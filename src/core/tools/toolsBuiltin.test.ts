// Ported from tests/test_tools_builtin.py — the six tools of the test port (#76). Same inputs, same expected results.
import { describe, expect, it } from "vitest";

import { basename, PathError, safeResolve } from "../paths";
import { makeVault } from "../testing/vault";

describe("test_tools_builtin.py", () => {
  it("test_safe_resolve_valid", () => {
    expect(safeResolve("notes/a.md")).toBe("notes/a.md");
  });

  it("test_safe_resolve_traversal_blocked", () => {
    expect(() => safeResolve("../../etc/passwd")).toThrow(PathError);
    expect(() => safeResolve("../../etc/passwd")).toThrow(/escape/);
  });

  it("test_read_note_returns_content", async () => {
    const vault = await makeVault({ "note.md": "Hello World" });
    const result = await vault.tool("read_note").run({ path: "note.md" });
    expect(result).toContain("Hello World");
  });

  it("test_create_note_creates_file", async () => {
    const vault = await makeVault();
    await vault.tool("create_note").run({ path: "new.md", content: "content here" });
    expect(await vault.read("new.md")).toBe("content here");
  });

  it("test_create_note_no_overwrite_raises", async () => {
    const vault = await makeVault({ "exists.md": "old" });
    const result = await vault.tool("create_note").run({ path: "exists.md", content: "new", overwrite: false });
    expect(result.toLowerCase().includes("exists") || result.toLowerCase().includes("error")).toBe(true);
  });

  it("test_safe_resolve_absolute_outside_blocked", () => {
    expect(() => safeResolve("/etc/passwd")).toThrow(/escape/);
  });

  it("test_read_note_missing_returns_error", async () => {
    const vault = await makeVault();
    const result = await vault.tool("read_note").run({ path: "missing.md" });
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  it("test_create_note_overwrite_replaces", async () => {
    const vault = await makeVault({ "exists.md": "old" });
    await vault.tool("create_note").run({ path: "exists.md", content: "new content", overwrite: true });
    expect(await vault.read("exists.md")).toBe("new content");
  });

  it("test_list_notes_flat", async () => {
    const vault = await makeVault({ "a.md": "", "b.md": "", "sub/c.md": "" });
    const result = await vault.tool("list_notes").run({ path: "", recursive: false });
    expect(result).toContain("a.md");
    expect(result).toContain("b.md");
  });

  it("test_list_notes_recursive", async () => {
    const vault = await makeVault({ "root.md": "", "sub/nested.md": "" });
    const result = await vault.tool("list_notes").run({ path: "", recursive: true });
    expect(result).toContain("nested.md");
  });

  it("test_search_vault_finds_match", async () => {
    const vault = await makeVault({ "note.md": "This is about pandas and data science" });
    const result = await vault.tool("search_vault").run({ query: "pandas" });
    expect(result).toContain("note.md");
  });

  it("test_search_vault_no_match", async () => {
    const vault = await makeVault({ "note.md": "completely unrelated content" });
    const result = await vault.tool("search_vault").run({ query: "zyxwvutsrqponmlkji" });
    // Python answered "": in words since #160, as an empty answer reads to a small model as a broken tool
    expect(result).toBe("No notes contain 'zyxwvutsrqponmlkji'. Try fewer or other words, or find_notes to search by name.");
  });

  it("test_list_notes_subdirectory", async () => {
    const vault = await makeVault({ "root.md": "", "sub/nested.md": "" });
    const result = await vault.tool("list_notes").run({ path: "sub", recursive: false });
    expect(result).toContain("nested.md");
    expect(result).not.toContain("root.md");
  });

  it("test_list_notes_empty_vault_returns_empty", async () => {
    const vault = await makeVault({});
    const result = await vault.tool("list_notes").run({ path: "", recursive: false });
    expect(result.trim()).toBe("");
  });

  it("test_search_vault_case_insensitive", async () => {
    const vault = await makeVault({ "note.md": "Pandas is a data library" });
    const result = await vault.tool("search_vault").run({ query: "pandas" });
    expect(result).toContain("note.md");
  });

  it("test_search_vault_limit_respected", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 25; i++) {
      files[`note_${String(i).padStart(2, "0")}.md`] = "findme here";
    }
    const vault = await makeVault(files);
    const result = await vault.tool("search_vault").run({ query: "findme", limit: 5 });
    const lines = result.trim().split("\n").filter((ln) => ln);
    expect(lines.length).toBeLessThanOrEqual(5);
  });

  it("test_search_vault_returns_snippet", async () => {
    const vault = await makeVault({ "note.md": "The quick brown fox jumps over the lazy dog" });
    const result = await vault.tool("search_vault").run({ query: "brown fox" });
    expect(result.toLowerCase()).toContain("brown fox");
  });

  it("test_obsidian_configuration_is_not_writable_by_tools[.obsidian/plugins/obsidian-agent/data.json]", () => {
    expect(() => safeResolve(".obsidian/plugins/obsidian-agent/data.json")).toThrow(/Obsidian's own configuration/);
  });

  it("test_obsidian_configuration_is_not_writable_by_tools[.obsidian/app.json]", () => {
    expect(() => safeResolve(".obsidian/app.json")).toThrow(/Obsidian's own configuration/);
  });

  it("test_obsidian_configuration_is_not_writable_by_tools[.obsidian]", () => {
    expect(() => safeResolve(".obsidian")).toThrow(/Obsidian's own configuration/);
  });

  it("test_obsidian_configuration_is_not_writable_by_tools[./.obsidian/hotkeys.json]", () => {
    expect(() => safeResolve("./.obsidian/hotkeys.json")).toThrow(/Obsidian's own configuration/);
  });

  it("test_a_note_merely_named_like_it_is_fine", () => {
    expect(basename(safeResolve("Notes/.obsidian notes.md"))).toBe(".obsidian notes.md");
    expect(basename(safeResolve("obsidian/Plugins.md"))).toBe("Plugins.md");
  });

  it("test_update_note_replaces_content", async () => {
    const vault = await makeVault({ "note.md": "original" });
    await vault.tool("update_note").run({ path: "note.md", content: "replaced" });
    expect(await vault.read("note.md")).toBe("replaced");
  });

  it("test_update_note_is_destructive", async () => {
    const vault = await makeVault({});
    expect(vault.tool("update_note").destructive).toBe(true);
  });

  it("test_append_to_note_adds_text", async () => {
    const vault = await makeVault({ "note.md": "first line" });
    await vault.tool("append_to_note").run({ path: "note.md", text: "second line" });
    const content = await vault.read("note.md");
    expect(content).toContain("first line");
    expect(content).toContain("second line");
  });

  it("test_update_note_missing_returns_error", async () => {
    const vault = await makeVault({});
    const result = await vault.tool("update_note").run({ path: "nonexistent.md", content: "new content" });
    expect(result.toLowerCase()).toContain("error");
  });

  it("test_append_to_note_missing_returns_error", async () => {
    const vault = await makeVault({});
    const result = await vault.tool("append_to_note").run({ path: "nonexistent.md", text: "extra line" });
    expect(result.toLowerCase()).toContain("error");
  });
});
