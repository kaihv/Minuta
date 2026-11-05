import { adminClient, gateService } from "../_shared/auth.ts";
import { fetchWithTimeout, jsonResponse } from "../_shared/http.ts";
import { buildWebhookPayload, safeWebhookUrl, signBody } from "../_shared/outgoing-webhook.ts";
import { runOnce, supabaseEventStore } from "../_shared/pipeline-events.ts";
import { formatTranscript, readTranscript } from "../_shared/transcript.ts";

// Avisa a OUTGOING_WEBHOOK_URL que una reunión quedó lista. Una vez por
// reunión (pipeline_events). Sin URL configurada no hace nada. Solo la llama
// la tubería (llave de servicio). Detalle en _shared/outgoing-webhook.ts.

Deno.serve(async (req) => {
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);
  const gate = gateService(req);
  if (gate.response) return gate.response;

  const url = safeWebhookUrl(Deno.env.get("OUTGOING_WEBHOOK_URL"));
  if (!url) return jsonResponse({ skipped: "sin OUTGOING_WEBHOOK_URL válida" });
  const { meetingId } = await req.json().catch(() => ({}));
  if (typeof meetingId !== "string") return jsonResponse({ error: "meetingId requerido" }, 400);

  const db = adminClient();
  const out = await runOnce(
    supabaseEventStore(db),
    `outgoing-webhook:${meetingId}`,
    { kind: "integration", event_type: "outgoing-webhook", meeting_id: meetingId, maxAttempts: 5, retryAfterMs: 10 * 60_000 },
    async () => {
      const { data: meeting, error } = await db
        .from("meetings")
        .select("id, title, scheduled_at, duration_minutes, meeting_url, attendees, summary, status")
        .eq("id", meetingId)
        .single();
      if (error || !meeting) throw new Error("Reunión no encontrada");
      const withTranscript = Deno.env.get("OUTGOING_WEBHOOK_INCLUDE_TRANSCRIPT") === "true";
      const transcript = withTranscript ? formatTranscript(await readTranscript(db, meetingId)) : null;
      const body = JSON.stringify(buildWebhookPayload(meeting, { appUrl: Deno.env.get("APP_URL"), transcript }));
      const secret = Deno.env.get("OUTGOING_WEBHOOK_SECRET") ?? "";
      const res = await fetchWithTimeout(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(secret ? { "X-Minuta-Signature": await signBody(secret, body) } : {}),
        },
        body,
        redirect: "manual", // una redirección podría apuntar a la red interna
      }, 20_000);
      if (!res.ok) throw new Error(`El destino respondió ${res.status}`);
      return { value: res.status, detail: { http_status: res.status } };
    },
  ).catch((err) => ({ ran: true as const, value: 0, error: err instanceof Error ? err.message : String(err) }));
  return jsonResponse(out, "error" in out ? 502 : 200);
});
