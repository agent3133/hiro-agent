/**
 * The Features tab's MCP servers (#87, #61): list, add, edit, switch on and off, remove, test — and approve.
 *
 * A stdio server is a program started on this computer with the user's rights, and the settings sync with the
 * vault. So a stdio server runs only once approved on this device, for the exact command line shown; adding or
 * editing one shows that line and asks. A server that arrived by sync waits here, marked, until someone says yes.
 */

import { App, Modal, Notice, Setting, type SettingDefinitionGroup, type SettingGroupItem } from "obsidian";

import type { ConfigWriteResult } from "../api/types";
import { messageOf } from "../core/errors";
import { draftOf, emptyDraft, serverChange, type McpDraft } from "../mcp/draft";
import type { McpServerStatus, McpTest } from "../mcp/service";
import type { McpServerSpec } from "../mcp/servers";

export interface McpUiHost {
  app: App;
  status(): McpServerStatus[];
  test(name: string): Promise<McpTest>;
  approve(name: string): void;
  revoke(name: string): Promise<void>;
  save(values: Record<string, unknown>): Promise<ConfigWriteResult | null>;
  redraw(): void;
}

/** What the MCP servers are, said once above their list. */
const INTRO = "Tools from other programs and services (Model Context Protocol). An agent uses them when its tools "
  + "list them. A server that is a program on this computer runs only once approved on this device, for exactly the "
  + "command line shown. A key stays in Obsidian's keychain (Settings → Keychain): write ${its-name} in the "
  + "environment or a header.";

/** The MCP servers as one group: a row per server, and one to add another (#321). */
export function mcpGroup(host: McpUiHost): SettingDefinitionGroup {
  const servers = host.status();
  const taken = servers.map((one) => one.spec.name);
  const items: SettingGroupItem[] = [{ name: "What MCP servers are", desc: INTRO }];
  for (const server of servers) {
    items.push({
      name: server.spec.name,
      aliases: ["MCP", server.spec.transport === "stdio" ? server.commandLine : server.spec.url ?? ""],
      render: (setting) => { serverRow(setting, server, host, taken); },
    });
  }
  items.push({
    name: servers.length ? "Another server" : "No MCP servers yet",
    desc: "A program on this computer, or a service at an address.",
    render: (setting) => {
      setting.addButton((button) => button.setButtonText("Add server").onClick(() => openEditor(host, null, taken)));
    },
  });
  return { type: "group", heading: "MCP servers", items };
}

/** One server's row: where it runs or what it reaches, whether it is approved here, and what can be done to it. */
function serverRow(setting: Setting, server: McpServerStatus, host: McpUiHost, taken: string[]): void {
  const { spec } = server;
  const where = spec.transport === "stdio" ? server.commandLine : spec.url;
  setting.descEl.createEl("code", { text: where, cls: "obsidian-agent-mcp-command" });
  if (spec.transport === "stdio") {
    setting.descEl.createDiv({
      cls: server.approved ? "obsidian-agent-found" : "obsidian-agent-found mod-warning",
      text: server.approved ? "Approved to run on this device." : "Not approved on this device: it will not start.",
    });
  } else if (server.commandLine) {
    // It sends a key from the keychain: used only once approved here, for this address and these headers (#136)
    setting.descEl.createDiv({
      cls: server.approved ? "obsidian-agent-found" : "obsidian-agent-found mod-warning",
      text: server.approved ? "Approved on this device to receive the key it names."
        : "Not approved on this device: it would receive a key from your keychain, so it is not used.",
    });
  } else {
    setting.descEl.createDiv({ cls: "obsidian-agent-found", text: "Sends what the agent asks it to this address." });
  }
  const result = setting.descEl.createDiv({ cls: "obsidian-agent-mcp-result" });

  if (!server.approved) {
    setting.addButton((button) => button.setButtonText("Approve").setCta().onClick(() => {
      new ApproveModal(host.app, spec, server.commandLine, (yes) => {
        if (!yes) return;
        host.approve(spec.name);
        host.redraw();
      }).open();
    }));
  }
  setting.addButton((button) => button.setButtonText("Test").onClick(async () => {
    button.setDisabled(true);
    result.setText("Connecting…");
    const answer = await host.test(spec.name);
    button.setDisabled(false);
    result.toggleClass("mod-warning", !answer.ok);
    result.setText(answer.ok
      ? (answer.tools.length ? `${answer.tools.length} tools: ${answer.tools.map((tool) => tool.name).join(", ")}`
        : "Connected; it offers no tools (or the filter lets none through).")
      : answer.error);
  }));
  setting.addToggle((toggle) => toggle.setValue(spec.enabled).setTooltip("On or off, for every agent")
    .onChange(async (value) => {
      const saved = await host.save({ mcp_servers: { [spec.name]: { enabled: value } } });
      if (saved?.ok) return;
      toggle.setValue(!value);
      // A null result was already told as a notice by the save
      if (saved) {
        const reason = saved.fields.map((item) => item.message).join("; ") || saved.error || "refused";
        new Notice(`'${spec.name}' was not switched ${value ? "on" : "off"}: ${reason}`, 10_000);
      }
    }));
  setting.addExtraButton((button) => button.setIcon("pencil").setTooltip("Edit").onClick(() => {
    openEditor(host, spec, taken);
  }));
  setting.addExtraButton((button) => button.setIcon("trash").setTooltip("Remove").onClick(async () => {
    const saved = await host.save({ mcp_servers: { [spec.name]: null } });
    if (!saved?.ok) return;
    await host.revoke(spec.name);
    host.redraw();
  }));
}

/** The form; on save, a stdio server's command line is shown and must be allowed before it can run here. */
function openEditor(host: McpUiHost, previous: McpServerSpec | null, taken: string[]): void {
  new ServerModal(host.app, previous ? draftOf(previous) : emptyDraft(), previous !== null, async (draft) => {
    let change: Record<string, unknown>;
    try {
      change = serverChange(draft, previous, taken);
    } catch (error) {
      return messageOf(error);
    }
    const saved = await host.save(change);
    if (!saved) return "Not saved.";
    if (!saved.ok) return saved.fields.map((field) => `${field.path}: ${field.message}`).join("\n") || saved.error || "Not saved.";
    if (previous && previous.name !== draft.name.trim()) await host.revoke(previous.name);
    // As stored now; a stdio server whose command line is already approved here is not asked about again
    const stored = host.status().find((one) => one.spec.name === draft.name.trim());
    if (stored && !stored.approved) {
      const spec = stored.spec;
      new ApproveModal(host.app, spec, stored.commandLine, (yes) => {
        if (yes) host.approve(spec.name);
        else new Notice(`Hiro Agent: '${spec.name}' is saved, but is not used on this device until you approve it.`);
        host.redraw();
      }).open();
    } else {
      host.redraw();
    }
    return null;
  }).open();
}

/**
 * What will run — or where a key will go — word for word, and a yes that holds for this device only. Dismissing
 * is no.
 */
class ApproveModal extends Modal {
  private answered = false;

  constructor(app: App, private readonly spec: McpServerSpec, private readonly line: string,
              private readonly decide: (yes: boolean) => void) {
    super(app);
  }

  override onOpen(): void {
    const { contentEl } = this;
    const stdio = this.spec.transport === "stdio";
    this.setTitle(stdio ? `Allow '${this.spec.name}' to run on this computer?`
      : `Allow '${this.spec.name}' to receive a key from your keychain?`);
    contentEl.createEl("p", { text: stdio
      ? "This MCP server is a program. The agent starts it with your rights whenever an agent that lists its "
        + "tools needs it:"
      : "This MCP server is reached over the network, and its address or headers name a key from your keychain. "
        + "The key is sent there whenever an agent that lists its tools needs it:" });
    contentEl.createEl("pre", { text: this.line, cls: "obsidian-agent-confirm-detail" });
    contentEl.createEl("p", { cls: "setting-item-description", text: stdio
      ? "The approval is for this command line on this device only. If the command, its arguments or its "
        + "environment change — here or on another device — it is asked for again."
      : "The approval is for this address and these headers on this device only. If they change — here or on "
        + "another device — it is asked for again." });
    new Setting(contentEl)
      .addButton((button) => button.setButtonText("Cancel").onClick(() => this.answer(false)))
      .addButton((button) => button.setButtonText("Allow on this device").setDestructive().onClick(() => this.answer(true)));
  }

  override onClose(): void {
    this.contentEl.empty();
    if (!this.answered) this.decide(false);
  }

  private answer(yes: boolean): void {
    this.answered = true;
    this.decide(yes);
    this.close();
  }
}

/** One server's fields; *save* answers null when stored, or what to fix. */
class ServerModal extends Modal {
  constructor(app: App, private readonly draft: McpDraft, private readonly editing: boolean,
              private readonly save: (draft: McpDraft) => Promise<string | null>) {
    super(app);
  }

  override onOpen(): void {
    this.draw();
  }

  override onClose(): void {
    this.contentEl.empty();
  }

  private draw(): void {
    const { contentEl, draft } = this;
    contentEl.empty();
    this.setTitle(this.editing ? `MCP server '${draft.name}'` : "New MCP server");

    new Setting(contentEl).setName("Name").setDesc("Its tools are named name__tool in an agent's list.")
      .addText((text) => text.setValue(draft.name).onChange((value) => { draft.name = value; }));
    new Setting(contentEl).setName("Where it runs")
      .setDesc("A program this computer starts, with your rights (stdio), or a server reached at an address "
               + "(streamable HTTP).")
      .addDropdown((dropdown) => dropdown.addOption("stdio", "A program on this computer")
        .addOption("http", "A server at an address")
        .setValue(draft.transport).onChange((value) => {
          draft.transport = value === "http" ? "http" : "stdio";
          this.draw();
        }));
    if (draft.transport === "stdio") {
      new Setting(contentEl).setName("Command").setDesc("The program, e.g. npx, node, uvx, or a full path.")
        .addText((text) => text.setValue(draft.command).onChange((value) => { draft.command = value; }));
      area(contentEl, "Arguments", "One per line. ${vault_path} is this vault's folder.", draft.args,
           (value) => { draft.args = value; });
      area(contentEl, "Environment", "KEY=value, one per line; a key as KEY=${its-keychain-name}. The server gets "
           + "these, PATH and the like — nothing else of Obsidian's environment.", draft.env,
           (value) => { draft.env = value; });
    } else {
      new Setting(contentEl).setName("URL")
        .addText((text) => text.setPlaceholder("https://example.com/mcp").setValue(draft.url)
          .onChange((value) => { draft.url = value; }));
      area(contentEl, "Headers", "Name: value, one per line; a key as Authorization: Bearer ${its-keychain-name}.",
           draft.headers, (value) => { draft.headers = value; });
    }
    new Setting(contentEl).setName("Only these tools")
      .setDesc("Tool names as the server gives them, separated by commas. Empty: all of them.")
      .addText((text) => text.setValue(draft.toolsFilter).onChange((value) => { draft.toolsFilter = value; }));

    const problem = contentEl.createEl("p", { cls: "mod-warning obsidian-agent-mcp-problem" });
    new Setting(contentEl)
      .addButton((button) => button.setButtonText("Cancel").onClick(() => this.close()))
      .addButton((button) => button.setButtonText("Save").setCta().onClick(async () => {
        button.setDisabled(true);
        const refused = await this.save(draft);
        button.setDisabled(false);
        if (refused) problem.setText(refused);
        else this.close();
      }));
  }
}

function area(container: HTMLElement, name: string, description: string, value: string,
              onChange: (value: string) => void): void {
  new Setting(container).setName(name).setDesc(description).addTextArea((text) => {
    text.setValue(value).onChange(onChange);
    text.inputEl.rows = 4;
    text.inputEl.addClass("obsidian-agent-mcp-area");
  });
}
