/**
 * An EPUB book, chapter by chapter (#213). Without `pages` the answer is the book's title and its chapters with
 * their length — a book is far longer than a context window — and `pages` picks the chapters to read, each as
 * Markdown: headings, paragraphs, lists, tables, links.
 */

import { pageNumbers } from "../pageNumbers";
import { attr, descendants, markdownTable, parseXml } from "./xml";
import { DocumentError, resolvePart } from "./zip";

export const EPUB_PARTS = (name: string): boolean => /\.(opf|xml|xhtml|html|htm)$/i.test(name);

/** A chapter's XHTML as Markdown. Parsed as HTML: books use HTML entities (&nbsp;) that XML does not know. */
export function chapterToMarkdown(html: string): string {
  const document = new DOMParser().parseFromString(html, "text/html");
  const blocks: string[] = [];
  const inline = (element: Element): string => {
    let text = "";
    for (const node of Array.from(element.childNodes)) {
      if (node.nodeType === 3) text += (node.textContent ?? "").replace(/\s+/g, " ");
      else if (node.nodeType === 1) {
        const el = node as Element;
        const name = el.localName.toLowerCase();
        if (name === "br") text += "\n";
        else if (name === "img") text += el.getAttribute("alt") ? `[image: ${el.getAttribute("alt")}]` : "[image]";
        else if (name === "a" && /^https?:/.test(el.getAttribute("href") ?? "")) text += `[${inline(el)}](${el.getAttribute("href")})`;
        else if (name !== "script" && name !== "style") text += inline(el);
      }
    }
    return text;
  };
  const isList = (node: Node): boolean => node.nodeType === 1 && /^(ul|ol)$/i.test((node as Element).localName);
  /** A list's items, each with its own text, then its nested lists one level deeper. */
  const list = (element: Element, depth: number): void => {
    const numbered = element.localName.toLowerCase() === "ol";
    let counter = 0;
    for (const item of Array.from(element.children).filter((c) => c.localName.toLowerCase() === "li")) {
      counter += 1;
      const text = Array.from(item.childNodes).filter((n) => !isList(n))
        .map((n) => (n.nodeType === 1 ? inline(n as Element) : (n.textContent ?? ""))).join("").replace(/\s+/g, " ").trim();
      if (text) blocks.push(`${"  ".repeat(depth)}${numbered ? `${counter}.` : "-"} ${text}`);
      for (const nested of Array.from(item.children).filter(isList)) list(nested, depth + 1);
    }
  };
  const walk = (container: Element): void => {
    for (const element of Array.from(container.children)) {
      const name = element.localName.toLowerCase();
      const heading = /^h([1-6])$/.exec(name);
      if (heading) blocks.push(`\n${"#".repeat(Number(heading[1]))} ${inline(element).trim()}`);
      else if (name === "p" || name === "blockquote" || name === "pre") {
        const text = inline(element).trim();
        if (text) blocks.push(`\n${name === "blockquote" ? `> ${text}` : text}`);
      } else if (name === "ul" || name === "ol") {
        blocks.push("");
        list(element, 0);
      } else if (name === "table") {
        const rows = Array.from(element.querySelectorAll("tr")).map((row) =>
          Array.from(row.children).map((cell) => inline(cell).trim()));
        if (rows.length) blocks.push(`\n${markdownTable(rows)}`);
      } else if (name !== "script" && name !== "style" && name !== "head") {
        walk(element);
      }
    }
  };
  if (document.body) walk(document.body);
  return blocks.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** The book in *parts* — its chapter list, or the chapters *pages* picks. */
export function epubToMarkdown(parts: Map<string, string>, pages = ""): string {
  const container = parts.get("META-INF/container.xml");
  if (!container) throw new DocumentError("it has no META-INF/container.xml, so it is not an EPUB book");
  const opfPath = attr(descendants(parseXml(container), "rootfile")[0] ?? null, "full-path");
  const opfXml = parts.get(opfPath);
  if (!opfXml) throw new DocumentError("its package file is missing");
  const opf = parseXml(opfXml);
  const title = descendants(opf, "title")[0]?.textContent?.trim() ?? "";
  const manifest = new Map(descendants(opf, "item").map((item) => [attr(item, "id"), attr(item, "href")]));
  const chapters = descendants(opf, "itemref").map((ref) => resolvePart(opfPath, decodeURI(manifest.get(attr(ref, "idref")) ?? "")))
    .filter((path) => parts.has(path));
  if (!chapters.length) return `The book${title ? ` "${title}"` : ""} has no readable chapters.`;
  const texts = chapters.map((path) => chapterToMarkdown(parts.get(path)!));
  const name = (text: string, index: number): string => /^#{1,6} (.+)$/m.exec(text)?.[1] ?? `Chapter ${index + 1}`;
  if (!pages.trim()) {
    const list = texts.map((text, index) => {
      const words = text.split(/\s+/).filter(Boolean).length;
      return `${index + 1}. ${name(text, index)} (${words} words)`;
    });
    return `${title ? `"${title}" — ` : ""}${chapters.length} chapters. Read them with pages ("3", "1-2"):\n\n${list.join("\n")}`;
  }
  const chosen = pageNumbers(pages, chapters.length);
  if (typeof chosen === "string") return chosen.replace("the PDF has pages", "the book has chapters");
  return chosen.map((number) => `## Chapter ${number}/${chapters.length}\n\n${texts[number - 1] || "(no text)"}`).join("\n\n");
}

