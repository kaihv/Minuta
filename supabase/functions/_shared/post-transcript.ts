// Lo que pasa cuando una transcripción quedó completa: análisis UNA vez y,
// si salió bien, el aviso hacia afuera UNA vez. Lo usan recall-webhook (bot),
// transcribe-audio (presencial) y el barrido.
//
//   POST analyze-meeting { meetingId, source: "pipeline" } con la llave de
//   servicio; 2xx = listo (también cuando no hay IA configurada: la reunión
//   queda con transcripción y sin resumen, y eso es éxito); 4xx/5xx = falló y
//   el barrido reintenta (máximo 3 intentos, 15 min entre uno y otro).
//
// `beforeAnalysis` es un gancho opcional para traer contexto antes del
// análisis (por ejemplo, datos del cliente desde un CRM). Nunca frena la
// tubería: si falla o tarda, el análisis sigue igual.

import { claimEvent, finishEvent, type EventStore } from "./pipeline-events.ts";
import { fetchWithTimeout } from "./http.ts";

export const ANALYSIS_MAX_ATTEMPTS = 3;
export const ANALYSIS_RETRY_AFTER_MS = 15 * 60_000;
export const ANALYSIS_TIMEOUT_MS = 150_000;
/** Lo máximo que el gancho previo puede demorar al análisis. */
export const BEFORE_ANALYSIS_TIMEOUT_MS = 25_000;

export interface CallResult {
  ok: boolean;
  status: number;
  body?: unknown;
  error?: string;
}

export interface PostTranscriptDeps {
  events: EventStore;
  /**
   * Gancho opcional antes del análisis (contexto externo). Nunca bloquea: lo
   * que devuelva o lance no cambia el resultado de la tubería.
   */
  beforeAnalysis?(meetingId: string): Promise<unknown>;
  analyze(meetingId: string): Promise<CallResult>;
  /** Avisos posteriores al análisis (webhook de salida). Idempotentes por su cuenta. */
  integrate(meetingId: string): Promise<unknown>;
  now?: () => Date;
}

export const analysisKey = (meetingId: string) => `step:analysis:${meetingId}`;

export type PostTranscriptOutcome =
  | "analyzed"
  | "already_done"
  | "in_progress"
  | "max_attempts"
  | "too_soon"
  | "analysis_failed";

/** Dispara el análisis una sola vez por reunión; reintentable si falla. */
export async function runPostTranscript(
  deps: PostTranscriptDeps,
  meetingId: string,
  opts: { force?: boolean } = {},
): Promise<{ outcome: PostTranscriptOutcome; detail?: unknown }> {
  const now = deps.now ?? (() => new Date());
  const key = analysisKey(meetingId);
  const claim = await claimEvent(
    deps.events,
    key,
    {
      kind: "step",
      event_type: "analysis",
      meeting_id: meetingId,
      // Si el proceso murió esperando el análisis, se puede retomar pasado el límite
      // (el gancho previo corre antes y cuenta en ese límite).
      staleMs: BEFORE_ANALYSIS_TIMEOUT_MS + ANALYSIS_TIMEOUT_MS + 60_000,
      maxAttempts: ANALYSIS_MAX_ATTEMPTS,
      retryAfterMs: ANALYSIS_RETRY_AFTER_MS,
      force: opts.force,
    },
    now(),
  );
  if (!claim.claimed) {
    const map: Record<string, PostTranscriptOutcome> = {
      done: "already_done",
      in_progress: "in_progress",
      max_attempts: "max_attempts",
      too_soon: "too_soon",
    };
    return { outcome: map[claim.reason ?? "in_progress"] };
  }

  // Gancho previo: se intenta una vez por corrida y no decide nada.
  if (deps.beforeAnalysis) {
    try {
      await deps.beforeAnalysis(meetingId);
    } catch (err) {
      console.error(`Gancho previo de ${meetingId} falló:`, err instanceof Error ? err.message : err);
    }
  }

  let result: CallResult;
  try {
    result = await deps.analyze(meetingId);
  } catch (err) {
    result = { ok: false, status: 0, error: err instanceof Error ? err.message : String(err) };
  }

  if (!result.ok) {
    const error = result.error ?? `analyze-meeting respondió ${result.status}`;
    await finishEvent(deps.events, key, "error", { error, detail: { http_status: result.status } }, now());
    return { outcome: "analysis_failed", detail: error };
  }

  // deno-lint-ignore no-explicit-any
  const body = (result.body ?? {}) as any;
  await finishEvent(
    deps.events,
    key,
    "done",
    {
      detail: {
        http_status: result.status,
        run_id: body.run_id ?? null,
        status: body.status ?? null,
        skip_reason: body.skip_reason ?? null,
        summary_status: body.summary_status ?? null,
      },
    },
    now(),
  );

  try {
    await deps.integrate(meetingId);
  } catch (err) {
    // Las integraciones dejan su propio registro y se pueden repetir sin daño.
    console.error(`Avisos de ${meetingId} fallaron:`, err instanceof Error ? err.message : err);
  }
  return { outcome: "analyzed", detail: body };
}

// --- Implementación real (HTTP entre funciones) -----------------------------

export function httpPostTranscriptDeps(input: {
  supabaseUrl: string;
  serviceRoleKey: string;
  events: EventStore;
  fetchImpl?: typeof fetch;
}): PostTranscriptDeps {
  const f = input.fetchImpl ?? fetch;
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${input.serviceRoleKey}`,
  };
  async function post(fn: string, body: unknown, timeoutMs: number): Promise<CallResult> {
    const res = await fetchWithTimeout(
      `${input.supabaseUrl}/functions/v1/${fn}`,
      { method: "POST", headers, body: JSON.stringify(body) },
      timeoutMs,
      f,
    );
    const text = await res.text().catch(() => "");
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = text.slice(0, 500);
    }
    return {
      ok: res.ok,
      status: res.status,
      body: parsed,
      // deno-lint-ignore no-explicit-any
      error: res.ok ? undefined : String((parsed as any)?.error ?? text.slice(0, 300) ?? res.status),
    };
  }
  return {
    events: input.events,
    analyze: (meetingId) => post("analyze-meeting", { meetingId, source: "pipeline" }, ANALYSIS_TIMEOUT_MS),
    // send-webhook no hace nada si OUTGOING_WEBHOOK_URL no está configurada.
    integrate: async (meetingId) => (await post("send-webhook", { meetingId }, 40_000)).status,
  };
}
