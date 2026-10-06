/**
 * Going back to before a message (#303): what the answers since then changed, all of it in one diff, and the offer
 * to take it back and remove those messages from the conversation. Like undo, it asks first and shows the diff;
 * a file edited since the agent wrote it is named and left alone.
 */

import { App, Modal, Notice, Setting } from "obsidian";

import { messageOf } from "../core/errors";
import type { InProcessAgent } from "../inprocess/InProcessAgent";
import { describeUndo, renderDiff } from "./UndoModal";

export interface RewindRequest {
  /** The questions and answers removed: the message gone back to, and every one after it. */
  exchanges: number;
  /** The answers among them that changed files, newest first. */
  turns: string[];
  /** Answers among them whose changes cannot be taken back: from before Obsidian started, or out of the journal. */
  unknown: number;
}

export class RewindModal extends Modal {
  private busy = false;

  constructor(app: App, private readonly client: Pick<InProcessAgent, "turnDiff">,
              private readonly request: RewindRequest,
              private readonly onConfirm: () => Promise<{ restored: string[]; refused: { path: string; reason: string }[] }>) {
    super(app);
  }

  override onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass("obsidian-agent-undo");
    this.modalEl.addClass("obsidian-agent-undo-modal");
    this.setTitle("Go back to before this message?");
    const { exchanges, turns, unknown } = this.request;
    const answers = `${exchanges} question${exchanges === 1 ? "" : "s"} and ${exchanges === 1 ? "its answer" : "their answers"}`;
    contentEl.createEl("p", { text: `This message and everything after it — ${answers} — are removed from the `
      + "conversation, and the message goes back into the input box to send again or change." });
    const what = contentEl.createEl("p");
    what.setText(turns.length
      ? `What ${turns.length === 1 ? "the answer" : `${turns.length} answers`} changed in the vault is taken back:`
      : "No answer since then changed anything in the vault that can be taken back.");
    if (unknown) {
      contentEl.createEl("p", { cls: "obsidian-agent-undo-warning",
        text: `${unknown} answer${unknown === 1 ? "" : "s"} from before Obsidian started the plugin cannot be taken back: `
          + "anything they changed in the vault stays." });
    }
    const warning = contentEl.createEl("p", { cls: "obsidian-agent-undo-warning" });
    warning.hide();
    const diff = contentEl.createDiv({ cls: "obsidian-agent-undo-diff" });
    if (turns.length) {
      diff.setText("Loading the diff…");
      void this.load(diff, warning);
    } else {
      diff.hide();
    }
    contentEl.createEl("p", {
      cls: "obsidian-agent-undo-note",
      text: "Only files still holding what the agent wrote are restored. Anything you edited since is left alone.",
    });
    new Setting(contentEl)
      .addButton((button) => button.setButtonText("Keep").onClick(() => this.close()))
      .addButton((button) => button.setButtonText("Go back").setDestructive().onClick(() => void this.confirm(button.buttonEl)));
  }

  override onClose(): void {
    this.contentEl.empty();
  }

  private async load(diff: HTMLElement, warning: HTMLElement): Promise<void> {
    const parts: string[] = [];
    const stale: string[] = [];
    try {
      // Oldest first, as they happened
      for (const turn of [...this.request.turns].reverse()) {
        const answer = await this.client.turnDiff(turn);
        parts.push(answer.diff);
        stale.push(...answer.stale);
      }
    } catch (error) {
      diff.setText(`The diff could not be read: ${messageOf(error)}`);
      return;
    }
    renderDiff(diff, parts.join("\n"));
    if (stale.length) {
      warning.setText(`Edited since, and so left alone: ${[...new Set(stale)].join(", ")}`);
      warning.show();
    }
  }

  private async confirm(button: HTMLElement): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    button.setAttr("disabled", "true");
    try {
      const result = await this.onConfirm();
      if (this.request.turns.length) new Notice(describeUndo(result), result.refused.length ? 10_000 : 4_000);
      this.close();
    } catch (error) {
      new Notice(`Going back did not finish: ${messageOf(error)}`, 10_000);
      this.busy = false;
      button.removeAttribute("disabled");
    }
  }
}
