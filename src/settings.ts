/**
 * What the plugin remembers between sessions.
 *
 * The plugin's own settings — what the chat view remembers — are kept here, in data.json. Keys are not: they live
 * in Obsidian's keychain, and the settings name them (`${openai-api-key}`, #147).
 * So is everything the agent itself is configured with (`agentConfig`, what config.yaml was for the Python
 * runtime), drawn from its schema (`config/schema.json`) by `settings/`.
 */

import { App, Modal, Notice, PluginSettingTab, Setting, SettingPage, type SettingDefinitionItem } from "obsidian";

import type { ConfigDocument, ConfigWriteResult } from "./api/types";
import { messageOf } from "./core/errors";
import { AgentsEditorState, renderAgents, type AgentsHost } from "./settings/AgentsTab";
import { featureGroup } from "./settings/BasicSections";
import { mcpGroup } from "./settings/McpSection";
import { BASIC_PATHS } from "./settings/basicPaths";
import { advancedGroups } from "./settings/ConfigSections";
import { findLocalServers, type LocalServer, type Profiles } from "./settings/connections";
import { connectionGroup, type ProfilesHost } from "./settings/ProfilesSection";
import { probe } from "./settings/probe";
import type ObsidianAgentPlugin from "./main";

export interface PluginSettings {
  /** The conversation the chat view had open last, so reopening Obsidian resumes it rather than starting over. */
  lastSession: string;
  /** Whether a new conversation is written to a vault note. The box in the chat header sets it per conversation. */
  keepConversations: boolean;
  /** The llm_profiles entry last chosen in the chat header. Empty means "whatever the agent asks for". */
  lastProfile: string;
  /**
   * The agent's configuration — what config.yaml was for the runtime (#86): connections, sampling, memory, audio,
   * journal, tool settings. Empty until something is set: the schema's defaults apply.
   */
  agentConfig: Record<string, unknown>;
}

export const DEFAULT_SETTINGS: PluginSettings = {
  lastSession: "",
  keepConversations: true,
  lastProfile: "",
  agentConfig: {},
};

/** Settings of the runtime the plugin used to start and of the switch to it (#88), and the Brave key's (#118) — dropped on load. */
export const OBSOLETE_SETTINGS = ["mode", "commandLine", "version", "binaryPath", "showStatusBar", "inProcessTurns",
                                   "braveSecretId",
                                   "developerTools", "secrets"];

/** How long a look for local servers stands before the Connections page looks again. */
const LOOK_AGAIN_MS = 30_000;

/**
 * The settings as Obsidian 1.13 describes them (#321): a page each for the connections, the features, the agents and
 * the rest, in the order setting up meets them (#149). Obsidian draws them, and finds each setting in its search.
 *
 * The agent's configuration is read once and kept; a change reads it again and describes the settings anew
 * (`reload`), which redraws the page that is open.
 */
export class AgentSettingTab extends PluginSettingTab {
  /** The agent's configuration as last read; null until the first read is done. */
  private doc: ConfigDocument | null = null;
  /** Why the configuration could not be read, when it could not. */
  private problem = "";
  /** Local servers no connection points at yet, and when they were looked for. */
  private found: LocalServer[] = [];
  private lookedAt = 0;

  /** The Agents page's editor, kept across redraws and closing the settings (#181). */
  private readonly agentsState = new AgentsEditorState();

  constructor(app: App, private readonly plugin: ObsidianAgentPlugin) {
    super(app, plugin);
    void this.reload();
  }

  /** Set while a field of these settings saves: the change needs no redraw, which would take the focus away. */
  private saving = false;

  /**
   * Read the agent's configuration again and describe the settings anew; the open page is drawn again. During a save
   * from these settings it only keeps what was saved, quietly: the field shows it already.
   */
  async reload(): Promise<void> {
    const quietly = this.saving;
    try {
      this.doc = await this.plugin.backend().config();
      this.problem = "";
    } catch (error) {
      this.problem = messageOf(error);
    }
    if (!quietly) this.update();
  }

  override getSettingDefinitions(): SettingDefinitionItem[] {
    const doc = this.doc;
    if (!doc) {
      return [this.problem
        ? { name: "Could not read the agent's configuration", desc: this.problem }
        : { name: "Loading the configuration…" }];
    }
    const redraw = (): void => void this.reload();
    const host: ProfilesHost = {
      app: this.app,
      save: (values) => this.saveConfig(values),
      probe: (url, headers) => probe(url, headers),
      redraw,
      connectionApproval: (name) => this.plugin.approvalStatus("connection", name),
      keychain: { app: this.app, names: () => this.plugin.keychainNames(), value: (name) => this.plugin.keychainValue(name) },
      approveConnection: (name) => this.plugin.approveOnThisDevice("connection", name),
    };
    const client = this.plugin.backend();
    const mcp = this.plugin.mcp();
    return [
      {
        type: "page", name: "Connections",
        desc: "Where the agent sends your notes. A cloud connection sends what the agent reads to that provider.",
        items: [connectionGroup(doc, host, this.found, () => this.lookForServers(doc))],
      },
      {
        type: "page", name: "Features",
        desc: "What the agent may do: web pages, undo, memory, audio transcription, MCP servers. A change applies "
              + "from the next message.",
        items: [
          featureGroup(doc, host, redraw, {
            detect: () => client.detectPrograms(),
            test: (program) => client.testProgram(program),
            approval: () => this.plugin.approvalStatus("programs"),
            approve: () => this.plugin.approveOnThisDevice("programs"),
          }),
          mcpGroup({
            app: this.app,
            status: () => mcp.status(),
            test: (name) => mcp.test(name),
            approve: (name) => mcp.approve(name),
            revoke: (name) => mcp.revoke(name),
            save: (values) => this.saveConfig(values),
            redraw,
          }),
        ],
      },
      {
        type: "page", name: "Agents",
        desc: "The default agent, and each agent's prompt, tools, folders and connection.",
        page: () => new AgentsPage(this.app, this.agentsHost()),
      },
      {
        type: "page", name: "Advanced",
        desc: `Everything else in ${doc.path}. An empty field uses the default.`,
        items: [...advancedGroups(doc, host, BASIC_PATHS), this.developerGroup()],
      },
    ];
  }

  /**
   * Look for llama.cpp, Ollama and the like on this machine while the Connections page is drawn — not at startup,
   * and not again within half a minute — and list what answers once it has.
   */
  private lookForServers(doc: ConfigDocument): void {
    if (Date.now() - this.lookedAt < LOOK_AGAIN_MS) return;
    this.lookedAt = Date.now();
    const profiles = (doc.values.llm_profiles ?? {}) as Profiles;
    void findLocalServers(profiles, (url) => probe(url)).then((found) => {
      if (JSON.stringify(found) === JSON.stringify(this.found)) return;
      this.found = found;
      this.update();
    }).catch(() => undefined);
  }

  /** Switches for testing the plugin itself. */
  private developerGroup(): SettingDefinitionItem {
    return {
      type: "group", heading: "Developer",
      items: [{
        name: "Agent tools on the Obsidian CLI",
        desc: "Leave this off unless you are testing the plugin: while it is on, any program on this computer can "
              + "delete, move or overwrite notes through the Obsidian command line without asking you. It lets "
              + "`obsidian agent:tool name=… args=…` run one of the agent's tools (destructive ones only with the "
              + "confirm flag), and `agent:ask … allow=destructive` change notes without the dialog, for unattended "
              + "runs such as the benchmark. The command-line tool takes effect when the plugin reloads. The switch "
              + "is kept on this device only: it does not sync with the vault.",
        aliases: ["developer"],
        render: (setting) => {
          setting.addToggle((toggle) => toggle
            .setValue(this.plugin.developer())
            .onChange((value) => this.plugin.setDeveloper(value)));
        },
      }],
    };
  }

  /** What the Agents page needs: the built-in agents and the vault's `.agents/`, kept by the plugin (#86). */
  private agentsHost(): Omit<AgentsHost, "redraw"> {
    const client = this.plugin.backend();
    return {
      app: this.app,
      state: this.agentsState,
      client,
      profiles: (client.info()?.profiles ?? []).map((profile) => profile.name),
      changed: () => this.plugin.agentsChanged(),
      setDefault: async (name) => {
        // The default agent is a config value, so it goes through the config API and its validation
        const result = await this.saveConfig({ vault: { default_agent: name } });
        if (!result?.ok) return false;
        await this.plugin.agentsChanged();  // the agent list carries which one is the default
        return true;
      },
      preview: (name, draft) => this.plugin.promptAsSent(name, draft),
    };
  }

  private async saveConfig(values: Record<string, unknown>): Promise<ConfigWriteResult | null> {
    const client = this.plugin.backend();
    this.saving = true;
    try {
      const result = await client.putConfig(values);
      if (result.ok && result.changed.length) await this.plugin.configChanged();
      return result;
    } catch (error) {
      new Notice(`Not saved: ${messageOf(error)}`, 10_000);
      return null;
    } finally {
      this.saving = false;
    }
  }
}

/**
 * The Agents page: the editor draws itself (`renderAgents`), with its picker, unsaved edits and tool switches, which
 * definitions cannot describe. Leaving it with unsaved edits asks what to do with them (#149).
 */
class AgentsPage extends SettingPage {
  constructor(private readonly app: App, private readonly host: Omit<AgentsHost, "redraw">) {
    super();
    this.title = "Agents";
  }

  override display(): void {
    this.containerEl.empty();
    this.containerEl.addClass("obsidian-agent-settings");
    void renderAgents(this.containerEl, { ...this.host, redraw: () => this.display() });
  }

  override hide(): void {
    const unsaved = this.host.state.unsaved();
    if (unsaved) new UnsavedModal(this.app, unsaved).open();
    super.hide();
  }
}

/** Unsaved edits to an agent as the settings close: save them, drop them, or keep them for the next visit. */
class UnsavedModal extends Modal {
  constructor(app: App, private readonly unsaved: { name: string; save(): Promise<boolean>; discard(): void }) {
    super(app);
  }

  override onOpen(): void {
    this.setTitle(`Save the changes to ${this.unsaved.name}?`);
    this.contentEl.createEl("p", { text: "You changed this agent in the settings and did not save. Kept for later, "
                                         + "the changes wait on the Agents page until Obsidian closes." });
    new Setting(this.contentEl)
      .addButton((button) => button.setButtonText("Keep for later").onClick(() => this.close()))
      .addButton((button) => button.setButtonText("Discard").setDestructive().onClick(() => {
        this.unsaved.discard();
        this.close();
      }))
      .addButton((button) => button.setButtonText("Save").setCta().onClick(async () => {
        if (await this.unsaved.save()) this.close();
      }));
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}
