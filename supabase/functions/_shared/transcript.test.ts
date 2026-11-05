import { assert, assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  countTranscript,
  dedupeTurns,
  formatTime,
  formatTranscript,
  normalizeRecallTranscript,
  readTranscript,
  splitWordsByPauses,
  writeTranscript,
  type NewTurn,
} from "./transcript.ts";
import { FakeDb } from "./test-helpers.ts";

const w = (text: string, start: number, end: number) => ({
  text,
  start_timestamp: { relative: start },
  end_timestamp: { relative: end },
});

Deno.test("splitWordsByPauses: corta el turno cuando hay más de 1,5 s de silencio", () => {
  const parts = splitWordsByPauses([w("hola", 0, 0.4), w("qué", 0.5, 0.7), w("tal", 3.0, 3.2)]);
  assertEquals(parts.map((p) => p.map((x) => x.text).join(" ")), ["hola qué", "tal"]);
  assertEquals(splitWordsByPauses([]), []);
});

Deno.test("normalizeRecallTranscript: formato real de Recall, ordenado por tiempo", () => {
  const raw = [
    { participant: { id: 200, name: "Cliente" }, words: [w("Buenas", 5, 5.4), w("tardes", 5.5, 5.9)] },
    { participant: { id: 100, name: "Pedro Rojas" }, words: [w("Hola", 0, 0.3), w("equipo", 0.4, 0.8), w("Partimos", 4, 4.5)] },
    { participant: { id: 300, name: "Mudo" }, words: [] },
  ];
  const turns = normalizeRecallTranscript(raw);
  assertEquals(turns.map((t) => [t.speaker_name, t.content, t.start_time_ms, t.end_time_ms]), [
    ["Pedro Rojas", "Hola equipo", 0, 800],
    ["Pedro Rojas", "Partimos", 4000, 4500],
    ["Cliente", "Buenas tardes", 5000, 5900],
  ]);
  assertEquals(turns[0].speaker_id, "100");
});

Deno.test("normalizeRecallTranscript: entradas raras no rompen ni generan turnos vacíos", () => {
  assertEquals(normalizeRecallTranscript(null), []);
  assertEquals(normalizeRecallTranscript({ results: [] }), []);
  const turns = normalizeRecallTranscript([
    null,
    { participant: { name: "A" }, words: [{ text: "   " }] },
    { speaker: "B", text: "formato antiguo", start: 2, end: 3 },
  ]);
  assertEquals(turns, [{ speaker_name: "B", speaker_id: null, content: "formato antiguo", start_time_ms: 2000, end_time_ms: 3000 }]);
});

Deno.test("normalizeRecallTranscript: la misma transcripción entregada dos veces no duplica turnos", () => {
  const entry = { participant: { id: 1, name: "Pedro" }, words: [w("Hola", 0, 0.3)] };
  assertEquals(normalizeRecallTranscript([entry, entry]).length, 1);
});

Deno.test("dedupeTurns: quita repetidos (mismo inicio, hablante y texto) y conserva el primero", () => {
  const rows = [
    { id: "a", speaker_name: "Pedro", content: "Hola", start_time_ms: 0 },
    { id: "b", speaker_name: "Pedro", content: "Hola", start_time_ms: 0 },
    { id: "c", speaker_name: "Ana", content: "Hola", start_time_ms: 0 }, // otra persona: se queda
    { id: "d", speaker_name: "Pedro", content: "Hola", start_time_ms: 900 }, // otro momento: se queda
    { id: "e", speaker_name: "Pedro", content: "Hola", start_time_ms: 0 },
  ];
  assertEquals(dedupeTurns(rows).map((r) => r.id), ["a", "c", "d"]);
});

Deno.test("formatTranscript y formatTime", () => {
  assertEquals(formatTime(0), "00:00");
  assertEquals(formatTime(321_000), "05:21");
  assertEquals(formatTime(3_725_000), "62:05");
  const turns = [
    { speaker_name: "Pedro", content: "Hola", start_time_ms: 0 },
    { speaker_name: null, content: "Buenas", start_time_ms: 65_000 },
  ];
  assertEquals(formatTranscript(turns), "[00:00] Pedro: Hola\n[01:05] Speaker: Buenas");
  assertEquals(formatTranscript(turns, { timestamps: false }), "Pedro: Hola\nSpeaker: Buenas");
});

function makeTurns(n: number): NewTurn[] {
  return Array.from({ length: n }, (_, i) => ({
    speaker_name: i % 2 ? "Cliente" : "Pedro",
    speaker_id: String(i % 2),
    content: `turno ${i}`,
    start_time_ms: i * 1000,
    end_time_ms: i * 1000 + 800,
  }));
}

Deno.test("writeTranscript: 1.868 turnos en 4 llamadas, no en 1.868", async () => {
  const db = new FakeDb();
  const res = await writeTranscript(db, "m1", makeTurns(1868));
  assertEquals(res, { inserted: 1868, replaced: 0 });
  assertEquals(db.calls.filter((c) => c.table === "transcriptions" && c.action === "insert").length, 4);
  assertEquals(await countTranscript(db, "m1"), 1868);
});

Deno.test("writeTranscript: no duplica al escribir y reemplaza un intento anterior a medias", async () => {
  const db = new FakeDb();
  db.seed("transcriptions", makeTurns(30).map((t, i) => ({ id: `viejo-${i}`, meeting_id: "m1", ...t })));
  db.seed("transcriptions", [{ id: "otra", meeting_id: "m2", speaker_name: "X", content: "de otra reunión", start_time_ms: 0 }]);
  const turns = makeTurns(100);
  const res = await writeTranscript(db, "m1", [...turns, ...turns]); // llega repetida
  assertEquals(res, { inserted: 100, replaced: 30 });
  assertEquals(await countTranscript(db, "m1"), 100);
  assertEquals(await countTranscript(db, "m2"), 1, "no toca otras reuniones");
});

Deno.test("writeTranscript: si un lote falla no deja media transcripción", async () => {
  const db = new FakeDb({ failInsert: { table: "transcriptions", onCall: 2 } });
  await assertRejects(() => writeTranscript(db, "m1", makeTurns(1200)), Error, "lote 2");
  assertEquals(await countTranscript(db, "m1"), 0);
});

Deno.test("readTranscript: pagina más allá de las 1.000 filas de PostgREST", async () => {
  const db = new FakeDb({ maxRows: 1000 });
  db.seed("transcriptions", makeTurns(2350).map((t, i) => ({ id: `t${String(i).padStart(5, "0")}`, meeting_id: "m1", ...t })));
  const turns = await readTranscript(db, "m1");
  assertEquals(turns.length, 2350);
  assertEquals(turns[0].content, "turno 0");
  assertEquals(turns[2349].content, "turno 2349");
  assertEquals(db.calls.filter((c) => c.action === "select").length, 3);
});

Deno.test("readTranscript: desduplica las filas viejas repetidas y respeta el orden", async () => {
  const db = new FakeDb();
  const base = makeTurns(700).map((t, i) => ({ meeting_id: "m1", ...t, id: `a${String(i).padStart(4, "0")}` }));
  const copy = base.map((r) => ({ ...r, id: r.id.replace("a", "b") })); // la segunda copia que dejó la carrera
  db.seed("transcriptions", [...copy, ...base]);
  const turns = await readTranscript(db, "m1");
  assertEquals(turns.length, 700);
  assert(turns.every((t) => t.id.startsWith("a")), "conserva la primera fila por id");
  assertEquals(turns.map((t) => t.start_time_ms), base.map((t) => t.start_time_ms));
  assertEquals((await readTranscript(db, "m1", { dedupe: false })).length, 1400);
  assertEquals(await readTranscript(db, "no-existe"), []);
});
