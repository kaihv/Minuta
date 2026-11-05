import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { handleRpc, type McpDeps, type MeetingLite, TOOLS } from "./mcp.ts";

const M: MeetingLite = {
  id: "m1", title: "Pedido marzo", status: "completed", meeting_type: "virtual",
  scheduled_at: "2026-11-03T15:00:00Z", created_at: "2026-11-03T15:00:00Z", duration_minutes: 30,
  attendees: [{ email: "carla@cliente.example", name: "Carla" }],
  summary: { executive_summary: "- Se acordó precio", action_items: [{ task: "Enviar cotización", assignee: "Ana", due_date: "2026-11-06" }], decisions: ["Precio fijo"], topics: ["Precio"] },
};

function deps(over: Partial<McpDeps> = {}): McpDeps & { sent: string[] } {
  const sent: string[] = [];
  return {
    sent,
    userId: "u1",
    appUrl: "https://actas.example",
    listMeetings: () => Promise.resolve([M]),
    getMeeting: (id) => Promise.resolve(id === "m1" ? M : null),
    transcript: () => Promise.resolve([
      { start_time_ms: 0, speaker_name: "Ana", content: "Hola" },
      { start_time_ms: 125_000, speaker_name: null, content: "Precio fijo" },
    ]),
    sendBot: (url) => {
      sent.push(url);
      return Promise.resolve({ meetingId: "new" });
    },
    ...over,
  };
}

const rpc = (method: string, params?: unknown, id: number | null = 1) => ({ jsonrpc: "2.0", ...(id !== null ? { id } : {}), method, params });

Deno.test("initialize: negocia versión y anuncia herramientas", async () => {
  const r = await handleRpc(deps(), rpc("initialize", { protocolVersion: "2025-03-26" }));
  assertEquals(r.result.protocolVersion, "2025-03-26");
  assertEquals(r.result.serverInfo.name, "minuta");
  assert(r.result.capabilities.tools);
  const r2 = await handleRpc(deps(), rpc("initialize", { protocolVersion: "1999-01-01" }));
  assertEquals(r2.result.protocolVersion, "2025-06-18");
});

Deno.test("notificaciones no tienen respuesta; métodos desconocidos sí", async () => {
  assertEquals(await handleRpc(deps(), rpc("notifications/initialized", undefined, null)), null);
  assertEquals((await handleRpc(deps(), rpc("nada"))).error.code, -32601);
  assertEquals((await handleRpc(deps(), { method: "x" })).error.code, -32600);
});

Deno.test("tools/list trae las cinco herramientas con esquema", async () => {
  const r = await handleRpc(deps(), rpc("tools/list"));
  assertEquals(r.result.tools.map((t: { name: string }) => t.name), TOOLS.map((t) => t.name));
  for (const t of r.result.tools) assertEquals(t.inputSchema.type, "object");
});

Deno.test("buscar_reuniones y ver_reunion", async () => {
  const list = await handleRpc(deps(), rpc("tools/call", { name: "buscar_reuniones", arguments: { texto: "pedido", desde: "mal", limite: 999 } }));
  const t = list.result.content[0].text as string;
  assert(t.includes("Pedido marzo") && t.includes("id: m1") && t.includes("https://actas.example/reunion/m1"));
  const one = await handleRpc(deps(), rpc("tools/call", { name: "ver_reunion", arguments: { id: "m1" } }));
  const body = one.result.content[0].text as string;
  assert(body.includes("Enviar cotización (Ana, 2026-11-06)") && body.includes("Participantes: Carla"));
  const none = await handleRpc(deps(), rpc("tools/call", { name: "ver_reunion", arguments: { id: "otra" } }));
  assertEquals(none.result.isError, true);
});

Deno.test("buscar_reuniones: limita y valida filtros antes de consultar", async () => {
  let seen: unknown = null;
  await handleRpc(deps({ listMeetings: (o) => { seen = o; return Promise.resolve([]); } }), rpc("tools/call", { name: "buscar_reuniones", arguments: { desde: "2026-01-01", hasta: "no", limite: 500 } }));
  assertEquals(seen, { query: undefined, from: "2026-01-01", to: undefined, limit: 50 });
});

Deno.test("leer_transcripcion: con minutos y tramo", async () => {
  const all = await handleRpc(deps(), rpc("tools/call", { name: "leer_transcripcion", arguments: { id: "m1" } }));
  assert((all.result.content[0].text as string).includes("[02:05] Participante: Precio fijo"));
  const part = await handleRpc(deps(), rpc("tools/call", { name: "leer_transcripcion", arguments: { id: "m1", desde_minuto: 1 } }));
  assert(!(part.result.content[0].text as string).includes("Hola"));
});

Deno.test("compromisos_pendientes y mandar_bot", async () => {
  const c = await handleRpc(deps(), rpc("tools/call", { name: "compromisos_pendientes", arguments: {} }));
  assert((c.result.content[0].text as string).includes('Enviar cotización (Ana, 2026-11-06) en "Pedido marzo"'));
  const d = deps();
  const b = await handleRpc(d, rpc("tools/call", { name: "mandar_bot", arguments: { enlace: "https://meet.google.com/x" } }));
  assertEquals(d.sent, ["https://meet.google.com/x"]);
  assert((b.result.content[0].text as string).includes("new"));
  const err = await handleRpc(deps({ sendBot: () => Promise.reject(new Error("Llegaste al máximo")) }), rpc("tools/call", { name: "mandar_bot", arguments: { enlace: "x" } }));
  assertEquals(err.result.isError, true);
  const unknown = await handleRpc(deps(), rpc("tools/call", { name: "borrar_todo", arguments: {} }));
  assertEquals(unknown.error.code, -32602);
});
