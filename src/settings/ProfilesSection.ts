/**
 * Connections: the `llm_profiles` map, which the generated sections cannot draw because its keys are the user's.
 *
 * Add, remove, choose the default and test — the open half of #37 — and the one-click offer WP8 asks for: a llama.cpp
 * server answering on this machine that no connection points at yet is found and offered as one.
 *
 * Which connection a conversation uses stays the user's choice in the chat header. What is set here is the
 * list to choose from, and what is used when nothing is chosen.
 */

import { Notice, Setting } from "obsidian";

import type { ConfigDocument } from "../api/types";
import { renderField, type ConfigHost } from "./ConfigSections";
import { addLocalServer, findLocalServers, modelId, type ProbeAnswer, type Profiles } from "./connections";
import { group } from "./layout";
import { buildSection, profileSchema, type ConfigField } from "./schemaForm";

export interface ProfilesHost extends ConfigHost {
  /** GET a URL without credentials; null when nothing answers. */
  probe(url: string): Promise<ProbeAnswer | null>;
  /** Fetch the config again and draw the tab anew, after a change to the list itself. */
  redraw(): void;
}


const NAME = /^[A-Za-z0-9_-]{1,40}$/;

/** The fields of a connection most people set; the rest of `LLMConfig` sits under "More settings". */
const CONNECTION_BASICS = ["provider", "base_url", "model", "api_key"];

export function renderProfiles(container: HTMLElement, doc: ConfigDocument, host: ProfilesHost): void {
  const profiles = (doc.values.llm_profiles ?? {}) as Profiles;
  const fallback = typeof doc.values.default_llm_profile === "string" ? doc.values.default_llm_profile : "";
  const names = Object.keys(profiles).sort((a, b) => a.localeCompare(b));

  container = group(container, "Connections",
                    "Where the agent sends your notes. A cloud connection sends what the agent reads to that provider.");

  if (names.length) {
    new Setting(container)
      .setName("Default connection")
      .setDesc("Used when a conversation does not pick one in the chat header.")
      .addDropdown((dropdown) => {
        if (!fallback) dropdown.addOption("", "none — the Advanced llm block");
        for (const name of names) dropdown.addOption(name, name);
        dropdown.setValue(fallback).onChange((value) => void apply(host, { default_llm_profile: value || null }));
      });
  }

  const entry = profileSchema(doc.schema);
  for (const name of names) {
    const values = profiles[name];
    const where = [values.provider ?? "openai", values.model ?? "model from the server", values.base_url ?? "provider's own URL"]
      .map(String).join(" · ");
    const row = new Setting(container).setName(name).setDesc(where);
    const details = container.createEl("details", { cls: "obsidian-agent-connection" });
    details.createEl("summary", { text: "Edit" });
    row.addButton((button) => button.setButtonText("Test").onClick(async () => {
      button.setDisabled(true);
      new Notice(`${name}: ${await testConnection(values, host)}`, 8_000);
      button.setDisabled(false);
    }));
    row.addExtraButton((button) => button.setIcon("pencil").setTooltip(`Edit ${name}`)
      .onClick(() => { details.open = !details.open; }));
    row.addExtraButton((button) => button.setIcon("trash-2").setTooltip(`Remove ${name}`).onClick(async () => {
      // A default that names a removed connection would leave turns with nowhere to go, so it goes too
      const change: Record<string, unknown> = { llm_profiles: { [name]: null } };
      if (name === fallback) change.default_llm_profile = null;
      await apply(host, change);
    }));

    const body = details.createDiv();
    const section = buildSection(doc.schema, entry, values, ["llm_profiles", name]);
    const key = (field: ConfigField): string => field.path[field.path.length - 1];
    for (const field of section.fields.filter((item) => CONNECTION_BASICS.includes(key(item)))) {
      renderField(body, field, host);
    }
    const more = body.createEl("details", { cls: "obsidian-agent-config-section" });
    more.createEl("summary", { text: "More settings" });
    const moreBody = more.createDiv();
    for (const field of section.fields.filter((item) => !CONNECTION_BASICS.includes(key(item)))) {
      renderField(moreBody, field, host);
    }
  }

  renderAdd(container, profiles, fallback, host);
  void renderDetected(container, profiles, fallback, host);
}

function renderAdd(container: HTMLElement, profiles: Profiles, fallback: string, host: ProfilesHost): void {
  let name = "";
  new Setting(container)
    .setName("Add a connection")
    .setDesc("Letters, digits, dashes and underscores. Set its provider, URL and model under Edit afterwards.")
    .addText((text) => text.setPlaceholder("cloud").onChange((value) => { name = value.trim(); }))
    .addButton((button) => button.setButtonText("Add").onClick(async () => {
      if (!NAME.test(name)) {
        new Notice("A connection name is letters, digits, dashes and underscores.");
        return;
      }
      if (name in profiles) {
        new Notice(`There is already a connection called ${name}.`);
        return;
      }
      const change: Record<string, unknown> = { llm_profiles: { [name]: { provider: "openai" } } };
      if (!fallback) change.default_llm_profile = name;
      await apply(host, change);
    }));
}

/** Offer each local llama.cpp server that answers and that no connection points at yet. */
async function renderDetected(container: HTMLElement, profiles: Profiles, fallback: string,
                              host: ProfilesHost): Promise<void> {
  const slot = container.createDiv();
  for (const server of await findLocalServers(profiles, (url) => host.probe(url))) {
    new Setting(slot)
      .setName(`Found a llama.cpp server on 127.0.0.1:${server.port}`)
      .setDesc(server.model ? `Serving ${server.model}. Nothing leaves this machine.` : "Nothing leaves this machine.")
      .addButton((button) => button.setButtonText(`Add as "${server.name}"`).setCta()
        .onClick(async () => apply(host, addLocalServer(server, fallback))));
  }
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

/**
 * Whether a connection answers — not whether it works end to end. The test sends no API key (the agent reads
 * it from the keychain only when a turn needs it), so a server that wants one answers 401 here, which still proves
 * the URL is right.
 */
async function testConnection(values: Record<string, unknown>, host: ProfilesHost): Promise<string> {
  const llamacpp = values.provider === "llamacpp";
  const base = typeof values.base_url === "string" && values.base_url
    ? values.base_url.replace(/\/+$/, "")
    : llamacpp ? "" : "https://api.openai.com/v1";
  if (!base) return "no URL set — a llama.cpp connection needs its server's address.";
  const url = llamacpp && !base.endsWith("/v1") ? `${base}/v1/models` : `${base}/models`;
  const answer = await host.probe(url);
  if (!answer) return `nothing answered at ${url}.`;
  if (answer.status === 200) {
    const model = modelId(answer.body);
    return model ? `answers, serving ${model}.` : "answers.";
  }
  if (answer.status === 401 || answer.status === 403) {
    return "answers and wants its key — the agent sends it, this test does not.";
  }
  return `answered ${answer.status} at ${url}.`;
}
