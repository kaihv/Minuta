// ¿Tiene sentido mandar el bot a este evento del calendario? Reglas puras, con
// pruebas en calendar-filter.test.ts.
//
// Google le pone enlace de Meet a casi cualquier evento, así que "tiene enlace"
// no significa "es una reunión". Por defecto las reuniones internas SÍ se
// graban; el interruptor `bot_settings.skip_internal_meetings` (Ajustes) las
// salta si todos los invitados son del dominio interno.

export interface CalendarAttendee {
  email?: string;
  self?: boolean;
  resource?: boolean;
  organizer?: boolean;
  responseStatus?: string; // needsAction | declined | tentative | accepted
}

export interface CalendarEvent {
  id: string;
  status?: string; // confirmed | tentative | cancelled
  summary?: string;
  description?: string;
  location?: string;
  eventType?: string; // default | outOfOffice | focusTime | workingLocation | birthday
  start: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  hangoutLink?: string;
  conferenceData?: { entryPoints?: Array<{ uri?: string; entryPointType?: string }> };
  attendees?: CalendarAttendee[];
  organizer?: { email?: string; self?: boolean };
}

export interface FilterSettings {
  excludedEmails?: string[];
  skipInternalMeetings?: boolean;
  internalDomain?: string;
  /** Correo de la cuenta de Google dueña del calendario (si se conoce). */
  selfEmail?: string | null;
}

export type SkipReason =
  | "cancelled"
  | "all_day"
  | "not_a_meeting"
  | "no_video_link"
  | "declined"
  | "no_other_attendees"
  | "everyone_declined"
  | "in_person"
  | "excluded_email"
  | "external_not_accepted"
  | "internal_disabled_by_admin";

export type BotDecision = { send: true; meetingUrl: string } | { send: false; reason: SkipReason; detail?: string };

/** Enlace de videollamada del evento (hoy solo Google Meet). */
export function videoLink(event: CalendarEvent): string | null {
  if (event.hangoutLink) return event.hangoutLink;
  const entry = event.conferenceData?.entryPoints?.find(
    (ep) => ep.entryPointType === "video" && ep.uri?.includes("meet.google.com"),
  );
  return entry?.uri ?? null;
}

const VIRTUAL_HINTS = ["meet.google.com", "zoom.us", "teams.microsoft.com", "webex.com", "whereby.com", "http://", "https://"];
const PHYSICAL_PATTERNS = [
  /\d+\s+\w+/,
  /\b(calle|avenida|av\.|avda|paseo|plaza|edificio|piso|oficina|sala|despacho|room|floor|building|office|street|st\.|avenue|ave\.|boulevard|blvd|suite|ste)\b/i,
  /\b\d{4,6}\b/,
];

/** La ubicación parece una dirección física (reunión presencial). */
export function isPhysicalLocation(location?: string): boolean {
  const loc = (location ?? "").toLowerCase().trim();
  if (!loc) return false;
  if (VIRTUAL_HINTS.some((h) => loc.includes(h))) return false;
  return PHYSICAL_PATTERNS.some((p) => p.test(loc));
}

const lower = (s?: string | null) => (s ?? "").trim().toLowerCase();

export function decideBot(event: CalendarEvent, settings: FilterSettings = {}): BotDecision {
  if (event.status === "cancelled") return { send: false, reason: "cancelled" };
  if (!event.start?.dateTime) return { send: false, reason: "all_day" };
  if (event.eventType && !["default", "fromGmail"].includes(event.eventType)) {
    return { send: false, reason: "not_a_meeting", detail: event.eventType };
  }

  const meetingUrl = videoLink(event);
  if (!meetingUrl) return { send: false, reason: "no_video_link" };

  const self = lower(settings.selfEmail);
  const attendees = (event.attendees ?? []).filter((a) => !a.resource && a.email);
  const isSelf = (a: CalendarAttendee) => a.self === true || (!!self && lower(a.email) === self);

  // La persona rechazó la invitación: no va a estar.
  if (attendees.find(isSelf)?.responseStatus === "declined") return { send: false, reason: "declined" };

  // ¿Hay alguien más? Cuentan los invitados que no son la persona y, si la
  // lista viene oculta, quien organiza el evento.
  const others = attendees.filter((a) => !isSelf(a));
  const organizerIsOther = !!event.organizer?.email && event.organizer.self !== true &&
    (!self || lower(event.organizer.email) !== self) && !lower(event.organizer.email).endsWith("calendar.google.com");
  if (others.length === 0 && !organizerIsOther) return { send: false, reason: "no_other_attendees" };
  if (others.length > 0 && others.every((a) => a.responseStatus === "declined") && !organizerIsOther) {
    return { send: false, reason: "everyone_declined" };
  }

  if (isPhysicalLocation(event.location)) return { send: false, reason: "in_person", detail: event.location };

  const excluded = (settings.excludedEmails ?? []).map(lower);
  const hit = attendees.find((a) => excluded.includes(lower(a.email)));
  if (hit) return { send: false, reason: "excluded_email", detail: hit.email };

  // Invitación de alguien de afuera que la persona no ha aceptado: Google la
  // agrega sola al calendario, así que cualquiera podría "mandar el bot" a su
  // reunión. Solo aplica si se configuró el dominio de la empresa.
  const internal = lower(settings.internalDomain);
  const organizer = lower(event.organizer?.email);
  if (
    internal && organizer && event.organizer?.self !== true && !organizer.endsWith(`@${internal}`) &&
    !organizer.endsWith("calendar.google.com") && attendees.find(isSelf)?.responseStatus === "needsAction"
  ) {
    return { send: false, reason: "external_not_accepted", detail: organizer };
  }

  if (settings.skipInternalMeetings && attendees.length > 0 && internal) {
    const domain = `@${internal}`;
    if (attendees.every((a) => lower(a.email).endsWith(domain))) {
      return { send: false, reason: "internal_disabled_by_admin" };
    }
  }
  return { send: true, meetingUrl };
}

// --- Contexto del evento que se guarda en la reunión -------------------------

export const CALENDAR_DESCRIPTION_MAX = 4000;

/** Descripción de la invitación como texto plano (Google la entrega con HTML). */
export function plainDescription(raw: unknown, max = CALENDAR_DESCRIPTION_MAX): string | null {
  if (typeof raw !== "string") return null;
  const text = raw
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6])\s*>/gi, "\n")
    .replace(/<li[^>]*>/gi, "• ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
  if (!text) return null;
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/**
 * Datos del evento de calendario que se guardan en `meetings` (sirven de
 * contexto al resumen):
 *  - scheduled_end_at: término agendado (con scheduled_at da la duración agendada);
 *  - calendar_description: descripción de la invitación, texto plano.
 * Nulos cuando el evento no los trae.
 */
export function calendarContext(event: Pick<CalendarEvent, "end" | "description">): {
  scheduled_end_at: string | null;
  calendar_description: string | null;
} {
  const end = event.end?.dateTime ? new Date(event.end.dateTime) : null;
  return {
    scheduled_end_at: end && !isNaN(end.getTime()) ? end.toISOString() : null,
    calendar_description: plainDescription(event.description),
  };
}

/** PostgREST o Postgres rechazaron una columna que todavía no existe (migración sin aplicar). */
export function isMissingColumnError(error: { code?: string; message?: string } | null | undefined): boolean {
  if (!error) return false;
  return error.code === "42703" || error.code === "PGRST204" ||
    /column .* does not exist|could not find the .* column/i.test(error.message ?? "");
}
