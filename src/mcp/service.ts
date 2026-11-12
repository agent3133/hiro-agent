/**
 * The MCP servers as the settings and the Agents tab see them (#87): what is configured, what a stdio server
 * would run and whether it is approved on this device, a test that lists a server's tools, and the tools for the
 * Agents tab's switches.
 */

import type { ToolInfo } from "../api/types";
import { messageOf } from "../core/errors";
import { mcpToolInfos } from "./agentTools";
import type { McpApprovals } from "./approvals";
import type { McpManager, McpTool } from "./manager";
import { commandLine, httpLine, mcpServers, needsApproval, type McpServerSpec } from "./servers";

export interface McpServerStatus {
  spec: McpServerSpec;
  /** What a stdio server runs, as written; empty for an http server. */
  commandLine: string;
  /** An http server needs no approval; a stdio server needs this exact command line approved here. */
  approved: boolean;
}

/** How long the Agents tab waits for http servers it lists by itself (#403). */
const LIST_WAIT_MS = 5000;
/** How long before an http server that did not list its tools is asked again by the Agents tab. */
const LIST_AGAIN_MS = 60_000;

export type McpTest ={ ok: true; tools: McpTool[] } | { ok: false; error: string };

export class McpService {
  /** When the Agents tab last asked each unlisted http server for its tools (#403). */
  private readonly askedAt = new Map<string, number>();

  constructor(private readonly values: () => Record<string, unknown>, readonly manager: McpManager,
              private readonly approvals: McpApprovals) {}

  servers(): McpServerSpec[] {
    return mcpServers(this.values());
  }

  status(): McpServerStatus[] {
    return this.servers().map((spec) => ({
      spec, commandLine: spec.transport === "stdio" ? commandLine(spec) : needsApproval(spec) ? httpLine(spec) : "", approved: this.approvals.approved(spec),
    }));
  }

  /** Connects (starting a stdio server that is approved) and lists what the server offers, after its filter. */
  async test(name: string): Promise<McpTest> {
    const spec = this.servers().find((server) => server.name === name);
    if (!spec) return { ok: false, error: `there is no MCP server called '${name}'` };
    try {
      return { ok: true, tools: await this.manager.tools(spec) };
    } catch (error) {
      return { ok: false, error: messageOf(error) };
    }
  }

  approve(name: string): void {
    const spec = this.servers().find((server) => server.name === name);
    if (spec) this.approvals.approve(spec);
  }

  /** Takes an approval back, and stops the server if it runs. */
  async revoke(name: string): Promise<void> {
    this.approvals.revoke(name);
    await this.manager.close(name);
  }

  /** After a settings change: close what was removed, switched off or changed. */
  async sync(): Promise<void> {
    await this.manager.sync(this.servers());
  }

  /**
   * The Agents tab's MCP switches: the tools of the servers that are on and may run, as each last listed them.
   * An http server not listed yet is asked for its tools here (#403): that starts no program. A stdio server is not
   * — opening the tab starts no program (#178) — and shows once a turn or its Test has connected.
   */
  async toolInfos(): Promise<ToolInfo[]> {
    const specs = this.servers().filter((spec) => spec.enabled);
    // Each one at most once a minute: one that does not answer would hold every redraw of the page otherwise
    const now = Date.now();
    const unlisted = specs.filter((spec) => spec.transport === "http" && this.approvals.approved(spec)
                                            && !this.manager.isListed(spec.name)
                                            && now - (this.askedAt.get(spec.name) ?? 0) >= LIST_AGAIN_MS);
    for (const spec of unlisted) this.askedAt.set(spec.name, now);
    // One that does not answer is left as it was: Features → MCP servers → Test says why. The page waits a few
    // seconds at most; a slower server's tools show the next time it is drawn
    if (unlisted.length) {
      await Promise.race([Promise.allSettled(unlisted.map((spec) => this.manager.tools(spec))),
                          new Promise((resolve) => setTimeout(resolve, LIST_WAIT_MS))]);
    }
    return mcpToolInfos(specs, this.manager.knownTools(specs.filter((spec) => this.approvals.approved(spec))));
  }

  /** The names of the servers that are configured, switched on or not. */
  names(): string[] {
    return this.servers().map((spec) => spec.name);
  }
}
