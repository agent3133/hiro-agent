/**
 * The Agents tab: which agent answers by default, and an editor for any one — prompt, folders, tools, and the
 * rarely changed rest folded away.
 *
 * An agent is a Markdown file (built in, or in the vault's `.agents/`); this tab edits it through the catalog, which validates
 * every field against what it can actually do before anything is written. Nothing saves until Save: an agent's
 * tools and folders decide what it may touch, and half an edit saved on the way elsewhere is the wrong default.
 *
 * Folders (`vault_scope`) are the strongest control the app has — enforced in the tool layer, not asked for in
 * the prompt. While any are set, the tools that could reach past them are withheld from the agent, and shown
 * greyed out here with the reason, so the tab never promises more than the tool layer holds.
 */

import { App, FuzzySuggestModal, Modal, Notice, Setting, TFolder } from "obsidian";

import type { AgentDetail, AgentFields, AgentSource, AgentWrite, ToolInfo } from "../api/types";
import type { PluginBackend } from "../config/backend";
import { ALL_MCP_TOOLS, isMcpToolName } from "../mcp/servers";
import { group } from "./layout";

export interface AgentsHost {
  app: App;
  /** Where the agents are kept: the plugin itself since #86 (config/backend.ts). */
  client: Pick<PluginBackend, "tools" | "info" | "createAgent" | "agent" | "resetAgent" | "deleteAgent" | "saveAgent">;
  /** The connections an agent can name (`llm_profiles`). */
  profiles: string[];
  /** The agent list changed: tell the chat, the commands and the client. */
  changed(): Promise<void>;
  /** Make *name* the agent used when none is chosen (the config's `vault.default_agent`). */
  setDefault(name: string): Promise<boolean>;
  /** Draw the whole settings tab again. */
  redraw(): void;
}

/** Which agent the editor showed last, and whether it holds unsaved changes — both survive a redraw. */
let selected = "";
let dirty = false;
/** Tool groups unfolded to single switches; kept across redraws so fine-tuning does not fold away. */
const unfolded = new Set<string>();

const SOURCE_LABEL: Record<AgentSource, string> = {
  bundled: "built in",
  user: "yours",
  vault: "in this vault",
  other: "from an agents folder in the config",
};

export async function renderAgents(pane: HTMLElement, host: AgentsHost): Promise<void> {
  const loading = pane.createEl("p", { cls: "setting-item-description", text: "Loading the agents…" });
  let catalog: ToolInfo[];
  try {
    catalog = await host.client.tools();
  } catch (error) {
    loading.setText(`Could not read the agents: ${(error as Error).message}`);
    return;
  }
  loading.remove();
  const agents = host.client.info()?.agents ?? [];
  const fallback = agents.find((agent) => agent.default)?.name ?? "";
  if (!agents.some((agent) => agent.name === selected)) {
    selected = fallback || agents[0]?.name || "";
    dirty = false;
  }
  const discard = (): boolean => !dirty || window.confirm(`Discard the unsaved changes to ${selected}?`);

  const top = group(pane, "Agents", "An agent is a prompt, the tools it may use and the folders it may work in.");
  new Setting(top)
    .setName("Used when none is chosen")
    .setDesc("Answers a conversation or command that does not pick an agent.")
    .addDropdown((dropdown) => {
      for (const agent of agents) dropdown.addOption(agent.name, agent.name);
      dropdown.setValue(fallback).onChange(async (name) => {
        if (await host.setDefault(name)) host.redraw();
      });
    });
  const picker = new Setting(top).setName("Edit").addDropdown((dropdown) => {
    for (const agent of agents) dropdown.addOption(agent.name, `${agent.name} (${SOURCE_LABEL[agent.source ?? "other"]})`);
    dropdown.setValue(selected).onChange((name) => {
      if (!discard()) {
        dropdown.setValue(selected);
        return;
      }
      selected = name;
      dirty = false;
      host.redraw();
    });
  });
  picker.addButton((button) => button.setButtonText("New").onClick(() => {
    if (!discard()) return;
    new NameModal(host.app, "A new agent", "", (name) => void create(name, "", host)).open();
  }));
  const description = agents.find((agent) => agent.name === selected)?.description;
  if (description) picker.setDesc(description);

  if (selected) await renderEditor(pane, selected, catalog, host, picker);
}

async function create(name: string, from: string, host: AgentsHost): Promise<void> {
  const result = await host.client.createAgent(name, from || undefined);
  if (!refused(result)) {
    selected = name;
    dirty = false;
    await host.changed();
    host.redraw();
  }
}

/** Show why a write was refused, field by field. True when it was. */
function refused(result: AgentWrite): boolean {
  if (result.ok) return false;
  const reasons = result.fields.map((item) => `${item.path}: ${item.message}`).join("\n");
  new Notice(`Not saved.\n${reasons || result.error}`, 12_000);
  return true;
}

async function renderEditor(pane: HTMLElement, name: string, catalog: ToolInfo[], host: AgentsHost,
                            picker: Setting): Promise<void> {
  let agent: AgentDetail;
  try {
    agent = await host.client.agent(name);
  } catch (error) {
    pane.createEl("p", { cls: "setting-item-description", text: `Could not read ${name}: ${(error as Error).message}` });
    return;
  }
  const draft: AgentFields & { prompt: string } = {
    description: agent.description, tools: [...agent.tools], vault_scope: [...agent.vault_scope],
    llm_profile: agent.llm_profile, max_iterations: agent.max_iterations, model: agent.model,
    temperature: agent.temperature, enable_thinking: agent.enable_thinking, prompt: agent.prompt,
  };
  const touch = (): void => { dirty = true; };

  // --- Actions on the whole agent sit with the picker ----------------------------------------------------------
  picker.addButton((button) => button.setButtonText("Duplicate").onClick(() => {
    new NameModal(host.app, `A copy of ${name}`, `${name}-copy`, (copy) => void create(copy, name, host)).open();
  }));
  if (agent.can_reset) {
    picker.addButton((button) => button.setButtonText("Reset").setTooltip("Use the built-in version again")
      .setWarning().onClick(async () => {
        if (!window.confirm(`Drop your copy of ${name} and use the built-in one again?`)) return;
        try {
          await host.client.resetAgent(name);
        } catch (error) {
          new Notice(`Not reset: ${(error as Error).message}`, 10_000);
          return;
        }
        dirty = false;
        await host.changed();
        host.redraw();
      }));
  }
  if (agent.can_delete) {
    picker.addButton((button) => button.setButtonText("Delete").setWarning().onClick(async () => {
      if (!window.confirm(`Delete the agent ${name}? Its file is removed: ${agent.path}`)) return;
      try {
        await host.client.deleteAgent(name);
      } catch (error) {
        new Notice(`Not deleted: ${(error as Error).message}`, 10_000);
        return;
      }
      selected = "";
      dirty = false;
      await host.changed();
      host.redraw();
    }));
  }

  // --- What it is --------------------------------------------------------------------------------------------
  const about = group(pane, "Prompt", whereItSaves(agent));
  new Setting(about).setName("Description").setDesc("Shown in the agent pickers.")
    .addText((text) => text.setValue(draft.description ?? "").onChange((value) => {
      draft.description = value.trim() || null;
      touch();
    }));
  const prompt = about.createEl("textarea", { cls: "obsidian-agent-prompt" });
  prompt.rows = 12;
  prompt.spellcheck = false;
  prompt.value = draft.prompt;
  prompt.addEventListener("input", () => { draft.prompt = prompt.value; touch(); });
  about.createEl("p", {
    cls: "setting-item-description obsidian-agent-prompt-hint",
    text: `Filled in each turn: ${agent.variables.map((variable) => `{{ ${variable} }}`).join(", ")}.`,
  });

  // --- Where it may work, and with what ----------------------------------------------------------------------
  const folders = group(pane, "Folders", "Empty: the whole vault. Set: the agent's note tools refuse every note "
                                         + "outside these folders, whatever the prompt or a note says.");
  const toolsSlot = pane.createDiv();
  const drawTools = (): void => {
    toolsSlot.empty();
    renderTools(toolsSlot, draft, catalog, touch, drawTools);
  };
  const drawFolders = (): void => {
    folders.querySelectorAll(".obsidian-agent-folder").forEach((element) => element.remove());
    for (const folder of draft.vault_scope) {
      const row = new Setting(folders).setName(folder).addExtraButton((button) => button
        .setIcon("x").setTooltip(`Remove ${folder}`).onClick(() => {
          draft.vault_scope = draft.vault_scope.filter((item) => item !== folder);
          touch();
          drawFolders();
          drawTools();
        }));
      row.settingEl.addClass("obsidian-agent-folder");
      folders.insertBefore(row.settingEl, addFolder.settingEl);
    }
  };
  const addFolder = new Setting(folders).addButton((button) => button.setButtonText("Add a folder").onClick(() => {
    new FolderPicker(host.app, draft.vault_scope, (folder) => {
      draft.vault_scope = [...draft.vault_scope, folder];
      touch();
      drawFolders();
      drawTools();
    }).open();
  }));
  drawFolders();
  drawTools();

  // --- The rarely changed, folded ----------------------------------------------------------------------------
  const more = pane.createEl("details", { cls: "obsidian-agent-more" });
  more.createEl("summary", { text: "More: connection, step limit, model" });
  const running = group(more.createDiv());
  new Setting(running).setName("Connection")
    .setDesc("Where this agent sends notes. A connection chosen in the chat header wins over this one.")
    .addDropdown((dropdown) => {
      dropdown.addOption("", "the chat's choice, or the default");
      for (const profile of host.profiles) dropdown.addOption(profile, profile);
      if (draft.llm_profile && !host.profiles.includes(draft.llm_profile)) {
        dropdown.addOption(draft.llm_profile, `${draft.llm_profile} (not configured)`);
      }
      dropdown.setValue(draft.llm_profile ?? "").onChange((value) => { draft.llm_profile = value || null; touch(); });
    });
  numberSetting(running, "Step limit", "Tool calls in one turn before the agent has to answer. Empty uses 50.",
                draft.max_iterations, (value) => { draft.max_iterations = value; touch(); }, true);
  new Setting(running).setName("Model").setDesc("Overrides the connection's model for this agent. Empty uses it.")
    .addText((text) => text.setValue(draft.model ?? "").onChange((value) => { draft.model = value.trim() || null; touch(); }));
  numberSetting(running, "Temperature", "0 to 2; lower is more predictable. Empty uses the connection's.",
                draft.temperature, (value) => { draft.temperature = value; touch(); }, false);
  new Setting(running).setName("Thinking").setDesc("For reasoning models. Default leaves it to the connection.")
    .addDropdown((dropdown) => dropdown
      .addOptions({ "": "default", on: "on", off: "off" })
      .setValue(draft.enable_thinking === null ? "" : draft.enable_thinking ? "on" : "off")
      .onChange((value) => { draft.enable_thinking = value === "" ? null : value === "on"; touch(); }));

  // --- Save ---------------------------------------------------------------------------------------------------
  const actions = new Setting(pane);
  actions.settingEl.addClass("obsidian-agent-agent-actions");
  actions.addButton((button) => button.setButtonText("Save").setCta().onClick(async () => {
    const fields = changedFields(agent, draft);
    const change: { prompt?: string; fields?: Partial<AgentFields> } = {};
    if (Object.keys(fields).length) change.fields = fields;
    if (draft.prompt !== agent.prompt) change.prompt = draft.prompt;
    if (!change.fields && change.prompt === undefined) {
      new Notice("Nothing has changed.");
      return;
    }
    const result = await host.client.saveAgent(name, change);
    if (refused(result)) return;
    dirty = false;
    new Notice(`${name} is saved. It applies from the next turn.`);
    await host.changed();
    host.redraw();
  }));
  actions.addButton((button) => button.setButtonText("Discard changes").onClick(() => {
    dirty = false;
    host.redraw();
  }));
}

/**
 * The tools as one switch per group, each unfolding to its tools. What a group does — delete, leave the machine,
 * run programs — is said once on the group. With folders set, the tools that could reach past them are greyed
 * out: they are withheld from a folder-restricted agent, and the card says so.
 */
function renderTools(slot: HTMLElement, draft: AgentFields, catalog: ToolInfo[], touch: () => void,
                     redraw: () => void): void {
  const scoped = draft.vault_scope.length > 0;
  // mcp:* gives the agent every MCP tool, so while it is on, each server's tools show as on — never "off" while
  // the agent can in fact call them. Switching one off spells mcp:* out: every other MCP tool, listed by name
  const allMcp = draft.tools.includes(ALL_MCP_TOOLS);
  const covered = (tool: ToolInfo): boolean => allMcp && tool.name !== ALL_MCP_TOOLS && isMcpToolName(tool.name);
  const spellOut = (without: string[]): void => {
    const mcp = catalog.filter((tool) => tool.name !== ALL_MCP_TOOLS && isMcpToolName(tool.name)
                                         && !without.includes(tool.name) && !draft.tools.includes(tool.name));
    draft.tools = [...draft.tools.filter((item) => item !== ALL_MCP_TOOLS), ...mcp.map((tool) => tool.name)];
    touch();
    redraw();
  };
  const card = group(slot, "Tools", scoped
    ? "Greyed out while folders are set: those tools could reach notes outside the folders — through Obsidian's "
      + "index, TaskNotes or an MCP server — so they are withheld from this agent. They come back "
      + "if you remove the folders."
    : "What the agent may call. It cannot use a tool that is switched off.");

  const groups = new Map<string, ToolInfo[]>();
  for (const tool of catalog) groups.set(tool.group, [...(groups.get(tool.group) ?? []), tool]);

  for (const [name, tools] of groups) {
    const usable = tools.filter((tool) => !(scoped && tool.ignores_scope) && !covered(tool));
    // The MCP group: its count is of the servers' tools, "All MCP tools" (mcp:*) standing over them
    const mcpGroup = tools.some((tool) => tool.name === ALL_MCP_TOOLS);
    const on = (): number => usable.filter((tool) => draft.tools.includes(tool.name)).length;
    const mcpCount = (): string => {
      const servers = tools.filter((tool) => tool.name !== ALL_MCP_TOOLS);
      if (draft.tools.includes(ALL_MCP_TOOLS)) return `all ${servers.length} on, and ones added later`;
      return `${servers.filter((tool) => draft.tools.includes(tool.name)).length} of ${servers.length} on`;
    };
    const marks = [
      tools.some((tool) => tool.destructive) ? "asks before deleting or overwriting" : "",
      tools.some((tool) => tool.leaves_machine) ? "sends data off this machine" : "",
      tools.some((tool) => tool.runs_programs) ? "runs programs" : "",
      scoped && !usable.length ? "withheld while folders are set"
        : scoped && usable.length < tools.length ? "some withheld while folders are set" : "",
    ].filter(Boolean);

    const row = new Setting(card).setName(name);
    const singles = card.createDiv({ cls: "obsidian-agent-tool-list" });
    const describe = (): void => {
      row.setDesc([mcpGroup && !scoped ? mcpCount() : `${on()} of ${usable.length} on`, ...marks].join(" · "));
    };
    let setGroup: (value: boolean) => void = () => {};
    const drawSingles = (): void => {
      singles.empty();
      singles.toggleClass("is-hidden", !unfolded.has(name));
      if (!unfolded.has(name)) return;
      for (const tool of tools) {
        const withheld = scoped && tool.ignores_scope;
        const viaAll = !withheld && covered(tool);
        const single = new Setting(singles).setName(tool.label ?? tool.name)
          .setDesc(viaAll ? `${tool.description} (On through "All MCP tools"; switching it off lists the other `
                            + "MCP tools one by one.)" : tool.description)
          .addToggle((toggle) => toggle
            .setValue(viaAll || draft.tools.includes(tool.name))
            .setDisabled(withheld)
            .onChange((value) => {
              if (viaAll) {
                if (!value) spellOut([tool.name]);
                return;
              }
              draft.tools = value ? [...draft.tools, tool.name] : draft.tools.filter((item) => item !== tool.name);
              touch();
              if (tool.name === ALL_MCP_TOOLS) {
                redraw();
                return;
              }
              describe();
              setGroup(usable.length > 0 && on() === usable.length);
            }));
        if (withheld) single.settingEl.addClass("is-disabled");
      }
    };
    row.addToggle((toggle) => {
      // Set from a single switch without re-running the group's own onChange, which would switch them all
      let quiet = false;
      setGroup = (value) => {
        quiet = true;
        toggle.setValue(value);
        quiet = false;
      };
      toggle.setValue(usable.length > 0 && on() === usable.length).setDisabled(!usable.length)
        .setTooltip("All of this group on or off")
        .onChange((value) => {
          if (quiet) return;
          const names = new Set(usable.map((tool) => tool.name));
          const others = draft.tools.filter((item) => !names.has(item));
          draft.tools = value ? [...others, ...usable.map((tool) => tool.name)] : others;
          touch();
          if (names.has(ALL_MCP_TOOLS)) {
            redraw();
            return;
          }
          describe();
          drawSingles();
        });
    });
    row.addExtraButton((button) => button
      .setIcon(unfolded.has(name) ? "chevron-down" : "chevron-right")
      .setTooltip("Show the single tools")
      .onClick(() => {
        if (unfolded.has(name)) unfolded.delete(name);
        else unfolded.add(name);
        button.setIcon(unfolded.has(name) ? "chevron-down" : "chevron-right");
        drawSingles();
      }));
    if (!usable.length) row.settingEl.addClass("is-disabled");
    describe();
    drawSingles();
  }

  // Names the catalog does not list (all MCP tools, say) are kept exactly as they are, not dropped by a save
  const known = new Set(catalog.map((tool) => tool.name));
  const other = draft.tools.filter((name) => !known.has(name));
  if (other.length) {
    card.createEl("p", { cls: "setting-item-description",
                         text: `Also listed in the file and kept as they are: ${other.join(", ")}.` });
  }
}

function numberSetting(container: HTMLElement, name: string, desc: string, value: number | null,
                       set: (value: number | null) => void, whole: boolean): void {
  new Setting(container).setName(name).setDesc(desc).addText((text) => {
    text.inputEl.type = "number";
    text.setValue(value === null ? "" : String(value)).onChange((input) => {
      const parsed = whole ? Number.parseInt(input, 10) : Number.parseFloat(input);
      set(input.trim() === "" || Number.isNaN(parsed) ? null : parsed);
    });
  });
}

/** Only what differs from the file, so a save never writes defaults into a file that left them out. */
function changedFields(agent: AgentDetail, draft: AgentFields): Partial<AgentFields> {
  const keys: (keyof AgentFields)[] = ["description", "tools", "vault_scope", "llm_profile", "max_iterations",
                                       "model", "temperature", "enable_thinking"];
  const changed: Partial<AgentFields> = {};
  for (const key of keys) {
    if (JSON.stringify(agent[key]) !== JSON.stringify(draft[key])) {
      (changed as Record<string, unknown>)[key] = draft[key];
    }
  }
  return changed;
}

function whereItSaves(agent: AgentDetail): string {
  if (agent.source === "bundled") {
    return "Built in. Saving keeps your version as your own copy; the built-in agent stays as it was.";
  }
  if (agent.can_reset) return `Your version of a built-in agent, in ${agent.path}.`;
  if (agent.source === "vault") return "In this vault's .agents folder.";
  return `In ${agent.path}.`;
}

/** The vault's folders to pick from — not dot folders, which hold Obsidian's and this app's own files. */
class FolderPicker extends FuzzySuggestModal<TFolder> {
  constructor(app: App, private readonly taken: string[], private readonly onPick: (folder: string) => void) {
    super(app);
    this.setPlaceholder("Which folder may the agent work in?");
  }

  override getItems(): TFolder[] {
    return this.app.vault.getAllLoadedFiles()
      .filter((file): file is TFolder => file instanceof TFolder && !file.isRoot())
      .filter((folder) => !folder.path.split("/").some((part) => part.startsWith(".")))
      .filter((folder) => !this.taken.includes(folder.path));
  }

  override getItemText(folder: TFolder): string {
    return folder.path;
  }

  override onChooseItem(folder: TFolder): void {
    this.onPick(folder.path);
  }
}

/** Ask for a name — for New and Duplicate. */
class NameModal extends Modal {
  constructor(app: App, private readonly heading: string, private readonly suggestion: string,
              private readonly onName: (name: string) => void) {
    super(app);
  }

  override onOpen(): void {
    this.titleEl.setText(this.heading);
    let name = this.suggestion;
    new Setting(this.contentEl).setName("Name")
      .setDesc("Lowercase letters, digits, dashes and underscores. Saved in this vault's .agents folder.")
      .addText((text) => text.setValue(name).onChange((value) => { name = value.trim(); }));
    new Setting(this.contentEl)
      .addButton((button) => button.setButtonText("Cancel").onClick(() => this.close()))
      .addButton((button) => button.setButtonText("Create").setCta().onClick(() => {
        this.close();
        this.onName(name);
      }));
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}
