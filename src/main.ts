/**
 * The plugin itself: the agent runs inside it (#88) — its settings and agents (#86), conversations (#85), tools on
 * Obsidian's own API (#80–#84) and MCP servers (#87) — with the chat view (WP6), the commands (WP7, in
 * `commands/`) and the settings tab (WP8) around it.
 */

import { FileSystemAdapter, Keymap, Notice, Platform, Plugin, TFile, WorkspaceLeaf, requestUrl } from "obsidian";

import { AgentCommands } from "./commands/AgentCommands";
import type { NoteContext } from "./commands/context";
import { messageOf } from "./core/errors";
import { AgentSettingTab, DEFAULT_SETTINGS, OBSOLETE_SETTINGS, type PluginSettings } from "./settings";
import { renderContextStatus } from "./view/contextStatus";
import { CHAT_VIEW_TYPE, ChatView } from "./view/ChatView";
import { keptSelection } from "./view/keptSelection";
import { registerBasesQuery } from "./vault/basesQuery";
import { ConfirmModal } from "./view/ConfirmModal";
import { sessionNameFor } from "./view/sessionName";
import { InProcessAgent, type PromptAsSent, type PromptDraft } from "./inprocess/InProcessAgent";
import { AgentCatalog } from "./config/agents";
import { PluginBackend } from "./config/backend";
import { defaultProfileName, hasConnection, migrateBareLlm, profileSummaries, resolveConnection } from "./config/connections";
import { addLocalServer, findLocalServers, type Profiles } from "./settings/connections";
import { probe } from "./settings/probe";
import { registerCli } from "./cli/register";
import type { AgentStatus } from "./cli/status";
import { ConfigStore, withoutObsolete } from "./config/store";
import { KEYCHAIN_NAME, migrateDeviceApprovals, migrateMcpApprovals, migrateReferences,
         renameConnectionApproval, renames }
  from "./config/keychainRefs";
import { changedApprovals, connectionApproval, DEVICE_APPROVALS_KEY, DeviceApprovals, programsApproval,
  requiredApprovals } from "./config/deviceApprovals";
import { APPROVALS_KEY, McpApprovals } from "./mcp/approvals";
import { mcpServers, needsApproval } from "./mcp/servers";
import { switchedOffTools } from "./config/features";
import { McpManager, type McpTool } from "./mcp/manager";
import { nodeFetch } from "./mcp/nodeFetch";
import { McpService } from "./mcp/service";
import { listSessions } from "./core/sessions";
import { obsidianVault, setRecorder } from "./vault/obsidianVault";
import { nodePrograms } from "./vault/programs";
import { registerToolCli } from "./vault/toolCli";
import { toolsetOptions, type ToolsetOptions } from "./vault/toolset";

const LOG_LINES = 200;

/** This device's Developer switch, in Obsidian's local storage for this vault (#136). */
const DEVELOPER_KEY = "agent-developer";

/** Where the MCP servers' last listed tools are kept on this device (#178). */
const MCP_TOOLS_KEY = "agent-mcp-tools";

export default class ObsidianAgentPlugin extends Plugin {
  override settings: PluginSettings = { ...DEFAULT_SETTINGS };  // Plugin declares `settings?: unknown`
  private readonly log: string[] = [];
  private commands: AgentCommands | null = null;
  // The agent's configuration and agents, kept by the plugin (#86), and the agent that answers in the plugin
  private readonly store = new ConfigStore(() => this.settings.agentConfig, async (values) => {
    // A change made here approves what it changed on this device (#136); one that arrives by sync does not pass
    // through here, so it waits for Approve in the settings
    const changed = changedApprovals(this.settings.agentConfig, values);
    this.settings.agentConfig = values;
    await this.saveSettings();
    if (changed.length) this.deviceApprovals.approve(...changed);
  }, () => this.vaultPath() ?? "");
  // MCP servers (#87): kept connected while Obsidian runs; a stdio one starts only once approved on this device,
  // and the approvals live in this device's local storage, not in data.json, which syncs
  private readonly mcpApprovals = new McpApprovals(() => this.app.loadLocalStorage(APPROVALS_KEY),
                                                   (value) => this.app.saveLocalStorage(APPROVALS_KEY, value));
  // Where a connection's key goes, and the audio programs: likewise approved on this device, not in data.json (#136)
  private readonly deviceApprovals = new DeviceApprovals(() => this.app.loadLocalStorage(DEVICE_APPROVALS_KEY),
                                                         (value) => this.app.saveLocalStorage(DEVICE_APPROVALS_KEY, value));
  private readonly mcpManager = new McpManager({
    vaultPath: () => this.vaultPath() ?? "",
    keychain: (name) => this.secretValue(name),
    approved: (spec) => this.mcpApprovals.approved(spec),
    log: (line) => this.addLog(line),
    fetch: nodeFetch,
    version: this.manifest.version,
    // Kept per device, beside the approvals, not in data.json: a server's tools are this device's view of it (#178)
    rememberedTools: () => (this.app.loadLocalStorage(MCP_TOOLS_KEY) ?? {}) as Record<string, McpTool[]>,
    rememberTools: (server, tools) => {
      const all = (this.app.loadLocalStorage(MCP_TOOLS_KEY) ?? {}) as Record<string, McpTool[]>;
      this.app.saveLocalStorage(MCP_TOOLS_KEY, { ...all, [server]: tools });
    },
  });
  private readonly mcpService = new McpService(() => this.store.values(), this.mcpManager, this.mcpApprovals);
  // Not recorded: an agent saved in the settings is not one of a turn's changes (#177)
  private readonly catalog = new AgentCatalog(obsidianVault(this.app, { record: false }), () => {
    const values = this.store.values();
    const vault = (values.vault ?? {}) as Record<string, unknown>;
    return { defaultAgent: typeof vault.default_agent === "string" ? vault.default_agent : "assistant",
             profiles: profileSummaries(values).map((p) => p.name), configDir: this.app.vault.configDir };
  }, () => this.mcpService.toolInfos(), () => switchedOffTools(this.store.values()), () => this.mcpService.names());
  private readonly pluginBackend = new PluginBackend(this.store, this.catalog, nodePrograms, this.manifest.version,
                                                     this.app.vault.getName());
  private readonly inProcess = new InProcessAgent(this.app, {
    catalog: this.catalog, backend: this.pluginBackend, values: () => this.store.values(),
    env: (name) => this.secretValue(name),
    fetchJson: async (url) => (await requestUrl({ url, throw: true })).json as unknown,
    mcp: this.mcpManager,
    deviceApprovals: this.deviceApprovals,
    log: (line) => this.addLog(line),
  }, () => this.toolsetOptions());

  /** The MCP servers, for the settings (#87). */
  mcp(): McpService {
    return this.mcpService;
  }

  private addLog(line: string): void {
    this.log.push(line);
    if (this.log.length > LOG_LINES) this.log.shift();
  }

  /** What the in-plugin agent's tools are set to: its settings, and whether this device approved the programs. */
  private async toolsetOptions(): Promise<ToolsetOptions> {
    const values = this.store.values();
    const options = toolsetOptions({ values });
    const programs = programsApproval(values);
    return { ...options, audio: { ...options.audio, approved: !programs || this.deviceApprovals.approved(programs) } };
  }

  /**
   * Developer (#81): `agent:tool`, and `agent:ask allow=destructive` without the dialog. Kept in this device's
   * local storage, not in data.json: a switch that turns off confirmations must not arrive by sync (#136).
   */
  developer(): boolean {
    return this.app.loadLocalStorage(DEVELOPER_KEY) === true;
  }

  setDeveloper(on: boolean): void {
    this.app.saveLocalStorage(DEVELOPER_KEY, on ? true : null);
  }

  /** What a connection's key or the audio programs need approved here, and whether they are; null when nothing. */
  approvalStatus(kind: "connection" | "programs", name = ""): { what: string; approved: boolean } | null {
    const values = this.store.values();
    const approval = kind === "connection" ? connectionApproval(values, name) : programsApproval(values);
    return approval && { what: approval.what, approved: this.deviceApprovals.approved(approval) };
  }

  /** Approve on this device what the settings ask for now — the settings tab's Approve button. */
  approveOnThisDevice(kind: "connection" | "programs", name = ""): void {
    const values = this.store.values();
    const approval = kind === "connection" ? connectionApproval(values, name) : programsApproval(values);
    if (approval) this.deviceApprovals.approve(approval);
  }

  /**
   * The first start of a version that asks for approvals, on this device: what is configured already ran without
   * asking before, so it is approved as it stands; from now on only changes made here approve themselves (#136).
   */
  private approveWhatIsThere(): void {
    const values = this.store.values();
    this.deviceApprovals.approve(...requiredApprovals(values));
    for (const spec of mcpServers(values)) {
      if (spec.transport !== "stdio" && needsApproval(spec) && !this.mcpApprovals.approved(spec)) this.mcpApprovals.approve(spec);
    }
  }

  /**
   * A `${name}` reference in the settings: the entry of that name in Obsidian's keychain (Settings → Keychain), and
   * nothing else — no environment variable, no key written into the settings (#147).
   */
  private secretValue(name: string): string | undefined {
    if (!KEYCHAIN_NAME.test(name)) return undefined;
    return this.app.secretStorage.getSecret(name) || undefined;
  }

  /** A keychain entry's value, for a connection's Test in the settings on this device (#149). */
  keychainValue(name: string): string | undefined {
    return this.secretValue(name);
  }

  /** The keychain's entry names on this device, for the settings; none when the keychain does not answer. */
  keychainNames(): string[] {
    try {
      return [...this.app.secretStorage.listSecrets()].sort();
    } catch {
      return [];
    }
  }

  /**
   * Once: the old Secrets tab's names (`${OPENAI_API_KEY}`) become the keychain entries they stood for
   * (`${openai-api-key}`) everywhere in the settings, and this device's approvals follow the rename (#147). Another
   * device receives the renamed settings by sync and approves them there.
   */
  private migrateSecretBindings(bindings: unknown): boolean {
    const renamed = renames(bindings);
    if (!Object.keys(renamed).length) return false;
    this.settings.agentConfig = migrateReferences(this.settings.agentConfig, renamed) as Record<string, unknown>;
    const device = migrateDeviceApprovals(this.app.loadLocalStorage(DEVICE_APPROVALS_KEY), renamed);
    if (device) this.app.saveLocalStorage(DEVICE_APPROVALS_KEY, device);
    const mcp = migrateMcpApprovals(this.app.loadLocalStorage(APPROVALS_KEY), renamed);
    if (mcp) this.app.saveLocalStorage(APPROVALS_KEY, mcp);
    this.addLog(`Keys now named as in the keychain: ${Object.entries(renamed).map(([from, to]) => `${from} → ${to}`).join(", ")}`);
    return true;
  }

  /** Once: a connection without a name becomes a named one, with this device's approval (#149). */
  private nameBareConnection(): boolean {
    const moved = migrateBareLlm(this.settings.agentConfig);
    if (!moved) return false;
    this.settings.agentConfig = moved.values;
    const device = renameConnectionApproval(this.app.loadLocalStorage(DEVICE_APPROVALS_KEY), moved.name);
    if (device) this.app.saveLocalStorage(DEVICE_APPROVALS_KEY, device);
    this.addLog(`The connection without a name is now '${moved.name}'.`);
    return true;
  }

  private contextItem: HTMLElement | null = null;

  /** The status bar item for the context meter, made on first use (#151). */
  private contextStatus(): HTMLElement {
    if (!this.contextItem) {
      this.contextItem = this.addStatusBarItem();
      this.contextItem.addClass("obsidian-agent-context", "is-hidden");
    }
    return this.contextItem;
  }

  /** The agent's settings and agents, as the settings tabs and the chat header ask for them (#86). */
  backend(): PluginBackend {
    return this.pluginBackend;
  }

  override async onload(): Promise<void> {
    await this.loadSettings();
    if (!this.deviceApprovals.initialized()) this.approveWhatIsThere();
    this.settingTab = new AgentSettingTab(this.app, this);
    this.addSettingTab(this.settingTab);
    // Checked first, with Obsidian's own flag: the command line and everything below need the desktop app (#183).
    // A vault without a folder on disk is refused too, as before: the tools and programs read files by path
    if (!Platform.isDesktopApp || !this.vaultPath()) {
      new Notice("Hiro Agent runs on desktop only for now.");
      return;
    }
    if (this.developer()) {
      registerToolCli(this, this.app, () => this.toolsetOptions());
    }
    registerCli(this, {
      status: () => this.cliStatus(),
      agents: async () => (await this.pluginBackend.refresh()).agents,
      sessions: () => listSessions(obsidianVault(this.app, { record: false })),
      ask: {
        info: () => this.pluginBackend.refresh(),
        send: (prompt, options, handlers) => this.inProcess.send(prompt, options, handlers),
        cancel: (turn) => this.inProcess.cancel(turn),
        confirm: (turn, callId, approved) => this.inProcess.confirm(turn, callId, approved),
        noteExists: async (path) => this.app.vault.getAbstractFileByPath(path) instanceof TFile,
        askInObsidian: (name, input) => new Promise((resolve) => new ConfirmModal(this.app, { name, input }, resolve).open()),
        developer: () => this.developer(),
        notice: (text) => new Notice(text, 10_000),
        sessionName: (prompt) => sessionNameFor(prompt),
      },
      undo: {
        turns: () => this.inProcess.turns(),
        turnDiff: (id) => this.inProcess.turnDiff(id),
        undoTurn: (id) => this.inProcess.undoTurn(id),
      },
    });

    // The note's selection stays visible while the cursor is in the chat (#218)
    this.registerEditorExtension(keptSelection);
    // query_base reads a Base's rows through a view type of the plugin's own (#230)
    registerBasesQuery(this);
    this.registerView(CHAT_VIEW_TYPE, (leaf: WorkspaceLeaf) => new ChatView(leaf, {
      agent: () => this.inProcess,
      defaultAgent: () => this.defaultAgent(),
      lastSession: () => this.settings.lastSession,
      keepByDefault: () => this.settings.keepConversations,
      lastProfile: () => this.settings.lastProfile,
      context: (usage) => renderContextStatus(this.contextStatus(), usage),
      rememberProfile: (name: string) => {
        if (this.settings.lastProfile === name) return;
        this.settings.lastProfile = name;
        void this.saveSettings();
      },
      setup: {
        ready: () => hasConnection(this.store.values()),
        findLocal: () => findLocalServers((this.store.values().llm_profiles ?? {}) as Profiles, probe),
        addLocal: async (server) => {
          const values = this.store.values();
          const result = await this.store.putConfig(addLocalServer(server, defaultProfileName(values)));
          if (!result.ok) return result.fields.map((f) => `${f.path}: ${f.message}`).join("; ") || result.error || "refused";
          await this.configChanged();
          return null;
        },
        openSettings: () => this.openSettings(),
      },
      rememberKeep: (keep: boolean) => {
        if (this.settings.keepConversations === keep) return;
        this.settings.keepConversations = keep;
        void this.saveSettings();
      },
      rememberSession: (name: string) => {
        if (this.settings.lastSession === name) return;
        this.settings.lastSession = name;
        void this.saveSettings();
      },
      used: (view) => {
        if (this.lastChat === view) return;
        this.lastChat = view;
        renderContextStatus(this.contextStatus(), view.contextUsage());
      },
      current: (view) => this.lastChat === view || !this.lastChat,
      openElsewhere: (name, view, reveal) => {
        const other = this.chatViews().find((chat) => chat !== view && chat.session() === name);
        if (other && reveal) void this.app.workspace.revealLeaf(other.leaf);
        return Boolean(other);
      },
      // The other chats list the conversations again after an answer or a rename (#286)
      sessionsChanged: (view) => {
        for (const chat of this.chatViews()) if (chat !== view) void chat.followRename();
      },
      loaded: () => this.loaded,
      newWindow: (name) => this.newChatWindow(name),
    }));
    // Ctrl/Cmd-click opens another chat window, as it opens a note in a new tab (#301)
    this.addRibbonIcon("bot", "Hiro Agent", (event) => {
      void (Keymap.isModEvent(event) ? this.newChatWindow() : this.openChat());
    });

    // Obsidian shows each of these as "Hiro Agent: <name>" — the prefix is this plugin's name in manifest.json
    this.addCommand({
      id: "open-chat",
      name: "Open the chat",
      callback: () => void this.openChat(),
    });
    // Another chat beside the first, with a conversation of its own (#153)
    this.addCommand({
      id: "new-chat-window",
      name: "New chat window",
      callback: () => void this.newChatWindow(),
    });

    // The conversation of the chat used last (#286)
    this.addCommand({
      id: "rename-conversation",
      name: "Rename conversation",
      callback: async () => {
        await this.openChat();
        this.currentChat()?.renameConversation();
      },
    });
    this.commands = new AgentCommands(this, {
      agents: () => this.pluginBackend.info().agents,
      defaultAgent: () => this.defaultAgent(),
      run: (agent, message, context) => this.runRequest(agent, message, context),
    });
    this.commands.registerFixed();
    // The id is the one it had while the log was the runtime's, so a hotkey set for it still works
    this.addCommand({
      id: "show-log",
      name: "Show the agent's log",
      callback: () => new Notice(this.log.slice(-20).join("\n") || "Nothing logged yet.", 10_000),
    });
    // The agents are read from the vault once Obsidian has laid it out, not while it waits for this plugin to
    // load (#92); the chat's pickers and the one-command-per-agent list follow when they are there
    // Only the chats Obsidian has opened: a tab not shown yet holds a placeholder view, and calling into it threw and
    // ended the refresh before any chat listed its connections (2026-10-06)
    this.app.workspace.onLayoutReady(() => void this.agentsChanged().then(() => {
      for (const chat of this.chatViews()) chat.refreshProfiles();
    }).finally(() => this.markLoaded()));
  }

  override onunload(): void {
    // The journal's recorder is module state in obsidianVault: a reloaded plugin starts without one (#177)
    setRecorder(null);
    // Obsidian does not wait for onunload: the MCP servers close in the background
    void this.mcpManager.closeAll().catch(() => undefined);
  }

  /** `obsidian agent:status`: the default agent and connection, the agents, the MCP servers (#71). */
  private cliStatus(): AgentStatus {
    const values = this.store.values();
    const info = this.pluginBackend.info();
    const connection = info.profiles.length || values.llm
      ? resolveConnection(values, "", () => undefined) : null;
    return {
      version: this.manifest.version, vault: this.app.vault.getName(), defaultAgent: this.defaultAgent(),
      agents: info.agents.length,
      connection: connection && { name: connection.name, provider: connection.provider, model: connection.model,
                                   url: connection.baseUrl },
      mcp: this.mcpService.status().map((server) => ({ name: server.spec.name, transport: server.spec.transport,
                                                       enabled: server.spec.enabled, approved: server.approved })),
    };
  }

  /** The agent used when none is chosen — the settings' "Default agent". */
  private defaultAgent(): string {
    return this.pluginBackend.info().agents.find((agent) => agent.default)?.name ?? "assistant";
  }

  /** The chat used last — focused or sent from — while it is open (#153). */
  private lastChat: ChatView | null = null;
  /** The settings, described anew after a config write wherever it came from (#321). */
  private settingTab: AgentSettingTab | null = null;
  private markLoaded: () => void = () => undefined;
  /**
   * Settled once the agents and connections are first read, after Obsidian has laid out the vault (#92). A chat
   * restored before that waits for it, or it lists no connection and calls its conversation's one "no longer
   * configured" (2026-10-06).
   */
  private readonly loaded = new Promise<void>((resolve) => { this.markLoaded = resolve; });

  /** The open chat views, in the workspace's order. */
  private chatViews(): ChatView[] {
    return this.app.workspace.getLeavesOfType(CHAT_VIEW_TYPE).map((leaf) => leaf.view)
      .filter((view): view is ChatView => view instanceof ChatView);
  }

  /** The chat used last if it is still open, else the first; null when none is open. */
  private currentChat(): ChatView | null {
    const views = this.chatViews();
    return this.lastChat && views.includes(this.lastChat) ? this.lastChat : views[0] ?? null;
  }

  /** A command's request: run in the chat used last, in a new conversation, opening a chat when there is none. */
  private async runRequest(agent: string, message: string, context: NoteContext | undefined): Promise<void> {
    await this.openChat();
    const view = this.currentChat();
    if (view) await view.runRequest(agent, message, context);
  }

  /** Reveal the chat used last in the right sidebar, creating one the first time. */
  async openChat(): Promise<void> {
    const current = this.currentChat();
    const leaf = current?.leaf ?? this.app.workspace.getRightLeaf(false);
    if (!leaf) return;
    if (!current) await leaf.setViewState({ type: CHAT_VIEW_TYPE, active: true });
    await this.app.workspace.revealLeaf(leaf);
  }

  /**
   * Another chat view, as a new tab in the right sidebar (#153), with conversation *name* or a conversation of its
   * own (#301). A conversation open in another chat is shown there instead, as picking it would.
   */
  async newChatWindow(name?: string): Promise<void> {
    if (name) {
      const other = this.chatViews().find((chat) => chat.session() === name);
      if (other) {
        await this.app.workspace.revealLeaf(other.leaf);
        return;
      }
    }
    const leaf = this.app.workspace.getRightLeaf(false);
    if (!leaf) return;
    await leaf.setViewState({ type: CHAT_VIEW_TYPE, active: true });
    await this.app.workspace.revealLeaf(leaf);
    if (leaf.view instanceof ChatView) {
      this.lastChat = leaf.view;
      if (name) await leaf.view.openSession(name);
    }
  }

  async loadSettings(): Promise<void> {
    const stored = { ...((await this.loadData()) ?? {}) } as Record<string, unknown>;
    const bindings = stored.secrets;
    // How the runtime was started, and the switch to it: gone with the runtime (#88), and from data.json at once
    const obsolete = OBSOLETE_SETTINGS.filter((key) => key in stored);
    for (const key of obsolete) delete stored[key];
    // A vault without settings of its own starts from the defaults
    this.settings = { ...DEFAULT_SETTINGS, ...stored,
                      agentConfig: (stored.agentConfig as Record<string, unknown> | null) ?? {} };
    const config = withoutObsolete(this.settings.agentConfig);
    if (config) this.settings.agentConfig = config;
    const migrated = this.migrateSecretBindings(bindings);
    const named = this.nameBareConnection();
    if (obsolete.length || config || migrated || named) await this.saveSettings();
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  /** This plugin's tab in Obsidian's settings. `app.setting` is not in the published API, but every plugin uses it. */
  openSettings(): void {
    const setting = (this.app as unknown as { setting?: { open(): void; openTabById(id: string): unknown } }).setting;
    setting?.open();
    setting?.openTabById(this.manifest.id);
  }

  /** After a config write: the connections may have changed, and the chat header's picker should list them. */
  async configChanged(): Promise<void> {
    // A failure leaves the pickers as they were; the log says why (#174)
    await this.pluginBackend.refresh().catch((error) => this.addLog(`Could not refresh the agents and connections: ${messageOf(error)}`));
    // An MCP server that was removed, switched off or changed is closed; the next use starts it as it is now
    await this.mcpService.sync().catch((error) => this.addLog(`Could not update the MCP servers: ${messageOf(error)}`));
    for (const chat of this.chatViews()) chat.refreshProfiles();
    void this.settingTab?.reload();
  }

  /** An agent's system prompt as its next turn would send it, for the Agents tab's "Show as sent" (#67). */
  promptAsSent(name: string, draft: PromptDraft): Promise<PromptAsSent> {
    return this.inProcess.promptAsSent(name, draft);
  }

  /** After the Agents tab created, changed or deleted one: the chat's picker and the commands follow. */
  async agentsChanged(): Promise<void> {
    await this.pluginBackend.refresh().catch((error) => this.addLog(`Could not refresh the agents: ${messageOf(error)}`));
    this.commands?.sync();
    for (const chat of this.chatViews()) await chat.refreshAgents();
  }

  /** The vault's folder on disk, or null when there is none — a mobile vault, or a future remote one. */
  private vaultPath(): string | null {
    const adapter = this.app.vault.adapter;
    return adapter instanceof FileSystemAdapter ? adapter.getBasePath() : null;
  }
}
