import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { memoryEventStore } from "./pipeline-events.ts";
import { runPostTranscript, type CallResult } from "./post-transcript.ts";
import {
  handleRecallEvent,
  recallEventKey,
  reconcileMeeting,
  type MeetingRow,
  type PipelineDb,
  type PipelineDeps,
} from "./recall-pipeline.ts";
import { dedupeTurns, type NewTurn } from "./transcript.ts";
import type { BotData, RecallClient } from "./recall.ts";
import type { MeetingStatus } from "./meeting-status.ts";

// --- Mundo simulado -----------------------------------------------------------
// Forma de los avisos: la real de Recall
//   { event: "bot.done", data: { data: { code, sub_code, updated_at }, bot: { id } } }
//   { event: "recording.done", data: { recording: { id }, bot: { id } } }
//   { event: "transcript.done", data: { transcript: { id }, recording: { id }, bot: { id } } }

const BOT = "bot-1";
const REC = "rec-1";
const T0 = Date.parse("2026-10-07T15:00:00Z");

const botEvent = (code: string, sub_code: string | null = null, at = "2026-10-07T15:31:00Z") => ({
  event: `bot.${code}`,
  data: { data: { code, sub_code, updated_at: at }, bot: { id: BOT, metadata: {} } },
});
const recordingDone = () => ({ event: "recording.done", data: { recording: { id: REC }, bot: { id: BOT } } });
const transcriptDone = (id = "tr-1") => ({
  event: "transcript.done",
  data: { transcript: { id }, recording: { id: REC }, bot: { id: BOT } },
});

const word = (text: string, s: number) => ({ text, start_timestamp: { relative: s }, end_timestamp: { relative: s + 0.4 } });
function recallTranscript(turns = 300) {
  return Array.from({ length: turns }, (_, i) => ({
    participant: { id: i % 2, name: i % 2 ? "Carla Soto" : "Ana Pérez" },
    words: [word(`frase ${i}`, i * 5), word("más", i * 5 + 0.5)],
  }));
}

function recordedBot(opts: { ready?: boolean; transcript?: { id: string; status: string } | null } = {}): BotData {
  return {
    id: BOT,
    meeting_url: { meeting_id: "abc-defg-hij", platform: "google_meet" },
    status_changes: [
      { code: "joining_call", created_at: "2026-10-07T15:00:00Z" },
      { code: "in_call_recording", created_at: "2026-10-07T15:01:00Z" },
      { code: "call_ended", created_at: "2026-10-07T15:31:00Z" },
      { code: "done", created_at: "2026-10-07T15:31:05Z" },
    ],
    recordings: [{
      id: REC,
      status: { code: opts.ready === false ? "processing" : "done" },
      media_shortcuts: {
        video_mixed: { data: { download_url: opts.ready === false ? null : "https://recall.example/video.mp4?sig=x" } },
        transcript: opts.transcript
          ? { id: opts.transcript.id, status: { code: opts.transcript.status }, data: { download_url: null } }
          : null,
      },
    }],
  };
}

function emptyBot(subCode: string): BotData {
  return {
    id: BOT,
    status_changes: [
      { code: "joining_call", created_at: "2026-10-07T15:00:00Z" },
      { code: "in_waiting_room", created_at: "2026-10-07T15:00:20Z" },
      { code: "done", sub_code: subCode, created_at: "2026-10-07T15:05:20Z" },
    ],
    recordings: [],
  };
}

interface World {
  deps: PipelineDeps;
  meeting(): MeetingRow & Record<string, unknown>;
  turns: (NewTurn & { meeting_id: string })[];
  usage: { service: string; seconds: number }[];
  calls: { createTranscript: number; fetchTranscript: number; storeVideo: number; analyze: number; integrate: number; getBot: number };
  setBot(b: BotData | null): void;
  clock: { ms: number };
  analyzeResult: CallResult;
  failWriteOnce: boolean;
  videoOk: boolean;
  events: ReturnType<typeof memoryEventStore>;
}

function world(initial: Partial<MeetingRow> = {}): World {
  const row: MeetingRow & Record<string, unknown> = {
    id: "m1",
    user_id: "u1",
    status: "scheduled",
    meeting_url: "https://meet.google.com/abc-defg-hij",
    recall_bot_id: BOT,
    recording_url: null,
    duration_minutes: null,
    transcript_completed_at: null,
    ...initial,
  };
  const events = memoryEventStore();
  let bot: BotData | null = recordedBot();
  const w = {
    turns: [] as (NewTurn & { meeting_id: string })[],
    usage: [] as { service: string; seconds: number }[],
    calls: { createTranscript: 0, fetchTranscript: 0, storeVideo: 0, analyze: 0, integrate: 0, getBot: 0 },
    clock: { ms: T0 },
    analyzeResult: { ok: true, status: 200, body: { success: true, status: "evaluada", run_id: "run-1" } } as CallResult,
    failWriteOnce: false,
    videoOk: true,
    events,
  } as World;
  const now = () => new Date(w.clock.ms);

  const db: PipelineDb = {
    findMeetingByBot: (id) => Promise.resolve(row.recall_bot_id === id ? { ...row } : null),
    findUnlinkedByUrl: (fragment) =>
      Promise.resolve(!row.recall_bot_id && row.meeting_url?.includes(fragment) ? { ...row } : null),
    linkBot: (_id, botId) => {
      if (row.recall_bot_id) return Promise.resolve(false);
      row.recall_bot_id = botId;
      return Promise.resolve(true);
    },
    getMeeting: () => Promise.resolve({ ...row }),
    advanceStatus: (_id, to: MeetingStatus, from: MeetingStatus[], extra) => {
      if (!from.includes(row.status as MeetingStatus)) return Promise.resolve(false);
      row.status = to;
      Object.assign(row, extra ?? {});
      return Promise.resolve(true);
    },
    updateMeeting: (_id, patch) => {
      Object.assign(row, patch);
      return Promise.resolve();
    },
    recordUsage: (u) => {
      if (!w.usage.some((x) => x.service === u.service)) w.usage.push({ service: u.service, seconds: u.seconds });
      return Promise.resolve();
    },
    countTranscript: () => Promise.resolve(w.turns.length),
    writeTranscript: async (meetingId, turns) => {
      const replaced = w.turns.length;
      w.turns.length = 0;
      const clean = dedupeTurns(turns);
      if (w.failWriteOnce) {
        w.failWriteOnce = false;
        // El proceso muere a medio guardar: queda la mitad escrita.
        w.turns.push(...clean.slice(0, Math.floor(clean.length / 2)).map((t) => ({ meeting_id: meetingId, ...t })));
        throw new Error("conexión cortada a mitad del guardado");
      }
      await Promise.resolve();
      w.turns.push(...clean.map((t) => ({ meeting_id: meetingId, ...t })));
      return { inserted: clean.length, replaced };
    },
    markTranscriptComplete: (_id, segments) => {
      row.transcript_completed_at = now().toISOString();
      row.transcript_segments = segments;
      return Promise.resolve();
    },
  };

  const recall: RecallClient = {
    createBot: () => Promise.resolve({ id: BOT }),
    getBot: () => {
      w.calls.getBot++;
      return Promise.resolve(bot);
    },
    createTranscript: () => {
      w.calls.createTranscript++;
      return Promise.resolve({ id: "tr-1" });
    },
    fetchTranscript: () => {
      w.calls.fetchTranscript++;
      return Promise.resolve(recallTranscript());
    },
    leaveCall: () => Promise.resolve(),
    deleteBot: () => Promise.resolve(),
    deleteMedia: () => Promise.resolve(),
  };

  w.deps = {
    db,
    events,
    recall,
    now,
    storeVideo: () => {
      w.calls.storeVideo++;
      return Promise.resolve(
        w.videoOk
          ? { stored: true, url: "https://x.supabase.co/storage/v1/object/public/meeting-recordings/u1/m1/recording.mp4", bytes: 5_000_000 }
          : { stored: false, url: null, bytes: 0, error: "Subida a Storage: 500" },
      );
    },
    afterTranscript: (meetingId) =>
      runPostTranscript(
        {
          events,
          now,
          analyze: () => {
            w.calls.analyze++;
            return Promise.resolve(w.analyzeResult);
          },
          integrate: () => {
            w.calls.integrate++;
            return Promise.resolve();
          },
        },
        meetingId,
      ),
  };
  w.meeting = () => row;
  w.setBot = (b) => {
    bot = b;
  };
  return w;
}

// --- Casos ---------------------------------------------------------------------

Deno.test("flujo normal: una transcripción pedida, un video copiado, un análisis, una integración", async () => {
  const w = world();
  for (const ev of [botEvent("in_call_recording"), botEvent("call_ended"), botEvent("done"), recordingDone(), transcriptDone()]) {
    await handleRecallEvent(w.deps, ev);
  }
  assertEquals(w.meeting().status, "completed");
  assertEquals(w.calls, { createTranscript: 1, fetchTranscript: 1, storeVideo: 1, analyze: 1, integrate: 1, getBot: 2 });
  assertEquals(w.turns.length, 300);
  assertEquals(w.meeting().transcript_segments, 300);
  assertEquals(w.meeting().duration_minutes, 30);
  assert(String(w.meeting().recording_url).includes("supabase.co/storage"), "el video apunta a nuestro Storage");
  assertEquals(w.usage.map((u) => u.service).sort(), ["recall", "recall_transcription"]);
});

Deno.test("transcript.done repetido ocho veces (reintentos de Recall): una sola corrida", async () => {
  const w = world({ status: "processing", duration_minutes: 30 });
  const outcomes: string[] = [];
  for (const min of [0, 0.08, 5, 35, 155, 455, 1055, 1655]) {
    w.clock.ms = T0 + min * 60_000;
    outcomes.push((await handleRecallEvent(w.deps, transcriptDone())).outcome);
  }
  assertEquals(outcomes, ["processed", ...Array(7).fill("duplicate")]);
  assertEquals([w.calls.fetchTranscript, w.calls.analyze, w.calls.integrate], [1, 1, 1]);
  assertEquals(w.turns.length, 300);
});

Deno.test("el mismo aviso entregado tres veces a la vez (tres destinos en Recall): una sola corrida, sin turnos duplicados", async () => {
  const w = world({ status: "processing", duration_minutes: 30 });
  const results = await Promise.all([1, 2, 3].map(() => handleRecallEvent(w.deps, transcriptDone())));
  assertEquals(results.map((r) => r.outcome).sort(), ["duplicate", "duplicate", "processed"]);
  assertEquals(w.turns.length, 300);
  assertEquals(w.calls.analyze, 1);
});

Deno.test("dos transcripciones distintas para la misma grabación: la segunda no reescribe ni reanaliza", async () => {
  const w = world({ status: "processing", duration_minutes: 30 });
  await handleRecallEvent(w.deps, transcriptDone("tr-1"));
  const second = await handleRecallEvent(w.deps, transcriptDone("tr-2"));
  assertEquals(second.detail, "already_complete");
  assertEquals([w.calls.fetchTranscript, w.calls.analyze, w.turns.length], [1, 1, 300]);
});

Deno.test("bot.done y recording.done llegan juntos: una sola petición de transcripción y una sola copia del video", async () => {
  const w = world({ status: "recording" });
  await Promise.all([handleRecallEvent(w.deps, botEvent("done")), handleRecallEvent(w.deps, recordingDone())]);
  assertEquals([w.calls.createTranscript, w.calls.storeVideo], [1, 1]);
  assertEquals(w.meeting().status, "processing");
  assertEquals(w.usage.filter((u) => u.service === "recall").length, 1);
});

Deno.test("la grabación todavía no está lista en bot.done: espera a recording.done sin pedir nada", async () => {
  const w = world({ status: "recording" });
  w.setBot(recordedBot({ ready: false }));
  const first = await handleRecallEvent(w.deps, botEvent("done"));
  assertEquals((first.detail as { state: string }).state, "recording_pending");
  assertEquals([w.calls.createTranscript, w.calls.storeVideo], [0, 0]);
  w.setBot(recordedBot());
  await handleRecallEvent(w.deps, recordingDone());
  assertEquals([w.calls.createTranscript, w.calls.storeVideo], [1, 1]);
});

Deno.test("avisos fuera de orden: transcript.done llega antes que bot.done y nada retrocede ni se repite", async () => {
  const w = world({ status: "recording" });
  await handleRecallEvent(w.deps, transcriptDone());
  assertEquals(w.meeting().status, "completed");
  await handleRecallEvent(w.deps, botEvent("call_ended"));
  await handleRecallEvent(w.deps, botEvent("done"));
  await handleRecallEvent(w.deps, recordingDone());
  assertEquals(w.meeting().status, "completed", "completed no vuelve a processing");
  assertEquals([w.calls.createTranscript, w.calls.fetchTranscript, w.calls.analyze], [0, 1, 1]);
  assertEquals(w.calls.storeVideo, 1, "el video igual se copia");
});

Deno.test("la transcripción llega en dos partes: el primer guardado muere a medias y el segundo deja una sola copia completa", async () => {
  const w = world({ status: "processing", duration_minutes: 30 });
  w.failWriteOnce = true;
  const first = await handleRecallEvent(w.deps, transcriptDone());
  assertEquals(first.outcome, "error");
  assertEquals(w.turns.length, 150, "quedó media transcripción");
  assertEquals(w.meeting().status, "processing", "no se marca completada a ciegas");
  assertEquals(w.calls.analyze, 0, "no se analiza media transcripción");
  // Recall reintenta el mismo aviso 5 minutos después.
  w.clock.ms = T0 + 5 * 60_000;
  const second = await handleRecallEvent(w.deps, transcriptDone());
  assertEquals(second.outcome, "processed");
  assertEquals(w.turns.length, 300, "sin mitades repetidas");
  assertEquals(new Set(w.turns.map((t) => `${t.start_time_ms}|${t.speaker_name}|${t.content}`)).size, 300);
  assertEquals([w.meeting().status, w.calls.analyze, w.calls.integrate], ["completed", 1, 1]);
});

Deno.test("bot que no grabó: queda not_recorded con el motivo, y un call_ended atrasado no lo pisa", async () => {
  const w = world();
  w.setBot(emptyBot("timeout_exceeded_waiting_room"));
  const [done] = await Promise.all([
    handleRecallEvent(w.deps, botEvent("done", "timeout_exceeded_waiting_room")),
    handleRecallEvent(w.deps, botEvent("call_ended")),
  ]);
  await handleRecallEvent(w.deps, botEvent("call_ended"));
  assertEquals(w.meeting().status, "not_recorded");
  assertEquals(w.meeting().not_recorded_reason, "timeout_exceeded_waiting_room");
  assertEquals((done.detail as { reason: string }).reason, "timeout_exceeded_waiting_room");
  assertEquals([w.calls.createTranscript, w.calls.storeVideo, w.calls.analyze], [0, 0, 0]);
});

Deno.test("una reunión dada por no grabada revive si después aparece la grabación", async () => {
  const w = world({ status: "not_recorded" });
  await handleRecallEvent(w.deps, recordingDone());
  assertEquals(w.meeting().status, "processing");
  assertEquals(w.meeting().not_recorded_reason, null);
});

Deno.test("el análisis falla: no hay integraciones, la reunión queda completada y el reintento respeta espera y tope", async () => {
  const w = world({ status: "processing", duration_minutes: 30 });
  w.analyzeResult = { ok: false, status: 503, error: "Gemini agotó reintentos" };
  await handleRecallEvent(w.deps, transcriptDone());
  assertEquals([w.meeting().status, w.calls.analyze, w.calls.integrate], ["completed", 1, 0]);
  assertEquals(w.events.rows.get("step:analysis:m1")?.status, "error");
  // El barrido lo vuelve a intentar.
  w.clock.ms = T0 + 5 * 60_000;
  assertEquals((await w.deps.afterTranscript("m1") as { outcome: string }).outcome, "too_soon");
  w.clock.ms = T0 + 20 * 60_000;
  assertEquals((await w.deps.afterTranscript("m1") as { outcome: string }).outcome, "analysis_failed");
  w.clock.ms = T0 + 40 * 60_000;
  w.analyzeResult = { ok: true, status: 200, body: { success: true, status: "no_evaluada", skip_reason: "interna" } };
  assertEquals((await w.deps.afterTranscript("m1") as { outcome: string }).outcome, "analyzed");
  assertEquals([w.calls.analyze, w.calls.integrate], [3, 1]);
  w.clock.ms = T0 + 60 * 60_000;
  assertEquals((await w.deps.afterTranscript("m1") as { outcome: string }).outcome, "already_done");
});

Deno.test("reunión antigua ya transcrita y analizada: un aviso atrasado solo deja la marca", async () => {
  const w = world({ status: "completed", duration_minutes: 30 });
  w.turns.push(...Array.from({ length: 40 }, (_, i) => ({ meeting_id: "m1", speaker_name: "Pedro", speaker_id: null, content: `t${i}`, start_time_ms: i, end_time_ms: null })));
  const r = await handleRecallEvent(w.deps, transcriptDone());
  assertEquals(r.detail, "legacy_complete");
  assertEquals([w.turns.length, w.calls.fetchTranscript, w.calls.analyze], [40, 0, 0]);
  assertEquals(w.meeting().transcript_segments, 40);
});

Deno.test("no se pudo copiar el video: queda el enlace temporal solo si no había nada y el paso se reintenta después", async () => {
  const w = world({ status: "recording" });
  w.videoOk = false;
  await handleRecallEvent(w.deps, botEvent("done"));
  assertEquals(w.meeting().recording_url, "https://recall.example/video.mp4?sig=x");
  assertEquals(w.events.rows.get("step:video:m1")?.status, "error");
  // El barrido vuelve a reconciliar antes de la espera mínima: no insiste.
  w.videoOk = true;
  w.clock.ms = T0 + 2 * 60_000;
  assertEquals((await reconcileMeeting(w.deps, w.meeting(), BOT)).video, "video_too_soon");
  w.clock.ms = T0 + 12 * 60_000;
  assertEquals((await reconcileMeeting(w.deps, w.meeting(), BOT)).video, "stored");
  assert(String(w.meeting().recording_url).includes("supabase.co/storage"));
  assertEquals(w.calls.createTranscript, 1, "la transcripción no se vuelve a pedir");
});

Deno.test("transcript.failed: la reunión queda grabada, sin transcripción y con el motivo visible", async () => {
  const w = world({ status: "processing" });
  await handleRecallEvent(w.deps, { event: "transcript.failed", data: { data: { sub_code: "no_speech" }, transcript: { id: "tr-1" }, bot: { id: BOT } } });
  assertEquals([w.meeting().status, w.meeting().pipeline_error], ["completed", "transcript_failed:no_speech"]);
  assertEquals(w.calls.analyze, 0);
});

Deno.test("bot sin enlazar: se asocia por el enlace de la videollamada solo a una reunión sin bot", async () => {
  const w = world({ recall_bot_id: null });
  const r = await handleRecallEvent(w.deps, botEvent("in_call_recording"));
  assertEquals([r.outcome, w.meeting().recall_bot_id, w.meeting().status], ["status", BOT, "recording"]);
  const other = world({ recall_bot_id: "otro-bot" });
  assertEquals((await handleRecallEvent(other.deps, botEvent("done"))).outcome, "no_meeting");
  assertEquals(other.meeting().recall_bot_id, "otro-bot", "no le roba la reunión a otro bot");
});

Deno.test("avisos que no se manejan o vienen sin bot se ignoran sin tocar nada", async () => {
  const w = world();
  assertEquals((await handleRecallEvent(w.deps, { event: "transcript.data", data: { bot: { id: BOT } } })).outcome, "ignored");
  assertEquals((await handleRecallEvent(w.deps, { event: "bot.done", data: {} })).outcome, "ignored");
  assertEquals((await handleRecallEvent(w.deps, null)).outcome, "ignored");
  assertEquals(w.events.rows.size, 0);
});

Deno.test("la clave del aviso distingue artefactos y no depende de la entrega", () => {
  assertEquals(recallEventKey(transcriptDone("tr-9")), "recall:transcript.done:bot-1:tr-9");
  assertEquals(recallEventKey(recordingDone()), "recall:recording.done:bot-1:rec-1");
  assertEquals(recallEventKey(botEvent("done", null, "2026-10-07T15:31:05Z")), "recall:bot.done:bot-1:2026-10-07T15:31:05Z");
  assertEquals(recallEventKey({ event: "bot.done", data: {} }), null);
});
