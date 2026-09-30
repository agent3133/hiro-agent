// Ported from tests/test_tools_vault_v2.py
import { describe, expect, it } from "vitest";

import { makeVault } from "../testing/vault";

const NOTES = {
  "Journal/Daily/2026-09-09.md": "# 2026-09-09\n\n- talked to [[Project Atlas]] team\n#meeting\n",
  "Projects/Project Atlas.md": "---\nstatus: active\ntags:\n  - project\n  - atlas\n---\n\n# Project Atlas\n\n- [ ] Draft API spec\n",
  "People/Maria Keller.md": "---\ntags: [person]\n---\nLeads [[Project Atlas]].\n",
};

describe("test_tools_vault_v2.py", () => {
  it("test_bare_file_name_resolves_to_the_only_match", async () => {
    const vault = await makeVault(NOTES);
    const result1 = await vault.tool("read_note").run({ path: "2026-09-09.md" });
    const result2 = await vault.tool("read_note").run({ path: "2026-09-09" });
    expect(result1).toContain("# 2026-09-09");
    expect(result2).toContain("# 2026-09-09");
  });

  it("test_wrong_path_names_the_real_note", async () => {
    const vault = await makeVault(NOTES);
    const result = await vault.tool("read_note").run({ path: "Atlas project" });
    expect(result.startsWith("Error: note not found")).toBe(true);
    expect(result).toContain("Projects/Project Atlas.md");
  });

  it("test_ambiguous_name_asks_for_the_full_path", async () => {
    const vault = await makeVault({ ...NOTES, "Archive/Project Atlas.md": "old copy" });
    const result = await vault.tool("read_note").run({ path: "Project Atlas.md" });
    expect(result).toContain("matches several notes");
    expect(result).toContain("Archive/Project Atlas.md");
  });

  it("test_missing_folder_suggests_an_existing_one", async () => {
    const vault = await makeVault(NOTES);
    const result = await vault.tool("list_notes").run({ path: "Journal/Meetings" });
    expect(result.startsWith("Error: folder not found")).toBe(true);
    expect(result).toContain("Journal/Daily");
  });

  it("test_edit_note_refuses_ambiguous_and_missing_text", async () => {
    const vault = await makeVault({ ...NOTES, "list.md": "- item\n- item\n" });
    const editTool = vault.tool("edit_note");

    const ambiguous = await editTool.run({ path: "list.md", old_text: "- item", new_text: "- done" });
    const text1 = await vault.read("list.md");
    const missing = await editTool.run({ path: "list.md", old_text: "- nope", new_text: "x" });

    expect(ambiguous).toContain("appears 2 times");
    expect(text1).toBe("- item\n- item\n");
    expect(missing).toContain("not found in");
  });

  it("test_edit_note_replace_all", async () => {
    const vault = await makeVault({ ...NOTES, "list.md": "- item\n- item\n" });
    const result = await vault.tool("edit_note").run({
      path: "list.md",
      old_text: "- item",
      new_text: "- done",
      replace_all: true,
    });
    const text = await vault.read("list.md");
    expect(result).toContain("2 replacements");
    expect(text).toBe("- done\n- done\n");
  });

  it("test_find_notes_by_substring_and_wildcard", async () => {
    const vault = await makeVault(NOTES);
    const findTool = vault.tool("find_notes");
    expect(await findTool.run({ pattern: "atlas" })).toBe("Projects/Project Atlas.md");
    expect(await findTool.run({ pattern: "*2026-09*" })).toBe("Journal/Daily/2026-09-09.md");
    expect(await findTool.run({ pattern: "*.md", folder: "People" })).toBe("People/Maria Keller.md");
  });

  it("test_find_notes_without_match_offers_the_closest", async () => {
    const vault = await makeVault(NOTES);
    const result = await vault.tool("find_notes").run({ pattern: "Atlas Projekt" });
    expect(result.startsWith("No notes match")).toBe(true);
    expect(result).toContain("Project Atlas");
  });

  it("test_search_vault_filters_by_tag_and_folder", async () => {
    const vault = await makeVault(NOTES);
    const searchTool = vault.tool("search_vault");
    expect((await searchTool.run({ tag: "person" })).startsWith("People/Maria Keller.md")).toBe(true);
    expect((await searchTool.run({ query: "Atlas", folder: "People" })).startsWith("People/")).toBe(true);
    expect((await searchTool.run({ tag: "meeting", query: "talked" })).startsWith("Journal/")).toBe(true);
    expect((await searchTool.run({}))).toContain("Error");
  });

  it("test_edit_note_changes_only_the_matched_text", async () => {
    const vault = await makeVault(NOTES);
    const result = await vault.tool("edit_note").run({
      path: "Projects/Project Atlas.md",
      old_text: "- [ ] Draft API spec",
      new_text: "- [x] Draft API spec",
    });
    const text = await vault.read("Projects/Project Atlas.md");
    expect(result.startsWith("Edited")).toBe(true);
    expect(text).toContain("- [x] Draft API spec");
    expect(text).toContain("status: active");
    expect(text).toContain("- atlas");
  });

  it("test_read_notes_returns_every_note_with_its_path", async () => {
    const vault = await makeVault(NOTES);
    const result = await vault.tool("read_notes").run({ paths: ["2026-09-09.md", "Projects/Project Atlas.md", "ghost.md"] });
    expect(result).toContain("## Journal/Daily/2026-09-09.md");
    expect(result).toContain("## Projects/Project Atlas.md");
    expect(result).toContain("# Project Atlas");
    expect(result).toContain("Error: note not found at 'ghost.md'");
  });

  it("test_suggestions_reach_metadata_and_write_tools", async () => {
    const vault = await makeVault(NOTES);
    const result1 = await vault.tool("get_metadata").run({ path: "Atlas project" });
    const result2 = await vault.tool("update_metadata").run({ path: "Atlas project", key: "status", value: "done" });
    const result3 = await vault.tool("append_to_note").run({ path: "2026-09-09x.md", text: "x" });
    expect(result1).toContain("Projects/Project Atlas.md");
    expect(result2).toContain("Projects/Project Atlas.md");
    expect(result3).toContain("Journal/Daily/2026-09-09.md");
  });
});
