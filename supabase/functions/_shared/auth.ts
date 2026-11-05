// Quién llama a una edge function y qué puede hacer. Un solo lugar para todas.
//
// Las funciones corren con la service role (se saltan RLS), así que cada una
// tiene que decidir por su cuenta si quien llama puede hacer lo que pide. Antes
// varias no lo hacían: bastaba conocer el id de una reunión.
//
// Dos tipos de llamador válidos:
//   - "service": otra función de la app, con `Authorization: Bearer <service role>`.
//   - "user": una persona con sesión; se valida el JWT contra Auth y, cuando la
//     acción es sobre una reunión, se pregunta a la base con SU sesión si puede
//     leerla (las mismas políticas RLS que la app: dueño, compartida con ella
//     o admin).
// La llave anónima (pública) nunca cuenta como credencial.
//
// Uso típico, justo después del OPTIONS del handler:
//
//   const gate = await gateMeeting(req, corsHeaders);
//   if (gate.response) return gate.response;
//
// `gateMeeting` lee el cuerpo desde una copia del request, así que el handler
// puede seguir haciendo su propio `await req.json()` después.

import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type Caller =
  | { kind: "service" }
  | { kind: "user"; userId: string; email: string | null; token: string };

export interface MeetingRef {
  id: string;
  user_id: string;
}

export interface Gate<B = Record<string, unknown>> {
  /** Si viene, el handler debe devolverla tal cual y no seguir. */
  response?: Response;
  caller?: Caller;
  body?: B;
  meeting?: MeetingRef;
}

type Cors = Record<string, string>;

function env(name: string): string {
  return Deno.env.get(name) ?? "";
}

export function deny(status: number, message: string, cors: Cors = {}): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

/** Comparación en tiempo constante (no revela cuántos caracteres calzan). */
export function safeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  let diff = ea.length ^ eb.length;
  const n = Math.max(ea.length, eb.length);
  for (let i = 0; i < n; i++) diff |= (ea[i] ?? 0) ^ (eb[i] ?? 0);
  return diff === 0;
}

export function bearerToken(req: Request): string {
  const h = req.headers.get("Authorization") ?? "";
  return /^Bearer\s+/i.test(h) ? h.replace(/^Bearer\s+/i, "").trim() : "";
}

export function isServiceRole(req: Request): boolean {
  const key = env("SUPABASE_SERVICE_ROLE_KEY");
  const token = bearerToken(req);
  return !!key && !!token && safeEqual(token, key);
}

let _admin: SupabaseClient | null = null;
/** Cliente con service role (se salta RLS). Solo para leer lo que el chequeo necesita. */
export function adminClient(): SupabaseClient {
  if (!_admin) {
    _admin = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return _admin;
}

/** Cliente que consulta la base COMO la persona: aplican sus políticas RLS. */
export function userClient(req: Request, token: string): SupabaseClient | null {
  // La llave pública la manda el navegador en `apikey`; se usa si la env no está.
  const anon = env("SUPABASE_ANON_KEY") || req.headers.get("apikey") || "";
  // Nunca la service role acá: si el Authorization no se impusiera, la consulta
  // correría sin RLS y el chequeo dejaría pasar a cualquiera.
  if (!anon || safeEqual(anon, env("SUPABASE_SERVICE_ROLE_KEY"))) return null;
  return createClient(env("SUPABASE_URL"), anon, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
}

/** Identifica al llamador, o null si no trae una credencial válida. */
export async function identify(req: Request): Promise<Caller | null> {
  const token = bearerToken(req);
  if (!token) return null;
  if (isServiceRole(req)) return { kind: "service" };
  // La llave anónima es un JWT firmado por el proyecto, pero no es una persona.
  const anon = env("SUPABASE_ANON_KEY");
  if (anon && safeEqual(token, anon)) return null;
  if (token.split(".").length !== 3) return null;
  try {
    const { data, error } = await adminClient().auth.getUser(token);
    if (error || !data?.user?.id) return null;
    return { kind: "user", userId: data.user.id, email: data.user.email ?? null, token };
  } catch (_e) {
    return null;
  }
}

export async function isAdminUser(userId: string): Promise<boolean> {
  const { data, error } = await adminClient().rpc("is_admin", { _user_id: userId });
  return !error && data === true;
}

/**
 * ¿Puede esta persona leer la reunión? Se pregunta a la base con su sesión.
 * Si no hay cómo armar un cliente con su sesión, se usa can_read_meeting
 * (mismas reglas que RLS, con el user_id explícito). Ante cualquier error: no.
 */
export async function canReadMeeting(req: Request, caller: Caller, meetingId: string): Promise<boolean> {
  if (caller.kind === "service") return true;
  if (!UUID_RE.test(meetingId)) return false;
  try {
    const asUser = userClient(req, caller.token);
    if (asUser) {
      const { data, error } = await asUser.from("meetings").select("id").eq("id", meetingId).maybeSingle();
      return !error && !!data;
    }
    const { data, error } = await adminClient().rpc("can_read_meeting", {
      _meeting_id: meetingId,
      _user_id: caller.userId,
    });
    return !error && data === true;
  } catch (_e) {
    return false;
  }
}

async function readBody<B>(req: Request): Promise<B | null> {
  try {
    const parsed = await req.clone().json();
    return parsed && typeof parsed === "object" ? (parsed as B) : null;
  } catch (_e) {
    return null;
  }
}

/** Exige una persona con sesión (no service role, no llave anónima). */
export async function gateUser(req: Request, cors: Cors = {}): Promise<Gate> {
  const caller = await identify(req);
  if (!caller || caller.kind !== "user") return { response: deny(401, "No autenticado", cors) };
  return { caller };
}

/** Exige service role o una persona con sesión. */
export async function gateAuthenticated(req: Request, cors: Cors = {}): Promise<Gate> {
  const caller = await identify(req);
  if (!caller) return { response: deny(401, "No autenticado", cors) };
  return { caller };
}

/** Exige service role (llamadas entre funciones) o un admin con sesión. */
export async function gateAdmin(req: Request, cors: Cors = {}): Promise<Gate> {
  const caller = await identify(req);
  if (!caller) return { response: deny(401, "No autenticado", cors) };
  if (caller.kind === "user" && !(await isAdminUser(caller.userId))) {
    return { response: deny(403, "Solo administradores", cors) };
  }
  return { caller };
}

/** Exige service role. */
export function gateService(req: Request, cors: Cors = {}): Gate {
  if (!isServiceRole(req)) return { response: deny(401, "No autorizado", cors) };
  return { caller: { kind: "service" } };
}

export interface GateMeetingOptions<B> {
  /** Nombre del campo del cuerpo con el id de la reunión. */
  field?: string;
  /**
   * Regla extra de la función, con la reunión ya resuelta. Devuelve un mensaje
   * para rechazar (403) o null para seguir.
   */
  extra?: (ctx: { caller: Caller; body: B; meeting: MeetingRef }) => string | null | Promise<string | null>;
}

/**
 * Exige que quien llama pueda leer la reunión que viene en el cuerpo.
 * Responde igual (404) si la reunión no existe o si no tiene acceso, para no
 * servir de oráculo de ids.
 */
export async function gateMeeting<B extends Record<string, unknown> = Record<string, unknown>>(
  req: Request,
  cors: Cors = {},
  opts: GateMeetingOptions<B> = {},
): Promise<Gate<B>> {
  const caller = await identify(req);
  if (!caller) return { response: deny(401, "No autenticado", cors) };

  const body = await readBody<B>(req);
  const raw = body ? body[opts.field ?? "meetingId"] : undefined;
  const meetingId = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (!meetingId) return { response: deny(400, "meetingId is required", cors) };
  const notFound = deny(404, "Reunión no encontrada o sin acceso", cors);
  if (!UUID_RE.test(meetingId)) return { response: notFound };

  if (!(await canReadMeeting(req, caller, meetingId))) return { response: notFound };

  const { data: meeting, error } = await adminClient()
    .from("meetings")
    .select("id, user_id")
    .eq("id", meetingId)
    .maybeSingle();
  if (error || !meeting) return { response: notFound };

  if (opts.extra) {
    const why = await opts.extra({ caller, body: body as B, meeting: meeting as MeetingRef });
    if (why) return { response: deny(403, why, cors) };
  }
  return { caller, body: body as B, meeting: meeting as MeetingRef };
}

/**
 * Ruta dentro del bucket `meeting-recordings` a partir de una URL (pública o
 * firmada) o de una ruta suelta. null si no apunta al bucket.
 */
export function recordingPath(urlOrPath: unknown): string | null {
  if (typeof urlOrPath !== "string" || !urlOrPath) return null;
  let path: string;
  if (urlOrPath.includes("/meeting-recordings/")) {
    path = urlOrPath.split("/meeting-recordings/")[1].split("?")[0];
  } else if (/^https?:\/\//i.test(urlOrPath)) {
    return null;
  } else {
    path = urlOrPath.replace(/^meeting-recordings\//, "").split("?")[0];
  }
  try {
    path = decodeURIComponent(path);
  } catch (_e) {
    return null;
  }
  path = path.replace(/^\/+/, "");
  if (!path || path.split("/").some((seg) => seg === ".." || seg === ".")) return null;
  return path;
}

/** ¿La ruta es de la carpeta de esa reunión (`{dueño}/{reunión}/...`)? */
export function pathBelongsToMeeting(path: string | null, meeting: MeetingRef): boolean {
  return !!path && path.toLowerCase().startsWith(`${meeting.user_id}/${meeting.id}/`.toLowerCase());
}

// --- Trabajos programados --------------------------------------------------

/**
 * Exige que llame pg_cron (cabecera `x-cron-secret`, validada contra el secreto
 * guardado en Vault), otra función (service role) o un admin con sesión.
 */
export async function gateCron(req: Request, cors: Cors = {}): Promise<Gate> {
  const secret = req.headers.get("x-cron-secret") ?? "";
  if (secret) {
    const { data, error } = await adminClient().rpc("verify_cron_secret", { p_secret: secret });
    if (!error && data === true) return { caller: { kind: "service" } };
    return { response: deny(401, "No autorizado", cors) };
  }
  return gateAdmin(req, cors);
}
