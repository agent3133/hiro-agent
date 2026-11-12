/**
 * The modal that stands between a note and a tool that would change it.
 *
 * Dismissing is denying. Escape, clicking outside, and closing the window all mean no — a dialog that approves
 * when you look away is how one poisoned note becomes a silent delete.
 */

import { App, Modal, Setting } from "obsidian";

import { linesKeepEnds, unifiedDiff } from "../core/difflib";
import { renderDiff } from "./UndoModal";

export interface ConfirmRequest {
  name: string;
  input: unknown;
}

/** How much of a change the dialog shows: a long diff is cut, with the count of what was left out. */
const MOST_DIFF_LINES = 300;
/** How many of a note's first lines the dialog shows before it is deleted. */
const FIRST_LINES = 8;

/**
 * What the dialog shows of the note a tool would change, from the note as it is now (#406): for update_note the
 * diff between it and the new text, for delete_note its size and first lines. Null when there is nothing to add to
 * the sentence and the detail — another tool, or no such note yet (update_note then shows its new text).
 */
export type NoteChange =
  | { kind: "diff"; diff: string; cut: number }
  | { kind: "delete"; characters: number; lines: number; head: string };

export function noteChange(request: ConfirmRequest, current: string | null): NoteChange | null {
  if (current === null) return null;
  const input = (request.input ?? {}) as Record<string, unknown>;
  const path = String(input.path ?? "");
  // update_note's new text, or the note as an edit that removes most of it would leave it (#404)
  const after = request.name === "update_note" ? input.content
    : request.name === "edit_note" ? input.planned_content : undefined;
  if (typeof after === "string") {
    const lines = unifiedDiff(linesKeepEnds(current), linesKeepEnds(after), `a/${path}`, `b/${path}`)
      .split("\n");
    if (lines[lines.length - 1] === "") lines.pop();
    const cut = Math.max(0, lines.length - MOST_DIFF_LINES);
    return { kind: "diff", diff: lines.slice(0, MOST_DIFF_LINES).join("\n"), cut };
  }
  if (request.name === "delete_note") {
    const all = current.replace(/\r\n/g, "\n").split("\n");
    if (all[all.length - 1] === "") all.pop();
    return { kind: "delete", characters: current.length, lines: all.length, head: all.slice(0, FIRST_LINES).join("\n") };
  }
  return null;
}

/** Where a tool's path argument names a note that exists: as given, or with .md as the tools add it. */
async function readNote(app: App, raw: unknown): Promise<string | null> {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const path = raw.trim().replace(/\\/g, "/").replace(/^\/+/, "");
  for (const candidate of path.toLowerCase().endsWith(".md") ? [path] : [path, `${path}.md`]) {
    try {
      if (await app.vault.adapter.exists(candidate)) return await app.vault.adapter.read(candidate);
    } catch {
      // unreadable: the dialog says what it said before
    }
  }
  return null;
}

export class ConfirmModal extends Modal {
  private answered = false;

  /**
   * *decide* gets the answer; *rest* is true for "Allow for this answer" (#405), which only *offerRest* shows: the chat
   * offers it, the terminal does not. Never for a write that would load or run something once shown (#395).
   */
  constructor(app: App, private readonly request: ConfirmRequest,
              private readonly decide: (approved: boolean, rest?: boolean) => void,
              private readonly offerRest = false) {
    super(app);
  }

  override onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass("obsidian-agent-confirm");
    this.setTitle(this.request.name === "web_fetch" ? "The agent wants to open a web page"
      : this.request.name.includes("__") ? "The agent wants to use an MCP server's tool"
        : "The agent wants to change your vault");

    // What will happen, in the user's terms — not a JSON blob to click past.
    const what = describe(this.request);
    contentEl.createEl("p", { text: what.summary, cls: "obsidian-agent-confirm-summary" });
    const detail = what.detail ? contentEl.createEl("pre", { text: what.detail, cls: "obsidian-agent-confirm-detail" }) : null;
    // The change against the note as it is now replaces the bare new text, once the note is read (#406)
    const change = contentEl.createDiv({ cls: "obsidian-agent-confirm-change" });
    contentEl.createEl("p", { text: `Tool: ${this.request.name}`, cls: "obsidian-agent-confirm-tool" });
    const planned = typeof (this.request.input as { planned_content?: unknown })?.planned_content === "string";
    if (this.request.name === "update_note" || this.request.name === "delete_note"
        || (this.request.name === "edit_note" && planned)) {
      this.shown = this.showChange(change, detail);
    }

    const buttons = new Setting(contentEl)
      .addButton((button) => button.setButtonText("Deny").onClick(() => this.answer(false)));
    // Not for a write that would load something once shown (#395), nor for a web page: its question is per host
    // (#403), and allowing the answer's further pages would let them go to any host
    const risky = typeof (this.request.input as { when_shown?: unknown } | null)?.when_shown === "string"
      || this.request.name === "web_fetch";
    if (this.offerRest && !risky) {
      buttons.addButton((button) => {
        button.setButtonText("Allow for this answer").onClick(() => this.answer(true, true));
        button.buttonEl.setAttr("aria-label", `This and the answer's further ${this.request.name} calls run without `
                                + "asking. The next answer asks again.");
      });
    }
    buttons.addButton((button) => button.setButtonText("Allow once").setCta().onClick(() => this.answer(true)));
  }

  override onClose(): void {
    this.contentEl.empty();
    if (!this.answered) this.decide(false); // dismissed is denied
  }

  /** Settles once the note has been read and its change drawn; for tests. */
  shown: Promise<void> = Promise.resolve();

  private async showChange(el: HTMLElement, detail: HTMLElement | null): Promise<void> {
    const shown = noteChange(this.request, await readNote(this.app, (this.request.input as { path?: unknown })?.path));
    if (!shown) return;
    if (shown.kind === "diff") {
      detail?.remove();
      const box = el.createDiv({ cls: "obsidian-agent-undo-diff" });
      renderDiff(box, shown.diff);
      if (shown.cut) el.createEl("p", { cls: "setting-item-description", text: `… and ${shown.cut} more lines of the change.` });
      return;
    }
    el.createEl("p", { cls: "obsidian-agent-confirm-size",
                       text: `The note has ${shown.lines === 1 ? "1 line" : `${shown.lines} lines`} `
                         + `(${shown.characters.toLocaleString("en")} characters). It begins:` });
    el.createEl("pre", { cls: "obsidian-agent-confirm-detail", text: shown.head || "(empty)" });
  }

  private answer(approved: boolean, rest = false): void {
    this.answered = true;
    this.decide(approved, rest);
    this.close();
  }
}

/** A sentence a person can judge, plus the argument that identifies what is being touched. */
export function describe(request: ConfirmRequest): { summary: string; detail: string } {
  const input = (request.input ?? {}) as Record<string, unknown>;
  const path = String(input.path ?? input.from_path ?? "");
  const target = String(input.to_path ?? "");
  const verbs: Record<string, string> = {
    delete_note: `Delete ${path}`,
    update_note: `Replace the whole content of ${path}`,
    move_note: `Move ${path} to ${target}`,
    create_note: `Create ${path}`,
    edit_note: `Edit ${path}`,
    append_to_note: `Append to ${path}`,
    update_metadata: `Set ${String(input.key ?? "a property")} in ${path}`,
  };
  // A page on a host this conversation has not opened yet (#403): the address goes there, with what is in it
  if (request.name === "web_fetch") {
    const host = String(input.host ?? "") || "this site";
    return { summary: `Open a page on ${host}. Once allowed, this conversation opens other pages there without asking.`,
             detail: String(input.url ?? "") };
  }
  const verb = verbs[request.name];
  // What the note would load or run by itself once shown, which is why a write that is otherwise not asked about
  // is (#395)
  // An edit that takes most of the note away says how much (#404)
  const said = verb && typeof input.removes === "string" ? `${verb}: ${input.removes}` : verb;
  const known = said && typeof input.when_shown === "string" ? `${said}. When the note is shown, it would ${input.when_shown}.`
    : said;
  // A tool without a sentence of its own — an MCP server's — shows every argument it will get: the user is asked
  // about what will run, not about its name (#135)
  const content = known ? String(input.content ?? input.new_text ?? input.text ?? "") : JSON.stringify(input, null, 2);
  const detail = content && content !== "{}" ? (content.length > 1200 ? `${content.slice(0, 1200)}…` : content) : "";
  return { summary: known ?? `Run ${request.name}`, detail };
}
