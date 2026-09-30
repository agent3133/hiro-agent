/**
 * The MCP servers as the settings and the Agents tab see them (#87): what is configured, what a stdio server
 * would run and whether it is approved on this device, a test that lists a server's tools, and the tools for the
 * Agents tab's switches.
 */

import type { ToolInfo } from "../api/types";
import { mcpToolInfos } from "./agentTools";
import type { McpApprovals } from "./approvals";
import type { McpManager, McpTool } from "./manager";
import { commandLine, mcpServers, type McpServerSpec } from "./servers";

export interface McpServerStatus {
  spec: McpServerSpec;
  /** What a stdio server runs, as written; empty for an http server. */
  commandLine: string;
  /** An http server needs no approval; a stdio server needs this exact command line approved here. */
  approved: boolean;
}

export type McpTest = { ok: true; tools: McpTool[] } | { ok: false; error: string };

export class McpService {
  constructor(private readonly values: () => Record<string, unknown>, readonly manager: McpManager,
              private readonly approvals: McpApprovals) {}

  servers(): McpServerSpec[] {
    return mcpServers(this.values());
  }

  status(): McpServerStatus[] {
    return this.servers().map((spec) => ({
      spec, commandLine: spec.transport === "stdio" ? commandLine(spec) : "", approved: this.approvals.approved(spec),
    }));
  }

  /** Connects (starting a stdio server that is approved) and lists what the server offers, after its filter. */
  async test(name: string): Promise<McpTest> {
    const spec = this.servers().find((server) => server.name === name);
    if (!spec) return { ok: false, error: `there is no MCP server called '${name}'` };
    try {
      return { ok: true, tools: await this.manager.tools(spec) };
    } catch (error) {
      return { ok: false, error: (error as Error).message };
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

  /** The Agents tab's MCP switches: the tools of the servers that are on and may run; none of the others. */
  async toolInfos(): Promise<ToolInfo[]> {
    const specs = this.servers().filter((spec) => spec.enabled);
    const { tools } = await this.manager.agentTools(specs.filter((spec) => this.approvals.approved(spec)));
    return mcpToolInfos(specs, tools);
  }
}
