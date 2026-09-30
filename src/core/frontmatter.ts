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

/** The note with *changes* set in its frontmatter (added at the end when new); a note without one gets one. */
export function setFrontmatter(text: string, changes: Record<string, unknown>): string {
  const match = BLOCK.exec(text);
  const document = parseDocument(match ? match[1] : "");
  for (const [key, value] of Object.entries(changes)) document.set(key, value);
  const yaml = document.toString({ flowCollectionPadding: false, lineWidth: 0 });
  const rest = match ? text.slice(match[0].length) : text;
  return `---\n${yaml}---\n${rest}`;
}
