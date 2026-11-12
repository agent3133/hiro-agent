/**
 * The memory profile, to read and edit (#401). It lives in `.memory/` by default, a folder Obsidian neither shows nor
 * opens, so "a note you can edit" needed a place to edit it: this dialog, from the command *Edit the memory profile*.
 */

import { App, Modal, Notice, Setting } from "obsidian";

export interface ProfileHost {
  /** The profile's text without its frontmatter; "" when there is none yet. */
  read(): Promise<string>;
  /** Save *text* as the profile. */
  save(text: string): Promise<void>;
  /** Where it is kept, as the settings name it. */
  path: string;
}

export class ProfileModal extends Modal {
  private text = "";

  constructor(app: App, private readonly host: ProfileHost) {
    super(app);
  }

  override async onOpen(): Promise<void> {
    this.setTitle("Memory profile");
    const { contentEl } = this;
    contentEl.addClass("obsidian-agent-profile");
    contentEl.createEl("p", { text: `What the agent keeps about you, in ${this.host.path}. It reads this at the start of `
                                     + "each conversation while Memory is on; change or remove anything here." });
    this.text = await this.host.read();
    const area = contentEl.createEl("textarea", { cls: "obsidian-agent-profile-text" });
    area.value = this.text;
    area.placeholder = "Nothing kept yet.";
    area.addEventListener("input", () => { this.text = area.value; });
    new Setting(contentEl)
      .addButton((button) => button.setButtonText("Cancel").onClick(() => this.close()))
      .addButton((button) => button.setButtonText("Save").setCta().onClick(async () => {
        try {
          await this.host.save(this.text);
          new Notice("Memory profile saved.");
          this.close();
        } catch (error) {
          new Notice(`Not saved: ${error instanceof Error ? error.message : String(error)}`, 10_000);
        }
      }));
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}
