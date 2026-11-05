import type { Meeting, MeetingStatus, Turn } from "./api";

export function clock(ms: number): string {
  const total = Math.max(0, Math.floor((ms || 0) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

const dayFmt = new Intl.DateTimeFormat("es-CL", { weekday: "short", day: "numeric", month: "short" });
const timeFmt = new Intl.DateTimeFormat("es-CL", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const dueFmt = new Intl.DateTimeFormat("es-CL", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });

export function when(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return `${dayFmt.format(d)}, ${timeFmt.format(d)}`;
}

/** Fecha de un compromiso (AAAA-MM-DD) en palabras: "jue, 6 nov". */
export function dueDate(ymd: string | null): string {
  if (!ymd || !/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return "Sin fecha";
  return dueFmt.format(new Date(`${ymd}T12:00:00Z`));
}

export function hour(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  return isNaN(d.getTime()) ? "" : timeFmt.format(d);
}

export const STATUS_LABEL: Record<MeetingStatus, string> = {
  scheduled: "Agendada",
  recording: "Grabando",
  processing: "Procesando",
  completed: "Lista",
  failed: "Falló",
  not_recorded: "No se grabó",
};

export const IN_PROGRESS: MeetingStatus[] = ["scheduled", "recording", "processing"];

/** Explicación en palabras simples de por qué no se grabó. */
export function notRecordedText(reason: string | null): string {
  const r = (reason ?? "").split(":")[0];
  const map: Record<string, string> = {
    noone_joined: "Nadie se conectó a la llamada.",
    timeout_exceeded_noone_joined: "Nadie se conectó a la llamada.",
    waiting_room_timeout: "Nadie dejó entrar al bot desde la sala de espera.",
    timeout_exceeded_waiting_room: "Nadie dejó entrar al bot desde la sala de espera.",
    denied_by_host: "El anfitrión rechazó al bot.",
    kicked: "Sacaron al bot de la llamada.",
    bot_kicked_from_call: "Sacaron al bot de la llamada.",
    call_ended_by_host: "La llamada terminó antes de empezar a grabar.",
    everyone_left: "Todos se fueron antes de empezar a grabar.",
    bot_create_failed: "No se pudo mandar el bot (revisa la configuración de Recall).",
    bot_not_found: "El bot ya no existe en Recall.",
    cancelled_by_user: "Cancelaste el bot.",
    "sweep": "El bot nunca llegó a la reunión.",
  };
  return map[r] ?? "La reunión terminó sin grabación.";
}

/** Transcripción como texto plano, para descargar o copiar. */
export function transcriptText(meeting: Pick<Meeting, "title" | "scheduled_at" | "created_at">, turns: Turn[]): string {
  const head = `${meeting.title}\n${when(meeting.scheduled_at ?? meeting.created_at)}\n\n`;
  return head + turns.map((t) => `[${clock(t.start_time_ms)}] ${t.speaker_name || "Participante"}: ${t.content}`).join("\n");
}

/** Agrupa turnos seguidos del mismo hablante (se lee mejor). */
export function groupTurns(turns: Turn[], maxGapMs = 15_000): Array<{ speaker: string; start: number; parts: string[] }> {
  const out: Array<{ speaker: string; start: number; parts: string[]; last: number }> = [];
  for (const t of turns) {
    const speaker = t.speaker_name || "Participante";
    const prev = out[out.length - 1];
    if (prev && prev.speaker === speaker && t.start_time_ms - prev.last <= maxGapMs) {
      prev.parts.push(t.content);
      prev.last = t.start_time_ms;
    } else {
      out.push({ speaker, start: t.start_time_ms, parts: [t.content], last: t.start_time_ms });
    }
  }
  return out.map(({ speaker, start, parts }) => ({ speaker, start, parts }));
}

/** Extensión permitida por la función transcribe-audio según el tipo del archivo. */
export function audioExtension(mime: string, fileName = ""): string | null {
  const m = mime.toLowerCase();
  const ext = fileName.toLowerCase().split(".").pop() ?? "";
  if (m.includes("webm") || ext === "webm") return "webm";
  if (m.includes("ogg") || ext === "ogg") return "ogg";
  if (m.includes("wav") || ext === "wav") return "wav";
  if (m.includes("mpeg") || m.includes("mp3") || ext === "mp3") return "mp3";
  if (m.includes("m4a") || ext === "m4a") return "m4a";
  if (m.includes("mp4") || m.includes("aac") || ext === "mp4") return "mp4";
  return null;
}
