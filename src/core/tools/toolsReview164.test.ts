// Tests for #164 — modifyFile, journalled, append_to_note, search_vault, TaskNotesSettings, suggestNotes,
// updateProfileSection
import { describe, expect, it, vi } from "vitest";

import { Journal, journalled } from "../journal";
import { fold } from "../paths";
import { makeVault, type TestVault } from "../testing/vault";
import { makeTools, type Tool } from "../tools";
import { modifyFile, type VaultPort } from "../vault";
import { TaskNotesSettings } from "./tasknotesTools";
import { updateProfileSection } from "./memoryTools";

/** Build a journalled vault for testing. */
async function booked(notes: Record<string, string> = {}): Promise<{ vault: TestVault; book: Journal; tool(name: string): Tool }> {
  const vault = await makeVault(notes);
  const book = new Journal(20);
  const tools = makeTools(journalled(vault.vault, book));
  return { vault, book, tool: (name) => tools.find((t) => t.name === name)! };
}

describe("toolsReview164", () => {
  // 1. modifyFile on a port without modify (vault.vault) applies the change to the current text, writes it and
  //    returns the written text.
  it("modifyFile_applies_change_and_returns_written_text", async () => {
    const vault = await makeVault({ "note.md": "hello world" });
    const result = await modifyFile(vault.vault, "note.md", (text) => text.replace("world", "universe"));
    expect(result).toBe("hello universe");
    expect(await vault.read("note.md")).toBe("hello universe");
  });

  // 2. modifyFile on a port object with a modify method calls that method (spy on it) and does not call write.
  it("modifyFile_calls_port_modify_when_available", async () => {
    const vault = await makeVault({ "note.md": "hello world" });
    const modifySpy = vi.fn(async (path: string, change: (text: string) => string) => {
      const text = await vault.vault.read(path);
      const result = change(text);
      await vault.vault.write(path, result);
      return result;
    });
    const writeSpy = vi.fn(vault.vault.write);
    const portWithModify: VaultPort = {
      ...vault.vault,
      write: writeSpy,
      modify: modifySpy,
    };
    const result = await modifyFile(portWithModify, "note.md", (text) => text.replace("world", "universe"));
    expect(result).toBe("hello universe");
    expect(modifySpy).toHaveBeenCalledTimes(1);
    expect(modifySpy).toHaveBeenCalledWith("note.md", expect.any(Function));
    expect(writeSpy).not.toHaveBeenCalled();
  });

  // 3. journalled(port, journal): its modify records one change with op "modify", before = the text before and
  //    after = the text written.
  it("journalled_modify_records_one_change", async () => {
    const { book, tool } = await booked({ "Existing.md": "first line\n" });
    book.begin("test modify");
    // append_to_note goes through modifyFile, so through the journalled port's modify
    await tool("append_to_note").run({ path: "Existing.md", text: "changed" });
    const turn = book.finish()!;
    expect(turn.changes.map((c) => c.op)).toEqual(["modify"]);
    expect(turn.changes[0].before).toBe("first line\n");
    expect(turn.changes[0].after).toBe("first line\nchanged");
  });

  // 4. append_to_note: an empty note becomes exactly the text; a note "a\n" becomes "a\nb"; a note "a" becomes "a\nb".
  it("append_to_note_empty_note_becomes_text", async () => {
    const vault = await makeVault({ "empty.md": "" });
    await vault.tool("append_to_note").run({ path: "empty.md", text: "hello" });
    expect(await vault.read("empty.md")).toBe("hello");
  });

  it("append_to_note_note_ending_with_newline_appends", async () => {
    const vault = await makeVault({ "trailing.md": "a\n" });
    await vault.tool("append_to_note").run({ path: "trailing.md", text: "b" });
    expect(await vault.read("trailing.md")).toBe("a\nb");
  });

  it("append_to_note_note_without_newline_gets_one", async () => {
    const vault = await makeVault({ "noNewline.md": "a" });
    await vault.tool("append_to_note").run({ path: "noNewline.md", text: "b" });
    expect(await vault.read("noNewline.md")).toBe("a\nb");
  });

  // 5. search_vault with folder "Inbox" on a port wrapper whose read/cachedRead count calls: notes outside Inbox
  //    are never read, and cachedRead is used instead of read when the port has it.
  it("search_vault_folder_filter_does_not_read_outside_folder", async () => {
    const vault = await makeVault({
      "Inbox/note.md": "search me",
      "Other/note.md": "don't find me",
    });
    const readPaths: string[] = [];
    const wrapped: VaultPort = {
      ...vault.vault,
      read: async (path: string) => { readPaths.push(path); return vault.vault.read(path); },
    };
    const searchTool = makeTools(wrapped).find((t) => t.name === "search_vault")!;
    expect(await searchTool.run({ query: "me", folder: "Inbox" })).toContain("Inbox/note.md");
    // Other/note.md also contains "me", but lies outside the folder: it is never read
    expect(readPaths).toEqual(["Inbox/note.md"]);
  });

  it("search_vault_uses_cachedRead_when_available", async () => {
    const vault = await makeVault({
      "Inbox/note.md": "search me",
    });
    let readCount = 0;
    let cachedReadCount = 0;
    const wrapped: VaultPort = {
      ...vault.vault,
      read: async (path: string) => { readCount++; return vault.vault.read(path); },
      cachedRead: async (path: string) => { cachedReadCount++; return vault.vault.read(path); },
    };
    const tools = makeTools(wrapped);
    const searchTool = tools.find((t) => t.name === "search_vault")!;
    await searchTool.run({ query: "search", folder: "Inbox" });
    // cachedRead should have been called
    expect(cachedReadCount).toBeGreaterThanOrEqual(1);
    expect(readCount).toBe(0);
  });

  // 6. TaskNotesSettings.read(vault, ".config") reads ".config/plugins/tasknotes/data.json" and with no argument
  //    it reads ".obsidian/plugins/tasknotes/data.json".
  it("TaskNotesSettings_reads_custom_config_path", async () => {
    const vault = await makeVault({
      ".config/plugins/tasknotes/data.json": JSON.stringify({ tasksFolder: "Work/Tasks" }),
    });
    const settings = await TaskNotesSettings.read(vault.vault, ".config");
    expect(settings.folder).toBe("Work/Tasks");
  });

  it("TaskNotesSettings_reads_default_config_path", async () => {
    const vault = await makeVault({
      ".obsidian/plugins/tasknotes/data.json": JSON.stringify({ tasksFolder: "Default/Tasks" }),
    });
    const settings = await TaskNotesSettings.read(vault.vault);
    expect(settings.folder).toBe("Default/Tasks");
  });

  // 7. suggestNotes with "Buroumzug" suggests "Journal/2026-09-16 Büroumzug.md"; fold turns "Büroumzug" into
  //    "buroumzug" and "Straße" into "strasse".
  it("suggestNotes_finds_notes_with_accents", async () => {
    const vault = await makeVault({
      "Journal/2026-09-16 Büroumzug.md": "content",
    });
    const suggestions = await import("../vault").then((m) => m.suggestNotes(vault.vault, "Buroumzug"));
    expect(suggestions).toContain("Journal/2026-09-16 Büroumzug.md");
  });

  it("fold_folds_umlauts_and_eszett", async () => {
    expect(fold("Büroumzug")).toBe("buroumzug");
    expect(fold("Straße")).toBe("strasse");
  });

  // 8. updateProfileSection with section "identity" replaces the existing "## Identity" section instead of adding
  //    a second one.
  it("updateProfileSection_replaces_existing_section", async () => {
    const vault = await makeVault({
      ".memory/user-profile.md": "---\ntype: user-profile\n---\n## Identity\n\nOriginal content\n\n## Preferences\n\nHobbies",
    });
    await updateProfileSection(vault.vault, ".memory/user-profile.md", "identity", "New content");
    const content = await vault.read(".memory/user-profile.md");
    // Should have exactly one "## Identity" line (case-sensitive)
    const identityLines = content.split("\n").filter((line) => line.startsWith("## Identity"));
    expect(identityLines.length).toBe(1);
    // Should not have a lowercase "## identity"
    expect(content).not.toContain("## identity");
    expect(content).toContain("New content");
  });
});
