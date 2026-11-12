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

  describe("several open turns (#206)", () => {
    it("1: two turns begun one after the other keep their changes apart", () => {
      const journal = new Journal();
      const a = journal.begin("turn a");
      const b = journal.begin("turn b");
      journal.record({ op: "create", path: "a.md", before: null, after: "A" }, a);
      journal.record({ op: "create", path: "b.md", before: null, after: "B" }, b);
      const turnA = journal.finish(a)!;
      const turnB = journal.finish(b)!;
      expect(turnA.changes.map((c) => c.path)).toEqual(["a.md"]);
      expect(turnB.changes.map((c) => c.path)).toEqual(["b.md"]);
    });

    it("2: beginning a second turn does not close the first", () => {
      const journal = new Journal();
      const firstId = journal.begin("first");
      journal.begin("second");
      journal.record({ op: "create", path: "first.md", before: null, after: "First" }, firstId);
      const turn = journal.finish(firstId)!;
      expect(turn.changes.map((c) => c.path)).toEqual(["first.md"]);
    });

    it("3: record and finish without an id go to the turn begun last", () => {
      const journal = new Journal();
      journal.begin("first");
      journal.begin("second");
      journal.record({ op: "create", path: "last.md", before: null, after: "Last" });
      const turn = journal.finish()!;
      expect(turn.changes.map((c) => c.path)).toEqual(["last.md"]);
    });

    it("4: finish(id) of an already finished turn returns null, and turns() holds it only once", () => {
      const journal = new Journal();
      const id = journal.begin("once");
      journal.record({ op: "create", path: "x.md", before: null, after: "X" });
      journal.finish(id);
      const again = journal.finish(id);
      expect(again).toBeNull();
      expect(journal.turns().length).toBe(1);
    });

    it("5: a change recorded with an id while undoing another turn is still kept", async () => {
      const journal = new Journal();
      const xId = journal.begin("turn X");
      journal.record({ op: "create", path: "x.md", before: null, after: "X" }, xId);
      journal.finish(xId);

      const yId = journal.begin("turn Y");

      const vault = {
        isFile: async (path: string) => path === "x.md",
        read: async (path: string) => {
          if (path === "x.md") return "X";
          return "";
        },
        remove: async (path: string) => {
          if (path === "x.md") {
            journal.record({ op: "create", path: "y.md", before: null, after: "Y" }, yId);
          }
        },
      } as unknown as Parameters<Journal["undo"]>[1];

      const turnX = journal.find(xId)!;
      await journal.undo(turnX, vault);

      const turnY = journal.finish(yId)!;
      expect(turnY.changes.map((c) => c.path)).toContain("y.md");
    });

    it("undoes, from a journal saved and read back after a restart, what the turn changed (#410)", async () => {
      const { book, tool, vault } = await booked({ "Existing.md": "first line\n" });

      book.begin("write some notes");
      await tool("create_note").run({ path: "One.md", content: "one\n" });
      await tool("append_to_note").run({ path: "Existing.md", text: "second line" });
      book.finish();

      // A new journal, as after a restart, from what was saved
      const restarted = new Journal();
      restarted.restore(JSON.parse(JSON.stringify(book.saved())));
      expect(restarted.turns()).toHaveLength(1);

      const result = await restarted.undo(restarted.turns()[0], vault.vault);

      expect(result.restored.length > 0 && result.refused.length === 0).toBe(true);
      expect(await vault.exists("One.md")).toBe(false);
      expect(await vault.read("Existing.md")).toBe("first line\n");
    });

    it("still refuses, after a restart, a note changed since the agent wrote it (#410)", async () => {
      const { book, tool, vault } = await booked({ "Mine.md": "original\n" });

      book.begin("edit two notes");
      await tool("update_note").run({ path: "Mine.md", content: "the agent's version\n" });
      book.finish();

      await vault.vault.write("Mine.md", "and then I edited it myself\n");

      const restarted = new Journal();
      restarted.restore(JSON.parse(JSON.stringify(book.saved())));

      const result = await restarted.undo(restarted.turns()[0], vault.vault);

      expect(result.refused.map((r) => r.path)).toEqual(["Mine.md"]);
      expect(result.refused[0].reason).toContain("changed after the agent wrote it");
      expect(await vault.read("Mine.md")).toBe("and then I edited it myself\n");
    });

    it("keeps only the newest saved turns within the journal's limit (#410)", async () => {
      const { book, tool } = await booked({}, 20);

      for (let index = 0; index < 3; index++) {
        book.begin(`turn ${index}`);
        await tool("create_note").run({ path: `${index}.md`, content: "x" });
        book.finish();
      }

      const saved = book.saved();
      const newBook = new Journal(2);
      newBook.restore(saved);

      expect(newBook.turns().map((t) => t.id)).toEqual([saved.turns[1].id, saved.turns[2].id]);
    });

    it("reads nothing from a damaged or unknown saved journal (#410)", async () => {
      const { book } = await booked({});

      book.restore(null);
      expect(book.turns()).toEqual([]);

      book.restore({ version: 2, turns: [] });
      expect(book.turns()).toEqual([]);

      book.restore({ version: 1, turns: [{ id: "x", changes: [{ op: "bogus", path: "a" }] }] });
      expect(book.turns()).toEqual([]);
    });

    it("puts the saved turns before the ones answered since the start, which stay the newest (#410)", async () => {
      const before = await booked({});
      const aId = before.book.begin("turn A");
      await before.tool("create_note").run({ path: "a.md", content: "A" });
      before.book.finish(aId);

      // After the restart: turn B is answered before the saved journal is read
      const after = await booked({});
      const bId = after.book.begin("turn B");
      await after.tool("create_note").run({ path: "b.md", content: "B" });
      after.book.finish(bId);
      after.book.restore(JSON.parse(JSON.stringify(before.book.saved())));

      expect(after.book.turns().map((t) => t.id)).toEqual([aId, bId]);
    });
  });
});
