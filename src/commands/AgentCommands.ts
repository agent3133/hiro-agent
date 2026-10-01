/**
 * The agent's commands: one per agent, "Ask an agent…", and "Ask about the selection" (also in the editor's
 * right-click menu). Obsidian shows each as "Hiro Agent: …" — the prefix is the plugin's name, added by Obsidian.
 *
 * Every one of them opens the request box first and then runs in a new conversation in the chat view, so tool
 * calls, confirmations and undo work exactly as they do when typing there. No hotkeys are set by default; any
 * command can be given one in Obsidian's Hotkeys settings.
 */

import { Notice, Plugin } from "obsidian";

import type { AgentSummary } from "../api/types";
import { AgentPicker } from "./AgentPicker";
import { buildContext, MAX_SELECTION, type NoteContext } from "./context";
import { RequestModal } from "./RequestModal";

export interface CommandHost {
  /** The agents this vault has: the built-in ones and its `.agents/`. */
  agents(): AgentSummary[];
  /** The agent that answers when none is chosen, as the settings say. */
  defaultAgent(): string;
  /** Start a new conversation in the chat view and send this. */
  run(agent: string, message: string, context: NoteContext | undefined): Promise<void>;
}

/**
 * Per-agent command ids carry this prefix, so they cannot collide with the fixed ones. No id holds the plugin's id
 * (`agent`): Obsidian adds it in front of every command's id (#108).
 */
const PER_AGENT = "ask-with-";

export class AgentCommands {
  private readonly registered = new Set<string>();

  constructor(private readonly plugin: Plugin, private readonly host: CommandHost) {}

  /** The commands that do not depend on which agents there are. */
  registerFixed(): void {
    this.plugin.addCommand({
      id: "ask",
      name: "Ask an agent…",
      callback: () => this.pick(),
    });
    this.plugin.addCommand({
      id: "ask-about-selection",
      name: "Ask about the selection",
      editorCheckCallback: (checking, editor) => {
        const selection = editor.getSelection();
        if (checking) return selection.trim().length > 0;
        this.ask(this.host.defaultAgent(), selection);
        return true;
      },
    });
    this.plugin.registerEvent(this.plugin.app.workspace.on("editor-menu", (menu, editor) => {
      const selection = editor.getSelection();
      if (!selection.trim()) return;
      menu.addItem((item) => item
        .setTitle("Ask the agent about this")
        .setIcon("bot")
        .onClick(() => this.ask(this.host.defaultAgent(), selection)));
    }));
  }

  /**
   * One command per agent there is now. Called after the agents change: an agent that went away loses its
   * command, and a new one gains it.
   */
  sync(): void {
    const agents = this.host.agents();
    const wanted = new Map(agents.map((agent) => [`${PER_AGENT}${agent.name}`, agent]));
    for (const id of [...this.registered]) {
      if (wanted.has(id)) continue;
      this.plugin.removeCommand(id);
      this.registered.delete(id);
    }
    for (const [id, agent] of wanted) {
      if (this.registered.has(id)) continue;
      this.plugin.addCommand({ id, name: `Ask ${agent.name}…`, callback: () => this.ask(agent.name) });
      this.registered.add(id);
    }
  }

  private pick(): void {
    const agents = this.host.agents();
    if (!agents.length) {
      // Only before the agents are read, just after Obsidian starts (#171)
      new Notice("Hiro Agent: the agents are not loaded yet. Try again in a moment.");
      return;
    }
    new AgentPicker(this.plugin.app, agents, (agent) => this.ask(agent.name)).open();
  }

  /** Open the request box for *agent*, about the active note and whatever is selected in it. */
  ask(agent: string, selection = this.currentSelection()): void {
    if (!this.host.agents().some((known) => known.name === agent)) {
      // A command left from an agent that is gone, on an Obsidian too old to remove it — or no runtime at all
      new Notice(this.host.agents().length
        ? `There is no agent called ${agent} any more.`
        : "There are no agents. Check Settings → Hiro Agent → Agents.");
      return;
    }
    const file = this.plugin.app.workspace.getActiveFile();
    const notePath = file?.path ?? "";
    new RequestModal(this.plugin.app,
                     { agent, noteName: file?.basename ?? "", hasSelection: selection.trim().length > 0 },
                     ({ message, include }) => {
      const built = buildContext(notePath, selection, include);
      if (built.truncated) new Notice(`The selection was long; the agent gets its first ${MAX_SELECTION} characters.`);
      void this.host.run(agent, message, built.context);
    }).open();
  }

  private currentSelection(): string {
    return this.plugin.app.workspace.activeEditor?.editor?.getSelection() ?? "";
  }
}
