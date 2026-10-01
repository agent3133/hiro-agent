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
import { unusableTools } from "../config/agents";
import { messageOf } from "../core/errors";
import { ALL_MCP_TOOLS, displayName, isMcpToolName } from "../mcp/servers";
import { AskModal } from "../view/AskModal";
import { group } from "./layout";

export interface AgentsHost {
  app: App;
  /** The editor's state, kept by the settings tab across redraws (#181). */
  state: AgentsEditorState;
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

/**
 * Which agent the editor showed last, whether it holds unsaved changes, and the changes themselves — all survive a
 * redraw, which a save on another tab causes, so the edits are not lost on the way (#149). Owned by the settings
 * tab rather than kept in module variables, so a second settings window or a reload starts clean (#181).
 */
export class AgentsEditorState {
  selected = "";
  dirty = false;
  kept: { name: string; draft: AgentFields & { prompt: string } } | null = null;
  /** Saves the edits in the editor; set while an editor is drawn. */
  saveNow: (() => Promise<boolean>) | null = null;
  /** Tool groups unfolded to single switches; kept across redraws so fine-tuning does not fold away. */
  readonly unfolded = new Set<string>();

  /** The agent with unsaved edits, to ask about when the settings close; null when there are none. */
  unsaved(): { name: string; save(): Promise<boolean>; discard(): void } | null {
    if (!this.dirty || !this.kept || !this.saveNow) return null;
    const save = this.saveNow;
    return { name: this.kept.name, save, discard: () => { this.dirty = false; this.kept = null; } };
  }
}

const SOURCE_LABEL: Record<AgentSource, string> = {
  bundled: "built in",
  user: "yours",
  vault: "in this vault",
  other: "from an agents folder in the config",
};

export async function renderAgents(pane: HTMLElement, host: AgentsHost): Promise<void> {
  const state = host.state;
  const loading = pane.createEl("p", { cls: "setting-item-description", text: "Loading the agents…" });
  let catalog: ToolInfo[];
  try {
    catalog = await host.client.tools();
  } catch (error) {
    loading.setText(`Could not read the agents: ${messageOf(error)}`);
    return;
  }
  loading.remove();
  const agents = host.client.info()?.agents ?? [];
  const fallback = agents.find((agent) => agent.default)?.name ?? "";
  if (!agents.some((agent) => agent.name === state.selected)) {
    state.selected = fallback || agents[0]?.name || "";
    state.dirty = false;
    state.kept = null;
  }
  // Asked in Obsidian's own dialog, not window.confirm (#173); dismissing it keeps the changes
  const discard = (then: () => void, keep: () => void = () => {}): void => {
    if (!state.dirty) {
      then();
      return;
    }
    ask(host.app, `Discard the changes to ${state.selected}?`, "Your changes to this agent are not saved.", "Discard",
        (yes) => (yes ? then() : keep()));
  };

  const top = group(pane, "Agents", "An agent is a prompt, the tools it may use and the folders it may work in. "
                                    + "The built-in assistant works as it is: change an agent only to limit what it "
                                    + "may touch or how it answers.");
  new Setting(top)
    .setName("Default agent")
    .setDesc("Answers a conversation or command that does not pick an agent.")
    .addDropdown((dropdown) => {
      for (const agent of agents) dropdown.addOption(agent.name, agent.name);
      dropdown.setValue(fallback).onChange(async (name) => {
        if (await host.setDefault(name)) host.redraw();
      });
    });
  const picker = new Setting(top).setName("Agent").addDropdown((dropdown) => {
    for (const agent of agents) dropdown.addOption(agent.name, `${agent.name} (${SOURCE_LABEL[agent.source ?? "other"]})`);
    dropdown.setValue(state.selected).onChange((name) => discard(() => {
      state.selected = name;
      state.dirty = false;
      state.kept = null;
      host.redraw();
    }, () => dropdown.setValue(state.selected)));
  });
  picker.addButton((button) => button.setButtonText("New").onClick(() => discard(() => {
    new NameModal(host.app, "A new agent", "", (name) => void create(name, "", host)).open();
  })));
  const description = agents.find((agent) => agent.name === state.selected)?.description;
  if (description) picker.setDesc(description);

  if (state.selected) await renderEditor(pane, state.selected, catalog, host, picker);
}

async function create(name: string, from: string, host: AgentsHost): Promise<void> {
  const state = host.state;
  const result = await host.client.createAgent(name, from || undefined);
  if (!refused(result)) {
    state.selected = name;
    state.dirty = false;
    state.kept = null;
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
  const state = host.state;
  let agent: AgentDetail;
  try {
    agent = await host.client.agent(name);
  } catch (error) {
    pane.createEl("p", { cls: "setting-item-description", text: `Could not read ${name}: ${messageOf(error)}` });
    return;
  }
  // Unsaved edits of this agent from before a redraw carry on; otherwise the editor starts from the file
  const draft: AgentFields & { prompt: string } = state.dirty && state.kept?.name === name ? state.kept.draft : {
    description: agent.description, tools: [...agent.tools], vault_scope: [...agent.vault_scope],
    llm_profile: agent.llm_profile, max_iterations: agent.max_iterations, model: agent.model,
    temperature: agent.temperature, enable_thinking: agent.enable_thinking, prompt: agent.prompt,
  };
  state.kept = { name, draft };

  // Save and Discard at the top while there are changes, so they are in sight wherever the edit was (#149)
  const bar = new Setting(pane).setName(`Unsaved changes to ${name}`)
    .setDesc("Nothing is written until you save.");
  bar.settingEl.addClass("obsidian-agent-unsaved");
  bar.settingEl.toggleClass("is-hidden", !state.dirty);
  const touch = (): void => {
    state.dirty = true;
    bar.settingEl.removeClass("is-hidden");
  };
  const save = async (): Promise<boolean> => {
    const fields = changedFields(agent, draft);
    const change: { prompt?: string; fields?: Partial<AgentFields> } = {};
    if (Object.keys(fields).length) change.fields = fields;
    if (draft.prompt !== agent.prompt) change.prompt = draft.prompt;
    if (!change.fields && change.prompt === undefined) {
      new Notice("Nothing has changed.");
      state.dirty = false;
      state.kept = null;
      host.redraw();
      return true;
    }
    const result = await host.client.saveAgent(name, change);
    if (refused(result)) return false;
    state.dirty = false;
    state.kept = null;
    new Notice(`${name} is saved. It applies from the next message.`);
    await host.changed();
    host.redraw();
    return true;
  };
  const discardChanges = (): void => {
    state.dirty = false;
    state.kept = null;
    host.redraw();
  };
  state.saveNow = save;
  bar.addButton((button) => button.setButtonText("Discard changes").onClick(discardChanges));
  bar.addButton((button) => button.setButtonText("Save").setCta().onClick(() => void save()));

  // --- Actions on the whole agent sit with the picker ----------------------------------------------------------
  picker.addButton((button) => button.setButtonText("Duplicate").onClick(() => {
    new NameModal(host.app, `A copy of ${name}`, `${name}-copy`, (copy) => void create(copy, name, host)).open();
  }));
  if (agent.can_reset) {
    picker.addButton((button) => button.setButtonText("Reset").setTooltip("Use the built-in version again")
      .setWarning().onClick(() => ask(host.app, `Reset ${name}?`,
        `Your copy of ${name} is dropped, and the built-in one answers again.`, "Reset", async (yes) => {
        if (!yes) return;
        try {
          await host.client.resetAgent(name);
        } catch (error) {
          new Notice(`Not reset: ${messageOf(error)}`, 10_000);
          return;
        }
        state.dirty = false;
        state.kept = null;
        await host.changed();
        host.redraw();
      })));
  }
  if (agent.can_delete) {
    picker.addButton((button) => button.setButtonText("Delete").setWarning().onClick(() => ask(host.app,
      `Delete ${name}?`, `The agent's file is removed: ${agent.path}`, "Delete", async (yes) => {
      if (!yes) return;
      try {
        await host.client.deleteAgent(name);
      } catch (error) {
        new Notice(`Not deleted: ${messageOf(error)}`, 10_000);
        return;
      }
      state.selected = "";
      state.dirty = false;
      state.kept = null;
      await host.changed();
      host.redraw();
    })));
  }

  // --- What it is --------------------------------------------------------------------------------------------
  const about = group(pane, "Prompt", whereItSaves(agent));
  const description = new Setting(about).setName("Description").setDesc("Shown in the agent pickers.")
    .addText((text) => text.setValue(draft.description ?? "").onChange((value) => {
      draft.description = value.trim() || null;
      touch();
    }));
  description.settingEl.addClass("obsidian-agent-wide-text");
  const prompt = about.createEl("textarea", { cls: "obsidian-agent-prompt" });
  prompt.rows = 12;
  prompt.spellcheck = false;
  prompt.value = draft.prompt;
  prompt.addEventListener("input", () => { draft.prompt = prompt.value; touch(); });
  about.createEl("p", {
    cls: "setting-item-description obsidian-agent-prompt-hint",
    text: `Filled in for each message: ${agent.variables.map((variable) => `{{ ${variable} }}`).join(", ")}.`,
  });

  // --- Where it may work, and with what ----------------------------------------------------------------------
  const folders = group(pane, "Folders", "Empty: the whole vault. Set: the agent's note tools refuse every note "
                                         + "outside these folders, whatever the prompt or a note says.");
  const toolsSlot = pane.createDiv();
  const drawTools = (): void => {
    toolsSlot.empty();
    renderTools(toolsSlot, draft, catalog, touch, drawTools, state.unfolded);
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
  numberSetting(running, "Step limit", "Tool calls for one message before the agent has to answer. Empty uses 50.",
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
  actions.addButton((button) => button.setButtonText("Save").setCta().onClick(() => void save()));
  actions.addButton((button) => button.setButtonText("Discard changes").onClick(discardChanges));
}

/**
 * The tools as one switch per group, each unfolding to its tools. What a group does — delete, leave the machine,
 * run programs — is said once on the group. With folders set, the tools that could reach past them are greyed
 * out: they are withheld from a folder-restricted agent, and the card says so.
 */
function renderTools(slot: HTMLElement, draft: AgentFields, catalog: ToolInfo[], touch: () => void,
                     redraw: () => void, unfolded: Set<string>): void {
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

  // Listed but not usable now: say so, rather than let the list promise what the turn ignores (#146)
  const { missing, unreachable } = unusableTools(draft.tools, catalog.map((tool) => tool.name));
  if (missing.length || unreachable.length) {
    const note = new Setting(card).setName("Listed, but not usable now").setDesc([
      missing.length ? `Not tools of this plugin (left from an older version), so ignored: ${missing.join(", ")}.` : "",
      // Not in the list: a server that is off, or one this device has not listed yet — the tab starts none (#178)
      unreachable.length ? `From MCP servers that are off, or not listed on this device yet — Test them under `
        + `Features → MCP servers: ${unreachable.map(displayName).join(", ")}.` : "",
    ].filter(Boolean).join(" "));
    note.descEl.addClass("mod-warning");
    if (missing.length) {
      note.addButton((button) => button.setButtonText("Remove them").onClick(() => {
        draft.tools = draft.tools.filter((tool) => !missing.includes(tool));
        touch();
        redraw();
      }));
    }
  }

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
      ...[...new Set(tools.map((tool) => tool.off_in).filter(Boolean))].map((label) => `${label} is off in Features`),
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
        const off = tool.off_in ? ` (Off in Features → ${tool.off_in}: not offered to the model until that is `
          + "switched on. The agent keeps it in its list.)" : "";
        const single = new Setting(singles).setName(tool.label ?? tool.name)
          .setDesc(viaAll ? `${tool.description} (On through "All MCP tools"; switching it off lists the other `
                            + "MCP tools one by one.)" : `${tool.description}${off}`)
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
        if (withheld || tool.off_in) single.settingEl.addClass("is-disabled");
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
                         text: `Also listed in the file and state.kept as they are: ${other.join(", ")}.` });
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

/** A yes/no question in Obsidian's own dialog; dismissing it is no. */
function ask(app: App, title: string, body: string, confirm: string, decide: (yes: boolean) => void): void {
  new AskModal(app, { title, body, confirm }, decide).open();
}
