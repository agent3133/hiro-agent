// @vitest-environment jsdom
// The dialog that goes back to before a message (#303): what it says will go, the diff it shows, and the one button
// that rewinds.
import { afterEach, beforeEach, describe as group, expect, it, vi } from "vitest";

import { buttonNamed, makeApp, Notice } from "../testing/obsidian";
import { RewindModal, type RewindRequest } from "./RewindModal";

interface TurnAnswer {
  files: string[];
  diff: string;
  undone: boolean;
  stale: string[];
}

/** A client that answers turnDiff from *answers* (turn id → answer), and records the ids it was asked for. */
function fakeClient(answers: Record<string, Partial<TurnAnswer>>) {
  const asked: string[] = [];
  const turnDiff = vi.fn(async (id: string): Promise<TurnAnswer> => {
    asked.push(id);
    const answer = answers[id] ?? {};
    return { files: answer.files ?? [], diff: answer.diff ?? "", undone: false, stale: answer.stale ?? [] };
  });
  return { turnDiff, asked };
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

/** The paragraph of the dialog that starts with *start*. */
function paragraph(el: HTMLElement, start: string): HTMLElement | undefined {
  return [...el.querySelectorAll<HTMLElement>("p")].find((p) => p.textContent?.startsWith(start));
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

group("what the dialog says will go, and the diffs", () => {
  it("shows how many questions and answers go, and the diff of every answer in turns", async () => {
    const client = fakeClient({
      t1: { files: ["Notes/a.md"], diff: diffOf("Notes/a.md", "alpha", "beta") },
      t2: { files: ["Notes/b.md"], diff: diffOf("Notes/b.md", "gamma", "delta") },
    });
    const request: RewindRequest = { exchanges: 2, turns: ["t2", "t1"], unknown: 0 };
    const modal = new RewindModal(app as never, client as never, request, async () => ({ restored: [], refused: [] }));
    try {
      modal.open();
      expect(paragraph(modal.contentEl, "This message and everything after it")?.textContent)
        .toContain("2 questions and their answers");
      await diffLoaded(modal.contentEl);
      // Both answers were asked for, the older one first, as they happened
      expect(client.asked).toEqual(["t1", "t2"]);
      expect(diffTexts(modal.contentEl, "remove")).toEqual(["alpha", "gamma"]);
      expect(diffTexts(modal.contentEl, "add")).toEqual(["beta", "delta"]);
    } finally {
      modal.close();
    }
  });
});

group("files left alone and answers that cannot be taken back", () => {
  it("names a file that was edited since as left alone", async () => {
    const client = fakeClient({
      t1: { files: ["Notes/a.md"], diff: diffOf("Notes/a.md", "alpha", "beta"), stale: ["Notes/a.md"] },
    });
    const modal = new RewindModal(app as never, client as never, { exchanges: 1, turns: ["t1"], unknown: 0 },
                                  async () => ({ restored: [], refused: [] }));
    try {
      modal.open();
      await diffLoaded(modal.contentEl);
      const warning = paragraph(modal.contentEl, "Edited since, and so left alone");
      expect(warning?.textContent).toBe("Edited since, and so left alone: Notes/a.md");
      expect(warning?.style.display).not.toBe("none");
    } finally {
      modal.close();
    }
  });

  it("says how many answers from before Obsidian started cannot be taken back", () => {
    const client = fakeClient({});
    const modal = new RewindModal(app as never, client as never, { exchanges: 1, turns: [], unknown: 1 },
                                  async () => ({ restored: [], refused: [] }));
    try {
      modal.open();
      expect(paragraph(modal.contentEl, "1 answer from before Obsidian started the plugin")?.textContent)
        .toBe("1 answer from before Obsidian started the plugin cannot be taken back: anything they changed in the vault stays.");
    } finally {
      modal.close();
    }
  });
});

group("the buttons", () => {
  it("goes back by calling the rewind once, and closes when it has finished", async () => {
    const onConfirm = vi.fn(async () => ({ restored: [], refused: [] }));
    const modal = new RewindModal(app as never, fakeClient({}) as never,
                                  { exchanges: 1, turns: [], unknown: 0 }, onConfirm);
    modal.open();
    await buttonNamed(modal.contentEl, "Go back").click();
    await vi.waitFor(() => expect(document.body.querySelector(".obsidian-agent-undo-modal")).toBeNull());
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("ignores a second Go back while the first is still running", async () => {
    let finish!: (result: { restored: string[]; refused: { path: string; reason: string }[] }) => void;
    const onConfirm = vi.fn(() => new Promise<{ restored: string[]; refused: { path: string; reason: string }[] }>((resolve) => {
      finish = resolve;
    }));
    const modal = new RewindModal(app as never, fakeClient({}) as never,
                                  { exchanges: 1, turns: [], unknown: 0 }, onConfirm);
    modal.open();
    const goBack = buttonNamed(modal.contentEl, "Go back");
    await goBack.click();
    await vi.waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
    expect(goBack.buttonEl.disabled).toBe(true);
    await goBack.click();
    expect(onConfirm).toHaveBeenCalledTimes(1);
    // Let the first one finish, so the dialog closes and nothing is left pending
    finish({ restored: [], refused: [] });
    await vi.waitFor(() => expect(document.body.querySelector(".obsidian-agent-undo-modal")).toBeNull());
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("does not rewind when Keep is clicked, and closes", async () => {
    const onConfirm = vi.fn(async () => ({ restored: [], refused: [] }));
    const modal = new RewindModal(app as never, fakeClient({}) as never,
                                  { exchanges: 1, turns: [], unknown: 0 }, onConfirm);
    modal.open();
    await buttonNamed(modal.contentEl, "Keep").click();
    expect(document.body.querySelector(".obsidian-agent-undo-modal")).toBeNull();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("does not rewind when the dialog is closed without a button", () => {
    const onConfirm = vi.fn(async () => ({ restored: [], refused: [] }));
    const modal = new RewindModal(app as never, fakeClient({}) as never,
                                  { exchanges: 1, turns: [], unknown: 0 }, onConfirm);
    modal.open();
    modal.close();
    expect(document.body.querySelector(".obsidian-agent-undo-modal")).toBeNull();
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
