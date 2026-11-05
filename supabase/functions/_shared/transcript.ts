// Escritura y lectura de transcripciones: UN solo lugar.
//
// Problemas que resuelve (auditoría 06-oct-2026):
//  - se insertaba un turno por llamada (mediana 30 s por reunión) y Recall daba
//    el aviso por perdido y lo reintentaba 20 veces;
//  - dos avisos simultáneos pasaban el "¿ya hay turnos?" y duplicaban la
//    transcripción (48.477 filas de más, 25% de la tabla);
//  - los lectores pedían `.select()` sin paginar y PostgREST corta en 1.000
//    filas: las reuniones largas (hasta 1.868 turnos) se analizaban truncadas.
//
// Las funciones puras (normalizar, desduplicar, formatear) no tocan la red y
// tienen pruebas en transcript.test.ts.

export interface TranscriptTurn {
  id: string;
  meeting_id: string;
  speaker_name: string | null;
  speaker_id: string | null;
  content: string;
  start_time_ms: number;
  end_time_ms: number | null;
}

/** Un turno listo para insertar (todavía sin id ni reunión). */
export interface NewTurn {
  speaker_name: string | null;
  speaker_id: string | null;
  content: string;
  start_time_ms: number;
  end_time_ms: number | null;
}

// Cliente supabase-js, de servicio o de usuario. Sin tipar a propósito: las
// funciones usan el cliente sin el esquema generado.
// deno-lint-ignore no-explicit-any
export type SupabaseLike = any;

const PAGE_SIZE = 1000; // tope de filas por respuesta de PostgREST (max_rows)
const INSERT_CHUNK = 500;

// --- Normalización (pura) --------------------------------------------------

interface RecallWord {
  text?: string;
  word?: string;
  start_timestamp?: { relative?: number };
  end_timestamp?: { relative?: number };
}

/** Parte las palabras de un hablante en turnos cuando hay una pausa larga. */
export function splitWordsByPauses<T extends RecallWord>(words: T[], pauseSeconds = 1.5): T[][] {
  if (!Array.isArray(words) || words.length === 0) return [];
  const segments: T[][] = [];
  let current: T[] = [words[0]];
  for (let i = 1; i < words.length; i++) {
    const prevEnd = words[i - 1]?.end_timestamp?.relative ?? 0;
    const start = words[i]?.start_timestamp?.relative ?? 0;
    if (start - prevEnd > pauseSeconds) {
      segments.push(current);
      current = [words[i]];
    } else {
      current.push(words[i]);
    }
  }
  segments.push(current);
  return segments;
}

function toMs(seconds: unknown): number | null {
  return typeof seconds === "number" && Number.isFinite(seconds) ? Math.round(seconds * 1000) : null;
}

/**
 * Convierte la transcripción de Recall (lista de { participant, words }) en
 * turnos ordenados por tiempo. Acepta también el formato plano antiguo
 * ({ speaker, text, start, end }). Descarta turnos vacíos.
 */
export function normalizeRecallTranscript(raw: unknown, pauseSeconds = 1.5): NewTurn[] {
  if (!Array.isArray(raw)) return [];
  const turns: NewTurn[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    // deno-lint-ignore no-explicit-any
    const e = entry as any;
    if (e.participant && Array.isArray(e.words)) {
      for (const words of splitWordsByPauses<RecallWord>(e.words, pauseSeconds)) {
        const content = words.map((w) => w.text ?? w.word ?? "").join(" ").replace(/\s+/g, " ").trim();
        if (!content) continue;
        turns.push({
          speaker_name: e.participant.name || "Participante",
          speaker_id: e.participant.id != null ? String(e.participant.id) : null,
          content,
          start_time_ms: toMs(words[0]?.start_timestamp?.relative) ?? 0,
          end_time_ms: toMs(words[words.length - 1]?.end_timestamp?.relative),
        });
      }
      continue;
    }
    const content = String(e.text ?? e.content ?? e.transcript ?? "").trim();
    if (!content) continue;
    turns.push({
      speaker_name: e.speaker ?? e.speaker_name ?? "Participante",
      speaker_id: e.speaker_id != null ? String(e.speaker_id) : null,
      content,
      start_time_ms: toMs(e.start_time ?? e.start) ?? 0,
      end_time_ms: toMs(e.end_time ?? e.end),
    });
  }
  return sortTurns(dedupeTurns(turns));
}

function sortTurns<T extends { start_time_ms: number }>(turns: T[]): T[] {
  // Orden estable: a igual inicio se conserva el orden de llegada.
  return turns
    .map((t, i) => ({ t, i }))
    .sort((a, b) => a.t.start_time_ms - b.t.start_time_ms || a.i - b.i)
    .map(({ t }) => t);
}

/** Clave de igualdad de un turno: mismo inicio, mismo hablante, mismo texto. */
export function turnKey(t: Pick<TranscriptTurn, "speaker_name" | "content" | "start_time_ms">): string {
  return `${t.start_time_ms}\u0001${t.speaker_name ?? ""}\u0001${t.content}`;
}

/** Quita turnos repetidos conservando el primero. Puro, estable. */
export function dedupeTurns<T extends Pick<TranscriptTurn, "speaker_name" | "content" | "start_time_ms">>(
  rows: T[],
): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const row of rows) {
    const key = turnKey(row);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

export function formatTime(ms: number): string {
  const total = Math.max(0, Math.floor((ms || 0) / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

/** "[mm:ss] Hablante: texto" por línea; sin marca de tiempo con timestamps: false. */
export function formatTranscript(
  turns: Pick<TranscriptTurn, "speaker_name" | "content" | "start_time_ms">[],
  opts: { timestamps?: boolean } = {},
): string {
  const withTime = opts.timestamps !== false;
  return turns
    .map((t) => `${withTime ? `[${formatTime(t.start_time_ms)}] ` : ""}${t.speaker_name || "Speaker"}: ${t.content}`)
    .join("\n");
}

// --- Lectura ---------------------------------------------------------------

/**
 * Lee TODOS los turnos de una reunión: pagina (no se corta en 1.000), ordena
 * por (start_time_ms, id) y desduplica. Lanza si la base devuelve error.
 */
export async function readTranscript(
  supabase: SupabaseLike,
  meetingId: string,
  opts: { pageSize?: number; maxRows?: number; dedupe?: boolean } = {},
): Promise<TranscriptTurn[]> {
  const pageSize = Math.max(1, Math.min(opts.pageSize ?? PAGE_SIZE, PAGE_SIZE));
  const maxRows = opts.maxRows ?? 50_000;
  const rows: TranscriptTurn[] = [];
  for (let from = 0; from < maxRows; from += pageSize) {
    const { data, error } = await supabase
      .from("transcriptions")
      .select("id, meeting_id, speaker_name, speaker_id, content, start_time_ms, end_time_ms")
      .eq("meeting_id", meetingId)
      .order("start_time_ms", { ascending: true })
      .order("id", { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) throw new Error(`No se pudo leer la transcripción de ${meetingId}: ${error.message ?? error}`);
    const page = (data ?? []) as TranscriptTurn[];
    rows.push(...page);
    if (page.length < pageSize) break;
  }
  return opts.dedupe === false ? rows : dedupeTurns(rows);
}

/** Cuántos turnos tiene guardados una reunión (sin traerlos). */
export async function countTranscript(supabase: SupabaseLike, meetingId: string): Promise<number> {
  const { count, error } = await supabase
    .from("transcriptions")
    .select("id", { count: "exact", head: true })
    .eq("meeting_id", meetingId);
  if (error) throw new Error(`No se pudo contar la transcripción de ${meetingId}: ${error.message ?? error}`);
  return count ?? 0;
}

// --- Escritura -------------------------------------------------------------

export interface WriteResult {
  inserted: number;
  replaced: number; // filas de un intento anterior que se reemplazaron
}

/**
 * Guarda la transcripción completa de una reunión en lotes (500 filas por
 * llamada, no una por turno) y sin duplicar:
 *  - desduplica los turnos antes de escribir;
 *  - si quedaron filas de un intento anterior a medias, las reemplaza.
 * Quien llama debe tener el paso reclamado (pipeline-events) para que no haya
 * dos escritores a la vez; el índice único (migración pendiente) es el cinturón.
 * Si un lote falla, borra lo insertado en este intento y lanza.
 */
export async function writeTranscript(
  supabase: SupabaseLike,
  meetingId: string,
  turns: NewTurn[],
): Promise<WriteResult> {
  const clean = sortTurns(dedupeTurns(turns.filter((t) => t.content && t.content.trim().length > 0)));

  const previous = await countTranscript(supabase, meetingId);
  if (previous > 0) {
    const { error } = await supabase.from("transcriptions").delete().eq("meeting_id", meetingId);
    if (error) throw new Error(`No se pudo limpiar la transcripción anterior: ${error.message ?? error}`);
  }

  let inserted = 0;
  for (let i = 0; i < clean.length; i += INSERT_CHUNK) {
    const chunk = clean.slice(i, i + INSERT_CHUNK).map((t) => ({ meeting_id: meetingId, ...t }));
    const { error } = await supabase.from("transcriptions").insert(chunk);
    if (error) {
      // No dejar media transcripción: el próximo intento parte de cero.
      await supabase.from("transcriptions").delete().eq("meeting_id", meetingId);
      throw new Error(`No se pudo guardar la transcripción (lote ${i / INSERT_CHUNK + 1}): ${error.message ?? error}`);
    }
    inserted += chunk.length;
  }
  return { inserted, replaced: previous };
}

/**
 * Marca la transcripción como completa. Las columnas son nuevas
 * (migración 20261007090000): si todavía no existen, no rompe.
 */
export async function markTranscriptComplete(
  supabase: SupabaseLike,
  meetingId: string,
  segments: number,
  now: Date = new Date(),
): Promise<void> {
  const { error } = await supabase
    .from("meetings")
    .update({ transcript_completed_at: now.toISOString(), transcript_segments: segments })
    .eq("id", meetingId);
  if (error) console.warn(`No se pudo marcar la transcripción completa (¿migración sin aplicar?): ${error.message ?? error}`);
}
