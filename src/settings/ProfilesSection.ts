/**
 * Connections: the `llm_profiles` map, which the generated sections cannot draw because its keys are the user's.
 *
 * Add, remove, choose the default and test — the open half of #37 — and the one-click offer WP8 asks for: a llama.cpp
 * server answering on this machine that no connection points at yet is found and offered as one.
 *
 * Which connection a conversation uses stays the user's choice in the chat header. What is set here is the
 * list to choose from, and what is used when nothing is chosen.
 */

import { type App, Notice, type Setting, type SettingDefinitionGroup, type SettingGroupItem } from "obsidian";

import type { ConfigDocument } from "../api/types";
import { fieldItem, type ConfigHost } from "./ConfigSections";
import { ApprovalModal, ConnectionModal } from "./ConnectionModal";
import {
  addLocalServer, describeConnection, draftChange, draftOf, getVia, modelIds, modelsUrl, serverLabel, testVerdict,
  type ConnectionDraft, type LocalServer, type ProbeAnswer, type Profiles,
} from "./connections";
import { detectServer } from "../config/servers";
import { buildSection, profileSchema, type ConfigField } from "./schemaForm";

export interface ProfilesHost extends ConfigHost {
  /** For the dialogs this section opens. */
  app: App;
  /** GET a URL, with *headers* when given; null when nothing answers. */
  probe(url: string, headers?: Record<string, string>): Promise<ProbeAnswer | null>;
  /** Read the config again and describe the settings anew, after a change to the list itself. */
  redraw(): void;
  /** Where a connection's key goes and whether this device approved it; null when it sends no key (#136). */
  connectionApproval?(name: string): { what: string; approved: boolean } | null;
  approveConnection?(name: string): void;
  /** Obsidian's keychain (#147): the entries' names, and a value, which only a test on this device reads. */
  keychain?: { app: App; names(): string[]; value(name: string): string | undefined };
}

/** The fields of a connection the form edits; the rest of `LLMConfig` sits under "More" on its row. */
const CONNECTION_BASICS = ["provider", "base_url", "model", "api_key"];


/**
 * The connections as one group (#321): the default, a row per connection with its further settings on a page of its
 * own, the row to add one, and the local servers *found* that no connection points at yet. Drawing the add row
 * calls *lookForServers*, which lists what answers on this machine once it has.
 */
export function connectionGroup(doc: ConfigDocument, host: ProfilesHost, found: LocalServer[],
                                lookForServers: () => void): SettingDefinitionGroup {
  const profiles = (doc.values.llm_profiles ?? {}) as Profiles;
  const fallback = typeof doc.values.default_llm_profile === "string" ? doc.values.default_llm_profile : "";
  const names = Object.keys(profiles).sort((a, b) => a.localeCompare(b));
  const items: SettingGroupItem[] = [];

  if (names.length) {
    items.push({
      name: "Default connection",
      desc: "Used when a conversation does not pick one in the chat header.",
      render: (setting) => {
        setting.addDropdown((dropdown) => {
          if (!fallback) dropdown.addOption("", "None chosen yet");
          for (const name of names) dropdown.addOption(name, name);
          dropdown.setValue(fallback).onChange((value) => void apply(host, { default_llm_profile: value || null }));
        });
      },
    });
  }

  const entry = profileSchema(doc.schema);
  for (const name of names) {
    const values = profiles[name];
    items.push({
      name,
      desc: describeConnection(values),
      aliases: ["connection", ...[values.model, values.base_url].filter((value): value is string => typeof value === "string")],
      render: (setting) => { connectionRow(setting, name, values, names, fallback, host); },
    });
    // Sampling, limits, thinking: a page of their own under the row, each field saving on its own
    const section = buildSection(doc.schema, entry, values, ["llm_profiles", name]);
    const key = (field: ConfigField): string => field.path[field.path.length - 1];
    items.push({
      type: "page",
      name: `More for ${name}`,
      desc: "Sampling, context window, output length, reasoning, service tier, API.",
      items: [{ type: "group", items: section.fields.filter((item) => !CONNECTION_BASICS.includes(key(item)))
        .map((field) => fieldItem(field, host)) }],
    });
  }

  items.push({
    name: names.length ? "Another connection" : "Add a connection",
    desc: "A cloud API with a key from Obsidian's keychain, or a llama.cpp server.",
    render: (setting) => {
      lookForServers();
      setting.addButton((button) => (names.length ? button : button.setCta()).setButtonText("Add connection")
        .onClick(() => openForm(host, { name: names.length ? "" : "cloud", baseUrl: "", model: "", key: "" }, names,
                                null, fallback)));
    },
  });
  for (const server of found) {
    items.push({
      name: `Found: ${serverLabel(server)}`,
      desc: server.model ? `Serving ${server.model}. Nothing leaves this machine.` : "Nothing leaves this machine.",
      render: (setting) => {
        setting.addButton((button) => button.setButtonText(`Add as "${server.name}"`).setCta()
          .onClick(async () => apply(host, addLocalServer(server, fallback))));
      },
    });
  }
  return { type: "group", heading: "Connections", items };
}

/** A connection's row: what it is, what keeps it from being used, and Approve, Test, Edit and Remove. */
function connectionRow(row: Setting, name: string, values: Record<string, unknown>, names: string[], fallback: string,
                       host: ProfilesHost): void {
  // Which kind of server answers there, once it has said (#149): asked without a key, so nothing is sent
  if (typeof values.base_url === "string" && values.base_url.trim()) {
    void detectServer(values.base_url, getVia((url) => host.probe(url)), typeof values.model === "string" ? values.model : "")
      .then((facts) => { if (facts.kind) row.setDesc(describeConnection(values, facts.kind)); })
      .catch(() => undefined);
  }
  const draft = draftOf(name, values);
  // Warnings go below the description, which the server's kind may still replace
  const notes = row.infoEl.createDiv();
  // A key written out here is never used; the form shows it masked, so say it in words (#146)
  const writtenKey = typeof values.api_key === "string" ? values.api_key.trim() : "";
  if (writtenKey && !/^\$\{[^}]+\}$/.test(writtenKey)) {
    notes.createDiv({ cls: "obsidian-agent-found mod-warning",
      text: "Its API key is written out in the settings, and a key there is never used: open it and pick one "
            + "from the keychain." });
  } else if (draft.key && host.keychain && !host.keychain.names().includes(draft.key)) {
    notes.createDiv({ cls: "obsidian-agent-found mod-warning",
      text: `There is no entry '${draft.key}' in the keychain on this device, so it has no key.` });
  }
  const approval = host.connectionApproval?.(name);
  if (approval && !approval.approved) {
    // Its key and address came from settings this device has not approved — another device, or a version before
    // approvals: nothing is sent until someone here has looked (#136); asked in a dialog, as for MCP (#149)
    notes.createDiv({ cls: "obsidian-agent-found mod-warning",
      text: "Not approved on this device yet: the agent does not use it until you approve where its key goes." });
    row.addButton((button) => button.setButtonText("Approve").setCta().onClick(() => {
      new ApprovalModal(host.app,
        `Allow '${name}' to send its key?`,
        [`The connection ${approval.what}. Approve it only if you set this up, or trust whoever did.`,
         "The approval is for this address and this key on this device only; if either changes — here or on "
         + "another device — it is asked for again."],
        "", (yes) => {
          if (!yes) return;
          host.approveConnection?.(name);
          host.redraw();
        }).open();
    }));
  }
  row.addButton((button) => button.setButtonText("Test").onClick(async () => {
    button.setDisabled(true);
    const verdict = await testDraft(draft, host, !approval || approval.approved);
    new Notice(`${name}: ${verdict.text}`, 8_000);
    button.setDisabled(false);
  }));
  row.addExtraButton((button) => button.setIcon("pencil").setTooltip(`Edit ${name}`)
    .onClick(() => openForm(host, draft, names.filter((other) => other !== name), name, fallback)));
  row.addExtraButton((button) => button.setIcon("trash-2").setTooltip(`Remove ${name}`).onClick(async () => {
    // A default that names a removed connection would leave turns with nowhere to go, so it goes too
    const change: Record<string, unknown> = { llm_profiles: { [name]: null } };
    if (name === fallback) change.default_llm_profile = null;
    await apply(host, change);
  }));
}

/** The form, to add a connection (*previous* null) or change one. */
function openForm(host: ProfilesHost, draft: ConnectionDraft, taken: string[], previous: string | null,
                  fallback: string): void {
  const app = host.app;
  new ConnectionModal({
    app, taken,
    // A test from the form is made by the person filling it in, on this device: the key goes with it
    test: (current) => testDraft(current, host, true),
    save: async (current) => {
      const result = await host.save(draftChange(current, previous, fallback));
      if (!result) return "Not saved.";
      if (!result.ok) return result.fields.map((item) => item.message).join("; ") || result.error || "Not saved.";
      host.redraw();
      return null;
    },
  }, draft, previous !== null).open();
}

/**
 * Ask a connection for its models, with its key when *withKey* — what a message does, so a refused key shows here
 * rather than at the first message (#149). A connection this device has not approved is tested without its key.
 */
async function testDraft(draft: ConnectionDraft, host: ProfilesHost,
                         withKey: boolean): Promise<{ ok: boolean; text: string; models?: string[] }> {
  const url = modelsUrl(draft);
  let key: string | undefined;
  if (draft.key && withKey) {
    key = host.keychain?.value(draft.key);
    if (!key) return { ok: false, text: `There is no entry '${draft.key}' in the keychain on this device.` };
  }
  const answer = await host.probe(url, key ? { Authorization: `Bearer ${key}` } : undefined);
  const verdict: { ok: boolean; text: string; models?: string[] } = testVerdict(url, answer, Boolean(key));
  if (answer?.status === 200) {
    verdict.models = modelIds(answer.body);
    // Which kind of server it is, and the window it gives — what a message will use (#149)
    const facts = await detectServer(draft.baseUrl, getVia((address) => host.probe(address)), draft.model);
    if (facts.kind) {
      verdict.text += ` ${facts.kind}${facts.contextWindow ? `, context window ${facts.contextWindow.toLocaleString()} tokens` : ""}.`;
    }
    if (draft.model && verdict.models.length && !verdict.models.includes(draft.model)) {
      verdict.ok = false;
      verdict.text += ` It does not list the model ${draft.model}.`;
    }
  }
  if (draft.key && !withKey) verdict.text += " Tested without its key: approve the connection first.";
  return verdict;
}

/** Save a change to the list and draw it again; a refused change is shown rather than silently redrawn. */
async function apply(host: ProfilesHost, change: Record<string, unknown>): Promise<void> {
  const result = await host.save(change);
  if (!result) return;
  if (!result.ok) {
    new Notice(`Not saved: ${result.fields.map((item) => `${item.path}: ${item.message}`).join("; ") || result.error}`,
               10_000);
    return;
  }
  host.redraw();
}
