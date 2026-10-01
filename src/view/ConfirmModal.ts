/**
 * The modal that stands between a note and a tool that would change it.
 *
 * Dismissing is denying. Escape, clicking outside, and closing the window all mean no — a dialog that approves
 * when you look away is how one poisoned note becomes a silent delete.
 */

import { App, Modal, Setting } from "obsidian";

export interface ConfirmRequest {
  name: string;
  input: unknown;
}

export class ConfirmModal extends Modal {
  private answered = false;

  constructor(app: App, private readonly request: ConfirmRequest,
              private readonly decide: (approved: boolean) => void) {
    super(app);
  }

  override onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass("obsidian-agent-confirm");
    this.setTitle("The agent wants to change your vault");

    // What will happen, in the user's terms — not a JSON blob to click past.
    const what = describe(this.request);
    contentEl.createEl("p", { text: what.summary, cls: "obsidian-agent-confirm-summary" });
    if (what.detail) {
      contentEl.createEl("pre", { text: what.detail, cls: "obsidian-agent-confirm-detail" });
    }
    contentEl.createEl("p", { text: `Tool: ${this.request.name}`, cls: "obsidian-agent-confirm-tool" });

    new Setting(contentEl)
      .addButton((button) => button.setButtonText("Deny").onClick(() => this.answer(false)))
      .addButton((button) => button.setButtonText("Allow once").setCta().onClick(() => this.answer(true)));
  }

  override onClose(): void {
    this.contentEl.empty();
    if (!this.answered) this.decide(false); // dismissed is denied
  }

  private answer(approved: boolean): void {
    this.answered = true;
    this.decide(approved);
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
  const known = verbs[request.name];
  // A tool without a sentence of its own — an MCP server's — shows every argument it will get: the user is asked
  // about what will run, not about its name (#135)
  const content = known ? String(input.content ?? input.new_text ?? input.text ?? "") : JSON.stringify(input, null, 2);
  const detail = content && content !== "{}" ? (content.length > 1200 ? `${content.slice(0, 1200)}…` : content) : "";
  return { summary: known ?? `Run ${request.name}`, detail };
}
