// Un solo bot por reunión cuando hay varias personas del equipo invitadas: reglas
// sin I/O que usa auto-record-scheduler para decidir si la reunión que ya tiene
// bot es la misma y si la persona tiene derecho a verla.

// Estados en que la reunión de otra persona cuenta como "ya hay un bot": en
// curso o ya grabada. Si quedó not_recorded / failed, se manda un bot propio.
export const SHARED_STATUSES = ["scheduled", "recording", "processing", "completed"];

// El link de Meet se repite en reuniones recurrentes: solo es la misma reunión
// si parte a la misma hora (con holgura).
export const SHARED_WINDOW_MS = 60 * 60_000;

export function sharedWindow(eventStart: Date): { from: string; to: string } {
  return {
    from: new Date(eventStart.getTime() - SHARED_WINDOW_MS).toISOString(),
    to: new Date(eventStart.getTime() + SHARED_WINDOW_MS).toISOString(),
  };
}

// ¿Está ese correo en una lista de invitados? Se usa en los dos sentidos: yo en
// la lista del dueño de la reunión (meetings.attendees) y el dueño en la de mi
// evento. `email` tiene que ser el de la cuenta de Google del token, no uno que
// la persona pueda elegir (ni el perfil de la app ni el calendario que configuró).
export function isInvited(guests: unknown, email: string | null): boolean {
  const me = email?.trim().toLowerCase();
  if (!me || !Array.isArray(guests)) return false;
  return guests.some((a) => typeof a?.email === "string" && a.email.trim().toLowerCase() === me);
}
