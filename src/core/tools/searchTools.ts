/**
 * search_vault — ported from make_search_tools (src/obsidian_agent/tools/builtin/search.py), the file-reading path
 * (without Obsidian's index; the test port has none). Same results, snippets and limits.
 */

import { scopeHint } from "../paths";
import type { VaultPort } from "../vault";
import { defineTool, type Tool } from "./tool";
import { Scope } from "../scope";

const TAG_PATTERN = /(?:^|\s)#([A-Za-z0-9_][A-Za-z0-9_/-]*)/g;

function cleanTag(value: string): string {
  return value.trim().replace(/^["']+|["']+$/g, "").replace(/^#+/, "").toLowerCase();
}

/** Tags of a note: frontmatter `tags:` (list, block list or comma separated) plus inline #tags — `_note_tags`. */
export function noteTags(text: string): Set<string> {
  const tags = new Set([...text.matchAll(TAG_PATTERN)].map((m) => m[1].toLowerCase()));
  if (text.startsWith("---")) {
    const end = text.indexOf("\n---", 3);
    const front = end > 0 ? text.slice(3, end) : "";
    const match = /^tags:[ \t]*(.*)$/m.exec(front);
    if (match) {
      const inline = match[1].trim();
      if (inline.startsWith("[")) {
        for (const item of inline.replace(/^\[+|\]+$/g, "").split(",")) if (item.trim()) tags.add(cleanTag(item));
      } else if (inline) {
        for (const item of inline.split(",")) if (item.trim()) tags.add(cleanTag(item));
      } else {
        for (const line of front.slice(match.index + match[0].length).split(/\r?\n/)) {
          if (line.trim().startsWith("- ")) tags.add(cleanTag(line.trim().slice(2)));
          else if (line.trim() && !line.startsWith(" ")) break;
        }
      }
    }
  }
  return new Set([...tags].map(cleanTag).filter(Boolean));
}

/** Files in the order Python's os.walk visits them: a folder's files first, then its subfolders. */
function walkOrder(files: string[]): string[] {
  const key = (path: string): string[] => {
    const parts = path.split("/");
    // "\u0000" sorts a folder's own files before its subfolders' contents
    return [...parts.slice(0, -1).map((p) => `\u0001${p.toLowerCase()}`), `\u0000${parts[parts.length - 1].toLowerCase()}`];
  };
  return [...files].sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    for (let i = 0; i < Math.min(ka.length, kb.length); i++) if (ka[i] !== kb[i]) return ka[i] < kb[i] ? -1 : 1;
    return ka.length - kb.length;
  });
}

/**
 * The terms of a query (#416): its words, any order, and a "quoted phrase" as one term. Lowercase; an empty query has
 * none. One word is the substring search it always was.
 */
export function queryTerms(query: string): string[] {
  const terms: string[] = [];
  // In the order typed: a "quoted phrase" or a word; a stray quote is dropped
  for (const match of query.matchAll(/"([^"]+)"|(\S+)/g)) {
    const term = (match[1] ?? match[2]).replace(/"/g, "").trim().toLowerCase();
    if (term) terms.push(term);
  }
  return [...new Set(terms)];
}

/** How many matching lines a note's result shows. */
const HITS_PER_NOTE = 3;
/** Characters around a term in a hit. */
const AROUND = 60;

/**
 * A note's matching lines (#416): each line holding a term, with its number and the text around the first term in
 * it, up to *most*. Small models picked the first hit they saw; several, with their lines, show which part of the
 * note matters, and where to read.
 */
export function hitLines(content: string, terms: string[], most = HITS_PER_NOTE): { line: number; text: string }[] {
  const hits: { line: number; text: string }[] = [];
  const lines = content.split(/\r?\n/);
  for (let index = 0; index < lines.length && hits.length < most; index++) {
    const line = lines[index];
    const lower = line.toLowerCase();
    const at = terms.map((term) => lower.indexOf(term)).filter((i) => i >= 0).sort((a, b) => a - b)[0];
    if (at === undefined) continue;
    const start = Math.max(0, at - AROUND);
    const end = Math.min(line.length, at + AROUND * 2);
    hits.push({ line: index + 1,
                text: `${start > 0 ? "…" : ""}${line.slice(start, end).trim()}${end < line.length ? "…" : ""}` });
  }
  return hits;
}

/**
 * How well a note matches, for the order of the results (#416): the whole query as it was typed, then the terms in
 * the note's name, then how many lines match. Higher first.
 */
export function relevance(path: string, content: string, query: string, terms: string[]): number {
  const lower = content.toLowerCase();
  const name = path.toLowerCase().slice(path.lastIndexOf("/") + 1);
  const phrase = query.trim().toLowerCase().replace(/"/g, "");
  let score = terms.length > 1 && phrase && lower.includes(phrase) ? 1000 : 0;
  score += terms.filter((term) => name.includes(term)).length * 100;
  score += Math.min(99, lower.split("\n").filter((line) => terms.some((term) => line.includes(term))).length);
  return score;
}

export function makeSearchTools(vault: VaultPort, scope: string[] | null = null): Tool[] {
  const searchVault = defineTool("search_vault", async (args) => {
    const query = args.str("query");
    const limit = args.int("limit");
    const terms = queryTerms(query);
    const byModified = args.str("sort").toLowerCase() === "modified";
    const wantedTag = args.str("tag").trim().replace(/^#+/, "").toLowerCase();
    const wantedFolder = args.str("folder").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "").toLowerCase();
    if (!query && !wantedTag && !wantedFolder) return "Error: give a query, a tag, or a folder";

    // The whole vault is the root ""; a folder naming the vault itself or leaving it allows nothing (#419)
    const limits = Scope.of(scope);
    const roots = limits.restricted ? limits.roots() : [""];
    const files = await vault.files();
    // Every match is found before the order is decided: the best ones first, or the newest (#416)
    const found: { path: string; line: string; score: number; order: number }[] = [];
    for (const root of roots) {
      if (root && !(await vault.isFolder(root))) continue;
      const below = files.filter((file) => file.endsWith(".md") && (!root || file.startsWith(`${root}/`)))
        // os.walk skips folders starting with "." (.trash, .obsidian, .sessions) below the walk root
        .filter((file) => !(root ? file.slice(root.length + 1) : file).split("/").slice(0, -1).some((p) => p.startsWith(".")));
      // The folder is checked before a note is read, and the read comes from Obsidian's cache where it has one:
      // a search over a large vault no longer reads every note from disk (#164)
      const read = vault.cachedRead ?? vault.read;
      for (const rel of walkOrder(below)) {
        if (wantedFolder && !rel.toLowerCase().startsWith(`${wantedFolder}/`)) continue;
        let content: string;
        try {
          content = await read.call(vault, rel);
        } catch {
          continue;
        }
        if (wantedTag && !noteTags(content).has(wantedTag)) continue;
        const lower = content.toLowerCase();
        // Every word, in any order (#416)
        if (!terms.every((term) => lower.includes(term))) continue;
        if (found.some((item) => item.path === rel)) continue;
        // Its matching lines with their numbers; with only a tag or folder, its first line
        const hits = terms.length ? hitLines(content, terms) : [];
        const shown = hits.length ? hits.map((hit) => `line ${hit.line}: ${hit.text}`).join(" | ")
          : content.slice(0, 80).replace(/\n/g, " ").trim();
        found.push({ path: rel, line: `${rel}: ${shown}`, score: relevance(rel, content, query, terms),
                     order: found.length });
      }
    }
    if (byModified && vault.modified) {
      const times = new Map(await Promise.all(found.map(async (item) =>
        [item.path, await vault.modified!(item.path).catch(() => 0)] as const)));
      found.sort((a, b) => (times.get(b.path) ?? 0) - (times.get(a.path) ?? 0) || a.order - b.order);
    } else if (terms.length) {
      found.sort((a, b) => b.score - a.score || a.order - b.order);
    }
    const results = found.slice(0, limit).map((item) => item.line);
    if (found.length > limit) {
      results.push(`[${found.length - limit} more notes match: add a word, a tag or a folder to narrow it]`);
    }
    // Said in words: an empty answer reads to a small model as a broken tool (#160). A restricted agent's also says
    // where it looked (paths.scopeHint)
    if (!results.length) {
      if (scope && scope.length) return `No notes found${scopeHint(scope)}`;
      const asked = [query && `contain '${query}'`, wantedTag && `are tagged #${wantedTag}`,
                     wantedFolder && `are in '${wantedFolder}'`].filter(Boolean).join(" and ");
      return `No notes ${asked}. Try fewer or other words, or find_notes to search by name.`;
    }
    return results.join("\n");
  });

  return [searchVault];
}
