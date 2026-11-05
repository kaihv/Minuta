// Transiciones de estado de una reunión. Reglas puras, con pruebas.
//
// El enum meeting_status tiene: scheduled, recording, processing, completed,
// failed, not_recorded. Nada más: `transcribing`, `joining` e `in_progress` no
// existen (usarlos hacía fallar el UPDATE entero y dejó bots sin enlazar).
//
// Los avisos de Recall llegan en paralelo y desordenados, así que:
//  - avanzar es un UPDATE condicionado al estado actual (atómico);
//  - nunca se retrocede (completed no vuelve a processing);
//  - `not_recorded` y `failed` solo se escriben desde estados en curso: un
//    aviso atrasado no puede pisar una reunión ya completada;
//  - si aparece una grabación para una reunión marcada not_recorded / failed,
//    se "revive" (pasó cuando bot.leave_call llegaba antes que la grabación).

export type MeetingStatus = "scheduled" | "recording" | "processing" | "completed" | "failed" | "not_recorded";

export const PROGRESS_ORDER: Record<string, number> = {
  scheduled: 1,
  recording: 2,
  processing: 3,
  completed: 4,
};

export const IN_PROGRESS: MeetingStatus[] = ["scheduled", "recording", "processing"];
export const DEAD_ENDS: MeetingStatus[] = ["failed", "not_recorded"];

/**
 * Estados desde los cuales se permite pasar a `to`.
 * `revive`: además permite salir de failed / not_recorded (hay grabación).
 */
export function statusesAllowedBefore(to: MeetingStatus, opts: { revive?: boolean } = {}): MeetingStatus[] {
  if (to === "not_recorded" || to === "failed") return [...IN_PROGRESS];
  const order = PROGRESS_ORDER[to];
  if (!order) return [];
  const before = (Object.keys(PROGRESS_ORDER) as MeetingStatus[]).filter((s) => PROGRESS_ORDER[s] < order);
  return opts.revive ? [...before, ...DEAD_ENDS] : before;
}

export function canAdvance(from: string, to: MeetingStatus, opts: { revive?: boolean } = {}): boolean {
  return statusesAllowedBefore(to, opts).includes(from as MeetingStatus);
}

// Motivos por los que un bot termina sin grabar y NO es un error técnico.
export const NOT_RECORDED_SUB_CODES = [
  "waiting_room_timeout",
  "timeout_exceeded_waiting_room",
  "denied_by_host",
  "everyone_left",
  "timeout_exceeded_everyone_left",
  "kicked",
  "noone_joined",
  "timeout_exceeded_noone_joined",
  "call_ended_by_host",
  "meeting_not_started",
  "meeting_not_found",
  "bot_was_removed",
  "bot_kicked_from_call",
  "bot_kicked_from_waiting_room",
  "call_ended",
];

/**
 * Qué hacer con un bot que terminó SIN grabación.
 *  - sub_code conocido de "no se pudo grabar" => not_recorded;
 *  - error fatal cuando ya estaba grabando => failed;
 *  - cualquier otro caso => not_recorded (nunca llegó a grabar).
 * Devuelve también el motivo que se guarda en meetings.not_recorded_reason.
 */
export function outcomeWithoutRecording(input: {
  subCode?: string | null;
  lastCode?: string | null;
  meetingStatus: string;
}): { status: "not_recorded" | "failed"; reason: string } {
  const sub = (input.subCode ?? "").trim();
  if (sub && NOT_RECORDED_SUB_CODES.includes(sub)) return { status: "not_recorded", reason: sub };
  const fatal = input.lastCode === "fatal";
  if (fatal && input.meetingStatus === "recording") return { status: "failed", reason: sub || "fatal" };
  return { status: "not_recorded", reason: sub || (fatal ? "fatal" : "no_recording") };
}
