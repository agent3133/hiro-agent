/**
 * The agent's commands on the Obsidian CLI (M6): `obsidian agent:<action>`, registered with Obsidian 1.12.2's
 * `registerCliHandler` — the prefix is the plugin's id (#69).
 */

import type { CliData, CliFlags, Plugin } from "obsidian";

import type { AgentSummary } from "../api/types";
import type { SessionSummary } from "../core/sessions";
import { ask, DEFAULT_TIMEOUT_SECONDS, renderAsk, type AskHost } from "./ask";
import { agentsJson, agentsText, sessionsJson, sessionsText } from "./lists";
import { renderStatus, type AgentStatus } from "./status";

export interface CliHost {
  status(): AgentStatus;
  agents(): Promise<AgentSummary[]>;
  sessions(): Promise<SessionSummary[]>;
  ask: AskHost;
}

const FORMAT: CliFlags = { format: { value: "<text|json>", description: "json for scripts; text by default" } };

function register(plugin: Plugin, command: string, description: string, flags: CliFlags | null,
                  handler: (params: CliData) => string | Promise<string>): void {
  plugin.registerCliHandler(command, description, flags, handler);
}

export function registerCli(plugin: Plugin, host: CliHost): void {
  register(plugin, "agent:status", "What the agent would answer with: version, default agent and connection", FORMAT,
           (params) => renderStatus(host.status(), params.format));
  register(plugin, "agent:list", "The agents: name, where they come from, what they are for", FORMAT,
           async (params) => (params.format === "json" ? agentsJson : agentsText)(await host.agents()));
  register(plugin, "agent:sessions", "Saved conversations, newest first", FORMAT,
           async (params) => (params.format === "json" ? sessionsJson : sessionsText)(await host.sessions()));
  register(plugin, "agent:ask", "Run one turn of the agent and print its reply (#74)", {
    prompt: { value: "<text>", description: "What the agent should do", required: true },
    agent: { value: "<name>", description: "The agent; the default one when not given" },
    connection: { value: "<name>", description: "The connection; wins over the agent's own" },
    note: { value: "<path>", description: "A note the turn is about, as the commands pass the open note" },
    session: { value: "<name>", description: "Continue this saved conversation; a new one otherwise" },
    timeout: { value: "<seconds>", description: `Stop the turn after this long (default ${DEFAULT_TIMEOUT_SECONDS})` },
    allow: { value: "destructive", description: "Let it delete, move or overwrite notes (asked in Obsidian)" },
    format: { value: "<text|json>", description: "json for scripts; text by default" },
    keep: { value: "<true|false>", description: "false: do not save the conversation (default true)" },
  }, async (params) => renderAsk(await ask(host.ask, params), params.format));
}
