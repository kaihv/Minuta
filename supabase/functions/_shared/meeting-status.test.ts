import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { canAdvance, outcomeWithoutRecording, statusesAllowedBefore } from "./meeting-status.ts";

const ENUM = ["scheduled", "recording", "processing", "completed", "failed", "not_recorded"];

Deno.test("solo se usan estados que existen en el enum meeting_status", () => {
  for (const to of ENUM) {
    for (const s of statusesAllowedBefore(to as never, { revive: true })) {
      assertEquals(ENUM.includes(s), true, `${s} no existe`);
    }
  }
});

Deno.test("avanza hacia adelante y nunca retrocede", () => {
  assertEquals(canAdvance("scheduled", "recording"), true);
  assertEquals(canAdvance("recording", "processing"), true);
  assertEquals(canAdvance("scheduled", "completed"), true); // transcript.done puede llegar antes que bot.done
  assertEquals(canAdvance("completed", "processing"), false);
  assertEquals(canAdvance("processing", "recording"), false);
  assertEquals(canAdvance("completed", "completed"), false);
});

Deno.test("el caso que dejó 71 reuniones pegadas: call_ended no puede pisar el not_recorded de done", () => {
  // bot.done marcó not_recorded; bot.call_ended llega 1 ms después y quiere 'processing'.
  assertEquals(canAdvance("not_recorded", "processing"), false);
  assertEquals(canAdvance("failed", "processing"), false);
});

Deno.test("un aviso atrasado no puede marcar no grabada una reunión ya completada", () => {
  assertEquals(canAdvance("completed", "not_recorded"), false);
  assertEquals(canAdvance("completed", "failed"), false);
  assertEquals(canAdvance("not_recorded", "failed"), false);
  assertEquals(canAdvance("processing", "not_recorded"), true);
});

Deno.test("si aparece una grabación, una reunión marcada no grabada revive", () => {
  assertEquals(canAdvance("not_recorded", "processing", { revive: true }), true);
  assertEquals(canAdvance("failed", "completed", { revive: true }), true);
  assertEquals(canAdvance("completed", "processing", { revive: true }), false);
});

Deno.test("sin grabación: motivo y estado", () => {
  assertEquals(outcomeWithoutRecording({ subCode: "timeout_exceeded_waiting_room", meetingStatus: "scheduled" }), {
    status: "not_recorded",
    reason: "timeout_exceeded_waiting_room",
  });
  assertEquals(outcomeWithoutRecording({ subCode: "noone_joined", meetingStatus: "scheduled" }).reason, "noone_joined");
  assertEquals(outcomeWithoutRecording({ subCode: "", lastCode: "done", meetingStatus: "scheduled" }), {
    status: "not_recorded",
    reason: "no_recording",
  });
  assertEquals(outcomeWithoutRecording({ subCode: "bot_errored", lastCode: "fatal", meetingStatus: "recording" }), {
    status: "failed",
    reason: "bot_errored",
  });
  assertEquals(outcomeWithoutRecording({ subCode: null, lastCode: "fatal", meetingStatus: "scheduled" }), {
    status: "not_recorded",
    reason: "fatal",
  });
});
