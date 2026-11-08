/**
 * Where import_attachment puts an attachment's text in a note (#331) — in the core, so it is tested without Obsidian.
 * A new note gets the text (under *heading* when one is given); an existing note gets it as that section's text,
 * replacing what the section held, or at its end when no heading is given or the section is missing.
 */

import { findSection } from "./sections";

export interface Placed {
  /** The note's text after the import. */
  content: string;
  /** Where the text went, for the tool's answer. */
  where: string;
  /** True when a section that held text was replaced: the tool asks before that, as for update_note. */
  replaces: boolean;
}

/** The headings of *text* (outside code fences) moved down so that its highest is level *top*; at most level 6. */
export function demoteHeadings(text: string, top: number): string {
  const lines = text.split("\n");
  let fence = false;
  const levels: (number | null)[] = lines.map((line) => {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    const match = fence ? null : /^(#{1,6})[ \t]/.exec(line);
    return match ? match[1].length : null;
  });
  const highest = Math.min(...levels.filter((level): level is number => level !== null));
  if (!Number.isFinite(highest) || highest >= top) return text;
  const shift = top - highest;
  return lines.map((line, index) => {
    const level = levels[index];
    return level === null ? line : `${"#".repeat(Math.min(6, level + shift))}${line.slice(level)}`;
  }).join("\n");
}

/** *text* placed in the note *current* (null when there is none yet), under *heading* when one is given. */
export function placeImport(current: string | null, text: string, heading = ""): Placed {
  const name = heading.trim().replace(/^#+\s*/, "");
  const body = text.replace(/\r\n/g, "\n").trim();
  if (current === null) {
    return name ? { content: `## ${name}\n\n${demoteHeadings(body, 3)}\n`, where: `a new note, under '## ${name}'`, replaces: false }
      : { content: `${body}\n`, where: "a new note", replaces: false };
  }
  const crlf = current.includes("\r\n");
  const lf = current.replace(/\r\n/g, "\n");
  const back = (result: string): string => (crlf ? result.replace(/\n/g, "\r\n") : result);
  const section = name ? findSection(lf, name) : null;
  if (section) {
    // Below the section's own heading, so the imported headings do not end it — and a second import replaces it all
    const level = /^(#+)/.exec(lf.slice(section.start))?.[1].length ?? 2;
    const held = lf.slice(section.body, section.end);
    const after = lf.slice(section.end);
    const content = `${lf.slice(0, section.body)}\n${demoteHeadings(body, level + 1)}\n${after ? `\n${after}` : ""}`;
    return { content: back(content), where: `the section '${name}'`, replaces: held.trim() !== "" };
  }
  const end = lf.replace(/\s+$/, "");
  const added = name ? `## ${name}\n\n${demoteHeadings(body, 3)}` : body;
  return {
    content: back(`${end}${end ? "\n\n" : ""}${added}\n`),
    where: name ? `a new section '## ${name}' at the end` : "the end of the note",
    replaces: false,
  };
}
