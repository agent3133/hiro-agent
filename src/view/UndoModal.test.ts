// @vitest-environment jsdom
// The dialog that takes back what one answer changed (#131): the diff it shows, the offer it withdraws when nothing can
// come back, and what Undo reports.
import { afterEach, beforeEach, describe as group, expect, it, vi } from "vitest";

import { buttonNamed, makeApp, Notice } from "../testing/obsidian";
import { UndoModal } from "./UndoModal";

interface TurnAnswer {
  files: string[];
  diff: string;
  undone: boolean;
  stale: string[];
}

type UndoResult = { ok: boolean; undone: boolean; restored: string[]; refused: { path: string; reason: string }[] };

/** A client whose turnDiff answers *answer*, and whose undoTurn answers *undo*; both record what they were asked. */
function fakeClient(answer: Partial<TurnAnswer>, undo: UndoResult = { ok: true, undone: true, restored: [], refused: [] }) {
  const turnDiff = vi.fn(async (): Promise<TurnAnswer> => ({
    files: answer.files ?? [], diff: answer.diff ?? "", undone: false, stale: answer.stale ?? [],
  }));
  const undoTurn = vi.fn(async (): Promise<UndoResult> => undo);
  return { turnDiff, undoTurn };
}

/** A one-file unified diff: *removed* replaced by *added* in *file*. */
function diffOf(file: string, removed: string, added: string): string {
  return `--- a/${file}\n+++ b/${file}\n@@ -1 +1 @@\n-${removed}\n+${added}\n`;
}

/** The text of the diff's rows of one kind ("add" or "remove"), without the sign. */
function diffTexts(el: HTMLElement, kind: "add" | "remove"): (string | null | undefined)[] {
  return [...el.querySelectorAll<HTMLElement>(`.obsidian-agent-diff-line.is-${kind}`)]
    .map((row) => row.querySelector(".obsidian-agent-diff-text")?.textContent);
}

/** Waits until the diff has been read (the dialog says "Loading the diff…" until then). */
async function diffLoaded(el: HTMLElement): Promise<void> {
  await vi.waitFor(() => expect(el.querySelector(".obsidian-agent-undo-diff")?.textContent).not.toContain("Loading"));
}

let app: Awaited<ReturnType<typeof makeApp>>["app"];
let cleanup: () => Promise<void>;

beforeEach(async () => {
  document.body.innerHTML = "";
  Notice.shown = [];
  ({ app, cleanup } = await makeApp());
});

afterEach(async () => {
  document.body.innerHTML = "";
  await cleanup();
});

group("the answer's diff, and the offer", () => {
  it("shows the answer's diff as the lines it removes and adds", async () => {
    const client = fakeClient({ files: ["Notes/a.md"], diff: diffOf("Notes/a.md", "alpha", "beta") });
    const modal = new UndoModal(app as never, client as never, { turn: "t1", files: ["Notes/a.md"] }, () => undefined);
    try {
      modal.open();
      await diffLoaded(modal.contentEl);
      expect(client.turnDiff).toHaveBeenCalledWith("t1");
      expect(diffTexts(modal.contentEl, "remove")).toEqual(["alpha"]);
      expect(diffTexts(modal.contentEl, "add")).toEqual(["beta"]);
    } finally {
      modal.close();
    }
  });

  it("withdraws the undo button and says why when every file was edited since", async () => {
    const client = fakeClient({ files: ["Notes/a.md"], diff: diffOf("Notes/a.md", "alpha", "beta"), stale: ["Notes/a.md"] });
    const modal = new UndoModal(app as never, client as never, { turn: "t1", files: ["Notes/a.md"] }, () => undefined);
    try {
      modal.open();
      await diffLoaded(modal.contentEl);
      const warning = modal.contentEl.querySelector<HTMLElement>(".obsidian-agent-undo-warning");
      await vi.waitFor(() => expect(warning?.textContent).toContain("Nothing here can be taken back"));
      expect(warning?.textContent).toBe("Nothing here can be taken back: you have edited Notes/a.md since the agent wrote it.");
      const undo = buttonNamed(modal.contentEl, "Nothing to restore");
      expect(undo.buttonEl.disabled).toBe(true);
    } finally {
      modal.close();
    }
  });
});

group("Take it back", () => {
  it("undoes the answer by its turn id, reports it, calls onUndone, and closes", async () => {
    const client = fakeClient({ files: ["Notes/a.md"], diff: diffOf("Notes/a.md", "alpha", "beta") },
                              { ok: true, undone: true, restored: ["Notes/a.md"], refused: [] });
    const onUndone = vi.fn();
    const modal = new UndoModal(app as never, client as never, { turn: "t1", files: ["Notes/a.md"] }, onUndone);
    modal.open();
    await diffLoaded(modal.contentEl);
    await buttonNamed(modal.contentEl, "Take it back").click();
    await vi.waitFor(() => expect(document.body.querySelector(".obsidian-agent-undo-modal")).toBeNull());
    expect(client.undoTurn).toHaveBeenCalledWith("t1");
    expect(onUndone).toHaveBeenCalledTimes(1);
    expect(Notice.shown).toEqual(["Restored 1 file."]);
  });

  it("reports a file that was left alone, with its reason, in the notice", async () => {
    const client = fakeClient({ files: ["Notes/a.md", "Notes/b.md"], diff: diffOf("Notes/a.md", "alpha", "beta") },
                              { ok: false, undone: true, restored: ["Notes/a.md"],
                                refused: [{ path: "Notes/b.md", reason: "edited since" }] });
    const modal = new UndoModal(app as never, client as never,
                                { turn: "t1", files: ["Notes/a.md", "Notes/b.md"] }, () => undefined);
    modal.open();
    await diffLoaded(modal.contentEl);
    await buttonNamed(modal.contentEl, "Take it back").click();
    await vi.waitFor(() => expect(Notice.shown).toHaveLength(1));
    expect(Notice.shown).toEqual(["Restored 1 file. Left alone: Notes/b.md — edited since"]);
    expect(document.body.querySelector(".obsidian-agent-undo-modal")).toBeNull();
  });
});

group("keeping the answer", () => {
  it("does not undo when Keep is clicked", async () => {
    const client = fakeClient({ files: ["Notes/a.md"], diff: diffOf("Notes/a.md", "alpha", "beta") });
    const onUndone = vi.fn();
    const modal = new UndoModal(app as never, client as never, { turn: "t1", files: ["Notes/a.md"] }, onUndone);
    modal.open();
    await diffLoaded(modal.contentEl);
    await buttonNamed(modal.contentEl, "Keep").click();
    expect(document.body.querySelector(".obsidian-agent-undo-modal")).toBeNull();
    expect(client.undoTurn).not.toHaveBeenCalled();
    expect(onUndone).not.toHaveBeenCalled();
  });

  it("does not undo when the dialog is dismissed without a button", async () => {
    const client = fakeClient({ files: ["Notes/a.md"], diff: diffOf("Notes/a.md", "alpha", "beta") });
    const onUndone = vi.fn();
    const modal = new UndoModal(app as never, client as never, { turn: "t1", files: ["Notes/a.md"] }, onUndone);
    modal.open();
    await diffLoaded(modal.contentEl);
    modal.close();
    expect(document.body.querySelector(".obsidian-agent-undo-modal")).toBeNull();
    expect(client.undoTurn).not.toHaveBeenCalled();
    expect(onUndone).not.toHaveBeenCalled();
  });
});
