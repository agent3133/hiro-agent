// A tool whose Features switch is off is not offered, and what is off is said (#145).
import { describe, expect, it } from "vitest";

import { makeVault } from "../core/testing/vault";
import { AgentCatalog, unusableTools } from "./agents";
import { writtenOutKey } from "./connections";
import { featurePrompt, switchedOffTools } from "./features";

const WEB_ON = { builtin_tools: { web_fetch: { enabled: true } } };

describe("switchedOffTools", () => {
  it("has web pages and memory off in a new vault, by the switches' defaults", () => {
    expect(switchedOffTools({})).toEqual({ web_fetch: "Open web pages", read_user_memory: "Memory",
                                           update_user_memory: "Memory" });
  });

  it("follows the switches", () => {
    expect(switchedOffTools({ ...WEB_ON, memory: { enabled: true } })).toEqual({});
    expect(switchedOffTools(WEB_ON)).toEqual({ read_user_memory: "Memory", update_user_memory: "Memory" });
  });
});

describe("featurePrompt", () => {
  it("tells the model what is off and where the user switches it on", () => {
    const text = featurePrompt(["read_note", "web_fetch"], {});
    expect(text).toContain("Opening web pages is switched off in this vault's settings (Settings → Hiro Agent → Features → Open web pages)");
    expect(text).toContain("do not claim you cannot do it at all");
  });

  it("names a switch once however many of its tools are listed", () => {
    const text = featurePrompt(["read_user_memory", "update_user_memory"], {});
    expect(text.match(/Features → Memory/g)).toHaveLength(1);
  });

  it("says nothing when the listed tools are on, or none belongs to a switch", () => {
    expect(featurePrompt(["web_fetch"], WEB_ON)).toBe("");
    expect(featurePrompt(["read_note", "move_note"], {})).toBe("");
  });
});

describe("the Agents tab's tools", () => {
  it("carry the switch that is off, and only then", async () => {
    const vault = await makeVault();
    let values: Record<string, unknown> = {};
    const catalog = new AgentCatalog(vault.vault, () => ({ defaultAgent: "assistant", profiles: [] }), async () => [],
                                     () => switchedOffTools(values));
    expect((await catalog.tools()).find((tool) => tool.name === "web_fetch")?.off_in).toBe("Open web pages");
    expect((await catalog.tools()).find((tool) => tool.name === "read_note")?.off_in).toBeUndefined();
    values = WEB_ON;
    expect((await catalog.tools()).find((tool) => tool.name === "web_fetch")?.off_in).toBeUndefined();
  });
});

describe("unusableTools (#146)", () => {
  const known = ["read_note", "web_fetch", "test__echo"];

  it("names tools the plugin does not have, apart from MCP tools whose server is off or unreachable", () => {
    expect(unusableTools(["read_note", "git", "tasknotes_cli", "everything__echo", "test__echo", "mcp:*"], known))
      .toEqual({ missing: ["git", "tasknotes_cli"], unreachable: ["everything__echo"] });
  });

  it("finds nothing in a list of tools the plugin has", () => {
    expect(unusableTools(["read_note", "web_fetch", "mcp:*"], known)).toEqual({ missing: [], unreachable: [] });
  });
});

describe("writtenOutKey (#146)", () => {
  it("is a key written out, not a reference or nothing", () => {
    const values = { llm_profiles: { cloud: { api_key: "sk-written-out" }, ref: { api_key: "${OPENAI_API_KEY}" },
                                     none: {} },
                     llm: { api_key: " ${K} " } };
    expect(writtenOutKey(values, "cloud")).toBe(true);
    expect(writtenOutKey(values, "ref")).toBe(false);
    expect(writtenOutKey(values, "none")).toBe(false);
    expect(writtenOutKey(values, "")).toBe(false);
  });
});
