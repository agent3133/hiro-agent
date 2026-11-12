/**
 * read_note, read_notes, create_note, update_note, edit_note, append_to_note — ported from make_vault_tools
 * (src/obsidian_agent/tools/builtin/vault.py). Same results, same error texts, same limits. The tools that list —
 * list_notes, find_notes, list_attachments — are in listingTools.ts (#419).
 *
 * Differences from Python, on purpose: notes are written with "\n" line endings (Obsidian's), not the platform's;
 * listings use "/" on every platform (Python's list_notes used "\" on Windows).
 */

import { attachmentKind, isAttachment } from "../attachments";
import { checkNoteName, noteFile, PathError, safeResolve, stem } from "../paths";
import { modifyFile, resolveExistingNote, vaultNotes, type VaultPort } from "../vault";
import { namedDay } from "../dates";
import { getCloseMatches, ratio } from "../difflib";
import { brokenByWrite } from "../frontmatter";
import { appendToSection, findSection, headingNames } from "../sections";
import { introducedRisks, knownPluginBlock, risksSentence, type IsPluginBlock } from "../contentRisks";
import { removalSentence, removesMost } from "../removal";
import { defineTool, readArgs, type Args, type Tool } from "./tool";

/** Notes per read_notes call. */
export const READ_MANY_LIMIT = 20;
/** The least of a note read_notes shows, however many are asked for: less would tell the model nothing. */
const MIN_NOTE_SHARE = 600;

export interface VaultToolOptions {
  /** Which code-block languages another plugin runs, in this Obsidian (#395); a list of known ones elsewhere. */
  isPluginBlock?: IsPluginBlock;
}

export function makeVaultTools(vault: VaultPort, scope: string[] | null = null, options: VaultToolOptions = {}): Tool[] {
  const refused = (error: unknown): string => {
    if (error instanceof PathError) return `Error: ${error.message}`;
    throw error;
  };
  const isPluginBlock = options.isPluginBlock ?? knownPluginBlock;

  /**
   * What a write would add to its note that loads or runs by itself when Obsidian shows it (#395): a remote image,
   * an HTML tag with a remote address, another plugin's code block. What the note already has is not counted; a
   * note the tool cannot find counts as empty (the tool then answers with its own error).
   */
  const addedRisks = async (tool: string, args: Record<string, unknown>): Promise<string[]> => {
    // Read from the arguments as sent, for the question (confirmArgs gets them raw) as for the run
    const str = (key: string): string => (typeof args[key] === "string" ? args[key] : "");
    if (tool === "edit_note") return introducedRisks(str("old_text"), str("new_text"), isPluginBlock);
    const added = tool === "append_to_note" ? str("text") : str("content");
    if (!added) return [];
    let current = "";
    try {
      const resolved = safeResolve(noteFile(str("path")), scope);
      if (await vault.isFile(resolved)) current = await vault.read(resolved);
    } catch {
      current = "";
    }
    return introducedRisks(current, tool === "append_to_note" ? `${current}\n${added}` : added, isPluginBlock);
  };
  /** The arguments a confirmation shows, with what the note would load or run said (`ConfirmModal.describe`). */
  const withRisks = async (tool: string, shown: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const risks = await addedRisks(tool, shown);
    // The note as the tool names it, `.md` and all, as the loop's default confirmArgs shows it
    const named = typeof shown.path === "string" ? { ...shown, path: noteFile(shown.path) } : shown;
    return risks.length ? { ...named, when_shown: risksSentence(risks) } : named;
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
    // Replacing a note that exists is overwriting it: asked about like update_note (#157). A new note is not,
    // unless it would load or run something by itself when shown (#395)
    destructiveWhen: async (args) => {
      if ((await addedRisks("create_note", args)).length) return true;
      if (!args.bool("overwrite")) return false;
      const path = noteFile(args.str("path"));
      if (checkNoteName(path)) return false;  // refused by the tool itself
      try {
        return await vault.isFile(safeResolve(path, scope));
      } catch {
        return false;  // outside the agent's folders: refused by the tool itself
      }
    },
    confirmArgs: async (args) => withRisks("create_note", args),
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
      return withRisks("update_note", { ...args, path: resolved || noteFile(String(args.path ?? "")) });
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
  }, {
    // Text that would load or run something by itself when the note is shown is asked about (#395)
    destructiveWhen: async (args) => (await addedRisks("append_to_note", args)).length > 0,
    confirmArgs: async (args) => withRisks("append_to_note", args),
  });

  /**
   * edit_note's edit of the text *read*: the new text, or only the answer when it cannot be made. Used to run the
   * edit and, before that, to ask about one that removes most of the note (#404).
   */
  const planEdit = (read: string, args: Args, path: string, note: string): { text?: string; answer: string } => {
    // Line endings do not decide a match (#161): compared as "\n", written back as the note has them
    const crlf = read.includes("\r\n");
    const lf = (value: string): string => value.replace(/\r\n/g, "\n");
    const text = lf(read);
    const wanted = lf(args.str("old_text"));
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

  /** The note edit_note would change, its text and its text after the edit; null when the edit would fail. */
  const plannedEdit = async (args: Args): Promise<{ note: string; before: string; after: string } | null> => {
    const path = noteFile(args.str("path"));
    if (!args.str("old_text") || checkNoteName(path)) return null;
    try {
      const { note, error } = await resolveExistingNote(vault, path, scope);
      if (error || !note) return null;
      const before = await vault.read(note);
      const planned = planEdit(before, args, path, note);
      return planned.text === undefined ? null : { note, before, after: planned.text };
    } catch {
      return null;  // refused by the tool itself
    }
  };

  const editNote = defineTool("edit_note", async (args) => {
    const path = noteFile(args.str("path"));
    const problem = checkNoteName(path);
    if (problem) return `Error: invalid note path '${path}': ${problem}`;
    const oldText = args.str("old_text");
    if (!oldText) return "Error: old_text must not be empty; use append_to_note or update_note instead";
    const { note, error } = await resolveExistingNote(vault, path, scope);
    if (error) return error;
    const edit = (read: string): { text?: string; answer: string } => planEdit(read, args, path, note!);
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
  }, {
    // New text that would load or run something by itself when the note is shown is asked about (#395), and so is
    // an edit that takes most of the note away (#404)
    destructiveWhen: async (args) => {
      if ((await addedRisks("edit_note", args)).length > 0) return true;
      const planned = await plannedEdit(args);
      return planned !== null && removesMost(planned.before, planned.after) !== null;
    },
    // The question shows the note as the edit would leave it, so the dialog can draw what goes (ConfirmModal)
    confirmArgs: async (args) => {
      const shown = await withRisks("edit_note", args);
      let read: Args;
      try {
        read = readArgs(editNote, args);
      } catch {
        return shown;  // arguments the tool refuses: it says so when it runs
      }
      const planned = await plannedEdit(read);
      const share = planned ? removesMost(planned.before, planned.after) : null;
      if (!planned || share === null) return shown;
      return { ...shown, path: planned.note, removes: removalSentence(share), planned_content: planned.after };
    },
  });

  return [readNote, readNotes, createNote, updateNote, editNote, appendToNote];
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
