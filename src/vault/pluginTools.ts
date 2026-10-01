/**
 * The tools that follow a core plugin or TaskNotes (#82): daily_note, list_templates, create_from_template and
 * create_tasknote. Obsidian-only, tested inside Obsidian (plugin/tests/obsidian-tools.smoke.ts).
 *
 * Other plugins are reached by named reads only (docs/obsidian-plugin-security.md §4): the Daily notes and
 * Templates settings are read from their own files in the config folder, and TaskNotes is asked through the one
 * method its own dialogs use to create a task. Templates are filled here — {{title}}, {{date}}, {{time}} and their
 * `:format` forms, as Obsidian's Templates plugin fills them — and Templater is never run.
 *
 * query_base and list_bases are not here: Obsidian gives a plugin no way to run a Base's query outside a view.
 */

import { moment, type App } from "obsidian";

import { checkNoteName, noteFile, PathError, safeResolve, stem } from "../core/paths";
import { defineTool, type Tool } from "../core/tools/tool";
import type { VaultPort } from "../core/vault";

/**
 * Obsidian's bundled moment. Its declaration is a namespace import, which TypeScript will not call under
 * esModuleInterop; at runtime it is the moment function.
 */
const clock = moment as unknown as {
  (input?: string, formats?: unknown[], strict?: boolean): { isValid(): boolean; format(pattern?: string): string };
  ISO_8601: unknown;
};

const TEMPLATES_OFF = "Error: templates are not set up in this vault — the Templates core plugin is off, or has no "
  + "template folder. Everything else works without it.";
const TASKNOTES_OFF = "Error: creating a TaskNotes task needs the TaskNotes plugin enabled in this vault — the plugin "
  + "owns the task folder, the name template and the status vocabulary. Everything else works without it.";

/** A core plugin's settings, from its own file in the config folder; null when the plugin is off. */
async function coreSettings(app: App, id: string): Promise<Record<string, unknown> | null> {
  // The config folder is not in the vault's index, so its files are read through the adapter
  const read = async (name: string): Promise<Record<string, unknown>> => {
    try {
      return JSON.parse(await app.vault.adapter.read(`${app.vault.configDir}/${name}`)) as Record<string, unknown>;
    } catch {
      return {};
    }
  };
  // core-plugins.json is a map of id → on/off (older vaults: a list of the ones that are on)
  const enabled = await read("core-plugins.json");
  const on = Array.isArray(enabled) ? (enabled as unknown[]).includes(id) : enabled[id] === true;
  return on ? read(`${id}.json`) : null;
}

const text = (value: unknown, fallback: string): string => (typeof value === "string" && value.trim() ? value.trim() : fallback);

/** A title without one pair of surrounding quotes — `_unquoted` (tasknotes.py). */
function unquoted(title: string): string {
  const trimmed = title.trim();
  const pairs = [['"', '"'], ["'", "'"], ["“", "”"], ["‘", "’"], ["„", "“"], ["`", "`"], ["”", "”"], ["’", "’"]];
  for (const [open, close] of pairs) {
    if (trimmed.length >= 2 && trimmed.startsWith(open) && trimmed.endsWith(close)) return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

const list = (value: string): string[] | undefined => {
  const items = value.split(",").map((item) => item.trim()).filter(Boolean);
  return items.length ? items : undefined;
};

export function makePluginTools(app: App, vault: VaultPort, scope: string[] | null = null): Tool[] {
  const dailyNote = defineTool("daily_note", async (args) => {
    const settings = await coreSettings(app, "daily-notes");
    if (!settings) return "Error: daily notes are not set up in this vault — the Daily notes core plugin is off.";
    const wanted = args.str("date").trim();
    const day = wanted ? clock(wanted, ["YYYY-MM-DD", clock.ISO_8601], true) : clock();
    if (!day.isValid()) return `Error: '${wanted}' is not a date; give it as YYYY-MM-DD`;
    const folder = text(settings.folder, "").replace(/^\/+|\/+$/g, "");
    const name = day.format(text(settings.format, "YYYY-MM-DD"));
    return `${folder ? `${folder}/` : ""}${name}.md`;
  });

  /** The template folder and the templates in it, by name relative to the folder, without `.md`. */
  const templates = async (): Promise<{ folder: string; names: string[]; settings: Record<string, unknown> } | null> => {
    const settings = await coreSettings(app, "templates");
    const folder = settings ? text(settings.folder, "").replace(/^\/+|\/+$/g, "") : "";
    if (!settings || !folder) return null;
    const names = app.vault.getMarkdownFiles().filter((file) => file.path.startsWith(`${folder}/`))
      .map((file) => file.path.slice(folder.length + 1).replace(/\.md$/, "")).sort();
    return { folder, names, settings };
  };

  const listTemplates = defineTool("list_templates", async () => {
    const found = await templates();
    if (!found) return TEMPLATES_OFF;
    return found.names.join("\n") || "No templates in this vault";
  });

  const createFromTemplate = defineTool("create_from_template", async (args) => {
    const found = await templates();
    if (!found) return TEMPLATES_OFF;
    const path = noteFile(args.str("path"));
    const problem = checkNoteName(path);
    if (problem) return `Error: invalid note path '${path}': ${problem}`;
    const template = args.str("template");
    const wanted = template.replace(/\\/g, "/").replace(/\.md$/, "").toLowerCase();
    const name = found.names.find((n) => n.toLowerCase() === wanted)
      ?? found.names.find((n) => stem(n).toLowerCase() === stem(wanted));
    if (!name) return `Error: no template '${template}' (use list_templates)`;
    let target: string;
    try {
      target = safeResolve(path, scope);
    } catch (error) {
      if (error instanceof PathError) return `Error: ${error.message}`;
      throw error;
    }
    if ((await vault.isFile(target)) || (await vault.isFolder(target))) return `Error: note already exists at '${path}'`;
    const now = clock();
    const dateFormat = text(found.settings.dateFormat, "YYYY-MM-DD");
    const timeFormat = text(found.settings.timeFormat, "HH:mm");
    const title = args.str("title") || stem(path);
    const filled = (await vault.read(`${found.folder}/${name}.md`))
      .replace(/\{\{\s*title\s*\}\}/gi, title)
      .replace(/\{\{\s*(date|time)\s*(?::\s*([^}]*?))?\s*\}\}/gi, (_whole, kind: string, format?: string) =>
        now.format(format || (kind.toLowerCase() === "date" ? dateFormat : timeFormat)));
    await vault.write(target, filled);
    return `Created '${path}' from template '${template}'`;
  });

  const createTaskNote = defineTool("create_tasknote", async (args) => {
    const title = unquoted(args.str("title"));
    if (!title) return "Error: a task needs a title";
    // The one named method TaskNotes' own dialogs, HTTP API and MCP server create tasks with. `app.plugins` is not
    // in the published API; without it, or without TaskNotes, the tool says so rather than failing (#173)
    const plugins = (app as unknown as { plugins?: { getPlugin?(id: string): unknown } }).plugins;
    const tasknotes = plugins?.getPlugin?.("tasknotes") as
      { taskService?: { createTask?(data: Record<string, unknown>): Promise<unknown> } } | null | undefined;
    if (!tasknotes) return TASKNOTES_OFF;
    const createTask = tasknotes.taskService?.createTask;
    if (typeof createTask !== "function") {
      return "Error: this version of TaskNotes offers no way for another plugin to create a task; update TaskNotes.";
    }
    const projects = list(args.str("projects"))?.map((p) => (p.startsWith("[[") ? p : `[[${p}]]`));
    const data: Record<string, unknown> = {
      title, projects, contexts: list(args.str("contexts")), tags: list(args.str("tags")),
      due: args.str("due") || undefined, scheduled: args.str("scheduled") || undefined,
      priority: args.str("priority") || undefined, status: args.str("status") || undefined,
      timeEstimate: args.int("estimate") > 0 ? args.int("estimate") : undefined,
      details: args.str("details") || undefined, recurrence: args.str("recurrence") || undefined,
    };
    for (const key of Object.keys(data)) if (data[key] === undefined) delete data[key];
    let created: unknown;
    try {
      created = await createTask.call(tasknotes.taskService, data);
    } catch (error) {
      return `Error: TaskNotes did not create the task: ${error instanceof Error ? error.message : String(error)}`;
    }
    const result = created as { file?: { path?: string }; taskInfo?: { path?: string } } | undefined;
    const where = result?.file?.path ?? result?.taskInfo?.path;
    return `Created TaskNotes task '${title}'${where ? ` at '${where}'` : ""}`;
  });

  // Python withholds create_tasknote from an agent with a folder restriction: TaskNotes files the task wherever the
  // vault keeps tasks, which the restriction cannot follow (BUILTIN_IGNORES_SCOPE, runner.py)
  const restricted = Boolean(scope && scope.length);
  return [dailyNote, createFromTemplate, listTemplates, ...(restricted ? [] : [createTaskNote])];
}
