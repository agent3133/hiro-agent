/**
 * `obsidian agent:tool name=<tool> args=<json>` — runs one of the in-plugin agent's tools and prints its answer, so
 * the tools that only work inside Obsidian can be tested there (plugin/tests/obsidian-tools.smoke.ts, #81).
 *
 * A developer setting, off by default and read when the plugin loads. What it runs is exactly what the model
 * would get; a destructive tool runs only with the `confirm` flag, which stands in for the user's "Allow once".
 */

import type { App, CliData, Plugin } from "obsidian";

import { confirmArgs, toolErrorText } from "../core/agentLoop";
import { obsidianToolset, type ToolsetOptions } from "./toolset";

export function registerToolCli(plugin: Plugin, app: App, options: () => Promise<ToolsetOptions>): void {
  plugin.registerCliHandler("agent:tool", "Run one of the agent's tools (developer setting)", {
    name: { value: "<tool>", description: "The tool, e.g. get_backlinks", required: true },
    args: { value: "<json>", description: "Its arguments as a JSON object, e.g. {\"path\":\"Note.md\"}" },
    scope: { value: "<folders>", description: "Comma-separated folders, as an agent's vault_scope" },
    confirm: { description: "Allow a destructive tool to run (stands in for the user's answer)" },
  }, (params: CliData) => runTool(app, params, options));
}

async function runTool(app: App, params: CliData, options: () => Promise<ToolsetOptions>): Promise<string> {
  const scope = params.scope ? params.scope.split(",").map((s) => s.trim()).filter(Boolean) : null;
  const tool = obsidianToolset(app, scope, await options()).find((t) => t.name === params.name);
  if (!tool) return `Error: no tool '${params.name}'`;
  let args: Record<string, unknown>;
  try {
    const parsed: unknown = params.args ? JSON.parse(params.args) : {};
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return "Error: args must be a JSON object";
    args = parsed as Record<string, unknown>;
  } catch (error) {
    return toolErrorText(error);
  }
  try {
    if (tool.destructive) {
      tool.validate?.(args);
      if (params.confirm !== "true") {
        const asked = await (tool.confirmArgs?.(args) ?? Promise.resolve(confirmArgs(args)));
        return `Error: '${tool.name}' is destructive; pass the confirm flag to run it (it would change ${JSON.stringify(asked)})`;
      }
    }
    return await tool.run(args);
  } catch (error) {
    return toolErrorText(error);
  }
}
