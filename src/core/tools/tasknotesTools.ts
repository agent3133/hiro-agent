/**
 * list_tasknotes and complete_tasknote — ported from make_tasknotes_tools (src/obsidian_agent/tools/builtin/tasknotes.py).
 *
 * TaskNotes keeps one note per task. Reading, filtering and completing them is ordinary note work, done from the
 * files; the plugin's own settings file is read so a renamed property or a custom "completed" status is honoured.
 * Creating a task goes through the plugin itself (create_tasknote, #82).
 *
 * Difference from Python, on purpose: completing a task changes only its status and completion date in the
 * frontmatter; Python rewrote the whole block with its keys sorted.
 */

import { readFrontmatter, setFrontmatter } from "../frontmatter";
import { basename, OBSIDIAN_DIR } from "../paths";
import { vaultNotes, type VaultPort } from "../vault";
import { defineTool, type Tool } from "./tool";

/** Where TaskNotes keeps its settings, in the vault's config folder — `.obsidian` unless renamed (#164). */
export const settingsPath = (configDir = OBSIDIAN_DIR): string => `${configDir}/plugins/tasknotes/data.json`;
/** Rows per listing: a vault with a hundred tasks answers "list them" with a wall models give up on. */
export const TASK_LIST_LIMIT = 30;

export class TaskNotesSettings {
  folder = "TaskNotes/Tasks";
  archive = "TaskNotes/Archive";
  tag = "task";
  defaultStatus = "open";
  completedStatuses: string[] = ["done"];
  fields: Record<string, string> = {};

  static async read(vault: VaultPort, configDir = OBSIDIAN_DIR): Promise<TaskNotesSettings> {
    const settings = new TaskNotesSettings();
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(await vault.read(settingsPath(configDir))) as Record<string, unknown>;
    } catch {
      return settings; // no plugin settings: the defaults are what TaskNotes ships with
    }
    const text = (key: string): string => (typeof data[key] === "string" ? data[key] : "");
    settings.folder = text("tasksFolder") || settings.folder;
    settings.archive = text("archiveFolder") || settings.archive;
    settings.tag = text("taskTag") || settings.tag;
    settings.defaultStatus = text("defaultTaskStatus") || settings.defaultStatus;
    const custom = Array.isArray(data.customStatuses) ? data.customStatuses as Record<string, unknown>[] : [];
    const completed = custom.filter((s) => s.isCompleted).map((s) => String(s.value));
    if (completed.length) settings.completedStatuses = completed;
    if (data.fieldMapping && typeof data.fieldMapping === "object") {
      settings.fields = data.fieldMapping as Record<string, string>;
    }
    return settings;
  }

  /** The property name this vault uses for a TaskNotes field (`due` may be `deadline`). */
  name(canonical: string): string {
    return this.fields[canonical] || canonical;
  }

  get(meta: Record<string, unknown>, canonical: string, fallback: unknown = undefined): unknown {
    const value = meta[this.name(canonical)];
    return value === undefined ? fallback : value;
  }

  isTask(meta: Record<string, unknown>): boolean {
    const tags = asList(meta[this.name("tags")] ?? meta.tags);
    return tags.map((t) => pyStr(t).toLowerCase().replace(/^#+/, "")).includes(this.tag.toLowerCase());
  }

  isDone(meta: Record<string, unknown>): boolean {
    return this.completedStatuses.includes(pyStr(this.get(meta, "status", "")).toLowerCase());
  }
}

function asList(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

/** Python's str() for the values YAML gives: True/False and None as Python writes them. */
function pyStr(value: unknown): string {
  if (value === true) return "True";
  if (value === false) return "False";
  if (value === null || value === undefined) return "None";
  return String(value);
}

function isTruthy(value: unknown): boolean {
  return !(value === undefined || value === null || value === false || value === "" || value === 0
           || (Array.isArray(value) && value.length === 0));
}

/** Python's `date.today().isoformat()`: the local date. */
function today(now = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export function makeTaskNotesTools(vault: VaultPort, scope: string[] | null = null, configDir = OBSIDIAN_DIR): Tool[] {
  interface TaskNote { rel: string; meta: Record<string, unknown> }

  const taskNotes = async (settings: TaskNotesSettings): Promise<TaskNote[]> => {
    const folders = [settings.folder.toLowerCase() + "/", settings.archive.toLowerCase() + "/"];
    const found: TaskNote[] = [];
    for (const rel of [...(await vaultNotes(vault, scope))].sort()) {
      if (!folders.some((folder) => rel.toLowerCase().startsWith(folder))) continue;
      let meta: Record<string, unknown>;
      try {
        meta = readFrontmatter(await vault.read(rel)).data;
      } catch {
        continue;
      }
      if (settings.isTask(meta)) found.push({ rel, meta });
    }
    return found;
  };

  /** A task note by title or path, or an error naming the candidates. */
  const find = async (settings: TaskNotesSettings, task: string): Promise<{ rel: string; error: string }> => {
    const wanted = task.trim().toLowerCase().replace(/\.md$/, "");
    const notes = await taskNotes(settings);
    const title = (meta: Record<string, unknown>): string => pyStr(settings.get(meta, "title", "")).toLowerCase();
    const exact = notes.filter(({ rel, meta }) => rel.toLowerCase().replace(/\.md$/, "") === wanted
      || title(meta) === wanted || basename(rel).replace(/\.md$/, "").toLowerCase() === wanted);
    if (exact.length === 1) return { rel: exact[0].rel, error: "" };
    const listed = (list: TaskNote[]): string => list.slice(0, 5).map(({ rel }) => `'${rel}'`).join(", ");
    if (exact.length > 1) {
      return { rel: "", error: `Error: several tasks are called '${task}': ${listed(exact)}. Give the path.` };
    }
    const partial = notes.filter(({ rel, meta }) => rel.toLowerCase().includes(wanted) || title(meta).includes(wanted));
    if (partial.length === 1) return { rel: partial[0].rel, error: "" };
    if (partial.length) {
      return { rel: "", error: `Error: '${task}' matches several tasks: ${listed(partial)}. Give the path.` };
    }
    return { rel: "", error: `Error: no TaskNotes task called '${task}' (list_tasknotes shows them)` };
  };

  const listTaskNotes = defineTool("list_tasknotes", async (args) => {
    const settings = await TaskNotesSettings.read(vault, configDir);
    const status = args.str("status");
    const project = args.str("project");
    const unassigned = ["none", "no project", "unassigned", "-"].includes(project.trim().toLowerCase());
    let rows: string[] = [];
    let hiddenStatus = 0;
    let hiddenProject = 0;
    for (const { rel, meta } of await taskNotes(settings)) {
      const done = settings.isDone(meta);
      const projects = asList(settings.get(meta, "projects")).map(pyStr);
      const wanted = project.toLowerCase().replace(/^[[\]]+|[[\]]+$/g, "");
      const inProject = unassigned ? !projects.length
        : !project || projects.some((p) => p.toLowerCase().includes(wanted));
      if ((status === "open" && done) || (status === "done" && !done)) {
        hiddenStatus += inProject ? 1 : 0;
        continue;
      }
      if (!inProject) {
        hiddenProject += 1;
        continue;
      }
      const details = [`status: ${pyStr(settings.get(meta, "status", "unknown"))}`];
      for (const canonical of ["due", "scheduled", "priority"]) {
        const value = settings.get(meta, canonical);
        if (isTruthy(value)) details.push(`${canonical}: ${pyStr(value)}`);
      }
      if (projects.length) details.push(`projects: ${projects.join(", ")}`);
      rows.push(`${rel} — ${details.join("; ")}`);
    }
    // A filtered list that says nothing about what it filtered reads as the whole truth (tasknotes.py)
    const notes: string[] = [];
    if (hiddenStatus) {
      const kind = status === "open" ? "done" : "open";
      const where = project ? " in this project" : "";
      notes.push(`${hiddenStatus} ${kind} task${hiddenStatus !== 1 ? "s" : ""}${where} not listed`);
    }
    if (hiddenProject) {
      const where = unassigned ? "that belong to a project" : "in other projects";
      notes.push(`${hiddenProject} task${hiddenProject !== 1 ? "s" : ""} ${where} not listed`);
    }
    if (rows.length > TASK_LIST_LIMIT) {
      notes.unshift(`${rows.length - TASK_LIST_LIMIT} more, narrow with project or status`);
      rows = rows.slice(0, TASK_LIST_LIMIT);
    }
    if (!rows.length) return "No TaskNotes tasks found" + (notes.length ? ` (${notes.join("; ")})` : "");
    return rows.join("\n") + (notes.length ? `\n(${notes.join("; ")})` : "");
  });

  const completeTaskNote = defineTool("complete_tasknote", async (args) => {
    const settings = await TaskNotesSettings.read(vault, configDir);
    const { rel, error } = await find(settings, args.str("task"));
    if (error) return error;
    const text = await vault.read(rel);
    const meta = readFrontmatter(text).data;
    if (isTruthy(settings.get(meta, "recurrence"))) {
      return `Error: '${rel}' is a recurring task. Completing it has to advance `
             + "its schedule, which only the TaskNotes plugin can do — tick it off in Obsidian instead.";
    }
    if (settings.isDone(meta)) return `'${rel}' is already ${pyStr(settings.get(meta, "status"))}`;
    const completed = settings.completedStatuses[0];
    await vault.write(rel, setFrontmatter(text, { [settings.name("status")]: completed,
                                                  [settings.name("completedDate")]: today() }));
    return `Completed '${rel}' (${settings.name("status")}: ${completed})`;
  });

  return [listTaskNotes, completeTaskNote];
}
