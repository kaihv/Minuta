import { adminClient, gateMeeting } from "../_shared/auth.ts";
import { aiFromEnv, type ChatMessage } from "../_shared/ai.ts";
import { jsonResponse, preflight } from "../_shared/http.ts";
import { aiQuota } from "../_shared/quota.ts";
import { CHAT_SYSTEM_PROMPT, fitTranscript, neutralizeDelims } from "../_shared/summary.ts";
import { formatTranscript, readTranscript } from "../_shared/transcript.ts";

// Preguntarle a una reunión ("¿qué precio se acordó?"). Requiere IA.
// Cuerpo: { meetingId, messages: [{ role: "user" | "assistant", content }] }
// La conversación no se guarda: vive en la pantalla.

const MAX_MESSAGES = 12;
const MAX_CHARS = 2_000;

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  const gate = await gateMeeting<{ messages?: unknown }>(req);
  if (gate.response) return gate.response;
  const ai = aiFromEnv();
  if (!ai) return jsonResponse({ error: "La IA no está configurada (AI_PROVIDER y AI_API_KEY)." }, 400);

  const messages: ChatMessage[] = (Array.isArray(gate.body?.messages) ? gate.body!.messages as unknown[] : [])
    // deno-lint-ignore no-explicit-any
    .filter((m: any) => (m?.role === "user" || m?.role === "assistant") && typeof m?.content === "string" && m.content.trim())
    .slice(-MAX_MESSAGES)
    // deno-lint-ignore no-explicit-any
    .map((m: any) => ({ role: m.role, content: m.content.slice(0, MAX_CHARS) }));
  if (messages.length === 0 || messages[messages.length - 1].role !== "user") {
    return jsonResponse({ error: "Falta la pregunta" }, 400);
  }

  const db = adminClient();
  const userId = gate.caller!.kind === "user" ? gate.caller!.userId : null;
  if (userId) {
    const quota = await aiQuota(db, userId);
    if (quota.over) return jsonResponse({ error: `Llegaste al máximo de ${quota.limit} preguntas por día.` }, 429);
  }

  try {
    const [{ data: meeting }, turns] = await Promise.all([
      db.from("meetings").select("title, scheduled_at, summary").eq("id", gate.meeting!.id).single(),
      readTranscript(db, gate.meeting!.id),
    ]);
    if (turns.length === 0) return jsonResponse({ error: "Esta reunión todavía no tiene transcripción" }, 400);
    const context = [
      `Reunión: ${neutralizeDelims(meeting?.title ?? "(sin título)")} (${String(meeting?.scheduled_at ?? "").slice(0, 10)})`,
      meeting?.summary?.executive_summary ? `Resumen:\n${meeting.summary.executive_summary}` : "",
      `<transcripcion>\n${neutralizeDelims(fitTranscript(formatTranscript(turns)))}\n</transcripcion>`,
    ].filter(Boolean).join("\n\n");
    const { text, usage } = await ai.chat({ system: `${CHAT_SYSTEM_PROMPT}\n\n${context}`, messages, maxTokens: 1_500 });
    await db.from("usage_records").insert({
      user_id: userId,
      meeting_id: gate.meeting!.id,
      service: "ai_chat",
      period_month: new Date().toISOString().slice(0, 7),
      ai_input_tokens: usage.inputTokens,
      ai_output_tokens: usage.outputTokens,
    });
    return jsonResponse({ answer: text.trim() });
  } catch (err) {
    console.error("meeting-chat:", err);
    return jsonResponse({ error: "La IA no pudo responder. Intenta de nuevo." }, 502);
  }
});
