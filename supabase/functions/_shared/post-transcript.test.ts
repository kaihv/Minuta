// Correr: deno test --allow-env supabase/functions/_shared/post-transcript.test.ts
//
// El gancho previo al análisis se intenta una vez por corrida y no puede
// frenar ni cambiar el resultado de la tubería.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { memoryEventStore } from "./pipeline-events.ts";
import {
  ANALYSIS_TIMEOUT_MS,
  type CallResult,
  BEFORE_ANALYSIS_TIMEOUT_MS,
  httpPostTranscriptDeps,
  type PostTranscriptDeps,
  runPostTranscript,
} from "./post-transcript.ts";

const okAnalysis: CallResult = { ok: true, status: 200, body: { run_id: "r1", status: "evaluada", summary: "ok" } };

function world(over: Partial<PostTranscriptDeps> = {}) {
  const order: string[] = [];
  const deps: PostTranscriptDeps = {
    events: memoryEventStore(),
    beforeAnalysis: () => {
      order.push("before");
      return Promise.resolve({ ok: true, status: 200 });
    },
    analyze: () => {
      order.push("analyze");
      return Promise.resolve(okAnalysis);
    },
    integrate: () => {
      order.push("integrate");
      return Promise.resolve(null);
    },
    ...over,
  };
  return { deps, order };
}

Deno.test("el gancho previo se pide una vez y antes del análisis", async () => {
  const w = world();
  const r = await runPostTranscript(w.deps, "m1");
  assertEquals(r.outcome, "analyzed");
  assertEquals(w.order, ["before", "analyze", "integrate"]);
});

Deno.test("si el gancho previo falla, el análisis y las integraciones corren igual", async () => {
  for (const beforeAnalysis of [
    () => Promise.reject(new Error("Timeout de 25000 ms llamando al gancho")),
    () => {
      throw new Error("síncrono");
    },
    () => Promise.resolve({ ok: false, status: 502, error: "hub caído" }),
    () => Promise.resolve({ ok: false, status: 404 }),
    () => Promise.resolve(undefined),
  ] as PostTranscriptDeps["beforeAnalysis"][]) {
    const order: string[] = [];
    const w = world({
      beforeAnalysis,
      analyze: () => {
        order.push("analyze");
        return Promise.resolve(okAnalysis);
      },
      integrate: () => {
        order.push("integrate");
        return Promise.resolve(null);
      },
    });
    const r = await runPostTranscript(w.deps, "m1");
    assertEquals(r.outcome, "analyzed");
    assertEquals(order, ["analyze", "integrate"]);
  }
});

Deno.test("una entrega repetida no vuelve a consultar el CRM", async () => {
  const w = world();
  assertEquals((await runPostTranscript(w.deps, "m1")).outcome, "analyzed");
  assertEquals((await runPostTranscript(w.deps, "m1")).outcome, "already_done");
  assertEquals(w.order, ["before", "analyze", "integrate"]);
});

Deno.test("un contexto exitoso no tapa un análisis fallido", async () => {
  const w = world({ analyze: () => Promise.resolve({ ok: false, status: 500, error: "modelo caído" }) });
  const r = await runPostTranscript(w.deps, "m1");
  assertEquals(r.outcome, "analysis_failed");
  assertEquals(w.order, ["before"]);
});

Deno.test("sin el paso del contexto, la tubería se comporta como antes", async () => {
  const w = world({ beforeAnalysis: undefined });
  assertEquals((await runPostTranscript(w.deps, "m1")).outcome, "analyzed");
  assertEquals(w.order, ["analyze", "integrate"]);
});

Deno.test("una corrida viva no se da por muerta mientras duran el contexto y el análisis", async () => {
  // Mientras la primera corrida espera el análisis, llega otro intento (el
  // barrido). Antes de contexto + análisis + 60 s debe ver "in_progress";
  // pasado ese límite la puede retomar.
  const T0 = Date.parse("2026-10-07T12:00:00Z");
  const budget = BEFORE_ANALYSIS_TIMEOUT_MS + ANALYSIS_TIMEOUT_MS;
  assert(BEFORE_ANALYSIS_TIMEOUT_MS > 0 && BEFORE_ANALYSIS_TIMEOUT_MS < ANALYSIS_TIMEOUT_MS);
  const events = memoryEventStore();
  const seen: Record<string, string> = {};
  let nested = false;
  const quiet = { events, analyze: () => Promise.resolve(okAnalysis), integrate: () => Promise.resolve(null) };
  const first: PostTranscriptDeps = {
    events,
    now: () => new Date(T0),
    beforeAnalysis: () => Promise.resolve(null),
    analyze: async () => {
      if (!nested) {
        nested = true;
        seen.antes = (await runPostTranscript({ ...quiet, now: () => new Date(T0 + budget + 59_000) }, "m1")).outcome;
        seen.despues = (await runPostTranscript({ ...quiet, now: () => new Date(T0 + budget + 61_000) }, "m1")).outcome;
      }
      return okAnalysis;
    },
    integrate: () => Promise.resolve(null),
  };
  await runPostTranscript(first, "m1");
  assertEquals(seen.antes, "in_progress");
  assertEquals(seen.despues, "analyzed");
});

// ── Dependencias reales (HTTP entre funciones), con fetch simulado ─────────

type Handler = (fn: string, body: unknown) => Response | Promise<Response>;

function fakeFetch(handler: Handler) {
  const calls: { fn: string; body: unknown; auth: string | null }[] = [];
  const impl = ((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const fn = url.split("/functions/v1/")[1] ?? url;
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ fn, body, auth: new Headers(init?.headers).get("Authorization") });
    try {
      return Promise.resolve(handler(fn, body));
    } catch (e) {
      return Promise.reject(e);
    }
  }) as typeof fetch;
  return { impl, calls };
}

const jsonRes = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function httpDeps(handler: Handler) {
  const f = fakeFetch(handler);
  const deps = httpPostTranscriptDeps({
    supabaseUrl: "https://demo.supabase.co",
    serviceRoleKey: "llave-de-servicio-de-prueba",
    events: memoryEventStore(),
    fetchImpl: f.impl,
  });
  return { deps, calls: f.calls };
}

Deno.test("http: llama a analyze-meeting con la llave de servicio y después a send-webhook", async () => {
  const { deps, calls } = httpDeps((fn) =>
    fn === "analyze-meeting" ? jsonRes({ success: true, summary_status: "done" }) : jsonRes({ success: true })
  );
  const r = await runPostTranscript(deps, "m1");
  assertEquals(r.outcome, "analyzed");
  assertEquals(calls[0], { fn: "analyze-meeting", body: { meetingId: "m1", source: "pipeline" }, auth: "Bearer llave-de-servicio-de-prueba" });
  assertEquals(calls.map((c) => c.fn), ["analyze-meeting", "send-webhook"]);
});

Deno.test("http: si analyze-meeting falla no se avisa afuera y queda para reintento", async () => {
  const { deps, calls } = httpDeps((fn) => (fn === "analyze-meeting" ? jsonRes({ error: "x" }, 500) : jsonRes({})));
  assertEquals((await runPostTranscript(deps, "m1")).outcome, "analysis_failed");
  assertEquals(calls.map((c) => c.fn), ["analyze-meeting"]);
});

Deno.test("http: send-webhook caído no cambia el resultado", async () => {
  const { deps } = httpDeps((fn) => {
    if (fn === "send-webhook") throw new TypeError("connection reset");
    return jsonRes({ success: true });
  });
  assertEquals((await runPostTranscript(deps, "m1")).outcome, "analyzed");
});
