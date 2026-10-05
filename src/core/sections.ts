/**
 * One section of a note: a heading and what follows it up to the next heading of the same or a higher level — for
 * reading or appending to a part of a long note (#166). Headings inside code fences do not count.
 */

export interface Section {
  /** Where the heading line starts. */
  start: number;
  /** Where the section's text starts: after the heading line. */
  body: number;
  /** Where the next heading of the same or a higher level starts, or the end of the note. */
  end: number;
}

interface Heading {
  level: number;
  name: string;
  start: number;
  body: number;
}

function headings(text: string): Heading[] {
  const found: Heading[] = [];
  let offset = 0;
  let fence = false;
  for (const line of text.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    const match = fence ? null : /^(#{1,6})[ \t]+(.*?)[ \t#]*\r?$/.exec(line);
    if (match) found.push({ level: match[1].length, name: match[2].trim(), start: offset, body: offset + line.length + 1 });
    offset += line.length + 1;
  }
  return found;
}

/** The section headed *heading* ("Tasks" or "## Tasks", any case), or null; the first when several share it. */
export function findSection(text: string, heading: string): Section | null {
  const wanted = heading.trim().replace(/^#+\s*/, "").toLowerCase();
  const all = headings(text);
  const index = all.findIndex((h) => h.name.toLowerCase() === wanted);
  if (index < 0) return null;
  const own = all[index];
  const next = all.slice(index + 1).find((h) => h.level <= own.level);
  return { start: own.start, body: Math.min(own.body, text.length), end: next ? next.start : text.length };
}

/** The note's headings, for an error that shows which there are. */
export function headingNames(text: string): string[] {
  return headings(text).map((h) => h.name);
}

/** *text* with *addition* at the end of *section*: after its last line, before the next heading's blank line. */
export function appendToSection(text: string, section: Section, addition: string): string {
  const before = text.slice(0, section.end).replace(/\s+$/, "");
  const after = text.slice(section.end);
  return after ? `${before}\n${addition}\n\n${after}` : `${before}\n${addition}\n`;
}
