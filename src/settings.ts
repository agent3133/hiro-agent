/**
 * What the plugin remembers between sessions.
 *
 * The plugin's own settings — what the chat view remembers, the Secrets bindings — are kept here, in data.json.
 * So is everything the agent itself is configured with (`agentConfig`, what config.yaml was for the Python
 * runtime), drawn from its schema (`config/schema.json`) by `settings/`.
 */

import { App, Notice, PluginSettingTab, Setting } from "obsidian";

import type { ConfigWriteResult } from "./api/types";
import { renderAgents } from "./settings/AgentsTab";
import { renderFeatures } from "./settings/BasicSections";
import { renderMcp } from "./settings/McpSection";
import { BASIC_PATHS } from "./settings/basicPaths";
import { renderAdvanced } from "./settings/ConfigSections";
import { group, tabs, type Tab } from "./settings/layout";
import { renderProfiles, type ProfilesHost } from "./settings/ProfilesSection";
import { probe } from "./settings/probe";
import { defaultSecretId, isValidSecretId, type SecretBinding } from "./settings/secrets";
import type ObsidianAgentPlugin from "./main";

export interface PluginSettings {
  /** The conversation the chat view had open last, so reopening Obsidian resumes it rather than starting over. */
  lastSession: string;
  /** Whether a new conversation is written to a vault note. The box in the chat header sets it per conversation. */
  keepConversations: boolean;
  /** The llm_profiles entry last chosen in the chat header. Empty means "whatever the agent asks for". */
  lastProfile: string;
  /**
   * The names a `${NAME}` in the settings may use, each bound to a secret in Obsidian's keychain. Only the names
   * are here; the values live in Obsidian's secret store, never in this data.json, which syncs with the vault.
   */
  secrets: SecretBinding[];
  /** Developer (#81): `obsidian agent:tool` runs one of the agent's tools, for testing inside Obsidian. */
  developerTools: boolean;
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
  secrets: [],
  developerTools: false,
  agentConfig: {},
};

/** Settings of the runtime the plugin used to start and of the switch to it (#88), and the Brave key's (#118) — dropped on load. */
export const OBSOLETE_SETTINGS = ["mode", "commandLine", "version", "binaryPath", "showStatusBar", "inProcessTurns",
                                   "braveSecretId"];

type TabId = "general" | "agents" | "features" | "secrets" | "advanced";

const TABS: Tab<TabId>[] = [
  { id: "general", label: "General" },
  { id: "agents", label: "Agents" },
  { id: "features", label: "Features" },
  { id: "secrets", label: "Secrets" },
  { id: "advanced", label: "Advanced" },
];

export class AgentSettingTab extends PluginSettingTab {
  /** The tab shown last, so a redraw after a change stays where the user was. */
  private activeTab: TabId = "general";

  constructor(app: App, private readonly plugin: ObsidianAgentPlugin) {
    super(app, plugin);
  }

  /**
   * Tabs, in the order a person setting the agent up meets them: where it sends notes and which agent answers,
   * what it may do, the secrets those need — and everything else last.
   */
  override display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass("obsidian-agent-settings");

    const panes = tabs(containerEl, TABS, this.activeTab, (id) => { this.activeTab = id; });
    this.displaySecrets(panes.secrets);
    this.displayConfig(panes.general, panes.features, panes.advanced);
    this.displayAgents(panes.agents);
  }

  /** Switches for testing the plugin itself. */
  private displayDeveloper(pane: HTMLElement): void {
    new Setting(group(pane, "Developer"))
      .setName("Agent tools on the Obsidian CLI")
      .setDesc("Lets `obsidian agent:tool name=… args=…` run one of the agent's tools, to test them inside "
               + "Obsidian; destructive tools run only with the confirm flag. Also lets `agent:ask … allow=destructive` "
               + "delete, move or overwrite notes without the dialog, for unattended runs such as the benchmark. "
               + "The command-line tool takes effect when the plugin reloads.")
      .addToggle((toggle) => toggle
        .setValue(this.plugin.settings.developerTools)
        .onChange(async (value) => {
          this.plugin.settings.developerTools = value;
          await this.plugin.saveSettings();
        }));
  }

  /**
   * Secrets, held by Obsidian: the only place a `${NAME}` in the settings is read from, when a turn or an MCP
   * server needs it — so a change applies from the next one.
   *
   * The plugin stores only the *name* of each secret; the value lives in Obsidian's secret store, which is
   * backed by DPAPI on Windows, the Keychain on macOS and libsecret or KWallet on Linux. Writing the value into
   * `data.json` would be plaintext inside the vault, which is what this exists to avoid.
   */
  private displaySecrets(containerEl: HTMLElement): void {
    const storage = this.app.secretStorage;
    containerEl = group(containerEl, "Secrets",
      "A setting that says api_key: ${LLM_API_KEY} reads the value from here, and only from here, so the "
      + "settings, which sync with the vault, hold no secret of their own. Obsidian keeps the values; this plugin "
      + "stores only their names.");

    const existing = safeListSecrets(storage);

    this.plugin.settings.secrets.forEach((binding, index) => {
      const id = binding.id || defaultSecretId(binding.env);
      const held = Boolean(id && safeGetSecret(storage, id));
      const setting = new Setting(containerEl)
        .setName(binding.env || "(unnamed)")
        .setDesc(id
          ? `Keychain id "${id}" — ${held ? "set" : "not set"}`
          : "Name the variable first; the keychain id follows from it")
        .addText((text) => text
          .setPlaceholder("LLM_API_KEY")
          .setValue(binding.env)
          .onChange(async (value) => {
            this.plugin.settings.secrets[index].env = value.trim();
            await this.plugin.saveSettings();
          }));

      // Obsidian's own dialog only accepts lowercase letters, digits and dashes — no underscores — so a secret
      // made there is never named like the variable. Offering what is already in the keychain is how a binding
      // reaches it without anyone having to guess the spelling.
      if (existing.length) {
        setting.addDropdown((dropdown) => {
          dropdown.addOption("", id ? `${id} (from the name)` : "(from the name)");
          for (const known of existing) dropdown.addOption(known, known);
          dropdown.setValue(existing.includes(binding.id) ? binding.id : "");
          dropdown.onChange(async (value) => {
            this.plugin.settings.secrets[index].id = value;
            await this.plugin.saveSettings();
            this.display();
            new Notice(`${binding.env} now reads "${value || defaultSecretId(binding.env)}".`);
          });
        });
      }

      setting
        .addText((text) => {
          text.inputEl.type = "password";
          text.setPlaceholder(held ? "replace the value" : "paste the value")
            .onChange(async (value) => {
              if (!value) return;
              if (!isValidSecretId(id)) {
                new Notice(`"${id}" is not a keychain id Obsidian will take: lowercase letters, digits and `
                           + "dashes, up to 64 characters.", 10_000);
                return;
              }
              try {
                // Straight into Obsidian's store, and never into this plugin's settings.
                storage.setSecret(id, value);
              } catch (error) {
                new Notice(`Obsidian would not store that secret: ${(error as Error).message}`, 10_000);
                return;
              }
              this.plugin.settings.secrets[index].id = id;
              await this.plugin.saveSettings();
              text.setValue("");
              this.display();
              new Notice(`"${id}" is stored in Obsidian's keychain.`);
            });
        })
        .addExtraButton((button) => button
          .setIcon("trash-2")
          .setTooltip("Forget this variable (the secret itself stays in Obsidian's keychain)")
          .onClick(async () => {
            const gone = this.plugin.settings.secrets[index].env;
            this.plugin.settings.secrets.splice(index, 1);
            await this.plugin.saveSettings();
            this.display();
            new Notice(`${gone} is forgotten; the secret itself stays in Obsidian's keychain.`);
          }));
    });

    new Setting(containerEl)
      .addButton((button) => button
        .setButtonText("Add a secret")
        .onClick(async () => {
          this.plugin.settings.secrets.push({ env: "LLM_API_KEY", id: "" });
          await this.plugin.saveSettings();
          this.display();
        }));
  }

  /**
   * Connections and the rest of the agent's configuration, kept by the plugin for this vault (#86).
   *
   * A change is checked against the configuration's schema before it is saved, secrets are masked on the way to
   * the form, and the next turn uses what was saved — as the runtime did with config.yaml.
   */
  private displayConfig(general: HTMLElement, features: HTMLElement, advanced: HTMLElement): void {
    const client = this.plugin.backend();
    const panes = [general, features, advanced];
    const loading = panes.map((pane) => pane.createEl("p", {
      cls: "setting-item-description", text: "Loading the configuration…",
    }));
    const host: ProfilesHost = {
      save: (values) => this.saveConfig(values),
      probe: (url) => probe(url),
      redraw: () => this.display(),
    };
    client.config().then((doc) => {
      for (const line of loading) line.remove();
      renderProfiles(general, doc, host);
      renderFeatures(features, doc, host, host.redraw, {
        detect: () => client.detectPrograms(),
        test: (program) => client.testProgram(program),
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
      new Notice(`Not saved: ${(error as Error).message}`, 10_000);
      return null;
    }
  }
}

/** The keychain's ids, or none. Listing is a convenience; a store that will not answer must not break settings. */
function safeListSecrets(storage: { listSecrets(): string[] }): string[] {
  try {
    return [...storage.listSecrets()].sort();
  } catch {
    return [];
  }
}

function safeGetSecret(storage: { getSecret(id: string): string | null }, id: string): string | null {
  try {
    return storage.getSecret(id);
  } catch {
    return null;
  }
}
