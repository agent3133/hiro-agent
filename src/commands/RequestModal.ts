/**
 * "What should daily-note do?" — the box every agent command opens before anything runs.
 *
 * Asking first is deliberate: a command can be triggered by a stray hotkey, and an agent that acts on a note
 * without being told what to do is guessing. The box names the agent and the note, and lets the user leave the
 * note out — context is not always wanted.
 */

import { App, Modal, Setting } from "obsidian";

import { includeLabel } from "./context";

export interface Request {
  message: string;
  include: boolean;
}

export class RequestModal extends Modal {
  constructor(app: App,
              private readonly about: { agent: string; noteName: string; hasSelection: boolean },
              private readonly onSubmit: (request: Request) => void) {
    super(app);
  }

  override onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass("obsidian-agent-request");
    this.titleEl.setText(`Ask ${this.about.agent}`);

    const input = contentEl.createEl("textarea", {
      cls: "obsidian-agent-request-input",
      attr: { placeholder: this.about.hasSelection ? "What should it do with the selection?"
                                                   : "What should it do?", rows: "4" },
    });

    let include = true;
    const label = includeLabel(this.about.noteName, this.about.hasSelection);
    if (label) {
      new Setting(contentEl)
        .setName(label)
        .setDesc("The note is passed by name; the agent reads it itself.")
        .addToggle((toggle) => toggle.setValue(true).onChange((value) => { include = value; }));
    }

    const submit = (): void => {
      const message = input.value.trim();
      if (!message) return;
      this.close();
      this.onSubmit({ message, include });
    };
    // Enter sends and Shift+Enter starts a line, as in the chat view
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        submit();
      }
    });

    new Setting(contentEl)
      .addButton((button) => button.setButtonText("Cancel").onClick(() => this.close()))
      .addButton((button) => button.setButtonText("Ask").setCta().onClick(submit));

    window.setTimeout(() => input.focus(), 0);
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}
