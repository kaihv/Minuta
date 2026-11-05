// Implementación de PipelineDb sobre supabase-js (cliente de servicio).
//
// Las columnas nuevas de `meetings` (migración 20261007090000_pipeline_v2.sql)
// pueden no existir todavía: si PostgREST las rechaza, se reintenta sin ellas.
// Así el código se puede desplegar antes o después que la migración.

import { isMissingColumnError } from "./calendar-filter.ts";
import type { MeetingStatus } from "./meeting-status.ts";
import type { MeetingRow, PipelineDb } from "./recall-pipeline.ts";
import { countTranscript, markTranscriptComplete, writeTranscript } from "./transcript.ts";

// deno-lint-ignore no-explicit-any
type SupabaseLike = any;

export const NEW_MEETING_COLUMNS = [
  "not_recorded_reason",
  "pipeline_error",
  "transcript_completed_at",
  "transcript_segments",
];

const BASE_COLUMNS = "id, user_id, status, meeting_url, recall_bot_id, recording_url, duration_minutes";
const FULL_COLUMNS = `${BASE_COLUMNS}, transcript_completed_at`;

const missingColumn = isMissingColumnError;

export function withoutNewColumns(patch: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(patch).filter(([k]) => !NEW_MEETING_COLUMNS.includes(k)));
}

export function supabasePipelineDb(supabase: SupabaseLike): PipelineDb {
  let newColumns = true; // se apaga al primer rechazo y no se vuelve a probar en esta instancia

  // deno-lint-ignore no-explicit-any
  async function selectMeeting(build: (cols: string) => any): Promise<MeetingRow | null> {
    if (newColumns) {
      const { data, error } = await build(FULL_COLUMNS);
      if (!error) return (data as MeetingRow) ?? null;
      if (!missingColumn(error)) throw new Error(`meetings: ${error.message ?? error.code}`);
      newColumns = false;
    }
    const { data, error } = await build(BASE_COLUMNS);
    if (error) throw new Error(`meetings: ${error.message ?? error.code}`);
    return (data as MeetingRow) ?? null;
  }

  // deno-lint-ignore no-explicit-any
  async function update(patch: Record<string, unknown>, apply: (q: any) => any): Promise<any[]> {
    const attempt = async (p: Record<string, unknown>) =>
      await apply(supabase.from("meetings").update({ ...p, updated_at: new Date().toISOString() })).select("id");
    let res = await attempt(newColumns ? patch : withoutNewColumns(patch));
    if (res.error && missingColumn(res.error)) {
      newColumns = false;
      const slim = withoutNewColumns(patch);
      if (Object.keys(slim).length === 0) return [];
      res = await attempt(slim);
    }
    if (res.error) throw new Error(`meetings update: ${res.error.message ?? res.error.code}`);
    return res.data ?? [];
  }

  return {
    findMeetingByBot: (botId) =>
      selectMeeting((cols) => supabase.from("meetings").select(cols).eq("recall_bot_id", botId).limit(1).maybeSingle()),

    findUnlinkedByUrl: (fragment, sinceIso) =>
      selectMeeting((cols) =>
        supabase
          .from("meetings")
          .select(cols)
          .ilike("meeting_url", `%${fragment.replace(/[%_]/g, "")}%`)
          .is("recall_bot_id", null)
          .gte("created_at", sinceIso)
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle()
      ),

    async linkBot(meetingId, botId) {
      const rows = await update({ recall_bot_id: botId }, (q) => q.eq("id", meetingId).is("recall_bot_id", null));
      return rows.length > 0;
    },

    getMeeting: (meetingId) =>
      selectMeeting((cols) => supabase.from("meetings").select(cols).eq("id", meetingId).maybeSingle()),

    async advanceStatus(meetingId, to: MeetingStatus, from: MeetingStatus[], extra = {}) {
      if (from.length === 0) return false;
      const rows = await update({ status: to, ...extra }, (q) => q.eq("id", meetingId).in("status", from));
      return rows.length > 0;
    },

    async updateMeeting(meetingId, patch) {
      await update(patch, (q) => q.eq("id", meetingId));
    },

    async recordUsage(row) {
      const isBot = row.service === "recall";
      const column = isBot ? "recall_bot_seconds" : "transcription_seconds";
      const { data: existing } = await supabase
        .from("usage_records")
        .select("id")
        .eq("meeting_id", row.meeting_id)
        .gt(column, 0)
        .limit(1);
      if (Array.isArray(existing) && existing.length > 0) return;
      const { error } = await supabase.from("usage_records").insert({
        user_id: row.user_id,
        meeting_id: row.meeting_id,
        service: row.service,
        period_month: new Date().toISOString().slice(0, 7),
        ...(isBot
          ? { recall_bot_seconds: row.seconds, recall_cost_usd: row.cost_usd }
          : { transcription_seconds: row.seconds, transcription_cost_usd: row.cost_usd }),
      });
      // 23505: otro proceso lo registró en el intertanto (índice único parcial).
      if (error && error.code !== "23505") console.error("No se pudo registrar el uso:", error.message);
    },

    countTranscript: (meetingId) => countTranscript(supabase, meetingId),
    writeTranscript: (meetingId, turns) => writeTranscript(supabase, meetingId, turns),
    markTranscriptComplete: (meetingId, segments) => markTranscriptComplete(supabase, meetingId, segments),
  };
}
