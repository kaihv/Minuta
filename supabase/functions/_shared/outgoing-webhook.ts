// Aviso hacia afuera cuando una reunión queda lista (transcrita y, si hay IA,
// resumida). Sirve para conectar la app con cualquier otra herramienta: un
// CRM, Zapier/Make/n8n, una planilla, un canal de chat.
//
//   OUTGOING_WEBHOOK_URL     https://... (si no está, no se manda nada)
//   OUTGOING_WEBHOOK_SECRET  para firmar; el receptor verifica la cabecera
//                            X-Minuta-Signature: sha256=<hex de HMAC-SHA256 del cuerpo>
//   OUTGOING_WEBHOOK_INCLUDE_TRANSCRIPT  "true" para mandar también la transcripción

export interface WebhookMeeting {
  id: string;
  title: string | null;
  scheduled_at: string | null;
  duration_minutes: number | null;
  meeting_url: string | null;
  attendees: unknown;
  summary: unknown;
  status: string;
}

export function buildWebhookPayload(
  meeting: WebhookMeeting,
  opts: { appUrl?: string | null; transcript?: string | null; now?: Date } = {},
): Record<string, unknown> {
  const appUrl = (opts.appUrl ?? "").replace(/\/+$/, "");
  return {
    event: "meeting.ready",
    sent_at: (opts.now ?? new Date()).toISOString(),
    meeting: {
      id: meeting.id,
      title: meeting.title,
      scheduled_at: meeting.scheduled_at,
      duration_minutes: meeting.duration_minutes,
      meeting_url: meeting.meeting_url,
      attendees: Array.isArray(meeting.attendees) ? meeting.attendees : [],
      status: meeting.status,
      app_url: appUrl ? `${appUrl}/reunion/${meeting.id}` : null,
    },
    summary: meeting.summary ?? null,
    ...(opts.transcript != null ? { transcript: opts.transcript } : {}),
  };
}

export async function signBody(secret: string, body: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(body)));
  return "sha256=" + Array.from(mac).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Solo https y sin apuntar a la red interna. */
export function safeWebhookUrl(raw: string | undefined | null): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw.trim());
    if (u.protocol !== "https:") return null;
    const h = u.hostname.toLowerCase();
    if (h === "localhost" || h.endsWith(".local") || h.endsWith(".internal") || h.endsWith(".localhost") ||
      /^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(h) ||
      h.startsWith("[")) return null; // IPv6 literal: no se acepta (puede apuntar a la red interna)
    return u.toString();
  } catch (_e) {
    return null;
  }
}
