// Límites diarios por persona, para que nadie con cuenta pueda gastar sin tope
// los créditos de Recall o de la IA. Se ajustan en Ajustes (admin):
//   bot_settings.daily_bot_limit  bots mandados a mano en 24 h
//   bot_settings.daily_ai_limit   preguntas al chat + "volver a resumir" en 24 h
// La grabación automática del calendario y el resumen automático no cuentan.

// deno-lint-ignore no-explicit-any
type Db = any;

export const AI_MANUAL_SERVICES = ["ai_chat", "ai_summary_manual"];

export function isOver(used: number, limit: number | null | undefined): boolean {
  const l = typeof limit === "number" && limit >= 0 ? limit : 0;
  return used >= l;
}

const since = () => new Date(Date.now() - 24 * 3600_000).toISOString();

export async function botQuota(db: Db, userId: string): Promise<{ over: boolean; limit: number }> {
  const [{ data: s }, { count }] = await Promise.all([
    db.from("bot_settings").select("daily_bot_limit").eq("id", 1).maybeSingle(),
    db.from("meetings").select("id", { count: "exact", head: true })
      .eq("user_id", userId).eq("meeting_type", "virtual").eq("auto_record", false).gte("created_at", since()),
  ]);
  const limit = s?.daily_bot_limit ?? 15;
  return { over: isOver(count ?? 0, limit), limit };
}

export async function aiQuota(db: Db, userId: string): Promise<{ over: boolean; limit: number }> {
  const [{ data: s }, { count }] = await Promise.all([
    db.from("bot_settings").select("daily_ai_limit").eq("id", 1).maybeSingle(),
    db.from("usage_records").select("id", { count: "exact", head: true })
      .eq("user_id", userId).in("service", AI_MANUAL_SERVICES).gte("created_at", since()),
  ]);
  const limit = s?.daily_ai_limit ?? 60;
  return { over: isOver(count ?? 0, limit), limit };
}
