import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { calendarContext, decideBot, isMissingColumnError, isPhysicalLocation, plainDescription, type CalendarEvent } from "./calendar-filter.ts";

const base = (over: Partial<CalendarEvent> = {}): CalendarEvent => ({
  id: "evt",
  status: "confirmed",
  summary: "Reunión con cliente",
  start: { dateTime: "2026-10-07T15:00:00-03:00" },
  hangoutLink: "https://meet.google.com/abc-defg-hij",
  organizer: { email: "ana@miempresa.example", self: true },
  attendees: [
    { email: "ana@miempresa.example", self: true, responseStatus: "accepted" },
    { email: "carla@cliente.example", responseStatus: "accepted" },
  ],
  ...over,
});
const reason = (e: CalendarEvent, s = {}) => {
  const d = decideBot(e, s);
  return d.send ? "send" : d.reason;
};

Deno.test("reunión normal con cliente: se manda el bot", () => {
  assertEquals(decideBot(base()), { send: true, meetingUrl: "https://meet.google.com/abc-defg-hij" });
});

Deno.test("las reuniones internas SÍ se graban ", () => {
  const interna = base({ attendees: [{ email: "pedro@miempresa.example", self: true }, { email: "ana@miempresa.example" }] });
  assertEquals(reason(interna), "send");
  assertEquals(reason(interna, { skipInternalMeetings: false, internalDomain: "miempresa.example" }), "send");
  // Solo si un admin deja encendido el interruptor de Configuración.
  assertEquals(reason(interna, { skipInternalMeetings: true, internalDomain: "miempresa.example" }), "internal_disabled_by_admin");
});

Deno.test("sin enlace de videollamada no hay a dónde mandar el bot", () => {
  assertEquals(reason(base({ hangoutLink: undefined })), "no_video_link");
  const conEntrada = base({
    hangoutLink: undefined,
    conferenceData: { entryPoints: [{ entryPointType: "video", uri: "https://meet.google.com/xyz" }] },
  });
  assertEquals(reason(conEntrada), "send");
});

Deno.test("eventos de día completo, cancelados y que no son reuniones", () => {
  assertEquals(reason(base({ start: { date: "2026-10-07" } })), "all_day");
  assertEquals(reason(base({ status: "cancelled" })), "cancelled");
  assertEquals(reason(base({ eventType: "focusTime" })), "not_a_meeting");
  assertEquals(reason(base({ eventType: "outOfOffice" })), "not_a_meeting");
});

Deno.test("la persona rechazó la invitación", () => {
  const e = base({
    organizer: { email: "carla@cliente.example" },
    attendees: [
      { email: "ana@miempresa.example", self: true, responseStatus: "declined" },
      { email: "carla@cliente.example", responseStatus: "accepted" },
    ],
  });
  assertEquals(reason(e), "declined");
  // También cuando Google no marca `self` pero se conoce la cuenta.
  const sinSelf = base({ attendees: [{ email: "ana@miempresa.example", responseStatus: "declined" }, { email: "x@y.cl" }] });
  assertEquals(reason(sinSelf, { selfEmail: "Ana@miempresa.example" }), "declined");
});

Deno.test("sin nadie más: bloque propio con enlace de Meet puesto por Google", () => {
  assertEquals(reason(base({ attendees: [] })), "no_other_attendees");
  assertEquals(reason(base({ attendees: undefined })), "no_other_attendees");
  assertEquals(reason(base({ attendees: [{ email: "ana@miempresa.example", self: true }] })), "no_other_attendees");
  // Una sala de reuniones no cuenta como "alguien más".
  assertEquals(
    reason(base({ attendees: [{ email: "ana@miempresa.example", self: true }, { email: "sala@resource.calendar.google.com", resource: true }] })),
    "no_other_attendees",
  );
});

Deno.test("lista de invitados oculta: si organiza otra persona, hay alguien más", () => {
  const e = base({
    organizer: { email: "cliente@empresa.cl" },
    attendees: [{ email: "ana@miempresa.example", self: true, responseStatus: "accepted" }],
  });
  assertEquals(reason(e), "send");
});

Deno.test("todos los demás rechazaron", () => {
  const e = base({
    attendees: [
      { email: "ana@miempresa.example", self: true, responseStatus: "accepted" },
      { email: "a@cliente.cl", responseStatus: "declined" },
      { email: "b@cliente.cl", responseStatus: "declined" },
    ],
  });
  assertEquals(reason(e), "everyone_declined");
  e.attendees![2].responseStatus = "needsAction";
  assertEquals(reason(e), "send");
});

Deno.test("presencial y correos excluidos (reglas que ya existían)", () => {
  assertEquals(reason(base({ location: "Av. Apoquindo 4501, piso 12" })), "in_person");
  assertEquals(reason(base({ location: "https://meet.google.com/abc" })), "send");
  assertEquals(isPhysicalLocation("Sala de reuniones"), true);
  assertEquals(isPhysicalLocation(""), false);
  assertEquals(reason(base(), { excludedEmails: ["CARLA@cliente.example"] }), "excluded_email");
});

Deno.test("contexto del evento: término agendado y descripción en texto plano", () => {
  const ctx = calendarContext({
    end: { dateTime: "2026-10-07T15:30:00-03:00" },
    description: "<p>Segunda reunión: <b>revisión de propuesta</b></p><ul><li>Piloto 3 módulos</li><li>Precios &amp; plazos</li></ul><br>Enlace: <a href=\"https://x.cl\">propuesta</a>",
  });
  assertEquals(ctx.scheduled_end_at, "2026-10-07T18:30:00.000Z");
  assertEquals(ctx.calendar_description, "Segunda reunión: revisión de propuesta\n• Piloto 3 módulos\n• Precios & plazos\n\nEnlace: propuesta");
  // Sin datos: nulos (reunión rápida, evento de día completo, descripción vacía).
  assertEquals(calendarContext({}), { scheduled_end_at: null, calendar_description: null });
  assertEquals(calendarContext({ end: { date: "2026-10-08" }, description: "  <br> " }), { scheduled_end_at: null, calendar_description: null });
});

Deno.test("la descripción se corta a 4.000 caracteres", () => {
  const long = plainDescription("palabra ".repeat(2000))!;
  assertEquals(long.length <= 4000, true);
  assertEquals(long.endsWith("…"), true);
  assertEquals(plainDescription(42), null);
});

Deno.test("columna que todavía no existe: se reconoce el error para reintentar sin ella", () => {
  assertEquals(isMissingColumnError({ code: "PGRST204", message: "Could not find the 'scheduled_end_at' column of 'meetings' in the schema cache" }), true);
  assertEquals(isMissingColumnError({ code: "42703", message: 'column "calendar_description" does not exist' }), true);
  assertEquals(isMissingColumnError({ code: "23505", message: "duplicate key" }), false);
  assertEquals(isMissingColumnError(null), false);
});

Deno.test("invitación externa sin aceptar no se graba (si hay dominio configurado)", () => {
  const externa = base({
    organizer: { email: "carla@cliente.example" },
    attendees: [
      { email: "ana@miempresa.example", self: true, responseStatus: "needsAction" },
      { email: "carla@cliente.example", responseStatus: "accepted" },
    ],
  });
  assertEquals(reason(externa, { internalDomain: "miempresa.example" }), "external_not_accepted");
  assertEquals(reason(externa), "send"); // sin dominio configurado no se aplica
  const aceptada = base({
    organizer: { email: "carla@cliente.example" },
    attendees: [
      { email: "ana@miempresa.example", self: true, responseStatus: "accepted" },
      { email: "carla@cliente.example", responseStatus: "accepted" },
    ],
  });
  assertEquals(reason(aceptada, { internalDomain: "miempresa.example" }), "send");
});
