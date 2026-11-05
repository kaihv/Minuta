// Copia del video de Recall a nuestro Storage, y verificación de esa copia.
//
//  - sube con `upsert`, así dos manejadores no chocan por "ya existe";
//  - después de subir VERIFICA que el objeto exista y pese lo esperado;
//  - nunca carga el video en memoria (los hay de 1,7 GB).

import { fetchWithTimeout } from "./http.ts";

// deno-lint-ignore no-explicit-any
type SupabaseLike = any;

export const RECORDINGS_BUCKET = "meeting-recordings";

export function recordingObjectPath(userId: string, meetingId: string): string {
  return `${userId}/${meetingId}/recording.mp4`;
}

export interface BackupCheck {
  exists: boolean;
  bytes: number;
}

/**
 * ¿Se puede confiar en la copia? Regla pura (con pruebas):
 *  - tiene que existir y no ser un archivo vacío o de pocos bytes;
 *  - si se conoce el tamaño del original, no puede faltarle más de un 1%.
 */
export function backupIsTrustworthy(check: BackupCheck, expectedBytes?: number | null): boolean {
  if (!check.exists || check.bytes < 10_000) return false;
  if (expectedBytes && expectedBytes > 0) return check.bytes >= expectedBytes * 0.99;
  return true;
}

/** Busca el archivo de la grabación en Storage y devuelve su tamaño. */
export async function verifyRecordingBackup(
  supabase: SupabaseLike,
  userId: string,
  meetingId: string,
): Promise<BackupCheck> {
  const { data, error } = await supabase.storage
    .from(RECORDINGS_BUCKET)
    .list(`${userId}/${meetingId}`, { limit: 100, search: "recording" });
  if (error || !Array.isArray(data)) return { exists: false, bytes: 0 };
  // deno-lint-ignore no-explicit-any
  const file = data.find((f: any) => f.name === "recording.mp4");
  if (!file) return { exists: false, bytes: 0 };
  const bytes = Number(file.metadata?.size ?? 0);
  return { exists: true, bytes: Number.isFinite(bytes) ? bytes : 0 };
}

export interface StoreResult {
  stored: boolean;
  url: string | null; // la que se guarda en meetings.recording_url
  bytes: number;
  error?: string;
}

/** Copia el video (en streaming) y verifica el resultado. No lanza. */
export async function storeRecording(
  supabase: SupabaseLike,
  input: { userId: string; meetingId: string; sourceUrl: string },
  opts: { fetchImpl?: typeof fetch; uploadTimeoutMs?: number } = {},
): Promise<StoreResult> {
  const f = opts.fetchImpl ?? fetch;
  const path = recordingObjectPath(input.userId, input.meetingId);
  const bucket = supabase.storage.from(RECORDINGS_BUCKET);
  try {
    const { data: signed, error: signError } = await bucket.createSignedUploadUrl(path, { upsert: true });
    if (signError || !signed?.signedUrl) {
      return { stored: false, url: null, bytes: 0, error: `URL de subida: ${signError?.message ?? "sin URL"}` };
    }

    const download = await fetchWithTimeout(input.sourceUrl, {}, 30_000, f);
    if (!download.ok || !download.body) {
      return { stored: false, url: null, bytes: 0, error: `Descarga desde Recall: ${download.status}` };
    }
    const contentLength = download.headers.get("content-length");
    const expected = contentLength ? Number(contentLength) : null;

    const upload = await fetchWithTimeout(
      signed.signedUrl,
      {
        method: "PUT",
        headers: {
          "Content-Type": download.headers.get("content-type") || "video/mp4",
          "x-upsert": "true",
          ...(contentLength ? { "Content-Length": contentLength } : {}),
        },
        body: download.body,
        // deno-lint-ignore no-explicit-any
        ...({ duplex: "half" } as any),
      },
      opts.uploadTimeoutMs ?? 5 * 60_000,
      f,
    );
    if (!upload.ok) {
      const text = await upload.text().catch(() => "");
      return { stored: false, url: null, bytes: 0, error: `Subida a Storage: ${upload.status} ${text.slice(0, 200)}` };
    }
    await upload.body?.cancel().catch(() => {});

    const check = await verifyRecordingBackup(supabase, input.userId, input.meetingId);
    if (!backupIsTrustworthy(check, expected)) {
      return {
        stored: false,
        url: null,
        bytes: check.bytes,
        error: `La copia no calza: ${check.bytes} bytes guardados de ${expected ?? "?"}`,
      };
    }
    // El bucket es privado: se guarda la ruta y la app pide un enlace firmado
    // de 1 hora (función get-recording-url) cada vez que alguien la ve.
    return { stored: true, url: `${RECORDINGS_BUCKET}/${path}`, bytes: check.bytes };
  } catch (err) {
    return { stored: false, url: null, bytes: 0, error: err instanceof Error ? err.message : String(err) };
  }
}
