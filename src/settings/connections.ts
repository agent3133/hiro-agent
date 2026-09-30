/** The pure half of the connections editor — no Obsidian in here, so it can be tested under Node. */

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

/** Where llama-server usually listens: its own default, and the port this project's docs use. */
export const LOCAL_PORTS = [8080, 8090];

export interface ProbeAnswer {
  status: number;
  body: unknown;
}

/** A llama.cpp server answering on this machine that no connection points at yet, and the name it would get. */
export interface LocalServer {
  port: number;
  baseUrl: string;
  model: string;
  name: string;
}

/** The local llama.cpp servers that answer and that no connection in *profiles* points at yet. */
export async function findLocalServers(profiles: Profiles,
                                       probe: (url: string) => Promise<ProbeAnswer | null>): Promise<LocalServer[]> {
  const found: LocalServer[] = [];
  for (const port of LOCAL_PORTS) {
    if (Object.values(profiles).some((values) => pointsAt(values.base_url, port))) continue;
    const baseUrl = `http://127.0.0.1:${port}`;
    const answer = await probe(`${baseUrl}/v1/models`);
    if (!answer || answer.status !== 200) continue;
    found.push({ port, baseUrl, model: modelId(answer.body),
                 name: freeName(port === 8080 ? "local" : `local-${port}`, profiles) });
  }
  return found;
}

/** The settings change that adds *server* as a connection — the default one when there is no default yet. */
export function addLocalServer(server: LocalServer, defaultProfile: string): Record<string, unknown> {
  const change: Record<string, unknown> = {
    llm_profiles: { [server.name]: { provider: "llamacpp", base_url: server.baseUrl } },
  };
  if (!defaultProfile) change.default_llm_profile = server.name;
  return change;
}
