/**
 * The Features page: the handful of feature switches, chosen by hand rather than generated.
 *
 * Generating every field made the settings a wall of sixty knobs, most of them sampling parameters and terminal
 * styling. These are the ones a person setting the agent up actually decides; the rest stays reachable under
 * Advanced. Anything in `BASIC_PATHS` (basicPaths.ts) is left out of Advanced so no field appears twice — the
 * default agent among them, which the Agents page sets.
 *
 * Each feature is a switch, and its further settings a page of their own under it while it is on (#149, #321).
 */

import { Notice, type Setting, type SettingDefinitionGroup, type SettingGroupItem } from "obsidian";

import type { ConfigDocument, ProgramCheck, ProgramFound } from "../api/types";
import { fieldItem, type ConfigHost } from "./ConfigSections";
import { AUDIO_DETAILS, FEATURES, LABELS } from "./basicPaths";
import { buildSection, findField, nest, type ConfigField, type ConfigSection } from "./schemaForm";

/** The agent's programs (whisper.cpp, ffmpeg), as the Features page needs them: find, and test. */
export interface ProgramHost {
  detect(): Promise<Record<"whisper" | "ffmpeg", ProgramFound>>;
  test(program: "whisper" | "ffmpeg"): Promise<ProgramCheck>;
  /** What the programs as set run and whether this device approved it; null for the plugin's defaults (#136). */
  approval?(): { what: string; approved: boolean } | null;
  approve?(): void;
}

type Found = Record<"whisper" | "ffmpeg", ProgramFound> | null;

/** Which of the audio fields get a Test button, and what it tests. */
const TESTABLE: Record<string, { program: "whisper" | "ffmpeg"; name: string }> = {
  "audio.whisper_cli": { program: "whisper", name: "whisper.cpp" },
  "audio.ffmpeg": { program: "ffmpeg", name: "ffmpeg" },
};

/**
 * The features as one group. *changed* reads the configuration again after a save, so a feature's page appears
 * when it is switched on and goes when it is switched off.
 */
export function featureGroup(doc: ConfigDocument, host: ConfigHost, changed: () => void,
                             programs?: ProgramHost): SettingDefinitionGroup {
  const root = buildSection(doc.schema, doc.schema, doc.values);
  const items: SettingGroupItem[] = [];
  for (const { path, label, more } of FEATURES) {
    const field = findField(root, path);
    if (!field) continue;  // a schema that predates the field; Advanced shows what it has
    items.push(fieldItem(field, host, { label, onSaved: changed }));
    const details = more.map((detail) => findField(root, detail)).filter((item) => item !== undefined);
    const audio = path === "audio.enabled" ? audioItems(root, host, changed, programs) : [];
    if (!audio.length && !details.length) continue;
    items.push({
      type: "page", name: `More for ${label.toLowerCase()}`,
      desc: path === "audio.enabled" ? "The programs and the model that transcribe, and how." : undefined,
      visible: Boolean(field.value ?? field.defaultValue),
      items: [{
        type: "group",
        items: [...audio, ...details.map((detail) => fieldItem(detail, host, { label: LABELS[detail.path.join(".")] }))],
      }],
    });
  }
  return { type: "group", heading: "What the agent may do", items };
}

/** What audio transcription needs: approval on this device, and the programs with a Test button each. */
function audioItems(root: ConfigSection, host: ConfigHost, changed: () => void,
                    programs?: ProgramHost): SettingGroupItem[] {
  const items: SettingGroupItem[] = [];
  const approval = programs?.approval?.();
  const unapproved = Boolean(approval && !approval.approved);
  if (approval && unapproved) {
    // Programs named in settings that sync run nothing here until someone on this device has looked (#136)
    items.push({
      name: "Not approved on this device",
      desc: `As set, transcription ${approval.what}. These paths may have come from another device; nothing runs `
            + "here until you approve them.",
      render: (setting) => {
        setting.addButton((button) => button.setButtonText("Approve").setCta().onClick(() => {
          programs?.approve?.();
          changed();
        }));
      },
    });
  }
  // Looked up once per drawing of the page, and shared by the program rows
  let found: Promise<Found> | null = null;
  const lookUp = (): Promise<Found> => (found ??= programs ? programs.detect().catch(() => null) : Promise.resolve(null));
  for (const detail of AUDIO_DETAILS) {
    const field = findField(root, detail);
    if (!field) continue;
    const item = fieldItem(field, host, { label: LABELS[detail] });
    const testable = TESTABLE[detail];
    if (testable && programs) {
      const draw = item.render;
      item.render = (setting, group) => {
        draw(setting, group);
        programRow(setting, field, testable, host, changed, programs, lookUp(), unapproved);
      };
    }
    items.push(item);
  }
  return items;
}

/** Which program a path runs — and, when it runs nothing, the one PATH offers, in one click — and a Test button. */
function programRow(setting: Setting, field: ConfigField, testable: { program: "whisper" | "ffmpeg"; name: string },
                    host: ConfigHost, changed: () => void, programs: ProgramHost, found: Promise<Found>,
                    unapproved: boolean): void {
  const where = setting.descEl.createDiv({ cls: "obsidian-agent-found" });
  void found.then((all) => {
    const status = all?.[testable.program];
    if (!status) return;
    if (status.resolved) {
      where.setText(`Runs ${status.resolved}`);
    } else if (status.on_path) {
      where.setText(`Not found as set. On PATH: ${status.on_path}`);
      where.addClass("mod-warning");
      setting.addButton((button) => button.setButtonText("Use it").setCta().onClick(async () => {
        const result = await host.save(nest(field.path, status.on_path));
        if (result?.ok) changed();
      }));
    } else {
      where.setText(`Not found as set, and ${testable.name} is not on PATH either.`);
      where.addClass("mod-warning");
    }
  });
  // Tests what is saved: a path is saved when its box loses focus, which clicking Test does first
  setting.addButton((button) => button.setButtonText("Test").onClick(async () => {
    if (unapproved) {
      new Notice("Approve the programs on this device first: Test runs them.");
      return;
    }
    button.setDisabled(true);
    try {
      const check = await programs.test(testable.program);
      new Notice(check.ok
        ? `${testable.name} works${check.said[0] ? `: ${check.said[0]}` : "."}`
        : `${testable.name}: ${check.error ?? "it did not work"}`, 10_000);
    } catch (error) {
      new Notice(`${testable.name} could not be tested: ${(error as Error).message}`, 10_000);
    } finally {
      button.setDisabled(false);
    }
  }));
}
