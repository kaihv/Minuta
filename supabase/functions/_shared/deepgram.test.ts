import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { deepgramQuery, durationMinutes, turnsFromDeepgram } from "./deepgram.ts";

Deno.test("turnsFromDeepgram: utterances con hablante y tiempos", () => {
  const r = { results: { utterances: [
    { speaker: 0, transcript: " Buenos días ", start: 0.5, end: 1.2 },
    { speaker: 1, transcript: "", start: 2, end: 3 },
    { speaker: 1, transcript: "Hola", start: 3.25, end: 4 },
  ] }, metadata: { duration: 61 } };
  assertEquals(turnsFromDeepgram(r), [
    { speaker_name: "Hablante 1", speaker_id: "0", content: "Buenos días", start_time_ms: 500, end_time_ms: 1200 },
    { speaker_name: "Hablante 2", speaker_id: "1", content: "Hola", start_time_ms: 3250, end_time_ms: 4000 },
  ]);
  assertEquals(durationMinutes(r), 2);
});

Deno.test("turnsFromDeepgram: sin utterances usa el texto completo; vacío da []", () => {
  assertEquals(turnsFromDeepgram({ results: { channels: [{ alternatives: [{ transcript: "todo" }] }] } }).length, 1);
  assertEquals(turnsFromDeepgram({}), []);
  assertEquals(durationMinutes({}), null);
});

Deno.test("deepgramQuery: idioma configurable", () => {
  assertEquals(new URLSearchParams(deepgramQuery("en")).get("language"), "en");
  assertEquals(new URLSearchParams(deepgramQuery()).get("diarize"), "true");
});
