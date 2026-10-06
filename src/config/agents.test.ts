// Ported from tests/test_server_agents.py — the agents, kept by the plugin (#86). Python's HTTP calls are the
// catalog's: `client.get("/agents/x").json()` is `await catalog.agent("x")`, `client.put("/agents/x", json=...)` is
// `await catalog.saveAgent("x", {...})` (422: `ok: false` with `fields`), `client.post("/agents", json={"name",
// "from"})` is `await catalog.createAgent(name, from)`, DELETE is `deleteAgent`, `.../reset` is `resetAgent`, and
// `/tools` is `await catalog.tools()`. A 404 or 409 is a thrown Error. The user's copy of a built-in agent is in
// the vault's `.agents/` (Python: the user agents folder), so `source` is "vault" where Python said "user".
import { describe, expect, it } from "vitest";

import type { ConfigFieldError } from "../api/types";
import { makeVault, type TestVault } from "../core/testing/vault";
import { AgentCatalog, RETIRED_TOOLS } from "./agents";
import bundled from "./bundled-agents.json";
import specs from "../core/tools/specs.json";

/** The Python `client` fixture: the catalog on a fresh vault, "default" the default agent, one connection. */
async function catalogWith(notes: Record<string, string> = {}, profiles = ["local"]):
    Promise<{ vault: TestVault; catalog: AgentCatalog }> {
  const vault = await makeVault(notes);
  return { vault, catalog: new AgentCatalog(vault.vault, () => ({ defaultAgent: "default", profiles })) };
}

/** `_read_default_bundled`: the built-in assistant's file as shipped. */
function assistantText(): string {
  return (bundled as { file: string; text: string }[]).find((b) => b.file === "assistant.md")!.text;
}

/** The field errors of a refused write (Python's 422 body `fields`); none for one that went through. */
function fieldErrors(result: { ok: true } | { ok: false; fields: ConfigFieldError[] }): ConfigFieldError[] {
  return result.ok ? [] : result.fields;
}

describe("test_server_agents.py", () => {
  it("test_get_default_agent_200", async () => {
    const { catalog } = await catalogWith();
    const body = await catalog.agent("assistant");
    expect(body.source).toBe("bundled");
    expect(body.can_reset).toBe(false);
    expect(body.prompt.length).toBeGreaterThan(0);
    expect(body.prompt).not.toContain("tools:");
  });

  it("test_put_agent_creates_user_copy", async () => {
    const { vault, catalog } = await catalogWith();
    const bundledBefore = assistantText();
    const result = await catalog.saveAgent("assistant", { prompt: "You are brief." });
    expect(result.ok).toBe(true);
    const content = await vault.read(".agents/assistant.md");
    expect(content.startsWith("---")).toBe(true);
    expect(content).toContain("tools:");
    expect(content).toContain("You are brief.");
    // Bundled file must be unchanged
    const bundledAfter = assistantText();
    expect(bundledAfter).toBe(bundledBefore);
  });

  it("test_put_then_get_shows_user_source", async () => {
    const { catalog } = await catalogWith();
    await catalog.saveAgent("assistant", { prompt: "You are brief." });
    const body = await catalog.agent("assistant");
    expect(body.source).toBe("vault");
    expect(body.can_reset).toBe(true);
    expect(body.prompt).toBe("You are brief.");
  });

  it("test_reset_drops_user_copy", async () => {
    const { vault, catalog } = await catalogWith();
    await catalog.saveAgent("assistant", { prompt: "You are brief." });
    expect(await vault.exists(".agents/assistant.md")).toBe(true);
    await catalog.resetAgent("assistant");
    expect(await vault.exists(".agents/assistant.md")).toBe(false);
    const body = await catalog.agent("assistant");
    expect(body.source).toBe("bundled");
  });

  it("test_put_agent_not_found_and_empty_prompt", async () => {
    const { vault, catalog } = await catalogWith();
    await expect(catalog.saveAgent("nosuchagent", { prompt: "x" })).rejects.toThrow("no agent called 'nosuchagent'");
    const result = await catalog.saveAgent("assistant", { prompt: "   " });
    expect(result.ok).toBe(false);
    // No user copy should have been created
    expect(await vault.exists(".agents/assistant.md")).toBe(false);
  });

  it("test_put_edit_user_agent_in_place", async () => {
    const { vault, catalog } = await catalogWith({ ".agents/mine.md": "---\nname: mine\ntools:\n  - read_note\n---\n\nOld prompt.\n" });
    const result = await catalog.saveAgent("mine", { prompt: "New prompt." });
    expect(result.ok).toBe(true);
    const content = await vault.read(".agents/mine.md");
    expect(content.startsWith("---\nname: mine\ntools:\n  - read_note\n---\n")).toBe(true);
    expect(content).toContain("New prompt.");
    expect(content).not.toContain("Old prompt.");
    // Reset should fail because mine is not a copy of a built-in agent
    await expect(catalog.resetAgent("mine")).rejects.toThrow("not a copy of a built-in agent");
  });

  it("test_get_tools_200", async () => {
    const { catalog } = await catalogWith();
    const tools = await catalog.tools();
    const byName = new Map(tools.map((t) => [t.name, t]));

    const readNote = byName.get("read_note");
    expect(readNote!.group).toBe("Read notes");

    // Python's git runs a program and ignores the scope. The plugin has no shell tools and no git (decided
    // 2026-09-29), and TaskNotes' creation is the tool that ignores the scope
    expect(byName.has("git")).toBe(false);
    expect(tools.some((t) => t.runs_programs)).toBe(false);
    expect(byName.get("create_tasknote")!.ignores_scope).toBe(true);

    const webFetch = byName.get("web_fetch");
    expect(webFetch!.leaves_machine).toBe(true);

    const deleteNote = byName.get("delete_note");
    expect(deleteNote!.destructive).toBe(true);
  });

  it("test_put_agent_invalid_tool_422", async () => {
    const { vault, catalog } = await catalogWith();
    const result = await catalog.saveAgent("assistant", { fields: { tools: ["read_note", "no_such_tool"] } });
    expect(result.ok).toBe(false);
    const toolsError = fieldErrors(result).filter((e) => e.path === "tools");
    expect(toolsError.length).toBe(1);
    expect(toolsError[0].message).toContain("no_such_tool");
    expect(await vault.exists(".agents/assistant.md")).toBe(false);
  });

  it("test_put_agent_vault_scope_and_llm_profile", async () => {
    const { vault, catalog } = await catalogWith();
    // NoSuchFolder doesn't exist → 422
    const result1 = await catalog.saveAgent("assistant", { fields: { vault_scope: ["NoSuchFolder"] } });
    expect(result1.ok).toBe(false);
    const vaultErrors = fieldErrors(result1).filter((e) => e.path === "vault_scope");
    expect(vaultErrors.length).toBe(1);

    // Create the folder and try again
    await vault.folder("Journal");
    const result2 = await catalog.saveAgent("assistant", { fields: { vault_scope: ["Journal"] } });
    expect(result2.ok).toBe(true);

    // GET /agents/assistant should show vault_scope
    const body = await catalog.agent("assistant");
    expect(body.vault_scope).toEqual(["Journal"]);

    // llm_profile must be invalid (config has no llm_profiles)
    const result3 = await catalog.saveAgent("assistant", { fields: { llm_profile: "nope" } });
    expect(result3.ok).toBe(false);
    const llmErrors = fieldErrors(result3).filter((e) => e.path === "llm_profile");
    expect(llmErrors.length).toBe(1);
  });

  it("test_post_agents_create_from_default", async () => {
    const { vault, catalog } = await catalogWith();
    // POST /agents
    const result = await catalog.createAgent("research", "default");
    expect(result.ok).toBe(true);

    // File exists and contains name: research
    const agentFile = ".agents/research.md";
    expect(await vault.exists(agentFile)).toBe(true);
    const content = await vault.read(agentFile);
    expect(content).toContain("name: research");

    // GET /agents/research shows source=vault and prompt equal to default
    const bodyResearch = await catalog.agent("research");
    expect(bodyResearch.source).toBe("vault");

    const bodyDefault = await catalog.agent("assistant");
    expect(bodyResearch.prompt).toBe(bodyDefault.prompt);

    // GET /agents lists the agent
    const agents = await catalog.summaries();
    const researchEntry = agents.filter((a) => a.name === "research");
    expect(researchEntry.length).toBe(1);
    expect(researchEntry[0].source).toBe("vault");
  });

  it("test_post_agents_invalid_name", async () => {
    const { catalog } = await catalogWith();
    // Bad Name has a space — invalid
    const result1 = await catalog.createAgent("Bad Name", "default");
    expect(result1.ok).toBe(false);
    const nameErrors1 = fieldErrors(result1).filter((e) => e.path === "name");
    expect(nameErrors1.length).toBe(1);

    // default already exists
    const result2 = await catalog.createAgent("default", "default");
    expect(result2.ok).toBe(false);
    const nameErrors2 = fieldErrors(result2).filter((e) => e.path === "name");
    expect(nameErrors2.length).toBe(1);
  });

  it("test_delete_agents_research", async () => {
    const { vault, catalog } = await catalogWith();
    // First create research
    const result = await catalog.createAgent("research", "default");
    expect(result.ok).toBe(true);

    // DELETE research — should succeed
    const agentFile = ".agents/research.md";
    expect(await vault.exists(agentFile)).toBe(true);
    await catalog.deleteAgent("research");
    expect(await vault.exists(agentFile)).toBe(false);

    // DELETE daily-note — built in, should fail
    await expect(catalog.deleteAgent("daily-note")).rejects.toThrow("is built in and cannot be deleted");
  });

  it("test_a_tool_already_listed_does_not_block_a_save", async () => {
    const { catalog } = await catalogWith();
    const tools = (await catalog.agent("assistant")).tools;
    expect(tools).toContain("mcp:*");
    const result = await catalog.saveAgent("assistant", { fields: { tools: tools.filter((t) => t !== "git") } });
    expect(fieldErrors(result)).toEqual([]);
    if (!result.ok) return;
    expect(result.agent.tools).not.toContain("git");
    expect(result.agent.tools).toContain("mcp:*");
  });

  it("test_the_old_name_default_still_reaches_the_renamed_agent", async () => {
    const { catalog } = await catalogWith();
    const body = await catalog.agent("default");
    const agentsList = await catalog.summaries();
    const names = agentsList.map((a) => a.name);

    expect(body.name).toBe("assistant");
    expect(body.source).toBe("bundled");
    expect(names).toContain("assistant");
    expect(names).not.toContain("default");
  });
});

describe("the built-in agents", () => {
  // tasknotes_cli, a Python tool, stayed in them after the plugin took over, and the daily note agent told the
  // model to use it (found in the beta screenshots, #129)
  it("list only tools the plugin has, or MCP tools", async () => {
    const { catalog } = await catalogWith();
    const known = new Set((specs as { name: string }[]).map((spec) => spec.name));
    for (const name of ["assistant", "daily-note", "weekly-review"]) {
      const unknown = (await catalog.agent(name)).tools.filter((tool) => !known.has(tool) && !tool.startsWith("mcp:"));
      expect(unknown, name).toEqual([]);
    }
  });

  it("name no tool in their prompts that they do not have", async () => {
    const { catalog } = await catalogWith();
    for (const name of ["assistant", "daily-note", "weekly-review"]) {
      const agent = await catalog.agent(name);
      const named = [...agent.prompt.matchAll(/`([a-z]+(?:_[a-z]+)+)`/g)].map((match) => match[1]);
      expect(named.filter((tool) => !agent.tools.includes(tool)), name).toEqual([]);
    }
  });
});

describe("an agent listing MCP tools before this device listed the server (#178)", () => {
  async function catalogWith(servers: string[]) {
    const vault = await makeVault();
    return new AgentCatalog(vault.vault, () => ({ defaultAgent: "assistant", profiles: [] }), async () => [],
                            () => ({}), () => servers);
  }

  it("is saved when the tool's server is configured", async () => {
    const catalog = await catalogWith(["search"]);
    expect((await catalog.saveAgent("assistant", { fields: { tools: ["read_note", "search__web"] } })).ok).toBe(true);
  });

  it("is refused when no server of that name is configured", async () => {
    const catalog = await catalogWith(["search"]);
    const result = await catalog.saveAgent("assistant", { fields: { tools: ["other__web"] } });
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).toContain("there is no tool called 'other__web'");
  });
});

describe("tools the plugin no longer has", () => {
  // A copy of the assistant from an older version listed git, tasknotes_cli, web_search and list_bases, and the
  // Agents tab asked the user to remove them, as if they were the user's mistake (2026-10-05)
  const copy = "---\nname: assistant\ndescription: d\ntools:\n  - read_note\n  - git\n  - tasknotes_cli\n"
    + "  - web_search\n  - list_bases\n  - obsidian_cli\n  - made_up_tool\n---\nPrompt.\n";

  it("are dropped when an agent is read, while a name the plugin never had stays to be shown", async () => {
    const { catalog } = await catalogWith({ ".agents/assistant.md": copy });
    expect((await catalog.agent("assistant")).tools).toEqual(["read_note", "made_up_tool"]);
  });

  it("are left out of the file at the next save", async () => {
    const { vault, catalog } = await catalogWith({ ".agents/assistant.md": copy });
    const tools = (await catalog.agent("assistant")).tools.filter((tool) => tool !== "made_up_tool");
    const result = await catalog.saveAgent("assistant", { fields: { tools } });
    expect(result.ok).toBe(true);
    const text = await vault.read(".agents/assistant.md");
    for (const retired of RETIRED_TOOLS) expect(text).not.toContain(retired);
  });
});

describe("an agent's folders and the vault's config folder (#322)", () => {
  it("refuses the config folder the vault uses, renamed or not, and its subfolders", async () => {
    const vault = await makeVault({ ".config/app.json": "{}", ".obsidian/app.json": "{}", "Journal/a.md": "x" });
    const catalog = new AgentCatalog(vault.vault, () => ({ defaultAgent: "assistant", profiles: [], configDir: ".config" }));
    for (const folder of [".config", ".config/plugins", ".obsidian"]) {
      const result = await catalog.saveAgent("assistant", { fields: { vault_scope: [folder] } });
      expect(fieldErrors(result).map((error) => error.message)).toEqual([`'${folder}' is not a folder notes live in`]);
    }
    expect((await catalog.saveAgent("assistant", { fields: { vault_scope: ["Journal"] } })).ok).toBe(true);
  });
});
