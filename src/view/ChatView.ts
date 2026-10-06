/**
 * The chat itself: a sidebar view that streams a turn, shows what the agent did, and lets you stop it.
 *
 * Everything the model produces is rendered through Obsidian's own Markdown renderer. None of it is ever put
 * into innerHTML — a reply is untrusted text that happens to arrive from a program you started.
 */

import type { EditorView } from "@codemirror/view";
import { type Editor, ItemView, Keymap, MarkdownRenderer, MarkdownView, Menu, Notice, Scope, TFile, WorkspaceLeaf, setIcon } from "obsidian";

import type { AgentSummary, ProfileSummary, ToolCall, TurnChanges }
  from "../api/types";
import type { SavedCall, SessionSummary } from "../core/sessions";
import { buildContext, type NoteContext } from "../commands/context";
import { messageOf } from "../core/errors";
import type { InProcessAgent } from "../inprocess/InProcessAgent";
import { displayName } from "../mcp/servers";
import { serverLabel, type LocalServer } from "../settings/connections";
import { ConfirmModal } from "./ConfirmModal";
import { AskModal } from "./AskModal";
import { RewindModal } from "./RewindModal";
import { UndoModal } from "./UndoModal";
import { showKeptSelection } from "./keptSelection";
import type { ContextUsage } from "./contextMeter";
import { renderContextStatus } from "./contextStatus";
import { sessionNameFor } from "./sessionName";
import { ACCEPT, attachmentPrompt, checkAttachment, formatSize } from "./attachments";
import { coalesce } from "./coalesce";
import { asStreaming } from "./streamingMarkdown";
import { RenameModal } from "./RenameModal";
import { listedSessions, readableName, sessionLabels } from "./sessionLabels";
import { pickedTarget } from "./pickedTarget";
import { callArguments, callLine } from "./toolCallText";
import { isRemote, withoutRemoteMedia } from "./safeMarkdown";

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
  /** Show how full the context window is in Obsidian's status bar; null hides it (#151). */
  context(usage: ContextUsage | null): void;
  /** This view was focused or sent something: commands and the context meter follow it (#153). */
  used(view: ChatView): void;
  /** Whether this is the chat used last, whose context the status bar shows. */
  current(view: ChatView): boolean;
  /** Whether conversation *name* is open in another chat view; *reveal* switches to that view (#153). */
  openElsewhere(name: string, view: ChatView, reveal: boolean): boolean;
  /** The conversations changed in *view* — an answer, a new title: the other chat views list them again (#286). */
  sessionsChanged(view: ChatView): void;
  /** Settles once the agents and connections are first read; a chat restored at startup waits for it. */
  loaded(): Promise<void>;
  /** Another chat window, with conversation *name* or a new one (#301). */
  newWindow(name?: string): Promise<void>;
}

export interface SetupHost {
  /** Whether any connection is set up. */
  ready(): boolean;
  /** The local servers answering on this computer that no connection points at yet. */
  findLocal(): Promise<LocalServer[]>;
  /** Add *server* as a connection; the reason when it could not be saved. */
  addLocal(server: LocalServer): Promise<string | null>;
  openSettings(): void;
}

/** The picker's entry for an open conversation that is not kept (#286): not a name a note can have. */
const UNKEPT = "\u0000unkept";

export class ChatView extends ItemView {
  private messages!: HTMLElement;
  /** The text each rendered message was drawn from, to draw it again once Obsidian allows what it held back (#189). */
  private readonly drawnFrom = new WeakMap<HTMLElement, string>();
  private input!: HTMLTextAreaElement;
  private sendButton!: HTMLButtonElement;
  /** Files added to the next message, saved to the vault only when it is sent (#190). */
  private pending: File[] = [];
  private chips!: HTMLElement;
  private agentPicker!: HTMLSelectElement;
  private profilePicker!: HTMLSelectElement;
  private sessionPicker!: HTMLSelectElement;
  private menuButton!: HTMLButtonElement;
  /** The titles the conversations in the picker were given, by name (#286). */
  private titles = new Map<string, string>();
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
  // Above the input: the note and selection a typed message takes along (#218)
  private contextLine: HTMLElement | null = null;
  /** This view's own, for its conversation while it is not kept: two chats never share one (#153). */
  readonly viewId = crypto.randomUUID();
  // How full the window was after this view's last answer, shown again when the view is focused (#153)
  private usage: ContextUsage | null = null;
  private meter!: HTMLElement;

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
      // Back in this chat: list the conversations again, as notes in .sessions/ may have been removed or added
      // outside it — in the file explorer, or by sync (2026-10-05). Not while an answer is coming in
      if (leaf === this.leaf && !this.turnId) void this.refreshSessions();
    }));

    // The conversation first, then who answers it, then what happens to it (#286); a new conversation is the
    // picker's first entry, so there is no + button. Named for screen readers, as the icon button is (#173)
    const bar = root.createDiv({ cls: "obsidian-agent-bar" });
    this.sessionPicker = bar.createEl("select", { cls: "dropdown obsidian-agent-sessions",
                                                  attr: { "aria-label": "Conversation" } });
    // Ctrl/Cmd held while picking opens the conversation in another window (#301), as a note opens in a new tab.
    // A native list says nothing of the keys when it changes: they are noted on the click that opens it, and while
    // it is open
    let mod = false;
    const note = (event: MouseEvent | KeyboardEvent): void => { mod = Keymap.isModEvent(event) !== false; };
    this.sessionPicker.addEventListener("mousedown", note);
    this.registerDomEvent(window, "keydown", (event) => { if (event.key === "Control" || event.key === "Meta") mod = true; });
    this.registerDomEvent(window, "keyup", (event) => { if (event.key === "Control" || event.key === "Meta") mod = false; });
    this.sessionPicker.onchange = () => {
      const picked = this.sessionPicker.value;
      const target = pickedTarget(picked, this.sessionName, UNKEPT, mod);
      mod = false;
      if (target === "window") {
        this.showInPicker();  // this window keeps its conversation
        void this.deps.newWindow(picked || undefined);
      } else if (target === "here") {
        void this.openSession(picked);
      }
    };
    this.agentPicker = bar.createEl("select", { cls: "dropdown obsidian-agent-picker", attr: { "aria-label": "Agent" } });
    this.profilePicker = bar.createEl("select", { cls: "dropdown obsidian-agent-profiles",
                                                  attr: { "aria-label": "Connection" } });
    this.profilePicker.onchange = () => this.deps.rememberProfile(this.profilePicker.value);

    const keep = bar.createEl("label", { cls: "obsidian-agent-keep" });
    this.keepBox = keep.createEl("input", { type: "checkbox" });
    this.keepBox.checked = this.deps.keepByDefault();
    keep.createSpan({ text: "Keep" });
    keep.title = "Write this conversation to a note in the vault";
    this.keepBox.onchange = () => this.keepChanged();
    // Rename and Delete in one menu (#286): the header has no room for an icon each
    this.menuButton = bar.createEl("button", { cls: "clickable-icon", attr: { "aria-label": "Conversation actions" } });
    setIcon(this.menuButton, "more-horizontal");
    this.menuButton.onclick = (event) => this.conversationMenu(event);

    this.messages = root.createDiv({ cls: "obsidian-agent-messages" });
    // Obsidian shows no menu of its own on selected text in a view: offer Copy, as an editor would (#217)
    this.registerDomEvent(this.messages, "contextmenu", (event) => {
      const selected = this.messages.ownerDocument.getSelection();
      const text = selected && !selected.isCollapsed && this.messages.contains(selected.anchorNode) ? selected.toString() : "";
      if (!text.trim()) return;
      event.preventDefault();
      new Menu().addItem((item) => item.setTitle("Copy").setIcon("copy").onClick(() => {
        void navigator.clipboard.writeText(text).then(() => new Notice("Copied"));
      })).showAtMouseEvent(event);
    });

    // Files added to the next message: by "+", or dropped anywhere on the chat (#190)
    this.chips = root.createDiv({ cls: "obsidian-agent-attachments is-hidden" });
    // What a typed message takes along: the note, and its selection (#218)
    this.contextLine = root.createDiv({ cls: "obsidian-agent-context-line is-hidden" });
    // The context meter in the chat itself, for a chat in a window of its own: that window has no status bar. In the
    // main window the status bar's meter is the one, and two would be one too many (2026-10-06)
    this.meter = root.createDiv({ cls: "obsidian-agent-context obsidian-agent-chat-meter is-hidden" });
    this.placeMeter();
    this.registerEvent(this.app.workspace.on("layout-change", () => this.placeMeter()));
    const composer = root.createDiv({ cls: "obsidian-agent-composer" });
    this.input = composer.createEl("textarea", {
      cls: "obsidian-agent-input",
      attr: { rows: "3", placeholder: "Ask the agent — Enter to send, Shift+Enter for a new line" },
    });
    const actions = composer.createDiv({ cls: "obsidian-agent-actions" });
    const add = actions.createEl("button", { cls: "clickable-icon obsidian-agent-add",
                                             attr: { "aria-label": "Add images, PDFs, recordings or videos" } });
    setIcon(add, "plus");
    const picker = actions.createEl("input", { type: "file", attr: { multiple: "", accept: ACCEPT } });
    picker.hide();
    add.onclick = () => picker.click();
    picker.onchange = () => {
      this.addFiles(Array.from(picker.files ?? []));
      picker.value = "";
    };
    this.sendButton = actions.createEl("button", { text: "Send", cls: "mod-cta" });
    const carriesFiles = (event: DragEvent): boolean => Array.from(event.dataTransfer?.types ?? []).includes("Files");
    this.registerDomEvent(root, "dragover", (event) => {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      root.addClass("is-dropping");
    });
    this.registerDomEvent(root, "dragleave", (event) => {
      if (!root.contains(event.relatedTarget as Node | null)) root.removeClass("is-dropping");
    });
    this.registerDomEvent(root, "drop", (event) => {
      root.removeClass("is-dropping");
      if (!carriesFiles(event)) return;
      event.preventDefault();
      this.addFiles(Array.from(event.dataTransfer?.files ?? []));
    });

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

    // Commands and the context meter go to the chat used last (#153)
    this.registerDomEvent(this.containerEl, "focusin", () => {
      this.deps.used(this);
      this.keepNoteSelection();
    });

    // Restored with the workspace, a chat can open before the plugin has read the agents and connections
    await this.deps.loaded();
    await this.refreshAgents();
    this.refreshProfiles();
    await this.refreshSessions();
    // A second chat window starts a conversation of its own rather than loading the first one's twice (#153)
    const last = this.deps.lastSession();
    if (!this.deps.setup.ready()) this.showSetup();
    else if (last && !this.deps.openElsewhere(last, this, false)) await this.openSession(last);
    else void this.say("system", "Ready.", false);
  }

  override async onClose(): Promise<void> {
    this.cancel();
    this.showContext(null);
    this.contentEl.empty();
  }

  /** The conversation open here: its session name, or "" while it is not kept. */
  session(): string {
    return this.sessionName;
  }

  /** How full the context window was after this view's last answer; null before one. */
  contextUsage(): ContextUsage | null {
    return this.usage;
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
    auto.title = info?.defaultProfile ? `Falls back to "${info.defaultProfile}"` : "No default connection is chosen: Settings → Hiro Agent → Connections";
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
      void this.say("system", "A connection is set up. Ask away.", false);
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
    card.createEl("p", { text: "Hiro Agent talks to a language model you choose: a server on this computer "
                               + "(llama.cpp, Ollama, LM Studio, vLLM), or any OpenAI-compatible API." });
    const buttons = card.createDiv({ cls: "obsidian-agent-setup-buttons" });
    const find = buttons.createEl("button", { text: "Find a local server", cls: "mod-cta" });
    const settings = buttons.createEl("button", { text: "Open settings" });
    settings.onclick = () => this.deps.setup.openSettings();
    const found = card.createDiv();
    find.onclick = async () => {
      find.disabled = true;
      found.empty();
      found.createEl("p", { text: "Looking on this computer…" });
      const servers = await this.deps.setup.findLocal();
      found.empty();
      find.disabled = false;
      if (!servers.length) {
        found.createEl("p", { text: "No server answers on this computer's usual ports (llama.cpp 8080 and 8090, "
                                    + "vLLM 8000, LM Studio 1234, Ollama 11434). Start one and look again, or add a "
                                    + "connection in the settings." });
        return;
      }
      for (const server of servers) {
        const use = found.createEl("button", {
          text: `Use ${server.model || "the server"} (${serverLabel(server)})`, cls: "mod-cta" });
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
    // Titles, or names made readable; the option's value stays the name, which identifies the note (#286)
    this.titles = new Map(sessions.filter((s) => s.title).map((s) => [s.name, s.title!]));
    // The open conversation is listed before its note exists, or a refresh during its first answer blanks the picker
    sessions = listedSessions(sessions, this.sessionName,
                              (name) => ({ name, agent: "", model: "", updated: "", exchanges: 0 }));
    const labels = sessionLabels(sessions);
    for (const session of sessions) {
      this.sessionPicker.createEl("option", { text: labels.get(session.name) ?? session.name, value: session.name });
    }
    this.showInPicker();
  }

  /** The box: start keeping the open conversation, or stop. Both take effect now, not on the next turn. */
  private keepChanged(): void {
    const keep = this.keepBox.checked;
    this.deps.rememberKeep(keep);
    const client = this.deps.agent();
    if (keep && !this.sessionName) {
      const name = sessionNameFor(this.firstPrompt || "conversation");
      client.nameSession("", name, this.viewId);
      this.setSession(name);
      new Notice(`Keeping this conversation as "${name}".`);
      window.setTimeout(() => void this.refreshSessions(), 300);
    } else if (!keep && this.sessionName) {
      client.nameSession(this.sessionName, "", this.viewId);
      new Notice(`No longer adding to "${this.sessionName}". The note so far is still there.`);
      this.setSession("");
    }
  }

  /** The header's ⋯ menu: another window, rename the conversation, or delete it once it is kept (#286, #301). */
  private conversationMenu(event: MouseEvent): void {
    const menu = new Menu();
    menu.addItem((item) => item.setTitle("Open a new chat window").setIcon("plus")
      .onClick(() => void this.deps.newWindow()));
    menu.addSeparator();
    menu.addItem((item) => item.setTitle("Rename conversation…").setIcon("pencil")
      .onClick(() => this.renameConversation()));
    menu.addItem((item) => {
      item.setTitle("Delete conversation").setIcon("trash-2").setDisabled(!this.sessionName)
        .onClick(() => this.askToDelete());
      (item as unknown as { setWarning?(warning: boolean): unknown }).setWarning?.(true);
    });
    menu.showAtMouseEvent(event);
  }

  /**
   * Ask for a new name and rename the open conversation (#286); one that is not kept is kept under it. Not while an
   * answer is coming: its note is written when the answer ends, under the name it started with.
   */
  renameConversation(): void {
    if (this.turnId) {
      new Notice("Wait until the answer is done, then rename the conversation.");
      return;
    }
    const current = this.titles.get(this.sessionName)
      ?? (this.sessionName ? readableName(this.sessionName) : this.firstPrompt.trim().slice(0, 60));
    new RenameModal(this.app, current, async (wanted) => {
      const title = wanted.trim();
      const agent = this.deps.agent();
      let name = this.sessionName;
      try {
        if (!name) {
          // Not kept yet: kept now, under a name of its own as Keep would give it, and called what was typed
          name = sessionNameFor(this.firstPrompt || title || "conversation");
          agent.nameSession("", name, this.viewId);
          this.keepBox.checked = true;
          this.setSession(name);
        }
        await agent.titleSession(name, title);
      } catch (error) {
        return messageOf(error);
      }
      this.deps.sessionsChanged(this);
      await this.refreshSessions();
      new Notice(title ? `Renamed to "${title}".` : `"${readableName(name)}" has no title now.`);
      return null;
    }).open();
  }

  /** The conversations changed in another chat view: list them again (#286). */
  async followRename(): Promise<void> {
    await this.refreshSessions();
  }

  /** How a conversation is called here: its title, or its name made readable (#286). */
  private labelOf(name: string): string {
    return this.titles.get(name) ?? readableName(name);
  }

  /**
   * Delete the open conversation's note, into the trash Obsidian is set to use (#322). Asks first: undo does not cover
   * it, as the journal does not record the conversation's own note.
   */
  private askToDelete(): void {
    const name = this.sessionName;
    if (!name) {
      new Notice("This conversation has not been saved yet.");
      return;
    }
    new AskModal(this.app, {
      title: "Delete this conversation?",
      body: `"${this.labelOf(name)}" and everything said in it go to the trash, as Obsidian is set to keep deleted `
            + "files (Settings → Files and links). Notes the agent changed are not touched.",
      confirm: "Delete",
    }, (yes) => {
      if (yes) void this.deleteSession(name);
    }).open();
  }

  private async deleteSession(name: string): Promise<void> {
    try {
      await this.deps.agent().deleteSession(name);
    } catch (error) {
      new Notice(`That conversation could not be deleted: ${messageOf(error)}`, 10_000);
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
    this.deps.agent().forget(this.viewId);
    this.keepBox.checked = this.deps.keepByDefault();
    this.setSession("");
    this.messages.empty();
    this.showContext(null);
    void this.say("system", "New conversation.", false);
  }

  /** Reopen a conversation from its session note. The empty name is the "New conversation" entry. */
  async openSession(name: string): Promise<void> {
    if (!name) {
      await this.newConversation();
      return;
    }
    // Open in another chat already: go there, rather than hold one conversation in two places (#153)
    if (this.deps.openElsewhere(name, this, true)) {
      this.showInPicker();
      return;
    }
    this.cancel();
    this.firstPrompt = "";
    this.keepBox.checked = true; // it is a note already; the box shows the truth about this conversation
    this.setSession(name);
    this.messages.empty();
    this.showContext(null);
    try {
      const answer = await this.deps.agent().session(name);
      // Without a count: the note records only the last summary's, and an earlier one may be folded into it
      if (answer.summary) await this.addSummaryDivider(0, answer.summary.text);
      for (const message of answer.messages) await this.replay(message.role, message.content, message.calls);
      void this.say("system", this.continueOnRecordedConnection(name, answer), false);
    } catch (error) {
      // Its note is gone — removed outside the chat (2026-10-05): list what is there now, start a new conversation,
      // and say what happened, rather than sit on a name the list can no longer open
      await this.refreshSessions();
      if (!Array.from(this.sessionPicker.options).some((option) => option.value === name)) {
        await this.newConversation();
        void this.say("system", `"${readableName(name)}" is no longer in the vault: its note in .sessions/ was removed `
                 + "outside the chat. The list of conversations is up to date again.", false);
        return;
      }
      void this.say("system", `That conversation could not be read: ${messageOf(error)}`, false);
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
    if (!recorded) return `Continuing "${this.labelOf(name)}".`;
    const offered = Array.from(this.profilePicker.options).some((option) => option.value === recorded);
    if (!answer.connection_exists || !offered) {
      return `Continuing "${this.labelOf(name)}". It was answered with "${recorded}", which is no longer configured; `
             + "choose a connection in the header.";
    }
    this.profilePicker.value = recorded;
    this.deps.rememberProfile(recorded);
    const model = answer.model ? ` (${answer.model})` : "";
    return `Continuing "${this.labelOf(name)}" on ${recorded}${model}, as before.`;
  }

  /**
   * One message from a session note: its text, and an answer's tool calls when the note kept them (#282), folded
   * as they were while it ran. Thinking is never in the note.
   */
  private async replay(role: string, content: string, calls?: SavedCall[]): Promise<void> {
    if (role === "user") {
      await this.say("user", content, true);
      return;
    }
    const turn = this.messages.createDiv({ cls: "obsidian-agent-message mod-agent" });
    // From an earlier run: what it changed is not in this run's journal, so going back cannot take it back (#303)
    turn.dataset.replayed = "true";
    if (calls?.length) {
      const tools = turn.createDiv({ cls: "obsidian-agent-tools" });
      for (const call of calls) {
        let input: Record<string, unknown> = {};
        try {
          input = JSON.parse(call.args) as Record<string, unknown>;
        } catch {
          // Cut short in the note: the row goes without its argument
        }
        const row = this.addToolRow(tools, { callId: "", name: call.name, input });
        this.completeToolRow(row, call.result, call.error);
      }
    }
    await this.renderMarkdown(content, turn.createDiv({ cls: "obsidian-agent-body" }));
  }

  private setSession(name: string): void {
    this.sessionName = name;
    this.deps.rememberSession(name);
    if (!this.sessionPicker) return;
    // A conversation is named before its note exists, so the entry has to be added now. Setting `value` to an
    // option the list does not have selects nothing, and the picker sits blank on the conversation you are in.
    const known = Array.from(this.sessionPicker.options).some((option) => option.value === name);
    if (name && !known) this.sessionPicker.createEl("option", { text: this.labelOf(name), value: name });
    this.showInPicker();
  }

  /**
   * Select the open conversation in the picker. One that is not kept but has messages gets an entry of its own,
   * so that choosing "New conversation" is a change the picker reports (there is no + button, #286).
   */
  private showInPicker(): void {
    const unkept = !this.sessionName && Boolean(this.firstPrompt);
    let entry = Array.from(this.sessionPicker.options).find((option) => option.value === UNKEPT) ?? null;
    if (unkept && !entry) {
      entry = createEl("option", { text: "This conversation (not kept)", value: UNKEPT });
      this.sessionPicker.options[0]?.after(entry);
    } else if (!unkept && entry) {
      entry.remove();
    }
    this.sessionPicker.value = this.sessionName || (unkept ? UNKEPT : "");
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
    const typed = this.input.value.trim();
    if ((!typed && !this.pending.length) || this.turnId) return;
    if (!this.deps.setup.ready()) {
      this.showSetup();
      return;
    }
    // The added files go into the vault now, where the agent reads them (#190); one that cannot be saved stops the send
    const saved = await this.saveAttachments();
    if (!saved) return;
    const prompt = attachmentPrompt(typed, saved);
    this.input.value = "";
    // The first turn names the conversation, and naming it is what writes it to a vault note: the box decides
    // whether this conversation exists outside the view — without a name it is kept in memory and nothing is written.
    if (!this.firstPrompt) this.firstPrompt = prompt;
    const isNewSession = this.keepBox.checked && !this.sessionName;
    if (isNewSession) this.setSession(sessionNameFor(typed || this.firstFileName(saved)));
    else this.showInPicker();
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
    // One render at a time, of the newest text, at most once a frame: rendering the whole answer again on every
    // token, with renders overlapping, was quadratic and could show stale or doubled text (#172)
    // While it arrives, a diagram shows as code: drawn from half its code on every frame, it jittered (#189)
    const answer = coalesce((draw: { text: string; done: boolean }) =>
      this.swapInMarkdown(draw.done ? draw.text : asStreaming(draw.text), body), nextFrame);
    let thought = "";

    const rows = new Map<string, HTMLElement>();
    const runner = this.deps.agent();
    this.deps.used(this);
    this.turnId = runner.send(prompt, { agent: this.agentPicker.value, session: this.sessionName || undefined,
                                        view: this.viewId,
                                        profile: this.profilePicker.value || undefined,
                                        context: request ? request.context : this.activeNoteContext() }, {
      onToken: (text) => {
        if (!this.streaming) return;
        this.streaming.text += text;
        answer.push({ text: this.streaming.text, done: false });
        this.scrollDown();
      },
      onThinking: (text) => {
        thinking.show();
        thought += text;
        thinkingBody.setText(thought);
      },
      onToolCall: (call) => rows.set(call.callId, this.addToolRow(tools, call)),
      onToolResult: (callId, result, isError) => this.completeToolRow(rows.get(callId), result, isError),
      onConfirmRequest: (callId, name, input) => {
        new ConfirmModal(this.app, { name, input }, (approved) => {
          if (this.turnId) runner.confirm(this.turnId, callId, approved);
        }).open();
      },
      onContext: (tokens, window, estimated, peak, answering) =>
        this.showContext({ tokens, window, estimated, peak, answering }),
      onSetAside: (total) => {
        // Said once per answer, and kept current: the agent no longer sees what it read first
        let note = turn.querySelector<HTMLElement>(".obsidian-agent-set-aside");
        if (!note) note = tools.createDiv({ cls: "obsidian-agent-note obsidian-agent-set-aside" });
        note.setText(`${total} earlier tool result${total === 1 ? " was" : "s were"} set aside to stay inside the `
                     + "model's context window; the agent reads again what it still needs.");
      },
      onSummary: (exchanges, summary, when) => void this.addSummaryDivider(exchanges, summary, { turn, when }),
      onDone: (reply, cancelled, usage, changed) => {
        if (reply && this.streaming) answer.push({ text: reply, done: true });
        if (cancelled) turn.createDiv({ cls: "obsidian-agent-note", text: "Cancelled." });
        // A cancelled turn still gets its footer when it wrote something: stopping it is often why you want it back.
        if (!cancelled || changed) this.addFooter(turn, body, usage, changed);
        this.finishTurn();
        // The note was just written: the picker lists conversations by their last change, newest first, so this
        // one moves to the top, here and in the other chats (2026-10-05)
        if (this.sessionName) {
          void this.refreshSessions();
          this.deps.sessionsChanged(this);
        }
      },
      onError: (message) => {
        turn.createDiv({ cls: "obsidian-agent-error", text: message });
        this.finishTurn();
      },
    });
  }

  /** The chat's own meter only where there is no status bar: in a window other than the main one. */
  private placeMeter(): void {
    this.meter.toggleClass("is-under-status-bar", this.containerEl.ownerDocument === document);
  }

  /**
   * The context meter, in the status bar and in a chat of its own window: tokens in use of the window, hidden
   * before the first request (#151), and following each request while an answer runs.
   */
  private showContext(usage: ContextUsage | null): void {
    this.usage = usage;
    renderContextStatus(this.meter, usage);
    this.placeMeter();
    // The status bar has one meter: it shows the chat used last, not whichever answered last (#153)
    if (this.deps.current(this)) this.deps.context(usage);
  }

  /**
   * A divider where the conversation was summarised (#154): above it, the agent remembers the exchanges only as the
   * summary, which unfolds on demand. Placed before or after *at*'s answer, or at the end of a reopened conversation's
   * start.
   */
  private async addSummaryDivider(exchanges: number, summary: string,
                                  at?: { turn: HTMLElement; when: "before" | "after" }): Promise<void> {
    const divider = createEl("details", { cls: "obsidian-agent-summary-divider" });
    const count = exchanges ? `${exchanges} earlier exchange${exchanges === 1 ? "" : "s"}` : "Earlier exchanges";
    const line = divider.createEl("summary");
    line.createSpan({ cls: "obsidian-agent-summary-label", text: `${count} summarised here` });
    line.setAttr("aria-label", "The agent remembers what is above as a summary, to stay inside the model's context "
                               + "window. Click to read the summary.");
    const body = divider.createDiv({ cls: "obsidian-agent-summary-body" });
    await this.renderMarkdown(summary, body);
    if (!at) this.messages.appendChild(divider);
    else if (at.when === "before") at.turn.before(divider);
    else at.turn.after(divider);
    this.scrollDown();
  }

  private addToolRow(container: HTMLElement, call: ToolCall): HTMLElement {
    const row = container.createEl("details", { cls: "obsidian-agent-tool" });
    const summary = row.createEl("summary");
    summary.createSpan({ cls: "obsidian-agent-tool-name", text: displayName(call.name) });
    // Every argument on the line, the main one first; the full set when the row is unfolded (2026-10-05)
    const line = callLine(call.input);
    const argument = summary.createSpan({ cls: "obsidian-agent-tool-arg", text: line });
    if (line) argument.setAttr("title", line);
    summary.createSpan({ cls: "obsidian-agent-tool-state", text: "…" });
    const all = callArguments(call.input);
    if (all) row.createEl("pre", { cls: "obsidian-agent-tool-args", text: all });
    row.createEl("pre", { cls: "obsidian-agent-tool-result" });
    return row;
  }

  private completeToolRow(row: HTMLElement | undefined, result: string, isError: boolean): void {
    if (!row) return;
    const state = row.querySelector(".obsidian-agent-tool-state");
    if (state) state.textContent = isError ? "failed" : "done";
    row.toggleClass("mod-error", isError);
    const pre = row.querySelector(".obsidian-agent-tool-result");
    if (pre) pre.textContent = result.length > 2000 ? `${result.slice(0, 2000)}…` : result;
    if (isError) row.setAttr("open", "true");
  }

  private addFooter(turn: HTMLElement, body: HTMLElement, usage: Record<string, unknown>,
                    changed: TurnChanges | null = null): void {
    const footer = turn.createDiv({ cls: "obsidian-agent-footer" });
    // Going back to an earlier message takes this answer's changes back too (#303)
    if (changed) turn.dataset.turn = changed.turn;
    const seconds = usage.seconds ? `${usage.seconds}s` : "";
    const calls = usage.tool_calls ? `${usage.tool_calls} tool call${usage.tool_calls === 1 ? "" : "s"}` : "";
    footer.createSpan({ text: [seconds, calls].filter(Boolean).join(" · ") });

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

  /**
   * Go back to before *message* (#303): the answers since then are taken back — what they changed in the vault, newest
   * first — and the messages from there on removed from the conversation, the message itself put back in the input.
   * Not past a summary: the exchanges above it are only in the summary now.
   */
  private rewindTo(message: HTMLElement, text: string): void {
    if (this.turnId) {
      new Notice("Wait until the answer is done, then go back.");
      return;
    }
    const after: HTMLElement[] = [];
    for (let element: Element | null = message; element; element = element.nextElementSibling) {
      after.push(element as HTMLElement);
    }
    if (after.some((element) => element.hasClass("obsidian-agent-summary-divider"))) {
      new Notice("The conversation was summarised after this message, so it cannot go back that far: pick a message "
                 + "below the summary.", 8_000);
      return;
    }
    const exchanges = after.filter((element) => element.hasClass("mod-user")).length;
    const answers = after.filter((element) => element.hasClass("mod-agent"));
    const turns = answers.map((element) => element.dataset.turn).filter((turn): turn is string => Boolean(turn)).reverse();
    const unknown = answers.filter((element) => element.dataset.replayed === "true").length;
    const agent = this.deps.agent();
    new RewindModal(this.app, agent, { exchanges, turns, unknown }, async () => {
      const result = await agent.rewind({ session: this.sessionName || undefined, view: this.viewId }, exchanges, turns);
      for (const element of after) element.remove();
      // Nothing said any more: the conversation is named by the next first message, as a new one is
      if (!this.messages.querySelector(".mod-user")) this.firstPrompt = "";
      this.input.value = text;
      this.input.focus();
      this.showInPicker();
      if (this.sessionName) {
        void this.refreshSessions();
        this.deps.sessionsChanged(this);
      }
      return result;
    }).open();
  }

  /** Offered only on turns that wrote something, and only while the journal still holds them. */
  private addUndoButton(footer: HTMLElement, changed: TurnChanges, files: HTMLElement): void {
    const undo = footer.createEl("button", { cls: "clickable-icon", attr: { "aria-label": "Undo what this answer changed" } });
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

  /** Add *files* to the next message, refusing what the agent cannot read or what is too large (#190). */
  private addFiles(files: File[]): void {
    for (const file of files) {
      const verdict = checkAttachment(file.name, file.size);
      if ("error" in verdict) {
        new Notice(verdict.error, 8_000);
        continue;
      }
      if (!this.pending.some((other) => other.name === file.name && other.size === file.size)) this.pending.push(file);
    }
    this.showAttachments();
  }

  /** The files waiting for the next message, each with a way to take it out again. */
  private showAttachments(): void {
    this.chips.empty();
    this.chips.toggleClass("is-hidden", !this.pending.length);
    for (const file of this.pending) {
      const chip = this.chips.createDiv({ cls: "obsidian-agent-attachment" });
      chip.createSpan({ text: `${file.name} · ${formatSize(file.size)}` });
      const remove = chip.createEl("button", { cls: "clickable-icon", attr: { "aria-label": `Remove ${file.name}` } });
      setIcon(remove, "x");
      remove.onclick = () => {
        this.pending = this.pending.filter((other) => other !== file);
        this.showAttachments();
      };
    }
    // An agent without read_attachment would be told about files it cannot open
    const agent = this.catalog()?.agents.find((one) => one.name === this.agentPicker.value);
    if (this.pending.length && agent?.tools && !agent.tools.includes("read_attachment")) {
      this.chips.createDiv({ cls: "obsidian-agent-note mod-warning",
                             text: `${agent.name} cannot read attachments: it has no read_attachment tool.` });
    }
  }

  /** Save the waiting files to the vault's attachment location; their paths, or null when one failed. */
  private async saveAttachments(): Promise<string[] | null> {
    const paths: string[] = [];
    for (const file of this.pending) {
      try {
        let path = await this.app.fileManager.getAvailablePathForAttachment(file.name);
        // Never into a dot folder (a conversation note's, say): the agent's tools do not read there
        if (path.split("/").slice(0, -1).some((part) => part.startsWith("."))) {
          path = await this.app.fileManager.getAvailablePathForAttachment(file.name, "");
          if (path.split("/").slice(0, -1).some((part) => part.startsWith("."))) path = file.name;
        }
        const created = await this.app.vault.createBinary(path, await file.arrayBuffer());
        paths.push(created.path);
      } catch (error) {
        new Notice(`${file.name} could not be saved to the vault: ${messageOf(error)}`, 10_000);
        return null;
      }
    }
    this.pending = [];
    this.showAttachments();
    return paths;
  }

  /** A name for a conversation that began with files and no words. */
  private firstFileName(paths: string[]): string {
    const name = paths[0]?.split("/").pop() ?? "";
    return name.replace(/\.[^.]+$/, "");
  }

  private setRunning(running: boolean): void {
    this.sendButton.setText(running ? "Stop" : "Send");
    this.sendButton.toggleClass("mod-warning", running);
    this.sendButton.onclick = running ? () => this.cancel() : () => void this.submit();
  }

  private async say(role: "user" | "system", text: string, markdown: boolean): Promise<void> {
    const element = this.messages.createDiv({ cls: `obsidian-agent-message mod-${role}` });
    if (role === "user") {
      // A break point (#303): back to before this message, with what the answers since changed taken back
      const back = element.createEl("button", { cls: "clickable-icon obsidian-agent-rewind",
                                                attr: { "aria-label": "Go back to before this message" } });
      setIcon(back, "history");
      back.onclick = () => this.rewindTo(element, text);
    }
    if (markdown) await this.renderMarkdown(text, element.createDiv({ cls: "obsidian-agent-body" }));
    else element.createDiv({ cls: "obsidian-agent-body", text });
    this.scrollDown();
  }

  /** Render *text* off the page and put it in *target* in one step, so an answer never flashes empty (#172). */
  private async swapInMarkdown(text: string, target: HTMLElement): Promise<void> {
    const fresh = createDiv();
    await this.renderMarkdown(text, fresh);
    target.replaceChildren(...Array.from(fresh.childNodes));
    this.drawnFrom.set(target, text);
    this.scrollDown();
  }

  /**
   * Obsidian asks before it draws some things in a vault — "Display Mermaid diagrams in this vault?" — and after
   * *Allow* redraws its own notes, not this view (#189). So a click on such a button here redraws every message that
   * still shows one, once Obsidian has stored the answer.
   */
  private watchPermissionPrompts(target: HTMLElement): void {
    for (const button of Array.from(target.querySelectorAll("button"))) {
      if (button.getText().trim() !== "Allow") continue;
      button.addEventListener("click", () => window.setTimeout(() => void this.redrawPrompted(), 300));
    }
  }

  private async redrawPrompted(): Promise<void> {
    for (const body of Array.from(this.messages.querySelectorAll<HTMLElement>(".obsidian-agent-body"))) {
      const text = this.drawnFrom.get(body);
      const prompted = Array.from(body.querySelectorAll("button")).some((button) => button.getText().trim() === "Allow");
      if (text !== undefined && prompted) await this.renderMarkdown(text, body);
    }
  }

  /** Obsidian's renderer, so links and embeds behave — and so model output is never parsed as HTML by us. */
  private async renderMarkdown(text: string, target: HTMLElement): Promise<void> {
    target.empty();
    // Nothing in an answer fetches from the network by itself: images from the web become links (#137)
    await MarkdownRenderer.render(this.app, withoutRemoteMedia(text), target, this.activeNotePath(), this);
    this.drawnFrom.set(target, text);
    this.watchPermissionPrompts(target);
    // A second net, for whatever the renderer made of the rest: media pointing off the machine is removed
    for (const media of Array.from(target.querySelectorAll("img, video, audio, source, iframe, object, embed"))) {
      const url = media.getAttribute("src") ?? media.getAttribute("data") ?? "";
      if (isRemote(url)) media.replaceWith(createSpan({ text: "(remote media not loaded)", cls: "obsidian-agent-note" }));
    }
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

  /**
   * The chat has the focus: keep the note's selection visible there, and say above the input what a typed message
   * takes along (#218). The editor's CodeMirror view is `editor.cm`, not in the published API: without it the line
   * still says what goes along.
   */
  private keepNoteSelection(): void {
    const editor = this.noteEditor();
    const view = (editor as unknown as { cm?: EditorView } | undefined)?.cm;
    if (view && editor?.somethingSelected()) showKeptSelection(view);
    this.showContextLine();
  }

  private showContextLine(): void {
    if (!this.contextLine) return;
    const context = this.activeNoteContext();
    const note = context?.active_note ? context.active_note.split("/").pop()!.replace(/\.md$/, "") : "";
    const selection = (context?.selection ?? "").replace(/\s+/g, " ").trim();
    const text = selection ? `Selection in "${note}": "${selection.length > 60 ? `${selection.slice(0, 60)}…` : selection}"`
      : note ? `Note: "${note}"` : "";
    this.contextLine.setText(text);
    this.contextLine.toggleClass("is-hidden", !text);
  }

  private scrollDown(): void {
    this.messages.scrollTop = this.messages.scrollHeight;
  }
}

/** The next animation frame: renders of a streamed answer wait for it, so the view repaints between them. */
function nextFrame(): Promise<void> {
  return new Promise((resolve) => window.requestAnimationFrame(() => resolve()));
}
