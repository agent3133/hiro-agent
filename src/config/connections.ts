/**
 * The LLM connections in the agent's settings (`llm`, `llm_profiles`, `default_llm_profile`), resolved for a turn —
 * ported from config/loader.py (select_default_profile, ${VAR} references), config/presets.py and
 * providers/llamacpp.py (what a llama.cpp server says about its model, context window and thinking) (#86).
 *
 * A key is written as a reference to an entry in Obsidian's keychain, `${openai-api-key}`, and read from there only
 * (#147): a key written into the settings is ignored, and the environment is not read.
 */

import type { ProfileSummary } from "../api/types";
import { apiBase, detectServer, type GetJson, type ServerFacts, type ServerKind } from "./servers";

type Values = Record<string, unknown>;

export interface Connection {
  /** The profile's name; "" for the bare `llm` section. */
  name: string;
  /** As stored; since #149 nothing depends on it — the kind of server is found out (`server`). */
  provider: string;
  /** The kind of server found at `baseUrl`; undefined for an ordinary API. */
  server?: ServerKind;
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
 * The bare `llm` section as a named connection (#149, usability review): the settings show only named ones, so a
 * connection set up before profiles — one with an address or a key — becomes "local" or "cloud" (or "cloud-2" when
 * that is taken), the default when there is no valid default, and `llm` goes. Null when there is nothing to move.
 */
export function migrateBareLlm(values: Values): { values: Values; name: string } | null {
  const llm = section(values, "llm");
  if (!llm.base_url && !llm.api_key) return null;
  const profiles = section(values, "llm_profiles");
  const base = llm.provider === "llamacpp" ? "local" : "cloud";
  let name = base;
  for (let n = 2; name in profiles; n++) name = `${base}-${n}`;
  const next: Values = { ...values, llm_profiles: { ...profiles, [name]: { ...llm } } };
  delete next.llm;
  if (!defaultProfileName(values)) next.default_llm_profile = name;
  return { values: next, name };
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

/**
 * Whether connection *name*'s key is written out in the settings rather than named as `${KEY}` (#146). The plugin
 * never uses such a key — keys come only from the keychain — so the connection goes without one.
 */
export function writtenOutKey(values: Values, name: string): boolean {
  const raw = name ? section(section(values, "llm_profiles"), name) : section(values, "llm");
  return typeof raw.api_key === "string" && raw.api_key.trim() !== "" && !/^\$\{[^}]+\}$/.test(raw.api_key.trim());
}

/** What a turn says when there is no connection yet. */
export const NO_CONNECTION = "no connection is set up yet. Add one under Settings → Hiro Agent → Connections — "
  + "a model server running on this computer is found there — then send the message again.";

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
  // An address without a path is a server's root: the API is under /v1 (#149). None is OpenAI's own — except for
  // a connection stored as llama.cpp, which has no default address
  const address = typeof raw.base_url === "string" ? raw.base_url.trim() : "";
  const baseUrl = address ? apiBase(address) : provider === "llamacpp" ? "" : OPENAI_BASE_URL;
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

/** What detectConnection learnt about each address, and when; asked again after a while (a model may be swapped). */
export type ServerCache = Map<string, { facts: ServerFacts; at: number }>;
const REMEMBER_MS = 5 * 60_000;

/**
 * What the server says about itself, filled into *connection* (#149): which kind it is, the loaded model when none
 * is named, the context window, and thinking when it is not set. *get* is Obsidian's requestUrl in the plugin.
 */
export async function detectConnection(connection: Connection, get: GetJson, cache: ServerCache = new Map(),
                                       now = Date.now()): Promise<Connection> {
  if (!connection.baseUrl) return connection;
  const key = `${connection.baseUrl}\n${connection.model}`;
  let facts = cache.get(key);
  if (!facts || now - facts.at > REMEMBER_MS) {
    facts = { facts: await detectServer(connection.baseUrl, get, connection.model), at: now };
    cache.set(key, facts);
  }
  const found = facts.facts;
  if (!found.kind) return connection;
  return {
    ...connection,
    server: found.kind,
    model: connection.model || found.models[0] || "",
    contextWindow: found.contextWindow ?? connection.contextWindow,
    enableThinking: connection.enableThinking ?? (found.thinking ? true : undefined),
  };
}
