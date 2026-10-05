/**
 * Small helpers over the platform's DOMParser for the document readers (#211). Elements are matched by their local
 * name, whatever prefix a file uses for the namespace — Word writes `w:p`, another program may write `ns0:p`.
 */

import { DocumentError } from "./zip";

export function parseXml(text: string): Document {
  const document = new DOMParser().parseFromString(text, "application/xml");
  if (document.getElementsByTagName("parsererror").length) throw new DocumentError("a part of the file is not valid XML");
  return document;
}

/** The direct children of *element* with local name *name* (any, when none is given). */
export function children(element: Element, name?: string): Element[] {
  return Array.from(element.children).filter((child) => !name || child.localName === name);
}

export function child(element: Element, name: string): Element | null {
  return children(element, name)[0] ?? null;
}

/** Every element below *root* with local name *name*, in document order. */
export function descendants(root: Element | Document, name: string): Element[] {
  return Array.from(root.getElementsByTagName("*")).filter((element) => element.localName === name);
}

/** The attribute *name* of *element*, by local name: `w:val` and `val` alike. */
export function attr(element: Element | null, name: string): string {
  if (!element) return "";
  for (const attribute of Array.from(element.attributes)) {
    // By the name after the prefix too: not every DOM gives a prefixed attribute its local name
    if (attribute.localName === name || attribute.name === name || attribute.name.endsWith(`:${name}`)) return attribute.value;
  }
  return "";
}

/** The relationship id of *element* (`r:id`, `r:embed`'s sibling): a prefixed `id`, never a plain one. */
export function relId(element: Element | null): string {
  if (!element) return "";
  for (const attribute of Array.from(element.attributes)) {
    if (attribute.name.includes(":") && attribute.name.endsWith(":id")) return attribute.value;
  }
  return "";
}

/** A relationships part (`_rels/*.rels`) as id → target. */
export function relationships(text: string | undefined): Map<string, { target: string; type: string; external: boolean }> {
  const map = new Map<string, { target: string; type: string; external: boolean }>();
  if (!text) return map;
  for (const relation of descendants(parseXml(text), "Relationship")) {
    map.set(attr(relation, "Id"), { target: attr(relation, "Target"), type: attr(relation, "Type"),
                                    external: attr(relation, "TargetMode") === "External" });
  }
  return map;
}

/** *text* made safe for a Markdown table cell. */
export function cell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\s*\n\s*/g, "<br>").trim();
}

/** Rows as a Markdown table, the first row as its header; columns padded to the widest row. */
export function markdownTable(rows: string[][]): string {
  const width = Math.max(1, ...rows.map((row) => row.length));
  const padded = rows.map((row) => [...row, ...Array<string>(width - row.length).fill("")].map(cell));
  const line = (row: string[]): string => `| ${row.join(" | ")} |`;
  return [line(padded[0]), line(Array<string>(width).fill("---")), ...padded.slice(1).map(line)].join("\n");
}
