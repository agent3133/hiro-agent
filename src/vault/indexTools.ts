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
import { ensureFolder, HIDDEN_WINDOW_MOVE, noteWrite, recordChange, windowHidden, writeCount } from "./obsidianVault";

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

  /**
   * The file *raw* names: an existing attachment — an image, a PDF, any file that is not a note — as given, or found
   * by its bare name the way an embed finds it (#215); anything else is a note, with `.md` added as before.
   */
  const fileOrNote = (raw: string): string => {
    const given = raw.trim().replace(/\\/g, "/");
    if (!/\.[A-Za-z0-9]{1,8}$/.test(given) || /\.md$/i.test(given)) return noteFile(given);
    try {
      if (app.vault.getAbstractFileByPath(safeResolve(given, scope)) instanceof TFile) return given;
    } catch {
      return noteFile(given);
    }
    if (!given.includes("/")) {
      const linked = app.metadataCache.getFirstLinkpathDest(given, "");
      if (linked && linked.extension !== "md" && inScope(linked.path)) return linked.path;
    }
    return noteFile(given);
  };
  /** Attachments are moved and deleted, but not journaled: undo writes text back, which would break an image. */
  const isAttachment = (path: string): boolean => !/\.md$/i.test(path);
  const NOT_UNDONE = " Undo does not cover attachments";
  /** Where *source* goes: an attachment keeps its extension when the new name has none; a note gets `.md`. */
  const destinationFor = (source: string, raw: string): string => {
    if (!isAttachment(source)) return noteFile(raw);
    const extension = source.slice(source.lastIndexOf("."));
    const given = raw.trim();
    return given.toLowerCase().endsWith(extension.toLowerCase()) ? given : `${given}${extension}`;
  };

  const deleteNote = defineTool("delete_note", async (args) => {
    const path = fileOrNote(args.str("path"));
    const { resolved: given, error } = checked(path);
    if (error) return error;
    // A wrong folder or a bare name finds the one note of that name (#159); the dialog named it already
    let resolved = given;
    if (!(await exists(given))) {
      const found = await resolveExistingNote(vault, path, scope);
      if (found.note) resolved = found.note;
    }
    const target: TAbstractFile | null = app.vault.getAbstractFileByPath(resolved);
    if (!target) {
      if (!(await exists(resolved))) return notFound("note", path, await suggestNotes(vault, path, scope));
      return `Error: Obsidian does not know '${resolved}' — notes in hidden folders cannot be deleted with this tool`;
    }
    noteWrite();
    // The undo journal keeps what the note held: undo writes it back, wherever the trash put it. Not an
    // attachment's, which is no text (#215)
    const attachment = isAttachment(resolved);
    const kind = attachment ? "attachment" : "note";
    const held = target instanceof TFile && !attachment ? await app.vault.read(target) : null;
    const record = (): void => {
      if (!attachment) recordChange({ op: "delete", path: resolved, before: held, after: null });
    };
    const noUndo = attachment ? `.${NOT_UNDONE}` : "";
    if (args.bool("permanent")) {
      await app.vault.delete(target, true);
      record();
      return `Deleted ${kind} at '${resolved}' permanently${noUndo}`;
    }
    // Where "the trash" is, is the user's choice (Settings → Files and links → Deleted files). `vault.getConfig` is
    // not in the published API: read only, and without it the message names no place rather than failing (#173)
    const option = (app.vault as unknown as { getConfig?(key: string): unknown }).getConfig?.("trashOption");
    await app.fileManager.trashFile(target);
    record();
    if (option === "local") {
      return `Moved ${kind} '${resolved}' to ${TRASH}/ (restore it with move_note, or delete permanently)${noUndo}`;
    }
    if (option === "system") {
      return `Moved ${kind} '${resolved}' to the system trash (restore it from there, outside Obsidian)${noUndo}`;
    }
    if (option === "none") {
      return `Deleted ${kind} at '${resolved}' permanently (the vault is set to delete files instead of keeping them in a `
        + `trash)${noUndo}`;
    }
    return `Moved ${kind} '${resolved}' to the trash, as the vault is set to${noUndo}`;
  }, {
    // Asked about only when there is something to delete: a path that names nothing fails at once, with the
    // closest names, instead of asking the user to approve deleting a note that does not exist (2026-10-05)
    destructiveWhen: async (args) => {
      const path = fileOrNote(args.str("path"));
      const { resolved, error } = checked(path);
      if (error) return false;  // refused by the tool itself
      return (await exists(resolved)) || Boolean((await resolveExistingNote(vault, path, scope)).note);
    },
  });

  /**
   * Other notes with *file*'s name. Links are usually written by name, and with two notes of one name Obsidian
   * resolves `[[name]]` to one of them — on 2026-09-28 renaming an agent-made summary rewrote the project links of
   * twenty task notes that meant the project note of the same name.
   */
  const sameName = (file: TFile): string[] => app.vault.getMarkdownFiles()
    .filter((other) => other.path !== file.path && other.basename.toLowerCase() === file.basename.toLowerCase())
    .map((other) => other.path).sort();

  /**
   * The notes linking to *file* by its bare name — `[[name]]` in the text or the frontmatter, as TaskNotes writes
   * projects — which Obsidian resolves to this note though another of that name may be meant. Links written with a
   * folder are not ambiguous, and a note no one links to has no link to rewrite (#162).
   */
  const linkedByName = (file: TFile): string[] => {
    const linking: string[] = [];
    for (const [from, targets] of Object.entries(app.metadataCache.resolvedLinks)) {
      if (from === file.path || targets[file.path] === undefined) continue;
      const source = fileAt(from);
      const cache = source ? app.metadataCache.getFileCache(source) : null;
      const references = [...(cache?.links ?? []), ...(cache?.embeds ?? []), ...(cache?.frontmatterLinks ?? [])];
      const bare = references.some((reference) => {
        const path = parseLinktext(reference.link).path;
        return !path.includes("/") && app.metadataCache.getFirstLinkpathDest(path, from)?.path === file.path;
      });
      if (bare) linking.push(from);
    }
    return linking.sort();
  };

  /** move_note's source as the tool will find it: the path given, or the one note a fuzzy lookup lands on. */
  const moveSource = async (fromPath: string): Promise<{ source: string; error: string }> => {
    const { resolved, error } = checked(fromPath);
    if (error) return { source: "", error };
    if (await exists(resolved)) return { source: resolved, error: "" };
    const found = await resolveExistingNote(vault, fromPath, scope);
    if (found.error) return { source: "", error: found.error.replace("Error: note not found", "Error: source note not found") };
    return { source: found.note!, error: "" };
  };

  /**
   * Where move_note puts *source*: a new name without a folder is a rename and keeps the source's folder — the model
   * says "rename X to Y" and passes just "Y", which once landed the note in the vault root (#229). A path with a
   * folder is used as given, and "/Y" still asks for the root. A note gets `.md`, an attachment keeps its
   * extension (destinationFor, #215).
   */
  const renameTarget = (source: string, raw: string): string => {
    const given = raw.trim().replace(/\\/g, "/");
    if (given.startsWith("/")) return destinationFor(source, given.replace(/^\/+/, ""));
    const folder = source.includes("/") ? source.slice(0, source.lastIndexOf("/")) : "";
    return destinationFor(source, !given.includes("/") && folder ? `${folder}/${given}` : given);
  };

  const moveNote = defineTool("move_note", async (args) => {
    const fromPath = fileOrNote(args.str("from_path"));
    const problem = checkNoteName(fromPath);
    if (problem) return `Error: invalid note path '${fromPath}': ${problem}`;
    const { source, error } = await moveSource(fromPath);
    if (error) return error;
    const toPath = renameTarget(source, args.str("to_path"));
    const toProblem = checkNoteName(toPath);
    if (toProblem) return `Error: invalid note path '${toPath}': ${toProblem}`;
    const destination = checked(toPath);
    if (destination.error) return destination.error;
    if (await exists(destination.resolved)) return `Error: a note already exists at '${toPath}'`;
    const file = app.vault.getAbstractFileByPath(source);
    // Refused rather than left hanging until the turn times out: a minimized window never finishes it (#207)
    if (file instanceof TFile && args.bool("update_links") && windowHidden()) return HIDDEN_WINDOW_MOVE;
    if (file instanceof TFile && args.bool("update_links")) {
      const namesake = sameName(file);
      const linking = namesake.length ? linkedByName(file) : [];
      if (linking.length) {
        // Paths outside the agent's folders are counted, not named (#162)
        const shown = namesake.filter(inScope).map((p) => `'${p}'`);
        const hidden = namesake.length - shown.length;
        if (hidden) shown.push(`${hidden} outside the folders you may use`);
        const linkers = linking.filter(inScope);
        const named = linkers.slice(0, 3).map((p) => `'${p}'`).join(", ");
        return `Error: another note is also called '${file.basename}' (${shown.join(", ")}), and ${linking.length} `
               + `note(s) link to [[${file.basename}]] by that name${named ? `, e.g. ${named}` : ""}: such a link may `
               + "mean either note, and updating links could rewrite links meant for the other one. Ask the user to "
               + "rename one of them in Obsidian first, or move this one with update_links=false.";
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
    // For undo: the move, then the notes whose links Obsidian rewrote — undone newest first, links before the move.
    // Not for an attachment, which is no text (#215): moving it back with move_note puts the links back as well
    const attachment = isAttachment(source);
    if (!attachment) {
      const moved = await vault.read(destination.resolved).catch(() => null);
      recordChange({ op: "move", path: source, before: null, after: moved, movedTo: destination.resolved });
      for (const note of rewritten) recordChange({ op: "modify", path: note.path, before: note.before, after: note.after });
    }
    return `Moved ${attachment ? "attachment" : "note"} from '${source}' to '${destination.resolved}'`
      + `${changed ? `; updated links in ${changed} note(s)` : ""}${attachment ? `.${NOT_UNDONE}; move it back to undo` : ""}`;
  }, {
    // Asked about only when there is something to move (2026-10-05): a source that names nothing fails at once
    destructiveWhen: async (args) => {
      const from = fileOrNote(args.str("from_path"));
      if (checkNoteName(from)) return false;  // refused by the tool itself
      return Boolean((await moveSource(from)).source);
    },
    // The question names the note that really moves: a model that passes 'Scratch' moves 'Inbox/Scratch.md'
    confirmArgs: async (args) => {
      const shown: Record<string, unknown> = { ...args };
      if (typeof args.from_path === "string") {
        const from = fileOrNote(args.from_path);
        const { source } = await moveSource(from);
        shown.from_path = source || from;
        // The question names where the file really goes: a bare new name keeps its folder (#229) and an
        // attachment its extension (#215)
        if (typeof args.to_path === "string") shown.to_path = source ? renameTarget(source, args.to_path) : destinationFor(from, args.to_path);
      } else if (typeof args.to_path === "string") {
        shown.to_path = noteFile(args.to_path);
      }
      return shown;
    },
  });

  return [listTags, getBacklinks, getOutlinks, listTasks, noteOutline, findBrokenLinks, openInObsidian,
          deleteNote, moveNote];
}
