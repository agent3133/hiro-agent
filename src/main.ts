/**
 * The plugin itself: the agent runs inside it (#88) — its settings and agents (#86), conversations (#85), tools on
 * Obsidian's own API (#80–#84) and MCP servers (#87) — with the chat view (WP6), the commands (WP7, in
 * `commands/`) and the settings tab (WP8) around it.
 */

import { FileSystemAdapter, Notice, Plugin, TFile, WorkspaceLeaf, requestUrl } from "obsidian";

import { AgentCommands } from "./commands/AgentCommands";
import type { NoteContext } from "./commands/context";
import { AgentSettingTab, DEFAULT_SETTINGS, OBSOLETE_SETTINGS, type PluginSettings } from "./settings";
import { CHAT_VIEW_TYPE, ChatView } from "./view/ChatView";
import { ConfirmModal } from "./view/ConfirmModal";
import { sessionNameFor } from "./view/sessionName";
import { InProcessAgent } from "./inprocess/InProcessAgent";
import { AgentCatalog } from "./config/agents";
import { PluginBackend } from "./config/backend";
import { defaultProfileName, hasConnection, profileSummaries, resolveConnection } from "./config/connections";
import { addLocalServer, findLocalServers, type Profiles } from "./settings/connections";
import { probe } from "./settings/probe";
import { registerCli } from "./cli/register";
import type { AgentStatus } from "./cli/status";
import { ConfigStore, withoutObsolete } from "./config/store";
import { APPROVALS_KEY, McpApprovals } from "./mcp/approvals";
import { McpManager } from "./mcp/manager";
import { nodeFetch } from "./mcp/nodeFetch";
import { McpService } from "./mcp/service";
import { listSessions } from "./core/sessions";
import { obsidianVault } from "./vault/obsidianVault";
import { nodePrograms } from "./vault/programs";
import { registerToolCli } from "./vault/toolCli";
import { toolsetOptions, type ToolsetOptions } from "./vault/toolset";

const LOG_LINES = 200;

export default class ObsidianAgentPlugin extends Plugin {
  override settings: PluginSettings = { ...DEFAULT_SETTINGS };  // Plugin declares `settings?: unknown`
  private readonly log: string[] = [];
  private commands: AgentCommands | null = null;
  // The agent's configuration and agents, kept by the plugin (#86), and the agent that answers in the plugin
  private readonly store = new ConfigStore(() => this.settings.agentConfig, async (values) => {
    this.settings.agentConfig = values;
    await this.saveSettings();
  }, () => this.vaultPath() ?? "");
  // MCP servers (#87): kept connected while Obsidian runs; a stdio one starts only once approved on this device,
  // and the approvals live in this device's local storage, not in data.json, which syncs
  private readonly mcpApprovals = new McpApprovals(() => this.app.loadLocalStorage(APPROVALS_KEY),
                                                   (value) => this.app.saveLocalStorage(APPROVALS_KEY, value));
  private readonly mcpManager = new McpManager({
    vaultPath: () => this.vaultPath() ?? "",
    keychain: (name) => this.secretValue(name),
    approved: (spec) => this.mcpApprovals.approved(spec),
    log: (line) => this.addLog(line),
    fetch: nodeFetch,
    version: this.manifest.version,
  });
  private readonly mcpService = new McpService(() => this.store.values(), this.mcpManager, this.mcpApprovals);
  private readonly catalog = new AgentCatalog(obsidianVault(this.app), () => {
    const values = this.store.values();
    const vault = (values.vault ?? {}) as Record<string, unknown>;
    return { defaultAgent: typeof vault.default_agent === "string" ? vault.default_agent : "assistant",
             profiles: profileSummaries(values).map((p) => p.name) };
  }, () => this.mcpService.toolInfos());
  private readonly pluginBackend = new PluginBackend(this.store, this.catalog, nodePrograms, this.manifest.version,
                                                     this.app.vault.getName());
  private readonly inProcess = new InProcessAgent(this.app, {
    catalog: this.catalog, backend: this.pluginBackend, values: () => this.store.values(),
    env: (name) => this.secretValue(name),
    fetchJson: async (url) => (await requestUrl({ url, throw: true })).json as unknown,
    mcp: this.mcpManager,
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

  /** What the in-plugin agent's tools are set to: its settings. */
  private async toolsetOptions(): Promise<ToolsetOptions> {
    return toolsetOptions({ values: this.store.values() });
  }

  /**
   * A `${VAR}` reference in the settings: the keychain secret bound to that name (Secrets), and nothing else — no
   * environment variable, no key written into the settings. Obsidian's keychain is the one place a key lives.
   */
  private secretValue(name: string): string | undefined {
    const binding = this.settings.secrets.find((secret) => secret.env === name);
    return (binding?.id ? this.app.secretStorage.getSecret(binding.id) : null) || undefined;
  }

  /** The agent's settings and agents, as the settings tabs and the chat header ask for them (#86). */
  backend(): PluginBackend {
    return this.pluginBackend;
  }

  override async onload(): Promise<void> {
    await this.loadSettings();
    this.addSettingTab(new AgentSettingTab(this.app, this));
    if (this.settings.developerTools) {
      registerToolCli(this, this.app, () => this.toolsetOptions());
    }
    registerCli(this, {
      status: () => this.cliStatus(),
      agents: async () => (await this.pluginBackend.refresh()).agents,
      sessions: () => listSessions(obsidianVault(this.app)),
      ask: {
        info: () => this.pluginBackend.refresh(),
        send: (prompt, options, handlers) => this.inProcess.send(prompt, options, handlers),
        cancel: (turn) => this.inProcess.cancel(turn),
        confirm: (turn, callId, approved) => this.inProcess.confirm(turn, callId, approved),
        noteExists: async (path) => this.app.vault.getAbstractFileByPath(path) instanceof TFile,
        askInObsidian: (name, input) => new Promise((resolve) => new ConfirmModal(this.app, { name, input }, resolve).open()),
        developer: () => this.settings.developerTools,
        notice: (text) => new Notice(text, 10_000),
        sessionName: (prompt) => sessionNameFor(prompt),
      },
    });

    if (!this.vaultPath()) {
      // Mobile has no file system path and no way to run a binary; say so once instead of failing repeatedly.
      new Notice("Hiro Agent runs on desktop only.");
      return;
    }

    this.registerView(CHAT_VIEW_TYPE, (leaf: WorkspaceLeaf) => new ChatView(leaf, {
      agent: () => this.inProcess,
      defaultAgent: () => this.defaultAgent(),
      lastSession: () => this.settings.lastSession,
      keepByDefault: () => this.settings.keepConversations,
      lastProfile: () => this.settings.lastProfile,
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
    }));
    this.addRibbonIcon("bot", "Hiro Agent", () => void this.openChat());

    // Obsidian shows each of these as "Hiro Agent: <name>" — the prefix is this plugin's name in manifest.json
    this.addCommand({
      id: "open-chat",
      name: "Open the chat",
      callback: () => void this.openChat(),
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
    this.app.workspace.onLayoutReady(() => void this.agentsChanged().then(() => {
      for (const leaf of this.app.workspace.getLeavesOfType(CHAT_VIEW_TYPE)) (leaf.view as ChatView).refreshProfiles();
    }));
  }

  override async onunload(): Promise<void> {
    await this.mcpManager.closeAll().catch(() => undefined);
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

  /** A command's request: open the chat and run it there, in a new conversation. */
  private async runRequest(agent: string, message: string, context: NoteContext | undefined): Promise<void> {
    await this.openChat();
    const view = this.app.workspace.getLeavesOfType(CHAT_VIEW_TYPE)[0]?.view;
    if (view instanceof ChatView) await view.runRequest(agent, message, context);
  }

  /** Reveal the chat in the right sidebar, creating it the first time. */
  async openChat(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(CHAT_VIEW_TYPE);
    const leaf = existing[0] ?? this.app.workspace.getRightLeaf(false);
    if (!leaf) return;
    if (!existing.length) await leaf.setViewState({ type: CHAT_VIEW_TYPE, active: true });
    await this.app.workspace.revealLeaf(leaf);
  }

  async loadSettings(): Promise<void> {
    const stored = { ...((await this.loadData()) ?? {}) } as Record<string, unknown>;
    // How the runtime was started, and the switch to it: gone with the runtime (#88), and from data.json at once
    const obsolete = OBSOLETE_SETTINGS.filter((key) => key in stored);
    for (const key of obsolete) delete stored[key];
    // A vault without settings of its own starts from the defaults
    this.settings = { ...DEFAULT_SETTINGS, ...stored,
                      agentConfig: (stored.agentConfig as Record<string, unknown> | null) ?? {} };
    const config = withoutObsolete(this.settings.agentConfig);
    if (config) this.settings.agentConfig = config;
    if (obsolete.length || config) await this.saveSettings();
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
    await this.pluginBackend.refresh().catch(() => undefined);
    // An MCP server that was removed, switched off or changed is closed; the next use starts it as it is now
    await this.mcpService.sync().catch(() => undefined);
    for (const leaf of this.app.workspace.getLeavesOfType(CHAT_VIEW_TYPE)) (leaf.view as ChatView).refreshProfiles();
  }

  /** After the Agents tab created, changed or deleted one: the chat's picker and the commands follow. */
  async agentsChanged(): Promise<void> {
    await this.pluginBackend.refresh().catch(() => undefined);
    this.commands?.sync();
    for (const leaf of this.app.workspace.getLeavesOfType(CHAT_VIEW_TYPE)) await (leaf.view as ChatView).refreshAgents();
  }

  /** The vault's folder on disk, or null when there is none — a mobile vault, or a future remote one. */
  private vaultPath(): string | null {
    const adapter = this.app.vault.adapter;
    return adapter instanceof FileSystemAdapter ? adapter.getBasePath() : null;
  }
}
