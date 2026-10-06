// `obsidian agent:undo` (#302): which answer it takes back, what it prints, and what it refuses.
import { describe, expect, it } from "vitest";

import type { TurnSummary, UndoResult } from "../api/types";
import { listText, undo, type UndoHost } from "./undo";

const turn = (id: string, prompt: string, undone = false): TurnSummary =>
  ({ id, prompt, started: "2026-10-05T20:00:00.000Z", files: [`Notes/${id}.md`], undone });

/** A journal with *turns*, newest first, as InProcessAgent lists them; records what was undone. */
function host(turns: TurnSummary[], options: { journalling?: boolean; result?: UndoResult; stale?: string[] } = {}) {
  const undone: string[] = [];
  const made: UndoHost & { undone: string[] } = {
    undone,
    turns: async () => ({ journalling: options.journalling ?? true, turns }),
    turnDiff: async (id) => ({ files: [`Notes/${id}.md`], diff: `--- a/Notes/${id}.md\n+++ b/Notes/${id}.md\n`,
                               undone: false, stale: options.stale ?? [] }),
    undoTurn: async (id) => {
      undone.push(id);
      return options.result ?? { ok: true, undone: true, restored: [`Notes/${id}.md`], refused: [] };
    },
  };
  return made;
}

describe("agent:undo", () => {
  it("takes back the answer named by turn=", async () => {
    const journal = host([turn("b2", "Tidy the inbox"), turn("a1", "Summarise it")]);
    expect(await undo(journal, { turn: "a1" })).toBe("Undid \"Summarise it\" (a1).\n[restored: Notes/a1.md]");
    expect(journal.undone).toEqual(["a1"]);
  });

  it("takes back the newest answer not undone yet when no turn is named", async () => {
    const journal = host([turn("c3", "Newest", true), turn("b2", "Tidy the inbox"), turn("a1", "Summarise it")]);
    await undo(journal, {});
    expect(journal.undone).toEqual(["b2"]);
  });

  it("names what it could not restore, and fails when nothing was", async () => {
    const partly = host([turn("a1", "Summarise it")], { result: { ok: false, undone: false, restored: ["Notes/x.md"],
      refused: [{ path: "Notes/y.md", reason: "changed after the agent wrote it" }] } });
    expect(await undo(partly, { turn: "a1" })).toBe("Undid \"Summarise it\" (a1).\n[restored: Notes/x.md]\n"
      + "[not restored: Notes/y.md — changed after the agent wrote it]");
    const none = host([turn("a1", "Summarise it")], { result: { ok: false, undone: false, restored: [],
      refused: [{ path: "Notes/y.md", reason: "changed after the agent wrote it" }] } });
    expect(await undo(none, { turn: "a1" })).toMatch(/^Error: nothing of "Summarise it" \(a1\) was undone\.\n\[not restored: /);
  });

  it("shows the diff with dry, and changes nothing", async () => {
    const journal = host([turn("a1", "Summarise it")], { stale: ["Notes/a1.md"] });
    const text = await undo(journal, { turn: "a1", dry: "true" });
    expect(text).toContain("Undo would take back \"Summarise it\" (a1):\n\n--- a/Notes/a1.md");
    expect(text).toContain("[would be skipped, edited since: Notes/a1.md]");
    expect(journal.undone).toEqual([]);
  });

  it("refuses an unknown answer, one undone already, an empty journal, and undo switched off", async () => {
    expect(await undo(host([turn("a1", "x")]), { turn: "zz" })).toMatch(/^Error: no answer 'zz' is kept for undo/);
    expect(await undo(host([turn("a1", "x", true)]), { turn: "a1" })).toBe("Error: what answer 'a1' changed is already undone");
    expect(await undo(host([]), {})).toMatch(/^Error: nothing to undo/);
    expect(await undo(host([], { journalling: false }), {})).toMatch(/^Error: undo is off/);
  });

  it("lists the answers, newest first, and answers JSON for scripts", async () => {
    const turns = [turn("b2", "Tidy the inbox", true), turn("a1", "Summarise it")];
    expect(listText(turns)).toBe("b2  2026-10-05T20:00:00.000Z  (undone) \"Tidy the inbox\"  Notes/b2.md\n"
      + "a1  2026-10-05T20:00:00.000Z  \"Summarise it\"  Notes/a1.md");
    expect(JSON.parse(await undo(host(turns), { list: "true", format: "json" }))).toEqual({ ok: true, turns });
    expect(JSON.parse(await undo(host(turns), { turn: "zz", format: "json" })).ok).toBe(false);
    expect(JSON.parse(await undo(host(turns), { turn: "a1", format: "json" })))
      .toMatchObject({ turn: "a1", ok: true, restored: ["Notes/a1.md"] });
  });
});
