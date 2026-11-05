// Cliente de Recall.ai: UN solo lugar para hablar con Recall.
//
// Las funciones puras de abajo (extraer URL, duración,
// motivo) tienen pruebas en recall.test.ts.

import { fetchWithTimeout } from "./http.ts";

// Tarifas con las que se ESTIMA el costo en usage_records (no vienen de la
// factura de Recall).
export const RECALL_BOT_USD_PER_HOUR = 0.70;
export const RECALL_TRANSCRIPT_USD_PER_HOUR = 0.15;

// deno-lint-ignore no-explicit-any
export type BotData = any;

export interface BotSettings {
  waiting_room_timeout?: number | null;
  noone_joined_timeout?: number | null;
  everyone_left_timeout?: number | null;
  everyone_left_activate_after?: number | null;
  bot_name?: string | null;
  bot_image?: string | null;
}

/** Cuerpo de POST /bot. El mismo para grabación automática, manual y MCP. */
export function buildBotRequest(
  meetingUrl: string,
  settings: BotSettings | null | undefined,
  opts: { joinAt?: string | null; joinMessage?: string | null } = {},
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    meeting_url: meetingUrl,
    bot_name: settings?.bot_name || "Minuta · toma notas",
    automatic_leave: {
      waiting_room_timeout: settings?.waiting_room_timeout ?? 300,
      noone_joined_timeout: settings?.noone_joined_timeout ?? 300,
      everyone_left_timeout: {
        timeout: settings?.everyone_left_timeout ?? 30,
        activate_after: settings?.everyone_left_activate_after ?? 60,
      },
    },
    recording_config: {
      video_mixed_layout: "gallery_view_v2",
      video_mixed_participant_video_when_screenshare: "beside",
      // 7 días: los primeros 7 días de retención no se cobran. El video se
      // copia a nuestro Storage; el barrido tiene esa ventana para reintentar.
      retention: { type: "timed", hours: 168 },
    },
  };
  if (settings?.bot_image) body.bot_image = settings.bot_image;
  if (opts.joinAt) body.join_at = opts.joinAt;
  // Aviso de grabación en el chat de la reunión (consentimiento: en Chile aplica
  // la Ley 21.719 de datos personales). Se enciende con la variable
  // BOT_JOIN_MESSAGE o pasando joinMessage. Recomendado dejarlo encendido.
  const message = (opts.joinMessage ?? "").trim();
  if (message) body.chat = { on_bot_join: { send_to: "everyone", message } };
  return body;
}

// --- Lectura de los datos de un bot (puro) ----------------------------------

interface StatusChange {
  code?: string;
  sub_code?: string | null;
  created_at?: string;
}

function statusChanges(bot: BotData): StatusChange[] {
  return Array.isArray(bot?.status_changes) ? bot.status_changes : [];
}

export function lastStatus(bot: BotData): { code: string | null; subCode: string | null } {
  const changes = statusChanges(bot);
  const last = changes[changes.length - 1];
  return { code: last?.code ?? null, subCode: last?.sub_code ?? null };
}

/** El bot ya terminó (no va a mandar más avisos de estado). */
export function botIsTerminal(bot: BotData): boolean {
  const code = lastStatus(bot).code;
  return code === "done" || code === "fatal";
}

// deno-lint-ignore no-explicit-any
export function primaryRecording(bot: BotData): any | null {
  const recs = Array.isArray(bot?.recordings) ? bot.recordings : [];
  // deno-lint-ignore no-explicit-any
  return recs.find((r: any) => r?.status?.code !== "failed") ?? null;
}

/** La grabación existe y Recall ya terminó de procesarla. */
export function recordingIsReady(bot: BotData): boolean {
  const rec = primaryRecording(bot);
  if (!rec) return false;
  return rec.status?.code === "done" || !!rec.completed_at;
}

export function extractRecordingId(bot: BotData): string | null {
  return primaryRecording(bot)?.id ?? null;
}

export function extractVideoUrl(bot: BotData): string | null {
  const shortcuts = primaryRecording(bot)?.media_shortcuts;
  return (
    shortcuts?.video_mixed?.data?.download_url ??
    shortcuts?.audio_mixed?.data?.download_url ??
    bot?.video_url ?? // forma antigua de la API
    null
  );
}

/** Transcripción ya asociada a la grabación, si Recall la informa en el bot. */
export function extractTranscriptShortcut(
  bot: BotData,
): { id: string | null; status: string | null; downloadUrl: string | null } | null {
  const t = primaryRecording(bot)?.media_shortcuts?.transcript;
  if (!t) return null;
  return { id: t.id ?? null, status: t.status?.code ?? null, downloadUrl: t.data?.download_url ?? null };
}

function firstAt(bot: BotData, codes: string[]): number | null {
  const hit = statusChanges(bot).find((s) => s.code && codes.includes(s.code));
  const t = hit?.created_at ? Date.parse(hit.created_at) : NaN;
  return Number.isFinite(t) ? t : null;
}

/** Duración de la reunión en minutos (desde que el bot entró hasta que terminó). */
export function extractDurationMinutes(bot: BotData): number | null {
  const start = firstAt(bot, ["in_call_recording", "in_call_not_recording"]);
  const end = firstAt(bot, ["call_ended", "done"]);
  if (start !== null && end !== null && end > start) return Math.ceil((end - start) / 60_000);
  const rec = primaryRecording(bot);
  if (rec?.started_at && rec?.completed_at) {
    const ms = Date.parse(rec.completed_at) - Date.parse(rec.started_at);
    if (Number.isFinite(ms) && ms > 0) return Math.ceil(ms / 60_000);
  }
  if (typeof bot?.call_duration_secs === "number") return Math.ceil(bot.call_duration_secs / 60);
  return null;
}

/** Segundos de bot que cobra Recall (desde que empieza a unirse hasta que termina). */
export function extractBotSeconds(bot: BotData): number {
  const start = firstAt(bot, ["joining_call"]);
  const end = firstAt(bot, ["done", "fatal"]) ?? firstAt(bot, ["call_ended"]);
  if (start !== null && end !== null && end > start) return Math.round((end - start) / 1000);
  const minutes = extractDurationMinutes(bot);
  return minutes ? minutes * 60 : 0;
}

/** URL de la reunión a la que fue el bot, y el fragmento para buscarla. */
export function extractMeetingUrl(bot: BotData): { url: string | null; fragment: string | null } {
  const m = bot?.meeting_url;
  if (typeof m === "string" && m) {
    const fragment = m.replace(/^https?:\/\//, "").split("?")[0].split("/").filter(Boolean).pop() ?? null;
    return { url: m, fragment };
  }
  if (m && typeof m === "object" && m.meeting_id) {
    const id = String(m.meeting_id);
    const platform = m.platform ?? "google_meet";
    const url = platform === "google_meet"
      ? `https://meet.google.com/${id}`
      : platform === "zoom"
      ? `https://zoom.us/j/${id}`
      : id;
    return { url, fragment: id };
  }
  return { url: null, fragment: null };
}

// --- Cliente HTTP ------------------------------------------------------------

export class RecallError extends Error {
  constructor(message: string, public status: number) {
    super(message);
    this.name = "RecallError";
  }
}

export interface RecallClient {
  createBot(body: Record<string, unknown>): Promise<{ id: string }>;
  /** null si el bot no existe (404). Lanza RecallError en cualquier otro fallo. */
  getBot(botId: string): Promise<BotData | null>;
  createTranscript(recordingId: string): Promise<{ id: string | null }>;
  /** Segmentos de una transcripción ya terminada. */
  fetchTranscript(ref: { transcriptId?: string | null; downloadUrl?: string | null }): Promise<unknown>;
  leaveCall(botId: string): Promise<void>;
  deleteBot(botId: string): Promise<void>;
  deleteMedia(botId: string): Promise<void>;
}

export function recallClient(opts: {
  apiKey: string;
  region?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): RecallClient {
  const base = `https://${opts.region || "us-west-2"}.recall.ai/api/v1`;
  const timeout = opts.timeoutMs ?? 20_000;
  const f = opts.fetchImpl ?? fetch;
  const headers = { Authorization: `Token ${opts.apiKey}`, "Content-Type": "application/json" };

  async function call(path: string, init: RequestInit = {}): Promise<Response> {
    return await fetchWithTimeout(`${base}${path}`, { ...init, headers: { ...headers, ...(init.headers ?? {}) } }, timeout, f);
  }

  async function fail(res: Response, what: string): Promise<never> {
    const text = await res.text().catch(() => "");
    throw new RecallError(`Recall ${what}: ${res.status} ${text.slice(0, 300)}`, res.status);
  }

  return {
    async createBot(body) {
      const res = await call("/bot/", { method: "POST", body: JSON.stringify(body) });
      if (!res.ok) await fail(res, "crear bot");
      const data = await res.json();
      return { id: data.id };
    },
    async getBot(botId) {
      const res = await call(`/bot/${botId}/`);
      if (res.status === 404) return null;
      if (!res.ok) await fail(res, "leer bot");
      return await res.json();
    },
    async createTranscript(recordingId) {
      const res = await call(`/recording/${recordingId}/create_transcript/`, {
        method: "POST",
        body: JSON.stringify({
          provider: { recallai_async: { language_code: Deno.env.get("TRANSCRIPT_LANGUAGE") || "es" } },
          diarization: { use_separate_streams_when_available: true },
        }),
      });
      if (!res.ok) await fail(res, "pedir transcripción");
      const data = await res.json().catch(() => ({}));
      return { id: data?.id ?? null };
    },
    async fetchTranscript(ref) {
      let url = ref.downloadUrl ?? null;
      if (!url) {
        if (!ref.transcriptId) throw new RecallError("Sin id ni URL de transcripción", 0);
        const res = await call(`/transcript/${ref.transcriptId}/`);
        if (!res.ok) await fail(res, "leer transcripción");
        const meta = await res.json();
        url = meta?.data?.download_url ?? meta?.download_url ?? null;
        if (!url) {
          if (Array.isArray(meta?.segments)) return meta.segments;
          throw new RecallError(`La transcripción ${ref.transcriptId} todavía no tiene archivo`, 409);
        }
      }
      // El archivo es una URL prefirmada: sin cabecera de autorización.
      const file = await fetchWithTimeout(url, {}, 30_000, f);
      if (!file.ok) throw new RecallError(`Recall bajar transcripción: ${file.status}`, file.status);
      return await file.json();
    },
    async leaveCall(botId) {
      const res = await call(`/bot/${botId}/leave_call/`, { method: "POST" });
      if (!res.ok) await fail(res, "sacar bot");
    },
    async deleteBot(botId) {
      const res = await call(`/bot/${botId}/`, { method: "DELETE" });
      if (!res.ok && res.status !== 404) await fail(res, "borrar bot");
    },
    async deleteMedia(botId) {
      const res = await call(`/bot/${botId}/delete_media/`, { method: "POST" });
      if (!res.ok && res.status !== 404) await fail(res, "borrar medios");
    },
  };
}

/** Texto del aviso de grabación configurado en el entorno, o null (apagado). */
export function joinMessageFromEnv(): string | null {
  return Deno.env.get("BOT_JOIN_MESSAGE")?.trim() || null;
}

export function recallClientFromEnv(): RecallClient {
  const apiKey = Deno.env.get("RECALL_API_KEY");
  if (!apiKey) throw new Error("RECALL_API_KEY no configurada");
  return recallClient({ apiKey, region: Deno.env.get("RECALL_API_REGION") || "us-west-2" });
}
