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
const NEVER = ["llm_profiles", "default_llm_profile", "mcp_servers", "vault.path"];

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

  const name = options.label ?? field.label;
  // One way of answering a change (#149): a short "Saved" by the field; a refusal on the field and as a notice
  const refuse = (reason: string): void => {
    setting.setDesc(reason);
    setting.descEl.addClass("mod-warning");
    new Notice(`${name} was not saved: ${reason}`, 8_000);
  };
  const report = (result: ConfigWriteResult | null): void => {
    if (!result) return;
    const dotted = field.path.join(".");
    const problems = result.fields.filter((item) => item.path === dotted || item.path.startsWith(`${dotted}.`));
    if (!result.ok) {
      refuse(problems.map((item) => item.message).join("; ") || result.error || "Not saved.");
      return;
    }
    setting.setDesc(baseDesc);
    setting.descEl.removeClass("mod-warning");
    flashSaved(setting);
    options.onSaved?.();
  };

  const send = async (input: string | boolean): Promise<void> => {
    const parsed = parseInput(field, input);
    if (!parsed.ok) {
      refuse(`expected ${parsed.error}.`);
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
        // "not set" when there is no default: "default (none)" read like a choice, next to a real `none` (2026-10-05)
        // Values read as words: chat_completions as "chat completions"
        const words = (option: string): string => option.replace(/_/g, " ");
        const fallback = display(field.defaultValue);
        dropdown.addOption("", fallback ? `default (${words(fallback)})` : "not set");
        for (const option of field.options) dropdown.addOption(option, words(option));
        dropdown.setValue(display(field.value));
        dropdown.onChange((value) => void send(value));
      });
      break;
    case "list":
      setting.addTextArea((area) => {
        area.setPlaceholder(display(field.defaultValue) || "one per line").setValue(display(field.value));
        area.inputEl.rows = 3;
        // Saved while typing, a moment after the last key, and at once on leaving the box (#149)
        let timer: number | undefined;
        const flush = (): void => {
          if (timer === undefined) return;
          window.clearTimeout(timer);
          timer = undefined;
          void send(area.getValue());
        };
        area.inputEl.addEventListener("input", () => {
          window.clearTimeout(timer);
          timer = window.setTimeout(flush, 800);
        });
        area.inputEl.addEventListener("blur", flush);
      });
      break;
    default:
      setting.addText((text) => {
        if (field.secret) {
          // The stored value never comes into this box: it is masked, and a mask is not an input
          text.setPlaceholder(field.value ? `${display(field.value)} (set)` : "${openai-api-key}");
          text.inputEl.addEventListener("change", () => {
            const input = text.getValue();
            if (!input.trim()) return;  // leaving the box empty keeps what is stored
            if (!acceptsSecret(input)) {
              new Notice("Put the key in Obsidian's keychain (Settings → Keychain), then write its name here, e.g. "
                         + "${openai-api-key}. "
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
  if (field.secret) return "The name of a keychain entry, as ${openai-api-key}, never the key itself.";
  return "";
}

/** A short "Saved" next to the field's name. */
function flashSaved(setting: Setting): void {
  setting.nameEl.querySelector(".obsidian-agent-saved")?.remove();
  const mark = setting.nameEl.createSpan({ cls: "obsidian-agent-saved", text: "Saved" });
  window.setTimeout(() => mark.remove(), 1_500);
}
