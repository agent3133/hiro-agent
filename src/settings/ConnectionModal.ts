/**
 * Adding or editing a connection in one form (#149, usability review): its name, where it is, which model, which
 * key from Obsidian's keychain — tested in place and saved together. There is no kind to pick: every server speaks
 * the same API, and what differs (llama.cpp, Ollama, vLLM, LM Studio) is found out from the address.
 */

import { type App, Modal, SecretComponent, Setting } from "obsidian";

import { draftProblem, type ConnectionDraft } from "./connections";

export interface ConnectionFormHost {
  app: App;
  /** The other connections' names. */
  taken: string[];
  /** Store *draft*; null when stored, or why not. */
  save(draft: ConnectionDraft): Promise<string | null>;
  /** Ask the server for its models with the key, as a message would; the verdict in words, and the models. */
  test(draft: ConnectionDraft): Promise<{ ok: boolean; text: string; models?: string[] }>;
}

let lists = 0;

export class ConnectionModal extends Modal {
  private readonly draft: ConnectionDraft;

  constructor(private readonly host: ConnectionFormHost, draft: ConnectionDraft, private readonly editing: boolean) {
    super(host.app);
    this.draft = { ...draft };
  }

  override onOpen(): void {
    this.setTitle(this.editing ? `Connection '${this.draft.name}'` : "Add a connection");
    this.draw();
  }

  override onClose(): void {
    this.contentEl.empty();
  }

  private draw(): void {
    const { contentEl } = this;
    contentEl.empty();

    new Setting(contentEl).setName("Name")
      .setDesc("How the chat header lists it. Letters, digits, dashes and underscores.")
      .addText((text) => text.setPlaceholder("cloud").setValue(this.draft.name)
        .onChange((value) => { this.draft.name = value.trim(); }));
    new Setting(contentEl).setName("Address")
      .setDesc("Empty for OpenAI itself. Another provider's API, e.g. https://openrouter.ai/api/v1, or a server "
               + "you run: llama.cpp (http://127.0.0.1:8080), Ollama (http://127.0.0.1:11434), LM Studio (:1234), "
               + "vLLM (:8000). What kind of server it is, is found out.")
      .addText((text) => text.setPlaceholder("https://api.openai.com/v1")
        .setValue(this.draft.baseUrl).onChange((value) => { this.draft.baseUrl = value.trim(); }));
    // Typed freely, with the server's models as suggestions once a test has listed them
    const suggestions = contentEl.createEl("datalist", { attr: { id: `obsidian-agent-models-${++lists}` } });
    new Setting(contentEl).setName("Model")
      .setDesc("The model's name there. Empty for a server of your own: the model it has loaded, or the first it "
               + "lists. Test lists the models it offers.")
      .addText((text) => {
        text.inputEl.setAttr("list", suggestions.id);
        text.setPlaceholder("gpt-4o-mini").setValue(this.draft.model)
          .onChange((value) => { this.draft.model = value.trim(); });
      });
    const key = new Setting(contentEl).setName("API key")
      .setDesc("From Obsidian's keychain (Settings → Keychain): pick an entry, or add one here. The value stays in "
               + "the keychain. A server on this computer usually needs none.");
    new SecretComponent(this.app, key.controlEl).setValue(this.draft.key)
      .onChange((value) => { this.draft.key = value; });

    const result = contentEl.createDiv({ cls: "setting-item-description obsidian-agent-connection-result" });
    new Setting(contentEl)
      .addButton((button) => button.setButtonText("Test").onClick(async () => {
        button.setDisabled(true);
        result.removeClass("mod-warning");
        result.setText("Asking the server…");
        const verdict = await this.host.test(this.draft);
        suggestions.empty();
        for (const model of verdict.models ?? []) suggestions.createEl("option", { attr: { value: model } });
        result.setText(verdict.text);
        result.toggleClass("mod-warning", !verdict.ok);
        button.setDisabled(false);
      }))
      .addButton((button) => button.setButtonText("Cancel").onClick(() => this.close()))
      .addButton((button) => button.setButtonText("Save").setCta().onClick(async () => {
        const problem = draftProblem(this.draft, this.host.taken) ?? await this.host.save(this.draft);
        if (problem) {
          result.setText(problem);
          result.addClass("mod-warning");
          return;
        }
        this.close();
      }));
  }
}

/** A yes for this device only, named for what it allows. Dismissing is no. */
export class ApprovalModal extends Modal {
  private answered = false;

  constructor(app: App, private readonly title: string, private readonly lines: string[],
              private readonly detail: string, private readonly decide: (yes: boolean) => void) {
    super(app);
  }

  override onOpen(): void {
    this.setTitle(this.title);
    for (const line of this.lines) this.contentEl.createEl("p", { text: line });
    if (this.detail) this.contentEl.createEl("pre", { text: this.detail, cls: "obsidian-agent-confirm-detail" });
    new Setting(this.contentEl)
      .addButton((button) => button.setButtonText("Cancel").onClick(() => this.answer(false)))
      .addButton((button) => button.setButtonText("Allow on this device").setDestructive().onClick(() => this.answer(true)));
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
