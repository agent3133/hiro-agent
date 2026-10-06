/**
 * The MCP servers' connections, and their tools as the agent's (#87) — what tools/mcp.py and
 * langchain-mcp-adapters' MultiServerMCPClient did for the runtime, through the TypeScript MCP SDK.
 *
 * A connection is made on first use and kept while Obsidian runs (decided 2026-09-29; Python started a process
 * per call): `sync` closes one whose settings changed or that was removed or switched off, and `closeAll` runs
 * when the plugin unloads. A connection that drops is forgotten, and the next use makes a new one.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

import { messageOf } from "../core/errors";
import type { ContentPart } from "../core/llm/openaiChat";
import { programEnv } from "../core/programPath";
import type { Tool, ToolSpec } from "../core/tools/tool";
import { commandLine, McpConfigError, type McpServerSpec, needsApproval, passesFilter, resolveSpec, TOOL_SEPARATOR } from "./servers";

/** What the manager needs from the plugin. */
export interface McpHost {
  vaultPath(): string;
  /** A keychain entry's value by its name; the keychain is the only place a `${name}` is read from (#147). */
  keychain(name: string): string | undefined;
  /**
   * Whether this exact server was approved on this device (servers.fingerprint): a stdio server, and an http server
   * whose URL or headers send a keychain key (#136). Asked only for servers that need it (needsApproval).
   */
  approved(spec: McpServerSpec): boolean;
  log(line: string): void;
  fetch: (url: string | URL, init?: RequestInit) => Promise<Response>;
  version: string;
  /**
   * The tools each server offered when it was last listed, kept on this device (#178): the Agents tab draws its
   * switches from them without starting a server. Not given: nothing is kept between sessions.
   */
  rememberedTools?(): Record<string, McpTool[]>;
  rememberTools?(server: string, tools: McpTool[]): void;
}

/** A tool as a server offers it, before it is named for the agent. */
export interface McpTool {
  server: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /**
   * The user is asked first unless the server says the tool only reads, or that it destroys nothing: the MCP
   * specification's defaults are readOnlyHint false and destructiveHint true, so a tool without annotations asks
   * (#138, security review 2026-09-30).
   */
  destructive: boolean;
}

export class McpNotApproved extends Error {
  constructor(readonly spec: McpServerSpec) {
    const what = spec.transport === "stdio" ? "runs a program on this computer"
      : `sends a key from this device's keychain to ${spec.url}`;
    super(`MCP server '${spec.name}' ${what} and has not been approved on this device. `
      + "Approve it under Settings → Hiro Agent → Features → MCP servers.");
    this.name = "McpNotApproved";
  }
}

interface Connection {
  key: string;
  client: Client;
  tools: McpTool[] | null;
}

const CONNECT_TIMEOUT_MS = 30_000;
const CALL_TIMEOUT_MS = 120_000;
/** What a stdio server wrote to stderr last, kept for the error when it fails to start. */
const STDERR_KEPT = 2_000;

export class McpManager {
  private readonly connections = new Map<string, Promise<Connection>>();
  /** What each server offered when it was last listed, before its filter (#178). */
  private readonly listed: Map<string, McpTool[]>;

  constructor(private readonly host: McpHost) {
    let remembered: Record<string, McpTool[]> = {};
    try {
      remembered = host.rememberedTools?.() ?? {};
    } catch {
      remembered = {};  // unreadable: the next listing fills it again
    }
    this.listed = new Map(Object.entries(remembered).filter(([, tools]) => Array.isArray(tools)));
  }

  /**
   * The tools of *specs* as the agent's, from each server's last listing — without connecting to anything (#178).
   * A server not listed yet on this device has none here; a turn or a test lists it.
   */
  knownTools(specs: McpServerSpec[]): Tool[] {
    return specs.flatMap((spec) => (this.listed.get(spec.name) ?? [])
      .filter((tool) => passesFilter(spec, tool.name))
      .map((tool) => this.asTool(spec, { ...tool, server: spec.name })));
  }

  /** The server's tools, as it names them, after its `tools_filter`. Connects when not connected. */
  async tools(spec: McpServerSpec): Promise<McpTool[]> {
    const connection = await this.connection(spec);
    if (!connection.tools) {
      const listed: McpTool[] = [];
      let cursor: string | undefined;
      do {
        const page = await connection.client.listTools(cursor ? { cursor } : undefined, { timeout: CONNECT_TIMEOUT_MS });
        for (const tool of page.tools) {
          const hints = tool.annotations ?? {};
          listed.push({ server: spec.name, name: tool.name, description: tool.description ?? "",
                        inputSchema: tool.inputSchema,
                        destructive: hints.readOnlyHint !== true && hints.destructiveHint !== false });
        }
        cursor = page.nextCursor;
      } while (cursor);
      connection.tools = listed;
      this.listed.set(spec.name, listed);
      this.host.rememberTools?.(spec.name, listed);
    }
    return connection.tools.filter((tool) => passesFilter(spec, tool.name));
  }

  /** Calls one of the server's tools; the answer as the model is given it (text, and images as parts). */
  async call(spec: McpServerSpec, tool: string, args: Record<string, unknown>): Promise<string | ContentPart[]> {
    const connection = await this.connection(spec);
    const result = await connection.client.callTool({ name: tool, arguments: args }, undefined,
                                                    { timeout: CALL_TIMEOUT_MS, resetTimeoutOnProgress: true });
    return resultContent(result as { content?: unknown[]; isError?: boolean; structuredContent?: unknown });
  }

  /**
   * The tools of *specs* (the enabled ones) as the agent's, named `server__tool`. A server that fails — not
   * approved, not reachable, a missing key — is left out, and said in `failures`, so the others still count.
   */
  async agentTools(specs: McpServerSpec[]): Promise<{ tools: Tool[]; failures: string[] }> {
    const enabled = specs.filter((spec) => spec.enabled);
    const answers = await Promise.allSettled(enabled.map((spec) => this.tools(spec)));
    const tools: Tool[] = [];
    const failures: string[] = [];
    answers.forEach((answer, index) => {
      const spec = enabled[index];
      if (answer.status === "rejected") {
        failures.push(`${spec.name}: ${(answer.reason as Error)?.message ?? String(answer.reason)}`);
        return;
      }
      for (const tool of answer.value) tools.push(this.asTool(spec, tool));
    });
    return { tools, failures };
  }

  /** Closes the connections of servers that are gone, switched off, or set differently from *specs*. */
  async sync(specs: McpServerSpec[]): Promise<void> {
    const wanted = new Map(specs.filter((spec) => spec.enabled).map((spec) => [spec.name, spec]));
    await Promise.all([...this.connections.keys()].map(async (name) => {
      const spec = wanted.get(name);
      const connection = await this.connections.get(name)?.catch(() => null);
      if (!spec || !connection || connection.key !== this.keyOf(spec)) await this.close(name);
    }));
  }

  async close(name: string): Promise<void> {
    const pending = this.connections.get(name);
    this.connections.delete(name);
    const connection = await pending?.catch(() => null);
    await connection?.client.close().catch(() => undefined);
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.connections.keys()].map((name) => this.close(name)));
  }

  /**
   * The key a connection is made for: the server as started, keys included — kept in memory only. The filter and
   * the switch are the plugin's own business, not the server's: changing them needs no new connection.
   */
  private keyOf(spec: McpServerSpec): string {
    try {
      const { toolsFilter: _filter, enabled: _enabled, ...started } =
        resolveSpec(spec, this.host.vaultPath(), (name) => this.host.keychain(name));
      return JSON.stringify(started);
    } catch {
      return "";  // a reference with no key: never equal to a working connection's
    }
  }

  private connection(spec: McpServerSpec): Promise<Connection> {
    const key = this.keyOf(spec);
    const existing = this.connections.get(spec.name);
    if (existing) {
      return existing.then((connection) => {
        if (connection.key === key) return connection;
        return this.close(spec.name).then(() => this.connection(spec));
      });
    }
    const made = this.connect(spec, key);
    this.connections.set(spec.name, made);
    // A failed start is not kept: the next use tries again
    made.catch(() => { if (this.connections.get(spec.name) === made) this.connections.delete(spec.name); });
    return made;
  }

  private async connect(spec: McpServerSpec, key: string): Promise<Connection> {
    // Checked here, where the server is used, for every kind that needs it: an http server naming a keychain key
    // would otherwise send it wherever settings that arrived by sync point it (#170)
    if (needsApproval(spec) && !this.host.approved(spec)) throw new McpNotApproved(spec);
    const resolved = resolveSpec(spec, this.host.vaultPath(), (name) => this.host.keychain(name));
    let transport: Transport;
    let stderr = "";
    if (resolved.transport === "stdio") {
      if (!resolved.command) throw new McpConfigError(`MCP server '${spec.name}' has no command`);
      // The line as written, references and all: the log never holds a key
      this.host.log(`MCP: starting '${spec.name}': ${commandLine(spec)}`);
      // The SDK's safe environment (PATH, HOME, …) plus the server's own env, nothing else of Obsidian's; on macOS
      // PATH gains Homebrew's folders (#124), where npx and the node it runs usually are
      const path = programEnv(process.env, process.platform)?.PATH;
      const env = path && !("PATH" in resolved.env) ? { PATH: path, ...resolved.env } : resolved.env;
      const stdio = new StdioClientTransport({
        command: resolved.command, args: resolved.args, env, cwd: this.host.vaultPath() || undefined,
        stderr: "pipe",
      });
      stdio.stderr?.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-STDERR_KEPT); });
      transport = stdio;
    } else {
      if (!resolved.url) throw new McpConfigError(`MCP server '${spec.name}' has no URL`);
      this.host.log(`MCP: connecting to '${spec.name}': ${spec.url}`);
      transport = new StreamableHTTPClientTransport(new URL(resolved.url), {
        requestInit: { headers: resolved.headers }, fetch: this.host.fetch,
      });
    }
    const client = new Client({ name: "obsidian-agent", version: this.host.version });
    client.onclose = () => {
      // Dropped: forget it, so the next use connects again
      void this.connections.get(spec.name)?.then((connection) => {
        if (connection.client === client) this.connections.delete(spec.name);
      }).catch(() => undefined);
    };
    try {
      await client.connect(transport, { timeout: CONNECT_TIMEOUT_MS });
    } catch (error) {
      await client.close().catch(() => undefined);
      const said = stderr.trim().split("\n").slice(-3).join(" ").trim();
      throw new Error(`MCP server '${spec.name}' did not start: ${messageOf(error)}${said ? ` (${said})` : ""}`);
    }
    return { key, client, tools: null };
  }

  private asTool(spec: McpServerSpec, tool: McpTool): Tool {
    const schema = tool.inputSchema ?? {};
    const parameters = {
      type: "object" as const,
      properties: (schema.properties ?? {}) as ToolSpec["parameters"]["properties"],
      required: Array.isArray(schema.required) ? (schema.required as string[]) : [],
    };
    const call = (args: Record<string, unknown>): Promise<string | ContentPart[]> => this.call(spec, tool.name, args);
    return {
      name: `${spec.name}${TOOL_SEPARATOR}${tool.name}`,
      description: tool.description,
      parameters,
      destructive: tool.destructive,
      run: async (args) => {
        const answer = await call(args);
        return typeof answer === "string" ? answer : answer.map((part) => (part.type === "text" ? part.text : "[image]")).join("\n");
      },
      runContent: call,
    };
  }
}

/**
 * An MCP tool's answer as the model is given it: the text parts joined, images as image parts; an error result
 * is "Error: …", as a failed built-in tool's is.
 */
export function resultContent(result: { content?: unknown[]; isError?: boolean; structuredContent?: unknown }):
    string | ContentPart[] {
  const parts: ContentPart[] = [];
  for (const raw of result.content ?? []) {
    const item = raw as { type?: string; text?: string; data?: string; mimeType?: string;
                          resource?: { uri?: string; text?: string } };
    if (item.type === "text" && typeof item.text === "string") parts.push({ type: "text", text: item.text });
    else if (item.type === "image" && item.data) {
      parts.push({ type: "image_url", image_url: { url: `data:${item.mimeType ?? "image/png"};base64,${item.data}` } });
    } else if (item.type === "resource" && item.resource) {
      parts.push({ type: "text", text: item.resource.text ?? `[resource ${item.resource.uri ?? ""}]` });
    } else if (item.type === "resource_link") {
      const link = raw as { uri?: string; name?: string };
      parts.push({ type: "text", text: `[${link.name ?? "resource"}: ${link.uri ?? ""}]` });
    } else if (item.type === "audio") {
      parts.push({ type: "text", text: "[audio]" });
    }
  }
  if (!parts.length && result.structuredContent !== undefined) {
    parts.push({ type: "text", text: JSON.stringify(result.structuredContent) });
  }
  const text = parts.filter((part) => part.type === "text").map((part) => (part as { text: string }).text).join("\n");
  if (result.isError) return `Error: ${text || "the tool failed"}`;
  return parts.some((part) => part.type === "image_url") ? parts : text;
}
