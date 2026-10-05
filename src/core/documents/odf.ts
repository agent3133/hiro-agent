/**
 * OpenDocument files — LibreOffice's `.odt`, `.ods`, `.odp` — as text, the way the Office readers give theirs
 * (#212): a text document as Markdown, a spreadsheet's tables, a presentation's slides with their notes. All three
 * keep their content in `content.xml`.
 */

import { pageNumbers } from "../pageNumbers";
import { MAX_ROWS } from "./xlsx";
import { attr, children, descendants, markdownTable, parseXml } from "./xml";
import { DocumentError } from "./zip";

export const ODF_PARTS = (name: string): boolean => name === "content.xml" || name === "styles.xml";

/** Repeated empty cells and rows (LibreOffice writes "the rest of the sheet" as one repeated cell) are capped. */
const MAX_REPEAT = 1000;

/** The text of *element*: spans, links, spaces, tabs and line breaks; pictures as [image]. */
function inline(element: Element): string {
  let text = "";
  for (const node of Array.from(element.childNodes)) {
    if (node.nodeType === 3) {
      text += node.textContent ?? "";
      continue;
    }
    if (node.nodeType !== 1) continue;
    const el = node as Element;
    switch (el.localName) {
      case "s": text += " ".repeat(Number(attr(el, "c") || "1")); break;
      case "tab": text += "\t"; break;
      case "line-break": text += "\n"; break;
      case "a": {
        const label = inline(el);
        const href = attr(el, "href");
        text += href && /^https?:/.test(href) ? `[${label}](${href})` : label;
        break;
      }
      case "image": text += "[image]"; break;
      case "note": case "annotation": break;
      default: text += inline(el);
    }
  }
  return text;
}

/** Which list styles number their items (else bullets), by style name. */
function numberedLists(document: Document[]): Set<string> {
  const numbered = new Set<string>();
  for (const doc of document) {
    for (const style of descendants(doc, "list-style")) {
      if (children(style)[0]?.localName === "list-level-style-number") numbered.add(attr(style, "name"));
    }
  }
  return numbered;
}

function odtToMarkdown(content: Document, numbered: Set<string>): string {
  const body = descendants(content, "text")[0];
  if (!body) return "";
  const blocks: string[] = [];
  const list = (element: Element, depth: number, style: string): void => {
    const own = attr(element, "style-name") || style;
    let counter = 0;
    for (const item of children(element, "list-item")) {
      counter += 1;
      for (const part of children(item)) {
        if (part.localName === "list") list(part, depth + 1, own);
        else if (part.localName === "p" || part.localName === "h") {
          const text = inline(part).trim();
          if (text) blocks.push(`${"  ".repeat(depth)}${numbered.has(own) ? `${counter}.` : "-"} ${text}`);
        }
      }
    }
  };
  const walk = (container: Element): void => {
    for (const element of children(container)) {
      const name = element.localName;
      if (name === "h") {
        const text = inline(element).trim();
        if (text) blocks.push(`\n${"#".repeat(Math.min(Number(attr(element, "outline-level") || "1"), 6))} ${text}`);
      } else if (name === "p") {
        const text = inline(element).trim();
        if (text) blocks.push(`\n${text}`);
      } else if (name === "list") {
        blocks.push("");
        list(element, 0, "");
      } else if (name === "table") {
        const rows = descendants(element, "table-row").map((row) => children(row).filter((c) => c.localName === "table-cell")
          .map((cell) => children(cell).map(inline).join("\n").trim()));
        if (rows.length) blocks.push(`\n${markdownTable(rows)}`);
      } else if (name === "section") {
        walk(element);
      }
    }
  };
  walk(body);
  return blocks.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function odsToMarkdown(content: Document, pages: string): string {
  const sheets = descendants(content, "table").filter((t) => t.parentElement?.localName === "spreadsheet");
  if (!sheets.length) return "The spreadsheet has no sheets.";
  const chosen = pageNumbers(pages, sheets.length);
  if (typeof chosen === "string") return chosen.replace("the PDF has pages", "the spreadsheet has sheets");
  const value = (cell: Element): string => {
    const type = attr(cell, "value-type");
    if (type === "date") return attr(cell, "date-value").replace("T00:00:00", "").replace("T", " ");
    if (type === "float" || type === "percentage" || type === "currency") return attr(cell, "value");
    if (type === "boolean") return attr(cell, "boolean-value").toUpperCase();
    return children(cell).filter((c) => c.localName === "p").map(inline).join("\n");
  };
  const out: string[] = [];
  for (const number of chosen) {
    const sheet = sheets[number - 1];
    const heading = `## Sheet ${number}/${sheets.length}: ${attr(sheet, "name")}`;
    const rows: string[][] = [];
    for (const row of descendants(sheet, "table-row")) {
      const cells: string[] = [];
      for (const cell of children(row).filter((c) => c.localName === "table-cell" || c.localName === "covered-table-cell")) {
        const text = value(cell);
        const repeat = Math.min(Number(attr(cell, "number-columns-repeated") || "1"), text ? MAX_REPEAT : 1);
        for (let i = 0; i < repeat; i++) cells.push(text);
      }
      while (cells.length && !cells[cells.length - 1].trim()) cells.pop();
      if (!cells.length) continue;
      const repeat = Math.min(Number(attr(row, "number-rows-repeated") || "1"), MAX_REPEAT);
      for (let i = 0; i < repeat; i++) rows.push(cells);
    }
    if (!rows.length) {
      out.push(`${heading}\n\n(empty)`);
      continue;
    }
    const shown = rows.slice(0, MAX_ROWS + 1);
    const left = rows.length - shown.length;
    out.push(`${heading} (${rows.length} row${rows.length === 1 ? "" : "s"})\n\n${markdownTable(shown)}`
             + (left ? `\n\n[${left} more rows not shown — the sheet is cut at ${MAX_ROWS} rows]` : ""));
  }
  return out.join("\n\n");
}

function odpToMarkdown(content: Document, pages: string): string {
  const slides = descendants(content, "page").filter((p) => p.parentElement?.localName === "presentation");
  if (!slides.length) return "The presentation has no slides.";
  const chosen = pageNumbers(pages, slides.length);
  if (typeof chosen === "string") return chosen.replace("the PDF has pages", "the presentation has slides");
  const lines = (frame: Element): string[] => {
    const out: string[] = [];
    const visit = (element: Element, depth: number): void => {
      for (const part of children(element)) {
        if (part.localName === "list") visit(part, depth + 1);
        else if (part.localName === "list-item") visit(part, depth);
        else if (part.localName === "p" || part.localName === "h") {
          const text = inline(part).trim();
          if (text) out.push(`${"  ".repeat(Math.max(depth - 1, 0))}${text}`);
        }
      }
    };
    for (const box of descendants(frame, "text-box")) visit(box, 0);
    return out;
  };
  const out: string[] = [];
  for (const number of chosen) {
    const slide = slides[number - 1];
    let title = "";
    const body: string[] = [];
    for (const frame of children(slide).filter((c) => c.localName === "frame")) {
      const text = lines(frame);
      if (!title && attr(frame, "class") === "title") title = text.join(" ");
      else body.push(...text.map((line) => line.replace(/^( *)/, "$1- ")));
    }
    const notesElement = children(slide).find((c) => c.localName === "notes");
    const notes = notesElement ? children(notesElement).filter((c) => c.localName === "frame")
      .filter((f) => attr(f, "class") === "notes").flatMap(lines) : [];
    out.push([`## Slide ${number}/${slides.length}${title ? `: ${title}` : ""}`, "", ...body,
              ...(notes.length ? ["", `Notes: ${notes.join(" ")}`] : [])].join("\n").trim());
  }
  return out.join("\n\n");
}

/** An OpenDocument file of *kind* as Markdown; *pages* picks sheets or slides. */
export function odfToMarkdown(kind: "odt" | "ods" | "odp", parts: Map<string, string>, pages = ""): string {
  const contentXml = parts.get("content.xml");
  if (!contentXml) throw new DocumentError("it has no content.xml, so it is not an OpenDocument file");
  const content = parseXml(contentXml);
  if (kind === "ods") return odsToMarkdown(content, pages);
  if (kind === "odp") return odpToMarkdown(content, pages);
  const styles = parts.get("styles.xml");
  return odtToMarkdown(content, numberedLists(styles ? [content, parseXml(styles)] : [content]));
}
