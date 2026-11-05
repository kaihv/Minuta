import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  botIsTerminal,
  buildBotRequest,
  extractBotSeconds,
  extractDurationMinutes,
  extractMeetingUrl,
  extractRecordingId,
  extractTranscriptShortcut,
  extractVideoUrl,
  lastStatus,
  recordingIsReady,
} from "./recall.ts";
import { backupIsTrustworthy, recordingObjectPath } from "./recording-storage.ts";

const bot = {
  meeting_url: { meeting_id: "abc-defg-hij", platform: "google_meet" },
  status_changes: [
    { code: "joining_call", created_at: "2026-10-07T15:00:00Z" },
    { code: "in_waiting_room", created_at: "2026-10-07T15:00:10Z" },
    { code: "in_call_recording", created_at: "2026-10-07T15:01:00Z" },
    { code: "call_ended", sub_code: "call_ended_by_host", created_at: "2026-10-07T15:31:30Z" },
    { code: "done", created_at: "2026-10-07T15:31:40Z" },
  ],
  recordings: [{
    id: "rec-1",
    status: { code: "done" },
    media_shortcuts: {
      video_mixed: { data: { download_url: "https://recall.example/v.mp4" } },
      transcript: { id: "tr-1", status: { code: "done" }, data: { download_url: "https://recall.example/t.json" } },
    },
  }],
};

Deno.test("datos del bot: grabación, video, duración y segundos cobrados", () => {
  assertEquals(extractRecordingId(bot), "rec-1");
  assertEquals(extractVideoUrl(bot), "https://recall.example/v.mp4");
  assertEquals(recordingIsReady(bot), true);
  assertEquals(extractDurationMinutes(bot), 31);
  assertEquals(extractBotSeconds(bot), 31 * 60 + 40);
  assertEquals(botIsTerminal(bot), true);
  assertEquals(lastStatus(bot), { code: "done", subCode: null });
  assertEquals(extractTranscriptShortcut(bot), { id: "tr-1", status: "done", downloadUrl: "https://recall.example/t.json" });
  assertEquals(extractMeetingUrl(bot), { url: "https://meet.google.com/abc-defg-hij", fragment: "abc-defg-hij" });
  assertEquals(extractMeetingUrl({ meeting_url: "https://meet.google.com/xyz-1234-abc?authuser=0" }).fragment, "xyz-1234-abc");
});

Deno.test("bot sin grabación o con grabación fallida", () => {
  const empty = { status_changes: [{ code: "done", sub_code: "timeout_exceeded_waiting_room" }], recordings: [] };
  assertEquals(extractRecordingId(empty), null);
  assertEquals(extractVideoUrl(empty), null);
  assertEquals(recordingIsReady(empty), false);
  assertEquals(lastStatus(empty).subCode, "timeout_exceeded_waiting_room");
  assertEquals(extractRecordingId({ recordings: [{ id: "x", status: { code: "failed" } }] }), null);
  assertEquals(extractBotSeconds({}), 0);
  assertEquals(botIsTerminal({ status_changes: [{ code: "in_call_recording" }] }), false);
});

Deno.test("crear bot: un solo cuerpo, retención de 7 días y aviso de grabación apagado por defecto", () => {
  const body = buildBotRequest("https://meet.google.com/abc", { bot_name: "Mi Bot", waiting_room_timeout: 120 });
  assertEquals(body.bot_name, "Mi Bot");
  // deno-lint-ignore no-explicit-any
  const b = body as any;
  assertEquals(b.automatic_leave.waiting_room_timeout, 120);
  assertEquals(b.automatic_leave.noone_joined_timeout, 300);
  assertEquals(b.recording_config.retention, { type: "timed", hours: 168 });
  assertEquals(b.recording_config.video_mixed_layout, "gallery_view_v2");
  assert(!("chat" in body), "sin aviso salvo que se configure");
  assert(!("join_at" in body));
  const withNotice = buildBotRequest("https://meet.google.com/abc", null, { joinMessage: " Esta reunión se está grabando. ", joinAt: "2026-10-07T15:00:00Z" });
  // deno-lint-ignore no-explicit-any
  assertEquals((withNotice as any).chat.on_bot_join.message, "Esta reunión se está grabando.");
  assertEquals(withNotice.join_at, "2026-10-07T15:00:00Z");
});

Deno.test("respaldo del video: cuándo se puede confiar (y por lo tanto borrar en Recall)", () => {
  assertEquals(backupIsTrustworthy({ exists: false, bytes: 0 }), false);
  assertEquals(backupIsTrustworthy({ exists: true, bytes: 0 }), false);
  assertEquals(backupIsTrustworthy({ exists: true, bytes: 512 }), false, "un archivo de pocos bytes no es un video");
  assertEquals(backupIsTrustworthy({ exists: true, bytes: 48_000_000 }), true);
  assertEquals(backupIsTrustworthy({ exists: true, bytes: 48_000_000 }, 96_000_000), false, "copia cortada a la mitad");
  assertEquals(backupIsTrustworthy({ exists: true, bytes: 95_900_000 }, 96_000_000), true);
  assertEquals(recordingObjectPath("u1", "m1"), "u1/m1/recording.mp4");
});
