// Barrido de la tubería: lo que quedó a medias no se queda así para siempre.
//
// Antes no existía nada parecido: había 30 reuniones pegadas en estados
// intermedios (algunas desde marzo) y nadie lo sabía. El barrido corre al final
// de cada pasada de auto-record-scheduler (cada 5 minutos) y hace tres cosas:
//
//  1. Repite los avisos de Recall que fallaron o murieron a medias.
//  2. Reintenta los pasos que quedaron en error (video, transcripción, análisis).
//  3. Revisa las reuniones pegadas: le pregunta a Recall qué pasó con el bot y
//     las lleva a su estado real, o las cierra con un motivo.
//
// `sweepDecision` es pura y tiene pruebas. Todo lo que hace el barrido pasa por
// las mismas funciones idempotentes del webhook, así que repetirlo no hace daño.

import { claimEvent, finishEvent, type EventStore, type PipelineEvent } from "./pipeline-events.ts";
import { statusesAllowedBefore } from "./meeting-status.ts";
import { handleRecallEvent, reconcileMeeting, type MeetingRow, type PipelineDeps } from "./recall-pipeline.ts";

export interface SweepMeeting {
  id: string;
  status: string;
  meeting_type: string;
  auto_record?: boolean | null;
  recall_bot_id: string | null;
  scheduled_at: string | null;
  created_at: string;
  not_recorded_reason?: string | null;
}

export type SweepAction =
  | { action: "none"; why: string }
  | { action: "reconcile" }
  | { action: "close_not_recorded"; reason: string }
  | { action: "close_without_transcript"; reason: string };

const HOUR = 3600_000;

/** Qué hacer con una reunión que sigue en un estado intermedio. */
export function sweepDecision(m: SweepMeeting, now: Date): SweepAction {
  if (m.meeting_type !== "virtual") {
    // Presencial: el audio está en trozos en Storage y el rescate es manual
    // (botón en el detalle). El barrido no decide por la persona; aparece en salud.
    return { action: "none", why: "presencial_rescate_manual" };
  }
  const since = Date.parse(m.scheduled_at ?? m.created_at);
  if (!Number.isFinite(since)) return { action: "none", why: "sin_fecha" };
  const age = now.getTime() - since;
  if (age < 0) return { action: "none", why: "futura" };

  if (m.status === "scheduled") {
    if (m.recall_bot_id) {
      // El bot ya debería haber entrado o haberse ido (espera máxima 5 min).
      return age > 45 * 60_000 ? { action: "reconcile" } : { action: "none", why: "reciente" };
    }
    // Sin bot: automática que nunca consiguió bot, o intento manual abandonado.
    const limit = m.auto_record ? 3 * HOUR : 24 * HOUR;
    return age > limit
      ? { action: "close_not_recorded", reason: m.not_recorded_reason ?? "sweep:never_started" }
      : { action: "none", why: "reciente" };
  }

  if (m.status === "recording") {
    if (!m.recall_bot_id) return { action: "none", why: "sin_bot" };
    return age > 6 * HOUR ? { action: "reconcile" } : { action: "none", why: "puede_seguir_en_curso" };
  }

  if (m.status === "processing") {
    // Pasadas 24 h sin transcripción ya no va a llegar (y a los 7 días Recall
    // borra el archivo): se cierra como grabada sin transcripción, a la vista.
    if (age > 24 * HOUR) return { action: "close_without_transcript", reason: "transcript_unavailable" };
    if (!m.recall_bot_id) return { action: "none", why: "sin_bot" };
    return age > 45 * 60_000 ? { action: "reconcile" } : { action: "none", why: "reciente" };
  }
  return { action: "none", why: "estado_final" };
}

/** Lecturas que necesita el barrido además de las de la tubería. */
export interface SweepDb {
  listOpenMeetings(limit: number): Promise<SweepMeeting[]>;
  /** Avisos y pasos en error, o `processing` abandonados, de los últimos días. */
  listFailedEvents(sinceIso: string, staleBeforeIso: string, limit: number): Promise<PipelineEvent[]>;
}

export interface SweepDeps {
  pipeline: PipelineDeps;
  sweepDb: SweepDb;
  events: EventStore;
  now?: () => Date;
}

export interface SweepReport {
  events_replayed: number;
  steps_retried: number;
  meetings_checked: number;
  actions: Record<string, number>;
  errors: string[];
}

const MAX_ATTEMPTS: Record<string, number> = { webhook: 5, video: 4, "transcript-request": 3, "transcript-save": 5, analysis: 3 };

export async function runSweep(deps: SweepDeps, opts: { limit?: number; budgetMs?: number } = {}): Promise<SweepReport> {
  const now = deps.now ?? (() => new Date());
  const started = now().getTime();
  const budget = opts.budgetMs ?? 60_000;
  const limit = opts.limit ?? 10;
  const overBudget = () => now().getTime() - started > budget;
  const report: SweepReport = { events_replayed: 0, steps_retried: 0, meetings_checked: 0, actions: {}, errors: [] };
  const count = (k: string) => (report.actions[k] = (report.actions[k] ?? 0) + 1);
  const { db } = deps.pipeline;

  // 1 y 2: avisos y pasos que fallaron.
  let failed: PipelineEvent[] = [];
  try {
    failed = await deps.sweepDb.listFailedEvents(
      new Date(started - 3 * 24 * HOUR).toISOString(),
      new Date(started - 15 * 60_000).toISOString(),
      limit * 3,
    );
  } catch (err) {
    report.errors.push(`listar eventos: ${err instanceof Error ? err.message : err}`);
  }
  for (const ev of failed) {
    if (overBudget()) break;
    const type = ev.kind === "webhook" ? "webhook" : ev.event_type ?? "";
    if (ev.attempts >= (MAX_ATTEMPTS[type] ?? 3)) continue;
    try {
      if (ev.kind === "webhook") {
        // deno-lint-ignore no-explicit-any
        const payload = (ev.detail as any)?.event ? ev.detail : null;
        if (!payload) continue;
        const r = await handleRecallEvent(deps.pipeline, payload);
        if (r.outcome !== "duplicate") report.events_replayed++;
        count(`replay_${r.outcome}`);
      } else if (ev.kind === "step" && ev.meeting_id) {
        if (ev.event_type === "analysis") {
          await deps.pipeline.afterTranscript(ev.meeting_id);
        } else {
          const meeting = await db.getMeeting(ev.meeting_id);
          if (!meeting?.recall_bot_id) continue;
          await reconcileMeeting(deps.pipeline, meeting, meeting.recall_bot_id);
        }
        report.steps_retried++;
        count(`retry_${ev.event_type}`);
      }
    } catch (err) {
      report.errors.push(`${ev.event_key}: ${err instanceof Error ? err.message : err}`);
    }
  }

  // 3: reuniones pegadas. Cada una se revisa a lo más una vez por hora.
  let open: SweepMeeting[] = [];
  try {
    open = await deps.sweepDb.listOpenMeetings(limit * 5);
  } catch (err) {
    report.errors.push(`listar reuniones: ${err instanceof Error ? err.message : err}`);
  }
  for (const m of open) {
    if (overBudget() || report.meetings_checked >= limit) break;
    const decision = sweepDecision(m, now());
    if (decision.action === "none") continue;
    const hour = now().toISOString().slice(0, 13);
    const key = `sweep:meeting:${m.id}:${hour}`;
    const claim = await claimEvent(deps.events, key, { kind: "sweep", event_type: decision.action, meeting_id: m.id }, now());
    if (!claim.claimed) continue;
    report.meetings_checked++;
    try {
      let detail: unknown = decision;
      if (decision.action === "reconcile") {
        const meeting = (await db.getMeeting(m.id)) as MeetingRow | null;
        if (meeting?.recall_bot_id) {
          // Sin pista de "terminó": si el bot sigue en la llamada no se toca.
          detail = await reconcileMeeting(deps.pipeline, meeting, meeting.recall_bot_id);
        }
      } else if (decision.action === "close_not_recorded") {
        await db.advanceStatus(m.id, "not_recorded", statusesAllowedBefore("not_recorded"), {
          not_recorded_reason: decision.reason,
        });
      } else if (decision.action === "close_without_transcript") {
        await db.advanceStatus(m.id, "completed", statusesAllowedBefore("completed"), { pipeline_error: decision.reason });
      }
      count(decision.action);
      await finishEvent(deps.events, key, "done", { detail }, now());
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      report.errors.push(`${m.id}: ${message}`);
      await finishEvent(deps.events, key, "error", { error: message }, now());
    }
  }
  return report;
}

// --- Implementación sobre Supabase ------------------------------------------

// deno-lint-ignore no-explicit-any
type SupabaseLike = any;

export function supabaseSweepDb(supabase: SupabaseLike): SweepDb {
  return {
    async listOpenMeetings(limit) {
      const base = "id, status, meeting_type, auto_record, recall_bot_id, scheduled_at, created_at";
      const run = (cols: string) =>
        supabase
          .from("meetings")
          .select(cols)
          .in("status", ["scheduled", "recording", "processing"])
          .lt("created_at", new Date(Date.now() - 45 * 60_000).toISOString())
          .order("created_at", { ascending: false })
          .limit(limit);
      let res = await run(`${base}, not_recorded_reason`);
      if (res.error) res = await run(base); // migración sin aplicar
      if (res.error) throw new Error(res.error.message ?? "meetings");
      return (res.data ?? []) as SweepMeeting[];
    },
    async listFailedEvents(sinceIso, staleBeforeIso, limit) {
      const { data, error } = await supabase
        .from("pipeline_events")
        .select("*")
        .in("kind", ["webhook", "step"])
        .gte("created_at", sinceIso)
        .or(`status.eq.error,and(status.eq.processing,locked_at.lt.${staleBeforeIso})`)
        .order("created_at", { ascending: true })
        .limit(limit);
      if (error) return []; // sin tabla todavía: no hay nada que repetir
      return (data ?? []) as PipelineEvent[];
    },
  };
}
