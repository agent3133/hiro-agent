/**
 * What a turn changed, and the offer to put it back.
 *
 * Undo is destructive in its own right — it overwrites what is on disk now — so it asks the same way a
 * destructive tool does, and shows the diff first rather than a count of files. Dismissing means keep.
 *
 * The runtime only restores files that still hold exactly what the agent left. Which files those are is asked
 * before the question, not discovered by clicking: a file you have edited since is named here and the offer is
 * withdrawn when none of them can come back. Finding that out afterwards reads as a broken undo.
 */

import { App, Modal, Notice, Setting } from "obsidian";

import type { TurnChanges } from "../api/types";
import type { InProcessAgent } from "../inprocess/InProcessAgent";

export class UndoModal extends Modal {
  private busy = false;
  private undoButton: HTMLElement | null = null;

  constructor(app: App, private readonly client: Pick<InProcessAgent, "turnDiff" | "undoTurn">,
              private readonly changed: TurnChanges,
              private readonly onUndone: () => void) {
    super(app);
  }

  override onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass("obsidian-agent-undo");
    this.setTitle("Take this turn back?");

    const list = contentEl.createEl("ul", { cls: "obsidian-agent-undo-files" });
    for (const file of this.changed.files) list.createEl("li", { text: file });

    const warning = contentEl.createEl("p", { cls: "obsidian-agent-undo-warning" });
    warning.hide();
    const diff = contentEl.createEl("pre", { cls: "obsidian-agent-undo-diff", text: "Loading the diff…" });
    void this.load(diff, warning);

    contentEl.createEl("p", {
      cls: "obsidian-agent-undo-note",
      text: "Only files still holding what the agent wrote are restored. Anything you edited since is left alone.",
    });

    new Setting(contentEl)
      .addButton((button) => button.setButtonText("Keep").onClick(() => this.close()))
      .addButton((button) => {
        this.undoButton = button.buttonEl;
        button.setButtonText("Take it back").setWarning().onClick(() => void this.undo(button.buttonEl));
      });
  }

  override onClose(): void {
    this.contentEl.empty();
  }

  private async load(diff: HTMLElement, warning: HTMLElement): Promise<void> {
    let answer;
    try {
      answer = await this.client.turnDiff(this.changed.turn);
    } catch (error) {
      diff.setText(`The diff could not be read: ${(error as Error).message}`);
      return;
    }
    diff.setText(answer.diff || "(nothing textual changed)");
    if (!answer.stale?.length) return;

    const all = answer.stale.length >= this.changed.files.length;
    warning.setText(all
      ? `Nothing here can be taken back: you have edited ${answer.stale.join(", ")} since the agent wrote it.`
      : `Edited since, and so left alone: ${answer.stale.join(", ")}`);
    warning.show();
    // Nothing would come back, so withdraw the offer — and say so on the button itself. A control that is
    // disabled but still reads as clickable is its own small trap.
    if (all && this.undoButton) {
      this.undoButton.setAttr("disabled", "true");
      this.undoButton.setText("Nothing to restore");
    }
  }

  private async undo(button: HTMLElement): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    button.setAttr("disabled", "true");
    try {
      const result = await this.client.undoTurn(this.changed.turn);
      new Notice(describeUndo(result), result.refused.length ? 10_000 : 4_000);
      if (result.restored.length) this.onUndone();
      this.close();
    } catch (error) {
      new Notice(`Nothing was taken back: ${(error as Error).message}`, 10_000);
      this.busy = false;
      button.removeAttribute("disabled");
    }
  }
}

/** The result as a sentence: what came back, and what was left alone and why. */
export function describeUndo(result: { restored: string[]; refused: { path: string; reason: string }[] }): string {
  const restored = result.restored.length
    ? `Restored ${result.restored.length} file${result.restored.length === 1 ? "" : "s"}.`
    : "Nothing was restored.";
  if (!result.refused.length) return restored;
  const kept = result.refused
    .map((item) => (item.path ? `${item.path} — ${item.reason}` : item.reason))
    .join("; ");
  return `${restored} Left alone: ${kept}`;
}
