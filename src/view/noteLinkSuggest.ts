/**
 * `[[` in the chat's input suggests notes (#411): type `[[` and part of a name, pick one with the arrow keys and Enter
 * or Tab (or a click), and `[[Folder/Note]]` goes into the message — the note's path, which the agent's tools take
 * as it is. Escape closes the list; Enter while it is open picks, and does not send.
 *
 * Obsidian's own suggest classes serve the editor and one-line inputs; the chat's input is a textarea, so this is a
 * small one of its own, with no Obsidian in it (tested in jsdom).
 */

/** The text being completed: what follows an open `[[` before the caret, on the same line; null when none. */
export function linkQuery(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret);
  const match = /\[\[([^[\]\n|#]*)$/.exec(before);
  return match ? { start: match.index, query: match[1] } : null;
}

/**
 * The notes that match *query*, best first: the name starting with it, then the name containing it, then the path
 * containing it; shorter paths first within each. Case does not matter; an empty query lists the first ones.
 */
export function matchNotes(paths: string[], query: string, limit = 8): string[] {
  const wanted = query.trim().toLowerCase();
  const scored: { path: string; rank: number }[] = [];
  for (const path of paths) {
    const lower = path.toLowerCase();
    const name = lower.slice(lower.lastIndexOf("/") + 1).replace(/\.md$/, "");
    const rank = !wanted ? 2 : name.startsWith(wanted) ? 0 : name.includes(wanted) ? 1 : lower.includes(wanted) ? 2 : -1;
    if (rank >= 0) scored.push({ path, rank });
  }
  scored.sort((a, b) => a.rank - b.rank || a.path.length - b.path.length || a.path.localeCompare(b.path));
  return scored.slice(0, limit).map((item) => item.path);
}

/** How a chosen note goes into the message: its path as a link, without `.md`. */
export function linkText(path: string): string {
  return `[[${path.replace(/\.md$/i, "")}]]`;
}

export class NoteLinkSuggest {
  private readonly list: HTMLElement;
  private shown: string[] = [];
  private selected = 0;
  private query: { start: number; query: string } | null = null;

  /**
   * *input* is the chat's textarea, *host* where the list is drawn (above the input), *notes* the vault's notes
   * now. Created before the chat's own keydown handler, so Enter that picks a note never sends.
   */
  constructor(private readonly input: HTMLTextAreaElement, host: HTMLElement, private readonly notes: () => string[]) {
    this.list = host.createDiv({ cls: "obsidian-agent-link-suggest is-hidden", attr: { role: "listbox" } });
    input.addEventListener("input", () => this.update());
    input.addEventListener("keydown", (event) => this.key(event));
    input.addEventListener("blur", () => this.close());
  }

  isOpen(): boolean {
    return this.shown.length > 0;
  }

  close(): void {
    this.shown = [];
    this.query = null;
    this.list.empty();
    this.list.addClass("is-hidden");
  }

  /** Read the input again: open, narrow or close the list. */
  update(): void {
    if (typeof this.input.selectionStart !== "number") return;
    const query = linkQuery(this.input.value, this.input.selectionStart);
    if (!query) {
      this.close();
      return;
    }
    this.query = query;
    this.shown = matchNotes(this.notes(), query.query);
    this.selected = 0;
    this.draw();
  }

  /** Put *path* in place of the `[[` being typed, and the caret after it. */
  choose(path: string): void {
    const query = this.query;
    if (!query) return;
    const caret = this.input.selectionStart ?? this.input.value.length;
    // A "]]" the input already had right after the caret (typed, or closed by another tool) is taken over
    const after = this.input.value.slice(caret).replace(/^\]\]/, "");
    const link = linkText(path);
    this.input.value = `${this.input.value.slice(0, query.start)}${link}${after}`;
    const at = query.start + link.length;
    this.input.setSelectionRange(at, at);
    this.close();
    this.input.dispatchEvent(new Event("input", { bubbles: true }));
  }

  private key(event: KeyboardEvent): void {
    if (!this.isOpen() || event.isComposing) return;
    const handled = (): void => {
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      handled();
      const step = event.key === "ArrowDown" ? 1 : -1;
      this.selected = (this.selected + step + this.shown.length) % this.shown.length;
      this.draw();
    } else if ((event.key === "Enter" && !event.shiftKey) || event.key === "Tab") {
      handled();
      this.choose(this.shown[this.selected]);
    } else if (event.key === "Escape") {
      handled();
      this.close();
    }
  }

  private draw(): void {
    this.list.empty();
    this.list.toggleClass("is-hidden", !this.shown.length);
    this.shown.forEach((path, index) => {
      const item = this.list.createDiv({
        cls: `obsidian-agent-link-suggestion${index === this.selected ? " is-selected" : ""}`,
        attr: { role: "option", "aria-selected": String(index === this.selected) },
      });
      const slash = path.lastIndexOf("/");
      item.createSpan({ cls: "obsidian-agent-link-name", text: path.slice(slash + 1).replace(/\.md$/i, "") });
      if (slash > 0) item.createSpan({ cls: "obsidian-agent-link-folder", text: path.slice(0, slash) });
      // A click picks without taking the focus away from the input first
      item.addEventListener("mousedown", (event) => {
        event.preventDefault();
        this.choose(path);
      });
    });
  }
}
