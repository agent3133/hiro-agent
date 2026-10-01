/**
 * The MCP servers in the agent's settings (`mcp_servers`), as the plugin runs them (#87) — the fields are
 * config/schema.py's MCPServerConfig, the Python runtime's.
 *
 * Kept from Python: `stdio` and `http` (streamable HTTP), `enabled`, `tools_filter`, tools named `server__tool`,
 * `${vault_path}` in the arguments. Different, decided 2026-09-29:
 * - a `${name}` in `env`, `headers` or the URL names an entry in Obsidian's keychain, read from there and nowhere else;
 * - a `stdio` server gets only the MCP SDK's safe environment (PATH, HOME, …) plus its own `env`, never the whole
 *   of Obsidian's;
 * - a `stdio` server is a program started on this machine, and the settings sync with the vault: it runs only
 *   once approved on this device, for exactly this command line (`fingerprint`).
 */

export type Transport = "stdio" | "http";

export interface McpServerSpec {
  name: string;
  transport: Transport;
  command: string;
  args: string[];
  env: Record<string, string>;
  url: string;
  headers: Record<string, string>;
  enabled: boolean;
  /** Tool names as the server gives them, or "*" for all of them. */
  toolsFilter: string[];
}

/** The separator between a server's name and its tool's: `filesystem__read_file` (prefix_mcp_tools). */
export const TOOL_SEPARATOR = "__";
/** In an agent's tools: every tool of every enabled server. */
export const ALL_MCP_TOOLS = "mcp:*";

const REFERENCE = /\$\{([^}]+)\}/g;

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function record(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

/** The servers in *values* (the plugin's agent settings), in the order they were written. */
export function mcpServers(values: Record<string, unknown>): McpServerSpec[] {
  const section = values.mcp_servers;
  if (!section || typeof section !== "object" || Array.isArray(section)) return [];
  return Object.entries(section as Record<string, unknown>).flatMap(([name, raw]) => {
    if (!raw || typeof raw !== "object") return [];
    const server = raw as Record<string, unknown>;
    const transport = server.transport === "stdio" ? "stdio" : server.transport === "http" ? "http" : null;
    if (!transport) return [];
    const filter = strings(server.tools_filter);
    return [{
      name, transport,
      command: typeof server.command === "string" ? server.command : "",
      args: strings(server.args),
      env: record(server.env),
      url: typeof server.url === "string" ? server.url : "",
      headers: record(server.headers),
      enabled: server.enabled !== false,
      toolsFilter: filter.length ? filter : ["*"],
    }];
  });
}

/** An MCP tool's name as a person reads it: `everything__echo` is "everything: echo"; any other name as it is. */
export function displayName(name: string): string {
  const at = name.indexOf(TOOL_SEPARATOR);
  return at > 0 ? `${name.slice(0, at)}: ${name.slice(at + TOOL_SEPARATOR.length)}` : name;
}

/** Whether *name* is the name of one of an MCP server's tools, as an agent lists it. */
export function isMcpToolName(name: string): boolean {
  return name === ALL_MCP_TOOLS || name.includes(TOOL_SEPARATOR);
}

/** What a stdio server runs, as the user is shown it before it may run: the command, its arguments, its env. */
export function commandLine(spec: McpServerSpec): string {
  const quote = (word: string): string => (/^[\w./:\\=@+,-]+$/.test(word) ? word : JSON.stringify(word));
  const env = Object.entries(spec.env).map(([key, value]) => `${key}=${quote(value)}`);
  return [...env, quote(spec.command), ...spec.args.map(quote)].join(" ");
}

/**
 * What an approval is for: a stdio server's command, arguments and env as written (references, not the keys
 * they name — a new key in the keychain needs no new approval, a changed command does); an http server's URL and
 * headers as written, when they send a key (#136).
 */
export function fingerprint(spec: McpServerSpec): string {
  if (spec.transport !== "stdio") {
    return JSON.stringify([spec.name, "http", spec.url, Object.entries(spec.headers).sort()]);
  }
  return JSON.stringify([spec.name, spec.command, spec.args, Object.entries(spec.env).sort()]);
}

/**
 * Whether *spec* may be used only once approved on this device: a stdio server starts a program here; an http
 * server whose URL or headers name a `${KEY}` sends a keychain secret to wherever the synced settings say (#136).
 */
export function needsApproval(spec: McpServerSpec): boolean {
  if (spec.transport === "stdio") return true;
  return [spec.url, ...Object.values(spec.headers)].some((text) => /\$\{[^}]+\}/.test(text));
}

/** What an http server that needs approval sends, as the user is shown it: the URL and the headers as written. */
export function httpLine(spec: McpServerSpec): string {
  return [spec.url, ...Object.entries(spec.headers).map(([name, value]) => `${name}: ${value}`)].join("\n");
}

export class McpConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpConfigError";
  }
}

/**
 * *text* with its references filled in: `${vault_path}` is the vault's folder, any other `${NAME}` the keychain's
 * secret bound to NAME. A NAME with nothing behind it is an error rather than an empty string, so a server is
 * never started with a missing token.
 */
export function fillReferences(text: string, where: string, vaultPath: string,
                               keychain: (name: string) => string | undefined): string {
  return text.replace(REFERENCE, (_whole, name: string) => {
    if (name === "vault_path") return vaultPath;
    const value = keychain(name);
    if (value === undefined || value === "") {
      throw new McpConfigError(`${where} names \${${name}}, which is not in Obsidian's keychain on this device (Settings → Keychain)`);
    }
    return value;
  });
}

/** The server as it is started: every reference filled in. */
export function resolveSpec(spec: McpServerSpec, vaultPath: string,
                            keychain: (name: string) => string | undefined): McpServerSpec {
  const fill = (text: string, where: string): string => fillReferences(text, where, vaultPath, keychain);
  const fillAll = (entries: Record<string, string>, what: string): Record<string, string> =>
    Object.fromEntries(Object.entries(entries).map(([key, value]) => [key, fill(value, `${spec.name}'s ${what} ${key}`)]));
  return {
    ...spec,
    args: spec.args.map((arg) => fill(arg, `${spec.name}'s arguments`)),
    env: fillAll(spec.env, "env"),
    url: fill(spec.url, `${spec.name}'s URL`),
    headers: fillAll(spec.headers, "header"),
  };
}

/** Whether a server's tool, named as the server gives it, passes its `tools_filter`. */
export function passesFilter(spec: McpServerSpec, tool: string): boolean {
  return spec.toolsFilter.includes("*") || spec.toolsFilter.includes(tool);
}
