/**
 * An agent's tools with MCP's among them — assemble_tools and filter_mcp_tools_for_agent (runner.py, mcp.py).
 *
 * Exactly the tools the agent lists, in its order, none when it lists none. `mcp:*` stands for every MCP tool,
 * where it is listed; `server__tool` for one. A folder-restricted agent gets no MCP tool at all: a server reaches
 * whatever it reaches, past any folder (runner.py's ignores_scope).
 */

import type { ToolInfo } from "../api/types";
import type { Tool } from "../core/tools/tool";
import { ALL_MCP_TOOLS, displayName, isMcpToolName, TOOL_SEPARATOR, type McpServerSpec } from "./servers";

/** Whether the agent's list asks for any MCP tool — so no server is started for an agent that has none. */
export function wantsMcp(listed: string[], scoped: boolean): boolean {
  return !scoped && listed.some(isMcpToolName);
}

export function assembleTools(listed: string[], builtin: Tool[], mcp: Tool[], scoped: boolean): Tool[] {
  const byName = new Map([...builtin, ...(scoped ? [] : mcp)].map((tool) => [tool.name, tool]));
  const tools: Tool[] = [];
  const seen = new Set<string>();
  const add = (tool: Tool | undefined): void => {
    if (!tool || seen.has(tool.name)) return;
    seen.add(tool.name);
    tools.push(tool);
  };
  for (const name of listed) {
    if (name === ALL_MCP_TOOLS) {
      if (!scoped) for (const tool of mcp) add(tool);
    } else {
      add(byName.get(name));
    }
  }
  return tools;
}

/**
 * The MCP tools as the Agents tab lists them, in one group: `mcp:*` first as "All MCP tools", then each server's,
 * shown as "server: tool". Every one is withheld from a folder-restricted agent; a stdio server's run a program
 * here, an http server's send data off it.
 */
export function mcpToolInfos(specs: McpServerSpec[], tools: Tool[]): ToolInfo[] {
  if (!specs.length) return [];
  const infos: ToolInfo[] = [{
    name: ALL_MCP_TOOLS, label: "All MCP tools", group: "MCP",
    description: "Every tool of every MCP server that is switched on, including ones added later.",
    destructive: tools.some((tool) => tool.destructive), ignores_scope: true,
    leaves_machine: specs.some((spec) => spec.transport === "http"),
    runs_programs: specs.some((spec) => spec.transport === "stdio"),
  }];
  for (const spec of specs) {
    const prefix = `${spec.name}${TOOL_SEPARATOR}`;
    for (const tool of tools.filter((one) => one.name.startsWith(prefix))) {
      infos.push({ name: tool.name, label: displayName(tool.name), group: "MCP",
                   description: tool.description.trim().split("\n")[0],
                   destructive: Boolean(tool.destructive), ignores_scope: true,
                   leaves_machine: spec.transport === "http", runs_programs: spec.transport === "stdio" });
    }
  }
  return infos;
}

/**
 * What the system prompt says about the agent's MCP tools, so it knows which of its tools come from MCP and from
 * which server — without it the model denies having any MCP at all. Empty when it has none.
 */
export function mcpPrompt(tools: Tool[]): string {
  const byServer = new Map<string, string[]>();
  for (const tool of tools) {
    const at = tool.name.indexOf(TOOL_SEPARATOR);
    if (at <= 0) continue;
    const server = tool.name.slice(0, at);
    byServer.set(server, [...(byServer.get(server) ?? []), tool.name.slice(at + TOOL_SEPARATOR.length)]);
  }
  if (!byServer.size) return "";
  const lines = [...byServer].map(([server, names]) => `- ${server}: ${names.join(", ")}`);
  return "\n\n---\nSome of your tools come from MCP (Model Context Protocol) servers the user connected. A tool "
    + "named server__tool is that server's tool; you have these:\n" + lines.join("\n")
    + "\nWhen the user asks about MCP or one of these servers, these are the tools meant. You have no other "
    + "MCP tools.\n---";
}
