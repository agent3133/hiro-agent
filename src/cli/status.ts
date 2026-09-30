/**
 * `obsidian agent:status` (#71, M6): what the agent in this vault would answer with — its version, the agent and
 * connection used when none is chosen, how many agents there are, and the MCP servers. Plain text for a person,
 * `format=json` for a script. Nothing here needs Obsidian, so it is tested under Node.
 */

export interface AgentStatus {
  version: string;
  vault: string;
  defaultAgent: string;
  agents: number;
  /** The connection a turn uses when none is chosen; null when none is configured. */
  connection: { name: string; provider: string; model: string; url: string } | null;
  mcp: { name: string; transport: string; enabled: boolean; approved: boolean }[];
}

export function statusText(status: AgentStatus): string {
  const connection = status.connection;
  const lines = [
    `agent ${status.version} in vault "${status.vault}"`,
    `default agent: ${status.defaultAgent} (${status.agents} agent${status.agents === 1 ? "" : "s"})`,
    connection
      ? `default connection: ${connection.name || "llm"} — ${connection.provider}, ${connection.model || "the server's model"}`
        + (connection.url ? `, ${connection.url}` : "")
      : "default connection: none configured",
  ];
  if (status.mcp.length) {
    const servers = status.mcp.map((server) => `${server.name} (${server.transport}`
      + (server.enabled ? "" : ", off") + (server.approved ? "" : ", not approved on this device") + ")");
    lines.push(`MCP servers: ${servers.join(", ")}`);
  }
  return lines.join("\n");
}

/** The answer for *format*: "json" for scripts, anything else as text. */
export function renderStatus(status: AgentStatus, format: string | undefined): string {
  return format === "json" ? JSON.stringify(status, null, 2) : statusText(status);
}
