/**
 * A yes/no question about something that cannot be undone.
 *
 * `ConfirmModal` answers the runtime about a tool call; this one is for the plugin's own destructive actions,
 * where there is no call id and nothing waiting on a socket. Same rule: dismissing is declining, so Escape,
 * clicking outside and closing the window all mean no.
 */

import { App, Modal, Setting } from "obsidian";

export class AskModal extends Modal {
  private answered = false;

  constructor(app: App, private readonly question: { title: string; body: string; confirm: string },
              private readonly decide: (yes: boolean) => void) {
    super(app);
  }

  override onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass("obsidian-agent-ask");
    this.setTitle(this.question.title);
    contentEl.createEl("p", { text: this.question.body });

    new Setting(contentEl)
      .addButton((button) => button.setButtonText("Cancel").onClick(() => this.close()))
      .addButton((button) => button.setButtonText(this.question.confirm).setWarning()
        .onClick(() => this.answer(true)));
  }

  override onClose(): void {
    this.contentEl.empty();
    if (!this.answered) this.decide(false);
  }

  private answer(yes: boolean): void {
    this.answered = true;
    this.decide(yes);
    this.close();
  }
}
