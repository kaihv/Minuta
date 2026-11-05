// deno test supabase/functions/_shared/oauth-state.test.ts
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { allowedOrigins, safeReturnUrl, signState, STATE_TTL_MS, verifyState, withParam } from "./oauth-state.ts";

const SECRET = "llave-de-prueba";
const DATA = { userId: "11111111-1111-4111-8111-111111111111", redirectUrl: "https://actas.miempresa.example/ajustes" };

Deno.test("state firmado: ida y vuelta", async () => {
  const s = await signState(SECRET, DATA);
  assertEquals(await verifyState(SECRET, s), DATA);
});

Deno.test("state: el formato viejo (JSON en base64, sin firma) ya no vale", async () => {
  const viejo = btoa(JSON.stringify({ userId: DATA.userId, redirectUrl: "https://evil.example" }));
  assertEquals(await verifyState(SECRET, viejo), null);
});

Deno.test("state: cambiar el usuario invalida la firma", async () => {
  const s = await signState(SECRET, DATA);
  const [payload, sig] = s.split(".");
  const p = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/")));
  p.u = "22222222-2222-4222-8222-222222222222";
  const forged = btoa(JSON.stringify(p)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  assertEquals(await verifyState(SECRET, `${forged}.${sig}`), null);
});

Deno.test("state: otra llave, vencido, vacío o basura", async () => {
  const s = await signState(SECRET, DATA, 1_000);
  assertEquals(await verifyState("otra", s, 1_000), null);
  assert(await verifyState(SECRET, s, 1_000 + STATE_TTL_MS - 1));
  assertEquals(await verifyState(SECRET, s, 1_000 + STATE_TTL_MS + 1), null);
  assertEquals(await verifyState(SECRET, null), null);
  assertEquals(await verifyState(SECRET, ""), null);
  assertEquals(await verifyState(SECRET, "a.b.c"), null);
  assertEquals(await verifyState(SECRET, "%%%.%%%"), null);
  assertEquals(await verifyState("", s, 1_000), null);
});

Deno.test("state: dos firmas del mismo dato son distintas (nonce)", async () => {
  assert((await signState(SECRET, DATA)) !== (await signState(SECRET, DATA)));
});

const ORIGINS = allowedOrigins({ appUrl: "https://actas.miempresa.example", extra: "https://preview.miempresa.example, " });

Deno.test("allowedOrigins: APP_URL y extras, sin rutas", () => {
  assertEquals(ORIGINS, ["https://actas.miempresa.example", "https://preview.miempresa.example"]);
  assertEquals(allowedOrigins({ appUrl: "", extra: "" }), []);
});

Deno.test("safeReturnUrl: solo orígenes propios", () => {
  assertEquals(safeReturnUrl("https://actas.miempresa.example/ajustes?x=1", ORIGINS), "https://actas.miempresa.example/ajustes?x=1");
  assertEquals(safeReturnUrl("https://preview.miempresa.example/ajustes", ORIGINS), "https://preview.miempresa.example/ajustes");
  // Con una URL real configurada, localhost ya no vale (evita redirecciones abiertas).
  assertEquals(safeReturnUrl("http://localhost:8080/ajustes", ORIGINS), "https://actas.miempresa.example/ajustes");
  assertEquals(safeReturnUrl("http://localhost:5173/ajustes", []), "http://localhost:5173/ajustes");
  assertEquals(safeReturnUrl("http://localhost:5173/x", ["http://localhost:8080"]), "http://localhost:5173/x");
  for (const malo of [
    "https://actas.miempresa.example.evil.example/",
    "https://evil.example/?https://actas.miempresa.example",
    "javascript:alert(1)",
    "/ajustes",
    "",
    null,
  ]) {
    assertEquals(safeReturnUrl(malo, ORIGINS), "https://actas.miempresa.example/ajustes");
  }
  assertEquals(safeReturnUrl("https://evil.example", []), "http://localhost:8080/ajustes");
});

Deno.test("withParam agrega el parámetro", () => {
  assertEquals(withParam("https://actas.miempresa.example/ajustes?a=1", "calendar_error", "x y"), "https://actas.miempresa.example/ajustes?a=1&calendar_error=x+y");
});
