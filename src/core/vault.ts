/**
 * The vault as the tools see it, and the helpers they share — a port of `_vault_notes`, `suggest_notes`,
 * `suggest_folders`, `not_found` and `resolve_existing_note` (src/obsidian_agent/tools/builtin/__init__.py).
 *
 * `VaultPort` is the only way the core touches files. It has two implementations: `nodeVault.ts` (the file
 * system, for tests and headless runs) and, outside the core, one on Obsidian's `Vault`. Paths are vault-relative
 * POSIX strings throughout.
 */

import { getCloseMatches, ratio } from "./difflib";
import { basename, hasSuffix, normalize, PathError, safeResolve, stem } from "./paths";

export interface VaultPort {
  /** Every file, including files in dot folders (callers decide what to skip). Sorted. */
  files(): Promise<string[]>;
  /** Every folder, including dot folders. Sorted. */
  folders(): Promise<string[]>;
  isFile(path: string): Promise<boolean>;
  isFolder(path: string): Promise<boolean>;
  read(path: string): Promise<string>;
  /** Create or replace a file, creating its folders. */
  write(path: string, text: string): Promise<void>;
  /** Delete a file for good (sessions, and undoing a create). */
  remove(path: string): Promise<void>;
  /** Move a file, creating the folders it goes to; in Obsidian, links follow it as the user has them set. */
  move(from: string, to: string): Promise<void>;
}

/** Whether *path* lies in a dot folder below *root* (.trash, .sessions): what the note tools leave out. */
export function hiddenBelow(path: string, root: string): boolean {
  const rest = root ? path.slice(root.length + 1) : path;
  return rest.split("/").some((part) => part.startsWith("."));
}

/** Every note in the vault (or in *scope*), skipping dot folders such as .trash — `_vault_notes`. */
export async function vaultNotes(vault: VaultPort, scope: string[] | null = null): Promise<string[]> {
  return vaultFiles(vault, scope, (file) => file.endsWith(".md"));
}

/** Every file *wanted* takes, in the vault (or in *scope*), skipping dot folders such as .trash. */
export async function vaultFiles(vault: VaultPort, scope: string[] | null,
                                 wanted: (file: string) => boolean): Promise<string[]> {
  const roots = scope && scope.length ? scope.map((s) => normalize(s.replace(/\/+$/, "")) ?? "") : [""];
  const files = await vault.files();
  const found: string[] = [];
  for (const root of roots) {
    if (root && !(await vault.isFolder(root))) continue;
    for (const file of files) {
      if (!wanted(file)) continue;
      if (root && !file.startsWith(`${root}/`)) continue;
      if (!hiddenBelow(file, root)) found.push(file);
    }
  }
  return found;
}

/** Notes whose path or file name is close to *wanted* — `suggest_notes`. */
export async function suggestNotes(vault: VaultPort, wanted: string, scope: string[] | null = null,
                                   limit = 3): Promise<string[]> {
  const wantedClean = stripQuotes(wanted.replace(/\\/g, "/").trim()).replace(/\.md$/, "").toLowerCase();
  if (!wantedClean) return [];
  const wantedWords = words(wantedClean);
  const scored: [number, string][] = [];
  for (const rel of await vaultNotes(vault, scope)) {
    const noteStem = stem(rel).toLowerCase();
    const relKey = rel.replace(/\.md$/, "").toLowerCase();
    let score = Math.max(ratio(wantedClean, relKey), ratio(wantedClean, noteStem));
    if (relKey.includes(wantedClean) || wantedClean.includes(noteStem) || noteStem.includes(wantedClean)) {
      score = Math.max(score, 0.9);
    }
    // "Atlas project" should find "Projects/Project Atlas": same words, different order
    const noteWords = words(relKey);
    if (wantedWords.size && noteWords.size) {
      const shared = [...wantedWords].filter((w) => noteWords.has(w)).length / wantedWords.size;
      score = Math.max(score, shared === 1 ? 0.85 : shared >= 0.5 ? 0.7 : 0);
    }
    if (score >= 0.6) scored.push([score, rel]);
  }
  scored.sort((x, y) => (y[0] - x[0]) || (x[1] < y[1] ? -1 : x[1] > y[1] ? 1 : 0));
  return scored.slice(0, limit).map(([, rel]) => rel);
}

/** Folders close to *wanted*, for a failed list_notes — `suggest_folders`. */
export async function suggestFolders(vault: VaultPort, wanted: string, scope: string[] | null = null,
                                     limit = 3): Promise<string[]> {
  const wantedClean = stripQuotes(wanted.replace(/\\/g, "/").trim()).replace(/^\/+|\/+$/g, "").toLowerCase();
  let folders = (await vault.folders()).filter((f) => !f.split("/").some((part) => part.startsWith(".")));
  if (scope && scope.length) {
    const roots = scope.map((s) => s.replace(/\/+$/, ""));
    folders = folders.filter((f) => roots.some((s) => f === s || f.startsWith(`${s}/`)));
  }
  if (!wantedClean) return [...folders].sort().slice(0, limit);
  const close = folders.filter((f) => f.toLowerCase().includes(wantedClean) || wantedClean.includes(f.toLowerCase()));
  for (const f of getCloseMatches(wantedClean, folders.map((f) => f.toLowerCase()), limit, 0.6)) {
    if (!close.includes(f)) close.push(f);
  }
  const seen: string[] = [];
  for (const folder of close) {
    const match = folders.find((f) => f.toLowerCase() === folder.toLowerCase()) ?? folder;
    if (!seen.includes(match)) seen.push(match);
  }
  return seen.slice(0, limit);
}

/** A not-found error naming the closest real paths — `not_found`. */
export function notFound(kind: string, wanted: string, options: string[]): string {
  if (!options.length) return `Error: ${kind} not found at '${wanted}'`;
  if (options.length === 1) return `Error: ${kind} not found at '${wanted}'. Did you mean '${options[0]}'?`;
  return `Error: ${kind} not found at '${wanted}'. Did you mean one of ${options.map((o) => `'${o}'`).join(", ")}?`;
}

/**
 * The note *path* names, or the error to return — `resolve_existing_note`. A bare file name that matches exactly
 * one note resolves to it: models ask for '2026-09-09.md' when the note is in 'Journal/Daily/'.
 */
export async function resolveExistingNote(vault: VaultPort, path: string,
                                          scope: string[] | null = null): Promise<{ note: string | null; error: string }> {
  let resolved: string;
  try {
    resolved = safeResolve(path, scope);
  } catch (error) {
    if (error instanceof PathError) return { note: null, error: `Error: ${error.message}` };
    throw error;
  }
  if (resolved && (await vault.isFile(resolved))) return { note: resolved, error: "" };
  if (resolved && !hasSuffix(resolved) && (await vault.isFile(`${resolved}.md`))) {
    return { note: `${resolved}.md`, error: "" };
  }
  const wanted = basename(stripQuotes(path.replace(/\\/g, "/").trim())).replace(/\.md$/, "").toLowerCase();
  const matches = (await vaultNotes(vault, scope)).filter((note) => stem(note).toLowerCase() === wanted);
  if (matches.length === 1) return { note: matches[0], error: "" };
  if (matches.length > 1) {
    const listed = [...matches].sort().slice(0, 5).map((note) => `'${note}'`).join(", ");
    return { note: null, error: `Error: '${path}' matches several notes: ${listed}. Use the full path.` };
  }
  return { note: null, error: notFound("note", path, await suggestNotes(vault, path, scope)) };
}

function words(text: string): Set<string> {
  return new Set(text.split(/[^a-z0-9]+/).filter((w) => w.length > 2));
}

/** Python's `str.strip('"')`. */
function stripQuotes(text: string): string {
  return text.replace(/^"+|"+$/g, "");
}
