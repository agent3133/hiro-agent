/**
 * Vault-relative paths, and the rules about which ones a tool may touch — a port of the helpers in
 * src/obsidian_agent/tools/builtin/__init__.py (`note_file`, `check_note_name`, `safe_resolve`).
 *
 * Everything here works on vault-relative POSIX paths ("Projects/Atlas.md"), never on the file system, so the same
 * rules hold for the Node vault and for Obsidian's.
 */

/** Obsidian's own configuration. No tool reaches it. */
export const OBSIDIAN_DIR = ".obsidian";

/**
 * Folders no tool reaches, and what each holds: Obsidian's configuration; the definitions that decide what an agent
 * may do (#60); the saved conversations, which are read back into the model's context; the profile that goes into
 * every agent's prompt (#135). The plugin's own code reaches them through the vault port, not through a tool.
 */
const PROTECTED: [string, string][] = [
  [OBSIDIAN_DIR, "holds Obsidian's own configuration"],
  [".agents", "holds agent definitions"],
  [".tools", "holds tool definitions"],
  [".sessions", "holds saved conversations"],
  [".memory", "holds the profile the agent keeps of the user"],
];

/**
 * Paths protected on top of those, set for this vault: a renamed config folder, a profile kept elsewhere. Module
 * state on purpose (#181): each vault window runs its own copy of the plugin, and every toolset sets it from the
 * same settings before its tools run, so it cannot mix two vaults; passing it through every path check would not
 * make that safer.
 */
let extraProtected: [string, string][] = [];

/**
 * Protect Obsidian's config folder when the vault renamed it (`app.vault.configDir`), and the user profile when
 * memory keeps it outside `.memory/` (#135). Called with this vault's values before tools run.
 */
export function protectVaultPaths(paths: { configDir?: string; profilePath?: string }): void {
  extraProtected = [];
  const configDir = paths.configDir ? normalize(paths.configDir) : null;
  if (configDir) extraProtected.push([configDir, "holds Obsidian's own configuration"]);
  const profile = paths.profilePath ? normalize(paths.profilePath) : null;
  if (profile) extraProtected.push([profile, "is the profile the agent keeps of the user"]);
}

const INVALID_NAME_CHARS = new Set(['<', '>', ':', '"', '|', '?', '*']);
const RESERVED_NAMES = new Set(["CON", "PRN", "AUX", "NUL",
  ...Array.from({ length: 9 }, (_, i) => `COM${i + 1}`), ...Array.from({ length: 9 }, (_, i) => `LPT${i + 1}`)]);

/** A tool refused a path; its message is what the model is told, after "Error: ". */
export class PathError extends Error {}

/** The note's file name, with `.md` added when it is missing. */
export function noteFile(path: string): string {
  const cleaned = path.trim();
  if (!cleaned || cleaned.toLowerCase().endsWith(".md")) return cleaned;
  return `${cleaned}.md`;
}

/** Why *relativePath* cannot be a note file name (Windows' rules), or null if it can. */
export function checkNoteName(relativePath: string): string | null {
  for (const part of relativePath.replace(/\\/g, "/").split("/")) {
    if (!part || part === "." || part === "..") continue;
    const bad = [...new Set([...part].filter((c) => INVALID_NAME_CHARS.has(c) || c.charCodeAt(0) < 32))].sort();
    if (bad.length) {
      const shown = bad.map((c) => (c.charCodeAt(0) >= 32 ? pyRepr(c) : `\\x${c.charCodeAt(0).toString(16).padStart(2, "0")}`))
        .join(" ");
      return `${shown} not allowed in file or folder names ('${part}'); e.g. write times as 1100 or 11-00`;
    }
    if (part.endsWith(" ") || part.endsWith(".")) {
      return `file or folder names cannot end with a space or dot ('${part}')`;
    }
    if (RESERVED_NAMES.has(part.split(".")[0].toUpperCase())) {
      return `'${part.split(".")[0]}' is a reserved name on Windows`;
    }
  }
  return null;
}

/** Python's repr() of a one-character string, as the Python error messages show it. */
function pyRepr(c: string): string {
  return c === "'" ? `"'"` : `'${c}'`;
}

/** An agent's folders as the model is told them: `'Journal/Daily/'`, joined. */
function scopeFolders(scope: string[]): string {
  return scope.map((s) => `'${s.replace(/\/+$/, "")}/'`).join(", ");
}

/**
 * What a search that found nothing adds for a restricted agent: that only its folders were searched, so the note
 * the user means may well exist outside them. Without it the model tells the user the note does not exist.
 * Empty for an agent without a restriction.
 */
export function scopeHint(scope: string[] | null): string {
  if (!scope || !scope.length) return "";
  return ` (only ${scopeFolders(scope)} searched: this agent is restricted to those folders, so a note elsewhere `
    + "in the vault cannot be found or read by it — tell the user so rather than that the note does not exist)";
}

/** The system prompt's paragraph for a restricted agent; empty for one without a restriction. */
export function scopePrompt(scope: string[] | null): string {
  if (!scope || !scope.length) return "";
  return `\n\n---\nYou can only reach notes in ${scopeFolders(scope)}: the user restricted you to these folders. `
    + "Notes elsewhere in the vault exist, but your tools cannot find, read or change them. When the user asks "
    + "about a note you cannot find or open, say that it may lie outside the folders you are allowed to use, "
    + "and that another agent without this restriction can reach it. Never say such a note does not exist. "
    + "For the same reason you have no tools that could reach past these folders — MCP servers' tools, creating "
    + "TaskNotes: when the user asks for one, say that the folder restriction withholds it, and that it comes "
    + "back when the restriction is lifted.\n---";
}

/**
 * The vault-relative path *relativePath* stands for, or a PathError — the same refusals, with the same words, as
 * Python's `safe_resolve`: leaving the vault, Obsidian's own folder, the definition folders, and the scope.
 */
export function safeResolve(relativePath: string, scope: string[] | null = null): string {
  const resolved = normalize(relativePath);
  if (resolved === null) throw new PathError(`Path escape attempt blocked: '${relativePath}'`);
  // Without regard to letter case: on Windows and macOS '.Agents' is '.agents' (#135)
  for (const [folder, holds] of [...PROTECTED, ...extraProtected]) {
    if (within(resolved.toLowerCase(), folder.toLowerCase())) {
      throw new PathError(`'${folder}' ${holds} and is not reachable by tools`);
    }
  }
  if (scope && scope.length) {
    // A folder that names the vault itself or leaves it ('.', '..', '/') allows nothing, rather than everything (#135)
    const allowed = scope.map((s) => normalize(s.replace(/\/+$/, ""))).filter((d): d is string => Boolean(d));
    if (!allowed.some((d) => resolved === d || resolved.startsWith(`${d}/`))) {
      const shown = scope.map((s) => `'${s}'`).join(", ");
      throw new PathError(`Path '${relativePath}' is outside this agent's allowed scope (${shown})`);
    }
  }
  return resolved;
}

/** "a/./b/../c" → "a/c"; "" for the vault root; null when it leaves the vault or is absolute. */
export function normalize(path: string): string | null {
  const raw = path.replace(/\\/g, "/");
  if (raw.startsWith("/") || /^[A-Za-z]:/.test(raw)) return null;
  const parts: string[] = [];
  for (const part of raw.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (!parts.length) return null;
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  return parts.join("/");
}

/** Whether *path* is *folder* or inside it. */
export function within(path: string, folder: string): boolean {
  return path === folder || path.startsWith(`${folder}/`);
}

/** The last path segment without `.md` — Python's `Path.stem` for a note. */
export function stem(path: string): string {
  const name = basename(path);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

export function basename(path: string): string {
  const parts = path.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] ?? "";
}

/** Whether the last segment has an extension — Python's `Path.suffix` being non-empty. */
export function hasSuffix(path: string): boolean {
  const name = basename(path);
  const dot = name.lastIndexOf(".");
  return dot > 0 && dot < name.length - 1;
}

/**
 * *text* lowercased with its letters folded to their base form — "Büroumzug" → "buroumzug", "Straße" → "strasse" —
 * for matching a name a model wrote without its accents (#164).
 */
export function fold(text: string): string {
  return text.normalize("NFD").replace(/\p{M}+/gu, "").replace(/ß/g, "ss").toLowerCase().normalize("NFC");
}

/**
 * The system prompt's paragraph on how the note tools take paths and which one finds what — said once here, for
 * every agent with note tools, rather than in each tool's description or only in the bundled assistant (#165).
 * Empty for an agent without them.
 */
export function toolConventions(tools: string[]): string {
  const has = new Set(tools);
  const pathTools = ["read_note", "read_notes", "edit_note", "update_note", "append_to_note", "move_note",
                     "delete_note", "get_metadata", "update_metadata"];
  const ways: string[] = [];
  if (has.has("find_notes")) ways.push("find_notes by name");
  if (has.has("search_vault")) ways.push("search_vault by content");
  if (has.has("list_notes")) ways.push("list_notes by folder");
  const parts: string[] = [];
  if (pathTools.some((name) => has.has(name))) {
    parts.push("Note paths are relative to the vault and .md is optional; a note's name alone is enough when it is unique.");
  }
  if (ways.length > 1) parts.push(`To find a note, use ${ways.join(", ")}.`);
  // The note tools do not list images, PDFs and the like, which a model then took for missing (#235)
  if (has.has("list_attachments")) {
    parts.push("Files that are not notes (images, PDFs, Office files, recordings) are found with list_attachments"
               + (has.has("read_attachment") ? " and read with read_attachment." : "."));
  }
  // Small models edited the frontmatter as text, removing a property with edit_note in 11 of 20 probe runs (#246)
  if (has.has("update_metadata") && (has.has("edit_note") || has.has("update_note"))) {
    parts.push("Change a note's properties with update_metadata (to remove one, pass the value null); edit_note is "
               + "for the text below them.");
  }
  return parts.length ? `\n\n---\n${parts.join(" ")}\n---` : "";
}
