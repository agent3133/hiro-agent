// Going back to an earlier message (#303): the conversation without its last exchanges, and the answers' changes
// taken back newest first.
import { describe, expect, it } from "vitest";

import { Journal, journalled } from "./journal";
import { undoTurns, withoutLast } from "./rewind";
import { makeVault } from "./testing/vault";

const conversation = [
  { role: "system", content: "summary" },
  { role: "user", content: "q1" },
  { role: "assistant", content: "a1" },
  { role: "user", content: "q2" },
  { role: "assistant", content: "a2" },
  { role: "user", content: "q3" },
  { role: "assistant", content: "a3" },
];

describe("withoutLast", () => {
  it("drops the last exchanges and keeps the summary before them", () => {
    expect(withoutLast(conversation, 2)).toEqual([
      { role: "system", content: "summary" },
      { role: "user", content: "q1" },
      { role: "assistant", content: "a1" },
    ]);
  });

  it("keeps everything for 0, and only the summary for more exchanges than there are", () => {
    expect(withoutLast(conversation, 0)).toEqual(conversation);
    expect(withoutLast(conversation, 5)).toEqual([{ role: "system", content: "summary" }]);
  });

  it("drops a last question that has no answer yet", () => {
    expect(withoutLast([{ role: "user", content: "q1" }, { role: "assistant", content: "a1" },
                        { role: "user", content: "q2" }], 1))
      .toEqual([{ role: "user", content: "q1" }, { role: "assistant", content: "a1" }]);
  });
});

describe("undoTurns", () => {
  it("takes back two answers newest first, an edit and the notes they made", async () => {
    const vault = await makeVault();
    const journal = new Journal();
    const first = journal.begin("Turn A");
    await journalled(vault.vault, journal).write("Notes/a.md", "content A");
    journal.finish();
    const second = journal.begin("Turn B");
    const port = journalled(vault.vault, journal);
    await port.write("Notes/a.md", "content B");
    await port.write("Notes/b.md", "content B");
    journal.finish();

    const result = await undoTurns(journal, vault.vault, [second, first]);
    expect(await vault.exists("Notes/a.md")).toBe(false);
    expect(await vault.exists("Notes/b.md")).toBe(false);
    expect(result.restored).toEqual(["Notes/b.md", "Notes/a.md", "Notes/a.md"]);
    expect(result.refused).toEqual([]);
  });

  it("skips an answer undone already, and names one the journal no longer holds", async () => {
    const vault = await makeVault();
    const journal = new Journal();
    const id = journal.begin("Turn A");
    await journalled(vault.vault, journal).write("Notes/a.md", "content A");
    const turn = journal.finish()!;
    await journal.undo(turn, vault.vault);
    const result = await undoTurns(journal, vault.vault, [id, "gone"]);
    expect(result.restored).toEqual([]);
    expect(result.refused).toEqual([{ path: "", reason: "an answer's changes are no longer kept for undo" }]);
  });

  it("leaves a file edited since the agent wrote it, and restores the others", async () => {
    const vault = await makeVault({ "Notes/kept.md": "before\n" });
    const journal = new Journal();
    const id = journal.begin("Turn A");
    const port = journalled(vault.vault, journal);
    await port.write("Notes/kept.md", "the agent's text\n");
    await port.write("Notes/new.md", "new\n");
    journal.finish();
    await vault.write("Notes/kept.md", "edited by hand\n");

    const result = await undoTurns(journal, vault.vault, [id]);
    expect(result.refused).toEqual([{ path: "Notes/kept.md", reason: "changed after the agent wrote it" }]);
    expect(result.restored).toEqual(["Notes/new.md"]);
    expect(await vault.read("Notes/kept.md")).toBe("edited by hand\n");
    expect(await vault.exists("Notes/new.md")).toBe(false);
  });
});
