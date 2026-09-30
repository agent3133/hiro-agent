// `obsidian agent:status` (#71): what it says, as text and as JSON.
import { describe, expect, it } from "vitest";

import { renderStatus, statusText, type AgentStatus } from "./status";

const STATUS: AgentStatus = {
  version: "0.3.0", vault: "Notes", defaultAgent: "assistant", agents: 3,
  connection: { name: "local", provider: "llamacpp", model: "", url: "http://127.0.0.1:8080" },
  mcp: [{ name: "everything", transport: "stdio", enabled: true, approved: true },
        { name: "remote", transport: "http", enabled: false, approved: true },
        { name: "synced", transport: "stdio", enabled: true, approved: false }],
};

describe("agent:status", () => {
  it("says the version, the default agent and connection, and the MCP servers, one per line", () => {
    expect(statusText(STATUS)).toBe([
      'agent 0.3.0 in vault "Notes"',
      "default agent: assistant (3 agents)",
      "default connection: local — llamacpp, the server's model, http://127.0.0.1:8080",
      "MCP servers: everything (stdio), remote (http, off), synced (stdio, not approved on this device)",
    ].join("\n"));
  });

  it("says when there is no connection or no MCP server", () => {
    const text = statusText({ ...STATUS, agents: 1, connection: null, mcp: [] });
    expect(text).toContain("default agent: assistant (1 agent)");
    expect(text).toContain("default connection: none configured");
    expect(text).not.toContain("MCP servers");
  });

  it("names the model when the connection sets one", () => {
    expect(statusText({ ...STATUS, connection: { name: "", provider: "openai", model: "gpt-5.4-mini", url: "" } }))
      .toContain("default connection: llm — openai, gpt-5.4-mini\n");
  });

  it("answers JSON for format=json, and text otherwise", () => {
    expect(JSON.parse(renderStatus(STATUS, "json"))).toEqual(STATUS);
    expect(renderStatus(STATUS, undefined)).toBe(statusText(STATUS));
    expect(renderStatus(STATUS, "text")).toBe(statusText(STATUS));
  });
});
