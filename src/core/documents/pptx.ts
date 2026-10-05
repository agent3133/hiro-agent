/**
 * A PowerPoint deck (`.pptx`) as text, slide by slide (#211): the title, the text of every shape and table in
 * reading order, bullet levels as indents, then the speaker notes. Slides as pictures would need an office suite
 * to render them, so they are not offered.
 */

import { pageNumbers } from "../pageNumbers";
import { attr, child, descendants, markdownTable, parseXml, relationships, relId } from "./xml";
import { DocumentError, resolvePart } from "./zip";

const PRESENTATION = "ppt/presentation.xml";

export const PPTX_PARTS = (name: string): boolean => name.startsWith("ppt/") && (name.endsWith(".xml") || name.endsWith(".rels"));

/** The rels part of *part*: `ppt/slides/slide1.xml` → `ppt/slides/_rels/slide1.xml.rels`. */
function relsOf(part: string): string {
  const at = part.lastIndexOf("/");
  return `${part.slice(0, at)}/_rels/${part.slice(at + 1)}.rels`;
}

/** The paragraphs of a text body, bullet levels as indents. */
function paragraphs(body: Element): string[] {
  return descendants(body, "p").map((p) => {
    const text = descendants(p, "t").map((t) => t.textContent ?? "").join("").trim();
    const level = Number(attr(child(p, "pPr"), "lvl") || "0");
    return text ? `${"  ".repeat(level)}${text}` : "";
  }).filter(Boolean);
}

/** A shape's placeholder type ("title", "body", …); empty for a free text box. */
function placeholder(shape: Element): string {
  const ph = descendants(shape, "ph")[0];
  return ph ? attr(ph, "type") || "body" : "";
}

export function pptxToMarkdown(parts: Map<string, string>, pages = ""): string {
  const presentationXml = parts.get(PRESENTATION);
  if (!presentationXml) throw new DocumentError("it has no ppt/presentation.xml, so it is not a PowerPoint deck");
  const links = relationships(parts.get(relsOf(PRESENTATION)));
  const slides = descendants(parseXml(presentationXml), "sldId")
    .map((id) => resolvePart(PRESENTATION, links.get(relId(id))?.target ?? ""));
  if (!slides.length) return "The deck has no slides.";
  const chosen = pageNumbers(pages, slides.length);
  if (typeof chosen === "string") return chosen.replace("the PDF has pages", "the deck has slides");

  const out: string[] = [];
  for (const number of chosen) {
    const path = slides[number - 1];
    const xml = parts.get(path);
    if (!xml) continue;
    const slide = parseXml(xml);
    let title = "";
    const lines: string[] = [];
    // Shapes and tables in the order the slide lists them, which is the order they are read in
    for (const element of Array.from(slide.getElementsByTagName("*")).filter((e) => e.localName === "sp" || e.localName === "graphicFrame")) {
      if (element.localName === "graphicFrame") {
        const table = descendants(element, "tbl")[0];
        if (table) {
          const rows = descendants(table, "tr").map((row) => descendants(row, "tc").map((tc) => paragraphs(tc).join("\n")));
          if (rows.length) lines.push(markdownTable(rows));
        }
        continue;
      }
      const body = descendants(element, "txBody")[0];
      if (!body) continue;
      const kind = placeholder(element);
      const text = paragraphs(body);
      if (!text.length) continue;
      if (!title && (kind === "title" || kind === "ctrTitle")) title = text.join(" ");
      else lines.push(...text.map((line) => (line.startsWith(" ") ? `${line.replace(/^( *)/, "$1- ")}` : `- ${line}`)));
    }
    // The speaker notes: the body placeholder of the notes slide this slide links to
    const notesTarget = [...relationships(parts.get(relsOf(path))).values()].find((r) => r.type.endsWith("/notesSlide"));
    const notesXml = notesTarget ? parts.get(resolvePart(path, notesTarget.target)) : undefined;
    const notes = notesXml ? descendants(parseXml(notesXml), "sp").filter((sp) => placeholder(sp) === "body")
      .flatMap((sp) => paragraphs(descendants(sp, "txBody")[0] ?? sp)) : [];
    out.push([`## Slide ${number}/${slides.length}${title ? `: ${title}` : ""}`, "", ...lines,
              ...(notes.length ? ["", `Notes: ${notes.join(" ")}`] : [])].join("\n").trim());
  }
  return out.join("\n\n");
}
