/**
 * The name of a conversation, asked for as Obsidian's *Rename file* asks (#286): the current name selected, Enter
 * renames, Escape and Cancel change nothing. A name that cannot be used is said in the dialog, which stays open.
 */

import { App, Modal, Setting } from "obsidian";

export class RenameModal extends Modal {
  constructor(app: App, private readonly current: string,
              /** Renames; resolves to an error to show, or null when it is done. */
              private readonly rename: (name: string) => Promise<string | null>) {
    super(app);
  }

  override onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass("obsidian-agent-rename");
    this.setTitle("Rename conversation");
    const input = contentEl.createEl("input", { type: "text", cls: "obsidian-agent-rename-input",
                                                attr: { "aria-label": "Conversation name" } });
    input.value = this.current;
    const problem = contentEl.createDiv({ cls: "obsidian-agent-rename-problem mod-warning" });
    const submit = async (): Promise<void> => {
      problem.setText("");
      const error = await this.rename(input.value);
      if (error) {
        problem.setText(error);
        input.focus();
        return;
      }
      this.close();
    };
    input.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" || event.isComposing) return;
      event.preventDefault();
      void submit();
    });
    new Setting(contentEl)
      .addButton((button) => button.setButtonText("Cancel").onClick(() => this.close()))
      .addButton((button) => button.setButtonText("Rename").setCta().onClick(() => void submit()));
    window.setTimeout(() => {
      input.focus();
      input.select();
    }, 0);
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}
