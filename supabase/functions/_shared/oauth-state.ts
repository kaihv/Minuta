// `state` firmado para el OAuth de Google Calendar.
//
// Antes el `state` era un JSON en base64 con el `userId`: cualquiera podía
// fabricar uno y dejar SU calendario conectado en la cuenta de otra persona (o
// hacer que otra persona conectara el suyo en la cuenta del atacante). Ahora va
// firmado con HMAC-SHA256 y vence.
//
// La llave se deriva de la service role (que solo conocen las funciones): no
// hace falta un secreto nuevo en el proyecto.

const enc = new TextEncoder();
const dec = new TextDecoder();

const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function fromB64url(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

async function hmacKey(secret: string, purpose: string): Promise<CryptoKey> {
  // Llave propia de este uso: HMAC(secret, purpose). Así la firma del state no
  // sirve para ningún otro fin aunque comparta el secreto de origen.
  const base = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const derived = await crypto.subtle.sign("HMAC", base, enc.encode(purpose));
  return crypto.subtle.importKey("raw", derived, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
}

/** Comparación en tiempo constante. */
function sameString(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

const PURPOSE = "minuta:google-calendar-oauth-state:v1";
export const STATE_TTL_MS = 15 * 60_000;

export interface OAuthState {
  userId: string;
  redirectUrl: string;
}

export async function signState(secret: string, data: OAuthState, now = Date.now()): Promise<string> {
  if (!secret) throw new Error("state secret not configured");
  const nonce = b64url(crypto.getRandomValues(new Uint8Array(12)));
  const payload = b64url(enc.encode(JSON.stringify({ u: data.userId, r: data.redirectUrl, e: now + STATE_TTL_MS, n: nonce })));
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret, PURPOSE), enc.encode(payload));
  return `${payload}.${b64url(new Uint8Array(sig))}`;
}

/** Devuelve el contenido si la firma es válida y no venció; si no, null. */
export async function verifyState(secret: string, state: string | null, now = Date.now()): Promise<OAuthState | null> {
  if (!secret || !state) return null;
  const parts = state.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  try {
    const expected = b64url(new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(secret, PURPOSE), enc.encode(parts[0]))));
    if (!sameString(expected, parts[1])) return null;
    const p = JSON.parse(dec.decode(fromB64url(parts[0])));
    if (typeof p?.u !== "string" || typeof p?.e !== "number" || p.e < now) return null;
    return { userId: p.u, redirectUrl: typeof p.r === "string" ? p.r : "" };
  } catch (_e) {
    return null;
  }
}

// A dónde se puede volver después del OAuth: solo orígenes propios, que se
// configuran con APP_URL (y opcionalmente APP_EXTRA_ORIGINS, separados por coma,
// por ejemplo la URL de vista previa). localhost se acepta solo mientras
// APP_URL no esté configurada o sea también localhost (desarrollo).
const LOCAL_RE = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch (_e) {
    return null;
  }
}

/** Orígenes permitidos según el entorno (o los que se pasen, para pruebas). */
export function allowedOrigins(env?: { appUrl?: string; extra?: string }): string[] {
  const e = env ?? { appUrl: Deno.env.get("APP_URL") ?? "", extra: Deno.env.get("APP_EXTRA_ORIGINS") ?? "" };
  return [e.appUrl ?? "", ...(e.extra ?? "").split(",")]
    .map((u) => u.trim())
    .filter(Boolean)
    .map(originOf)
    .filter((o): o is string => !!o);
}

/** Adónde volver si la URL pedida no es válida. */
export function defaultReturnUrl(origins: string[] = allowedOrigins()): string {
  return origins[0] ? `${origins[0]}/ajustes` : "http://localhost:8080/ajustes";
}

/** URL de retorno segura: la pedida si es de un origen propio; si no, la de por defecto. */
export function safeReturnUrl(requested: unknown, origins: string[] = allowedOrigins()): string {
  const fallback = defaultReturnUrl(origins);
  if (typeof requested !== "string" || !requested) return fallback;
  try {
    const u = new URL(requested);
    const devMode = origins.length === 0 || origins.every((o) => LOCAL_RE.test(o));
    if (origins.includes(u.origin) || (devMode && LOCAL_RE.test(u.origin))) return u.toString();
  } catch (_e) { /* relativa o inválida */ }
  return fallback;
}

/** Agrega un parámetro a una URL de retorno ya validada. */
export function withParam(url: string, key: string, value: string): string {
  const u = new URL(url);
  u.searchParams.set(key, value);
  return u.toString();
}
