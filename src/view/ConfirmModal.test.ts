// @vitest-environment jsdom
// What the dialog that stands between a note and a tool says (#398): the sentence and the detail the user judges.
import { afterEach, describe as group, expect, it } from "vitest";

import { buttonNamed, makeApp } from "../testing/obsidian";
import { ConfirmModal, describe } from "./ConfirmModal";

/** The words on the dialog's buttons, in the order they are drawn. */
function buttonWords(el: HTMLElement): string[] {
  return [...el.querySelectorAll<HTMLButtonElement>(".setting-item button")].map((button) => button.textContent ?? "");
}

group("describe", () => {
  it("names the note delete_note would delete", () => {
    expect(describe({ name: "delete_note", input: { path: "Projects/Atlas.md" } }))
      .toEqual({ summary: "Delete Projects/Atlas.md", detail: "" });
  });

  it("names both ends of a move", () => {
    expect(describe({ name: "move_note", input: { from_path: "Inbox/a.md", to_path: "Archive/a.md" } }).summary)
      .toBe("Move Inbox/a.md to Archive/a.md");
  });

  it("shows update_note's new content, cut after 1200 characters", () => {
    const { summary, detail } = describe({ name: "update_note", input: { path: "a.md", content: "x".repeat(1500) } });
    expect(summary).toBe("Replace the whole content of a.md");
    expect(detail).toBe(`${"x".repeat(1200)}…`);
  });

  it("shows every argument of a tool without a sentence of its own, such as an MCP server's", () => {
    const { summary, detail } = describe({ name: "files__write", input: { path: "/etc/x", text: "y" } });
    expect(summary).toBe("Run files__write");
    expect(JSON.parse(detail)).toEqual({ path: "/etc/x", text: "y" });
  });
});

group("the dialog", () => {
  it("counts closing it without an answer as no", async () => {
    const { app, cleanup } = await makeApp();
    try {
      const answers: boolean[] = [];
      const modal = new ConfirmModal(app as never, { name: "delete_note", input: { path: "a.md" } }, (yes) => answers.push(yes));
      modal.open();
      modal.close();
      expect(answers).toEqual([false]);
    } finally {
      await cleanup();
    }
  });

  // The text of the diff's rows of one kind ("add" or "remove"), without the sign
  function diffTexts(el: HTMLElement, kind: "add" | "remove"): (string | null | undefined)[] {
    return [...el.querySelectorAll<HTMLElement>(`.obsidian-agent-diff-line.is-${kind}`)]
      .map((row) => row.querySelector(".obsidian-agent-diff-text")?.textContent);
  }

  it("shows an update_note as the lines it removes and adds, in place of the bare new text", async () => {
    const { app, cleanup } = await makeApp();
    const modal = new ConfirmModal(app as never,
      { name: "update_note", input: { path: "Notes/a.md", content: "one\n2\nthree\n" } }, () => undefined);
    try {
      await app.vault.adapter.write("Notes/a.md", "one\ntwo\nthree\n");
      modal.open();
      await modal.shown;
      expect(diffTexts(modal.contentEl, "remove")).toEqual(["two"]);
      expect(diffTexts(modal.contentEl, "add")).toEqual(["2"]);
      expect(modal.contentEl.querySelector(".obsidian-agent-confirm-detail")).toBeNull();
    } finally {
      modal.close();
      await cleanup();
    }
  });

  it("finds the note an update_note names without .md, and shows its diff the same way", async () => {
    const { app, cleanup } = await makeApp();
    const modal = new ConfirmModal(app as never,
      { name: "update_note", input: { path: "Notes/a", content: "one\n2\nthree\n" } }, () => undefined);
    try {
      await app.vault.adapter.write("Notes/a.md", "one\ntwo\nthree\n");
      modal.open();
      await modal.shown;
      expect(diffTexts(modal.contentEl, "remove")).toEqual(["two"]);
      expect(diffTexts(modal.contentEl, "add")).toEqual(["2"]);
      expect(modal.contentEl.querySelector(".obsidian-agent-confirm-detail")).toBeNull();
    } finally {
      modal.close();
      await cleanup();
    }
  });

  it("keeps the new text in the dialog, and shows no diff, for an update_note to a note that does not exist", async () => {
    const { app, cleanup } = await makeApp();
    const modal = new ConfirmModal(app as never,
      { name: "update_note", input: { path: "Notes/missing.md", content: "new\n" } }, () => undefined);
    try {
      modal.open();
      await modal.shown;
      expect(modal.contentEl.querySelector(".obsidian-agent-confirm-detail")?.textContent).toBe("new\n");
      expect(modal.contentEl.querySelector(".obsidian-agent-undo-diff")).toBeNull();
      expect(modal.contentEl.querySelector(".obsidian-agent-diff-line")).toBeNull();
    } finally {
      modal.close();
      await cleanup();
    }
  });

  it("tells how long a note is before delete_note deletes it, and shows only its first 8 lines", async () => {
    const { app, cleanup } = await makeApp();
    const text = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
    const modal = new ConfirmModal(app as never, { name: "delete_note", input: { path: "Notes/long.md" } }, () => undefined);
    try {
      await app.vault.adapter.write("Notes/long.md", text);
      modal.open();
      await modal.shown;
      const size = modal.contentEl.querySelector<HTMLElement>(".obsidian-agent-confirm-size");
      expect(size?.textContent).toContain("12 lines");
      const head = size?.nextElementSibling;
      expect(head?.classList.contains("obsidian-agent-confirm-detail")).toBe(true);
      expect(head?.textContent).toBe(Array.from({ length: 8 }, (_, i) => `line ${i + 1}`).join("\n"));
    } finally {
      modal.close();
      await cleanup();
    }
  });

  it("shows neither a diff nor a size for move_note", async () => {
    const { app, cleanup } = await makeApp();
    const modal = new ConfirmModal(app as never,
      { name: "move_note", input: { from_path: "Inbox/a.md", to_path: "Archive/a.md" } }, () => undefined);
    try {
      await app.vault.adapter.write("Inbox/a.md", "one\ntwo\n");
      modal.open();
      await modal.shown;
      expect(modal.contentEl.querySelector(".obsidian-agent-undo-diff")).toBeNull();
      expect(modal.contentEl.querySelector(".obsidian-agent-diff-line")).toBeNull();
      expect(modal.contentEl.querySelector(".obsidian-agent-confirm-size")).toBeNull();
    } finally {
      modal.close();
      await cleanup();
    }
  });

  it("says how much an edit removes, and shows the lines it removes", async () => {
    const { app, cleanup } = await makeApp();
    const request = { name: "edit_note", input: { path: "Notes/a.md", old_text: "two\nthree\n", new_text: "",
                                                  removes: "it would remove 80 % of the note", planned_content: "one\n" } };
    const modal = new ConfirmModal(app as never, request, () => undefined);
    try {
      await app.vault.adapter.write("Notes/a.md", "one\ntwo\nthree\n");
      modal.open();
      await modal.shown;
      expect(describe(request).summary).toBe("Edit Notes/a.md: it would remove 80 % of the note");
      expect(modal.contentEl.querySelector(".obsidian-agent-confirm-summary")?.textContent)
        .toBe("Edit Notes/a.md: it would remove 80 % of the note");
      expect(diffTexts(modal.contentEl, "remove")).toEqual(["two", "three"]);
    } finally {
      modal.close();
      await cleanup();
    }
  });

  it("shows no diff for an edit that does not say what it leaves", async () => {
    const { app, cleanup } = await makeApp();
    const modal = new ConfirmModal(app as never,
      { name: "edit_note", input: { path: "Notes/a.md", old_text: "two", new_text: "2" } }, () => undefined);
    try {
      await app.vault.adapter.write("Notes/a.md", "one\ntwo\nthree\n");
      modal.open();
      await modal.shown;
      expect(modal.contentEl.querySelector(".obsidian-agent-undo-diff")).toBeNull();
      expect(modal.contentEl.querySelector(".obsidian-agent-diff-line")).toBeNull();
    } finally {
      modal.close();
      await cleanup();
    }
  });
});

group("the buttons, and Allow for this answer", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("offers Deny, Allow for this answer and Allow once, and Allow for this answer decides approved for the rest too", async () => {
    const { app, cleanup } = await makeApp();
    const decisions: unknown[][] = [];
    const modal = new ConfirmModal(app as never, { name: "create_note", input: { path: "Notes/a.md", content: "plain\n" } },
      (approved, rest) => decisions.push([approved, rest]), true);
    try {
      modal.open();
      expect(buttonWords(modal.contentEl)).toEqual(["Deny", "Allow for this answer", "Allow once"]);
      await buttonNamed(modal.contentEl, "Allow for this answer").click();
      expect(decisions).toEqual([[true, true]]);
    } finally {
      modal.close();
      await cleanup();
    }
  });

  it("offers no Allow for this answer when offerRest is left out, only Deny and Allow once", async () => {
    const { app, cleanup } = await makeApp();
    const modal = new ConfirmModal(app as never, { name: "create_note", input: { path: "Notes/a.md", content: "plain\n" } },
      () => undefined);
    try {
      modal.open();
      expect(buttonWords(modal.contentEl)).toEqual(["Deny", "Allow once"]);
      expect(buttonWords(modal.contentEl)).not.toContain("Allow for this answer");
    } finally {
      modal.close();
      await cleanup();
    }
  });

  it("offers no Allow for this answer for a write that would load or run something once shown, even when offered", async () => {
    const { app, cleanup } = await makeApp();
    const request = { name: "create_note", input: { path: "Notes/Remote.md", content: "![x](https://example.com/a.png)\n",
                                                    when_shown: "load https://example.com/a.png" } };
    const modal = new ConfirmModal(app as never, request, () => undefined, true);
    try {
      modal.open();
      expect(buttonWords(modal.contentEl)).toEqual(["Deny", "Allow once"]);
      expect(buttonWords(modal.contentEl)).not.toContain("Allow for this answer");
    } finally {
      modal.close();
      await cleanup();
    }
  });
});

group("a web page's confirmation (#403)", () => {
  it("says which host the page is on, shows the address, and offers no Allow for this answer even when offered", async () => {
    const { app, cleanup } = await makeApp();
    const modal = new ConfirmModal(app as never,
      { name: "web_fetch", input: { url: "https://example.com/a", host: "example.com" } }, () => undefined, true);
    try {
      modal.open();
      expect(modal.titleEl.textContent).toBe("The agent wants to open a web page");
      expect(modal.contentEl.querySelector(".obsidian-agent-confirm-summary")?.textContent)
        .toMatch(/^Open a page on example\.com/);
      expect(modal.contentEl.querySelector(".obsidian-agent-confirm-detail")?.textContent).toBe("https://example.com/a");
      expect(buttonWords(modal.contentEl)).toEqual(["Deny", "Allow once"]);
    } finally {
      modal.close();
      await cleanup();
    }
  });
});
