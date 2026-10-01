/**
 * Which kind of server answers at an address, and what it says about itself (#149). Every server the plugin talks
 * to speaks the same OpenAI-compatible API (`/v1/chat/completions`), so a connection names no kind: the kind only
 * decides how the plugin learns the loaded model and the context window, and that is found out by asking.
 *
 * - llama.cpp: `/props` (`default_generation_settings.n_ctx`, and whether the template can think)
 * - vLLM: `max_model_len` in `/v1/models` (its entries are `owned_by: "vllm"`)
 * - Ollama: `/api/version`; the loaded model's `context_length` in `/api/ps`. A model not loaded yet gets Ollama's
 *   usual default, a small window: too small only summarises early, too large would overflow.
 * - LM Studio: `/api/v0/models`, `loaded_context_length` or, before loading, at most its usual default
 *
 * Nothing answering those is an ordinary API; its context window is the configured one.
 */

export type ServerKind = "llama.cpp" | "vLLM" | "Ollama" | "LM Studio";

export interface ServerFacts {
  kind?: ServerKind;
  /** The models `/v1/models` lists, in its order. */
  models: string[];
  contextWindow?: number;
  /** Whether the chat template can think (llama.cpp only). */
  thinking?: boolean;
}

/** GET a URL's JSON; throws, or returns null, when nothing usable answers. */
export type GetJson = (url: string) => Promise<unknown>;

const OPENAI_API = "https://api.openai.com/v1";
/** What Ollama and LM Studio load a model with unless told otherwise. */
const SMALL_DEFAULT = 4096;

/** The API's base: the address as given, with `/v1` added when it has no path at all (`http://host:port`). */
export function apiBase(address: string): string {
  const trimmed = address.trim().replace(/\/+$/, "");
  if (!trimmed) return OPENAI_API;
  return /^https?:\/\/[^/]+$/i.test(trimmed) ? `${trimmed}/v1` : trimmed;
}

/** The server's root, where llama.cpp, Ollama and LM Studio keep their own endpoints. */
export function serverRoot(address: string): string {
  return apiBase(address).replace(/\/v1$/, "");
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function list(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(record) : [];
}

function positive(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

async function tryGet(get: GetJson, url: string): Promise<unknown> {
  try {
    return await get(url);
  } catch {
    return null;
  }
}

/** What the server at *address* is and says, for *model* (the configured one; "" for the server's own). */
export async function detectServer(address: string, get: GetJson, model = ""): Promise<ServerFacts> {
  const base = apiBase(address);
  if (base === OPENAI_API) return { models: [] };
  const root = serverRoot(address);
  const listed = list(record(await tryGet(get, `${base}/models`)).data);
  const models = listed.map((entry) => entry.id).filter((id): id is string => typeof id === "string");
  const chosen = model || models[0] || "";

  if (listed.some((entry) => entry.owned_by === "vllm")) {
    const entry = listed.find((item) => item.id === chosen) ?? listed[0];
    return { kind: "vLLM", models, contextWindow: positive(entry?.max_model_len) };
  }

  const props = record(await tryGet(get, `${root}/props`));
  if (props.default_generation_settings !== undefined) {
    const settings = record(props.default_generation_settings);
    return { kind: "llama.cpp", models,
             contextWindow: positive(settings.n_ctx) ?? positive(record(settings.params).n_ctx),
             thinking: Boolean(record(props.chat_template_caps).supports_preserve_reasoning) };
  }

  if (typeof record(await tryGet(get, `${root}/api/version`)).version === "string") {
    const loaded = list(record(await tryGet(get, `${root}/api/ps`)).models)
      .find((entry) => entry.name === chosen || entry.model === chosen);
    return { kind: "Ollama", models, contextWindow: positive(loaded?.context_length) ?? SMALL_DEFAULT };
  }

  const studio = list(record(await tryGet(get, `${root}/api/v0/models`)).data);
  if (studio.some((entry) => entry.max_context_length !== undefined)) {
    const entry = studio.find((item) => item.id === chosen) ?? studio.find((item) => item.state === "loaded");
    const loaded = positive(entry?.loaded_context_length);
    const most = positive(entry?.max_context_length);
    return { kind: "LM Studio", models,
             contextWindow: loaded ?? (most ? Math.min(most, SMALL_DEFAULT) : SMALL_DEFAULT) };
  }

  return { models };
}
