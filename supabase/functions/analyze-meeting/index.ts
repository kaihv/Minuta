import { adminClient, gateMeeting, isAdminUser } from "../_shared/auth.ts";
import { aiQuota } from "../_shared/quota.ts";
import { aiFromEnv } from "../_shared/ai.ts";
import { jsonResponse, preflight } from "../_shared/http.ts";
import { generateSummary } from "../_shared/summary.ts";
import { readTranscript } from "../_shared/transcript.ts";

// Resumen de una reunión con IA. Lo llama la tubería (post-transcript.ts) una
// vez por reunión, o el dueño de la reunión / un admin desde la app ("Volver a
// resumir"), con tope diario por persona.
//
// Sin IA configurada responde 200 con summary_status "disabled": la reunión
// queda con su transcripción y nada más. Eso es éxito, no error.
// Si la IA falla responde 502 y la tubería lo reintenta (hasta 3 veces).

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  const gate = await gateMeeting(req, {}, {
    extra: async ({ caller, meeting }) =>
      caller.kind === "service" || meeting.user_id === caller.userId || (await isAdminUser(caller.userId))
        ? null
        : "Solo el dueño de la reunión o un admin pueden volver a resumirla",
  });
  if (gate.response) return gate.response;
  const meetingId = gate.meeting!.id;
  const manualBy = gate.caller!.kind === "user" ? gate.caller!.userId : null;
  const db = adminClient();

  const ai = aiFromEnv();
  if (!ai) {
    await db.from("meetings").update({ summary_status: "disabled" }).eq("id", meetingId);
    return jsonResponse({ success: true, summary_status: "disabled" });
  }

  if (manualBy) {
    const quota = await aiQuota(db, manualBy);
    if (quota.over) return jsonResponse({ error: `Llegaste al máximo de ${quota.limit} usos de IA por día.` }, 429);
  }

  try {
    const [{ data: meeting }, { data: settings }, turns] = await Promise.all([
      db.from("meetings").select("id, user_id, title, scheduled_at, created_at, calendar_description").eq("id", meetingId).single(),
      db.from("bot_settings").select("summary_context").limit(1).maybeSingle(),
      readTranscript(db, meetingId),
    ]);
    if (!meeting) return jsonResponse({ error: "Reunión no encontrada" }, 404);
    if (turns.length === 0) {
      await db.from("meetings").update({ summary_status: "empty" }).eq("id", meetingId);
      return jsonResponse({ success: true, summary_status: "empty" });
    }

    await db.from("meetings").update({ summary_status: "running", summary_error: null }).eq("id", meetingId);
    const { summary, usage } = await generateSummary(ai, {
      title: meeting.title,
      meetingDate: String(meeting.scheduled_at ?? meeting.created_at).slice(0, 10),
      turns,
      companyContext: settings?.summary_context ?? null,
      calendarDescription: meeting.calendar_description,
    });

    await db.from("meetings").update({
      summary,
      summary_status: "done",
      summary_error: null,
      summarized_at: new Date().toISOString(),
    }).eq("id", meetingId);
    await db.from("usage_records").insert({
      user_id: manualBy ?? meeting.user_id,
      meeting_id: meetingId,
      service: manualBy ? "ai_summary_manual" : "ai_summary",
      period_month: new Date().toISOString().slice(0, 7),
      ai_input_tokens: usage.inputTokens,
      ai_output_tokens: usage.outputTokens,
    });
    return jsonResponse({ success: true, summary_status: "done" });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`analyze-meeting ${meetingId}:`, message);
    await db.from("meetings").update({ summary_status: "failed", summary_error: message.slice(0, 500) }).eq("id", meetingId);
    return jsonResponse({ error: "La IA no pudo resumir. Se reintentará; el detalle quedó en la reunión." }, 502);
  }
});
