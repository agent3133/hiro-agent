// @vitest-environment jsdom
// Creating an agent in the Agents tab (#368, on the obsidian stub): New asks for a name, and the agent is created
// through the backend — the create path, which once broke while editing worked (#343).
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  App, buttonNamed, DropdownComponent, ExtraButtonComponent, Notice, settingNamed, type TextComponent,
} from "../testing/obsidian";

import { AgentsEditorState, renderAgents, type AgentsHost } from "./AgentsTab";

function makeHost(createAgent: AgentsHost["client"]["createAgent"]): AgentsHost {
  return {
    app: new App(".") as never,
    state: new AgentsEditorState(),
    client: {
      tools: vi.fn(async () => []),
      info: vi.fn(() => ({ agents: [] })),
      createAgent,
      agent: vi.fn(),
      resetAgent: vi.fn(),
      deleteAgent: vi.fn(),
      saveAgent: vi.fn(),
    } as unknown as AgentsHost["client"],
    profiles: [],
    changed: vi.fn(async () => undefined),
    setDefault: vi.fn(async () => true),
    redraw: vi.fn(),
    preview: vi.fn(),
  };
}

/** Click New, type *name* into the dialog and click Create; wait for what Create started. */
async function createThroughTheTab(host: AgentsHost, name: string): Promise<void> {
  const pane = document.createElement("div");
  await renderAgents(pane, host);
  await buttonNamed(pane, "New").click();
  const dialog = document.body.lastElementChild as HTMLElement;
  expect(dialog.textContent).toContain("A new agent");
  await (settingNamed(dialog, "Name").components[0] as TextComponent).type(name);
  await buttonNamed(dialog, "Create").click();
  await vi.waitFor(() => expect(host.client.createAgent).toHaveBeenCalled());
  await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  Notice.shown = [];
  document.body.replaceChildren();
});

describe("the Agents tab's New", () => {
  it("creates the agent under the name typed, selects it, and tells the chat and the tab", async () => {
    const host = makeHost(vi.fn(async () => ({ ok: true, fields: [] })) as never);
    await createThroughTheTab(host, " helper ");
    expect(host.client.createAgent).toHaveBeenCalledWith("helper", undefined);
    expect(host.state.selected).toBe("helper");
    expect(host.changed).toHaveBeenCalled();
    expect(host.redraw).toHaveBeenCalled();
    // The dialog is gone
    expect(document.body.textContent).not.toContain("A new agent");
  });

  it("says why a name was refused, field by field, and selects nothing", async () => {
    const host = makeHost(vi.fn(async () => ({ ok: false, error: "invalid",
                                               fields: [{ path: "name", message: "already taken" }] })) as never);
    await createThroughTheTab(host, "assistant");
    expect(Notice.shown).toContain("Not saved.\nname: already taken");
    expect(host.state.selected).toBe("");
    expect(host.changed).not.toHaveBeenCalled();
  });
});

const AGENTS = [
  { name: "assistant", default: true, source: "bundled" },
  { name: "helper", source: "vault" },
];

/** The host's client lists AGENTS, and answers a minimal agent for any name, so the editor draws. */
function withAgents(host: AgentsHost): AgentsHost {
  host.client.info = vi.fn(() => ({ agents: AGENTS })) as never;
  host.client.agent = vi.fn(async (name: string) => ({
    name, description: null, tools: [], vault_scope: [], llm_profile: null, max_iterations: null, model: null,
    temperature: null, enable_thinking: null, prompt: "", variables: [], source: "vault",
    path: `.agents/${name}.md`, can_reset: false, can_delete: false,
  })) as never;
  return host;
}

function defaultAgentDropdown(pane: HTMLElement): DropdownComponent {
  return settingNamed(pane, "Default agent").components[0] as DropdownComponent;
}

describe("the Agents tab's Default agent", () => {
  it("offers every agent and shows the default one", async () => {
    const host = withAgents(makeHost(vi.fn() as never));
    const pane = document.createElement("div");
    await renderAgents(pane, host);
    const dropdown = defaultAgentDropdown(pane);
    expect([...dropdown.selectEl.options].map((option) => option.value)).toEqual(["assistant", "helper"]);
    expect(dropdown.getValue()).toBe("assistant");
  });

  it("choosing another agent sets it as the default, then draws the tab again", async () => {
    const host = withAgents(makeHost(vi.fn() as never));
    const pane = document.createElement("div");
    await renderAgents(pane, host);
    const dropdown = defaultAgentDropdown(pane);
    dropdown.selectEl.value = "helper";
    dropdown.selectEl.dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(host.redraw).toHaveBeenCalled());
    expect(host.setDefault).toHaveBeenCalledWith("helper");
  });

  it("does not draw the tab again when the default was not set", async () => {
    const host = withAgents(makeHost(vi.fn() as never));
    host.setDefault = vi.fn(async () => false);
    const pane = document.createElement("div");
    await renderAgents(pane, host);
    const dropdown = defaultAgentDropdown(pane);
    dropdown.selectEl.value = "helper";
    dropdown.selectEl.dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(host.setDefault).toHaveBeenCalledWith("helper"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(host.redraw).not.toHaveBeenCalled();
  });
});

describe("an MCP tool's Ask first in the Agents tab (#403)", () => {
  it("shows an MCP tool that runs without asking, and its button sets Ask first for it, then draws the tab again", async () => {
    const host = withAgents(makeHost(vi.fn() as never));
    host.client.tools = vi.fn(async () => [
      { name: "srv__search", label: "srv: search", description: "Searches the server.", group: "MCP",
        destructive: false, leaves_machine: true, runs_programs: false, ignores_scope: true },
    ]) as never;
    host.setAskFirst = vi.fn(async () => true);
    host.state.unfolded.add("MCP");
    const pane = document.createElement("div");
    await renderAgents(pane, host);

    const single = settingNamed(pane, "srv: search");
    expect(single.descEl.textContent).toContain("Runs without asking.");
    // The switch comes first, then the Ask first button
    const askFirst = single.components[1];
    expect(askFirst).toBeInstanceOf(ExtraButtonComponent);
    await (askFirst as ExtraButtonComponent).click();
    await vi.waitFor(() => expect(host.redraw).toHaveBeenCalled());
    expect(host.setAskFirst).toHaveBeenCalledWith("srv", "search", true);
  });
});
