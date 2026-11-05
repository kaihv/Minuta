// Tubería de grabación: qué hacer con cada aviso de Recall.
//
// Diseño (reemplaza al recall-webhook de 1.489 líneas que procesaba todo en
// línea y sin idempotencia; cada reunión se analizaba unas 20 veces):
//
//  1. Cada aviso tiene una clave semántica (evento + bot + artefacto). Se
//     reclama en pipeline_events: un reintento de Recall, o el mismo aviso
//     entregado a dos destinos, no se procesa dos veces.
//  2. Los avisos son "toques". Lo que manda es el estado real del bot en
//     Recall: `reconcileMeeting` lo lee y lleva la reunión hasta donde se pueda.
//     Por eso da lo mismo el orden en que lleguen.
//  3. Cada paso caro tiene su propio reclamo: una sola petición de
//     transcripción por grabación, un solo guardado por reunión, un solo
//     análisis por reunión.
//  4. Si un paso falla queda en `error` y el barrido lo reintenta: nada se
//     marca `completed` a ciegas.
//
// No hay red ni base acá: todo entra por `PipelineDeps`. Pruebas en
// recall-pipeline.test.ts con dependencias simuladas.

import { claimEvent, finishEvent, type EventStore } from "./pipeline-events.ts";
import { outcomeWithoutRecording, statusesAllowedBefore, type MeetingStatus } from "./meeting-status.ts";
import {
  botIsTerminal,
  extractBotSeconds,
  extractDurationMinutes,
  extractMeetingUrl,
  extractRecordingId,
  extractTranscriptShortcut,
  extractVideoUrl,
  lastStatus,
  primaryRecording,
  RECALL_BOT_USD_PER_HOUR,
  RECALL_TRANSCRIPT_USD_PER_HOUR,
  recordingIsReady,
  type BotData,
  type RecallClient,
} from "./recall.ts";
import { normalizeRecallTranscript, type NewTurn } from "./transcript.ts";
import type { StoreResult } from "./recording-storage.ts";

export interface MeetingRow {
  id: string;
  user_id: string;
  status: string;
  meeting_url: string | null;
  recall_bot_id: string | null;
  recording_url: string | null;
  duration_minutes: number | null;
  transcript_completed_at?: string | null;
}

/** Operaciones de base que necesita la tubería. */
export interface PipelineDb {
  findMeetingByBot(botId: string): Promise<MeetingRow | null>;
  /** Reunión reciente sin bot cuyo enlace contiene `fragment` (el bot no quedó enlazado). */
  findUnlinkedByUrl(fragment: string, sinceIso: string): Promise<MeetingRow | null>;
  /** Enlaza el bot solo si la reunión sigue sin bot. true si lo enlazó. */
  linkBot(meetingId: string, botId: string): Promise<boolean>;
  getMeeting(meetingId: string): Promise<MeetingRow | null>;
  /** UPDATE atómico de estado condicionado a `from`. true si avanzó. */
  advanceStatus(meetingId: string, to: MeetingStatus, from: MeetingStatus[], extra?: Record<string, unknown>): Promise<boolean>;
  updateMeeting(meetingId: string, patch: Record<string, unknown>): Promise<void>;
  /** Inserta uso si no existe ya uno del mismo tipo para la reunión. */
  recordUsage(row: {
    user_id: string;
    meeting_id: string;
    service: "recall" | "recall_transcription";
    seconds: number;
    cost_usd: number;
  }): Promise<void>;
  countTranscript(meetingId: string): Promise<number>;
  writeTranscript(meetingId: string, turns: NewTurn[]): Promise<{ inserted: number; replaced: number }>;
  markTranscriptComplete(meetingId: string, segments: number): Promise<void>;
}

export interface PipelineDeps {
  db: PipelineDb;
  events: EventStore;
  recall: RecallClient;
  storeVideo(meeting: MeetingRow, sourceUrl: string): Promise<StoreResult>;
  /** Análisis e integraciones, una vez por reunión (post-transcript.ts). */
  afterTranscript(meetingId: string): Promise<unknown>;
  now?: () => Date;
  log?: (message: string, extra?: unknown) => void;
}

// deno-lint-ignore no-explicit-any
type Payload = any;

// Avisos que solo mueven el estado visible. No pasan por el registro: repetir
// un UPDATE condicionado no hace daño.
const STATUS_EVENTS: Record<string, MeetingStatus | null> = {
  "bot.joining_call": null,
  "bot.in_waiting_room": null,
  "bot.in_call_not_recording": "recording",
  "bot.in_call_recording": "recording",
  "bot.call_ended": "processing",
};

// Avisos tras los cuales hay que mirar el estado real del bot en Recall.
const RECONCILE_EVENTS = new Set([
  "bot.done",
  "bot.fatal",
  "bot.fatal_error",
  "bot.error",
  "bot.leave_call",
  "recording.done",
  "recording.failed",
  "video_mixed.done",
]);

const TRANSCRIPT_EVENTS = new Set(["transcript.done", "transcript.failed"]);

export function isHandledEvent(event: unknown): boolean {
  return typeof event === "string" &&
    (event in STATUS_EVENTS || RECONCILE_EVENTS.has(event) || TRANSCRIPT_EVENTS.has(event));
}

export function extractBotId(payload: Payload): string | null {
  const d = payload?.data;
  const candidates = [d?.bot?.id, d?.bot_id, payload?.bot_id, payload?.bot?.id];
  for (const c of candidates) if (typeof c === "string" && c) return c;
  return null;
}

/**
 * Clave única de un aviso: evento + bot + artefacto. No depende del id de
 * entrega (svix-id), así que también coincide cuando el mismo aviso llega por
 * dos destinos registrados en Recall.
 */
export function recallEventKey(payload: Payload): string | null {
  const event = payload?.event;
  const botId = extractBotId(payload);
  if (typeof event !== "string" || !botId) return null;
  const d = payload?.data ?? {};
  let artifact: string | null = null;
  if (TRANSCRIPT_EVENTS.has(event)) artifact = d.transcript?.id ?? d.transcript_id ?? d.recording?.id ?? d.recording_id ?? null;
  else if (event.startsWith("recording.") || event.startsWith("video_mixed.")) {
    artifact = d.recording?.id ?? d.recording_id ?? d.video_mixed?.id ?? null;
  } else artifact = d.data?.updated_at ?? d.status?.created_at ?? null;
  return `recall:${event}:${botId}${artifact ? `:${artifact}` : ""}`;
}

/** Lo mínimo del aviso para poder repetirlo desde el barrido (sin datos personales). */
export function slimPayload(payload: Payload): Record<string, unknown> {
  const d = payload?.data ?? {};
  return {
    event: payload?.event ?? null,
    data: {
      bot: { id: extractBotId(payload) },
      recording: d.recording?.id || d.recording_id ? { id: d.recording?.id ?? d.recording_id } : undefined,
      transcript: d.transcript?.id || d.transcript_id ? { id: d.transcript?.id ?? d.transcript_id } : undefined,
      data: d.data?.sub_code || d.data?.code
        ? { code: d.data?.code ?? null, sub_code: d.data?.sub_code ?? null, updated_at: d.data?.updated_at ?? null }
        : undefined,
    },
  };
}

function eventSubCode(payload: Payload): string | null {
  const d = payload?.data ?? {};
  return d.data?.sub_code ?? d.sub_code ?? d.status?.sub_code ?? null;
}

export type HandleOutcome = "ignored" | "status" | "duplicate" | "no_meeting" | "processed" | "error";

export interface HandleResult {
  outcome: HandleOutcome;
  key?: string | null;
  meetingId?: string;
  detail?: unknown;
}

export async function handleRecallEvent(deps: PipelineDeps, payload: Payload): Promise<HandleResult> {
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? (() => {});
  const event = payload?.event;
  if (!isHandledEvent(event)) return { outcome: "ignored", detail: `evento no manejado: ${String(event)}` };
  const botId = extractBotId(payload);
  if (!botId) return { outcome: "ignored", detail: "aviso sin id de bot" };

  // Avisos de estado: sin registro, UPDATE condicionado.
  if (event in STATUS_EVENTS) {
    const to = STATUS_EVENTS[event];
    const meeting = await resolveMeeting(deps, botId);
    if (!meeting) return { outcome: "no_meeting" };
    const moved = to ? await deps.db.advanceStatus(meeting.id, to, statusesAllowedBefore(to)) : false;
    return { outcome: "status", meetingId: meeting.id, detail: { to, moved } };
  }

  const key = recallEventKey(payload)!;
  const claim = await claimEvent(
    deps.events,
    key,
    { kind: "webhook", event_type: event, bot_id: botId, detail: slimPayload(payload), staleMs: 10 * 60_000, maxAttempts: 5 },
    now(),
  );
  if (!claim.claimed) {
    log(`Aviso repetido, no se procesa: ${key} (${claim.reason})`);
    return { outcome: "duplicate", key, detail: claim.reason };
  }

  try {
    const meeting = await resolveMeeting(deps, botId);
    if (!meeting) {
      await finishEvent(deps.events, key, "skipped", { detail: { reason: "sin reunión para el bot" } }, now());
      return { outcome: "no_meeting", key };
    }
    const d = payload?.data ?? {};
    let detail: unknown;
    if (event === "transcript.done") {
      detail = await ingestTranscript(deps, meeting, {
        transcriptId: d.transcript?.id ?? d.transcript_id ?? null,
        recordingId: d.recording?.id ?? d.recording_id ?? null,
        botId,
      });
    } else if (event === "transcript.failed") {
      detail = await transcriptFailed(deps, meeting, eventSubCode(payload));
    } else {
      detail = await reconcileMeeting(deps, meeting, botId, {
        terminalHint: event === "bot.done" || event.startsWith("bot.fatal") || event === "bot.error",
        subCodeHint: eventSubCode(payload),
      });
    }
    await finishEvent(deps.events, key, "done", { meeting_id: meeting.id, detail: { ...slimPayload(payload), result: detail } }, now());
    return { outcome: "processed", key, meetingId: meeting.id, detail };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`Aviso ${key} falló: ${message}`);
    await finishEvent(deps.events, key, "error", { error: message }, now());
    return { outcome: "error", key, detail: message };
  }
}

/** Reunión del bot. Si el bot no quedó enlazado, la busca por el enlace de la videollamada. */
export async function resolveMeeting(deps: PipelineDeps, botId: string): Promise<MeetingRow | null> {
  const direct = await deps.db.findMeetingByBot(botId);
  if (direct) return direct;
  const bot = await deps.recall.getBot(botId).catch(() => null);
  const { fragment } = extractMeetingUrl(bot);
  if (!fragment) return null;
  const now = (deps.now ?? (() => new Date()))();
  // Solo reuniones de las últimas 24 h y SIN bot: el enlace de Meet se repite
  // en reuniones recurrentes y antes esto podía pegar el bot de hoy a la
  // reunión de la semana pasada.
  const orphan = await deps.db.findUnlinkedByUrl(fragment, new Date(now.getTime() - 24 * 3600_000).toISOString());
  if (!orphan) return null;
  const linked = await deps.db.linkBot(orphan.id, botId);
  return linked ? { ...orphan, recall_bot_id: botId } : await deps.db.findMeetingByBot(botId);
}

export interface ReconcileResult {
  state:
    | "in_progress"
    | "not_recorded"
    | "failed"
    | "recording_pending"
    | "recorded";
  reason?: string;
  transcript?: string;
  video?: string;
}

/**
 * Lleva la reunión hasta donde el estado real del bot lo permita. Idempotente:
 * se puede llamar las veces que sea (avisos, barrido).
 */
export async function reconcileMeeting(
  deps: PipelineDeps,
  meeting: MeetingRow,
  botId: string,
  hints: { terminalHint?: boolean; subCodeHint?: string | null } = {},
): Promise<ReconcileResult> {
  const now = deps.now ?? (() => new Date());
  const bot: BotData | null = await deps.recall.getBot(botId);
  if (!bot) {
    // 404: el bot ya no existe en Recall (borrado o retención vencida). No va a
    // llegar nada más de él.
    await deps.db.advanceStatus(meeting.id, "not_recorded", statusesAllowedBefore("not_recorded"), {
      not_recorded_reason: "bot_not_found",
    });
    return { state: "not_recorded", reason: "bot_not_found" };
  }

  const recording = primaryRecording(bot);
  const terminal = hints.terminalHint || botIsTerminal(bot);

  if (!recording) {
    if (!terminal) return { state: "in_progress" };
    const last = lastStatus(bot);
    const out = outcomeWithoutRecording({
      subCode: last.subCode ?? hints.subCodeHint,
      lastCode: last.code,
      meetingStatus: meeting.status,
    });
    await deps.db.advanceStatus(meeting.id, out.status, statusesAllowedBefore(out.status), {
      not_recorded_reason: out.reason,
    });
    return { state: out.status, reason: out.reason };
  }

  // Hay grabación: la reunión está al menos en proceso (y revive si un aviso
  // anterior la había dado por no grabada).
  await deps.db.advanceStatus(meeting.id, "processing", statusesAllowedBefore("processing", { revive: true }), {
    not_recorded_reason: null,
  });

  const duration = extractDurationMinutes(bot);
  if (duration && duration !== meeting.duration_minutes) {
    await deps.db.updateMeeting(meeting.id, { duration_minutes: duration });
  }

  if (terminal) {
    const seconds = extractBotSeconds(bot);
    if (seconds > 0) {
      await deps.db.recordUsage({
        user_id: meeting.user_id,
        meeting_id: meeting.id,
        service: "recall",
        seconds,
        cost_usd: (seconds / 3600) * RECALL_BOT_USD_PER_HOUR,
      });
    }
  }

  if (!recordingIsReady(bot)) return { state: "recording_pending" };

  const result: ReconcileResult = { state: "recorded" };
  const recordingId = extractRecordingId(bot);

  // --- Transcripción: primero, porque es rápida y el video puede tardar. ----
  const fresh = (await deps.db.getMeeting(meeting.id)) ?? meeting;
  if (fresh.transcript_completed_at) {
    result.transcript = "already_complete";
  } else if (recordingId) {
    const shortcut = extractTranscriptShortcut(bot);
    if (shortcut?.status === "done") {
      result.transcript = await ingestTranscript(deps, fresh, {
        transcriptId: shortcut.id,
        downloadUrl: shortcut.downloadUrl,
        recordingId,
        botId,
      });
    } else if (shortcut && shortcut.status && shortcut.status !== "failed") {
      result.transcript = "waiting"; // Recall la está generando: llegará transcript.done
    } else {
      const key = `step:transcript-request:${recordingId}`;
      const claim = await claimEvent(
        deps.events,
        key,
        { kind: "step", event_type: "transcript-request", meeting_id: meeting.id, bot_id: botId, staleMs: 2 * 60_000, maxAttempts: 3, retryAfterMs: 5 * 60_000 },
        now(),
      );
      if (!claim.claimed) {
        result.transcript = `request_${claim.reason}`;
      } else {
        try {
          const created = await deps.recall.createTranscript(recordingId);
          await finishEvent(deps.events, key, "done", { detail: { transcript_id: created.id } }, now());
          result.transcript = "requested";
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          await finishEvent(deps.events, key, "error", { error: message }, now());
          result.transcript = "request_failed";
        }
      }
    }
  } else {
    result.transcript = "no_recording_id";
  }

  // --- Video a nuestro Storage ----------------------------------------------
  const videoUrl = extractVideoUrl(bot);
  if (!videoUrl) {
    result.video = "no_url";
  } else {
    const key = `step:video:${meeting.id}`;
    const claim = await claimEvent(
      deps.events,
      key,
      { kind: "step", event_type: "video", meeting_id: meeting.id, bot_id: botId, staleMs: 15 * 60_000, maxAttempts: 4, retryAfterMs: 10 * 60_000 },
      now(),
    );
    if (!claim.claimed) {
      result.video = `video_${claim.reason}`;
    } else {
      const stored = await deps.storeVideo(fresh, videoUrl);
      if (stored.stored && stored.url) {
        await deps.db.updateMeeting(meeting.id, { recording_url: stored.url });
        await finishEvent(deps.events, key, "done", { detail: { bytes: stored.bytes } }, now());
        result.video = "stored";
      } else {
        // Sin copia propia: se deja el enlace temporal SOLO si no hay nada, y
        // el paso queda en error para que el barrido lo reintente (Recall
        // guarda el archivo 7 días).
        if (!fresh.recording_url) await deps.db.updateMeeting(meeting.id, { recording_url: videoUrl });
        await finishEvent(deps.events, key, "error", { error: stored.error ?? "no se pudo copiar el video" }, now());
        result.video = "store_failed";
      }
    }
  }
  return result;
}

export type IngestOutcome =
  | "saved"
  | "saved_empty"
  | "already_complete"
  | "legacy_complete"
  | "in_progress"
  | "done"
  | "max_attempts"
  | "too_soon";

/**
 * Guarda la transcripción de una reunión una sola vez (lote único, sin
 * duplicar), la marca completa, registra el uso, pasa la reunión a `completed`
 * y dispara el análisis.
 */
export async function ingestTranscript(
  deps: PipelineDeps,
  meeting: MeetingRow,
  ref: { transcriptId?: string | null; downloadUrl?: string | null; recordingId?: string | null; botId?: string | null },
): Promise<IngestOutcome> {
  const now = deps.now ?? (() => new Date());
  const fresh = (await deps.db.getMeeting(meeting.id)) ?? meeting;
  if (fresh.transcript_completed_at) return "already_complete";

  const key = `step:transcript-save:${meeting.id}`;
  const claim = await claimEvent(
    deps.events,
    key,
    { kind: "step", event_type: "transcript-save", meeting_id: meeting.id, bot_id: ref.botId ?? null, staleMs: 3 * 60_000, maxAttempts: 5, retryAfterMs: 30_000 },
    now(),
  );
  if (!claim.claimed) return (claim.reason ?? "in_progress") as IngestOutcome;

  let segments = 0;
  try {
    const existing = await deps.db.countTranscript(meeting.id);
    if (existing > 0 && fresh.status === "completed") {
      // Reunión anterior a esta versión: ya tenía transcripción y análisis.
      // Solo se deja la marca; no se reescribe ni se reanaliza.
      await deps.db.markTranscriptComplete(meeting.id, existing);
      await finishEvent(deps.events, key, "done", { detail: { legacy: true, segments: existing } }, now());
      return "legacy_complete";
    }

    let transcriptId = ref.transcriptId ?? null;
    let downloadUrl = ref.downloadUrl ?? null;
    if (!transcriptId && !downloadUrl && ref.botId) {
      const shortcut = extractTranscriptShortcut(await deps.recall.getBot(ref.botId));
      transcriptId = shortcut?.id ?? null;
      downloadUrl = shortcut?.downloadUrl ?? null;
    }
    const raw = await deps.recall.fetchTranscript({ transcriptId, downloadUrl });
    const turns = normalizeRecallTranscript(raw);
    const written = await deps.db.writeTranscript(meeting.id, turns);
    segments = written.inserted;
    await deps.db.markTranscriptComplete(meeting.id, segments);

    const minutes = fresh.duration_minutes ?? 0;
    if (minutes > 0) {
      await deps.db.recordUsage({
        user_id: meeting.user_id,
        meeting_id: meeting.id,
        service: "recall_transcription",
        seconds: minutes * 60,
        cost_usd: (minutes / 60) * RECALL_TRANSCRIPT_USD_PER_HOUR,
      });
    }
    await deps.db.advanceStatus(meeting.id, "completed", statusesAllowedBefore("completed", { revive: true }), {
      not_recorded_reason: null,
      pipeline_error: null,
    });
    await finishEvent(deps.events, key, "done", { detail: { segments, replaced: written.replaced, transcript_id: transcriptId } }, now());
  } catch (err) {
    await finishEvent(deps.events, key, "error", { error: err instanceof Error ? err.message : String(err) }, now());
    throw err;
  }

  if (segments === 0) return "saved_empty"; // reunión en silencio: nada que analizar
  await deps.afterTranscript(meeting.id);
  return "saved";
}

/** Recall no pudo transcribir: la reunión queda grabada, sin transcripción y con el motivo a la vista. */
export async function transcriptFailed(deps: PipelineDeps, meeting: MeetingRow, subCode: string | null): Promise<string> {
  const fresh = (await deps.db.getMeeting(meeting.id)) ?? meeting;
  if (fresh.transcript_completed_at) return "already_complete";
  const reason = `transcript_failed${subCode ? `:${subCode}` : ""}`;
  await deps.db.advanceStatus(meeting.id, "completed", statusesAllowedBefore("completed"), { pipeline_error: reason });
  return reason;
}
