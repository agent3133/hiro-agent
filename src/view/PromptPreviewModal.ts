/**
 * An agent's system prompt as its next message would send it (#67): read only, with what went into it said plainly —
 * the model named, template expressions left as written, and MCP tools taken from this device's last listing.
 */

import { App, Modal, Notice, Setting } from "obsidian";

import { messageOf } from "../core/errors";
import type { PromptAsSent } from "../inprocess/InProcessAgent";
import { previewNotes } from "./promptNotes";

export class PromptPreviewModal extends Modal {
  constructor(app: App, private readonly agent: string, private readonly preview: Promise<PromptAsSent>) {
    super(app);
  }

  override onOpen(): void {
    const { contentEl } = this;
    this.modalEl.addClass("obsidian-agent-prompt-preview");
    this.setTitle(`${this.agent}: the prompt as sent`);
    const notes = contentEl.createDiv({ cls: "obsidian-agent-prompt-preview-notes" });
    const body = contentEl.createEl("pre", { cls: "obsidian-agent-prompt-preview-text", text: "Filling in the prompt…" });
    let copied = "";
    new Setting(contentEl)
      .addButton((button) => {
        // Usable once the prompt is there
        button.setButtonText("Copy").setDisabled(true).onClick(() => {
          void navigator.clipboard.writeText(copied).then(() => new Notice("Prompt copied"));
        });
        void this.preview.then((sent) => {
          copied = sent.text;
          body.setText(sent.text);
          for (const line of previewNotes(sent)) notes.createEl("p", { cls: "setting-item-description", text: line });
          button.setDisabled(false);
        }, (error: unknown) => {
          body.setText(`The prompt could not be filled in: ${messageOf(error)}`);
        });
      })
      .addButton((button) => button.setButtonText("Close").setCta().onClick(() => this.close()));
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}
