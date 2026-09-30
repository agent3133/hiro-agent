// `obsidian agent:list` and `agent:sessions` (#72): the agents and the saved conversations, as text and JSON.
import { describe, expect, it } from "vitest";

import { agentsJson, agentsText, sessionsJson, sessionsText } from "./lists";

const AGENTS = [
  { name: "assistant", description: "General help.\nMore.", source: "bundled" as const, default: true, tools: ["x"] },
  { name: "research", description: "Digs.", source: "vault" as const },
];
const SESSIONS = [
  { name: "2026-09-29-0928-which-notes", agent: "daily-note", model: "gpt-5.4-mini", connection: "cloud",
    exchanges: 3, updated: "2026-09-29T09:31:12" },
  { name: "old", agent: "", model: "", exchanges: 12, updated: "2026-09-01T10:00:00" },
];

describe("agent:list", () => {
  it("lists each agent in columns, marks the default, and says where it comes from", () => {
    expect(agentsText(AGENTS)).toBe([
      "*  assistant  built in  General help.",
      "   research   .agents/  Digs.",
      "",
      "* used when no agent is chosen",
    ].join("\n"));
  });

  it("answers JSON with name, description, source and default only", () => {
    expect(JSON.parse(agentsJson(AGENTS))).toEqual([
      { name: "assistant", description: "General help.\nMore.", source: "bundled", default: true },
      { name: "research", description: "Digs.", source: "vault", default: false },
    ]);
  });

  it("says when there are none", () => {
    expect(agentsText([])).toBe("No agents.");
  });
});

describe("agent:sessions", () => {
  it("lists the conversations under a header, a dash where the note names no agent or connection", () => {
    expect(sessionsText(SESSIONS)).toBe([
      "UPDATED           EXCHANGES  AGENT       CONNECTION  NAME",
      "2026-09-29 09:31  3          daily-note  cloud       2026-09-29-0928-which-notes",
      "2026-09-01 10:00  12         -           -           old",
    ].join("\n"));
  });

  it("answers JSON with every field, the connection empty when unknown", () => {
    expect(JSON.parse(sessionsJson(SESSIONS))[1]).toEqual(
      { name: "old", agent: "", connection: "", model: "", exchanges: 12, updated: "2026-09-01T10:00:00" });
  });

  it("says when there are none", () => {
    expect(sessionsText([])).toBe("No saved conversations.");
  });
});
