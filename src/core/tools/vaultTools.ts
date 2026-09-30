/**
 * read_note, read_notes, create_note, update_note, edit_note, append_to_note, list_notes, find_notes — ported from
 * make_vault_tools
 * (src/obsidian_agent/tools/builtin/vault.py). Same results, same error texts, same limits.
 *
 * Differences from Python, on purpose: notes are written with "\n" line endings (Obsidian's), not the platform's;
 * listings use "/" on every platform (Python's list_notes used "\" on Windows).
 */

import { fnmatch } from "../fnmatch";
import { basename, checkNoteName, noteFile, PathError, safeResolve, scopeHint } from "../paths";
import { notFound, resolveExistingNote, suggestFolders, suggestNotes, vaultFiles, vaultNotes, type VaultPort } from "../vault";
import { defineTool, type Tool } from "./tool";

/** Notes per listing: "list everything" in a vault of a few hundred notes would crowd out the context. */
export const LIST_LIMIT = 100;
/** Notes per read_notes call. */
export const READ_MANY_LIMIT = 20;

export function makeVaultTools(vault: VaultPort, scope: string[] | null = null): Tool[] {
  const refused = (error: unknown): string => {
    if (error instanceof PathError) return `Error: ${error.message}`;
    throw error;
  };

  const readNote = defineTool("read_note", async (args) => {
    const { note, error } = await resolveExistingNote(vault, args.str("path"), scope);
    return error || vault.read(note!);
  });

  const readNotes = defineTool("read_notes", async (args) => {
    const paths = (args.paths as string[] | undefined) ?? [];
    if (!paths.length) return "Error: no paths given";
    const sections: string[] = [];
    for (const path of paths.slice(0, READ_MANY_LIMIT)) {
      const { note, error } = await resolveExistingNote(vault, String(path), scope);
      sections.push(`## ${note ?? path}\n${error || (await vault.read(note!))}`);
    }
    if (paths.length > READ_MANY_LIMIT) {
      sections.push(`[${paths.length - READ_MANY_LIMIT} more path(s) ignored; read at most ${READ_MANY_LIMIT} notes per call]`);
    }
    return sections.join("\n\n");
  });

  const createNote = defineTool("create_note", async (args) => {
    const path = noteFile(args.str("path"));
    const problem = checkNoteName(path);
    if (problem) return `Error: invalid note path '${path}': ${problem}`;
    let resolved: string;
    try {
      resolved = safeResolve(path, scope);
    } catch (error) {
      return refused(error);
    }
    if (!args.bool("overwrite") && ((await vault.isFile(resolved)) || (await vault.isFolder(resolved)))) {
      return `Error: note already exists at '${path}'`;
    }
    await vault.write(resolved, args.str("content"));
    return `Created note at '${path}'`;
  });

  /** The note an existing-note tool writes to, or the error to return (update_note, append_to_note). */
  const existing = async (raw: string): Promise<{ path: string; resolved: string; error: string }> => {
    const path = noteFile(raw);
    const problem = checkNoteName(path);
    if (problem) return { path, resolved: "", error: `Error: invalid note path '${path}': ${problem}` };
    let resolved: string;
    try {
      resolved = safeResolve(path, scope);
    } catch (error) {
      return { path, resolved: "", error: refused(error) };
    }
    if (!((await vault.isFile(resolved)) || (await vault.isFolder(resolved)))) {
      return { path, resolved, error: notFound("note", path, await suggestNotes(vault, path, scope)) };
    }
    return { path, resolved, error: "" };
  };

  const updateNote = defineTool("update_note", async (args) => {
    const { path, resolved, error } = await existing(args.str("path"));
    if (error) return error;
    await vault.write(resolved, args.str("content"));
    return `Updated note at '${path}'`;
  }, { destructive: true });

  const appendToNote = defineTool("append_to_note", async (args) => {
    const { path, resolved, error } = await existing(args.str("path"));
    if (error) return error;
    await vault.write(resolved, (await vault.read(resolved)) + "\n" + args.str("text"));
    return `Appended to note at '${path}'`;
  });

  const editNote = defineTool("edit_note", async (args) => {
    const path = noteFile(args.str("path"));
    const problem = checkNoteName(path);
    if (problem) return `Error: invalid note path '${path}': ${problem}`;
    const oldText = args.str("old_text");
    if (!oldText) return "Error: old_text must not be empty; use append_to_note or update_note instead";
    const { note, error } = await resolveExistingNote(vault, path, scope);
    if (error) return error;
    const text = await vault.read(note!);
    const occurrences = text.split(oldText).length - 1;
    if (occurrences === 0) {
      return `Error: old_text not found in '${path}'. Read the note and copy the text exactly, `
             + "including indentation and list markers.";
    }
    if (occurrences > 1 && !args.bool("replace_all")) {
      return `Error: old_text appears ${occurrences} times in '${path}'. Include more surrounding `
             + "text to make it unique, or pass replace_all=true.";
    }
    await vault.write(note!, text.split(oldText).join(args.str("new_text")));
    return `Edited '${note}' (${occurrences} replacement${occurrences > 1 ? "s" : ""})`;
  });

  const listNotes = defineTool("list_notes", async (args) => {
    const path = args.str("path");
    const recursive = args.bool("recursive");
    const limit = args.int("limit");
    const listing = (paths: string[], empty = ""): string => {
      if (!paths.length) return empty;
      const shown = paths.slice(0, limit);
      const left = paths.length - shown.length;
      return shown.join("\n") + (left ? `\n[${left} more, name a folder to narrow the list]` : "");
    };
    // Python's glob/rglob, which — unlike the other tools — do include notes in dot folders
    const under = async (base: string): Promise<string[]> => (await vault.files())
      .filter((file) => file.endsWith(".md") && (base ? file.startsWith(`${base}/`) : true))
      .filter((file) => recursive || !file.slice(base ? base.length + 1 : 0).includes("/"));

    if (path) {
      let base: string;
      try {
        base = safeResolve(path, scope);
      } catch (error) {
        return refused(error);
      }
      if (!(await vault.isFolder(base))) return notFound("folder", path, await suggestFolders(vault, path, scope));
      return listing((await under(base)).sort(), `No notes in '${path}'`);
    }
    if (scope && scope.length) {
      const all: string[] = [];
      for (const s of scope) {
        const dir = s.replace(/\/+$/, "");
        if (!(await vault.isFolder(dir))) continue;
        all.push(...(await under(dir)));
      }
      return listing(all.sort());
    }
    return listing((await under("")).sort());
  });

  const findNotes = defineTool("find_notes", async (args) => {
    const pattern = args.str("pattern");
    const folder = args.str("folder");
    const limit = args.int("limit");
    const needle = pattern.replace(/\\/g, "/").trim().replace(/^"+|"+$/g, "").toLowerCase();
    if (!needle) return "Error: pattern must not be empty";
    const wild = needle.includes("*") || needle.includes("?");
    const wantedFolder = folder.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "").toLowerCase();
    const matching = (candidates: string[]): string[] => candidates.filter((rel) => {
      if (folder && !rel.toLowerCase().startsWith(`${wantedFolder}/`)) return false;
      const haystack = rel.toLowerCase();
      return wild ? fnmatch(haystack, needle) || fnmatch(basename(haystack), needle) : haystack.includes(needle);
    });
    // A pattern naming another file type (`*.png`, `report.pdf`) asks for attachments, which Python's find_notes
    // never finds — a model then told the user the vault had no images (#95). Those files are searched first; a
    // note whose name merely has a dot in it ("Meeting 26.09", "v1.2") is still found when no file matches.
    const extension = /\.([a-z][a-z0-9]{0,7})$/.exec(needle)?.[1];
    let matches: string[] = [];
    if (extension !== undefined && extension !== "md") {
      const files = matching(await vaultFiles(vault, scope, (file) => file.toLowerCase().endsWith(`.${extension}`)));
      if (files.length) return attachmentList(files.sort(), limit);
      matches = matching(await vaultNotes(vault, scope));
      if (!matches.length) return `No files or notes match '${pattern}'${scopeHint(scope)}`;
    } else {
      matches = matching(await vaultNotes(vault, scope));
    }
    if (!matches.length) {
      const hint = await suggestNotes(vault, pattern, scope);
      return `No notes match '${pattern}'${scopeHint(scope)}`
        + (hint.length ? `. Closest: ${hint.map((h) => `'${h}'`).join(", ")}` : "");
    }
    const sorted = matches.sort();
    return sorted.slice(0, limit).join("\n") + (sorted.length > limit ? `\n[${sorted.length - limit} more]` : "");
  });

  // Python's order (make_vault_tools), so the model sees the tools as it does from the runtime
  return [readNote, readNotes, createNote, updateNote, editNote, appendToNote, listNotes, findNotes];
}

/** find_notes' answer for attachments: the files, and that they are read with read_attachment, not read_note. */
function attachmentList(found: string[], limit: number): string {
  const shown = found.slice(0, limit).join("\n") + (found.length > limit ? `\n[${found.length - limit} more]` : "");
  return `${shown}\n(Attachments, not notes: read_attachment reads images, PDFs and recordings; read_note does not.)`;
}
