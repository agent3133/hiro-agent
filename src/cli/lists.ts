/**
 * `obsidian agent:list` and `obsidian agent:sessions` (#72, M6): the agents and the saved conversations, as text
 * for a person — one per line, in columns — or `format=json` for a script. No Obsidian in here.
 */

import type { AgentSummary } from "../api/types";
import type { SessionSummary } from "../core/sessions";

/** Where an agent's file is, in words. */
const SOURCES: Record<string, string> = { bundled: "built in", vault: ".agents/", user: "user folder", other: "other" };

/** Rows as columns padded to their widest cell, the last column left as it is. */
function columns(rows: string[][]): string {
  const widths = rows[0].map((_, index) => Math.max(...rows.map((row) => row[index].length)));
  return rows.map((row) => row.map((cell, index) => (index === row.length - 1 ? cell : cell.padEnd(widths[index])))
    .join("  ").trimEnd()).join("\n");
}

export function agentsText(agents: AgentSummary[]): string {
  if (!agents.length) return "No agents.";
  const rows = agents.map((agent) => [
    agent.default ? "*" : " ", agent.name, SOURCES[agent.source ?? ""] ?? "", (agent.description ?? "").split("\n")[0],
  ]);
  return `${columns(rows)}\n\n* used when no agent is chosen`;
}

export function agentsJson(agents: AgentSummary[]): string {
  return JSON.stringify(agents.map((agent) => ({
    name: agent.name, description: agent.description ?? "", source: agent.source ?? "", default: Boolean(agent.default),
  })), null, 2);
}

export function sessionsText(sessions: SessionSummary[]): string {
  if (!sessions.length) return "No saved conversations.";
  const rows = [["UPDATED", "EXCHANGES", "AGENT", "CONNECTION", "NAME"], ...sessions.map((session) => [
    session.updated.slice(0, 16).replace("T", " "), String(session.exchanges), session.agent || "-",
    session.connection || "-", session.name,
  ])];
  return columns(rows);
}

export function sessionsJson(sessions: SessionSummary[]): string {
  return JSON.stringify(sessions.map((session) => ({
    name: session.name, agent: session.agent, connection: session.connection ?? "", model: session.model,
    exchanges: session.exchanges, updated: session.updated,
  })), null, 2);
}
