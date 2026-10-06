/**
 * Running a Base for query_base (#230). Obsidian gives a plugin no call that runs a Base's query, but it runs the
 * query for every Base shown with a view type — and a plugin may register one (`registerBasesView`, 1.10). So the
 * definition is written as a temporary `.base` whose view is the plugin's own type, opened in a background tab, and
 * the result handed to that view (filters, formulas, sorting, grouping and limits applied) is read and the tab and
 * file removed again. One query at a time.
 */

import { BasesView, Notice, type App, type BasesQueryResult, type Plugin, type QueryController, TFile } from "obsidian";

import { QUERY_VIEW_TYPE } from "../core/baseDefinition";
import { serially } from "../core/serial";

let available = false;
let deliver: ((view: QueryView) => void) | null = null;

class QueryView extends BasesView {
  type = QUERY_VIEW_TYPE;

  constructor(controller: QueryController, readonly el: HTMLElement) {
    super(controller);
    // A user who picks this view type in a Base sees what it is for, not an empty pane
    el.createDiv({ cls: "obsidian-agent-query-view",
                   text: "This view is used by Hiro Agent to read a Base's rows. Choose another view to see them." });
  }

  onDataUpdated(): void {
    deliver?.(this);
  }
}

/** Register the view type; without the Bases core plugin it fails, and query_base is not offered. */
export function registerBasesQuery(plugin: Plugin): void {
  available = plugin.registerBasesView(QUERY_VIEW_TYPE, {
    name: "Hiro Agent (reads rows)", icon: "bot", factory: (controller, el) => new QueryView(controller, el),
  });
}

export function basesAvailable(): boolean {
  return available;
}

export interface QueryRows {
  columns: string[];
  rows: string[][];
  /** The group of each row, when the view groups them; empty otherwise. */
  groups: string[];
}

function rowsOf(view: QueryView): QueryRows {
  const result: BasesQueryResult = view.data;
  const properties = result.properties.length ? result.properties : view.allProperties.slice(0, 8);
  const columns = ["file", ...properties.filter((p) => p !== "file.name").map((p) => view.config.getDisplayName(p) || p)];
  const shown = properties.filter((p) => p !== "file.name");
  const grouped = result.groupedData.some((group) => group.hasKey());
  const rows: string[][] = [];
  const groups: string[] = [];
  for (const group of result.groupedData) {
    for (const entry of group.entries) {
      rows.push([entry.file.path, ...shown.map((p) => {
        const value = entry.getValue(p);
        // An empty property is a null Value, which prints as "null"
        const text = value === null ? "" : value.toString();
        return text === "null" ? "" : text;
      })]);
      if (grouped) groups.push(group.key?.toString() ?? "");
    }
  }
  return { columns, rows, groups: grouped ? groups : [] };
}

/**
 * Remove the temporary Base. A Base view that closes may still save its file once, which would bring a file deleted
 * at once back: so wait a moment, delete, and delete again if it came back.
 */
async function removeQueryFile(app: App, name: string): Promise<void> {
  const pause = (ms: number): Promise<void> => new Promise((resolve) => window.setTimeout(resolve, ms));
  for (let attempt = 0; attempt < 3; attempt++) {
    await pause(250);
    const file = app.vault.getAbstractFileByPath(name);
    if (!(file instanceof TFile)) return;
    // Deleted for good, not to the trash: the plugin's own temporary note, which a trash would collect from every
    // query (#322). The review's prefer-file-manager-trash-file warns about this line on purpose
    await app.vault.delete(file).catch(() => undefined);
  }
  if (app.vault.getAbstractFileByPath(name)) new Notice(`Hiro Agent: delete '${name}', left from a Base query`);
}

const oneAtATime = serially();
const TIMEOUT_MS = 15_000;

/** The rows *yaml* (a Base's definition, its view set to QUERY_VIEW_TYPE) gives, or an Error. */
export function runBase(app: App, yaml: string): Promise<QueryRows> {
  return oneAtATime(async () => {
    let name = "Hiro Agent query.base";
    for (let n = 2; app.vault.getAbstractFileByPath(name); n++) name = `Hiro Agent query ${n}.base`;
    const file: TFile = await app.vault.create(name, yaml);
    const leaf = app.workspace.getLeaf("tab");
    try {
      const result = new Promise<QueryRows>((resolve, reject) => {
        const timer = window.setTimeout(() => reject(new Error("Obsidian did not run the Base in time")), TIMEOUT_MS);
        deliver = (view) => {
          window.clearTimeout(timer);
          resolve(rowsOf(view));
        };
      });
      await leaf.openFile(file, { active: false });
      return await result;
    } finally {
      deliver = null;
      leaf.detach();
      await removeQueryFile(app, name);
    }
  });
}
