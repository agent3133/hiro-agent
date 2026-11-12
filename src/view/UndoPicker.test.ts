// @vitest-environment jsdom
// The undo picker (#410, on the obsidian stub): the label each answer gets, the answers it offers (those not undone
// yet), what choosing one opens, and the notice that says why there is nothing to pick.
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { TurnSummary } from "../api/types";
import { App, Notice } from "../testing/obsidian";

import { openUndoPicker, turnLabel, UndoPicker } from "./UndoPicker";

function turn(overrides: Partial<TurnSummary> = {}): TurnSummary {
  return { id: "t1", prompt: "Tidy the inbox", started: "", files: ["Inbox.md"], undone: false, ...overrides };
}

/** A stand-in client: the journal's answers, their diffs and undo. */
function makeClient(turns: TurnSummary[], journalling = true) {
  return {
    turns: vi.fn(async () => ({ journalling, turns })),
    turnDiff: vi.fn(async () => ({ files: ["Inbox.md"], diff: "", undone: false, stale: [] })),
    undoTurn: vi.fn(async () => ({ ok: true, undone: true, restored: ["Inbox.md"], refused: [] })),
  };
}

type Client = Parameters<typeof openUndoPicker>[1];

/** Choose *item* in the picker as a click on it would (the stub's FuzzySuggestModal has choose). */
function choose(picker: UndoPicker, item: TurnSummary): void {
  (picker as unknown as { choose(item: TurnSummary): void }).choose(item);
}

beforeEach(() => {
  Notice.shown = [];
  document.body.replaceChildren();
});

describe("turnLabel", () => {
  it("names the prompt and says one file for one changed file", () => {
    expect(turnLabel(turn({ prompt: "Tidy the inbox", files: ["Inbox.md"] }))).toBe("Tidy the inbox · 1 file");
  });

  it("says how many files for more than one", () => {
    const label = turnLabel(turn({ prompt: "Tidy the inbox", files: ["Inbox.md", "Daily.md", "Tasks.md"] }));
    expect(label).toBe("Tidy the inbox · 3 files");
  });

  it("cuts a prompt longer than 70 characters to 70, the last one an ellipsis", () => {
    const label = turnLabel(turn({ prompt: "a".repeat(100), files: ["Inbox.md"] }));
    expect(label).toBe(`${"a".repeat(69)}… · 1 file`);
  });

  it("keeps a prompt of exactly 70 characters whole", () => {
    const label = turnLabel(turn({ prompt: "b".repeat(70), files: ["Inbox.md"] }));
    expect(label).toBe(`${"b".repeat(70)} · 1 file`);
  });

  it("puts the day and time of the answer before its prompt", () => {
    const started = "2026-11-10T09:30:00Z";
    const when = new Date(started);
    const time = when.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const label = turnLabel(turn({ prompt: "Tidy the inbox", started, files: ["Inbox.md"] }));
    expect(label).toBe(`${when.toLocaleDateString()} ${time} · Tidy the inbox · 1 file`);
  });
});

describe("openUndoPicker", () => {
  it("opens a picker that offers only the answers not undone yet", async () => {
    const undone = turn({ id: "t1", undone: true });
    const open = turn({ id: "t2", undone: false });
    const client = makeClient([undone, open]);
    const picker = await openUndoPicker(new App(".") as never, client as unknown as Client);
    expect(picker).toBeInstanceOf(UndoPicker);
    expect(picker!.getItems()).toEqual([open]);
    expect(document.body.childElementCount).toBe(1);
  });

  it("choosing an answer opens the undo dialog for it, which reads that answer's diff", async () => {
    const open = turn({ id: "t2", files: ["Inbox.md", "Daily/2026-11-10.md"] });
    const client = makeClient([open]);
    const picker = await openUndoPicker(new App(".") as never, client as unknown as Client);
    choose(picker!, open);
    await vi.waitFor(() => expect(client.turnDiff).toHaveBeenCalledWith("t2"));
    expect(document.body.textContent).toContain("Undo what this answer changed?");
    const listed = [...document.body.querySelectorAll("li")].map((li) => li.textContent);
    expect(listed).toEqual(["Inbox.md", "Daily/2026-11-10.md"]);
  });

  it("says the undo feature is off, and opens nothing, when journalling is off", async () => {
    const client = makeClient([turn()], false);
    const picker = await openUndoPicker(new App(".") as never, client as unknown as Client);
    expect(picker).toBeNull();
    expect(Notice.shown).toEqual([expect.stringContaining("Undo agent changes")]);
    expect(client.turnDiff).not.toHaveBeenCalled();
    expect(document.body.childElementCount).toBe(0);
  });

  it("says no answer's changes are left to undo, and opens nothing, when there are no answers", async () => {
    const client = makeClient([]);
    const picker = await openUndoPicker(new App(".") as never, client as unknown as Client);
    expect(picker).toBeNull();
    expect(Notice.shown).toEqual(["No answer's changes are left to undo."]);
    expect(document.body.childElementCount).toBe(0);
  });

  it("says no answer's changes are left to undo when every answer is undone already", async () => {
    const client = makeClient([turn({ undone: true })]);
    const picker = await openUndoPicker(new App(".") as never, client as unknown as Client);
    expect(picker).toBeNull();
    expect(Notice.shown).toEqual(["No answer's changes are left to undo."]);
    expect(document.body.childElementCount).toBe(0);
  });
});
