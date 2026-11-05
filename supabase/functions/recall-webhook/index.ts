import { runInBackground } from "../_shared/http.ts";
import { pipelineDeps } from "../_shared/pipeline-runtime.ts";
import { extractBotId, handleRecallEvent, isHandledEvent } from "../_shared/recall-pipeline.ts";
import { verifyRecallSignature } from "../_shared/recall-signature.ts";

// Avisos de Recall.ai (configurar en el panel de Recall > Webhooks apuntando a
// https://<proyecto>.supabase.co/functions/v1/recall-webhook).
//
// Responde 200 de inmediato y procesa en segundo plano: si tarda, Recall da el
// aviso por perdido y lo reintenta. Toda la lógica vive en
// _shared/recall-pipeline.ts (con pruebas):
//   - cada aviso se reclama con una clave única en pipeline_events, así un
//     reintento o una entrega doble no reprocesa;
//   - una sola petición de transcripción por grabación;
//   - la transcripción se guarda en un lote, sin duplicar turnos;
//   - el resumen lo hace analyze-meeting, una vez, con la transcripción completa.
// Lo que falle queda en pipeline_events con su error; el barrido de
// auto-record-scheduler lo reintenta.

function ok(body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const rawBody = await req.text();

  // Firma de Recall: sin secreto configurado se rechaza todo, salvo que se
  // permita explícitamente (solo para probar).
  const signature = await verifyRecallSignature(req.headers, rawBody, Deno.env.get("RECALL_WEBHOOK_SECRET"));
  if (signature === "invalid") return new Response("Invalid signature", { status: 401 });
  if (signature === "unconfigured" && Deno.env.get("ALLOW_UNSIGNED_WEBHOOKS") !== "true") {
    console.error("recall-webhook: falta RECALL_WEBHOOK_SECRET; aviso rechazado");
    return new Response("Webhook secret not configured", { status: 503 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  // deno-lint-ignore no-explicit-any
  const event = (payload as any)?.event;
  if (!isHandledEvent(event)) return ok({ received: true, handled: false });

  const botId = extractBotId(payload);
  console.log(`Aviso de Recall: ${event} bot=${botId ?? "?"}`);
  runInBackground(
    (async () => {
      const result = await handleRecallEvent(pipelineDeps(), payload);
      console.log(`Aviso ${event} bot=${botId ?? "?"} => ${result.outcome}`, result.detail ?? "");
    })(),
  );
  return ok({ received: true, handled: true });
});
