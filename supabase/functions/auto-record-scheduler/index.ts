import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { gateCron } from "../_shared/auth.ts";
import { isInvited, SHARED_STATUSES, sharedWindow } from "../_shared/shared-meeting.ts";
import { calendarContext, decideBot, isMissingColumnError, type CalendarEvent } from "../_shared/calendar-filter.ts";
import { corsHeaders, fetchWithTimeout, runInBackground } from "../_shared/http.ts";
import { claimEvent, finishEvent, supabaseEventStore } from "../_shared/pipeline-events.ts";
import { pipelineDeps } from "../_shared/pipeline-runtime.ts";
import { buildBotRequest, joinMessageFromEnv, recallClientFromEnv } from "../_shared/recall.ts";
import { runSweep, supabaseSweepDb } from "../_shared/sweep.ts";

// Programador de grabación automática. Lo llama pg_cron cada 5 minutos
// (ver supabase/cron.sql).
//
//  - Responde 202 de inmediato y trabaja en segundo plano: pg_net corta a los
//    5 segundos. El resultado de cada corrida
//    queda en pipeline_events (kind = 'scheduler'), no en la respuesta HTTP.
//    Con ?wait=1 espera y devuelve el resultado (para probar a mano).
//  - Los calendarios se leen en paralelo y cada llamada tiene límite de tiempo.
//    Los bots se deciden en serie, para que "un solo bot por reunión" no tenga
//    carreras entre personas.
//  - Un token de Google que no se puede renovar queda anotado en
//    calendar_connections.last_error y se deja de insistir cada 5 minutos.
//  - Antes de mandar un bot se aplican las reglas de _shared/calendar-filter.ts:
//    sin enlace de videollamada, día completo, rechazado, sin nadie más. Las
//    reuniones internas SÍ se graban (salvo que un admin lo apague en Ajustes).
//  - Si Recall no entrega bot, el motivo queda en la reunión.
//  - Al final corre el barrido de reuniones pegadas (_shared/sweep.ts).

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const GOOGLE_CLIENT_ID = Deno.env.get("GOOGLE_CLIENT_ID")!;
const GOOGLE_CLIENT_SECRET = Deno.env.get("GOOGLE_CLIENT_SECRET")!;

const GOOGLE_TIMEOUT_MS = 10_000;
const LOOKAHEAD_MINUTES = 15;
// Tras un `invalid_grant` (la persona revocó el acceso o Google invalidó el
// token) no se vuelve a intentar hasta pasado este tiempo.
const DEAD_TOKEN_BACKOFF_MS = 6 * 3600_000;

interface CalendarConnection {
  id: string;
  user_id: string;
  access_token: string;
  refresh_token: string;
  token_expires_at: string;
  calendar_id: string;
  auto_record_enabled: boolean;
  auto_record_minutes_before: number;
  last_error?: string | null;
  last_error_at?: string | null;
}

// deno-lint-ignore no-explicit-any
type Db = any;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

async function refreshGoogleToken(
  refreshToken: string,
): Promise<{ ok: true; access_token: string; expires_in: number } | { ok: false; error: string }> {
  try {
    const response = await fetchWithTimeout("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        refresh_token: refreshToken,
        grant_type: "refresh_token",
      }),
    }, GOOGLE_TIMEOUT_MS);
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      return { ok: false, error: `${body?.error ?? `http_${response.status}`}: ${body?.error_description ?? ""}`.trim() };
    }
    const data = await response.json();
    return { ok: true, access_token: data.access_token, expires_in: data.expires_in };
  } catch (error) {
    return { ok: false, error: `network: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/** Anota en la conexión el resultado del último intento (columnas nuevas: si no existen, se ignora). */
async function noteConnection(supabase: Db, connectionId: string, patch: Record<string, unknown>): Promise<void> {
  const { error } = await supabase.from("calendar_connections").update(patch).eq("id", connectionId);
  if (error && !/column|schema cache/i.test(error.message ?? "")) {
    console.error(`No se pudo anotar el estado de la conexión ${connectionId}:`, error.message);
  }
}

// Token de Google vigente para una conexión; lo renueva y lo guarda si venció.
async function ensureAccessToken(supabase: Db, connection: CalendarConnection): Promise<string | null> {
  if (!connection.token_expires_at || new Date(connection.token_expires_at) > new Date()) {
    return connection.access_token;
  }
  if (
    connection.last_error?.startsWith("invalid_grant") && connection.last_error_at &&
    Date.now() - Date.parse(connection.last_error_at) < DEAD_TOKEN_BACKOFF_MS
  ) {
    return null; // token muerto: se reintenta cada 6 horas, no cada 5 minutos
  }
  if (!connection.refresh_token) {
    await noteConnection(supabase, connection.id, { last_error: "invalid_grant: sin refresh_token", last_error_at: new Date().toISOString() });
    return null;
  }
  const refreshed = await refreshGoogleToken(connection.refresh_token);
  if (!refreshed.ok) {
    console.error(`Token de calendario sin renovar (usuario ${connection.user_id}): ${refreshed.error}`);
    connection.last_error = refreshed.error;
    connection.last_error_at = new Date().toISOString();
    await noteConnection(supabase, connection.id, { last_error: refreshed.error.slice(0, 500), last_error_at: connection.last_error_at });
    return null;
  }
  connection.access_token = refreshed.access_token;
  connection.token_expires_at = new Date(Date.now() + refreshed.expires_in * 1000).toISOString();
  await supabase
    .from("calendar_connections")
    .update({
      access_token: connection.access_token,
      token_expires_at: connection.token_expires_at,
      updated_at: new Date().toISOString(),
    })
    .eq("id", connection.id);
  await noteConnection(supabase, connection.id, { last_sync_at: new Date().toISOString(), last_error: null, last_error_at: null });
  return connection.access_token;
}

async function getUpcomingEvents(accessToken: string, calendarId: string): Promise<CalendarEvent[] | null> {
  const now = new Date();
  const url = new URL(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`);
  url.searchParams.set("timeMin", now.toISOString());
  url.searchParams.set("timeMax", new Date(now.getTime() + LOOKAHEAD_MINUTES * 60_000).toISOString());
  url.searchParams.set("singleEvents", "true");
  url.searchParams.set("orderBy", "startTime");
  try {
    const response = await fetchWithTimeout(url.toString(), { headers: { Authorization: `Bearer ${accessToken}` } }, GOOGLE_TIMEOUT_MS);
    if (!response.ok) {
      console.error("No se pudieron leer los eventos:", response.status, (await response.text()).slice(0, 200));
      return null;
    }
    const data = await response.json();
    return (data.items || []) as CalendarEvent[];
  } catch (error) {
    console.error("Error leyendo eventos:", error instanceof Error ? error.message : error);
    return null;
  }
}

// Correo de la cuenta de Google dueña del token: el id de su calendario
// principal. No depende de calendar_connections.calendar_id (que la persona
// puede apuntar a un calendario ajeno) ni del perfil de la app.
async function getAccountEmail(accessToken: string): Promise<string | null> {
  try {
    const response = await fetchWithTimeout("https://www.googleapis.com/calendar/v3/calendars/primary?fields=id", {
      headers: { Authorization: `Bearer ${accessToken}` },
    }, GOOGLE_TIMEOUT_MS);
    if (!response.ok) return null;
    const { id } = await response.json();
    return typeof id === "string" && id.includes("@") ? id.trim().toLowerCase() : null;
  } catch (error) {
    console.error("Error fetching account email:", error);
    return null;
  }
}

/** Actualiza la reunión con datos del evento; las columnas de contexto son opcionales. */
async function updateMeetingFromEvent(
  supabase: Db,
  meetingId: string,
  patch: Record<string, unknown>,
  context: Record<string, unknown>,
): Promise<void> {
  const { error } = await supabase.from("meetings").update({ ...patch, ...context }).eq("id", meetingId);
  if (error && isMissingColumnError(error)) {
    await supabase.from("meetings").update(patch).eq("id", meetingId);
  } else if (error) {
    console.error(`No se pudo actualizar la reunión ${meetingId}:`, error.message);
  }
}

interface RunSummary {
  connections: number;
  connections_without_token: number;
  events_seen: number;
  bots_created: number;
  shared: number;
  skipped: Record<string, number>;
  bot_errors: string[];
  sweep?: unknown;
}

async function runScheduler(supabase: Db): Promise<RunSummary> {
  const summary: RunSummary = {
    connections: 0,
    connections_without_token: 0,
    events_seen: 0,
    bots_created: 0,
    shared: 0,
    skipped: {},
    bot_errors: [],
  };
  const skip = (reason: string) => (summary.skipped[reason] = (summary.skipped[reason] ?? 0) + 1);

  const { data: botSettings } = await supabase.from("bot_settings").select("*").limit(1).maybeSingle();

  const { data: connections, error: connectionsError } = await supabase
    .from("calendar_connections")
    .select("*")
    .eq("is_active", true)
    .eq("auto_record_enabled", true);
  if (connectionsError) throw new Error(`calendar_connections: ${connectionsError.message}`);
  const conns = (connections ?? []) as CalendarConnection[];
  summary.connections = conns.length;

  // Fase 1, en paralelo: token y eventos de cada persona (lo lento).
  const prepared = await Promise.all(conns.map(async (connection) => {
    const accessToken = await ensureAccessToken(supabase, connection);
    if (!accessToken) return { connection, accessToken: null, events: [] as CalendarEvent[] };
    const events = await getUpcomingEvents(accessToken, connection.calendar_id || "primary");
    return { connection, accessToken, events: events ?? [] };
  }));

  // Cuenta de Google de cada persona, pedida a Google solo cuando hay que
  // decidir si una reunión se comparte o si la persona rechazó el evento.
  const accountEmails = new Map<string, string | null>();
  const accountEmailOf = async (userId: string): Promise<string | null> => {
    if (!accountEmails.has(userId)) {
      const token = prepared.find((p) => p.connection.user_id === userId)?.accessToken ?? null;
      accountEmails.set(userId, token ? await getAccountEmail(token) : null);
    }
    return accountEmails.get(userId) ?? null;
  };

  const recall = recallClientFromEnv();
  const excludedEmails = (botSettings?.excluded_emails as string[]) || [];
  const excludedKeywords = (botSettings?.excluded_keywords as string[]) || [];
  const skipInternal = botSettings?.skip_internal_meetings ?? false;
  const internalDomain = botSettings?.internal_domain ?? "";

  // Fase 2, en serie: decidir y mandar bots.
  for (const { connection, accessToken, events } of prepared) {
    if (!accessToken) {
      summary.connections_without_token++;
      continue;
    }
    const minutesBefore = connection.auto_record_minutes_before || 2;

    for (const event of events) {
      summary.events_seen++;
      const eventStartTime = event.start?.dateTime ? new Date(event.start.dateTime) : null;

      // ¿Tiene sentido mandar bot a este evento?
      const needsSelf = (event.attendees ?? []).length > 0 && !(event.attendees ?? []).some((a) => a.self === true);
      const decision = decideBot(event, {
        excludedEmails,
        excludedKeywords,
        skipInternalMeetings: skipInternal,
        internalDomain,
        selfEmail: needsSelf ? await accountEmailOf(connection.user_id) : null,
      });
      if (!decision.send) {
        skip(decision.reason);
        continue;
      }
      const meetingUrl = decision.meetingUrl;
      if (!eventStartTime) continue;

      const minutesUntilStart = (eventStartTime.getTime() - Date.now()) / 60_000;
      if (minutesUntilStart > minutesBefore) {
        skip("too_early");
        continue;
      }

      // Exclusión puntual de la persona para este evento.
      const { data: exclusion } = await supabase
        .from("meeting_exclusions")
        .select("id")
        .eq("calendar_event_id", event.id)
        .eq("user_id", connection.user_id)
        .maybeSingle();
      if (exclusion) {
        skip("excluded_by_user");
        continue;
      }

      // ¿Ya existe la reunión de este evento para esta persona?
      const { data: existingMeeting } = await supabase
        .from("meetings")
        .select("id, recall_bot_id, status")
        .eq("calendar_event_id", event.id)
        .eq("user_id", connection.user_id)
        .maybeSingle();
      if (existingMeeting?.recall_bot_id) {
        skip("already_has_bot");
        continue;
      }
      if (existingMeeting && !["scheduled"].includes(existingMeeting.status)) {
        // Ya se cerró (no grabada, fallida, completada): no se manda otro bot.
        skip("already_closed");
        continue;
      }

      // REUNIÓN COMPARTIDA: otra persona del equipo ya tiene bot en esta misma
      // reunión (mismo link, misma hora). No se manda un segundo bot: la
      // grabación del primero queda compartida con esta persona. Las dos tienen
      // que verse como invitadas en el evento de la otra, con la cuenta de
      // Google de su token: yo en la lista del dueño (no basta pegar el link en
      // un evento propio) y el dueño en la mía (nadie se queda con mi grabación
      // por haber mandado su bot primero).
      const window = sharedWindow(eventStartTime);
      const { data: sharedCandidates } = await supabase
        .from("meetings")
        .select("id, recall_bot_id, status, title, user_id, attendees")
        .eq("meeting_url", meetingUrl)
        .neq("user_id", connection.user_id)
        .not("recall_bot_id", "is", null)
        .in("status", SHARED_STATUSES)
        .gte("scheduled_at", window.from)
        .lte("scheduled_at", window.to)
        .order("created_at", { ascending: true })
        .limit(10);

      const myEmail = sharedCandidates?.length ? await accountEmailOf(connection.user_id) : null;
      const myGuests = [...(event.attendees ?? []), ...(event.organizer ? [event.organizer] : [])];
      let sharedMeeting = null;
      for (const candidate of sharedCandidates ?? []) {
        if (!isInvited(candidate.attendees, myEmail)) continue;
        if (!isInvited(myGuests, await accountEmailOf(candidate.user_id))) continue;
        sharedMeeting = candidate;
        break;
      }

      if (sharedMeeting) {
        // meeting_assignments es lo que da acceso (políticas RLS).
        const { error: assignmentError } = await supabase
          .from("meeting_assignments")
          .upsert(
            { meeting_id: sharedMeeting.id, assigned_to: connection.user_id, assigned_by: sharedMeeting.user_id },
            { onConflict: "meeting_id,assigned_to", ignoreDuplicates: true },
          );

        if (assignmentError) {
          // Sin acceso a la grabación ajena, mejor un bot propio que quedarse sin nada.
          console.error(`No se pudo compartir la reunión ${sharedMeeting.id} con ${connection.user_id}:`, assignmentError);
        } else {
          summary.shared++;
          continue; // sin segundo bot
        }
      }

      // ¿Esta persona ya tiene una reunión con el mismo link (grabación manual)?
      const { data: existingByUrl } = await supabase
        .from("meetings")
        .select("id, recall_bot_id, status, title")
        .eq("meeting_url", meetingUrl)
        .eq("user_id", connection.user_id)
        .in("status", ["scheduled", "recording"])
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (existingByUrl?.recall_bot_id) {
        skip("already_has_bot");
        continue;
      }

      const eventAttendees = (event.attendees || []).map((a) => ({
        email: a.email,
        name: null,
        responseStatus: a.responseStatus || null,
      }));

      // Término agendado y descripción de la invitación: contexto para el resumen.
      const context = calendarContext(event);

      let meetingId: string;
      if (existingMeeting) {
        meetingId = existingMeeting.id;
        await updateMeetingFromEvent(supabase, meetingId, { attendees: eventAttendees }, context);
      } else if (existingByUrl) {
        meetingId = existingByUrl.id;
        await updateMeetingFromEvent(supabase, meetingId, { attendees: eventAttendees, calendar_event_id: event.id }, context);
      } else {
        const row = {
          user_id: connection.user_id,
          title: event.summary || "Untitled Meeting",
          meeting_url: meetingUrl,
          calendar_event_id: event.id,
          scheduled_at: eventStartTime.toISOString(),
          auto_record: true,
          status: "scheduled",
          attendees: eventAttendees,
        };
        let { data: newMeeting, error: insertError } = await supabase
          .from("meetings").insert({ ...row, ...context }).select("id").single();
        if (insertError && isMissingColumnError(insertError)) {
          ({ data: newMeeting, error: insertError } = await supabase.from("meetings").insert(row).select("id").single());
        }
        if (insertError || !newMeeting) {
          summary.bot_errors.push(`crear reunión "${event.summary}": ${insertError?.message ?? "sin fila"}`);
          continue;
        }
        meetingId = newMeeting.id;
      }

      // Mandar el bot.
      let botId: string | null = null;
      try {
        botId = (await recall.createBot(buildBotRequest(meetingUrl, botSettings ?? undefined, { joinMessage: joinMessageFromEnv() }))).id;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        summary.bot_errors.push(`bot para ${meetingId}: ${message}`);
        // Queda el motivo en la reunión. La próxima pasada (5 min) lo vuelve a
        // intentar mientras el evento siga en curso; si nunca hay bot, el
        // barrido la cierra como no grabada con este motivo.
        const { error: noteError } = await supabase
          .from("meetings")
          .update({ not_recorded_reason: `bot_create_failed: ${message}`.slice(0, 300) })
          .eq("id", meetingId);
        if (noteError && !/column|schema cache/i.test(noteError.message ?? "")) console.error(noteError.message);
        continue;
      }

      // Enlazar el bot a la reunión. Sin tocar status: lo mueve recall-webhook.
      let linked = false;
      for (let attempt = 1; attempt <= 3 && !linked; attempt++) {
        const { error: updateError } = await supabase
          .from("meetings")
          .update({ recall_bot_id: botId, updated_at: new Date().toISOString() })
          .eq("id", meetingId);
        if (!updateError) linked = true;
        else if (attempt < 3) await new Promise((r) => setTimeout(r, attempt * 500));
      }
      if (!linked) {
        // El bot existe en Recall: recall-webhook lo enlaza por el link de la reunión.
        summary.bot_errors.push(`bot ${botId} creado pero sin enlazar a ${meetingId}`);
      }
      summary.bots_created++;
    }
  }

  // Fase 3: barrido de lo que quedó a medias.
  try {
    const pipeline = pipelineDeps(supabase);
    summary.sweep = await runSweep(
      { pipeline, sweepDb: supabaseSweepDb(supabase), events: pipeline.events },
      { limit: 8, budgetMs: 90_000 },
    );
  } catch (error) {
    summary.sweep = { error: error instanceof Error ? error.message : String(error) };
  }
  return summary;
}

/** Una corrida completa, registrada en pipeline_events y sin solaparse con otra. */
async function scheduledRun(): Promise<Record<string, unknown>> {
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const events = supabaseEventStore(supabase);
  // Una corrida por tramo de 5 minutos: si pg_cron dispara dos veces, o alguien
  // la llama a mano mientras corre, la segunda no hace nada.
  const slot = new Date(Math.floor(Date.now() / 300_000) * 300_000).toISOString();
  const key = `scheduler:${slot}`;
  const claim = await claimEvent(events, key, { kind: "scheduler", event_type: "auto-record", staleMs: 4 * 60_000 });
  if (!claim.claimed) return { skipped: true, reason: claim.reason };
  try {
    const summary = await runScheduler(supabase);
    const failed = summary.bot_errors.length > 0;
    await finishEvent(events, key, failed ? "error" : "done", {
      detail: summary,
      error: failed ? summary.bot_errors.join(" | ") : null,
    });
    console.log("Programador:", JSON.stringify(summary));
    return { success: true, ...summary };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Programador falló:", message);
    await finishEvent(events, key, "error", { error: message });
    return { success: false, error: message };
  }
}

Deno.serve(async (req) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  // Seguridad: cabecera x-cron-secret del job de pg_cron, service role, o un
  // admin con sesión. Ver _shared/auth.ts.
  const gate = await gateCron(req, corsHeaders);
  if (gate.response) return gate.response;

  const wait = new URL(req.url).searchParams.get("wait") === "1";
  const task = scheduledRun();
  if (wait) {
    const result = await task;
    return json(result, result.success === false ? 500 : 200);
  }
  runInBackground(task);
  return json({ accepted: true }, 202);
});
