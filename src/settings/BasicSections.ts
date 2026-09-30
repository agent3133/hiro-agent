/**
 * The Features tab: the handful of feature switches, chosen by hand rather than generated.
 *
 * Generating every field made the settings a wall of sixty knobs, most of them sampling parameters and terminal
 * styling. These are the ones a person setting the agent up actually decides; the rest stays reachable under
 * Advanced. Anything in `BASIC_PATHS` (basicPaths.ts) is left out of Advanced so no field appears twice — the
 * default agent among them, which the Agents tab sets.
 */

import { Notice } from "obsidian";

import type { ConfigDocument, ProgramCheck, ProgramFound } from "../api/types";
import { renderField, type ConfigHost } from "./ConfigSections";
import { AUDIO_DETAILS, FEATURES } from "./basicPaths";
import { group } from "./layout";
import { buildSection, findField, nest } from "./schemaForm";

/** The agent's programs (whisper.cpp, ffmpeg), as the Features tab needs them: find, and test. */
export interface ProgramHost {
  detect(): Promise<Record<"whisper" | "ffmpeg", ProgramFound>>;
  test(program: "whisper" | "ffmpeg"): Promise<ProgramCheck>;
}

/** Which of the audio fields get a Test button, and what it tests. */
const TESTABLE: Record<string, { program: "whisper" | "ffmpeg"; name: string }> = {
  "audio.whisper_cli": { program: "whisper", name: "whisper.cpp" },
  "audio.ffmpeg": { program: "ffmpeg", name: "ffmpeg" },
};

export function renderFeatures(container: HTMLElement, doc: ConfigDocument, host: ConfigHost,
                               redraw: () => void, programs?: ProgramHost): void {
  const root = buildSection(doc.schema, doc.schema, doc.values);
  container = group(container, "Features", "What the agent may do. Each switch applies from the next turn.");
  for (const { path, label } of FEATURES) {
    const field = findField(root, path);
    if (!field) continue;  // a schema that predates the field; Advanced shows what it has
    // Switching audio on or off shows or hides what it needs, so that one redraws after saving
    renderField(container, field, host, { label, onSaved: path === "audio.enabled" ? redraw : undefined });
    if (path === "audio.enabled" && (field.value ?? field.defaultValue)) {
      const nested = container.createDiv({ cls: "obsidian-agent-nested" });
      const found = programs?.detect().catch(() => null);
      for (const detail of AUDIO_DETAILS) {
        const detailField = findField(root, detail);
        if (!detailField) continue;
        const setting = renderField(nested, detailField, host);
        const testable = TESTABLE[detail];
        if (testable && programs && found) {
          // Which program this value runs — and, when it runs nothing, the one PATH offers, in one click
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
                const result = await host.save(nest(detailField.path, status.on_path));
                if (result?.ok) redraw();
              }));
            } else {
              where.setText(`Not found as set, and ${testable.name} is not on PATH either.`);
              where.addClass("mod-warning");
            }
          });
          // Tests what is saved: a path is saved when its box loses focus, which clicking Test does first
          setting.addButton((button) => button.setButtonText("Test").onClick(async () => {
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
      }
    }
  }
}
