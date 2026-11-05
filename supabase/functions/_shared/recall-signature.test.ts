// deno test supabase/functions/_shared/recall-signature.test.ts
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { signForTest, verifyRecallSignature } from "./recall-signature.ts";

const SECRET = "whsec_" + btoa("una-llave-de-prueba-de-32-bytes!");
const BODY = JSON.stringify({ event: "bot.done", data: { bot: { id: "abc" } } });
const NOW = 1_800_000_000;

async function headers(prefix: "webhook" | "svix", body = BODY, ts = NOW, secret = SECRET) {
  return new Headers({
    [`${prefix}-id`]: "msg_1",
    [`${prefix}-timestamp`]: String(ts),
    [`${prefix}-signature`]: await signForTest(secret, "msg_1", ts, body),
  });
}

Deno.test("sin secreto configurado: unconfigured (el webhook sigue como antes)", async () => {
  assertEquals(await verifyRecallSignature(new Headers(), BODY, undefined, NOW), "unconfigured");
  assertEquals(await verifyRecallSignature(new Headers(), BODY, "", NOW), "unconfigured");
});

Deno.test("firma válida con cabeceras webhook-* y svix-*", async () => {
  assertEquals(await verifyRecallSignature(await headers("webhook"), BODY, SECRET, NOW), "valid");
  assertEquals(await verifyRecallSignature(await headers("svix"), BODY, SECRET, NOW), "valid");
});

Deno.test("varias firmas: basta una válida", async () => {
  const h = await headers("webhook");
  h.set("webhook-signature", `v1,AAAA ${h.get("webhook-signature")}`);
  assertEquals(await verifyRecallSignature(h, BODY, SECRET, NOW), "valid");
});

Deno.test("inválida: sin cabeceras, cuerpo cambiado, otra llave, fuera de tiempo", async () => {
  assertEquals(await verifyRecallSignature(new Headers(), BODY, SECRET, NOW), "invalid");
  assertEquals(await verifyRecallSignature(await headers("webhook"), BODY + " ", SECRET, NOW), "invalid");
  assertEquals(await verifyRecallSignature(await headers("webhook", BODY, NOW, "whsec_" + btoa("otra-llave")), BODY, SECRET, NOW), "invalid");
  assertEquals(await verifyRecallSignature(await headers("webhook", BODY, NOW - 3600), BODY, SECRET, NOW), "invalid");
  const h = await headers("webhook");
  h.set("webhook-timestamp", "no-es-numero");
  assertEquals(await verifyRecallSignature(h, BODY, SECRET, NOW), "invalid");
});
