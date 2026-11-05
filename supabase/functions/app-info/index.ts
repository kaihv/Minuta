import { gateUser } from "../_shared/auth.ts";
import { aiConfigFromEnv } from "../_shared/ai.ts";
import { jsonResponse, preflight } from "../_shared/http.ts";

// Qué está encendido en esta instalación, para que la app muestre solo lo que
// funciona. No devuelve ninguna llave.

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  const gate = await gateUser(req);
  if (gate.response) return gate.response;
  const ai = aiConfigFromEnv();
  return jsonResponse({
    ai: ai ? { provider: ai.provider, model: ai.model } : null,
    recall: !!Deno.env.get("RECALL_API_KEY"),
    googleCalendar: !!Deno.env.get("GOOGLE_CLIENT_ID") && !!Deno.env.get("GOOGLE_CLIENT_SECRET"),
    inPerson: !!Deno.env.get("DEEPGRAM_API_KEY"),
    outgoingWebhook: !!Deno.env.get("OUTGOING_WEBHOOK_URL"),
  });
});
