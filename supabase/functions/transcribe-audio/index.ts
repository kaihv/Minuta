import { adminClient, gateMeeting, isAdminUser } from "../_shared/auth.ts";
import { deepgramFromUrl, durationMinutes, turnsFromDeepgram } from "../_shared/deepgram.ts";
import { jsonResponse, preflight, runInBackground } from "../_shared/http.ts";
import { runOnce, supabaseEventStore } from "../_shared/pipeline-events.ts";
import { postTranscriptDeps } from "../_shared/pipeline-runtime.ts";
import { runPostTranscript } from "../_shared/post-transcript.ts";
import { RECORDINGS_BUCKET } from "../_shared/recording-storage.ts";
import { markTranscriptComplete, writeTranscript } from "../_shared/transcript.ts";

// Reunión presencial o archivo subido: la app sube el audio a
// meeting-recordings/{dueño}/{reunión}/audio.<ext> y llama esta función con
// { meetingId, fileName }. Se transcribe con Deepgram y sigue la misma tubería
// que una reunión virtual (resumen, webhook de salida).
// Requiere DEEPGRAM_API_KEY. Solo el dueño de la reunión o un admin.

const ALLOWED = /^audio\.(webm|ogg|mp3|m4a|mp4|wav|mpeg)$/;

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);
  const apiKey = Deno.env.get("DEEPGRAM_API_KEY");
  if (!apiKey) return jsonResponse({ error: "La transcripción de audio no está configurada (DEEPGRAM_API_KEY)." }, 400);

  const gate = await gateMeeting<{ fileName?: string }>(req, {}, {
    extra: async ({ caller, meeting }) =>
      caller.kind === "service" || meeting.user_id === caller.userId || (await isAdminUser(caller.userId))
        ? null
        : "Solo el dueño de la reunión puede subir su audio",
  });
  if (gate.response) return gate.response;
  const meeting = gate.meeting!;
  const fileName = String(gate.body?.fileName ?? "");
  if (!ALLOWED.test(fileName)) return jsonResponse({ error: "Archivo no permitido" }, 400);
  const path = `${meeting.user_id}/${meeting.id}/${fileName}`;

  const db = adminClient();
  const { data: signed, error: signError } = await db.storage.from(RECORDINGS_BUCKET).createSignedUrl(path, 3600);
  if (signError || !signed?.signedUrl) return jsonResponse({ error: "No se encontró el audio subido" }, 404);

  await db.from("meetings").update({
    status: "processing",
    recording_url: `${RECORDINGS_BUCKET}/${path}`,
    pipeline_error: null,
  }).eq("id", meeting.id);

  const events = supabaseEventStore(db);
  const task = runOnce(
    events,
    `step:audio-transcribe:${meeting.id}:${fileName}`,
    { kind: "step", event_type: "audio-transcribe", meeting_id: meeting.id, maxAttempts: 3, staleMs: 10 * 60_000 },
    async () => {
      const result = await deepgramFromUrl(apiKey, signed.signedUrl, Deno.env.get("TRANSCRIPT_LANGUAGE") || "es");
      const turns = turnsFromDeepgram(result);
      const written = await writeTranscript(db, meeting.id, turns);
      await markTranscriptComplete(db, meeting.id, written.inserted);
      const minutes = durationMinutes(result);
      await db.from("meetings").update({
        status: "completed",
        ...(minutes ? { duration_minutes: minutes } : {}),
        ...(written.inserted === 0 ? { pipeline_error: "audio_sin_voz" } : {}),
      }).eq("id", meeting.id);
      if (minutes) {
        await db.from("usage_records").insert({
          user_id: meeting.user_id,
          meeting_id: meeting.id,
          service: "deepgram",
          period_month: new Date().toISOString().slice(0, 7),
          transcription_seconds: minutes * 60,
        });
      }
      if (written.inserted > 0) await runPostTranscript(postTranscriptDeps(db), meeting.id, { force: true });
      return { value: written.inserted, detail: { segments: written.inserted } };
    },
  ).catch(async (err) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`transcribe-audio ${meeting.id}:`, message);
    await db.from("meetings").update({ status: "failed", pipeline_error: `transcripcion: ${message}`.slice(0, 300) }).eq("id", meeting.id);
  });

  // Un audio de una hora puede tomar un par de minutos: se responde altiro.
  runInBackground(task);
  return jsonResponse({ accepted: true }, 202);
});
