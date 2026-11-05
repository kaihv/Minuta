// Pruebas del chequeo de quién llama (auth.ts) con Auth y la base simuladas.
// deno test --allow-env --allow-net supabase/functions/_shared/auth.test.ts
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

const URL_ = "https://proyecto.supabase.co";
const SERVICE = "eyJ.service.key";
const ANON = "eyJ.anon.key";
Deno.env.set("SUPABASE_URL", URL_);
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", SERVICE);
Deno.env.set("SUPABASE_ANON_KEY", ANON);

const {
  gateAdmin, gateMeeting, gateService, gateUser, identify, pathBelongsToMeeting, recordingPath, safeEqual,
} = await import("./auth.ts");

const OWNER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const ADMIN = "33333333-3333-4333-8333-333333333333";
const MEETING = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TOKENS: Record<string, string> = { "tok.owner.jwt": OWNER, "tok.other.jwt": OTHER, "tok.admin.jwt": ADMIN };

// Registro de lo que cada consulta mandó, para comprobar con qué credencial se hizo.
const seen: Array<{ url: string; auth: string; apikey: string }> = [];

globalThis.fetch = ((input: Request | URL | string, init?: RequestInit) => {
  const req = input instanceof Request ? input : new Request(String(input), init);
  const url = new URL(req.url);
  const auth = (req.headers.get("Authorization") ?? "").replace(/^Bearer /, "");
  const apikey = req.headers.get("apikey") ?? "";
  seen.push({ url: url.pathname + url.search, auth, apikey });
  const json = (body: unknown, status = 200) =>
    Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));

  if (url.pathname === "/auth/v1/user") {
    const id = TOKENS[auth];
    return id ? json({ id, email: `${id.slice(0, 4)}@miempresa.example`, aud: "authenticated" }) : json({ msg: "invalid JWT" }, 403);
  }
  if (url.pathname === "/rest/v1/rpc/is_admin") {
    return req.json().then((b) => json(b._user_id === ADMIN));
  }
  if (url.pathname === "/rest/v1/meetings") {
    const id = (url.searchParams.get("id") ?? "").replace("eq.", "");
    const exists = id === MEETING;
    // Con service role se ve todo; como persona, RLS: solo el dueño y el admin.
    const who = auth === SERVICE ? "service" : TOKENS[auth];
    const visible = exists && (who === "service" || who === OWNER || who === ADMIN);
    const row = { id: MEETING, user_id: OWNER };
    const single = (req.headers.get("Accept") ?? "").includes("vnd.pgrst.object");
    if (single) return visible ? json(row) : json({ code: "PGRST116", message: "0 rows" }, 406);
    return json(visible ? [row] : []);
  }
  return json({ error: "ruta no simulada: " + url.pathname }, 500);
}) as typeof fetch;

const call = (token: string | null, body: unknown = { meetingId: MEETING }, extraHeaders: Record<string, string> = {}) =>
  new Request("https://fn.local/x", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...extraHeaders },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

const opts = { sanitizeOps: false, sanitizeResources: false };

Deno.test("identify: sin credencial, llave anónima y basura no son nadie", opts, async () => {
  assertEquals(await identify(call(null)), null);
  assertEquals(await identify(call(ANON)), null);
  assertEquals(await identify(call("no-es-jwt")), null);
  assertEquals(await identify(call("tok.falso.jwt")), null);
});

Deno.test("identify: service role y persona con sesión", opts, async () => {
  assertEquals(await identify(call(SERVICE)), { kind: "service" });
  const u = await identify(call("tok.owner.jwt"));
  assert(u && u.kind === "user" && u.userId === OWNER);
});

Deno.test("gateMeeting: 401 sin credencial o con la llave anónima", opts, async () => {
  assertEquals((await gateMeeting(call(null))).response?.status, 401);
  assertEquals((await gateMeeting(call(ANON))).response?.status, 401);
  assertEquals((await gateMeeting(call("tok.falso.jwt"))).response?.status, 401);
});

Deno.test("gateMeeting: service role pasa y recibe la reunión", opts, async () => {
  const g = await gateMeeting(call(SERVICE));
  assertEquals(g.response, undefined);
  assertEquals(g.meeting, { id: MEETING, user_id: OWNER });
  assertEquals(g.caller, { kind: "service" });
});

Deno.test("gateMeeting: el dueño pasa, y el chequeo se hace con SU sesión y la llave anónima", opts, async () => {
  seen.length = 0;
  const g = await gateMeeting(call("tok.owner.jwt"));
  assertEquals(g.response, undefined);
  const rls = seen.find((s) => s.url.startsWith("/rest/v1/meetings") && s.auth === "tok.owner.jwt");
  assert(rls, "debe consultar meetings con el token de la persona");
  assertEquals(rls.apikey, ANON);
});

Deno.test("gateMeeting: otra persona recibe 404 (igual que si no existiera)", opts, async () => {
  const sinAcceso = await gateMeeting(call("tok.other.jwt"));
  assertEquals(sinAcceso.response?.status, 404);
  const noExiste = await gateMeeting(call("tok.owner.jwt", { meetingId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }));
  assertEquals(noExiste.response?.status, 404);
  assertEquals(await sinAcceso.response!.text(), await noExiste.response!.text());
});

Deno.test("gateMeeting: cuerpo inválido o sin meetingId es 400; id mal formado es 404", opts, async () => {
  assertEquals((await gateMeeting(call("tok.owner.jwt", "no-es-json"))).response?.status, 400);
  assertEquals((await gateMeeting(call("tok.owner.jwt", {}))).response?.status, 400);
  assertEquals((await gateMeeting(call("tok.owner.jwt", { meetingId: "1 or 1=1" }))).response?.status, 404);
});

Deno.test("gateMeeting: el handler puede volver a leer el cuerpo", opts, async () => {
  const req = call("tok.owner.jwt", { meetingId: MEETING, otro: 7 });
  const g = await gateMeeting(req);
  assertEquals(g.response, undefined);
  assertEquals((await req.json()).otro, 7);
});

Deno.test("gateMeeting: la regla extra rechaza con 403", opts, async () => {
  const g = await gateMeeting(call("tok.owner.jwt"), {}, { extra: () => "no" });
  assertEquals(g.response?.status, 403);
});

Deno.test("gateMeeting: sin llave anónima cae a can_read_meeting y, si falla, niega", opts, async () => {
  Deno.env.delete("SUPABASE_ANON_KEY");
  try {
    // La simulación no implementa ese RPC (responde 500): tiene que negar, no dejar pasar.
    assertEquals((await gateMeeting(call("tok.owner.jwt"))).response?.status, 404);
    // Con la llave pública en la cabecera `apikey` (como la manda el navegador) vuelve a RLS.
    assertEquals((await gateMeeting(call("tok.owner.jwt", { meetingId: MEETING }, { apikey: ANON }))).response, undefined);
    // Nunca se acepta la service role como `apikey` para el cliente "como persona".
    assertEquals((await gateMeeting(call("tok.other.jwt", { meetingId: MEETING }, { apikey: SERVICE }))).response?.status, 404);
  } finally {
    Deno.env.set("SUPABASE_ANON_KEY", ANON);
  }
});

Deno.test("gateAdmin / gateUser / gateService", opts, async () => {
  assertEquals((await gateAdmin(call(null))).response?.status, 401);
  assertEquals((await gateAdmin(call(ANON))).response?.status, 401);
  assertEquals((await gateAdmin(call("tok.owner.jwt"))).response?.status, 403);
  assertEquals((await gateAdmin(call("tok.admin.jwt"))).response, undefined);
  assertEquals((await gateAdmin(call(SERVICE))).response, undefined);
  assertEquals((await gateUser(call(SERVICE))).response?.status, 401);
  assertEquals((await gateUser(call(ANON))).response?.status, 401);
  assertEquals((await gateUser(call("tok.owner.jwt"))).response, undefined);
  assertEquals(gateService(call("tok.admin.jwt")).response?.status, 401);
  assertEquals(gateService(call(SERVICE)).response, undefined);
});

Deno.test("recordingPath y pathBelongsToMeeting", () => {
  const m = { id: MEETING, user_id: OWNER };
  const base = `${URL_}/storage/v1/object`;
  assertEquals(recordingPath(`${base}/public/meeting-recordings/${OWNER}/${MEETING}/recording.mp4`), `${OWNER}/${MEETING}/recording.mp4`);
  assertEquals(recordingPath(`${base}/sign/meeting-recordings/${OWNER}/${MEETING}/recording.webm?token=abc`), `${OWNER}/${MEETING}/recording.webm`);
  assertEquals(recordingPath(`${OWNER}/${MEETING}/recording.mp4`), `${OWNER}/${MEETING}/recording.mp4`);
  assertEquals(recordingPath("https://us-west-2.recall.ai/x.mp4?sig=1"), null);
  assertEquals(recordingPath(`${base}/public/meeting-recordings/${OWNER}/${MEETING}/../../${OTHER}/x/recording.mp4`), null);
  assertEquals(recordingPath(`${base}/public/meeting-recordings/${OWNER}/${MEETING}/%2e%2e/recording.mp4`), null);
  assertEquals(recordingPath(null), null);
  assert(pathBelongsToMeeting(`${OWNER}/${MEETING}/recording.mp4`, m));
  assert(!pathBelongsToMeeting(`${OTHER}/${MEETING}/recording.mp4`, m));
  assert(!pathBelongsToMeeting(`${OWNER}/${MEETING}x/recording.mp4`, m));
  assert(!pathBelongsToMeeting(null, m));
});

Deno.test("safeEqual", () => {
  assert(safeEqual("abc", "abc"));
  assert(!safeEqual("abc", "abd"));
  assert(!safeEqual("abc", "abcd"));
  assert(!safeEqual("", "a"));
});
