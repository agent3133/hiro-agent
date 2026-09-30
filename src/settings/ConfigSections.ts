/**
 * Drawing config fields, and the generated "Advanced" part of the settings tab.
 *
 * The first tabs show a few chosen settings (see `BasicSections.ts`); everything else in `config.yaml` is
 * generated here from the runtime's schema, on the Advanced tab. Generating it keeps a field added in Python
 * reachable without any TypeScript; its own tab keeps it from being the first thing anyone sees.
 *
 * Each field saves on its own when it loses focus — not per keystroke, which would write the file and reload
 * the runtime's config once per character. A refused value keeps the runtime's own message next to the field,
 * and a change the running process cannot apply says so.
 */

import { Notice, Setting } from "obsidian";

import type { ConfigDocument, ConfigWriteResult } from "../api/types";
import {
  acceptsSecret, buildSection, display, isEmpty, nest, parseInput, type ConfigField, type ConfigSection,
} from "./schemaForm";
import { group } from "./layout";

export interface ConfigHost {
  /** Send a partial change; null when it could not be saved (already reported to the user). */
  save(values: Record<string, unknown>): Promise<ConfigWriteResult | null>;
}

/** Headings that say what a block is for, where its key alone would not. */
const TITLES: Record<string, string> = {
  llm: "Connection without a profile",
  vault: "Vault",
  agents: "Agent folders",
  tools: "Tool folders",
  builtin_tools: "Web tools",
  external_tools: "External tools",
  memory: "Memory",
  journal: "Undo",
  audio: "Audio transcription",
};

/**
 * Never generated: the connections and the MCP servers have their own editors, the vault is whichever one
 * Obsidian has open, and `ui` only styles the terminal REPL. The runtime's agent and tool folders and its external
 * programs do nothing in the plugin, which takes agents from `.agents/` and runs no shell (decided 2026-09-29).
 */
const NEVER = ["llm_profiles", "default_llm_profile", "mcp_servers", "vault.path", "ui", "agents", "tools",
               "external_tools"];

/** Everything not already shown on the other tabs, one card per block. `shown` holds those fields' paths. */
export function renderAdvanced(pane: HTMLElement, doc: ConfigDocument, host: ConfigHost, shown: string[]): void {
  const root = buildSection(doc.schema, doc.schema, doc.values, [], new Set([...NEVER, ...shown]));
  group(pane, undefined, `Everything else in ${doc.path}. An empty field uses the default.`);
  for (const section of root.sections) renderSection(pane, section, host);
}

/**
 * A block of the config as a card, and each nested block as its own card after it ("External tools · Shell"),
 * since a card inside a card reads as a mistake.
 */
export function renderSection(pane: HTMLElement, section: ConfigSection, host: ConfigHost, parent?: string): void {
  if (isEmpty(section)) return;
  const key = section.path[section.path.length - 1];
  const title = parent ? `${parent} · ${section.title}` : TITLES[key] ?? section.title;
  if (section.fields.length || section.maps.length) {
    const list = group(pane, title);
    for (const field of section.fields) renderField(list, field, host);
    for (const map of section.maps) {
      list.createEl("p", {
        cls: "setting-item-description",
        text: `${map}: a list of named entries this tab does not draw yet.`,
      });
    }
  }
  for (const child of section.sections) renderSection(pane, child, host, title);
}

export interface FieldOptions {
  /** A friendlier name than the key, for the fields shown outside Advanced. */
  label?: string;
  /** Called after a change was saved, e.g. to show or hide the fields that depend on it. */
  onSaved?: () => void;
}

export function renderField(container: HTMLElement, field: ConfigField, host: ConfigHost,
                            options: FieldOptions = {}): Setting {
  const setting = new Setting(container).setName(options.label ?? field.label);
  const baseDesc = describe(field);
  setting.setDesc(baseDesc);
  setting.nameEl.title = field.path.join(".");  // where it lives in config.yaml, for whoever wants to know

  const report = (result: ConfigWriteResult | null): void => {
    if (!result) return;
    const dotted = field.path.join(".");
    const problems = result.fields.filter((item) => item.path === dotted || item.path.startsWith(`${dotted}.`));
    if (!result.ok) {
      setting.setDesc(problems.map((item) => item.message).join("; ") || result.error || "Not saved.");
      setting.descEl.addClass("mod-warning");
      return;
    }
    setting.setDesc(baseDesc);
    setting.descEl.removeClass("mod-warning");
    if (result.restart_required.length) {
      new Notice(`Saved. ${result.restart_required.join(", ")} applies after the agent restarts.`);
    } else if (!result.reloaded && result.changed.length) {
      new Notice("Saved, but the agent could not take the change up — see the agent's log.");
    }
    options.onSaved?.();
  };

  const send = async (input: string | boolean): Promise<void> => {
    const parsed = parseInput(field, input);
    if (!parsed.ok) {
      setting.setDesc(`Expected ${parsed.error}.`);
      setting.descEl.addClass("mod-warning");
      return;
    }
    report(await host.save(nest(field.path, parsed.value)));
  };

  switch (field.kind) {
    case "boolean":
      setting.addToggle((toggle) => toggle
        .setValue(Boolean(field.value ?? field.defaultValue))
        .onChange((value) => void send(value)));
      break;
    case "enum":
      setting.addDropdown((dropdown) => {
        dropdown.addOption("", `default (${display(field.defaultValue) || "none"})`);
        for (const option of field.options) dropdown.addOption(option, option);
        dropdown.setValue(display(field.value));
        dropdown.onChange((value) => void send(value));
      });
      break;
    case "list":
      setting.addTextArea((area) => {
        area.setPlaceholder(display(field.defaultValue) || "one per line").setValue(display(field.value));
        area.inputEl.rows = 3;
        area.inputEl.addEventListener("change", () => void send(area.getValue()));
      });
      break;
    default:
      setting.addText((text) => {
        if (field.secret) {
          // The stored value never comes into this box: it is masked, and a mask is not an input
          text.setPlaceholder(field.value ? `${display(field.value)} (set)` : "${LLM_API_KEY}");
          text.inputEl.addEventListener("change", () => {
            const input = text.getValue();
            if (!input.trim()) return;  // leaving the box empty keeps what is stored
            if (!acceptsSecret(input)) {
              new Notice("Put the key itself under Secrets, then write its variable here, e.g. ${LLM_API_KEY}. "
                         + "A key typed here would be stored as plain text in the settings, which sync with the vault.", 10_000);
              text.setValue("");
              return;
            }
            void send(input).then(() => text.setValue(""));
          });
          return;
        }
        text.setPlaceholder(display(field.defaultValue) || (field.nullable ? "not set" : ""))
          .setValue(display(field.value));
        text.inputEl.addEventListener("change", () => void send(text.getValue()));
      });
  }
  return setting;
}

function describe(field: ConfigField): string {
  if (field.help) return field.help;
  if (field.secret) return "Takes an ${ENV} reference to a secret, never the key itself.";
  return "";
}
