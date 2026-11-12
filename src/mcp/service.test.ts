// McpService.toolInfos (#403): the Agents tab lists an approved http server's tools it has not listed yet, and starts
// no stdio program to do it (#178). The manager is a stand-in that records what it is asked.
import { describe, expect, it, vi } from "vitest";

import { McpApprovals } from "./approvals";
import type { McpManager, McpTool } from "./manager";
import { mcpServers, type McpServerSpec } from "./servers";
import { McpService } from "./service";

const VALUES = {
  mcp_servers: {
    remote: { transport: "http", url: "https://example.com/mcp", enabled: true },
    local: { transport: "stdio", command: "npx", args: ["-y", "files"], enabled: true },
  },
};

/** A manager that lists a server's tools when asked, and remembers that it did. */
function setup() {
  const specs = mcpServers(VALUES);
  let stored: unknown = [];
  const approvals = new McpApprovals(() => stored, (value) => { stored = value; });
  // Both are approved here, so only its transport keeps the stdio server from being asked. The http server is on
  // another computer, which needs this device's approval since #407
  approvals.approve(specs.find((spec) => spec.name === "local")!);
  approvals.approve(specs.find((spec) => spec.name === "remote")!);

  let listed = false;
  const found: McpTool = { server: "remote", name: "search", description: "Searches the web.", inputSchema: {},
                           destructive: false };
  const tool = (name: string) => ({ name, description: "", parameters: { type: "object", properties: {}, required: [] },
                                    destructive: false, run: async () => "" });
  const manager = {
    isListed: vi.fn(() => listed),
    tools: vi.fn(async (spec: McpServerSpec) => {
      listed = true;
      return spec.name === "remote" ? [found] : [];
    }),
    knownTools: vi.fn(() => (listed ? [tool("remote__search")] : [])),
  } as unknown as McpManager;
  return { service: new McpService(() => VALUES, manager, approvals), manager, approvals, specs };
}

describe("the Agents tab's MCP tools (#403)", () => {
  it("lists an approved http server's tools that were not listed yet, after asking the server for them", async () => {
    const { service, manager, approvals, specs } = setup();
    expect(approvals.approved(specs.find((spec) => spec.name === "remote")!)).toBe(true);

    const infos = await service.toolInfos();
    expect(manager.tools).toHaveBeenCalledWith(expect.objectContaining({ name: "remote", transport: "http" }));
    expect(infos.find((info) => info.name === "remote__search")).toMatchObject({ group: "MCP", label: "remote: search" });
  });

  it("does not ask a stdio server for its tools, though it is enabled and approved", async () => {
    const { service, manager } = setup();
    await service.toolInfos();
    // Only the http server is asked: the stdio one would start a program just to draw the tab
    expect(vi.mocked(manager.tools).mock.calls.map(([spec]) => spec.name)).toEqual(["remote"]);
  });
});
