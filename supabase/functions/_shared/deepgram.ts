// Transcripción de audio subido (reuniones presenciales o archivos) con Deepgram.
// Se activa con DEEPGRAM_API_KEY. Idioma: TRANSCRIPT_LANGUAGE (por defecto "es").

import { fetchWithTimeout } from "./http.ts";
import type { NewTurn } from "./transcript.ts";

export function deepgramQuery(language = "es"): string {
  const qs = new URLSearchParams({
    model: "nova-2",
    language,
    punctuate: "true",
    diarize: "true",
    utterances: "true",
    smart_format: "true",
    utt_split: "0.8",
  });
  return qs.toString();
}

/** Pide a Deepgram que baje el audio desde una URL firmada y lo transcriba. */
export async function deepgramFromUrl(apiKey: string, audioUrl: string, language = "es", fetchImpl: typeof fetch = fetch) {
  const res = await fetchWithTimeout(`https://api.deepgram.com/v1/listen?${deepgramQuery(language)}`, {
    method: "POST",
    headers: { Authorization: `Token ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ url: audioUrl }),
  }, 300_000, fetchImpl);
  if (!res.ok) throw new Error(`Deepgram respondió ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return await res.json();
}

/** Respuesta de Deepgram -> turnos ("Hablante 1", "Hablante 2", ...). */
// deno-lint-ignore no-explicit-any
export function turnsFromDeepgram(result: any): NewTurn[] {
  const speaker = (s: unknown) => (typeof s === "number" ? `Hablante ${s + 1}` : "Hablante");
  const utterances = Array.isArray(result?.results?.utterances) ? result.results.utterances : [];
  if (utterances.length > 0) {
    return utterances
      // deno-lint-ignore no-explicit-any
      .filter((u: any) => typeof u?.transcript === "string" && u.transcript.trim())
      // deno-lint-ignore no-explicit-any
      .map((u: any) => ({
        speaker_name: speaker(u.speaker),
        speaker_id: typeof u.speaker === "number" ? String(u.speaker) : null,
        content: u.transcript.trim(),
        start_time_ms: Math.round((u.start ?? 0) * 1000),
        end_time_ms: typeof u.end === "number" ? Math.round(u.end * 1000) : null,
      }));
  }
  // Sin utterances: un solo bloque con todo el texto.
  const text = result?.results?.channels?.[0]?.alternatives?.[0]?.transcript;
  return typeof text === "string" && text.trim()
    ? [{ speaker_name: "Hablante", speaker_id: null, content: text.trim(), start_time_ms: 0, end_time_ms: null }]
    : [];
}

/** Duración del audio en minutos, si Deepgram la informa. */
// deno-lint-ignore no-explicit-any
export function durationMinutes(result: any): number | null {
  const s = result?.metadata?.duration;
  return typeof s === "number" && s > 0 ? Math.ceil(s / 60) : null;
}
