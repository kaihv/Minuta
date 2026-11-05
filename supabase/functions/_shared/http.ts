// Utilidades de red compartidas por las funciones.
//
// - fetchWithTimeout: ningún fetch de la tubería puede quedarse colgado.
// - runInBackground: responde al cliente y sigue trabajando (EdgeRuntime.waitUntil).

export class TimeoutError extends Error {
  constructor(public url: string, public ms: number) {
    super(`Timeout de ${ms} ms llamando a ${url}`);
    this.name = "TimeoutError";
  }
}

/** fetch con límite de tiempo. Lanza TimeoutError si se pasa. */
export async function fetchWithTimeout(
  input: string | URL,
  init: RequestInit = {},
  timeoutMs = 15_000,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(input, { ...init, signal: controller.signal });
  } catch (err) {
    if (controller.signal.aborted) throw new TimeoutError(String(input).split("?")[0], timeoutMs);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Deja una promesa corriendo después de responder. En Supabase Edge usa
 * EdgeRuntime.waitUntil; fuera (pruebas, deno run) simplemente la deja correr.
 */
export function runInBackground(task: Promise<unknown>): Promise<unknown> {
  const guarded = task.catch((err) => {
    console.error("Tarea en segundo plano falló:", err);
  });
  // deno-lint-ignore no-explicit-any
  const rt = (globalThis as any).EdgeRuntime;
  if (rt?.waitUntil) rt.waitUntil(guarded);
  return guarded;
}

export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

/** Respuesta al preflight CORS, o null si no es OPTIONS. */
export function preflight(req: Request): Response | null {
  return req.method === "OPTIONS" ? new Response(null, { headers: corsHeaders }) : null;
}
