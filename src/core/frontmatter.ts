/**
 * A note's YAML frontmatter: read it, and change single keys without rewriting the rest.
 *
 * Python used python-frontmatter, which re-serialises the whole block with its keys sorted. Here the block is
 * edited in place: key order, comments and quoting stay as the user wrote them, and the body is never touched.
 */

import { parseDocument } from "yaml";

const BLOCK = /^---\r?\n([\s\S]*?)\r?\n?---[ \t]*(?:\r?\n|$)/;

export interface Frontmatter {
  /** The parsed keys; {} when the note has none or it does not parse. Dates stay strings, as written. */
  data: Record<string, unknown>;
  /** Everything after the closing `---`. */
  body: string;
}

export function readFrontmatter(text: string): Frontmatter {
  const match = BLOCK.exec(text);
  if (!match) return { data: {}, body: text };
  const body = text.slice(match[0].length);
  try {
    // yaml records syntax errors on the document rather than throwing them
    const document = parseDocument(match[1]);
    if (document.errors.length) return { data: {}, body };
    const data = document.toJS() as unknown;
    return { data: data && typeof data === "object" && !Array.isArray(data) ? data as Record<string, unknown> : {}, body };
  } catch {
    return { data: {}, body };
  }
}

/** Why a note's frontmatter does not parse, or null when it does (or the note has none). */
export function frontmatterProblem(text: string): string | null {
  const match = BLOCK.exec(text.replace(/\r\n/g, "\n"));
  if (!match) return null;
  try {
    const document = parseDocument(match[1]);
    if (document.errors.length) {
      // The block starts on the note's second line; yaml counts from the block's first
      const first = document.errors[0];
      const line = (first.linePos?.[0]?.line ?? 0) + 1;
      return `line ${line} of the note: ${first.message.split("\n")[0]}`;
    }
    const data = document.toJS() as unknown;
    if (data !== null && (typeof data !== "object" || Array.isArray(data))) return "it is not a list of properties (key: value)";
    return null;
  } catch (error) {
    return error instanceof Error ? error.message.split("\n")[0] : String(error);
  }
}

/**
 * The error a write tool answers with when *after* would leave a note's frontmatter unparseable that parsed (or was
 * absent) *before* — Obsidian then shows no properties and every tool reading them sees none (#252). A note whose
 * frontmatter was already broken may still be written: that is the user's, and the write may be the repair. Null
 * when the write may go ahead.
 */
export function brokenByWrite(before: string, after: string): string | null {
  const problem = frontmatterProblem(after);
  if (!problem || frontmatterProblem(before)) return null;
  return `Error: the frontmatter would not parse (${problem}), so nothing was written. Obsidian would show no `
    + "properties for this note. Quote a value that contains ': ' or starts with a special character, e.g. "
    + "summary: \"Atlas: API spec almost done\", or set properties with update_metadata.";
}

/**
 * The note with *changes* set in its frontmatter (added at the end when new); a note without one gets one. A change
 * to `undefined` removes the key (#161).
 */
export function setFrontmatter(text: string, changes: Record<string, unknown>): string {
  const match = BLOCK.exec(text);
  const document = parseDocument(match ? match[1] : "");
  for (const [key, value] of Object.entries(changes)) {
    if (value === undefined) document.delete(key);
    else document.set(key, value);
  }
  const yaml = document.toString({ flowCollectionPadding: false, lineWidth: 0 });
  const rest = match ? text.slice(match[0].length) : text;
  const block = `---\n${yaml}---\n`;
  // A note written with "\r\n" keeps it, rather than getting a frontmatter of other line endings (#161)
  return (text.includes("\r\n") ? block.replace(/\n/g, "\r\n") : block) + rest;
}
