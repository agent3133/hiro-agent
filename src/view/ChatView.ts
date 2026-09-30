/**
 * The chat itself: a sidebar view that streams a turn, shows what the agent did, and lets you stop it.
 *
 * Everything the model produces is rendered through Obsidian's own Markdown renderer. None of it is ever put
 * into innerHTML — a reply is untrusted text that happens to arrive from a program you started.
 */

import { type Editor, ItemView, MarkdownRenderer, MarkdownView, Notice, Scope, TFile, WorkspaceLeaf, setIcon } from "obsidian";

import type { AgentSummary, ProfileSummary, SessionSummary, ToolCall, TurnChanges }
  from "../api/types";
import { buildContext, type NoteContext } from "../commands/context";
import type { InProcessAgent } from "../inprocess/InProcessAgent";
import { displayName } from "../mcp/servers";
import type { LocalServer } from "../settings/connections";
import { ConfirmModal } from "./ConfirmModal";
import { AskModal } from "./AskModal";
import { UndoModal } from "./UndoModal";
import { sessionNameFor } from "./sessionName";

export const CHAT_VIEW_TYPE = "obsidian-agent-chat";

interface ViewDeps {
  /** The agent, inside the plugin: turns, conversations, the turns it can take back (#85, #88). */
  agent(): InProcessAgent;
  defaultAgent(): string;
  /** The conversation this view had open when it was last closed, so reopening resumes rather than forgets. */
  lastSession(): string;
  rememberSession(name: string): void;
  /** Whether a new conversation is kept as a vault note. The box sets it; this remembers the answer. */
  keepByDefault(): boolean;
  rememberKeep(keep: boolean): void;
  /** The LLM connection last chosen in the header, so a new conversation starts where the last one left off. */
  lastProfile(): string;
  rememberProfile(name: string): void;
  /** A first start (#110): whether a connection is set up, and the ways to set one up from the chat. */
  setup: SetupHost;
}

export interface SetupHost {
  /** Whether any connection is set up. */
  ready(): boolean;
  /** The llama.cpp servers answering on this computer that no connection points at yet. */
  findLocal(): Promise<LocalServer[]>;
  /** Add *server* as a connection; the reason when it could not be saved. */
  addLocal(server: LocalServer): Promise<string | null>;
  openSettings(): void;
}

export class ChatView extends ItemView {
  private messages!: HTMLElement;
  private input!: HTMLTextAreaElement;
  private sendButton!: HTMLButtonElement;
  private agentPicker!: HTMLSelectElement;
  private profilePicker!: HTMLSelectElement;
  private sessionPicker!: HTMLSelectElement;
  private deleteButton!: HTMLButtonElement;
  private keepBox!: HTMLInputElement;
  private sessionName = "";
  // What this conversation was first asked, so the box can name it after the fact
  private firstPrompt = "";
  private turnId: string | null = null;
  private streaming: { body: HTMLElement; text: string } | null = null;
  // The note last worked in. Once the chat has the focus, Obsidian's activeEditor is empty, so a selection made
  // before clicking into the chat would be lost; the editor keeps it, and this remembers the editor
  private lastNote: MarkdownView | null = null;
  // Shown while no connection is set up (#110), in place of a first message that could only fail
  private setupCard: HTMLElement | null = null;

  constructor(leaf: WorkspaceLeaf, private readonly deps: ViewDeps) {
    super(leaf);
  }

  override getViewType(): string {
    return CHAT_VIEW_TYPE;
  }

  override getDisplayText(): string {
    return "Hiro Agent";
  }

  override getIcon(): string {
    return "bot";
  }

  override async onOpen(): Promise<void> {
    const root = this.contentEl;
    root.empty();
    root.addClass("obsidian-agent-chat");
    this.lastNote = this.app.workspace.getActiveViewOfType(MarkdownView);
    this.registerEvent(this.app.workspace.on("active-leaf-change", (leaf) => {
      if (leaf?.view instanceof MarkdownView) this.lastNote = leaf.view;
    }));

    const bar = root.createDiv({ cls: "obsidian-agent-bar" });
    this.agentPicker = bar.createEl("select", { cls: "dropdown obsidian-agent-picker" });
    this.profilePicker = bar.createEl("select", { cls: "dropdown obsidian-agent-profiles" });
    this.profilePicker.onchange = () => this.deps.rememberProfile(this.profilePicker.value);
    this.sessionPicker = bar.createEl("select", { cls: "dropdown obsidian-agent-sessions" });
    this.sessionPicker.onchange = () => void this.openSession(this.sessionPicker.value);
    const newChat = bar.createEl("button", { cls: "clickable-icon", attr: { "aria-label": "New conversation" } });
    setIcon(newChat, "plus");
    newChat.onclick = () => void this.newConversation();
    this.deleteButton = bar.createEl("button", { cls: "clickable-icon",
                                                 attr: { "aria-label": "Delete this conversation" } });
    setIcon(this.deleteButton, "trash-2");
    this.deleteButton.onclick = () => this.askToDelete();

    const keep = bar.createEl("label", { cls: "obsidian-agent-keep" });
    this.keepBox = keep.createEl("input", { type: "checkbox" });
    this.keepBox.checked = this.deps.keepByDefault();
    keep.createSpan({ text: "Keep" });
    keep.title = "Write this conversation to a note in the vault";
    this.keepBox.onchange = () => this.keepChanged();

    this.messages = root.createDiv({ cls: "obsidian-agent-messages" });

    const composer = root.createDiv({ cls: "obsidian-agent-composer" });
    this.input = composer.createEl("textarea", {
      cls: "obsidian-agent-input",
      attr: { rows: "3", placeholder: "Ask the agent — Enter to send, Shift+Enter for a new line" },
    });
    this.sendButton = composer.createEl("button", { text: "Send", cls: "mod-cta" });
    this.sendButton.onclick = () => void this.submit();
    this.input.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        void this.submit();
      }
    });

    // Escape cancels a running turn rather than closing the view out from under it.
    this.scope = new Scope(this.app.scope);
    this.scope.register([], "Escape", () => {
      if (!this.turnId) return true;
      this.cancel();
      return false;
    });

    await this.refreshAgents();
    this.refreshProfiles();
    await this.refreshSessions();
    const last = this.deps.lastSession();
    if (!this.deps.setup.ready()) this.showSetup();
    else if (last) await this.openSession(last);
    else this.say("system", "Ready.", false);
  }

  override async onClose(): Promise<void> {
    this.cancel();
    this.contentEl.empty();
  }

  /** The agents and connections to offer (#86). */
  private catalog(): ReturnType<InProcessAgent["info"]> {
    return this.deps.agent().info();
  }

  /** Fill the agent picker, so it lists what this vault actually has. */
  async refreshAgents(): Promise<void> {
    this.agentPicker.empty();
    const agents: AgentSummary[] = this.catalog()?.agents ?? [];
    for (const agent of agents.length ? agents : [{ name: this.deps.defaultAgent() }]) {
      const option = this.agentPicker.createEl("option", { text: agent.name, value: agent.name });
      // Which model an agent talks to is the question this picker could not answer before.
      option.title = [agent.description, agent.model ? `model: ${agent.model}` : ""].filter(Boolean).join(" · ");
    }
  }

  /**
   * Fill the connection picker. "Agent's choice" leaves it to the agent's own `llm_profile`, or to the config's
   * default when it declares none; anything else is the user overriding both, which is deliberately their call.
   */
  refreshProfiles(): void {
    const info = this.catalog();
    const profiles: ProfileSummary[] = info?.profiles ?? [];
    this.profilePicker.empty();
    this.profilePicker.toggleClass("is-hidden", profiles.length === 0);
    const auto = this.profilePicker.createEl("option", { text: "Agent's choice", value: "" });
    auto.title = info?.defaultProfile ? `Falls back to "${info.defaultProfile}"` : "Uses the configured llm block";
    for (const profile of profiles) {
      const label = profile.default ? `${profile.name} (default)` : profile.name;
      const option = this.profilePicker.createEl("option", { text: label, value: profile.name });
      option.title = [profile.provider, profile.model, profile.base_url].filter(Boolean).join(" · ");
    }
    const remembered = this.deps.lastProfile();
    this.profilePicker.value = profiles.some((profile) => profile.name === remembered) ? remembered : "";
    // A connection was just set up, here or in the settings: the card has done its job
    if (this.setupCard && this.deps.setup.ready()) {
      this.setupCard.remove();
      this.setupCard = null;
      this.say("system", "A connection is set up. Ask away.", false);
    }
  }

  /** The first start (#110): no connection yet, so say how to get one — here, or in the settings. */
  private showSetup(): void {
    if (this.setupCard) {
      this.scrollDown();
      return;
    }
    const card = this.messages.createDiv({ cls: "obsidian-agent-message mod-system obsidian-agent-setup" });
    this.setupCard = card;
    card.createEl("p", { cls: "obsidian-agent-setup-title", text: "Set up a connection" });
    card.createEl("p", { text: "Hiro Agent talks to a language model you choose: a llama.cpp server on this "
                               + "computer, or any OpenAI-compatible API." });
    const buttons = card.createDiv({ cls: "obsidian-agent-setup-buttons" });
    const find = buttons.createEl("button", { text: "Find a local server", cls: "mod-cta" });
    const settings = buttons.createEl("button", { text: "Open settings" });
    settings.onclick = () => this.deps.setup.openSettings();
    const found = card.createDiv();
    find.onclick = async () => {
      find.disabled = true;
      found.empty();
      found.createEl("p", { text: "Looking on 127.0.0.1:8080 and 8090…" });
      const servers = await this.deps.setup.findLocal();
      found.empty();
      find.disabled = false;
      if (!servers.length) {
        found.createEl("p", { text: "No llama.cpp server answers on 127.0.0.1:8080 or 8090. Start llama-server "
                                    + "and look again, or add a connection in the settings." });
        return;
      }
      for (const server of servers) {
        const use = found.createEl("button", {
          text: `Use ${server.model || "the llama.cpp server"} on port ${server.port}`, cls: "mod-cta" });
        use.onclick = async () => {
          use.disabled = true;
          const problem = await this.deps.setup.addLocal(server);
          if (problem) {
            use.disabled = false;
            new Notice(`Not saved: ${problem}`);
          }
        };
      }
    };
    this.scrollDown();
  }

  /** Fill the session picker from the vault's session notes, newest first. */
  async refreshSessions(): Promise<void> {
    let sessions: SessionSummary[] = [];
    try {
      sessions = await this.deps.agent().sessions();
    } catch {
      sessions = []; // a folder that cannot be listed must not stop you starting a conversation
    }
    this.sessionPicker.empty();
    this.sessionPicker.createEl("option", { text: "New conversation", value: "" });
    for (const session of sessions) {
      const label = session.exchanges ? `${session.name} (${session.exchanges})` : session.name;
      this.sessionPicker.createEl("option", { text: label, value: session.name });
    }
    this.sessionPicker.value = this.sessionName;
  }

  /** The box: start keeping the open conversation, or stop. Both take effect now, not on the next turn. */
  private keepChanged(): void {
    const keep = this.keepBox.checked;
    this.deps.rememberKeep(keep);
    const client = this.deps.agent();
    if (keep && !this.sessionName) {
      const name = sessionNameFor(this.firstPrompt || "conversation");
      client.nameSession("", name);
      this.setSession(name);
      new Notice(`Keeping this conversation as "${name}".`);
      window.setTimeout(() => void this.refreshSessions(), 300);
    } else if (!keep && this.sessionName) {
      client.nameSession(this.sessionName, "");
      new Notice(`No longer adding to "${this.sessionName}". The note so far is still there.`);
      this.setSession("");
    }
  }

  /** Delete the open conversation's note. Asks first: there is no undo, and the journal does not cover it. */
  private askToDelete(): void {
    const name = this.sessionName;
    if (!name) {
      new Notice("This conversation has not been saved yet.");
      return;
    }
    new AskModal(this.app, {
      title: "Delete this conversation?",
      body: `"${name}" and everything said in it go for good. Notes the agent changed are not touched.`,
      confirm: "Delete",
    }, (yes) => {
      if (yes) void this.deleteSession(name);
    }).open();
  }

  private async deleteSession(name: string): Promise<void> {
    try {
      await this.deps.agent().deleteSession(name);
    } catch (error) {
      new Notice(`That conversation could not be deleted: ${(error as Error).message}`, 10_000);
      return;
    }
    new Notice(`Deleted "${name}".`);
    // Starting a new conversation here means the next thing typed cannot recreate the note that was just removed
    await this.newConversation();
    await this.refreshSessions();
  }

  async newConversation(): Promise<void> {
    this.cancel();
    this.firstPrompt = "";
    this.deps.agent().forget();
    this.keepBox.checked = this.deps.keepByDefault();
    this.setSession("");
    this.messages.empty();
    this.say("system", "New conversation.", false);
  }

  /** Reopen a conversation from its session note. The empty name is the "New conversation" entry. */
  async openSession(name: string): Promise<void> {
    if (!name) {
      await this.newConversation();
      return;
    }
    this.cancel();
    this.firstPrompt = "";
    this.keepBox.checked = true; // it is a note already; the box shows the truth about this conversation
    this.setSession(name);
    this.messages.empty();
    try {
      const answer = await this.deps.agent().session(name);
      for (const message of answer.messages) await this.replay(message.role, message.content);
      this.say("system", this.continueOnRecordedConnection(name, answer), false);
    } catch (error) {
      this.say("system", `That conversation could not be read: ${(error as Error).message}`, false);
    }
    this.scrollDown();
  }

  /**
   * Switch the header's picker back to the connection a reopened conversation was answered with, and say so.
   *
   * Continuing a cloud conversation locally by accident, or the other way round, would surprise; the recorded
   * choice was the user's own. One that is no longer configured is named, and the picker stays as it is — never
   * a silent switch to another endpoint.
   */
  private continueOnRecordedConnection(name: string,
                                       answer: { connection?: string; model?: string; connection_exists?: boolean }): string {
    const recorded = answer.connection ?? "";
    if (!recorded) return `Continuing "${name}".`;
    const offered = Array.from(this.profilePicker.options).some((option) => option.value === recorded);
    if (!answer.connection_exists || !offered) {
      return `Continuing "${name}". It was answered with "${recorded}", which is no longer configured; `
             + "choose a connection in the header.";
    }
    this.profilePicker.value = recorded;
    this.deps.rememberProfile(recorded);
    const model = answer.model ? ` (${answer.model})` : "";
    return `Continuing "${name}" on ${recorded}${model}, as before.`;
  }

  /** One message from a session note. Tool calls and thinking are not in the note; the text is. */
  private async replay(role: string, content: string): Promise<void> {
    if (role === "user") {
      await this.say("user", content, true);
      return;
    }
    const turn = this.messages.createDiv({ cls: "obsidian-agent-message mod-agent" });
    await this.renderMarkdown(content, turn.createDiv({ cls: "obsidian-agent-body" }));
  }

  private setSession(name: string): void {
    this.sessionName = name;
    this.deps.rememberSession(name);
    if (!this.sessionPicker) return;
    // A conversation is named before its note exists, so the entry has to be added now. Setting `value` to an
    // option the list does not have selects nothing, and the picker sits blank on the conversation you are in.
    const known = Array.from(this.sessionPicker.options).some((option) => option.value === name);
    if (name && !known) this.sessionPicker.createEl("option", { text: name, value: name });
    this.sessionPicker.value = name;
    this.deleteButton?.toggleClass("is-disabled", !name);
  }

  /**
   * Run a request from a command: a new conversation, with the command's agent and context rather than what
   * the header and the active note say. The turn then streams here like any other.
   */
  async runRequest(agent: string, message: string, context: NoteContext | undefined): Promise<void> {
    if (this.turnId) {
      new Notice("The agent is still answering. Stop it or wait, then run the command again.");
      return;
    }
    await this.newConversation();
    if (Array.from(this.agentPicker.options).some((option) => option.value === agent)) this.agentPicker.value = agent;
    this.input.value = message;
    await this.submit({ context });
  }

  /** Send what is in the input. A command passes its own context, which may be none at all. */
  private async submit(request?: { context: NoteContext | undefined }): Promise<void> {
    const prompt = this.input.value.trim();
    if (!prompt || this.turnId) return;
    if (!this.deps.setup.ready()) {
      this.showSetup();
      return;
    }
    this.input.value = "";
    // The first turn names the conversation, and naming it is what writes it to a vault note: the box decides
    // whether this conversation exists outside the view — without a name it is kept in memory and nothing is written.
    if (!this.firstPrompt) this.firstPrompt = prompt;
    const isNewSession = this.keepBox.checked && !this.sessionName;
    if (isNewSession) this.setSession(sessionNameFor(prompt));
    await this.say("user", prompt, true);

    const turn = this.messages.createDiv({ cls: "obsidian-agent-message mod-agent" });
    const thinking = turn.createEl("details", { cls: "obsidian-agent-thinking" });
    thinking.createEl("summary", { text: "Thinking" });
    const thinkingBody = thinking.createEl("pre");
    thinking.hide();
    const tools = turn.createDiv({ cls: "obsidian-agent-tools" });
    const body = turn.createDiv({ cls: "obsidian-agent-body" });
    this.streaming = { body, text: "" };
    this.setRunning(true);

    const rows = new Map<string, HTMLElement>();
    const runner = this.deps.agent();
    this.turnId = runner.send(prompt, { agent: this.agentPicker.value, session: this.sessionName || undefined,
                                        profile: this.profilePicker.value || undefined,
                                        context: request ? request.context : this.activeNoteContext() }, {
      onToken: (text) => {
        if (!this.streaming) return;
        this.streaming.text += text;
        void this.renderMarkdown(this.streaming.text, body);
        this.scrollDown();
      },
      onThinking: (text) => {
        thinking.show();
        thinkingBody.setText(thinkingBody.getText() + text);
      },
      onToolCall: (call) => rows.set(call.callId, this.addToolRow(tools, call)),
      onToolResult: (callId, result, isError) => this.completeToolRow(rows.get(callId), result, isError),
      onConfirmRequest: (callId, name, input) => {
        new ConfirmModal(this.app, { name, input }, (approved) => {
          if (this.turnId) runner.confirm(this.turnId, callId, approved);
        }).open();
      },
      onDone: (reply, cancelled, usage, changed, compacted) => {
        if (reply && this.streaming) void this.renderMarkdown(reply, body);
        if (cancelled) turn.createDiv({ cls: "obsidian-agent-note", text: "Cancelled." });
        // A cancelled turn still gets its footer when it wrote something: stopping it is often why you want it back.
        if (!cancelled || changed) this.addFooter(turn, body, usage, changed);
        this.finishTurn();
        if (compacted) {
          // Said out loud: the agent's memory of those exchanges is now a summary, and that changes its answers.
          turn.createDiv({ cls: "obsidian-agent-note",
                           text: `${compacted} earlier exchanges were summarised to keep this conversation`
                                 + " inside the model's context window." });
        }
        if (isNewSession) void this.refreshSessions(); // it has a note now, so the picker should list it
      },
      onError: (message) => {
        turn.createDiv({ cls: "obsidian-agent-error", text: message });
        this.finishTurn();
      },
    });
  }

  private addToolRow(container: HTMLElement, call: ToolCall): HTMLElement {
    const row = container.createEl("details", { cls: "obsidian-agent-tool" });
    const summary = row.createEl("summary");
    summary.createSpan({ cls: "obsidian-agent-tool-name", text: displayName(call.name) });
    const argument = identifyingArgument(call.input);
    if (argument) summary.createSpan({ cls: "obsidian-agent-tool-arg", text: argument });
    summary.createSpan({ cls: "obsidian-agent-tool-state", text: "…" });
    row.createEl("pre", { cls: "obsidian-agent-tool-result" });
    return row;
  }

  private completeToolRow(row: HTMLElement | undefined, result: string, isError: boolean): void {
    if (!row) return;
    const state = row.querySelector(".obsidian-agent-tool-state");
    if (state) state.textContent = isError ? "failed" : "done";
    row.toggleClass("mod-error", isError);
    const pre = row.querySelector("pre");
    if (pre) pre.textContent = result.length > 2000 ? `${result.slice(0, 2000)}…` : result;
    if (isError) row.setAttr("open", "true");
  }

  private addFooter(turn: HTMLElement, body: HTMLElement, usage: Record<string, unknown>,
                    changed: TurnChanges | null = null): void {
    const footer = turn.createDiv({ cls: "obsidian-agent-footer" });
    const seconds = usage.seconds ? `${usage.seconds}s` : "";
    const calls = usage.tool_calls ? `${usage.tool_calls} tool calls` : "";
    // Says which one answered while the test port's switch exists (#76)
    const where = usage.in_plugin ? "in plugin" : "";
    footer.createSpan({ text: [seconds, calls, where].filter(Boolean).join(" · ") });

    if (changed) {
      const count = changed.files.length;
      // Its own span: taking the turn back does not un-spend the seconds, so only this part is struck through.
      const files = footer.createSpan({ cls: "obsidian-agent-footer-files",
                                        text: ` · ${count} file${count === 1 ? "" : "s"} changed` });
      this.addUndoButton(footer, changed, files);
    }

    const copy = footer.createEl("button", { cls: "clickable-icon", attr: { "aria-label": "Copy reply" } });
    setIcon(copy, "copy");
    copy.onclick = () => {
      void navigator.clipboard.writeText(this.streaming?.text ?? body.getText());
      new Notice("Copied.");
    };

    const insert = footer.createEl("button", { cls: "clickable-icon", attr: { "aria-label": "Insert into note" } });
    setIcon(insert, "file-input");
    insert.onclick = () => this.insertIntoActiveNote(this.streaming?.text ?? body.getText());
  }

  /** Offered only on turns that wrote something, and only while the journal still holds them. */
  private addUndoButton(footer: HTMLElement, changed: TurnChanges, files: HTMLElement): void {
    const undo = footer.createEl("button", { cls: "clickable-icon", attr: { "aria-label": "Take this turn back" } });
    setIcon(undo, "undo-2");
    undo.onclick = () => {
      new UndoModal(this.app, this.deps.agent(), changed, () => {
        undo.setAttr("disabled", "true");
        undo.setAttr("aria-label", "Taken back");
        files.addClass("obsidian-agent-footer-undone");
        files.setText(`${files.getText()} · taken back`);
      }).open();
    };
  }

  /** The editor of the note the user is working in, even while the chat has the focus. */
  private noteEditor(): Editor | undefined {
    const active = this.app.workspace.activeEditor?.editor;
    if (active) return active;
    // Still open? A closed tab's view is detached, and its file gone
    const last = this.lastNote;
    return last?.file && last.leaf.view === last ? last.editor : undefined;
  }

  private insertIntoActiveNote(text: string): void {
    const editor = this.noteEditor();
    if (!editor) {
      new Notice("Open a note to insert into.");
      return;
    }
    editor.replaceSelection(text);
  }

  private cancel(): void {
    if (!this.turnId) return;
    this.deps.agent().cancel(this.turnId);
  }

  private finishTurn(): void {
    this.turnId = null;
    this.streaming = null;
    this.setRunning(false);
    this.scrollDown();
  }

  private setRunning(running: boolean): void {
    this.sendButton.setText(running ? "Stop" : "Send");
    this.sendButton.toggleClass("mod-warning", running);
    this.sendButton.onclick = running ? () => this.cancel() : () => void this.submit();
  }

  private async say(role: "user" | "system", text: string, markdown: boolean): Promise<void> {
    const element = this.messages.createDiv({ cls: `obsidian-agent-message mod-${role}` });
    if (markdown) await this.renderMarkdown(text, element.createDiv({ cls: "obsidian-agent-body" }));
    else element.createDiv({ cls: "obsidian-agent-body", text });
    this.scrollDown();
  }

  /** Obsidian's renderer, so links and embeds behave — and so model output is never parsed as HTML by us. */
  private async renderMarkdown(text: string, target: HTMLElement): Promise<void> {
    target.empty();
    await MarkdownRenderer.render(this.app, text, target, this.activeNotePath(), this);
  }

  private activeNotePath(): string {
    const file = this.app.workspace.getActiveFile();
    return file instanceof TFile ? file.path : "";
  }

  /**
   * What the user is looking at, sent with a typed message. The key is `active_note`, as the protocol says
   * (plan §4.3); it used to be `note`, which the runtime never read, so "summarise this" never knew the note.
   */
  private activeNoteContext(): NoteContext | undefined {
    const selection = this.noteEditor()?.getSelection() ?? "";
    return buildContext(this.activeNotePath(), selection, true).context;
  }

  private scrollDown(): void {
    this.messages.scrollTop = this.messages.scrollHeight;
  }
}

/** The one argument that says what a call is about — a path, a query — for the collapsed row. */
export function identifyingArgument(input: unknown): string {
  const values = (input ?? {}) as Record<string, unknown>;
  for (const key of ["path", "from_path", "query", "pattern", "template", "task", "title"]) {
    const value = values[key];
    if (typeof value === "string" && value) return value.length > 60 ? `${value.slice(0, 60)}…` : value;
  }
  return "";
}
