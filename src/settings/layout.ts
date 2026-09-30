/**
 * The settings tab's frame: tabs across the top, and settings grouped into cards under a heading.
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

export interface Tab<Id extends string> {
  id: Id;
  label: string;
}

/**
 * A row of tab buttons and one pane per tab; only the chosen pane is shown. The choice survives a redraw
 * because the caller keeps it (`current`) and hears about changes (`onSwitch`).
 */
export function tabs<Id extends string>(container: HTMLElement, list: Tab<Id>[], current: Id,
                                        onSwitch: (id: Id) => void): Record<Id, HTMLElement> {
  const nav = container.createDiv({ cls: "obsidian-agent-tabs" });
  const panes = {} as Record<Id, HTMLElement>;
  const buttons = {} as Record<Id, HTMLElement>;
  for (const tab of list) {
    buttons[tab.id] = nav.createEl("button", { text: tab.label, cls: "obsidian-agent-tab" });
    panes[tab.id] = container.createDiv({ cls: "obsidian-agent-pane" });
  }
  const show = (id: Id): void => {
    for (const tab of list) {
      buttons[tab.id].toggleClass("is-active", tab.id === id);
      panes[tab.id].toggleClass("is-active", tab.id === id);
    }
  };
  for (const tab of list) {
    buttons[tab.id].addEventListener("click", () => {
      show(tab.id);
      onSwitch(tab.id);
    });
  }
  show(current);
  return panes;
}
