import { supabase } from "./supabase";

/** Llama a una función de Supabase con la sesión actual. Lanza con el mensaje del servidor. */
export async function callFn<T = Record<string, unknown>>(name: string, body: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await supabase.functions.invoke(name, { body });
  if (error) {
    let message = error.message;
    try {
      const ctx = (error as { context?: Response }).context;
      const parsed = ctx ? await ctx.json() : null;
      if (parsed?.error) message = parsed.error;
    } catch {
      /* sin cuerpo legible */
    }
    throw new Error(message);
  }
  return data as T;
}

export interface ActionItem {
  task: string;
  assignee: string | null;
  due_date: string | null;
}

export interface Summary {
  executive_summary: string;
  action_items: ActionItem[];
  decisions: string[];
  topics: string[];
}

export type MeetingStatus = "scheduled" | "recording" | "processing" | "completed" | "failed" | "not_recorded";

export interface Meeting {
  id: string;
  user_id: string;
  title: string;
  meeting_url: string | null;
  meeting_type: "virtual" | "presencial";
  status: MeetingStatus;
  scheduled_at: string | null;
  created_at: string;
  duration_minutes: number | null;
  recall_bot_id: string | null;
  recording_url: string | null;
  not_recorded_reason: string | null;
  pipeline_error: string | null;
  attendees: Array<{ email?: string; name?: string | null }> | null;
  summary: Summary | null;
  summary_status: "running" | "done" | "failed" | "disabled" | "empty" | null;
  summary_error: string | null;
  auto_record: boolean;
}

export const MEETING_COLUMNS =
  "id, user_id, title, meeting_url, meeting_type, status, scheduled_at, created_at, duration_minutes, recall_bot_id, recording_url, not_recorded_reason, pipeline_error, attendees, summary, summary_status, summary_error, auto_record";

export interface Turn {
  id: string;
  speaker_name: string | null;
  content: string;
  start_time_ms: number;
}

/** Toda la transcripción, paginando de a 1.000 (límite de la API). */
export async function fetchTranscript(meetingId: string): Promise<Turn[]> {
  const rows: Turn[] = [];
  for (let from = 0; from < 20_000; from += 1000) {
    const { data, error } = await supabase
      .from("transcriptions")
      .select("id, speaker_name, content, start_time_ms")
      .eq("meeting_id", meetingId)
      .order("start_time_ms", { ascending: true })
      .order("id", { ascending: true })
      .range(from, from + 999);
    if (error) throw error;
    rows.push(...(data as Turn[]));
    if (!data || data.length < 1000) break;
  }
  return rows;
}

export interface AppInfo {
  ai: { provider: string; model: string } | null;
  recall: boolean;
  googleCalendar: boolean;
  inPerson: boolean;
  outgoingWebhook: boolean;
}
