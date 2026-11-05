import { adminClient } from "../_shared/auth.ts";
import { handleRpc, type McpDeps, type MeetingLite } from "../_shared/mcp.ts";
import { sendManualBot } from "../_shared/manual-bot.ts";
import { readTranscript } from "../_shared/transcript.ts";

// Servidor MCP remoto de Minuta.
//   URL:    https://<proyecto>.supabase.co/functions/v1/mcp
//   Auth:   Authorization: Bearer mn_...   (token personal creado en Ajustes)
// Todo lo que se consulta queda limitado a lo que esa persona puede ver en la
// app (sus reuniones, las compartidas con ella y, si es admin, todas).
// Lógica y pruebas: _shared/mcp.ts.

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, mcp-protocol-version, mcp-session-id",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const COLS = "id, title, status, meeting_type, scheduled_at, created_at, duration_minutes, attendees, summary";

function reply(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: { ...CORS, ...(body === null ? {} : { "Content-Type": "application/json" }), ...extra },
  });
}

async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Para filtros de PostgREST: solo letras, números, espacios y signos simples. */
function cleanQuery(q: string): string {
  return q.replace(/[^\p{L}\p{N} ._@-]/gu, " ").replace(/\s+/g, " ").trim().slice(0, 100);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return reply({ error: "Usa POST (MCP sobre HTTP)" }, 405, { Allow: "POST" });

  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  const unauthorized = () =>
    reply({ jsonrpc: "2.0", id: null, error: { code: -32001, message: "Token inválido o vencido. Crea uno en Minuta, Ajustes, Conectar con IA." } }, 401, {
      "WWW-Authenticate": 'Bearer realm="minuta"',
    });
  if (!/^mn_[0-9a-f]{64}$/.test(token)) return unauthorized();

  const db = adminClient();
  const { data: pat } = await db
    .from("personal_access_tokens")
    .select("id, user_id, expires_at, revoked_at")
    .eq("token_hash", await sha256Hex(token))
    .maybeSingle();
  if (!pat || pat.revoked_at || (pat.expires_at && Date.parse(pat.expires_at) < Date.now())) return unauthorized();
  db.from("personal_access_tokens").update({ last_used_at: new Date().toISOString() }).eq("id", pat.id).then(() => {});

  const userId: string = pat.user_id;
  const { data: adminRow } = await db.from("user_roles").select("role").eq("user_id", userId).eq("role", "admin").maybeSingle();
  const isAdmin = !!adminRow;

  async function visibleScope() {
    if (isAdmin) return null; // todas
    const { data } = await db.from("meeting_assignments").select("meeting_id").eq("assigned_to", userId);
    const shared = (data ?? []).map((r: { meeting_id: string }) => r.meeting_id);
    return shared.length ? `user_id.eq.${userId},id.in.(${shared.join(",")})` : `user_id.eq.${userId}`;
  }

  const deps: McpDeps = {
    userId,
    appUrl: Deno.env.get("APP_URL") ?? null,
    async listMeetings({ query, from, to, limit }) {
      let q = db.from("meetings").select(COLS).order("scheduled_at", { ascending: false, nullsFirst: false }).limit(limit);
      const scope = await visibleScope();
      if (scope) q = q.or(scope);
      if (from) q = q.gte("scheduled_at", `${from}T00:00:00Z`);
      if (to) q = q.lte("scheduled_at", `${to}T23:59:59Z`);
      const term = query ? cleanQuery(query) : "";
      if (term) {
        const { data: hits } = await db.from("transcriptions").select("meeting_id").ilike("content", `%${term}%`).limit(500);
        const ids = [...new Set((hits ?? []).map((h: { meeting_id: string }) => h.meeting_id))].slice(0, 200);
        q = q.or(ids.length ? `title.ilike.%${term}%,id.in.(${ids.join(",")})` : `title.ilike.%${term}%`);
      }
      const { data, error } = await q;
      if (error) throw new Error("No se pudieron leer las reuniones");
      return (data ?? []) as MeetingLite[];
    },
    async getMeeting(id) {
      if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
      const { data: can } = await db.rpc("can_read_meeting", { _meeting_id: id, _user_id: userId });
      if (can !== true) return null;
      const { data } = await db.from("meetings").select(COLS).eq("id", id).maybeSingle();
      return (data as MeetingLite) ?? null;
    },
    transcript: (id) => readTranscript(db, id),
    sendBot: (url, title) => sendManualBot(db, userId, url, title),
  };

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return reply({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "JSON inválido" } }, 400);
  }

  if (Array.isArray(body)) {
    const out = (await Promise.all(body.slice(0, 20).map((m) => handleRpc(deps, m)))).filter((r) => r !== null);
    return out.length ? reply(out) : reply(null, 202);
  }
  const out = await handleRpc(deps, body);
  return out === null ? reply(null, 202) : reply(out);
});
