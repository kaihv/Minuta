import { adminClient, gateMeeting, gateUser, isAdminUser, type Caller, type MeetingRef } from "../_shared/auth.ts";
import { jsonResponse, preflight } from "../_shared/http.ts";
import { ManualBotError, sendManualBot } from "../_shared/manual-bot.ts";
import { pipelineDeps } from "../_shared/pipeline-runtime.ts";
import { reconcileMeeting } from "../_shared/recall-pipeline.ts";
import { extractRecordingId, recallClientFromEnv } from "../_shared/recall.ts";

// Acciones manuales sobre el bot de Recall, desde la app:
//   create_bot { meetingUrl, title? }  manda el bot ahora a una videollamada
//   stop_recording { meetingId }       saca al bot de la llamada
//   cancel_bot { meetingId }           cancela un bot que todavía no entra
//   refresh { meetingId }              revisa en Recall y retoma lo pendiente
//                                      (transcripción, copia del video)
// Crear: cualquier persona con sesión. El resto: dueño de la reunión o admin.

async function canModify(caller: Caller, meeting: MeetingRef): Promise<boolean> {
  if (caller.kind === "service") return true;
  return meeting.user_id === caller.userId || (await isAdminUser(caller.userId));
}

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  let action = "";
  try {
    action = String((await req.clone().json())?.action ?? "");
  } catch (_e) {
    return jsonResponse({ error: "Cuerpo inválido" }, 400);
  }

  try {
    const supabase = adminClient();

    if (action === "create_bot") {
      const gate = await gateUser(req);
      if (gate.response) return gate.response;
      const caller = gate.caller as Extract<Caller, { kind: "user" }>;
      const body = await req.json();
      try {
        const r = await sendManualBot(supabase, caller.userId, body.meetingUrl, body.title);
        return jsonResponse({ success: true, ...r });
      } catch (err) {
        if (err instanceof ManualBotError) return jsonResponse({ error: err.message, meetingId: err.meetingId }, err.status);
        throw err;
      }
    }

    if (!["stop_recording", "cancel_bot", "refresh"].includes(action)) {
      return jsonResponse({ error: `Acción desconocida: ${action}` }, 400);
    }

    const gate = await gateMeeting(req, {}, {
      extra: async ({ caller, meeting }) => (await canModify(caller, meeting)) ? null : "Solo el dueño de la reunión o un admin",
    });
    if (gate.response) return gate.response;
    const meetingId = gate.meeting!.id;
    const { data: row } = await supabase.from("meetings").select("recall_bot_id").eq("id", meetingId).maybeSingle();
    const botId: string | null = row?.recall_bot_id ?? null;
    if (!botId) return jsonResponse({ success: true, reason: "no_bot" });
    const recall = recallClientFromEnv();

    if (action === "stop_recording") {
      await recall.leaveCall(botId);
      return jsonResponse({ success: true });
    }

    if (action === "cancel_bot") {
      await recall.deleteBot(botId);
      await supabase
        .from("meetings")
        .update({ recall_bot_id: null, status: "not_recorded", not_recorded_reason: "cancelled_by_user" })
        .eq("id", meetingId)
        .in("status", ["scheduled"]);
      return jsonResponse({ success: true });
    }

    // refresh: mismo camino que el webhook; se permite volver a pedir la
    // transcripción aunque ya se haya pedido antes.
    const deps = pipelineDeps(supabase);
    const meeting = await deps.db.getMeeting(meetingId);
    if (!meeting) return jsonResponse({ error: "Reunión no encontrada" }, 404);
    const bot = await deps.recall.getBot(botId);
    const recordingId = bot ? extractRecordingId(bot) : null;
    if (recordingId) {
      const key = `step:transcript-request:${recordingId}`;
      const previous = await deps.events.get(key).catch(() => null);
      if (previous && previous.status !== "processing") {
        await deps.events.update(key, { status: "retryable", attempts: 0, finished_at: null });
      }
      await deps.events.update(`step:video:${meetingId}`, { status: "retryable", attempts: 0, finished_at: null }).catch(() => {});
    }
    const result = await reconcileMeeting(deps, meeting, botId);
    return jsonResponse({ success: true, ...result });
  } catch (err) {
    console.error(`recall-bot ${action}:`, err);
    return jsonResponse({ error: "No se pudo completar la acción. El detalle quedó en los registros de la función." }, 500);
  }
});
