/**
 * get_metadata and update_metadata — ported from make_metadata_tools (src/obsidian_agent/tools/builtin/metadata.py).
 *
 * In the core rather than on Obsidian's metadata cache (#81): the frontmatter is read from the note itself, so a
 * value set a moment ago reads back at once — the cache lags behind a write — and the tools run under Vitest.
 *
 * Differences from Python, on purpose: update_metadata changes the one key in place, keeping the other keys' order
 * and formatting (Python rewrote the block with its keys sorted); timestamps read back as written rather than in
 * Python's isoformat.
 */

import { readFrontmatter, setFrontmatter } from "../frontmatter";
import { checkNoteName, noteFile, PathError, safeResolve } from "../paths";
import { pyJson, pyRepr } from "../python";
import { notFound, resolveExistingNote, suggestNotes, type VaultPort } from "../vault";
import { defineTool, type Tool } from "./tool";

type Value = string | number | boolean | Value[] | { [key: string]: Value };

/** How a stored value reads back, with its type — `_shown`. */
export function shown(value: unknown): string {
  if (typeof value === "boolean") return `${value} (checkbox)`;
  if (typeof value === "number") return `${value} (number)`;
  if (Array.isArray(value)) return `${pyRepr(value)} (list of ${value.length})`;
  if (value && typeof value === "object") return `${pyRepr(value)} (mapping)`;
  return `'${String(value)}' (text)`;
}

/** A YAML flow list — `[a, b]` — rather than a wikilink or prose that opens with a bracket — `_is_flow_list`. */
function isFlowList(text: string): boolean {
  return text.startsWith("[") && text.endsWith("]") && !text.startsWith("[[") && !text.includes("\n")
    && text.split("[").length - 1 === 1;
}

/** `[[Tom Becker]]` written with JSON brackets becomes the link; other nested lists are flattened — `_flatten_links`. */
function flattenLinks(items: unknown[]): Value[] {
  const flat: Value[] = [];
  for (const item of items) {
    if (Array.isArray(item) && item.length === 1 && typeof item[0] === "string") {
      const name = item[0].trim();
      flat.push(name.startsWith("[[") ? name : `[[${name}]]`);
    } else if (Array.isArray(item)) {
      flat.push(...(item as Value[]));
    } else {
      flat.push(item as Value);
    }
  }
  return flat;
}

const INTEGER = /^[+-]?\d+(?:_\d+)*$/;
const FLOAT = /^[+-]?(?:(?:\d+(?:_\d+)*)?\.\d+(?:_\d+)*|\d+(?:_\d+)*\.?)(?:[eE][+-]?\d+)?$/;

/** The YAML value a written property should hold — `_parse_value`. */
export function parseValue(value: string): Value {
  const stripped = value.trim();
  if (stripped.length >= 2 && stripped[0] === stripped[stripped.length - 1] && `"'`.includes(stripped[0])) {
    return stripped.slice(1, -1);
  }
  if (["true", "yes"].includes(stripped.toLowerCase())) return true;
  if (["false", "no"].includes(stripped.toLowerCase())) return false;
  if (stripped.startsWith("[") || stripped.startsWith("{")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(stripped);
    } catch {
      // A YAML flow list the way the vault writes it — tags: [moc, borealis] — is not JSON
      if (!isFlowList(stripped)) return value;
      const items = stripped.slice(1, -1).split(",").map((item) => item.trim()).filter(Boolean);
      return flattenLinks(items.map(parseValue));
    }
    if (Array.isArray(parsed)) return flattenLinks(parsed);
    if (parsed && typeof parsed === "object") return parsed as Value;
  }
  if (INTEGER.test(stripped)) return Number(stripped.replace(/_/g, ""));
  if (FLOAT.test(stripped)) return Number(stripped.replace(/_/g, ""));
  return value;
}

export function makeMetadataTools(vault: VaultPort, scope: string[] | null = null): Tool[] {
  const getMetadata = defineTool("get_metadata", async (args) => {
    const { note, error } = await resolveExistingNote(vault, args.str("path"), scope);
    if (error) return error;
    return pyJson(readFrontmatter(await vault.read(note!)).data);
  });

  const updateMetadata = defineTool("update_metadata", async (args) => {
    const path = noteFile(args.str("path"));
    const problem = checkNoteName(path);
    if (problem) return `Error: invalid note path '${path}': ${problem}`;
    let resolved: string;
    try {
      resolved = safeResolve(path, scope);
    } catch (error) {
      if (error instanceof PathError) return `Error: ${error.message}`;
      throw error;
    }
    if (!((await vault.isFile(resolved)) || (await vault.isFolder(resolved)))) {
      return notFound("note", path, await suggestNotes(vault, path, scope));
    }
    const key = args.str("key");
    const stored = parseValue(args.str("value"));
    await vault.write(resolved, setFrontmatter(await vault.read(resolved), { [key]: stored }));
    return `Set ${key} to ${shown(stored)} in '${path}'`;
  });

  return [getMetadata, updateMetadata];
}
