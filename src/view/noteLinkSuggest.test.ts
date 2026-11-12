// @vitest-environment jsdom
// The note list `[[` opens in the chat's input (#411), in jsdom: what a link query reads, which notes match and in what
// order, what choosing one puts in the input, and how the list keeps the keys it uses away from the input's own handler.
import { beforeEach, describe, expect, it, vi } from "vitest";

// Installs the DOM helpers (createDiv, empty, addClass, …) the list is drawn with
import "../testing/obsidian";

import { linkQuery, matchNotes, NoteLinkSuggest } from "./noteLinkSuggest";

describe("linkQuery: the link being typed before the caret", () => {
  it("reads the name typed after an open [[, and where the [[ starts", () => {
    expect(linkQuery("see [[Pro", 9)).toEqual({ start: 4, query: "Pro" });
  });

  it("reads nothing once the link is closed with ]]", () => {
    expect(linkQuery("see [[Pro]] x", 13)).toBeNull();
  });

  it("reads nothing when a line break comes between the [[ and the caret", () => {
    expect(linkQuery("a\n[[b\nc", 7)).toBeNull();
  });
});

describe("matchNotes: which notes the list offers, best first", () => {
  const paths = ["Projects/Atlas.md", "Atlas notes.md", "Archive/Old atlas plan.md", "Inbox.md"];

  it("lists the notes whose name starts with the query first, shorter paths first, then the ones that contain it", () => {
    expect(matchNotes(paths, "atlas")).toEqual(["Atlas notes.md", "Projects/Atlas.md", "Archive/Old atlas plan.md"]);
  });

  it("leaves out the notes the query does not match", () => {
    expect(matchNotes(paths, "atlas")).not.toContain("Inbox.md");
  });
});

describe("NoteLinkSuggest in the chat's textarea", () => {
  const NOTES = ["Projects/Atlas.md", "Atlas notes.md", "Inbox.md"];
  let input: HTMLTextAreaElement;
  let host: HTMLElement;

  beforeEach(() => {
    document.body.replaceChildren();
    host = document.createElement("div");
    input = document.createElement("textarea");
    host.appendChild(input);
    document.body.appendChild(host);
    // The suggest is made before any other keydown listener on the input, as the chat makes it
    new NoteLinkSuggest(input, host, () => NOTES);
  });

  /** Type *text* as the user does: the value, the caret (at its end unless given), then the input event. */
  function typeText(text: string, caret = text.length): void {
    input.value = text;
    input.setSelectionRange(caret, caret);
    input.dispatchEvent(new Event("input"));
  }

  /** A keydown in the input, as the keyboard makes it. */
  function press(key: string, init: KeyboardEventInit = {}): void {
    input.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }));
  }

  const items = (): HTMLElement[] => Array.from(host.querySelectorAll<HTMLElement>(".obsidian-agent-link-suggestion"));
  const list = (): HTMLElement => {
    const found = host.querySelector<HTMLElement>(".obsidian-agent-link-suggest");
    if (!found) throw new Error("no .obsidian-agent-link-suggest above the input");
    return found;
  };

  it("shows the matching notes as items while [[ is typed, and puts the one picked with ArrowDown and Enter in place of [[", () => {
    typeText("[[at");
    expect(items().map((item) => item.querySelector(".obsidian-agent-link-name")?.textContent))
      .toEqual(["Atlas notes", "Atlas"]);

    press("ArrowDown");
    press("Enter");

    expect(input.value).toBe("[[Projects/Atlas]]");
    expect(input.selectionStart).toBe("[[Projects/Atlas]]".length);
    expect(items()).toHaveLength(0);
    expect(list().classList.contains("is-hidden")).toBe(true);
  });

  it("lets Enter pick a note without reaching a keydown listener the input has after the suggest", () => {
    const later = vi.fn();
    input.addEventListener("keydown", later);
    typeText("[[at");
    press("Enter");
    expect(later).not.toHaveBeenCalled();
  });

  it("lets Enter reach a keydown listener after the suggest while the list is closed", () => {
    const later = vi.fn();
    input.addEventListener("keydown", later);
    typeText("Hello");
    press("Enter");
    expect(later).toHaveBeenCalledTimes(1);
  });

  it("closes the list on Escape and leaves the text as it was", () => {
    typeText("[[at");
    expect(items().length).toBeGreaterThan(0);

    press("Escape");

    expect(items()).toHaveLength(0);
    expect(list().classList.contains("is-hidden")).toBe(true);
    expect(input.value).toBe("[[at");
  });

  it("puts a note in place of [[ when its item is clicked, with the mousedown the click starts with", () => {
    typeText("[[at");
    const inFolder = items().find((item) => item.querySelector(".obsidian-agent-link-folder")?.textContent === "Projects");
    if (!inFolder) throw new Error("no item for Projects/Atlas in the list");

    inFolder.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));

    expect(input.value).toBe("[[Projects/Atlas]]");
    expect(items()).toHaveLength(0);
  });
});
