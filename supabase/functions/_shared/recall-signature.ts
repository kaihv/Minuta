// Verificación de firma de los webhooks de Recall.ai.
//
// Recall firma con el esquema de Svix / Standard Webhooks: HMAC-SHA256 sobre
// `${id}.${timestamp}.${cuerpo}` con el secreto del workspace (`whsec_` + base64),
// en las cabeceras `webhook-id` / `webhook-timestamp` / `webhook-signature`
// (o las mismas con prefijo `svix-`). La firma viene como `v1,<base64>`, y
// puede traer varias separadas por espacio.
//
// Necesita el secreto `RECALL_WEBHOOK_SECRET` (panel de Recall > Webhooks).
// Sin él, `verifyRecallSignature` responde "unconfigured" y recall-webhook
// RECHAZA los avisos, salvo que ALLOW_UNSIGNED_WEBHOOKS=true (solo para pruebas).

const enc = new TextEncoder();
const TOLERANCE_SECONDS = 5 * 60;

export type SignatureResult = "valid" | "invalid" | "unconfigured";

function b64ToBytes(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

function bytesToB64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function sameString(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

export async function verifyRecallSignature(
  headers: Headers,
  rawBody: string,
  secret: string | undefined | null,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<SignatureResult> {
  if (!secret) return "unconfigured";
  const id = headers.get("webhook-id") ?? headers.get("svix-id");
  const timestamp = headers.get("webhook-timestamp") ?? headers.get("svix-timestamp");
  const signatures = headers.get("webhook-signature") ?? headers.get("svix-signature");
  if (!id || !timestamp || !signatures) return "invalid";

  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(nowSeconds - ts) > TOLERANCE_SECONDS) return "invalid";

  let keyBytes: Uint8Array;
  try {
    keyBytes = b64ToBytes(secret.startsWith("whsec_") ? secret.slice(6) : secret);
  } catch (_e) {
    // Secreto que no es base64: se usa tal cual.
    keyBytes = enc.encode(secret);
  }
  const key = await crypto.subtle.importKey("raw", keyBytes.slice().buffer, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, enc.encode(`${id}.${timestamp}.${rawBody}`));
  const expected = bytesToB64(new Uint8Array(mac));

  for (const part of signatures.split(" ")) {
    const [version, value] = part.split(",");
    if (version === "v1" && value && sameString(value, expected)) return "valid";
  }
  return "invalid";
}

/** Para pruebas: firma como lo haría Recall. */
export async function signForTest(secret: string, id: string, timestamp: number, rawBody: string): Promise<string> {
  const keyBytes = b64ToBytes(secret.startsWith("whsec_") ? secret.slice(6) : secret);
  const key = await crypto.subtle.importKey("raw", keyBytes.slice().buffer, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, enc.encode(`${id}.${timestamp}.${rawBody}`));
  return `v1,${bytesToB64(new Uint8Array(mac))}`;
}
