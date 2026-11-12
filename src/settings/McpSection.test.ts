// @vitest-environment jsdom
// The MCP servers group on the Features tab (#87, on the obsidian stub): the rows, the add form, removing a server
// and approving one on this device. The group is Obsidian 1.13's declarative definition; the stub does not draw
// those, so `draw` does what Obsidian does with them: a Setting per item, its render called on that Setting.
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SettingDefinitionGroup } from "obsidian";

import type { ConfigWriteResult } from "../api/types";
import { commandLine, type McpServerSpec } from "../mcp/servers";
import type { McpServerStatus } from "../mcp/service";
import {
  App, ButtonComponent, buttonNamed, Notice, Setting, SettingGroup, settingNamed, settingsIn, type TextComponent,
} from "../testing/obsidian";

import { mcpGroup, type McpUiHost } from "./McpSection";

function spec(name: string, overrides: Partial<McpServerSpec> = {}): McpServerSpec {
  return {
    name, transport: "stdio", command: "npx", args: ["-y", "files"], env: {}, url: "", headers: {}, enabled: true,
    toolsFilter: ["*"], askFirst: {}, ...overrides,
  };
}

function status(one: McpServerSpec, approved: boolean): McpServerStatus {
  return { spec: one, commandLine: commandLine(one), approved };
}

function host(servers: McpServerStatus[] = [], overrides: Partial<McpUiHost> = {}): McpUiHost {
  return {
    app: new App(".") as never,
    status: vi.fn(() => servers),
    test: vi.fn(async () => ({ ok: true as const, tools: [] })),
    approve: vi.fn(),
    revoke: vi.fn(async () => undefined),
    save: vi.fn(async () => ({ ok: true, changed: [], fields: [] }) as ConfigWriteResult),
    redraw: vi.fn(),
    ...overrides,
  };
}

/** Draws the group on the page: a Setting per item, named and described, and its render called on it. */
function draw(group: SettingDefinitionGroup): HTMLElement {
  const container = document.body.appendChild(document.createElement("div"));
  for (const item of group.items ?? []) {
    const setting = new Setting(container);
    setting.setName(item.name);
    if (item.desc !== undefined) setting.setDesc(item.desc);
    if ("render" in item && item.render) item.render(setting as never, new SettingGroup(container) as never);
  }
  return container;
}

/** The Remove button on one server's row (an extra button, found by its tooltip). */
function removeButton(container: HTMLElement, name: string): ButtonComponent {
  const found = settingNamed(container, name).components.find((component): component is ButtonComponent =>
    component instanceof ButtonComponent && component.buttonEl.getAttribute("aria-label") === "Remove");
  if (!found) throw new Error(`no Remove button on '${name}'`);
  return found;
}

beforeEach(() => {
  Notice.shown = [];
  document.body.replaceChildren();
});

describe("the MCP servers group", () => {
  it("says there are no servers yet and offers to add one, which opens the server form", async () => {
    const h = host([]);
    const group = mcpGroup(h);
    expect(group.heading).toBe("MCP servers");
    const container = draw(group);
    expect(settingsIn(container).map((one) => one.nameEl.textContent))
      .toEqual(["What MCP servers are", "No MCP servers yet"]);
    await buttonNamed(container, "Add server").click();
    const form = document.body.lastElementChild as HTMLElement;
    expect(form.textContent).toContain("New MCP server");
    expect(settingNamed(form, "Name")).toBeDefined();
    expect(settingNamed(form, "Command")).toBeDefined();
  });

  it("saves a new local server with the name and command typed, through the host, and closes the form", async () => {
    const h = host([]);
    const container = draw(mcpGroup(h));
    await buttonNamed(container, "Add server").click();
    const form = document.body.lastElementChild as HTMLElement;
    await (settingNamed(form, "Name").components[0] as TextComponent).type("files");
    await (settingNamed(form, "Command").components[0] as TextComponent).type("npx");
    await buttonNamed(form, "Save").click();
    expect(h.save).toHaveBeenCalledWith({
      mcp_servers: { files: { transport: "stdio", enabled: true, tools_filter: ["*"], command: "npx", args: [], env: {} } },
    });
    expect(form.isConnected).toBe(false);
    expect(h.redraw).toHaveBeenCalled();
  });

  it("lists two servers by name, each with its state as the host reports it", () => {
    const h = host([status(spec("files"), true), status(spec("notes", { command: "uvx" }), false)]);
    const container = draw(mcpGroup(h));
    expect(settingsIn(container).map((one) => one.nameEl.textContent))
      .toEqual(["What MCP servers are", "files", "notes", "Another server"]);
    expect(settingNamed(container, "files").descEl.textContent).toContain("Approved to run on this device.");
    expect(settingNamed(container, "notes").descEl.textContent)
      .toContain("Not approved on this device: it will not start.");
  });

  it("removes a server through the host when Remove is clicked, and nothing more when the save is refused", async () => {
    const h = host([status(spec("files"), true)]);
    const container = draw(mcpGroup(h));
    await removeButton(container, "files").click();
    const question = document.body.lastElementChild as HTMLElement;
    expect(question.textContent).toContain("Remove files?");
    await buttonNamed(question, "Remove").click();
    await vi.waitFor(() => expect(h.redraw).toHaveBeenCalled());
    expect(h.save).toHaveBeenCalledWith({ mcp_servers: { files: null } });
    expect(h.revoke).toHaveBeenCalledWith("files");

    const refused = host([status(spec("files"), true)], {
      save: vi.fn(async () => ({ ok: false, changed: [], error: "refused", fields: [] }) as ConfigWriteResult),
    });
    const again = draw(mcpGroup(refused));
    await removeButton(again, "files").click();
    await buttonNamed(document.body.lastElementChild as HTMLElement, "Remove").click();
    await vi.waitFor(() => expect(refused.save).toHaveBeenCalledWith({ mcp_servers: { files: null } }));
    expect(refused.revoke).not.toHaveBeenCalled();
    expect(refused.redraw).not.toHaveBeenCalled();
  });

  it("removes nothing when the question is cancelled", async () => {
    const h = host([status(spec("files"), true)]);
    const container = draw(mcpGroup(h));
    await removeButton(container, "files").click();
    await buttonNamed(document.body.lastElementChild as HTMLElement, "Cancel").click();
    expect(h.save).not.toHaveBeenCalled();
    expect(h.revoke).not.toHaveBeenCalled();
  });

  it("shows the approval prompt for a server not yet approved here, and approving goes through the host", async () => {
    const h = host([status(spec("notes", { command: "uvx", args: ["mcp-notes"] }), false)]);
    const container = draw(mcpGroup(h));
    await buttonNamed(container, "Approve").click();
    const prompt = document.body.lastElementChild as HTMLElement;
    expect(prompt.textContent).toContain("Allow 'notes' to run on this computer?");
    expect(prompt.querySelector("pre")!.textContent).toBe("uvx mcp-notes");
    await buttonNamed(prompt, "Allow on this device").click();
    expect(h.approve).toHaveBeenCalledWith("notes");
    expect(h.redraw).toHaveBeenCalled();
  });
});
