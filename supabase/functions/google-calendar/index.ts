import { adminClient, gateUser } from "../_shared/auth.ts";
import { decideBot, type CalendarEvent } from "../_shared/calendar-filter.ts";
import { corsHeaders, fetchWithTimeout, jsonResponse, preflight } from "../_shared/http.ts";
import { defaultReturnUrl, safeReturnUrl, signState, verifyState, withParam } from "../_shared/oauth-state.ts";

// Conexión con Google Calendar (solo lectura).
//   GET  ?action=callback               vuelta del consentimiento de Google (sin sesión;
//                                        la identidad viene en el `state` firmado)
//   POST { action: "get_auth_url", redirectUrl }
//   POST { action: "get_events" }        próximos 7 días, con la decisión del bot
//   POST { action: "exclude_event", eventId, exclude }  no grabar (o volver a grabar) un evento
//   POST { action: "disconnect" }
//
// Los tokens de Google quedan en calendar_connections y la app NUNCA los lee:
// las columnas de tokens no tienen permiso de lectura para usuarios (ver la migración).

const GOOGLE_CLIENT_ID = Deno.env.get("GOOGLE_CLIENT_ID") ?? "";
const GOOGLE_CLIENT_SECRET = Deno.env.get("GOOGLE_CLIENT_SECRET") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const STATE_SECRET = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const REDIRECT_URI = `${SUPABASE_URL}/functions/v1/google-calendar?action=callback`;
const SCOPE = "https://www.googleapis.com/auth/calendar.readonly";

// deno-lint-ignore no-explicit-any
type Db = any;

async function freshAccessToken(db: Db, userId: string): Promise<{ token: string; calendarId: string } | null> {
  const { data: c } = await db
    .from("calendar_connections")
    .select("id, access_token, refresh_token, token_expires_at, calendar_id")
    .eq("user_id", userId)
    .eq("is_active", true)
    .maybeSingle();
  if (!c) return null;
  if (c.token_expires_at && new Date(c.token_expires_at).getTime() > Date.now() + 60_000) {
    return { token: c.access_token, calendarId: c.calendar_id || "primary" };
  }
  if (!c.refresh_token) return null;
  const res = await fetchWithTimeout("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      refresh_token: c.refresh_token,
      grant_type: "refresh_token",
    }),
  }, 10_000);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    await db.from("calendar_connections").update({
      last_error: `${body?.error ?? res.status}`.slice(0, 300),
      last_error_at: new Date().toISOString(),
    }).eq("id", c.id);
    return null;
  }
  const t = await res.json();
  await db.from("calendar_connections").update({
    access_token: t.access_token,
    token_expires_at: new Date(Date.now() + (t.expires_in || 3600) * 1000).toISOString(),
    last_error: null,
    last_error_at: null,
    updated_at: new Date().toISOString(),
  }).eq("id", c.id);
  return { token: t.access_token, calendarId: c.calendar_id || "primary" };
}

async function handleCallback(url: URL): Promise<Response> {
  const back = (to: string, error?: string) =>
    new Response(null, { status: 302, headers: { ...corsHeaders, Location: error ? withParam(to, "calendar_error", error) : to } });

  const state = await verifyState(STATE_SECRET, url.searchParams.get("state"));
  if (!state) return back(defaultReturnUrl(), "state");
  const returnUrl = safeReturnUrl(state.redirectUrl);
  const code = url.searchParams.get("code");
  if (!code) return back(returnUrl, url.searchParams.get("error") ? "cancelado" : "sin_codigo");

  const tokenRes = await fetchWithTimeout("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      code,
      grant_type: "authorization_code",
      redirect_uri: REDIRECT_URI,
    }),
  }, 10_000);
  if (!tokenRes.ok) return back(returnUrl, "google");
  const tokens = await tokenRes.json();

  // El id del calendario principal es el correo de la cuenta de Google que autorizó.
  const calRes = await fetchWithTimeout("https://www.googleapis.com/calendar/v3/calendars/primary?fields=id", {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  }, 10_000);
  const calendarId: string = calRes.ok ? String((await calRes.json()).id ?? "") : "";
  if (!calendarId) return back(returnUrl, "google");

  // La cuenta de Google tiene que ser la misma de la persona en la app (o la que
  // ya tenía conectada). Sin esto, alguien podría mandarle a otra persona un
  // enlace de autorización y quedarse con su calendario.
  const db = adminClient();
  const [{ data: profile }, { data: existing }] = await Promise.all([
    db.from("profiles").select("email").eq("user_id", state.userId).maybeSingle(),
    db.from("calendar_connections").select("calendar_id, refresh_token").eq("user_id", state.userId).maybeSingle(),
  ]);
  const same = (a?: string | null, b?: string | null) => !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();
  if (!profile || !(same(calendarId, profile.email) || same(calendarId, existing?.calendar_id))) {
    return back(returnUrl, "cuenta");
  }

  const { error } = await db.from("calendar_connections").upsert({
    user_id: state.userId,
    provider: "google",
    access_token: tokens.access_token,
    // Google no siempre devuelve refresh_token: se conserva el que había.
    refresh_token: tokens.refresh_token || existing?.refresh_token || null,
    token_expires_at: new Date(Date.now() + (tokens.expires_in || 3600) * 1000).toISOString(),
    calendar_id: calendarId,
    is_active: true,
    last_error: null,
    last_error_at: null,
    updated_at: new Date().toISOString(),
  }, { onConflict: "user_id" });
  return error ? back(returnUrl, "guardar") : back(returnUrl);
}

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  try {
    if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
      return jsonResponse({ error: "Falta configurar GOOGLE_CLIENT_ID y GOOGLE_CLIENT_SECRET" }, 500);
    }
    const url = new URL(req.url);
    if (req.method === "GET" && url.searchParams.get("action") === "callback") return await handleCallback(url);
    if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

    const gate = await gateUser(req);
    if (gate.response) return gate.response;
    const userId = (gate.caller as { userId: string }).userId;
    const body = await req.json().catch(() => ({}));
    const db = adminClient();

    if (body.action === "get_auth_url") {
      const state = await signState(STATE_SECRET, { userId, redirectUrl: safeReturnUrl(body.redirectUrl) });
      const auth = new URL("https://accounts.google.com/o/oauth2/v2/auth");
      auth.searchParams.set("client_id", GOOGLE_CLIENT_ID);
      auth.searchParams.set("redirect_uri", REDIRECT_URI);
      auth.searchParams.set("response_type", "code");
      auth.searchParams.set("scope", SCOPE);
      auth.searchParams.set("access_type", "offline");
      auth.searchParams.set("prompt", "consent");
      auth.searchParams.set("state", state);
      return jsonResponse({ authUrl: auth.toString() });
    }

    if (body.action === "disconnect") {
      await db.from("calendar_connections").update({ is_active: false }).eq("user_id", userId);
      return jsonResponse({ success: true });
    }

    if (body.action === "exclude_event") {
      const eventId = typeof body.eventId === "string" ? body.eventId.slice(0, 300) : "";
      if (!eventId) return jsonResponse({ error: "eventId requerido" }, 400);
      if (body.exclude) {
        await db.from("meeting_exclusions").upsert(
          { user_id: userId, calendar_event_id: eventId },
          { onConflict: "user_id,calendar_event_id", ignoreDuplicates: true },
        );
      } else {
        await db.from("meeting_exclusions").delete().eq("user_id", userId).eq("calendar_event_id", eventId);
      }
      return jsonResponse({ success: true });
    }

    if (body.action === "get_events") {
      const access = await freshAccessToken(db, userId);
      if (!access) return jsonResponse({ connected: false, events: [] });
      const now = new Date();
      const list = new URL(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(access.calendarId)}/events`);
      list.searchParams.set("timeMin", now.toISOString());
      list.searchParams.set("timeMax", new Date(now.getTime() + 7 * 86_400_000).toISOString());
      list.searchParams.set("singleEvents", "true");
      list.searchParams.set("orderBy", "startTime");
      list.searchParams.set("maxResults", "50");
      const res = await fetchWithTimeout(list.toString(), { headers: { Authorization: `Bearer ${access.token}` } }, 10_000);
      if (!res.ok) return jsonResponse({ connected: true, error: "Google no entregó los eventos", events: [] });
      const items = ((await res.json()).items ?? []) as CalendarEvent[];

      const [{ data: settings }, { data: exclusions }] = await Promise.all([
        db.from("bot_settings").select("excluded_emails, excluded_keywords, skip_internal_meetings, internal_domain").limit(1).maybeSingle(),
        db.from("meeting_exclusions").select("calendar_event_id").eq("user_id", userId),
      ]);
      const excluded = new Set((exclusions ?? []).map((e: { calendar_event_id: string }) => e.calendar_event_id));
      const events = items
        .filter((e) => e.start?.dateTime)
        .map((e) => {
          const d = decideBot(e, {
            excludedEmails: settings?.excluded_emails ?? [],
            excludedKeywords: settings?.excluded_keywords ?? [],
            skipInternalMeetings: settings?.skip_internal_meetings ?? false,
            internalDomain: settings?.internal_domain ?? "",
            selfEmail: access.calendarId,
          });
          return {
            id: e.id,
            title: e.summary ?? "(sin título)",
            start: e.start.dateTime,
            end: e.end?.dateTime ?? null,
            willRecord: d.send && !excluded.has(e.id),
            reason: d.send ? (excluded.has(e.id) ? "excluded_by_user" : null) : d.reason,
            excludedByUser: excluded.has(e.id),
          };
        });
      return jsonResponse({ connected: true, events });
    }

    return jsonResponse({ error: `Acción desconocida: ${body.action}` }, 400);
  } catch (err) {
    console.error("google-calendar:", err);
    return jsonResponse({ error: "No se pudo completar la acción con Google. El detalle quedó en los registros." }, 500);
  }
});
