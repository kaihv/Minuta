// Registro de eventos de la tubería: la pieza que hace idempotente todo.
//
// Una fila por "cosa que debe pasar una sola vez", identificada por una clave
// única (`event_key`):
//   recall:transcript.done:<bot>:<transcript>   un aviso de Recall
//   step:transcript-save:<meeting>              un paso de la tubería
//   integration:<dept_integration>:<meeting>    una integración
//   hub-webhook:<meeting>                       el aviso a Sales OS
//
// `claimEvent` intenta insertar la fila. La base decide quién gana (restricción
// única), así que dos avisos simultáneos de Recall no pueden procesar lo mismo.
// Un aviso repetido encuentra la fila en `done` y se descarta. Si el dueño
// murió a medias (`processing` viejo) o terminó en `error`, otro intento puede
// retomarla, con tope de intentos y espera mínima.
//
// Tabla: public.pipeline_events (migración 20261007090000_pipeline_v2.sql).
// Si la tabla no existe todavía, las funciones "fallan abierto": procesan como
// antes y lo avisan en consola, para que desplegar código antes que la
// migración no detenga la tubería.

export type EventStatus = "processing" | "done" | "error" | "skipped" | "retryable";

export interface PipelineEvent {
  event_key: string;
  kind: string;
  event_type?: string | null;
  meeting_id?: string | null;
  bot_id?: string | null;
  status: EventStatus;
  attempts: number;
  detail?: unknown;
  error?: string | null;
  created_at?: string;
  locked_at?: string | null;
  finished_at?: string | null;
}

export class StoreUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StoreUnavailable";
  }
}

/** Lo mínimo que la lógica necesita de la base. Las pruebas usan una en memoria. */
export interface EventStore {
  /** Inserta; "conflict" si la clave ya existe. Lanza StoreUnavailable si no hay tabla. */
  insert(row: PipelineEvent): Promise<"inserted" | "conflict">;
  get(key: string): Promise<PipelineEvent | null>;
  /** UPDATE condicionado a (attempts, status) actuales. true si actualizó. */
  takeOver(key: string, expected: { attempts: number; status: EventStatus }, patch: Partial<PipelineEvent>): Promise<boolean>;
  update(key: string, patch: Partial<PipelineEvent>): Promise<void>;
}

export interface ClaimOptions {
  kind: string;
  event_type?: string;
  meeting_id?: string | null;
  bot_id?: string | null;
  detail?: unknown;
  /** Un `processing` más viejo que esto se considera abandonado. */
  staleMs?: number;
  /** Intentos totales permitidos (contando el primero). */
  maxAttempts?: number;
  /** Espera mínima desde el último fallo antes de reintentar. */
  retryAfterMs?: number;
  /** Retoma aunque esté `done` (reenvío manual explícito). */
  force?: boolean;
}

export type ClaimRefusal = "done" | "in_progress" | "max_attempts" | "too_soon";

export interface Claim {
  claimed: boolean;
  reason?: ClaimRefusal;
  attempts: number;
  /** false si la tabla no existe: se procesó "a la antigua", sin garantía. */
  storeAvailable: boolean;
}

const DEFAULT_STALE_MS = 10 * 60_000;

export async function claimEvent(
  store: EventStore,
  key: string,
  opts: ClaimOptions,
  now: Date = new Date(),
): Promise<Claim> {
  const nowIso = now.toISOString();
  try {
    const inserted = await store.insert({
      event_key: key,
      kind: opts.kind,
      event_type: opts.event_type ?? null,
      meeting_id: opts.meeting_id ?? null,
      bot_id: opts.bot_id ?? null,
      status: "processing",
      attempts: 1,
      detail: opts.detail ?? null,
      error: null,
      locked_at: nowIso,
      finished_at: null,
    });
    if (inserted === "inserted") return { claimed: true, attempts: 1, storeAvailable: true };

    const existing = await store.get(key);
    if (!existing) return { claimed: false, reason: "in_progress", attempts: 0, storeAvailable: true };

    if (!opts.force) {
      if (existing.status === "done" || existing.status === "skipped") {
        return { claimed: false, reason: "done", attempts: existing.attempts, storeAvailable: true };
      }
      if (existing.status === "processing") {
        const lockedAt = existing.locked_at ? Date.parse(existing.locked_at) : 0;
        if (now.getTime() - lockedAt < (opts.staleMs ?? DEFAULT_STALE_MS)) {
          return { claimed: false, reason: "in_progress", attempts: existing.attempts, storeAvailable: true };
        }
      }
      if (existing.attempts >= (opts.maxAttempts ?? Number.POSITIVE_INFINITY)) {
        return { claimed: false, reason: "max_attempts", attempts: existing.attempts, storeAvailable: true };
      }
      if (
        (existing.status === "error" || existing.status === "retryable") &&
        opts.retryAfterMs && existing.finished_at &&
        now.getTime() - Date.parse(existing.finished_at) < opts.retryAfterMs
      ) {
        return { claimed: false, reason: "too_soon", attempts: existing.attempts, storeAvailable: true };
      }
    }

    const won = await store.takeOver(
      key,
      { attempts: existing.attempts, status: existing.status },
      {
        status: "processing",
        attempts: existing.attempts + 1,
        locked_at: nowIso,
        finished_at: null,
        error: null,
        ...(opts.meeting_id ? { meeting_id: opts.meeting_id } : {}),
      },
    );
    return won
      ? { claimed: true, attempts: existing.attempts + 1, storeAvailable: true }
      : { claimed: false, reason: "in_progress", attempts: existing.attempts, storeAvailable: true };
  } catch (err) {
    if (err instanceof StoreUnavailable) {
      console.warn(`pipeline_events no disponible (${err.message}); se procesa sin idempotencia: ${key}`);
      return { claimed: true, attempts: 1, storeAvailable: false };
    }
    throw err;
  }
}

export async function finishEvent(
  store: EventStore,
  key: string,
  status: Exclude<EventStatus, "processing">,
  patch: { detail?: unknown; error?: string | null; meeting_id?: string | null } = {},
  now: Date = new Date(),
): Promise<void> {
  try {
    await store.update(key, {
      status,
      finished_at: now.toISOString(),
      ...(patch.detail !== undefined ? { detail: patch.detail } : {}),
      ...(patch.error !== undefined ? { error: patch.error ? String(patch.error).slice(0, 2000) : null } : {}),
      ...(patch.meeting_id ? { meeting_id: patch.meeting_id } : {}),
    });
  } catch (err) {
    // Nunca dejar que el registro tumbe el trabajo ya hecho.
    console.warn(`No se pudo cerrar el evento ${key} como ${status}:`, err instanceof Error ? err.message : err);
  }
}

/**
 * Corre `work` una sola vez por clave. Devuelve { ran: false } si otro ya lo
 * hizo o lo está haciendo. Si `work` lanza, el evento queda en `error` (y otro
 * intento podrá retomarlo) y la excepción se propaga.
 */
export async function runOnce<T>(
  store: EventStore,
  key: string,
  opts: ClaimOptions,
  work: (claim: Claim) => Promise<{ status?: Exclude<EventStatus, "processing">; detail?: unknown; value: T }>,
  now: () => Date = () => new Date(),
): Promise<{ ran: true; value: T } | { ran: false; reason: ClaimRefusal }> {
  const claim = await claimEvent(store, key, opts, now());
  if (!claim.claimed) return { ran: false, reason: claim.reason ?? "in_progress" };
  try {
    const out = await work(claim);
    await finishEvent(store, key, out.status ?? "done", { detail: out.detail, meeting_id: opts.meeting_id }, now());
    return { ran: true, value: out.value };
  } catch (err) {
    await finishEvent(store, key, "error", { error: err instanceof Error ? err.message : String(err) }, now());
    throw err;
  }
}

// --- Implementación sobre Supabase ------------------------------------------

// deno-lint-ignore no-explicit-any
type SupabaseLike = any;

const TABLE = "pipeline_events";

function unavailable(error: { code?: string; message?: string }): boolean {
  // 42P01: la tabla no existe. PGRST205 / PGRST204: PostgREST no la conoce.
  const code = error?.code ?? "";
  return code === "42P01" || code === "PGRST205" || code === "PGRST204" ||
    /could not find the table|relation .* does not exist|schema cache/i.test(error?.message ?? "");
}

export function supabaseEventStore(supabase: SupabaseLike): EventStore {
  return {
    async insert(row) {
      const { error } = await supabase.from(TABLE).insert(row);
      if (!error) return "inserted";
      if (error.code === "23505") return "conflict";
      if (unavailable(error)) throw new StoreUnavailable(error.message ?? "sin tabla");
      throw new Error(`pipeline_events insert: ${error.message ?? error.code}`);
    },
    async get(key) {
      const { data, error } = await supabase.from(TABLE).select("*").eq("event_key", key).maybeSingle();
      if (error) {
        if (unavailable(error)) throw new StoreUnavailable(error.message ?? "sin tabla");
        throw new Error(`pipeline_events get: ${error.message ?? error.code}`);
      }
      return (data as PipelineEvent) ?? null;
    },
    async takeOver(key, expected, patch) {
      const { data, error } = await supabase
        .from(TABLE)
        .update(patch)
        .eq("event_key", key)
        .eq("attempts", expected.attempts)
        .eq("status", expected.status)
        .select("event_key");
      if (error) {
        if (unavailable(error)) throw new StoreUnavailable(error.message ?? "sin tabla");
        throw new Error(`pipeline_events takeOver: ${error.message ?? error.code}`);
      }
      return Array.isArray(data) && data.length > 0;
    },
    async update(key, patch) {
      const { error } = await supabase.from(TABLE).update(patch).eq("event_key", key);
      if (error && !unavailable(error)) throw new Error(`pipeline_events update: ${error.message ?? error.code}`);
    },
  };
}

// --- Implementación en memoria (pruebas y ejecución sin base) ---------------

export function memoryEventStore(initial: PipelineEvent[] = []): EventStore & { rows: Map<string, PipelineEvent> } {
  const rows = new Map<string, PipelineEvent>(initial.map((r) => [r.event_key, { ...r }]));
  return {
    rows,
    insert(row) {
      if (rows.has(row.event_key)) return Promise.resolve("conflict" as const);
      rows.set(row.event_key, { ...row, created_at: row.created_at ?? new Date().toISOString() });
      return Promise.resolve("inserted" as const);
    },
    get(key) {
      const r = rows.get(key);
      return Promise.resolve(r ? { ...r } : null);
    },
    takeOver(key, expected, patch) {
      const r = rows.get(key);
      if (!r || r.attempts !== expected.attempts || r.status !== expected.status) return Promise.resolve(false);
      rows.set(key, { ...r, ...patch });
      return Promise.resolve(true);
    },
    update(key, patch) {
      const r = rows.get(key);
      if (r) rows.set(key, { ...r, ...patch });
      return Promise.resolve();
    },
  };
}
