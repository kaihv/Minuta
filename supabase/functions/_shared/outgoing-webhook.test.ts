import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { buildWebhookPayload, safeWebhookUrl, signBody } from "./outgoing-webhook.ts";

const M = {
  id: "m1", title: "Pedido", scheduled_at: "2026-11-04T15:00:00Z", duration_minutes: 30,
  meeting_url: "https://meet.google.com/x", attendees: [{ email: "a@b.example" }], summary: { executive_summary: "- ok" }, status: "completed",
};

Deno.test("payload: enlace a la app y transcripción solo si se pide", () => {
  const p = buildWebhookPayload(M, { appUrl: "https://actas.example/", now: new Date("2026-11-04T16:00:00Z") });
  assertEquals((p.meeting as Record<string, unknown>).app_url, "https://actas.example/reunion/m1");
  assertEquals(p.event, "meeting.ready");
  assert(!("transcript" in p));
  assertEquals(buildWebhookPayload(M, { transcript: "[00:00] A: hola" }).transcript, "[00:00] A: hola");
  assertEquals((buildWebhookPayload({ ...M, attendees: null }).meeting as Record<string, unknown>).attendees, []);
});

Deno.test("firma HMAC-SHA256 conocida", async () => {
  // echo -n 'hola' | openssl dgst -sha256 -hmac 'secreto'
  assertEquals(await signBody("secreto", "hola"), "sha256=066c767a010a01db3c26a63892788142a7add13214edfb9d6fb63a38cb2c1cce");
  assert((await signBody("secreto", "hola")) !== (await signBody("otro", "hola")));
});

Deno.test("safeWebhookUrl: https público solamente", () => {
  assertEquals(safeWebhookUrl("https://hooks.zapier.com/x"), "https://hooks.zapier.com/x");
  for (const bad of ["http://x.example", "https://localhost/x", "https://127.0.0.1/x", "https://10.0.0.2/x", "https://192.168.1.5", "https://169.254.169.254/", "https://[::1]/", "https://[fd00::1]/x", "https://[::ffff:10.0.0.1]/", "https://api.localhost/", "nada", "", null]) {
    assertEquals(safeWebhookUrl(bad), null, String(bad));
  }
});
