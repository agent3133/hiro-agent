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
import { modifyFile, resolveExistingNote, vaultNotes, type VaultPort } from "../vault";
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

/** How a value is written, as words: "a [[link]]", "a list of [[links]]", "a date like 2026-09-14", "text" (#264). */
export function writtenAs(value: unknown): string {
  if (value === null || value === undefined || value === "") return "";
  if (typeof value === "boolean") return "a checkbox";
  if (typeof value === "number") return "a number";
  if (value instanceof Date) return "a date like 2026-09-14";
  if (Array.isArray(value)) {
    const items = value.map(writtenAs).filter(Boolean);
    if (!items.length) return "";
    if (items.every((item) => item === "a [[link]]")) return "a list of [[links]]";
    return "a list";
  }
  if (typeof value === "object") return "a mapping";
  const text = String(value).trim();
  if (/^\[\[[^\]]+\]\]$/.test(text)) return "a [[link]]";
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return "a date like 2026-09-14";
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(text)) return "a date and time like 2026-09-14T10:00";
  if (/^\d{1,2}\.\d{1,2}\.\d{4}$/.test(text)) return "a date like 14.09.2026";
  if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(text)) return "a date like 09/14/2026";
  return "text";
}

/** Notes in a folder read for how they write a property (#264): enough to see a habit, few enough to stay quick. */
const SIBLINGS_READ = 50;

/**
 * A line for update_metadata's answer when *value* is written unlike *key* in most other notes of the note's folder
 * (#264): a path where the others link, text where they list. Only a hint — a different form may be meant.
 */
export async function formHint(vault: VaultPort, scope: string[] | null, note: string, key: string,
                               value: unknown): Promise<string> {
  const mine = writtenAs(value);
  if (!mine) return "";
  const folder = note.includes("/") ? note.slice(0, note.lastIndexOf("/")) : "";
  const siblings = (await vaultNotes(vault, scope)).filter((rel) => rel !== note
    && (rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "") === folder).slice(0, SIBLINGS_READ);
  const forms = new Map<string, { count: number; example: unknown; from: string }>();
  let seen = 0;
  for (const sibling of siblings) {
    let data: Record<string, unknown>;
    try {
      data = readFrontmatter(await vault.read(sibling)).data;
    } catch {
      continue;
    }
    const form = writtenAs(data[key]);
    if (!form) continue;
    seen++;
    const entry = forms.get(form) ?? { count: 0, example: data[key], from: sibling };
    entry.count++;
    forms.set(form, entry);
  }
  // A habit is two notes or more, and at least two thirds of those that have the property
  const [form, most] = [...forms.entries()].sort((a, b) => b[1].count - a[1].count)[0] ?? [];
  if (!form || !most || form === mine || most.count < 2 || most.count * 3 < seen * 2) return "";
  const example = typeof most.example === "string" ? most.example : pyRepr(most.example);
  const where = folder ? ` in '${folder}'` : "";
  return `\n[Other notes${where} write ${key} as ${form}, e.g. ${example} in '${most.from}'. If this one should match, `
    + "set it again.]";
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
    if (!(await vault.isFile(resolved))) {
      // A wrong folder or a bare name finds the one note of that name, as get_metadata does (#159)
      const found = await resolveExistingNote(vault, path, scope);
      if (!found.note) return found.error;
      resolved = found.note;
    }
    const key = args.str("key");
    // An unquoted null removes the property (#161); quoted, "null" is the text
    // Changes go to the note as it is when written, so the user's typing meanwhile is kept (#164)
    if (args.str("value").trim() === "null") {
      if (!(key in readFrontmatter(await vault.read(resolved)).data)) {
        return `'${key}' is not set in '${resolved}'; nothing to remove`;
      }
      await modifyFile(vault, resolved, (text) => setFrontmatter(text, { [key]: undefined }));
      return `Removed ${key} from '${resolved}'`;
    }
    const stored = parseValue(args.str("value"));
    await modifyFile(vault, resolved, (text) => setFrontmatter(text, { [key]: stored }));
    return `Set ${key} to ${shown(stored)} in '${resolved}'` + await formHint(vault, scope, resolved, key, stored);
  });

  return [getMetadata, updateMetadata];
}
