/**
 * What an answer reached beyond the vault and the model (#409): the sites whose pages it opened and the MCP servers
 * it called, for a line under the answer. The privacy claim — nothing leaves but what you configured — is then
 * something a user can check, answer by answer.
 *
 * A call counts once it went out: one the user declined, or an address refused before connecting, sent nothing.
 */

import { TOOL_SEPARATOR } from "../mcp/servers";
import { pageHost } from "../vault/webTools";

export interface FinishedCall {
  name: string;
  input: unknown;
  result: string;
}

export interface WhatLeft {
  /** Sites pages were opened on, in the order first opened. */
  sites: string[];
  /** MCP servers called, by name, in the order first called. */
  servers: string[];
}

/** Whether *result* says the call never went out: declined in the dialog, or an address refused before connecting. */
function neverWent(result: string): boolean {
  return result.startsWith("Error: the user declined")
    || / is on this computer or the local network|only http and https pages can be opened/.test(result)
    || result.includes("refused — a request from the terminal");
}

export function whatLeft(calls: FinishedCall[]): WhatLeft {
  const sites: string[] = [];
  const servers: string[] = [];
  for (const call of calls) {
    if (neverWent(call.result)) continue;
    if (call.name === "web_fetch") {
      const host = pageHost(String((call.input as { url?: unknown } | null)?.url ?? ""));
      if (host && !sites.includes(host)) sites.push(host);
      continue;
    }
    const at = call.name.indexOf(TOOL_SEPARATOR);
    if (at > 0) {
      const server = call.name.slice(0, at);
      if (!servers.includes(server)) servers.push(server);
    }
  }
  return { sites, servers };
}

/** The line under the answer, or "" when it reached nothing beyond the vault and the model. */
export function whatLeftLine(left: WhatLeft): string {
  const parts = [
    left.sites.length ? `${left.sites.length === 1 ? "a page on" : "pages on"} ${left.sites.join(", ")}` : "",
    left.servers.length ? `${left.servers.length === 1 ? "the MCP server" : "the MCP servers"} ${left.servers.join(", ")}` : "",
  ].filter(Boolean);
  return parts.length ? `Besides the model, this answer reached ${parts.join(" and ")}.` : "";
}
