/**
 * read_note, read_notes, create_note, update_note, edit_note, append_to_note, list_notes, find_notes — ported from
 * make_vault_tools
 * (src/obsidian_agent/tools/builtin/vault.py). Same results, same error texts, same limits.
 *
 * Differences from Python, on purpose: notes are written with "\n" line endings (Obsidian's), not the platform's;
 * listings use "/" on every platform (Python's list_notes used "\" on Windows).
 */

import { attachmentKind, isAttachment, readableSize } from "../attachments";
import { fnmatch } from "../fnmatch";
import { basename, checkNoteName, noteFile, PathError, safeResolve, scopeHint, stem, within } from "../paths";
import {
  hiddenBelow, modifyFile, newestFirst, resolveExistingNote, resolveFolder, suggestNotes, vaultFiles,
  vaultNotes, type VaultPort,
} from "../vault";
import { namedDay } from "../dates";
import { getCloseMatches, ratio } from "../difflib";
import { brokenByWrite } from "../frontmatter";
import { appendToSection, findSection, headingNames } from "../sections";
import { defineTool, type Args, type Tool } from "./tool";

/** Notes per listing: "list everything" in a vault of a few hundred notes would crowd out the context. */
export const LIST_LIMIT = 100;
/** Notes per read_notes call. */
export const READ_MANY_LIMIT = 20;
/** Attachments find_notes names when notes match as well (#248). */
const ATTACHMENTS_NAMED = 3;
/** The least of a note read_notes shows, however many are asked for: less would tell the model nothing. */
const MIN_NOTE_SHARE = 600;

export function makeVaultTools(vault: VaultPort, scope: string[] | null = null): Tool[] {
  const refused = (error: unknown): string => {
    if (error instanceof PathError) return `Error: ${error.message}`;
    throw error;
  };
  // New notes create_note held back for a similar name, this answer (#269): the toolset is made per answer
  const heldBack = new Set<string>();

  const readNote = defineTool("read_note", async (args) => {
    // A canvas is not a note: say which tool reads it, rather than that no note of that name exists (#214)
    if (/\.canvas$/i.test(args.str("path").trim())) {
      return `Error: '${args.str("path").trim()}' is a canvas, not a note; read it with read_attachment`;
    }
    const { note, error } = await resolveExistingNote(vault, args.str("path"), scope);
    if (error) return error;
    // An image's bytes are no answer: say which tool reads it (#235)
    if (isAttachment(note!)) return isBase(note!) ? baseDefinition(await vault.read(note!)) : notANote(note!);
    const text = await vault.read(note!);
    const heading = args.str("heading");
    // A note named by a date ends with its weekday: "by Friday" in it is resolved against that day (#261)
    const day = namedDay(note!) ? `\n\n[${namedDay(note!)}.]` : "";
    if (!heading) return text + day;
    // One section, for a long note on a small window: note_outline shows which there are (#166)
    const lf = text.replace(/\r\n/g, "\n");
    const section = findSection(lf, heading);
    if (!section) return noSection(note!, heading, lf);
    return lf.slice(section.start, section.end).replace(/\s+$/, "") + day;
  });

  /** The notes read_notes asked for, each as heading and text, with the paths it leaves out for being too many. */
  const readMany = async (args: Args, room = Infinity): Promise<string> => {
    const paths = (args.paths as string[] | undefined) ?? [];
    if (!paths.length) return "Error: no paths given";
    const asked = paths.slice(0, READ_MANY_LIMIT);
    // Each note gets its share of the room, so a long first note does not push the others out of the answer (#160)
    const share = Number.isFinite(room) ? Math.max(MIN_NOTE_SHARE, Math.floor(room / asked.length) - 80) : Infinity;
    const sections: string[] = [];
    const unread: string[] = [];
    let used = 0;
    for (const path of asked) {
      const { note, error } = await resolveExistingNote(vault, String(path), scope);
      const name = note ?? String(path);
      if (used >= room) {
        unread.push(name);
        continue;
      }
      let text = error || (!isAttachment(note!) ? await vault.read(note!)
        : isBase(note!) ? baseDefinition(await vault.read(note!)) : notANote(note!));
      if (text.length > share) {
        text = `${text.slice(0, share)}\n[Cut to ${share} of ${text.length} characters to fit the context window; `
          + `read_note('${name}') gives all of it]`;
      }
      const day = !error && namedDay(name) ? ` (${namedDay(name)})` : "";
      const section = `## ${name}${day}\n${text}`;
      used += section.length + 2;
      sections.push(section);
    }
    if (unread.length) {
      sections.push(`[Not read, no room left in the context window: ${unread.join(", ")} — call read_notes again `
                    + "with these]");
    }
    if (paths.length > READ_MANY_LIMIT) {
      sections.push(`[${paths.length - READ_MANY_LIMIT} more path(s) ignored; read at most ${READ_MANY_LIMIT} notes per call]`);
    }
    return sections.join("\n\n");
  };
  const readNotes = defineTool("read_notes", (args) => readMany(args), { within: readMany });

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
    // Frontmatter that does not parse shows no properties in Obsidian: refused, so the model can fix it (#252)
    const exists = await vault.isFile(resolved);
    const before = exists ? await vault.read(resolved) : "";
    const broken = brokenByWrite(before, args.str("content"));
    if (broken) return broken;
    // "Thomas Becker" next to People/Tom Becker.md: asked about before the note exists, as a hint after it came too
    // late — the model passed it on instead of using the other note (#265, #269). Two people may share a surname:
    // the same call again creates it
    if (!exists && !heldBack.has(resolved)) {
      const folder = resolved.includes("/") ? resolved.slice(0, resolved.lastIndexOf("/")) : "";
      const siblings = (await vaultNotes(vault, scope)).filter((rel) => rel !== resolved
        && (rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "") === folder);
      const similar = similarNames(stem(resolved), siblings);
      if (similar.length) {
        heldBack.add(resolved);
        return `Not created yet: ${similar.join(", ")} ${similar.length > 1 ? "have" : "has"} a similar name. If it is `
          + "the same person or thing, use that note; if not, call create_note again with the same path.";
      }
    }
    await vault.write(resolved, args.str("content"));
    return `Created note at '${path}'`;
  }, {
    // Replacing a note that exists is overwriting it: asked about like update_note (#157). A new note is not
    destructiveWhen: async (args) => {
      if (!args.bool("overwrite")) return false;
      const path = noteFile(args.str("path"));
      if (checkNoteName(path)) return false;  // refused by the tool itself
      try {
        return await vault.isFile(safeResolve(path, scope));
      } catch {
        return false;  // outside the agent's folders: refused by the tool itself
      }
    },
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
    if (await vault.isFile(resolved)) return { path, resolved, error: "" };
    // A wrong folder or a bare name finds the one note of that name, as read_note does (#159)
    const found = await resolveExistingNote(vault, path, scope);
    if (found.note) return { path: found.note, resolved: found.note, error: "" };
    return { path, resolved, error: found.error };
  };

  const updateNote = defineTool("update_note", async (args) => {
    const { path, resolved, error } = await existing(args.str("path"));
    if (error) return error;
    const broken = brokenByWrite(await vault.read(resolved), args.str("content"));
    if (broken) return broken;
    await vault.write(resolved, args.str("content"));
    return `Updated note at '${path}'`;
  }, {
    destructive: true,
    // The question names the note that really changes, found as the tool finds it (#159)
    confirmArgs: async (args) => {
      const { resolved } = await existing(String(args.path ?? ""));
      return { ...args, path: resolved || noteFile(String(args.path ?? "")) };
    },
  });

  const appendToNote = defineTool("append_to_note", async (args) => {
    const { path, resolved, error } = await existing(args.str("path"));
    if (error) return error;
    // One line break between the note and the text, none for an empty note (#164); applied to the note as it is
    // when written, so the user's typing meanwhile is kept
    const addition = args.str("text");
    const heading = args.str("heading");
    if (heading) {
      // At the end of one section — "add under ## Tasks" — rather than an exact anchor for edit_note (#166)
      const current = (await vault.read(resolved)).replace(/\r\n/g, "\n");
      if (!findSection(current, heading)) return noSection(resolved, heading, current);
      let added = false;
      await modifyFile(vault, resolved, (text) => {
        const crlf = text.includes("\r\n");
        const lf = text.replace(/\r\n/g, "\n");
        const section = findSection(lf, heading);
        if (!section) return text;
        added = true;
        const result = appendToSection(lf, section, addition.replace(/\r\n/g, "\n"));
        return crlf ? result.replace(/\n/g, "\r\n") : result;
      });
      return added ? `Appended to the section '${heading.replace(/^#+\s*/, "")}' of '${path}'`
        : noSection(resolved, heading, await vault.read(resolved));
    }
    const appended = (text: string): string => (!text ? addition : text.endsWith("\n") ? text + addition
      : `${text}\n${addition}`);
    // Text appended to an empty note can be the note's frontmatter (#252)
    const current = await vault.read(resolved);
    const broken = brokenByWrite(current, appended(current));
    if (broken) return broken;
    await modifyFile(vault, resolved, appended);
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
    const edit = (read: string): { text?: string; answer: string } => {
      // Line endings do not decide a match (#161): compared as "\n", written back as the note has them
      const crlf = read.includes("\r\n");
      const lf = (value: string): string => value.replace(/\r\n/g, "\n");
      const text = lf(read);
      const wanted = lf(oldText);
      const replacement = lf(args.str("new_text"));
      const back = (value: string): string => (crlf ? value.replace(/\n/g, "\r\n") : value);
      const occurrences = text.split(wanted).length - 1;
      if (occurrences === 0) {
        // Spaces a model added or dropped at the ends of lines: one such match, and only it, is replaced
        const loose = looseMatches(text, wanted);
        if (loose.length === 1) {
          const [start, end] = loose[0];
          return { text: back(text.slice(0, start) + replacement + text.slice(end)),
                   answer: `Edited '${note}' (1 replacement, ignoring spaces at line ends)` };
        }
        const closest = closestLine(text, wanted);
        return { answer: `Error: old_text not found in '${path}'. Read the note and copy the text exactly, `
                         + "including indentation and list markers."
                         + (closest ? ` The closest line in the note is: '${closest}'` : "") };
      }
      if (occurrences > 1 && !args.bool("replace_all")) {
        return { answer: `Error: old_text appears ${occurrences} times in '${path}'. Include more surrounding `
                         + "text to make it unique, or pass replace_all=true." };
      }
      return { text: back(text.split(wanted).join(replacement)),
               answer: `Edited '${note}' (${occurrences} replacement${occurrences > 1 ? "s" : ""})` };
    };
    // Checked first, so a failed edit writes nothing; then applied again to the note as it is when written (#164)
    const original = await vault.read(note!);
    const planned = edit(original);
    if (planned.text === undefined) return planned.answer;
    const broken = brokenByWrite(original, planned.text);
    if (broken) return broken;
    let answer = planned.answer;
    await modifyFile(vault, note!, (current) => {
      const done = edit(current);
      answer = done.answer;
      return done.text ?? current;
    });
    return answer;
  });

  const listNotes = defineTool("list_notes", async (args) => {
    const path = args.str("path");
    const recursive = args.bool("recursive");
    const limit = args.int("limit");
    // Quotes a model put around the path, and an empty one ('""'), are no folder to look for (#159)
    const asked = path.trim().replace(/^"+|"+$/g, "");
    const byModified = args.str("sort").toLowerCase() === "modified";
    const listing = async (found: string[], empty = ""): Promise<string> => {
      if (!found.length) return empty;
      // Newest first, each with its day, the folders still first (#166)
      const paths = byModified ? [...found.filter((p) => p.endsWith("/")),
                                  ...(await newestFirst(vault, found.filter((p) => !p.endsWith("/"))))] : found;
      const shown = paths.slice(0, limit);
      const left = paths.length - shown.length;
      return shown.join("\n") + (left ? `\n[${left} more, name a folder to narrow the list]` : "");
    };
    // Not the notes below a dot folder — .sessions, .memory, .trash — as no other tool shows them either, and none
    // may read them (#158). Naming one (.trash, to restore from it) lists what is directly in it.
    const notesUnder = async (base: string): Promise<string[]> => (await vault.files())
      .filter((file) => file.endsWith(".md") && (base ? file.startsWith(`${base}/`) : true))
      .filter((file) => !hiddenBelow(file, base))
      .filter((file) => recursive || !file.slice(base ? base.length + 1 : 0).includes("/"));
    // Not recursive: the folders directly inside too, first, as "Name/", so one call shows where notes live (#159)
    const foldersIn = async (base: string): Promise<string[]> => recursive ? [] : (await vault.folders())
      .filter((folder) => (base ? folder.startsWith(`${base}/`) : true))
      .filter((folder) => !folder.slice(base ? base.length + 1 : 0).includes("/"))
      .filter((folder) => !hiddenBelow(`${folder}/x`, base))
      .sort().map((folder) => `${folder}/`);
    const under = async (base: string): Promise<string[]> => [...(await foldersIn(base)), ...(await notesUnder(base)).sort()];
    // A folder's attachments are not listed, only counted, with the tool that lists them (#235): a model looking
    // for "the invoice in my Inbox" otherwise decides it is not there
    const attachmentsIn = async (base: string): Promise<string> => {
      const count = (await vault.files()).filter((file) => isAttachment(file)
        && (base ? file.startsWith(`${base}/`) : true) && !hiddenBelow(file, base)
        && (recursive || !file.slice(base ? base.length + 1 : 0).includes("/"))).length;
      return count ? `[and ${count} attachment(s)${base ? ` in '${base}'` : ""}: list_attachments lists them, or find_notes with their type, such as '*.pdf']` : "";
    };
    const withAttachments = async (text: string, base: string): Promise<string> => {
      const more = await attachmentsIn(base);
      return more ? (text ? `${text}\n${more}` : more) : text;
    };

    // "." and "/" are the vault itself: the folder "" that resolveFolder finds for them is no error (#235)
    if (asked && !/^[./]+$/.test(asked)) {
      const { folder, error } = await resolveFolder(vault, asked, scope);
      if (folder === null) return error;
      return withAttachments(await listing(await under(folder), `No notes in '${folder}'`), folder);
    }
    if (scope && scope.length) {
      const all: string[] = [];
      for (const s of scope) {
        const dir = s.replace(/\/+$/, "");
        if (!(await vault.isFolder(dir))) continue;
        all.push(...(await under(dir)));
      }
      return listing(all);
    }
    return withAttachments(await listing(await under("")), "");
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
      // A folder in the pattern matches at any depth: 'Projects/*' finds TaskNotes/Projects/x.md too (#159)
      return wild ? fnmatch(haystack, needle) || fnmatch(basename(haystack), needle)
                    || (needle.includes("/") && !needle.startsWith("/") && fnmatch(haystack, `*/${needle}`))
        : haystack.includes(needle);
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
      // No note by that name, but an attachment: "the kickoff slides", "Pasted image*", "*png" (#235)
      const files = matching(await vaultFiles(vault, scope, isAttachment));
      if (files.length) return `No notes match '${pattern}', but these attachments do:\n${attachmentList(files.sort(), limit)}`;
      // With a folder, the closest names in that folder first: '2026-10-05' in Journal/Daily suggested two
      // clippings next to the daily note (2026-10-05). Outside the agent's folders it suggests nothing extra
      const asked = folder.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
      const inside = asked && (!scope?.length || scope.some((root) => within(asked, root.replace(/\/+$/, ""))));
      let hint = inside ? await suggestNotes(vault, pattern, [asked]) : [];
      const where = hint.length ? ` in '${asked}'` : "";
      if (!hint.length) hint = await suggestNotes(vault, pattern, scope);
      return `No notes match '${pattern}'${scopeHint(scope)}`
        + (hint.length ? `. Closest${where}: ${hint.map((h) => `'${h}'`).join(", ")}` : "");
    }
    const sorted = args.str("sort").toLowerCase() === "modified" ? await newestFirst(vault, matches) : matches.sort();
    const listed = sorted.slice(0, limit).join("\n") + (sorted.length > limit ? `\n[${sorted.length - limit} more]` : "");
    // Notes matched, and an attachment by the same name may be what was meant: "the kickoff slides" found the
    // project note and never showed the deck beside it (#248). A pattern naming a file type was answered above.
    const alsoFiles = extension === undefined ? matching(await vaultFiles(vault, scope, isAttachment)).sort() : [];
    if (!alsoFiles.length) return listed;
    const named = alsoFiles.slice(0, ATTACHMENTS_NAMED).join(", ")
      + (alsoFiles.length > ATTACHMENTS_NAMED ? `, and ${alsoFiles.length - ATTACHMENTS_NAMED} more` : "");
    return `${listed}\n[and ${alsoFiles.length} attachment(s) match too: ${named}; read_attachment reads them]`;
  });

  const listAttachments = defineTool("list_attachments", async (args) => {
    const asked = args.str("path").replace(/\\/g, "/").trim().replace(/^"+|"+$/g, "");
    const pattern = args.str("pattern");
    const needle = pattern.replace(/\\/g, "/").trim().replace(/^"+|"+$/g, "").toLowerCase();
    const limit = args.int("limit");
    let base = "";
    if (asked && !/^[./]+$/.test(asked)) {
      const { folder, error } = await resolveFolder(vault, asked, scope);
      if (folder === null) return error;
      base = folder;
    }
    const found = (await vaultFiles(vault, scope, (file) => isAttachment(file) && (!base || file.startsWith(`${base}/`))))
      .filter((file) => !needle || pathMatches(file, needle));
    if (!found.length) {
      return `No attachments${base ? ` in '${base}'` : ""}${needle ? ` match '${pattern}'` : ""}${scopeHint(scope)}`;
    }
    const dated = args.str("sort").toLowerCase() === "modified" && vault.modified;
    const times = new Map<string, number>();
    if (dated) for (const file of found) times.set(file, await vault.modified!(file).catch(() => 0));
    const sorted = dated ? found.sort((a, b) => times.get(b)! - times.get(a)! || (a < b ? -1 : 1)) : found.sort();
    const lines: string[] = [];
    for (const file of sorted.slice(0, limit)) {
      const facts = [attachmentKind(file)];
      if (vault.size) facts.push(readableSize(await vault.size(file).catch(() => 0)));
      if (dated) facts.push(`changed ${day(times.get(file)!)}`);
      lines.push(`${file} (${facts.join(", ")})`);
    }
    const left = sorted.length - lines.length;
    return lines.join("\n") + (left ? `\n[${left} more; name a folder or a pattern to narrow the list]` : "")
      + "\n(read_attachment reads them)";
  });

  // Python's order (make_vault_tools), so the model sees the tools as it does from the runtime
  return [readNote, readNotes, createNote, updateNote, editNote, appendToNote, listNotes, findNotes, listAttachments];
}

/**
 * The notes in *siblings* whose name is close to *name* (#265), at most two: the same last word and first words
 * with the same initial (Thomas Becker, T. Becker, Tom Becker), or nearly the same name. Names with digits are
 * left out of the second test, or every daily note would be close to the next day's.
 */
export function similarNames(name: string, siblings: string[]): string[] {
  const fold = (text: string): string => text.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "");
  const words = (text: string): string[] => fold(text).split(/[\s._-]+/).filter(Boolean);
  const mine = words(name);
  return siblings.filter((rel) => {
    // A name with a number in it is a dated or numbered note, not a person or a thing: "2026-09-16 Website Relaunch
    // Review" is not "2026-08-21 Analytics Roadmap Review", though both end in "Review" and start with a 2 (2026-10-06)
    if (/\d/.test(name + stem(rel))) return false;
    const theirs = words(stem(rel));
    if (mine.length > 1 && theirs.length > 1 && mine.at(-1) === theirs.at(-1) && mine[0][0] === theirs[0][0]) return true;
    return ratio(fold(name), fold(stem(rel))) >= 0.85;
  }).slice(0, 2);
}

/** read_note's answer for a file that is not a note (#235). */
function isBase(path: string): boolean {
  return /\.base$/i.test(path);
}

/**
 * read_note's answer for a .base file: its definition, which is text. Sending the model to read_attachment, which
 * did not read Bases, left it no way to see a Base's YAML at all (2026-10-05).
 */
function baseDefinition(text: string): string {
  return `${text.replace(/\s+$/, "")}\n\n[The definition of a Base (YAML). query_base runs it and returns its rows.]`;
}

function notANote(path: string): string {
  return `Error: '${path}' is an attachment (${attachmentKind(path)}), not a note; read it with read_attachment`;
}

/** Whether a vault path matches a find_notes pattern: wildcards against the path or the file name, else a substring. */
function pathMatches(rel: string, needle: string): boolean {
  const haystack = rel.toLowerCase();
  if (!(needle.includes("*") || needle.includes("?"))) return haystack.includes(needle);
  // A folder in the pattern matches at any depth: 'Projects/*' finds TaskNotes/Projects/x.md too (#159)
  return fnmatch(haystack, needle) || fnmatch(basename(haystack), needle)
    || (needle.includes("/") && !needle.startsWith("/") && fnmatch(haystack, `*/${needle}`));
}

/** A local day, YYYY-MM-DD. */
function day(time: number): string {
  const date = new Date(time);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** find_notes' answer for attachments: the files, and that they are read with read_attachment, not read_note. */
function attachmentList(found: string[], limit: number): string {
  const shown = found.slice(0, limit).join("\n") + (found.length > limit ? `\n[${found.length - limit} more]` : "");
  return `${shown}\n(Attachments, not notes: read_attachment reads images, PDFs and recordings; read_note does not.)`;
}

/** Where *wanted* appears in *text* when spaces and tabs at the ends of lines are not counted (#161). */
export function looseMatches(text: string, wanted: string): [number, number][] {
  const lines = wanted.split("\n").map((line) => line.replace(/[ \t]+$/, ""));
  if (!lines.join("").trim()) return [];
  const escape = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(lines.map(escape).join("[ \\t]*\n") + (lines[lines.length - 1] ? "" : "[ \\t]*"), "g");
  return [...text.matchAll(pattern)].map((match) => [match.index ?? 0, (match.index ?? 0) + match[0].length]);
}

/** The line of *text* most like the first line of *wanted*, for an error that shows what is there. */
function closestLine(text: string, wanted: string): string {
  const first = wanted.split("\n").map((line) => line.trim()).find(Boolean) ?? "";
  if (!first) return "";
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  return getCloseMatches(first, lines, 1, 0.6)[0] ?? "";
}

/** The error for a heading a note does not have, naming the ones it has. */
function noSection(note: string, heading: string, text: string): string {
  const names = headingNames(text);
  return `Error: no heading '${heading.replace(/^#+\s*/, "")}' in '${note}'. `
    + (names.length ? `Its headings: ${names.map((name) => `'${name}'`).join(", ")}` : "It has no headings.");
}
