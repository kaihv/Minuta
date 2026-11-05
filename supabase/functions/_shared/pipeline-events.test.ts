import { assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { claimEvent, finishEvent, memoryEventStore, runOnce, StoreUnavailable, type EventStore } from "./pipeline-events.ts";

const T0 = new Date("2026-10-07T12:00:00Z");
const at = (min: number) => new Date(T0.getTime() + min * 60_000);

Deno.test("el mismo aviso ocho veces (los reintentos de Recall) se procesa una sola vez", async () => {
  const store = memoryEventStore();
  let runs = 0;
  // Agenda real de reintentos: 0, 5 s, 5 min, 30 min, 2 h, 5 h, 10 h, 10 h.
  for (const min of [0, 0.08, 5, 35, 155, 455, 1055, 1655]) {
    const claim = await claimEvent(store, "recall:transcript.done:bot1:tr1", { kind: "webhook" }, at(min));
    if (claim.claimed) {
      runs++;
      await finishEvent(store, "recall:transcript.done:bot1:tr1", "done", {}, at(min + 1));
    }
  }
  assertEquals(runs, 1);
  assertEquals(store.rows.get("recall:transcript.done:bot1:tr1")?.attempts, 1);
});

Deno.test("dos avisos simultáneos: gana uno solo", async () => {
  const store = memoryEventStore();
  const claims = await Promise.all([
    claimEvent(store, "k", { kind: "webhook" }, T0),
    claimEvent(store, "k", { kind: "webhook" }, T0),
    claimEvent(store, "k", { kind: "webhook" }, T0),
  ]);
  assertEquals(claims.filter((c) => c.claimed).length, 1);
  assertEquals(claims.filter((c) => c.reason === "in_progress").length, 2);
});

Deno.test("un intento que murió a medias se puede retomar, pero no antes de que venza", async () => {
  const store = memoryEventStore();
  assertEquals((await claimEvent(store, "k", { kind: "step", staleMs: 5 * 60_000 }, T0)).claimed, true);
  assertEquals((await claimEvent(store, "k", { kind: "step", staleMs: 5 * 60_000 }, at(2))).reason, "in_progress");
  const retake = await claimEvent(store, "k", { kind: "step", staleMs: 5 * 60_000 }, at(6));
  assertEquals([retake.claimed, retake.attempts], [true, 2]);
});

Deno.test("tras un error se reintenta con espera y con tope de intentos", async () => {
  const store = memoryEventStore();
  const opts = { kind: "step", maxAttempts: 3, retryAfterMs: 15 * 60_000 };
  await claimEvent(store, "k", opts, T0);
  await finishEvent(store, "k", "error", { error: "Gemini 503" }, at(1));
  assertEquals((await claimEvent(store, "k", opts, at(5))).reason, "too_soon");
  assertEquals((await claimEvent(store, "k", opts, at(20))).claimed, true); // intento 2
  await finishEvent(store, "k", "error", { error: "Gemini 503" }, at(21));
  assertEquals((await claimEvent(store, "k", opts, at(40))).claimed, true); // intento 3
  await finishEvent(store, "k", "error", { error: "Gemini 503" }, at(41));
  assertEquals((await claimEvent(store, "k", opts, at(90))).reason, "max_attempts");
  assertEquals(store.rows.get("k")?.error, "Gemini 503");
});

Deno.test("`retryable` deja la puerta abierta; `done` y `skipped` la cierran; `force` la reabre", async () => {
  const store = memoryEventStore();
  await claimEvent(store, "a", { kind: "integration" }, T0);
  await finishEvent(store, "a", "retryable", { detail: { reason: "sin tareas todavía" } }, T0);
  assertEquals((await claimEvent(store, "a", { kind: "integration" }, at(1))).claimed, true);
  await finishEvent(store, "a", "done", {}, at(2));
  assertEquals((await claimEvent(store, "a", { kind: "integration" }, at(3))).reason, "done");
  assertEquals((await claimEvent(store, "a", { kind: "integration", force: true }, at(4))).claimed, true);
  await claimEvent(store, "b", { kind: "webhook" }, T0);
  await finishEvent(store, "b", "skipped", {}, T0);
  assertEquals((await claimEvent(store, "b", { kind: "webhook" }, at(1))).reason, "done");
});

Deno.test("runOnce: corre una vez, registra el error y deja reintentar", async () => {
  const store = memoryEventStore();
  let runs = 0;
  const work = () => { runs++; return Promise.resolve({ value: runs }); };
  assertEquals(await runOnce(store, "k", { kind: "step" }, work), { ran: true, value: 1 });
  assertEquals(await runOnce(store, "k", { kind: "step" }, work), { ran: false, reason: "done" });
  assertEquals(runs, 1);
  await assertRejects(() => runOnce(store, "x", { kind: "step" }, () => Promise.reject(new Error("se cayó"))), Error, "se cayó");
  assertEquals(store.rows.get("x")?.status, "error");
  assertEquals((await runOnce(store, "x", { kind: "step" }, work)).ran, true);
});

Deno.test("sin la tabla (migración sin aplicar) falla abierto: procesa y lo dice", async () => {
  const broken: EventStore = {
    insert: () => Promise.reject(new StoreUnavailable("relation pipeline_events does not exist")),
    get: () => Promise.resolve(null),
    takeOver: () => Promise.resolve(false),
    update: () => Promise.resolve(),
  };
  const claim = await claimEvent(broken, "k", { kind: "webhook" });
  assertEquals([claim.claimed, claim.storeAvailable], [true, false]);
});
