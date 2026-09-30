import { describe, expect, it } from "vitest";
import { makeVault } from "../testing/vault";
import { safeResolve, scopeHint, scopePrompt } from "../paths";

const NOTES = {
  "Notes/allowed.md": "notes content",
  "Journal/entry.md": "journal entry content",
  "Private/secret.md": "secret content",
  "root_note.md": "root content",
};

describe("test_vault_scope.py", () => {
  it("test_safe_resolve_no_scope_resolves_valid_path", async () => {
    const result = safeResolve("Notes/allowed.md");
    expect(result).toBe("Notes/allowed.md");
  });

  it("test_safe_resolve_no_scope_allows_any_subdir", () => {
    const result = safeResolve("Private/secret.md");
    expect(result).toBe("Private/secret.md");
  });

  it("test_safe_resolve_no_scope_none_value_is_noop", () => {
    const result = safeResolve("root_note.md", null);
    expect(result).toBe("root_note.md");
  });

  it("test_safe_resolve_allows_path_directly_inside_scoped_dir", () => {
    const result = safeResolve("Notes/allowed.md", ["Notes"]);
    expect(result).toBe("Notes/allowed.md");
  });

  it("test_safe_resolve_allows_path_when_one_of_multiple_scopes_matches", async () => {
    const result = safeResolve("Journal/entry.md", ["Notes", "Journal"]);
    expect(result).toBe("Journal/entry.md");
  });

  it("test_safe_resolve_allows_nested_path_inside_scoped_dir", async () => {
    const result = safeResolve("Notes/sub/deep.md", ["Notes"]);
    expect(result).toBe("Notes/sub/deep.md");
  });

  it("test_safe_resolve_allows_path_equal_to_scoped_dir_itself", async () => {
    const result = safeResolve("Notes", ["Notes"]);
    expect(result).toBe("Notes");
  });

  it("test_safe_resolve_blocks_path_outside_scope", async () => {
    expect(() => safeResolve("Private/secret.md", ["Notes"])).toThrow(
      /outside this agent's allowed scope/
    );
  });

  it("test_safe_resolve_blocks_root_level_note_when_scope_is_set", async () => {
    expect(() => safeResolve("root_note.md", ["Notes"])).toThrow(
      /outside this agent's allowed scope/
    );
  });

  it("test_safe_resolve_error_message_includes_path_and_scope", async () => {
    try {
      safeResolve("Private/secret.md", ["Notes"]);
      expect.fail("should have thrown");
    } catch (e: any) {
      expect(e.message).toContain("Private/secret.md");
      expect(e.message).toContain("Notes");
    }
  });

  it("test_safe_resolve_blocks_path_outside_all_multiple_scopes", async () => {
    expect(() => safeResolve("Private/secret.md", ["Notes", "Journal"])).toThrow(
      /outside this agent's allowed scope/
    );
  });

  it("test_safe_resolve_empty_scope_allows_any_subdir", async () => {
    const result = safeResolve("Private/secret.md", []);
    expect(result).toBe("Private/secret.md");
  });

  it("test_safe_resolve_empty_scope_allows_root_note", async () => {
    const result = safeResolve("root_note.md", []);
    expect(result).toBe("root_note.md");
  });

  it("test_safe_resolve_traversal_blocked_with_active_scope", async () => {
    expect(() => safeResolve("../../etc/passwd", ["Notes"])).toThrow();
  });

  it("test_safe_resolve_traversal_blocked_without_scope", async () => {
    expect(() => safeResolve("../outside.md")).toThrow();
  });

  it("test_safe_resolve_traversal_via_scope_dir_still_blocked", async () => {
    expect(() => safeResolve("Notes/../../etc/passwd", ["Notes"])).toThrow();
  });

  it("test_safe_resolve_blocks_agents_dir", async () => {
    expect(() => safeResolve(".agents/evil.md")).toThrow(/.agents/);
  });

  it("test_safe_resolve_blocks_tools_dir", async () => {
    expect(() => safeResolve(".tools/evil.md")).toThrow(/.tools/);
  });

  it("test_safe_resolve_allows_normal_path", async () => {
    const result = safeResolve("Notes/a.md");
    expect(result).toBe("Notes/a.md");
  });

  it("test_list_notes_no_path_with_scope_returns_only_scoped_dirs", async () => {
    const vault = await makeVault(NOTES);
    const result = await vault.tool("list_notes", ["Notes", "Journal"]).run({ path: "", recursive: false });
    expect(result).toContain("allowed.md");
    expect(result).toContain("entry.md");
    expect(result).not.toContain("secret.md");
    expect(result).not.toContain("root_note.md");
  });

  it("test_list_notes_no_path_with_scope_excludes_unscoped_dir", async () => {
    const vault = await makeVault(NOTES);
    const result = await vault.tool("list_notes", ["Notes"]).run({ path: "", recursive: false });
    expect(result).not.toContain("entry.md");
    expect(result).not.toContain("secret.md");
  });

  it("test_list_notes_explicit_path_inside_scope_is_allowed", async () => {
    const vault = await makeVault(NOTES);
    const result = await vault.tool("list_notes", ["Notes"]).run({ path: "Notes", recursive: false });
    expect(result).toContain("allowed.md");
    expect(result).not.toContain("Error");
  });

  it("test_list_notes_explicit_path_outside_scope_returns_error", async () => {
    const vault = await makeVault(NOTES);
    const result = await vault.tool("list_notes", ["Notes"]).run({ path: "Private", recursive: false });
    expect(result).toContain("Error");
    expect(result.toLowerCase()).toContain("scope");
  });

  it("test_list_notes_no_scope_returns_all_vault_files", async () => {
    const vault = await makeVault(NOTES);
    const result = await vault.tool("list_notes").run({ path: "", recursive: true });
    expect(result).toContain("allowed.md");
    expect(result).toContain("entry.md");
    expect(result).toContain("secret.md");
    expect(result).toContain("root_note.md");
  });

  it("test_list_notes_no_path_with_nonexistent_scope_dir_returns_empty", async () => {
    const vault = await makeVault(NOTES);
    const result = await vault.tool("list_notes", ["NonExistent"]).run({ path: "", recursive: false });
    expect(result.trim()).toBe("");
  });

  it("test_search_vault_with_multiple_scopes_finds_match_in_each", async () => {
    const vault = await makeVault(NOTES);
    const result = await vault.tool("search_vault", ["Notes", "Journal"]).run({ query: "journal entry content" });
    expect(result).toContain("entry.md");
  });

  it("test_search_vault_with_scope_returns_empty_for_no_match", async () => {
    const vault = await makeVault(NOTES);
    const result = await vault.tool("search_vault", ["Notes"]).run({ query: "zyxwvutsrq_nomatch" });
    // Python answers "". The plugin says where it looked, so the model does not tell the user a note outside the
    // agent's folders does not exist (a deliberate difference, 2026-09-29)
    expect(result).toBe(`No notes found${scopeHint(["Notes"])}`);
    expect(result).toContain("only 'Notes/' searched");
  });

  it("an unrestricted search_vault still answers nothing for no match, as Python does", async () => {
    const vault = await makeVault(NOTES);
    expect(await vault.tool("search_vault").run({ query: "zyxwvutsrq_nomatch" })).toBe("");
  });

  it("find_notes with a scope says only its folders were searched", async () => {
    const vault = await makeVault(NOTES);
    const result = await vault.tool("find_notes", ["Notes"]).run({ pattern: "zyxwvutsrq_nomatch" });
    expect(result.startsWith(`No notes match 'zyxwvutsrq_nomatch' (only 'Notes/' searched`)).toBe(true);
    expect(result).toContain("tell the user so rather than that the note does not exist");
  });

  it("the system prompt tells a restricted agent its folders, and nothing to one without", () => {
    expect(scopePrompt(["Journal/Daily"])).toContain("You can only reach notes in 'Journal/Daily/'");
    expect(scopePrompt(["Journal/Daily"])).toContain("Never say such a note does not exist.");
    expect(scopePrompt(null)).toBe("");
    expect(scopePrompt([])).toBe("");
  });

  it("find_notes without a scope answers as Python does", async () => {
    const vault = await makeVault(NOTES);
    expect(await vault.tool("find_notes").run({ pattern: "zyxwvutsrq_nomatch" })).toBe("No notes match 'zyxwvutsrq_nomatch'");
  });

  it("test_search_vault_with_scope_excludes_journal_when_not_in_scope", async () => {
    const vault = await makeVault(NOTES);
    const result = await vault.tool("search_vault", ["Notes"]).run({ query: "journal entry content" });
    expect(result).not.toContain("entry.md");
  });

  it("test_search_vault_with_scope_finds_match_in_scoped_dir", async () => {
    const vault = await makeVault(NOTES);
    await vault.write("Notes/allowed.md", "unique_scoped_term");
    const scope = ["Notes"];
    const result = await vault.tool("search_vault", scope).run({ query: "unique_scoped_term" });
    expect(result).toContain("allowed.md");
  });

  it("test_search_vault_with_scope_does_not_return_unscoped_match", async () => {
    const vault = await makeVault(NOTES);
    const scope = ["Notes"];
    const result = await vault.tool("search_vault", scope).run({ query: "secret content" });
    expect(result).not.toContain("secret.md");
  });

  it("test_search_vault_without_scope_finds_content_in_all_dirs", async () => {
    const vault = await makeVault(NOTES);
    const result = await vault.tool("search_vault", null).run({ query: "secret content" });
    expect(result).toContain("secret.md");
  });
});
