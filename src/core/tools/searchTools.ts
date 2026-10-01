/**
 * search_vault — ported from make_search_tools (src/obsidian_agent/tools/builtin/search.py), the file-reading path
 * (without Obsidian's index; the test port has none). Same results, snippets and limits.
 */

import { normalize, scopeHint } from "../paths";
import type { VaultPort } from "../vault";
import { defineTool, type Tool } from "./tool";

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

export function makeSearchTools(vault: VaultPort, scope: string[] | null = null): Tool[] {
  const searchVault = defineTool("search_vault", async (args) => {
    const query = args.str("query");
    const limit = args.int("limit");
    const queryLower = query.toLowerCase();
    const wantedTag = args.str("tag").trim().replace(/^#+/, "").toLowerCase();
    const wantedFolder = args.str("folder").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "").toLowerCase();
    if (!query && !wantedTag && !wantedFolder) return "Error: give a query, a tag, or a folder";

    const roots = scope && scope.length
      ? scope.map((s) => normalize(s.replace(/\/+$/, "")) ?? "")
      : [""];
    const files = await vault.files();
    const results: string[] = [];
    for (const root of roots) {
      if (root && !(await vault.isFolder(root))) continue;
      const below = files.filter((file) => file.endsWith(".md") && (!root || file.startsWith(`${root}/`)))
        // os.walk skips folders starting with "." (.trash, .obsidian, .sessions) below the walk root
        .filter((file) => !(root ? file.slice(root.length + 1) : file).split("/").slice(0, -1).some((p) => p.startsWith(".")));
      for (const rel of walkOrder(below)) {
        let content: string;
        try {
          content = await vault.read(rel);
        } catch {
          continue;
        }
        if (wantedFolder && !rel.toLowerCase().startsWith(`${wantedFolder}/`)) continue;
        if (wantedTag && !noteTags(content).has(wantedTag)) continue;
        if (!queryLower || content.toLowerCase().includes(queryLower)) {
          const idx = queryLower ? Math.max(content.toLowerCase().indexOf(queryLower), 0) : 0;
          const start = Math.max(0, idx - 40);
          const end = Math.min(content.length, idx + query.length + 40);
          results.push(`${rel}: ${content.slice(start, end).replace(/\n/g, " ").trim()}`);
          if (results.length >= limit) break;
        }
      }
      if (results.length >= limit) break;
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
