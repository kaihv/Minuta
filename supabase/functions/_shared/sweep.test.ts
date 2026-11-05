import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { sweepDecision, type SweepMeeting } from "./sweep.ts";

const NOW = new Date("2026-10-07T18:00:00Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3600_000).toISOString();
const m = (over: Partial<SweepMeeting>): SweepMeeting => ({
  id: "m1",
  status: "scheduled",
  meeting_type: "virtual",
  auto_record: true,
  recall_bot_id: "bot-1",
  scheduled_at: hoursAgo(2),
  created_at: hoursAgo(2),
  ...over,
});
const act = (over: Partial<SweepMeeting>) => sweepDecision(m(over), NOW).action;

Deno.test("reunión futura o recién empezada: no se toca", () => {
  assertEquals(act({ scheduled_at: hoursAgo(-1) }), "none");
  assertEquals(act({ scheduled_at: hoursAgo(0.3) }), "none");
  assertEquals(act({ status: "processing", scheduled_at: hoursAgo(0.5) }), "none");
  assertEquals(act({ status: "recording", scheduled_at: hoursAgo(2) }), "none");
});

Deno.test("con bot y pegada: se le pregunta a Recall qué pasó", () => {
  assertEquals(act({ status: "scheduled", scheduled_at: hoursAgo(1) }), "reconcile");
  assertEquals(act({ status: "recording", scheduled_at: hoursAgo(7) }), "reconcile");
  assertEquals(act({ status: "processing", scheduled_at: hoursAgo(2) }), "reconcile");
});

Deno.test("sin bot: la automática se cierra a las 3 horas, la manual a las 24", () => {
  assertEquals(act({ recall_bot_id: null, scheduled_at: hoursAgo(2) }), "none");
  assertEquals(sweepDecision(m({ recall_bot_id: null, scheduled_at: hoursAgo(4) }), NOW), {
    action: "close_not_recorded",
    reason: "sweep:never_started",
  });
  assertEquals(act({ recall_bot_id: null, auto_record: false, scheduled_at: hoursAgo(4) }), "none");
  assertEquals(act({ recall_bot_id: null, auto_record: false, scheduled_at: hoursAgo(30) }), "close_not_recorded");
  // Si el programador dejó anotado por qué no hubo bot, se conserva ese motivo.
  assertEquals(
    sweepDecision(m({ recall_bot_id: null, scheduled_at: hoursAgo(4), not_recorded_reason: "bot_create_failed: 507" }), NOW),
    { action: "close_not_recorded", reason: "bot_create_failed: 507" },
  );
});

Deno.test("procesando hace más de un día: se cierra como grabada sin transcripción", () => {
  assertEquals(sweepDecision(m({ status: "processing", scheduled_at: hoursAgo(30) }), NOW), {
    action: "close_without_transcript",
    reason: "transcript_unavailable",
  });
});

Deno.test("presencial pegada: no se decide por la persona", () => {
  assertEquals(sweepDecision(m({ meeting_type: "in_person", status: "recording", recall_bot_id: null, scheduled_at: hoursAgo(900) }), NOW), {
    action: "none",
    why: "presencial_rescate_manual",
  });
});

Deno.test("las 30 reuniones pegadas de producción al 06-oct-2026 tienen salida", () => {
  // 15 manuales sin bot (marzo a agosto), 11 automáticas con bot (septiembre), 4 presenciales.
  const sinBot = Array.from({ length: 15 }, () => m({ recall_bot_id: null, auto_record: false, scheduled_at: hoursAgo(24 * 60) }));
  const conBot = Array.from({ length: 11 }, () => m({ scheduled_at: hoursAgo(24 * 20) }));
  const presenciales = Array.from({ length: 4 }, () => m({ meeting_type: "in_person", status: "recording", recall_bot_id: null }));
  assertEquals(sinBot.every((x) => sweepDecision(x, NOW).action === "close_not_recorded"), true);
  assertEquals(conBot.every((x) => sweepDecision(x, NOW).action === "reconcile"), true);
  assertEquals(presenciales.every((x) => sweepDecision(x, NOW).action === "none"), true);
});
