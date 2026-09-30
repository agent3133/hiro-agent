/**
 * The LLM connections in the agent's settings (`llm`, `llm_profiles`, `default_llm_profile`), resolved for a turn —
 * ported from config/loader.py (select_default_profile, ${VAR} references), config/presets.py and
 * providers/llamacpp.py (what a llama.cpp server says about its model, context window and thinking) (#86).
 *
 * A key is written as a reference, `${OPENAI_API_KEY}`, and resolved through the keychain bindings in the plugin's
 * Secrets settings — only there: a key written into the settings is ignored, and the environment is not read.
 */

import type { ProfileSummary } from "../api/types";

type Values = Record<string, unknown>;

export interface Connection {
  /** The profile's name; "" for the bare `llm` section. */
  name: string;
  provider: string;
  baseUrl: string;
  model: string;
  apiKey?: string;
  temperature: number;
  topP?: number;
  topK?: number;
  minP?: number;
  presencePenalty?: number;
  repetitionPenalty?: number;
  maxTokens?: number;
  enableThinking?: boolean;
  contextWindow: number;
}

/** Named sets of sampling values — `SAMPLING_PRESETS`. A preset fills only what is not set explicitly. */
export const SAMPLING_PRESETS: Record<string, Record<string, number>> = {
  "thinking-general": { temperature: 1.0, top_p: 0.95, top_k: 20, min_p: 0.0, presence_penalty: 1.5, repetition_penalty: 1.0 },
  "thinking-coding": { temperature: 0.6, top_p: 0.95, top_k: 20, min_p: 0.0, presence_penalty: 0.0, repetition_penalty: 1.0 },
  "instruct-general": { temperature: 0.7, top_p: 0.8, top_k: 20, min_p: 0.0, presence_penalty: 1.5, repetition_penalty: 1.0 },
  "instruct-reasoning": { temperature: 1.0, top_p: 1.0, top_k: 40, min_p: 0.0, presence_penalty: 2.0, repetition_penalty: 1.0 },
};

const OPENAI_BASE_URL = "https://api.openai.com/v1";

function section(values: Values, key: string): Values {
  const value = values[key];
  return value && typeof value === "object" && !Array.isArray(value) ? value as Values : {};
}

/** The connections the chat header offers — `profile_summaries`. */
export function profileSummaries(values: Values): ProfileSummary[] {
  const profiles = section(values, "llm_profiles");
  return Object.keys(profiles).sort().map((name) => {
    const profile = section(profiles, name);
    return { name, provider: String(profile.provider ?? "openai"), model: (profile.model as string) ?? null,
             base_url: (profile.base_url as string) ?? null, default: name === values.default_llm_profile };
  });
}

/**
 * Whether any connection is set up (#110): a named one, or an `llm` section with a server or a key. A new vault has
 * none, and the chat leads to setting one up instead of failing on the first message.
 */
export function hasConnection(values: Values): boolean {
  if (Object.keys(section(values, "llm_profiles")).length) return true;
  const llm = section(values, "llm");
  return Boolean(llm.base_url || llm.api_key);
}

/** What a turn says when there is no connection yet. */
export const NO_CONNECTION = "no connection is set up yet. Add one under Settings → Hiro Agent → General → "
  + "Connections — a llama.cpp server running on this computer is found there — then send the message again.";

/** The profile a turn uses when none is chosen: `default_llm_profile` when it exists, else the bare `llm` section. */
export function defaultProfileName(values: Values): string {
  const chosen = typeof values.default_llm_profile === "string" ? values.default_llm_profile : "";
  return chosen && chosen in section(values, "llm_profiles") ? chosen : "";
}

/** `${VAR}` replaced through *env* — `_interpolate_env_vars`; an unknown variable becomes empty, as in Python. */
export function interpolate(text: string, env: (name: string) => string | undefined): string {
  return text.replace(/\$\{([^}]+)\}/g, (_whole, name: string) => env(name) ?? "");
}

export interface AgentOverrides {
  model?: string | null;
  temperature?: number | null;
  enableThinking?: boolean | null;
  samplingPreset?: string | null;
}

/**
 * The connection for a turn: *profile* (the chat's choice) or the agent's own, else the default — and the agent's
 * model, temperature, thinking and preset over the connection's (llm_config_for, runner.py).
 */
export function resolveConnection(values: Values, profile: string, env: (name: string) => string | undefined,
                                  agent: AgentOverrides = {}): Connection {
  const profiles = section(values, "llm_profiles");
  const name = profile || defaultProfileName(values);
  if (profile && !(profile in profiles)) {
    throw new Error(`unknown connection '${profile}' (there are: ${Object.keys(profiles).sort().join(", ") || "none"})`);
  }
  const raw: Values = { ...(name ? section(profiles, name) : section(values, "llm")) };
  if (agent.model) raw.model = agent.model;
  if (agent.temperature !== null && agent.temperature !== undefined) raw.temperature = agent.temperature;
  if (agent.enableThinking !== null && agent.enableThinking !== undefined) raw.enable_thinking = agent.enableThinking;
  if (agent.samplingPreset) raw.sampling_preset = agent.samplingPreset;
  const preset = typeof raw.sampling_preset === "string" ? SAMPLING_PRESETS[raw.sampling_preset] : undefined;
  if (preset) for (const [key, value] of Object.entries(preset)) if (raw[key] === undefined || raw[key] === null) raw[key] = value;

  const provider = String(raw.provider ?? "openai");
  const number = (key: string): number | undefined => (typeof raw[key] === "number" ? raw[key] as number : undefined);
  // Only a `${VAR}` reference is a key: it is read from the keychain. A key written out is never used, and there
  // is no fallback to the environment (Python's OpenAI client read OPENAI_API_KEY on its own; the plugin does not)
  const reference = typeof raw.api_key === "string" ? /^\$\{([^}]+)\}$/.exec(raw.api_key.trim()) : null;
  const key = reference ? env(reference[1]) ?? "" : "";
  const baseUrl = typeof raw.base_url === "string" && raw.base_url ? raw.base_url : provider === "openai" ? OPENAI_BASE_URL : "";
  return {
    name, provider, baseUrl,
    model: typeof raw.model === "string" && raw.model ? raw.model : "",  // no model name is assumed; a turn asks for one (#110)
    apiKey: key || undefined,
    temperature: number("temperature") ?? 0.7,
    topP: number("top_p"), topK: number("top_k"), minP: number("min_p"),
    presencePenalty: number("presence_penalty"), repetitionPenalty: number("repetition_penalty"),
    maxTokens: number("max_tokens"),
    enableThinking: typeof raw.enable_thinking === "boolean" ? raw.enable_thinking : undefined,
    contextWindow: number("context_window") ?? 128_000,
  };
}

/**
 * What a llama.cpp server says about itself, filled into *connection* — `resolve_llm_config`: the loaded model when
 * none is named, the context window, and thinking when it is not set. Remembered per server; *fetchJson* is
 * Obsidian's requestUrl in the plugin.
 */
export async function detectLlamaCpp(connection: Connection, fetchJson: (url: string) => Promise<unknown>,
                                     cache = new Map<string, { model?: string; contextWindow?: number; thinking?: boolean }>()): Promise<Connection> {
  if (connection.provider !== "llamacpp" || !connection.baseUrl) return connection;
  const base = connection.baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
  let found = cache.get(base);
  if (!found) {
    found = {};
    try {
      const models = await fetchJson(`${base}/v1/models`) as { data?: { id?: string }[] };
      found.model = models?.data?.[0]?.id;
    } catch { /* the model name is only a label for a llama.cpp server */ }
    try {
      const props = await fetchJson(`${base}/props`) as {
        default_generation_settings?: { n_ctx?: number }; chat_template_caps?: { supports_preserve_reasoning?: boolean };
      };
      found.contextWindow = props?.default_generation_settings?.n_ctx;
      found.thinking = Boolean(props?.chat_template_caps?.supports_preserve_reasoning);
    } catch { /* keep the configured context window */ }
    cache.set(base, found);
  }
  return {
    ...connection,
    model: connection.model || found.model || "llamacpp-model",
    contextWindow: found.contextWindow ?? connection.contextWindow,
    enableThinking: connection.enableThinking ?? (found.thinking ? true : undefined),
  };
}
