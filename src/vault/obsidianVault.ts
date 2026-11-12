/**
 * The agent core's VaultPort on Obsidian's vault (#76 test port).
 *
 * Listing is Obsidian's index plus the dot folders at the vault's root (see `walk`); the core decides what to skip. Reading and writing go through `app.vault` wherever Obsidian knows the file, so its index,
 * open editors and sync hear about the change. The adapter is used only where the index does not reach: the dot
 * folders Obsidian does not index (`.agents/`, `.sessions/`, `.trash/`), and a file's kind, which it answers for
 * those too.
 */

import { normalizePath, TFile, TFolder, type App } from "obsidian";

import type { Change } from "../core/journal";
import { isFileSystemAlias } from "../core/paths";
import type { VaultPort } from "../core/vault";

let writes = 0;

/** The dot folders at the vault's root that listings include: the plugin's own, and the vault's trash (#399). */
export const WALKED_DOT_FOLDERS = [".agents", ".sessions", ".memory", ".tools", ".trash"];
/** How long one walk of those folders is used again, unless something was written meanwhile. */
const DOT_WALK_KEPT_MS = 3000;

/** What a port's writes are reported to: the undo journal's turn of the answer that made them (#206). */
export type Recorder = (change: Change) => void;

/**
 * Report a change made outside obsidianVault — a tool that trashes or renames through Obsidian (#85) — to the
 * journal turn *vault*'s writes go to, if any.
 */
export function recordChange(vault: VaultPort, change: Change): void {
  vault.record?.(change);
}

/** How many writes went through the vault so far — index questions wait for Obsidian to catch up after one. */
export function writeCount(): number {
  return writes;
}

/** Record a write made outside obsidianVault (a move, a delete). */
export function noteWrite(): void {
  writes += 1;
}

/**
 * Whether Obsidian's window is minimized. While it is, `fileManager.renameFile` never finishes: it waits for the
 * metadata cache, whose work does not run in a hidden window (#207). `vault.rename`, without link updates, is not
 * affected.
 */
export function windowHidden(): boolean {
  return activeDocument.visibilityState === "hidden";
}

/** What a move that would update links answers while the window is minimized (#207). */
export const HIDDEN_WINDOW_MOVE = "Error: Obsidian's window is minimized, and while it is, Obsidian does not finish "
  + "moving a note and updating the links to it. Nothing was moved. Ask the user to bring the Obsidian window up, "
  + "then try again.";

/** Some adapters hand paths back with a leading "/" when listing the root. */
function clean(path: string): string {
  return path.replace(/^\/+/, "");
}

/** Create *path* and the folders above it, through Obsidian so its file tree sees them. */
export async function ensureFolder(app: App, path: string): Promise<void> {
  if (!path || app.vault.getAbstractFileByPath(path) instanceof TFolder) return;
  // A folder the index does not hold (a dot folder) may exist all the same
  if (await app.vault.adapter.exists(path)) return;
  await ensureFolder(app, path.split("/").slice(0, -1).join("/"));
  await app.vault.createFolder(path);
}

/**
 * The VaultPort on *app*'s vault. Its writes go to *record* — one answer's turn in the undo journal, so answers
 * running side by side never take each other's changes (#206). Without it they go nowhere: the settings' own
 * writes (an agent saved in the Agents tab) and the conversations' notes are not the agent's changes (#177).
 */
export function obsidianVault(app: App, options: { record?: Recorder | false } = {}): VaultPort {
  const record = (): Recorder | null => options.record || null;
  const adapter = app.vault.adapter;

  /**
   * Every file and folder: what Obsidian has indexed — instant, however large the vault — and the dot folders at
   * the vault's root, which it does not index (`.agents`, `.sessions`, `.trash`), walked through the adapter. Never
   * Obsidian's own folder: walking `.obsidian` (plugins, their dependencies) made each listing take a second (#92).
   */
  async function walk(): Promise<{ files: string[]; folders: string[] }> {
    const files: string[] = [];
    const folders: string[] = [];
    for (const item of app.vault.getAllLoadedFiles()) {
      if (item instanceof TFile) files.push(item.path);
      else if (item instanceof TFolder && !item.isRoot()) folders.push(item.path);
    }
    const dot = await dotFolders();
    files.push(...dot.files);
    folders.push(...dot.folders);
    return { files: [...new Set(files.map(clean))].sort(), folders: [...new Set(folders.map(clean))].sort() };
  }

  /**
   * The plugin's own dot folders and the trash, walked through the adapter, which Obsidian does not index. Only
   * those (#399): `.git` (obsidian-git) or another tool's folder has thousands of files, and walking them took a
   * moment on every listing, several times per tool call. Kept until the next write through any port, and for a few
   * seconds at most: a tool call lists the vault several times within them, and a file put there by hand (an agent
   * copied into `.agents/`) shows on the next listing after that.
   */
  let walked: { at: number; time: number; files: string[]; folders: string[] } | null = null;
  async function dotFolders(): Promise<{ files: string[]; folders: string[] }> {
    if (walked && walked.at === writes && Date.now() - walked.time < DOT_WALK_KEPT_MS) return walked;
    const files: string[] = [];
    const folders: string[] = [];
    const visit = async (folder: string): Promise<void> => {
      const listed = await adapter.list(folder);
      files.push(...listed.files);
      for (const sub of listed.folders) {
        folders.push(sub);
        await visit(sub);
      }
    };
    for (const folder of WALKED_DOT_FOLDERS) {
      if (folder === app.vault.configDir || !(await adapter.exists(folder))) continue;
      folders.push(folder);
      await visit(folder);
    }
    walked = { at: writes, time: Date.now(), files, folders };
    return walked;
  }

  /**
   * Whether the adapter may answer for *path*, which the index does not hold (#393): only in a dot folder, which
   * Obsidian does not index, and never by another name for a file (`AGENTS~1`, `x::$DATA`): the file system would
   * follow such a name past the checks made on the name as written.
   */
  const adapterMayReach = (normalized: string): boolean => {
    const parts = normalized.split("/");
    return parts.some((part) => part.startsWith(".")) && !parts.some(isFileSystemAlias);
  };

  // The index first; the adapter for the dot folders, which the index does not hold
  const kind = async (path: string): Promise<"file" | "folder" | null> => {
    const normalized = normalizePath(path);
    const indexed = app.vault.getAbstractFileByPath(normalized);
    if (indexed instanceof TFile) return "file";
    if (indexed instanceof TFolder) return "folder";
    if (!adapterMayReach(normalized)) return null;
    const stat = await adapter.stat(normalized);
    return stat ? stat.type : null;
  };

  /** Read through the adapter what the index does not hold, or say it is not there. */
  const readOutside = async (normalized: string): Promise<string> => {
    if (!adapterMayReach(normalized)) throw new Error(`'${normalized}' was not found`);
    return adapter.read(normalized);
  };

  /** A file's text when the journal needs it, null when there is no file. */
  const before = async (path: string): Promise<string | null> => {
    if (!record()) return null;
    if ((await kind(path)) !== "file") return null;
    const file = app.vault.getAbstractFileByPath(normalizePath(path));
    return file instanceof TFile ? app.vault.read(file) : readOutside(normalizePath(path));
  };

  const write = async (path: string, text: string): Promise<void> => {
    writes += 1;
    const normalized = normalizePath(path);
    const file = app.vault.getAbstractFileByPath(normalized);
    if (file instanceof TFile) {
      // A background edit (Obsidian's guidelines): process() applies it atomically to the file as it is now
      await app.vault.process(file, () => text);
      return;
    }
    if (normalized.split("/").some(isFileSystemAlias)) {
      throw new Error(`'${normalized}' has the form of another name for a file and is not written (#393)`);
    }
    const parent = normalized.split("/").slice(0, -1).join("/");
    if (normalized.split("/").some((part) => part.startsWith("."))) {
      // Obsidian does not index dot folders (.sessions/); the adapter writes there directly
      if (parent && !(await adapter.exists(parent))) await adapter.mkdir(parent);
      await adapter.write(normalized, text);
      return;
    }
    await ensureFolder(app, parent);
    await app.vault.create(normalized, text);
  };

  return {
    ...(options.record ? { record: options.record } : {}),
    files: async () => (await walk()).files,
    folders: async () => (await walk()).folders,
    isFile: async (path) => (await kind(path)) === "file",
    isFolder: async (path) => (path === "" ? true : (await kind(path)) === "folder"),
    read: async (path) => {
      const file = app.vault.getAbstractFileByPath(normalizePath(path));
      return file instanceof TFile ? app.vault.read(file) : readOutside(normalizePath(path));
    },
    write: async (path, text) => {
      const previous = await before(path);
      await write(path, text);
      record()?.({ op: previous === null ? "create" : "modify", path: normalizePath(path), before: previous, after: text });
    },
    modify: async (path, change) => {
      const normalized = normalizePath(path);
      const file = app.vault.getAbstractFileByPath(normalized);
      let previous = "";
      let after: string;
      if (file instanceof TFile) {
        writes += 1;
        // The change runs on the text as it is now, inside process(): a keystroke of the user's since the tool
        // read the note is kept (#164)
        after = await app.vault.process(file, (text) => {
          previous = text;
          return change(text);
        });
      } else {
        // Not in the index (a dot folder): read and write, as write() does there
        previous = await readOutside(normalized);
        after = change(previous);
        await write(normalized, after);
      }
      record()?.({ op: "modify", path: normalized, before: previous, after });
      return after;
    },
    modified: async (path) => {
      const file = app.vault.getAbstractFileByPath(normalizePath(path));
      if (file instanceof TFile) return file.stat.mtime;
      return adapterMayReach(normalizePath(path)) ? ((await adapter.stat(normalizePath(path)))?.mtime ?? 0) : 0;
    },
    size: async (path) => {
      const file = app.vault.getAbstractFileByPath(normalizePath(path));
      if (file instanceof TFile) return file.stat.size;
      return adapterMayReach(normalizePath(path)) ? ((await adapter.stat(normalizePath(path)))?.size ?? 0) : 0;
    },
    cachedRead: async (path) => {
      const file = app.vault.getAbstractFileByPath(normalizePath(path));
      return file instanceof TFile ? app.vault.cachedRead(file) : readOutside(normalizePath(path));
    },
    remove: async (path) => {
      writes += 1;
      const normalized = normalizePath(path);
      const previous = await before(normalized);
      const file = app.vault.getAbstractFileByPath(normalized);
      // Where deleted files go is the user's choice (Settings → Files and links → Deleted files), which Obsidian's
      // own trash follows (#322) — for an undone note, a conversation and an agent alike. A file in a dot folder
      // (.sessions/, .agents/) is not in its index: the same choice, by hand
      if (file instanceof TFile) {
        await app.fileManager.trashFile(file);
      } else if (await adapter.exists(normalized)) {
        const option = (app.vault as unknown as { getConfig?(key: string): unknown }).getConfig?.("trashOption");
        if (option === "none") await adapter.remove(normalized);
        else if (option === "local" || !(await adapter.trashSystem(normalized))) await adapter.trashLocal(normalized);
      }
      record()?.({ op: "delete", path: normalized, before: previous, after: null });
    },
    move: async (from, to) => {
      writes += 1;
      const source = app.vault.getAbstractFileByPath(normalizePath(from));
      const target = normalizePath(to);
      // A minimized window would leave the move hanging (#207): refused before anything changes
      if (source instanceof TFile && windowHidden()) throw new Error(HIDDEN_WINDOW_MOVE.replace(/^Error: /, ""));
      await ensureFolder(app, target.split("/").slice(0, -1).join("/"));
      if (source instanceof TFile) await app.fileManager.renameFile(source, target);
      // Not in the index: a file in a dot folder
      else await adapter.rename(normalizePath(from), target);
      const note = record();
      if (note) note({ op: "move", path: normalizePath(from), before: null, after: await before(target), movedTo: target });
    },
  };
}
