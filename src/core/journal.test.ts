// Ported from tests/test_turn_journal.py — what a turn changed, and putting it back (#85). Python's `book` fixture is
// a Journal with the vault tools writing through `journalled(...)`; delete_note and move_note are Obsidian-only in
// the plugin (plugin/tests/obsidian-tools.smoke.ts covers them), so their tests are not ported here.
import { describe, expect, it } from "vitest";

import { Journal, journalled } from "./journal";
import { makeVault, type TestVault } from "./testing/vault";
import { makeTools, type Tool } from "./tools";

/** The `book` and `tools` fixtures: a journal, and the tools on a vault that reports to it. */
async function booked(notes: Record<string, string> = {}, maxTurns = 20):
    Promise<{ vault: TestVault; book: Journal; tool(name: string): Tool }> {
  const vault = await makeVault(notes);
  const book = new Journal(maxTurns);
  const tools = makeTools(journalled(vault.vault, book));
  return { vault, book, tool: (name) => tools.find((t) => t.name === name)! };
}

describe("test_turn_journal.py", () => {
  it("test_a_turn_records_what_it_wrote", async () => {
    const { book, tool } = await booked({ "Existing.md": "first line\n" });

    book.begin("write some notes");
    await tool("create_note").run({ path: "One.md", content: "one\n" });
    await tool("create_note").run({ path: "Two.md", content: "two\n" });
    await tool("append_to_note").run({ path: "Existing.md", text: "second line" });
    const turn = book.finish()!;

    expect(turn.changes.map((change) => change.op)).toEqual(["create", "create", "modify"]);
    expect(book.summary(turn)).toEqual(["created One.md", "created Two.md", "edited Existing.md"]);
    const diff = book.diff(turn);
    expect(diff).toContain("+one");
    expect(diff).toContain("+two");
    expect(diff).toContain("+second line");
  });

  it("test_undo_puts_the_vault_back_byte_for_byte", async () => {
    const { book, tool, vault } = await booked({ "Existing.md": "first line\n" });

    book.begin("write some notes");
    await tool("create_note").run({ path: "One.md", content: "one\n" });
    await tool("create_note").run({ path: "Two.md", content: "two\n" });
    await tool("append_to_note").run({ path: "Existing.md", text: "second line" });
    const turn = book.finish()!;

    const result = await book.undo(turn, vault.vault);

    expect(result.restored.length > 0 && result.refused.length === 0).toBe(true);
    expect(result.refused.length).toBe(0);
    expect(await vault.exists("One.md")).toBe(false);
    expect(await vault.exists("Two.md")).toBe(false);
    expect(await vault.read("Existing.md")).toBe("first line\n");
    expect(turn.undone).toBe(true);
  });

  it("test_a_note_edited_since_blocks_its_own_undo", async () => {
    const { book, tool, vault } = await booked({ "Mine.md": "original\n" });

    book.begin("edit two notes");
    await tool("update_note").run({ path: "Mine.md", content: "the agent's version\n" });
    await tool("create_note").run({ path: "Other.md", content: "other\n" });
    const turn = book.finish()!;

    await vault.vault.write("Mine.md", "and then I edited it myself\n");
    const result = await book.undo(turn, vault.vault);

    expect(result.refused.map((r) => r.path)).toEqual(["Mine.md"]);
    expect(result.refused[0].reason).toContain("changed after the agent wrote it");
    expect(await vault.read("Mine.md")).toBe("and then I edited it myself\n");
    expect(await vault.exists("Other.md")).toBe(false);
    expect(turn.undone).toBe(false);
  });

  it("test_undoing_an_undone_turn_is_a_no_op", async () => {
    const { book, tool, vault } = await booked({});

    book.begin("create one");
    await tool("create_note").run({ path: "One.md", content: "one\n" });
    const turn = book.finish()!;
    const firstUndo = await book.undo(turn, vault.vault);
    expect(firstUndo.restored.length > 0 && firstUndo.refused.length === 0).toBe(true);

    const again = await book.undo(turn, vault.vault);

    expect(again.restored).toEqual([]);
    expect(again.refused).toEqual([]);
    expect(await vault.exists("One.md")).toBe(false);
  });

  it("test_a_turn_that_changed_nothing_is_not_kept", async () => {
    const { book } = await booked({});

    book.begin("just a question");
    expect(book.finish()).toBeNull();
    expect(book.turns()).toEqual([]);
  });

  it("test_old_turns_are_dropped_when_the_cap_is_reached", async () => {
    const { book, tool } = await booked({}, 2);
    for (let index = 0; index < 4; index++) {
      book.begin(`turn ${index}`);
      await tool("create_note").run({ path: `${index}.md`, content: "x" });
      book.finish();
    }

    expect(book.turns().map((turn) => turn.prompt)).toEqual(["turn 2", "turn 3"]);
  });
});
