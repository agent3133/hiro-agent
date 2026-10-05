/**
 * A Word document (`.docx`) as Markdown (#211): headings from the paragraph styles, bulleted and numbered lists,
 * tables, links. Tracked changes read as accepted, pictures as `[image]`. Comments, footnotes, headers and footers
 * are left out — the text of the document is what is asked for.
 */

import { attr, child, children, descendants, markdownTable, parseXml, relationships, relId } from "./xml";
import { DocumentError } from "./zip";

const MAIN = "word/document.xml";

/** The parts a Word document is read from. */
export const DOCX_PARTS = (name: string): boolean =>
  name === MAIN || name === "word/styles.xml" || name === "word/numbering.xml" || name === "word/_rels/document.xml.rels";

/** Heading levels by style: Word's own names ("heading 1", "Title"), or an outline level set on the style. */
function headingLevels(stylesXml: string | undefined): Map<string, number> {
  const levels = new Map<string, number>();
  if (!stylesXml) return levels;
  for (const style of descendants(parseXml(stylesXml), "style")) {
    const id = attr(style, "styleId");
    const name = attr(child(style, "name"), "val").toLowerCase();
    const heading = /^heading (\d)$/.exec(name);
    const outline = attr(child(child(style, "pPr") ?? style, "outlineLvl"), "val");
    if (name === "title") levels.set(id, 1);
    else if (heading) levels.set(id, Number(heading[1]));
    else if (outline && Number(outline) < 9) levels.set(id, Number(outline) + 1);
  }
  return levels;
}

/** A list style's numbering: Word's "List Bullet" and "List Number" carry it on the style, not on each paragraph. */
interface StyleList { numId: string; level: number; kind?: "bullet" | "number" }

function styleLists(stylesXml: string | undefined): Map<string, StyleList> {
  const lists = new Map<string, StyleList>();
  if (!stylesXml) return lists;
  for (const style of descendants(parseXml(stylesXml), "style")) {
    const id = attr(style, "styleId");
    const numbering = child(child(style, "pPr") ?? style, "numPr");
    if (numbering) {
      lists.set(id, { numId: attr(child(numbering, "numId"), "val"),
                      level: Number(attr(child(numbering, "ilvl"), "val") || "0") });
      continue;
    }
    // Without a numbering definition, the style's own name says which list it is
    const named = /^list (bullet|number)(?: (\d))?$/.exec(attr(child(style, "name"), "val").toLowerCase());
    if (named) lists.set(id, { numId: `style:${id}`, level: Number(named[2] ?? "1") - 1, kind: named[1] === "bullet" ? "bullet" : "number" });
  }
  return lists;
}

/** Whether a list level is numbered (else bulleted), by numId and level. */
function numberFormats(numberingXml: string | undefined): (numId: string, level: number) => "bullet" | "number" {
  if (!numberingXml) return () => "bullet";
  const document = parseXml(numberingXml);
  const abstract = new Map<string, Map<number, string>>();
  for (const definition of descendants(document, "abstractNum")) {
    const formats = new Map<number, string>();
    for (const level of children(definition, "lvl")) formats.set(Number(attr(level, "ilvl")), attr(child(level, "numFmt"), "val"));
    abstract.set(attr(definition, "abstractNumId"), formats);
  }
  const numbers = new Map<string, string>();
  for (const num of descendants(document, "num")) numbers.set(attr(num, "numId"), attr(child(num, "abstractNumId"), "val"));
  return (numId, level) => {
    const format = abstract.get(numbers.get(numId) ?? "")?.get(level) ?? "bullet";
    return format === "bullet" || format === "none" || format === "" ? "bullet" : "number";
  };
}

export function docxToMarkdown(parts: Map<string, string>): string {
  const main = parts.get(MAIN);
  if (!main) throw new DocumentError("it has no word/document.xml, so it is not a Word document");
  const body = descendants(parseXml(main), "body")[0];
  if (!body) return "";
  const levels = headingLevels(parts.get("word/styles.xml"));
  const format = numberFormats(parts.get("word/numbering.xml"));
  const listStyles = styleLists(parts.get("word/styles.xml"));
  const links = relationships(parts.get("word/_rels/document.xml.rels"));
  const counters = new Map<string, number>();

  /** The text of the runs below *element*, in order: links as Markdown, deleted text left out. */
  const inline = (element: Element): string => {
    let text = "";
    for (const node of Array.from(element.children)) {
      switch (node.localName) {
        case "t": text += node.textContent ?? ""; break;
        case "tab": text += "\t"; break;
        case "br": case "cr": text += "\n"; break;
        case "drawing": case "pict": text += "[image]"; break;
        case "del": case "delText": case "rPr": case "pPr": break;
        case "hyperlink": {
          const label = inline(node);
          const target = links.get(relId(node));
          text += target?.external && label ? `[${label}](${target.target})` : label;
          break;
        }
        default: text += inline(node);
      }
    }
    return text;
  };

  const paragraph = (p: Element): string => {
    const properties = child(p, "pPr");
    const text = inline(p).trim();
    if (!text) return "";
    const style = attr(child(properties ?? p, "pStyle"), "val");
    const level = levels.get(style);
    if (level) return `${"#".repeat(Math.min(level, 6))} ${text}`;
    // The list: on the paragraph, or on its style (Word's "List Bullet", "List Number")
    const numbering = properties ? child(properties, "numPr") : null;
    const fromStyle = listStyles.get(style);
    if (numbering || fromStyle) {
      const numId = numbering ? attr(child(numbering, "numId"), "val") || fromStyle?.numId || "" : fromStyle!.numId;
      const depth = numbering && child(numbering, "ilvl") ? Number(attr(child(numbering, "ilvl"), "val") || "0")
        : fromStyle?.level ?? 0;
      const indent = "  ".repeat(depth);
      const kind = fromStyle?.kind && !numbering ? fromStyle.kind : format(numId, depth);
      if (kind === "bullet") return `${indent}- ${text}`;
      const key = `${numId}:${depth}`;
      counters.set(key, (counters.get(key) ?? 0) + 1);
      return `${indent}${counters.get(key)}. ${text}`;
    }
    return text;
  };

  const table = (tbl: Element): string => {
    const rows = children(tbl, "tr").map((row) => children(row, "tc").map((tc) =>
      children(tc, "p").map(paragraph).filter(Boolean).join("\n")));
    return rows.length ? markdownTable(rows) : "";
  };

  const blocks: string[] = [];
  const walk = (container: Element): void => {
    for (const element of Array.from(container.children)) {
      if (element.localName === "p") blocks.push(paragraph(element));
      else if (element.localName === "tbl") blocks.push(table(element));
      else if (element.localName === "sdt") walk(child(element, "sdtContent") ?? element);
      else if (element.localName === "ins") walk(element);
    }
  };
  walk(body);
  // Consecutive list items stay together; other blocks are separated by a blank line
  const out: string[] = [];
  for (const block of blocks.filter(Boolean)) {
    const isItem = /^\s*(-|\d+\.) /.test(block);
    const previousItem = out.length > 0 && /^\s*(-|\d+\.) /.test(out[out.length - 1]);
    out.push(out.length && !(isItem && previousItem) ? `\n${block}` : block);
  }
  // Blank lines trimmed, not spaces: a document may start with an indented list item
  return out.join("\n").replace(/^\n+/, "").trimEnd();
}

