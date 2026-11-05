// Arma las dependencias reales de la tubería (base, Recall, Storage, análisis)
// a partir del entorno de la función. Lo usan recall-webhook, recall-bot y el
// barrido de auto-record-scheduler.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { supabaseEventStore } from "./pipeline-events.ts";
import { httpPostTranscriptDeps, runPostTranscript, type PostTranscriptDeps } from "./post-transcript.ts";
import type { PipelineDeps } from "./recall-pipeline.ts";
import { supabasePipelineDb } from "./recall-pipeline-db.ts";
import { recallClientFromEnv } from "./recall.ts";
import { storeRecording } from "./recording-storage.ts";

// deno-lint-ignore no-explicit-any
type SupabaseLike = any;

export function serviceClient(): SupabaseLike {
  return createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export function postTranscriptDeps(supabase: SupabaseLike): PostTranscriptDeps {
  return httpPostTranscriptDeps({
    supabaseUrl: Deno.env.get("SUPABASE_URL")!,
    serviceRoleKey: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    events: supabaseEventStore(supabase),
  });
}

export function pipelineDeps(supabase: SupabaseLike = serviceClient()): PipelineDeps {
  const post = postTranscriptDeps(supabase);
  return {
    db: supabasePipelineDb(supabase),
    events: post.events,
    recall: recallClientFromEnv(),
    storeVideo: (meeting, sourceUrl) =>
      storeRecording(supabase, { userId: meeting.user_id, meetingId: meeting.id, sourceUrl }),
    afterTranscript: (meetingId) => runPostTranscript(post, meetingId),
    log: (message, extra) => (extra === undefined ? console.log(message) : console.log(message, extra)),
  };
}
