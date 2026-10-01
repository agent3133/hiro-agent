/**
 * The tools that need what Obsidian knows — links, tags, tasks, headings — and the ones that move and delete notes
 * the way Obsidian does (#81). Obsidian-only: they have no Node implementation and are tested inside Obsidian
 * (plugin/tests/obsidian-tools.smoke.ts through `agent:tool`).
 *
 * Names, descriptions and argument schemas are Python's (specs.json); the answers keep the shapes the Python tools
 * gave (src/obsidian_agent/tools/builtin/search.py, obsidian.py, vault.py).
 */

import { getAllTags, parseLinktext, TFile, type App, type TAbstractFile } from "obsidian";

import { checkNoteName, noteFile, PathError, safeResolve, stem, within } from "../core/paths";
import { defineTool, type Tool } from "../core/tools/tool";
import { notFound, resolveExistingNote, suggestNotes, type VaultPort } from "../core/vault";
import { ensureFolder, noteWrite, recordChange, writeCount } from "./obsidianVault";

/** How long Obsidian may need to index a note we just wrote — Python's INDEX_SETTLE_S. */
const INDEX_SETTLE_MS = 400;
/** Where the vault's own trash lives when the user keeps deleted files in the vault. */
const TRASH = ".trash";

/**
 * The write count the index last caught up with — module state on purpose (#181): each turn (and each `agent:tool`
 * call) builds its tools anew, and this has to outlive them. One per vault window, as each runs its own plugin.
 */
let settledAt = 0;

/** The longest list an index tool answers with (#160): more is cut, and the answer says how many it left out. */
const MAX_LINES = 100;

/** *lines* joined, at most MAX_LINES of them, with a note naming how many more there are. */
function capped(lines: string[], what: string, narrow = "ask about fewer to see the rest"): string {
  if (lines.length <= MAX_LINES) return lines.join("\n");
  return `${lines.slice(0, MAX_LINES).join("\n")}\n[${lines.length - MAX_LINES} more ${what}; ${narrow}]`;
}

/** Give Obsidian a moment to index notes written since the last question — the index lags behind a write. */
async function settle(): Promise<void> {
  if (writeCount() === settledAt) return;
  settledAt = writeCount();
  await new Promise((resolve) => window.setTimeout(resolve, INDEX_SETTLE_MS));
}

export function makeIndexTools(app: App, vault: VaultPort, scope: string[] | null = null): Tool[] {
  const scoped = scope && scope.length ? scope.map((s) => s.replace(/\/+$/, "")) : null;
  const inScope = (path: string): boolean => !scoped || scoped.some((root) => within(path, root));
  const notes = (): TFile[] => app.vault.getMarkdownFiles().filter((file) => inScope(file.path))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));


  const fileAt = (path: string): TFile | null => {
    const file = app.vault.getAbstractFileByPath(path);
    return file instanceof TFile ? file : null;
  };

  const refused = (error: unknown): string => {
    if (error instanceof PathError) return `Error: ${error.message}`;
    throw error;
  };

  const listTags = defineTool("list_tags", async (args) => {
    await settle();
    const counts = new Map<string, number>();
    for (const file of notes()) {
      const cache = app.metadataCache.getFileCache(file);
      const tags = new Set((cache ? getAllTags(cache) ?? [] : []).map((tag) => tag.replace(/^#+/, "").toLowerCase()));
      for (const tag of tags) if (tag) counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
    if (!counts.size) return "No tags found in the vault";
    return [...counts].sort(([a, x], [b, y]) => (y - x) || (a < b ? -1 : a > b ? 1 : 0)).slice(0, args.int("limit"))
      .map(([name, count]) => `#${name} (${count})`).join("\n");
  });

  const getBacklinks = defineTool("get_backlinks", async (args) => {
    const path = args.str("path");
    const { note, error } = await resolveExistingNote(vault, path, scope);
    // Only a note that does not exist falls back to its name (it can still be linked to). A refused path — outside
    // the scope, .obsidian — says so; Python fell back for those too, answering "no backlinks" to a refusal.
    if (error && !error.startsWith("Error: note not found")) return error;
    await settle();
    let sources: string[];
    if (note) {
      sources = Object.entries(app.metadataCache.resolvedLinks).filter(([, targets]) => targets[note] !== undefined)
        .map(([source]) => source);
    } else {
      // A note that does not exist yet can still be linked to: look for links to the name that was asked for
      const wanted = stem(path.replace(/\\/g, "/")).toLowerCase();
      sources = Object.entries(app.metadataCache.unresolvedLinks)
        .filter(([, targets]) => Object.keys(targets).some((link) => stem(parseLinktext(link).path).toLowerCase() === wanted))
        .map(([source]) => source);
    }
    // Said in words when there are none, and bounded when there are many (#160)
    const linking = sources.filter(inScope).sort();
    if (!linking.length) return `No notes link to '${note ?? path}'`;
    return capped(linking, "notes");
  });

  const getOutlinks = defineTool("get_outlinks", async (args) => {
    const { note, error } = await resolveExistingNote(vault, args.str("path"), scope);
    if (error) return error;
    await settle();
    const file = fileAt(note!);
    const cache = file ? app.metadataCache.getFileCache(file) : null;
    const links = [...(cache?.links ?? []), ...(cache?.embeds ?? [])]
      .sort((a, b) => a.position.start.offset - b.position.start.offset);
    const found: string[] = [];
    for (const link of links) {
      const target = parseLinktext(link.link).path;
      if (!target) continue; // a link to a heading of this same note
      const destination = app.metadataCache.getFirstLinkpathDest(target, note!);
      found.push(destination ? destination.path : `${target} (unresolved)`);
    }
    const unique = [...new Set(found)];
    return unique.length ? unique.join("\n") : `No links in '${note}'`;
  });

  const listTasks = defineTool("list_tasks", async (args) => {
    const status = args.str("status");
    if (!["todo", "done", "all"].includes(status)) return "Error: status must be todo, done or all";
    const wanted = args.str("path").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "").toLowerCase();
    await settle();
    const found: string[] = [];
    for (const file of notes()) {
      if (wanted && !file.path.toLowerCase().includes(wanted)) continue;
      const tasks = (app.metadataCache.getFileCache(file)?.listItems ?? []).filter((item) => item.task !== undefined);
      if (!tasks.length) continue;
      const lines = (await app.vault.cachedRead(file)).split(/\r?\n/);
      for (const item of tasks) {
        const done = ![" ", ""].includes(item.task ?? "");
        if ((status === "todo" && done) || (status === "done" && !done)) continue;
        const line = item.position.start.line;
        found.push(`${file.path}:${line + 1}: ${(lines[line] ?? "").trim()}`);
      }
    }
    return found.length ? capped(found, "tasks", "name a folder in path, or a status, to see fewer") : "No tasks found";
  });

  const noteOutline = defineTool("note_outline", async (args) => {
    const { note, error } = await resolveExistingNote(vault, args.str("path"), scope);
    if (error) return error;
    await settle();
    const file = fileAt(note!);
    const headings = (file ? app.metadataCache.getFileCache(file)?.headings : null) ?? [];
    return headings.map((h) => "  ".repeat(h.level - 1) + h.heading.trim()).join("\n") || "No headings in this note";
  });

  const findBrokenLinks = defineTool("find_broken_links", async () => {
    await settle();
    const broken: string[] = [];
    for (const [source, targets] of Object.entries(app.metadataCache.unresolvedLinks).sort(([a], [b]) => (a < b ? -1 : 1))) {
      if (!inScope(source)) continue;
      for (const link of Object.keys(targets)) {
        const target = link.split("|")[0].split("#")[0].trim();
        if (target) broken.push(`${source} -> ${target}`);
      }
    }
    return [...new Set(broken)].join("\n") || "No broken links";
  });

  const openInObsidian = defineTool("open_in_obsidian", async (args) => {
    const { note, error } = await resolveExistingNote(vault, args.str("path"), scope);
    if (error) return error;
    const file = fileAt(note!);
    if (!file) return `Error: Obsidian does not show '${note}' — notes in hidden folders cannot be opened`;
    await app.workspace.getLeaf(false).openFile(file);
    return `Opened '${note}' in Obsidian`;
  });

  /** A note path the tool may touch, checked as Python checks it; the error to return, or "". */
  const checked = (path: string): { resolved: string; error: string } => {
    const problem = checkNoteName(path);
    if (problem) return { resolved: "", error: `Error: invalid note path '${path}': ${problem}` };
    try {
      return { resolved: safeResolve(path, scope), error: "" };
    } catch (error) {
      return { resolved: "", error: refused(error) };
    }
  };

  const exists = async (path: string): Promise<boolean> => (await vault.isFile(path)) || (await vault.isFolder(path));

  const deleteNote = defineTool("delete_note", async (args) => {
    const path = noteFile(args.str("path"));
    const { resolved, error } = checked(path);
    if (error) return error;
    const target: TAbstractFile | null = app.vault.getAbstractFileByPath(resolved);
    if (!target) {
      if (!(await exists(resolved))) return notFound("note", path, await suggestNotes(vault, path, scope));
      return `Error: Obsidian does not know '${path}' — notes in hidden folders cannot be deleted with this tool`;
    }
    noteWrite();
    // The undo journal keeps what the note held: undo writes it back, wherever the trash put it
    const held = target instanceof TFile ? await app.vault.read(target) : null;
    if (args.bool("permanent")) {
      await app.vault.delete(target, true);
      recordChange({ op: "delete", path: resolved, before: held, after: null });
      return `Deleted note at '${path}' permanently`;
    }
    // Where "the trash" is, is the user's choice (Settings → Files and links → Deleted files). `vault.getConfig` is
    // not in the published API: read only, and without it the message names no place rather than failing (#173)
    const option = (app.vault as unknown as { getConfig?(key: string): unknown }).getConfig?.("trashOption");
    await app.fileManager.trashFile(target);
    recordChange({ op: "delete", path: resolved, before: held, after: null });
    if (option === "local") return `Moved note '${path}' to ${TRASH}/ (restore it with move_note, or delete permanently)`;
    if (option === "system") return `Moved note '${path}' to the system trash (restore it from there, outside Obsidian)`;
    if (option === "none") {
      return `Deleted note at '${path}' permanently (the vault is set to delete files instead of keeping them in a trash)`;
    }
    return `Moved note '${path}' to the trash, as the vault is set to`;
  }, { destructive: true });

  /**
   * Other notes with *file*'s name. Links are usually written by name, and with two notes of one name Obsidian
   * resolves `[[name]]` to one of them — on 2026-09-28 renaming an agent-made summary rewrote the project links of
   * twenty task notes that meant the project note of the same name.
   */
  const sameName = (file: TFile): string[] => app.vault.getMarkdownFiles()
    .filter((other) => other.path !== file.path && other.basename.toLowerCase() === file.basename.toLowerCase())
    .map((other) => other.path).sort();

  /** move_note's source as the tool will find it: the path given, or the one note a fuzzy lookup lands on. */
  const moveSource = async (fromPath: string): Promise<{ source: string; error: string }> => {
    const { resolved, error } = checked(fromPath);
    if (error) return { source: "", error };
    if (await exists(resolved)) return { source: resolved, error: "" };
    const found = await resolveExistingNote(vault, fromPath, scope);
    if (found.error) return { source: "", error: found.error.replace("Error: note not found", "Error: source note not found") };
    return { source: found.note!, error: "" };
  };

  const moveNote = defineTool("move_note", async (args) => {
    const fromPath = noteFile(args.str("from_path"));
    const toPath = noteFile(args.str("to_path"));
    for (const candidate of [fromPath, toPath]) {
      const problem = checkNoteName(candidate);
      if (problem) return `Error: invalid note path '${candidate}': ${problem}`;
    }
    const destination = checked(toPath);
    if (destination.error) return destination.error;
    const { source, error } = await moveSource(fromPath);
    if (error) return error;
    if (await exists(destination.resolved)) return `Error: a note already exists at '${toPath}'`;
    const file = app.vault.getAbstractFileByPath(source);
    if (file instanceof TFile && args.bool("update_links")) {
      const namesake = sameName(file);
      if (namesake.length) {
        return `Error: another note is also called '${file.basename}' (${namesake.map((p) => `'${p}'`).join(", ")}), `
               + `so a link written as [[${file.basename}]] may mean either note, and updating links could rewrite `
               + "links meant for the other one. Ask the user to rename one of them in Obsidian first, or move this "
               + "one with update_links=false.";
      }
    }
    await ensureFolder(app, destination.resolved.split("/").slice(0, -1).join("/"));
    noteWrite();

    let changed = 0;
    const rewritten: { path: string; before: string; after: string }[] = [];
    if (!file) {
      // Not in Obsidian's index — a note in a hidden folder, such as one restored from .trash/
      await app.vault.adapter.rename(source, destination.resolved);
    } else if (args.bool("update_links")) {
      // Obsidian rewrites the links, as the user has it set; count the notes whose text it changed
      const linking = Object.entries(app.metadataCache.resolvedLinks)
        .filter(([from, targets]) => from !== source && targets[source] !== undefined).map(([from]) => from);
      const before = new Map<string, string>();
      for (const path of linking) before.set(path, await vault.read(path));
      await app.fileManager.renameFile(file, destination.resolved);
      for (const [path, text] of before) {
        const after = await vault.read(path).catch(() => text);
        if (after !== text) rewritten.push({ path, before: text, after });
      }
      changed = rewritten.length;
    } else {
      await app.vault.rename(file, destination.resolved);
    }
    // For undo: the move, then the notes whose links Obsidian rewrote — undone newest first, links before the move
    const moved = await vault.read(destination.resolved).catch(() => null);
    recordChange({ op: "move", path: source, before: null, after: moved, movedTo: destination.resolved });
    for (const note of rewritten) recordChange({ op: "modify", path: note.path, before: note.before, after: note.after });
    return `Moved note from '${source}' to '${destination.resolved}'${changed ? `; updated links in ${changed} note(s)` : ""}`;
  }, {
    destructive: true,
    // The question names the note that really moves: a model that passes 'Scratch' moves 'Inbox/Scratch.md'
    confirmArgs: async (args) => {
      const shown: Record<string, unknown> = { ...args };
      if (typeof args.to_path === "string") shown.to_path = noteFile(args.to_path);
      if (typeof args.from_path === "string") {
        const { source } = await moveSource(noteFile(args.from_path));
        shown.from_path = source || noteFile(args.from_path);
      }
      return shown;
    },
  });

  return [listTags, getBacklinks, getOutlinks, listTasks, noteOutline, findBrokenLinks, openInObsidian,
          deleteNote, moveNote];
}
