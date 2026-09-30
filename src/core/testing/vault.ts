/**
 * Test vaults: a temporary folder with the given notes, as a VaultPort — the counterpart of the `tmp_path`
 * vaults in the Python tests. Removed again after each test.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach } from "vitest";

import { nodeVault } from "../nodeVault";
import { makeTools, type Tool } from "../tools";
import { DEFAULT_MEMORY } from "../tools/memoryTools";
import type { VaultPort } from "../vault";

export interface TestVault {
  /** The folder on disk. */
  root: string;
  vault: VaultPort;
  /** A note's text, read from disk; path relative to the vault, "/"-separated. */
  read(path: string): Promise<string>;
  exists(path: string): Promise<boolean>;
  write(path: string, text: string): Promise<void>;
  /** An empty folder. */
  folder(path: string): Promise<void>;
  /** A tool by name, on this vault, limited to *scope* when given. */
  tool(name: string, scope?: string[] | null): Tool;
}

const created: string[] = [];

afterEach(() => {
  for (const root of created.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A vault holding *notes* (path → text). */
export async function makeVault(notes: Record<string, string> = {}): Promise<TestVault> {
  const root = mkdtempSync(join(tmpdir(), "agent-core-test-"));
  created.push(root);
  const full = (path: string): string => join(root, ...path.split("/"));
  const write = async (path: string, text: string): Promise<void> => {
    await mkdir(dirname(full(path)), { recursive: true });
    await writeFile(full(path), text, "utf-8");
  };
  for (const [path, text] of Object.entries(notes)) await write(path, text);
  const vault = nodeVault(root);
  return {
    root, vault, write,
    read: (path) => readFile(full(path), "utf-8"),
    exists: async (path) => stat(full(path)).then(() => true, () => false),
    folder: async (path) => void (await mkdir(full(path), { recursive: true })),
    tool: (name, scope = null) => {
      // Memory on, with its default profile path, so the user-profile tools are there to test
      const tool = makeTools(vault, scope, { memory: DEFAULT_MEMORY }).find((t) => t.name === name);
      if (!tool) throw new Error(`no tool '${name}'`);
      return tool;
    },
  };
}
