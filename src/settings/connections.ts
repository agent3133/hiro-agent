/** The pure half of the connections editor — no Obsidian in here, so it can be tested under Node. */

import { apiBase, detectServer, type GetJson, type ServerKind } from "../config/servers";

export type Profiles = Record<string, Record<string, unknown>>;

/** Whether a configured URL is this machine's server on *port*, however it was spelled. */
export function pointsAt(url: unknown, port: number): boolean {
  if (typeof url !== "string") return false;
  const match = url.match(/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\]):(\d+)/i);
  return match !== null && Number(match[2]) === port;
}

/** The first model id in an OpenAI-style `/models` answer. */
export function modelId(body: unknown): string {
  const data = (body as { data?: { id?: unknown }[] } | null)?.data;
  return Array.isArray(data) && typeof data[0]?.id === "string" ? data[0].id : "";
}

export function freeName(wanted: string, profiles: Profiles): string {
  if (!(wanted in profiles)) return wanted;
  let n = 2;
  while (`${wanted}-${n}` in profiles) n += 1;
  return `${wanted}-${n}`;
}

/**
 * Where local servers usually listen: llama-server's default and the port this project's docs use, then vLLM,
 * LM Studio and Ollama (#149).
 */
export const LOCAL_PORTS = [8080, 8090, 8000, 1234, 11434];

export interface ProbeAnswer {
  status: number;
  body: unknown;
}

/** GET through *probe*, as detectServer asks: the body of a 200, else null. */
export function getVia(probe: (url: string) => Promise<ProbeAnswer | null>): GetJson {
  return async (url) => {
    const answer = await probe(url);
    return answer && answer.status === 200 ? answer.body : null;
  };
}

/** A server answering on this machine that no connection points at yet, and the name it would get. */
export interface LocalServer {
  port: number;
  baseUrl: string;
  /** The first model it lists; "" when it lists none. */
  model: string;
  /** How many models it lists: with more than one, the connection names the first. */
  models: number;
  kind?: ServerKind;
  name: string;
}

/** The local servers that answer and that no connection in *profiles* points at yet. */
export async function findLocalServers(profiles: Profiles,
                                       probe: (url: string) => Promise<ProbeAnswer | null>): Promise<LocalServer[]> {
  const found: LocalServer[] = [];
  const taken: Profiles = { ...profiles };
  for (const port of LOCAL_PORTS) {
    if (Object.values(profiles).some((values) => pointsAt(values.base_url, port))) continue;
    const baseUrl = `http://127.0.0.1:${port}`;
    const answer = await probe(`${baseUrl}/v1/models`);
    if (!answer || answer.status !== 200) continue;
    const facts = await detectServer(baseUrl, getVia(probe));
    const name = freeName(found.length ? `local-${port}` : "local", taken);
    taken[name] = {};
    found.push({ port, baseUrl, model: facts.models[0] ?? modelId(answer.body), models: facts.models.length,
                 kind: facts.kind, name });
  }
  return found;
}

/** The settings change that adds *server* as a connection — the default one when there is no default yet. */
export function addLocalServer(server: LocalServer, defaultProfile: string): Record<string, unknown> {
  // A server with one model serves that one; with several (Ollama, LM Studio) the connection has to name one
  const values: Record<string, unknown> = { base_url: server.baseUrl };
  if (server.models > 1 && server.model) values.model = server.model;
  const change: Record<string, unknown> = { llm_profiles: { [server.name]: values } };
  if (!defaultProfile) change.default_llm_profile = server.name;
  return change;
}

/** How a found server is named to a person: "Ollama on 127.0.0.1:11434". */
export function serverLabel(server: Pick<LocalServer, "kind" | "port">): string {
  return `${server.kind ?? "A server"} on 127.0.0.1:${server.port}`;
}

/** A connection as the form edits it: the key is a keychain entry's name, "" for none. No kind: it is found out. */
export interface ConnectionDraft {
  name: string;
  baseUrl: string;
  model: string;
  key: string;
}

const OPENAI = "https://api.openai.com/v1";

/** The form's fields from a stored connection. */
export function draftOf(name: string, values: Record<string, unknown>): ConnectionDraft {
  const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");
  return {
    name,
    baseUrl: text(values.base_url),
    model: text(values.model),
    key: /^\$\{([^}]+)\}$/.exec(text(values.api_key))?.[1] ?? "",
  };
}

/** Why *draft* cannot be saved as it is, or null. *taken* holds the other connections' names. */
export function draftProblem(draft: ConnectionDraft, taken: string[]): string | null {
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(draft.name)) return "A name is letters, digits, dashes and underscores.";
  if (taken.includes(draft.name)) return `There is already a connection called ${draft.name}.`;
  if (draft.baseUrl && !/^https?:\/\/\S+$/i.test(draft.baseUrl)) return "The address starts with http:// or https://.";
  // OpenAI itself serves many models and says none is the default; a server of your own says which it runs
  if (!draft.baseUrl && !draft.model) return "Name the model, e.g. gpt-4o-mini.";
  return null;
}

/**
 * The settings change that stores *draft*; empty fields are removed, so defaults apply. A stored `provider` goes
 * too: since #149 the kind of server is found out, and a stale one would only mislead.
 */
export function draftChange(draft: ConnectionDraft, previousName: string | null, defaultName: string): Record<string, unknown> {
  const profiles: Record<string, unknown> = {
    [draft.name]: { provider: null, base_url: draft.baseUrl || null, model: draft.model || null,
                    api_key: draft.key ? `\${${draft.key}}` : null },
  };
  if (previousName && previousName !== draft.name) profiles[previousName] = null;
  const change: Record<string, unknown> = { llm_profiles: profiles };
  if (!defaultName || defaultName === previousName) change.default_llm_profile = draft.name;
  return change;
}

/** What a connection's row says it is: the model, what answers where, the key it sends. *kind* once found out. */
export function describeConnection(values: Record<string, unknown>, kind?: ServerKind): string {
  const draft = draftOf("", values);
  const host = (url: string): string => url.replace(/^https?:\/\//i, "").replace(/\/v1\/?$/, "").replace(/\/$/, "");
  const model = draft.model || (draft.baseUrl ? "the server's model" : "no model set");
  return [model, kind, host(draft.baseUrl || OPENAI), draft.key ? `key ${draft.key}` : draft.baseUrl ? "" : "no key"]
    .filter(Boolean).join(" · ");
}

/** Where a test asks a connection for its models. */
export function modelsUrl(draft: Pick<ConnectionDraft, "baseUrl">): string {
  return `${apiBase(draft.baseUrl)}/models`;
}

/** The model ids in an OpenAI-style `/models` answer, for the form's suggestions. */
export function modelIds(body: unknown): string[] {
  const data = (body as { data?: { id?: unknown }[] } | null)?.data;
  return Array.isArray(data) ? data.map((item) => item?.id).filter((id): id is string => typeof id === "string") : [];
}
/** What a test's answer means, in words. *sentKey* says whether the key went with it. */
export function testVerdict(url: string, answer: ProbeAnswer | null, sentKey: boolean): { ok: boolean; text: string } {
  if (!answer) return { ok: false, text: `Nothing answered at ${url}: check the address, and that the server runs.` };
  if (answer.status === 200) {
    const model = modelId(answer.body);
    return { ok: true, text: `${sentKey ? "Works, and the key was accepted" : "Works"}${model ? `: it serves ${model}` : ""}.` };
  }
  if (answer.status === 401 || answer.status === 403) {
    return { ok: false, text: sentKey ? `The server refused the key (HTTP ${answer.status}): check the keychain entry.`
      : "The server answers but wants a key: pick one under API key." };
  }
  if (answer.status === 404) return { ok: false, text: `Nothing at ${url} (HTTP 404): check the address.` };
  return { ok: false, text: `The server answered HTTP ${answer.status} at ${url}.` };
}
