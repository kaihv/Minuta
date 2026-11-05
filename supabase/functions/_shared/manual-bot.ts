// Mandar el bot "a mano" a una videollamada: lo usan la app (recall-bot) y el
// servidor MCP. Valida el enlace, aplica el tope diario, crea la reunión y pide
// el bot a Recall. Lanza ManualBotError con un mensaje listo para mostrar.

import { validMeetingUrl } from "./meeting-url.ts";
import { botQuota } from "./quota.ts";
import { buildBotRequest, joinMessageFromEnv, recallClientFromEnv } from "./recall.ts";

// deno-lint-ignore no-explicit-any
type Db = any;

export class ManualBotError extends Error {
  constructor(message: string, public status: number, public meetingId?: string) {
    super(message);
    this.name = "ManualBotError";
  }
}

export async function sendManualBot(db: Db, userId: string, rawUrl: unknown, rawTitle: unknown): Promise<{ meetingId: string; botId: string }> {
  const meetingUrl = validMeetingUrl(rawUrl);
  if (!meetingUrl) throw new ManualBotError("Pega el enlace completo de Google Meet, Zoom, Teams o Webex (https://...)", 400);
  const quota = await botQuota(db, userId);
  if (quota.over) {
    throw new ManualBotError(`Llegaste al máximo de ${quota.limit} bots manuales por día. Un admin puede subirlo en Ajustes.`, 429);
  }
  const title = typeof rawTitle === "string" && rawTitle.trim() ? rawTitle.trim().slice(0, 200) : "Reunión";

  const { data: meeting, error } = await db
    .from("meetings")
    .insert({
      user_id: userId,
      title,
      meeting_url: meetingUrl,
      meeting_type: "virtual",
      scheduled_at: new Date().toISOString(),
      status: "scheduled",
      auto_record: false,
    })
    .select("id")
    .single();
  if (error || !meeting) throw new Error(`No se pudo crear la reunión: ${error?.message ?? "sin fila"}`);

  const { data: botSettings } = await db.from("bot_settings").select("*").limit(1).maybeSingle();
  try {
    const bot = await recallClientFromEnv().createBot(
      buildBotRequest(meetingUrl, botSettings ?? undefined, { joinMessage: joinMessageFromEnv() }),
    );
    await db.from("meetings").update({ recall_bot_id: bot.id }).eq("id", meeting.id);
    return { meetingId: meeting.id, botId: bot.id };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("Recall no entregó bot:", message);
    await db
      .from("meetings")
      .update({ status: "failed", not_recorded_reason: `bot_create_failed: ${message}`.slice(0, 300) })
      .eq("id", meeting.id);
    throw new ManualBotError("Recall no pudo mandar el bot. Revisa RECALL_API_KEY y la región.", 502, meeting.id);
  }
}
