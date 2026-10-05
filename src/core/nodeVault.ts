/**
 * A vault on the file system — for the tests and headless runs. Obsidian's vault has its own implementation
 * outside the core (plugin/src/vault/obsidianVault.ts).
 */

import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { VaultPort } from "./vault";

export function nodeVault(root: string): VaultPort {
  const full = (path: string): string => join(root, ...path.split("/"));

  async function walk(): Promise<{ files: string[]; folders: string[] }> {
    const files: string[] = [];
    const folders: string[] = [];
    const visit = async (relative: string): Promise<void> => {
      const entries = await readdir(relative ? full(relative) : root, { withFileTypes: true });
      for (const entry of entries) {
        const path = relative ? `${relative}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          folders.push(path);
          await visit(path);
        } else if (entry.isFile()) {
          files.push(path);
        }
      }
    };
    await visit("");
    return { files: files.sort(), folders: folders.sort() };
  }

  const kind = async (path: string): Promise<"file" | "folder" | null> => {
    try {
      const info = await stat(full(path));
      return info.isFile() ? "file" : info.isDirectory() ? "folder" : null;
    } catch {
      return null;
    }
  };

  return {
    files: async () => (await walk()).files,
    folders: async () => (await walk()).folders,
    isFile: async (path) => (await kind(path)) === "file",
    isFolder: async (path) => (path === "" ? true : (await kind(path)) === "folder"),
    read: (path) => readFile(full(path), "utf-8"),
    write: async (path, text) => {
      await mkdir(dirname(full(path)), { recursive: true });
      await writeFile(full(path), text, "utf-8");
    },
    modified: async (path) => (await stat(full(path))).mtimeMs,
    size: async (path) => (await stat(full(path))).size,
    remove: async (path) => rm(full(path), { force: true }),
    move: async (from, to) => {
      await mkdir(dirname(full(to)), { recursive: true });
      await rename(full(from), full(to));
    },
  };
}
