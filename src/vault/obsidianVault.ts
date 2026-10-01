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
import type { VaultPort } from "../core/vault";

let writes = 0;
let recorder: ((change: Change) => void) | null = null;

/** Report every write, move and delete to *record* (the in-plugin agent's undo journal); null stops it. */
export function setRecorder(record: ((change: Change) => void) | null): void {
  recorder = record;
}

/** Report a change made outside obsidianVault — a tool that trashes or renames through Obsidian (#85). */
export function recordChange(change: Change): void {
  recorder?.(change);
}

/** How many writes went through the vault so far — index questions wait for Obsidian to catch up after one. */
export function writeCount(): number {
  return writes;
}

/** Record a write made outside obsidianVault (a move, a delete). */
export function noteWrite(): void {
  writes += 1;
}

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
 * The VaultPort on *app*'s vault. Its writes go to the undo journal while a turn records them; with `record: false`
 * they never do — the settings' own writes (an agent saved in the Agents tab) are not the agent's changes (#177).
 */
export function obsidianVault(app: App, options: { record?: boolean } = {}): VaultPort {
  const record = (): ((change: Change) => void) | null => (options.record === false ? null : recorder);
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
    const visit = async (folder: string): Promise<void> => {
      const listed = await adapter.list(folder);
      files.push(...listed.files);
      for (const sub of listed.folders) {
        folders.push(sub);
        await visit(sub);
      }
    };
    for (const folder of (await adapter.list("/")).folders.map(clean)) {
      if (!folder.startsWith(".") || folder === app.vault.configDir) continue;
      folders.push(folder);
      await visit(folder);
    }
    return { files: [...new Set(files.map(clean))].sort(), folders: [...new Set(folders.map(clean))].sort() };
  }

  // Through the adapter: it answers for the dot folders too, which the index does not hold
  const kind = async (path: string): Promise<"file" | "folder" | null> => {
    const stat = await adapter.stat(normalizePath(path));
    return stat ? stat.type : null;
  };

  /** A file's text when the journal needs it, null when there is no file. */
  const before = async (path: string): Promise<string | null> => {
    if (!record()) return null;
    const stat = await adapter.stat(normalizePath(path));
    if (stat?.type !== "file") return null;
    const file = app.vault.getAbstractFileByPath(normalizePath(path));
    return file instanceof TFile ? app.vault.read(file) : adapter.read(normalizePath(path));
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
    files: async () => (await walk()).files,
    folders: async () => (await walk()).folders,
    isFile: async (path) => (await kind(path)) === "file",
    isFolder: async (path) => (path === "" ? true : (await kind(path)) === "folder"),
    read: async (path) => {
      const file = app.vault.getAbstractFileByPath(normalizePath(path));
      return file instanceof TFile ? app.vault.read(file) : adapter.read(normalizePath(path));
    },
    write: async (path, text) => {
      const previous = await before(path);
      await write(path, text);
      record()?.({ op: previous === null ? "create" : "modify", path: normalizePath(path), before: previous, after: text });
    },
    remove: async (path) => {
      writes += 1;
      const normalized = normalizePath(path);
      const previous = await before(normalized);
      const file = app.vault.getAbstractFileByPath(normalized);
      if (file instanceof TFile) await app.vault.delete(file, true);
      // Not in the index: a file in a dot folder
      else if (await adapter.exists(normalized)) await adapter.remove(normalized);
      record()?.({ op: "delete", path: normalized, before: previous, after: null });
    },
    move: async (from, to) => {
      writes += 1;
      const source = app.vault.getAbstractFileByPath(normalizePath(from));
      const target = normalizePath(to);
      await ensureFolder(app, target.split("/").slice(0, -1).join("/"));
      if (source instanceof TFile) await app.fileManager.renameFile(source, target);
      // Not in the index: a file in a dot folder
      else await adapter.rename(normalizePath(from), target);
      const note = record();
      if (note) note({ op: "move", path: normalizePath(from), before: null, after: await before(target), movedTo: target });
    },
  };
}
