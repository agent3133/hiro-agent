/**
 * Settings grouped into cards under a heading, for the Agents page, which draws itself (#321).
 *
 * Cards are Obsidian's own `SettingGroup`, so they look like every other plugin's; the caller gets back the element
 * to put `Setting`s into.
 */

import { SettingGroup } from "obsidian";

/** A card, optionally with a heading and a line of explanation; returns where its settings go. */
export function group(container: HTMLElement, heading?: string, description?: string): HTMLElement {
  const made = new SettingGroup(container);
  if (heading) made.setHeading(heading);
  const list = made.listEl;
  if (description) list.createEl("p", { cls: "setting-item-description obsidian-agent-card-intro", text: description });
  return list;
}
