// @vitest-environment jsdom
// The agent commands on the obsidian stub (#420): "Ask <agent>…" opens the request box about the note that is open,
// sends that note as context when Include is on and without it when off, and asks without a note when none is open.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentSummary } from "../api/types";
import { buttonNamed, makeApp, Notice, Plugin, settingNamed, type TestApp, type TFile } from "../testing/obsidian";

import { AgentCommands, type CommandHost } from "./AgentCommands";
import type { NoteContext } from "./context";

const HIRO: AgentSummary = { name: "Hiro", description: "The default helper" };

/** A plugin that keeps the commands it registers, so a test can run one as Obsidian would. */
class CapturingPlugin extends Plugin {
  commands: { id: string; name: string; callback?: () => void }[] = [];
  override addCommand(command: { id: string; name: string; callback?: () => void }): unknown {
    this.commands.push(command);
    return command;
  }
}

let t: TestApp;

beforeEach(async () => {
  document.body.replaceChildren();
  Notice.shown = [];
  t = await makeApp({ "Notes/Alpha.md": "Some text\n" });
});

afterEach(async () => {
  await t.cleanup();
});

/** The commands for the vault, with *activeFile* as the note that is open (null: none), and the host's run spied. */
function commandsWith(activeFile: TFile | null): {
  command: { id: string; name: string; callback?: () => void };
  run: ReturnType<typeof vi.fn<(agent: string, message: string, context: NoteContext | undefined) => Promise<void>>>;
} {
  (t.app.workspace as unknown as { getActiveFile: () => TFile | null }).getActiveFile = () => activeFile;
  const plugin = new CapturingPlugin(t.app);
  const run = vi.fn<(agent: string, message: string, context: NoteContext | undefined) => Promise<void>>(async () => undefined);
  const host: CommandHost = { agents: () => [HIRO], defaultAgent: () => HIRO.name, run };
  const commands = new AgentCommands(plugin as never, host);
  commands.sync();
  const command = plugin.commands.find((c) => c.id === "ask-with-Hiro");
  if (!command) throw new Error("no command for Hiro was registered");
  return { command, run };
}

/** The request box the command opened: its content element, or null when none is open. */
function requestBox(): HTMLElement | null {
  return document.querySelector<HTMLElement>(".obsidian-agent-request");
}

function requestInput(): HTMLTextAreaElement {
  return requestBox()!.querySelector("textarea")!;
}

describe("the Ask command about the open note", () => {
  it("opens the request box for the agent, with the open note's name in its Include box", () => {
    const { command } = commandsWith(t.app.vault.getFileByPath("Notes/Alpha.md"));
    command.callback!();
    expect(requestBox()).not.toBeNull();
    expect(requestBox()!.previousElementSibling?.textContent).toBe("Ask Hiro");
    expect(settingNamed(requestBox()!, 'Include "Alpha"').components).toHaveLength(1);
  });

  it("sends the message with the open note as active_note when Include is on", async () => {
    const { command, run } = commandsWith(t.app.vault.getFileByPath("Notes/Alpha.md"));
    command.callback!();
    requestInput().value = "Summarise it";
    await buttonNamed(requestBox()!, "Ask").click();
    expect(run).toHaveBeenCalledExactlyOnceWith("Hiro", "Summarise it", { active_note: "Notes/Alpha.md" });
  });

  it("sends the message without any context when Include is unticked", async () => {
    const { command, run } = commandsWith(t.app.vault.getFileByPath("Notes/Alpha.md"));
    command.callback!();
    await (settingNamed(requestBox()!, 'Include "Alpha"').components[0] as { type(on: boolean): Promise<void> }).type(false);
    requestInput().value = "Just this";
    await buttonNamed(requestBox()!, "Ask").click();
    expect(run).toHaveBeenCalledExactlyOnceWith("Hiro", "Just this", undefined);
  });

  // An agent can be asked without a note (a daily-note agent needs none): the box opens without an Include choice
  it("with no note open, opens the request box without an Include box", () => {
    const { command, run } = commandsWith(null);
    command.callback!();
    expect(requestBox()).not.toBeNull();
    expect(requestBox()!.textContent).not.toContain("Include");
    expect(run).not.toHaveBeenCalled();
  });

  it("with no note open, sends the message without any context", async () => {
    const { command, run } = commandsWith(null);
    command.callback!();
    requestInput().value = "What is due today?";
    await buttonNamed(requestBox()!, "Ask").click();
    expect(run).toHaveBeenCalledExactlyOnceWith("Hiro", "What is due today?", undefined);
    expect(Notice.shown).toHaveLength(0);
  });
});
