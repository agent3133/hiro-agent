/**
 * What the plugin remembers between sessions.
 *
 * The plugin's own settings — what the chat view remembers — are kept here, in data.json. Keys are not: they live
 * in Obsidian's keychain, and the settings name them (`${openai-api-key}`, #147).
 * So is everything the agent itself is configured with (`agentConfig`, what config.yaml was for the Python
 * runtime), drawn from its schema (`config/schema.json`) by `settings/`.
 */

import { App, Modal, Notice, PluginSettingTab, Setting } from "obsidian";

import type { ConfigWriteResult } from "./api/types";
import { messageOf } from "./core/errors";
import { AgentsEditorState, renderAgents } from "./settings/AgentsTab";
import { renderFeatures } from "./settings/BasicSections";
import { renderMcp } from "./settings/McpSection";
import { BASIC_PATHS } from "./settings/basicPaths";
import { renderAdvanced } from "./settings/ConfigSections";
import { group, tabs, type Tab } from "./settings/layout";
import { renderProfiles, type ProfilesHost } from "./settings/ProfilesSection";
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

type TabId = "connections" | "features" | "agents" | "advanced";

/** In the order setting up meets them: where notes go, what the agent may do, who answers, the rest (#149). */
const TABS: Tab<TabId>[] = [
  { id: "connections", label: "Connections" },
  { id: "features", label: "Features" },
  { id: "agents", label: "Agents" },
  { id: "advanced", label: "Advanced" },
];

export class AgentSettingTab extends PluginSettingTab {
  /** The tab shown last, so a redraw after a change stays where the user was. */
  private activeTab: TabId = "connections";

  /** The Agents tab's editor, kept across redraws and closing the settings (#181). */
  private readonly agentsState = new AgentsEditorState();

  constructor(app: App, private readonly plugin: ObsidianAgentPlugin) {
    super(app, plugin);
  }

  /** Tabs, in the order a person setting the agent up meets them (TABS). */
  override display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass("obsidian-agent-settings");

    const panes = tabs(containerEl, TABS, this.activeTab, (id) => { this.activeTab = id; });
    this.displayConfig(panes.connections, panes.features, panes.advanced);
    this.displayAgents(panes.agents);
  }

  /** Asked on closing the settings with unsaved agent edits (#149): they are kept until saved or discarded. */
  override hide(): void {
    const unsaved = this.agentsState.unsaved();
    if (unsaved) new UnsavedModal(this.app, unsaved).open();
    super.hide();
  }

  /** Switches for testing the plugin itself. */
  private displayDeveloper(pane: HTMLElement): void {
    new Setting(group(pane, "Developer"))
      .setName("Agent tools on the Obsidian CLI")
      .setDesc("Leave this off unless you are testing the plugin: while it is on, any program on this computer "
               + "can delete, move or overwrite notes through the Obsidian command line without asking you. It "
               + "lets `obsidian agent:tool name=… args=…` run one of the agent's tools (destructive ones only with "
               + "the confirm flag), and `agent:ask … allow=destructive` change notes without the dialog, for "
               + "unattended runs such as the benchmark. The command-line tool takes effect when the plugin "
               + "reloads. The switch is kept on this device only: it does not sync with the vault.")
      .addToggle((toggle) => toggle
        .setValue(this.plugin.developer())
        .onChange((value) => this.plugin.setDeveloper(value)));
  }

  /**
   * Connections and the rest of the agent's configuration, kept by the plugin for this vault (#86).
   *
   * A change is checked against the configuration's schema before it is saved, secrets are masked on the way to
   * the form, and the next turn uses what was saved — as the runtime did with config.yaml.
   */
  private displayConfig(connections: HTMLElement, features: HTMLElement, advanced: HTMLElement): void {
    const client = this.plugin.backend();
    const panes = [connections, features, advanced];
    const loading = panes.map((pane) => pane.createEl("p", {
      cls: "setting-item-description", text: "Loading the configuration…",
    }));
    const host: ProfilesHost = {
      app: this.app,
      save: (values) => this.saveConfig(values),
      probe: (url, headers) => probe(url, headers),
      redraw: () => this.display(),
      connectionApproval: (name) => this.plugin.approvalStatus("connection", name),
      keychain: { app: this.app, names: () => this.plugin.keychainNames(), value: (name) => this.plugin.keychainValue(name) },
      approveConnection: (name) => this.plugin.approveOnThisDevice("connection", name),
    };
    client.config().then((doc) => {
      for (const line of loading) line.remove();
      renderProfiles(connections, doc, host);
      renderFeatures(features, doc, host, host.redraw, {
        detect: () => client.detectPrograms(),
        test: (program) => client.testProgram(program),
        approval: () => this.plugin.approvalStatus("programs"),
        approve: () => this.plugin.approveOnThisDevice("programs"),
      });
      const mcp = this.plugin.mcp();
      renderMcp(features, {
        app: this.app,
        status: () => mcp.status(),
        test: (name) => mcp.test(name),
        approve: (name) => mcp.approve(name),
        revoke: (name) => mcp.revoke(name),
        save: (values) => this.saveConfig(values),
        redraw: host.redraw,
      });
      renderAdvanced(advanced, doc, host, BASIC_PATHS);
      this.displayDeveloper(advanced);
    }).catch((error: Error) => {
      for (const line of loading) line.setText(`Could not read the agent's configuration: ${error.message}`);
    });
  }

  /** The Agents tab: the built-in agents and the vault's `.agents/`, kept by the plugin (#86). */
  private displayAgents(pane: HTMLElement): void {
    const client = this.plugin.backend();
    void renderAgents(pane, {
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
      redraw: () => this.display(),
    });
  }

  private async saveConfig(values: Record<string, unknown>): Promise<ConfigWriteResult | null> {
    const client = this.plugin.backend();
    try {
      const result = await client.putConfig(values);
      if (result.ok && result.changed.length) await this.plugin.configChanged();
      return result;
    } catch (error) {
      new Notice(`Not saved: ${messageOf(error)}`, 10_000);
      return null;
    }
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
                                         + "the changes wait in the Agents tab until Obsidian closes." });
    new Setting(this.contentEl)
      .addButton((button) => button.setButtonText("Keep for later").onClick(() => this.close()))
      .addButton((button) => button.setButtonText("Discard").setWarning().onClick(() => {
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
