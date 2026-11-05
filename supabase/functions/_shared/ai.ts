// IA opcional, con el proveedor que se elija. UN solo lugar para hablar con
// el modelo: el resto del código no sabe si es Gemini, OpenAI o Claude.
//
// Se configura con variables de entorno (secretos de Supabase):
//   AI_PROVIDER   none | gemini | openai | anthropic   (por defecto: none)
//   AI_API_KEY    la llave del proveedor elegido
//   AI_MODEL      opcional; si no se pone, se usa el de DEFAULT_MODELS (los
//                 nombres de modelos cambian seguido: conviene fijarlo)
//
// Sin IA (AI_PROVIDER=none o sin llave) la app igual graba y transcribe: solo
// no hay resumen ni chat con la reunión.

import { fetchWithTimeout } from "./http.ts";

export type AiProvider = "gemini" | "openai" | "anthropic";

export const DEFAULT_MODELS: Record<AiProvider, string> = {
  gemini: "gemini-2.5-flash",
  openai: "gpt-4.1-mini",
  anthropic: "claude-haiku-5-5",
};

export interface AiUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface AiClient {
  provider: AiProvider;
  model: string;
  /** Texto libre. */
  chat(opts: { system: string; messages: ChatMessage[]; maxTokens?: number; timeoutMs?: number }): Promise<{ text: string; usage: AiUsage }>;
  /** Respuesta en JSON (se pide al modelo y se valida que se pueda leer). */
  generateJson<T = unknown>(opts: {
    system: string;
    prompt: string;
    maxTokens?: number;
    timeoutMs?: number;
  }): Promise<{ data: T; text: string; usage: AiUsage }>;
}

export class AiError extends Error {
  constructor(message: string, public status = 0) {
    super(message);
    this.name = "AiError";
  }
}

/** Lee la config del entorno. null si la IA está apagada o falta la llave. */
export function aiConfigFromEnv(env: (k: string) => string | undefined = (k) => Deno.env.get(k)):
  | { provider: AiProvider; apiKey: string; model: string }
  | null {
  const provider = (env("AI_PROVIDER") ?? "none").trim().toLowerCase();
  const apiKey = (env("AI_API_KEY") ?? "").trim();
  if (!["gemini", "openai", "anthropic"].includes(provider) || !apiKey) return null;
  const p = provider as AiProvider;
  return { provider: p, apiKey, model: (env("AI_MODEL") ?? "").trim() || DEFAULT_MODELS[p] };
}

export function aiFromEnv(fetchImpl: typeof fetch = fetch): AiClient | null {
  const cfg = aiConfigFromEnv();
  return cfg ? aiClient({ ...cfg, fetchImpl }) : null;
}

/**
 * Saca el objeto JSON de la respuesta del modelo: acepta JSON puro, JSON
 * dentro de ```json ... ``` o con texto alrededor. Lanza si no hay JSON.
 */
export function parseJsonLoose<T = unknown>(text: string): T {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed) as T;
  } catch (_e) { /* sigue */ }
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    try {
      return JSON.parse(fenced[1].trim()) as T;
    } catch (_e) { /* sigue */ }
  }
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(trimmed.slice(start, end + 1)) as T;
    } catch (_e) { /* sigue */ }
  }
  throw new AiError("La IA no devolvió JSON válido");
}

const JSON_RULE = "\n\nResponde SOLO con un objeto JSON válido, sin texto antes ni después y sin bloques de código.";

export function aiClient(opts: { provider: AiProvider; apiKey: string; model: string; fetchImpl?: typeof fetch }): AiClient {
  const f = opts.fetchImpl ?? fetch;

  async function post(url: string, headers: Record<string, string>, body: unknown, timeoutMs: number) {
    const res = await fetchWithTimeout(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    }, timeoutMs, f);
    const text = await res.text();
    if (!res.ok) throw new AiError(`${opts.provider} respondió ${res.status}: ${text.slice(0, 300)}`, res.status);
    try {
      return JSON.parse(text);
    } catch (_e) {
      throw new AiError(`${opts.provider} devolvió algo que no es JSON`);
    }
  }

  async function complete(system: string, messages: ChatMessage[], maxTokens: number, timeoutMs: number, json: boolean) {
    if (opts.provider === "gemini") {
      const data = await post(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(opts.model)}:generateContent`,
        { "x-goog-api-key": opts.apiKey },
        {
          systemInstruction: { parts: [{ text: system }] },
          contents: messages.map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] })),
          generationConfig: {
            temperature: 0.2,
            maxOutputTokens: maxTokens,
            ...(json ? { responseMimeType: "application/json" } : {}),
          },
        },
        timeoutMs,
      );
      // deno-lint-ignore no-explicit-any
      const text = (data?.candidates?.[0]?.content?.parts ?? []).map((p: any) => p?.text ?? "").join("");
      const u = data?.usageMetadata ?? {};
      return { text, usage: { inputTokens: u.promptTokenCount ?? 0, outputTokens: u.candidatesTokenCount ?? 0 } };
    }
    if (opts.provider === "openai") {
      const data = await post(
        "https://api.openai.com/v1/chat/completions",
        { Authorization: `Bearer ${opts.apiKey}` },
        {
          model: opts.model,
          temperature: 0.2,
          max_tokens: maxTokens,
          messages: [{ role: "system", content: system }, ...messages],
          ...(json ? { response_format: { type: "json_object" } } : {}),
        },
        timeoutMs,
      );
      const u = data?.usage ?? {};
      return {
        text: String(data?.choices?.[0]?.message?.content ?? ""),
        usage: { inputTokens: u.prompt_tokens ?? 0, outputTokens: u.completion_tokens ?? 0 },
      };
    }
    // anthropic
    const data = await post(
      "https://api.anthropic.com/v1/messages",
      { "x-api-key": opts.apiKey, "anthropic-version": "2023-06-01" },
      // Sin temperature: los modelos Claude 5.x responden 400 si se manda (y desde 2026-10-21, todos).
      { model: opts.model, max_tokens: maxTokens, system, messages },
      timeoutMs,
    );
    if (data?.stop_reason === "refusal") throw new AiError("Claude declinó la solicitud (refusal)");
    // deno-lint-ignore no-explicit-any
    const text = (data?.content ?? []).filter((b: any) => b?.type === "text").map((b: any) => b.text).join("");
    const u = data?.usage ?? {};
    return { text, usage: { inputTokens: u.input_tokens ?? 0, outputTokens: u.output_tokens ?? 0 } };
  }

  return {
    provider: opts.provider,
    model: opts.model,
    async chat({ system, messages, maxTokens = 2_000, timeoutMs = 60_000 }) {
      const out = await complete(system, messages, maxTokens, timeoutMs, false);
      if (!out.text.trim()) throw new AiError("La IA devolvió una respuesta vacía");
      return out;
    },
    async generateJson<T>({ system, prompt, maxTokens = 8_000, timeoutMs = 90_000 }: {
      system: string;
      prompt: string;
      maxTokens?: number;
      timeoutMs?: number;
    }) {
      const out = await complete(system + JSON_RULE, [{ role: "user", content: prompt }], maxTokens, timeoutMs, true);
      return { data: parseJsonLoose<T>(out.text), text: out.text, usage: out.usage };
    },
  };
}
