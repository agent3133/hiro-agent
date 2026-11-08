/**
 * An EPUB book, chapter by chapter (#213). Without `pages` the answer is the book's title and its chapters with
 * their length — a book is far longer than a context window — and `pages` picks the chapters to read, each as
 * Markdown: headings, paragraphs, lists, tables, links, bold and italic.
 *
 * The chapters are the book's table of contents (#330): many books — Project Gutenberg's among them — keep the whole
 * text in one file, so its files say nothing about its chapters. An entry runs from its anchor to the next entry's.
 * A book without a usable table of contents falls back to its files. A long chapter is read in parts ("3.2"), and
 * one answer holds at most about ANSWER_CHARS: it ends with the pages still to read.
 */

import { attr, children, descendants, markdownTable, parseXml } from "./xml";
import { DocumentError, resolvePart } from "./zip";

export const EPUB_PARTS = (name: string): boolean => /\.(opf|ncx|xml|xhtml|html|htm)$/i.test(name);

/** The longest part a chapter is read in, and the most one answer holds: well inside a 32k window's share. */
export const PART_CHARS = 12_000;
const ANSWER_CHARS = 12_000;

/** A chapter file's Markdown, block by block, with where the anchors *wanted* fall: before the block at *at*. */
interface Blocks {
  blocks: string[];
  marks: { id: string; at: number }[];
}

/** A chapter's XHTML as Markdown. Parsed as HTML: books use HTML entities (&nbsp;) that XML does not know. */
export function chapterToMarkdown(html: string): string {
  return joinBlocks(chapterBlocks(html, new Set()).blocks);
}

function joinBlocks(blocks: string[]): string {
  return blocks.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** *text* in *mark* (`**`, `*`), the spaces around it kept outside, so the Markdown stays valid. */
function emphasis(text: string, mark: string): string {
  const match = /^(\s*)([\s\S]*?)(\s*)$/.exec(text)!;
  return match[2] ? `${match[1]}${mark}${match[2]}${mark}${match[3]}` : text;
}

/** Elements that have no end tag in HTML; every other one written `<x/>`, as XHTML allows, gets one. */
const VOID = /^(area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)$/i;

/**
 * *xhtml* as HTML can read it: an empty `<pre/>` or `<span/>` is closed, which XHTML allows and HTML does not — an
 * HTML parser leaves it open, and Project Gutenberg's `<pre/>` before the title put the whole book in it (#330).
 */
export function closeEmptyTags(xhtml: string): string {
  return xhtml.replace(/<([A-Za-z][\w:-]*)(\s[^<>]*?)?\s*\/>/g,
    (whole, name: string, attributes = "") => (VOID.test(name) ? whole : `<${name}${attributes}></${name}>`));
}

/**
 * A chapter file's blocks. *image*, when given, writes an image (its `src` as the file has it) — the import's
 * placeholder for the file it saves (#331); without it an image is its alt text.
 */
function chapterBlocks(html: string, wanted: Set<string>, image?: (src: string) => string): Blocks {
  const document = new DOMParser().parseFromString(closeEmptyTags(html), "text/html");
  const blocks: string[] = [];
  const marks: Blocks["marks"] = [];
  /** The anchors *wanted* on *element* — and, for a block written whole, inside it — placed before the next block. */
  const mark = (element: Element, whole: boolean): void => {
    const inside = whole ? Array.from(element.querySelectorAll("[id], a[name]")) : [];
    for (const el of [element, ...inside]) {
      for (const id of [el.getAttribute("id"), el.getAttribute("name")]) {
        if (id && wanted.has(id)) marks.push({ id, at: blocks.length });
      }
    }
  };
  /** The text of *element*; *plain* leaves out bold and italic, as in a heading. */
  const inline = (element: Element, plain = false): string => {
    let text = "";
    for (const node of Array.from(element.childNodes)) {
      if (node.nodeType === 3) text += (node.textContent ?? "").replace(/\s+/g, " ");
      else if (node.nodeType === 1) {
        const el = node as Element;
        const name = el.localName.toLowerCase();
        if (name === "br") text += "\n";
        else if (name === "img" && image && el.getAttribute("src")) text += image(el.getAttribute("src")!);
        else if (name === "img") text += el.getAttribute("alt") ? `[image: ${el.getAttribute("alt")}]` : "[image]";
        else if (name === "a" && /^https?:/.test(el.getAttribute("href") ?? "")) text += `[${inline(el, plain)}](${el.getAttribute("href")})`;
        else if (!plain && (name === "strong" || name === "b")) text += emphasis(inline(el, plain), "**");
        else if (!plain && (name === "em" || name === "i")) text += emphasis(inline(el, plain), "*");
        else if (name !== "script" && name !== "style") text += inline(el, plain);
      }
    }
    return text;
  };
  /** A paragraph's lines, each trimmed: a line break inside verse stays, the spaces around it do not. */
  const lines = (text: string): string => text.split("\n").map((line) => line.replace(/ {2,}/g, " ").trim()).join("\n").trim();
  const isList = (node: Node): boolean => node.nodeType === 1 && /^(ul|ol)$/i.test((node as Element).localName);
  /** A list's items, each with its own text, then its nested lists one level deeper. */
  const list = (element: Element, depth: number): void => {
    const numbered = element.localName.toLowerCase() === "ol";
    let counter = 0;
    for (const item of Array.from(element.children).filter((c) => c.localName.toLowerCase() === "li")) {
      counter += 1;
      const text = Array.from(item.childNodes).filter((n) => !isList(n))
        .map((n) => (n.nodeType === 1 ? inline(n as Element) : (n.textContent ?? ""))).join("").replace(/\s+/g, " ").trim()
        // A bullet the book wrote into the item's text is the list's own mark already
        .replace(/^[•·▪◦‣]\s*/, "");
      if (text) blocks.push(`${"  ".repeat(depth)}${numbered ? `${counter}.` : "-"} ${text}`);
      for (const nested of Array.from(item.children).filter(isList)) list(nested, depth + 1);
    }
  };
  const walk = (container: Element): void => {
    for (const element of Array.from(container.children)) {
      const name = element.localName.toLowerCase();
      const heading = /^h([1-6])$/.exec(name);
      // A quotation of whole paragraphs is read as they are, each line then marked as quoted
      const quoteOfBlocks = name === "blockquote" && element.querySelector("p, div, h1, h2, h3, h4, h5, h6, ul, ol, table") !== null;
      const block = Boolean(heading) || /^(p|blockquote|pre|ul|ol|table|hr)$/.test(name);
      mark(element, block && !quoteOfBlocks);
      if (quoteOfBlocks) {
        const start = blocks.length;
        walk(element);
        const quoted = joinBlocks(blocks.splice(start)).split("\n").map((line) => (line ? `> ${line}` : ">")).join("\n");
        for (const placed of marks) placed.at = Math.min(placed.at, start);
        if (quoted.trim() !== ">") blocks.push(`\n${quoted}`);
      } else if (heading) blocks.push(`\n${"#".repeat(Number(heading[1]))} ${inline(element, true).replace(/\s+/g, " ").trim()}`);
      else if (name === "p" || name === "blockquote" || name === "pre") {
        const text = lines(inline(element));
        if (text) blocks.push(`\n${name === "blockquote" ? text.split("\n").map((line) => `> ${line}`).join("\n") : text}`);
      } else if (name === "ul" || name === "ol") {
        blocks.push("");
        list(element, 0);
      } else if (name === "table") {
        const rows = Array.from(element.querySelectorAll("tr")).map((row) =>
          Array.from(row.children).map((cell) => inline(cell).trim()));
        if (rows.length) blocks.push(`\n${markdownTable(rows)}`);
      } else if (name === "hr") {
        blocks.push("\n---");
      } else if (name !== "script" && name !== "style" && name !== "head") {
        walk(element);
      }
    }
  };
  if (document.body) walk(document.body);
  return { blocks, marks };
}

/** A chapter: its title, its depth in the table of contents, and its text in parts of at most PART_CHARS. */
export interface Chapter {
  title: string;
  depth: number;
  parts: string[];
  words: number;
}

export interface Book {
  title: string;
  author: string;
  chapters: Chapter[];
}

/** An entry of the table of contents: its title, depth, and the spine file and anchor it points at. */
interface Entry {
  title: string;
  depth: number;
  file: string;
  id: string;
}

const clean = (text: string | null | undefined): string => (text ?? "").replace(/\s+/g, " ").trim();

/** The EPUB 3 navigation document's table of contents, nested lists flattened with their depth. */
function navEntries(path: string, xml: string): Entry[] {
  const document = parseXml(xml);
  const navs = descendants(document, "nav");
  const nav = navs.find((element) => attr(element, "type").split(/\s+/).includes("toc")) ?? navs[0];
  const entries: Entry[] = [];
  const walk = (ol: Element, depth: number): void => {
    for (const li of children(ol, "li")) {
      const link = children(li, "a")[0];
      const href = attr(link ?? null, "href");
      if (link && href) entries.push({ title: clean(link.textContent), depth, ...target(path, href) });
      for (const nested of children(li, "ol")) walk(nested, depth + 1);
    }
  };
  for (const ol of nav ? children(nav, "ol") : []) walk(ol, 0);
  return entries;
}

/** The EPUB 2 NCX's navigation points, nested ones flattened with their depth. */
function ncxEntries(path: string, xml: string): Entry[] {
  const entries: Entry[] = [];
  const walk = (parent: Element, depth: number): void => {
    for (const point of children(parent, "navPoint")) {
      const label = descendants(children(point, "navLabel")[0] ?? point, "text")[0];
      const src = attr(children(point, "content")[0] ?? null, "src");
      if (src) entries.push({ title: clean(label?.textContent), depth, ...target(path, src) });
      walk(point, depth + 1);
    }
  };
  const map = descendants(parseXml(xml), "navMap")[0];
  if (map) walk(map, 0);
  return entries;
}

/** A link from the file at *from* as a file in the archive and an anchor ("" for the file's start). */
function target(from: string, href: string): { file: string; id: string } {
  const [file, id = ""] = href.split("#");
  return { file: resolvePart(from, safeDecode(file)), id: safeDecode(id) };
}

function safeDecode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/** *text* in parts of at most PART_CHARS, cut between blocks; a single longer block is a part of its own. */
function splitParts(blocks: string[]): string[] {
  const parts: string[] = [];
  let current: string[] = [];
  let length = 0;
  for (const block of blocks) {
    if (current.length && length + block.length > PART_CHARS) {
      parts.push(joinBlocks(current));
      current = [];
      length = 0;
    }
    current.push(block);
    length += block.length + 1;
  }
  if (current.length) parts.push(joinBlocks(current));
  return parts.filter(Boolean);
}

function chapter(title: string, depth: number, blocks: string[]): Chapter {
  const parts = splitParts(blocks);
  const text = joinBlocks(blocks);
  return { title, depth, parts: parts.length ? parts : [""], words: text.split(/\s+/).filter(Boolean).length };
}

/** An image's place in an imported chapter: the file in the archive, swapped for the saved file's embed (#331). */
export const IMAGE_PLACEHOLDER = /!\[\[epub:([^\]]+)\]\]/g;

/**
 * The book in *parts*: its title, author and chapters — from its table of contents, or else its files. With *images*,
 * a chapter's images are placeholders (IMAGE_PLACEHOLDER) naming their file in the archive.
 */
export function epubBook(parts: Map<string, string>, options: { images?: boolean } = {}): Book {
  const container = parts.get("META-INF/container.xml");
  if (!container) throw new DocumentError("it has no META-INF/container.xml, so it is not an EPUB book");
  const opfPath = attr(descendants(parseXml(container), "rootfile")[0] ?? null, "full-path");
  const opfXml = parts.get(opfPath);
  if (!opfXml) throw new DocumentError("its package file is missing");
  const opf = parseXml(opfXml);
  const title = clean(descendants(opf, "title")[0]?.textContent);
  const author = descendants(opf, "creator").map((creator) => clean(creator.textContent)).filter(Boolean).join(", ");
  const items = descendants(opf, "item");
  const href = (item: Element | undefined): string => (item ? resolvePart(opfPath, safeDecode(attr(item, "href"))) : "");
  const byId = new Map(items.map((item) => [attr(item, "id"), item]));
  const spine = descendants(opf, "itemref").map((ref) => href(byId.get(attr(ref, "idref")))).filter((path) => parts.has(path));
  if (!spine.length) return { title, author, chapters: [] };

  // The table of contents: EPUB 3's navigation document, else EPUB 2's NCX, which the spine names
  const nav = href(items.find((item) => attr(item, "properties").split(/\s+/).includes("nav")));
  const ncx = href(byId.get(attr(descendants(opf, "spine")[0] ?? null, "toc")));
  let entries: Entry[] = [];
  try {
    if (parts.has(nav)) entries = navEntries(nav, parts.get(nav)!);
    if (!entries.length && parts.has(ncx)) entries = ncxEntries(ncx, parts.get(ncx)!);
  } catch (error) {
    // A table of contents that cannot be read leaves the files as the chapters
    if (!(error instanceof DocumentError)) throw error;
  }
  entries = entries.filter((entry) => spine.includes(entry.file));

  // Every spine file's blocks, one sequence, with where each entry's anchor falls in it
  const wanted = new Map<string, Set<string>>();
  for (const entry of entries) if (entry.id) (wanted.get(entry.file) ?? wanted.set(entry.file, new Set()).get(entry.file)!).add(entry.id);
  const blocks: string[] = [];
  const starts = new Map<string, number>();
  const fileStarts: number[] = [];
  for (const file of spine) {
    const image = options.images ? (src: string): string => `![[epub:${resolvePart(file, safeDecode(src.split("#")[0]))}]]` : undefined;
    const read = chapterBlocks(parts.get(file)!, wanted.get(file) ?? new Set(), image);
    starts.set(file, blocks.length);
    fileStarts.push(blocks.length);
    for (const { id, at } of read.marks) if (!starts.has(`${file}#${id}`)) starts.set(`${file}#${id}`, blocks.length + at);
    blocks.push(...read.blocks);
  }
  const placed = entries.map((entry) => ({ entry, at: starts.get(entry.id ? `${entry.file}#${entry.id}` : entry.file) }))
    .filter((item): item is { entry: Entry; at: number } => item.at !== undefined)
    .sort((a, b) => a.at - b.at);

  if (!placed.length) {
    // No table of contents to go by: each file is a chapter, named by its first heading
    const chapters = spine.map((_, index) => {
      const own = blocks.slice(fileStarts[index], fileStarts[index + 1] ?? blocks.length);
      const heading = /^#{1,6} (.+)$/m.exec(joinBlocks(own))?.[1] ?? `Chapter ${index + 1}`;
      return chapter(heading, 0, own);
    });
    return { title, author, chapters };
  }
  const chapters: Chapter[] = [];
  // What comes before the first entry — a title page, a preface — is a chapter of its own when it has text
  const before = blocks.slice(0, placed[0].at);
  if (joinBlocks(before)) chapters.push(chapter("Before the contents", 0, before));
  // An entry with nothing but its heading — a title, a part's name, Gutenberg's "or" — joins the next entry, which
  // then starts with that heading: one chapter, not three of six words (#330)
  const onlyHeadings = (from: number, to: number): boolean =>
    blocks.slice(from, to).every((block) => !block.trim() || /^#{1,6} /.test(block.trim()) || block.trim() === "---");
  let start: number | null = null;
  placed.forEach(({ entry, at }, index) => {
    const end = placed[index + 1]?.at ?? blocks.length;
    const from = start ?? at;
    if (index + 1 < placed.length && onlyHeadings(at, end)) {
      start = from;
      return;
    }
    start = null;
    chapters.push(chapter(entry.title || `Chapter ${chapters.length + 1}`, entry.depth, blocks.slice(from, end)));
  });
  return { title, author, chapters };
}

/** A chapter and one of its parts, both from 1. */
interface Piece {
  chapter: number;
  part: number;
}

/** The pieces *wanted* names — "3", "3.2", "2-4", "3.2-5", "1,3" — in the book's order, or the error to return. */
export function chapterPieces(wanted: string, chapters: Chapter[]): Piece[] | string {
  const all: Piece[] = chapters.flatMap((chapter, index) => chapter.parts.map((_, part) => ({ chapter: index + 1, part: part + 1 })));
  const indexOf = (piece: Piece): number => all.findIndex((p) => p.chapter === piece.chapter && p.part === piece.part);
  const chosen = new Set<number>();
  for (const token of wanted.split(",").map((piece) => piece.trim()).filter(Boolean)) {
    const match = /^(\d+)(?:\.(\d+))?(?:\s*-\s*(\d+)(?:\.(\d+))?)?$/.exec(token);
    if (!match) return `Error: pages must be chapters or ranges such as '2', '1-3' or '3.2' (a chapter's part), not '${token}'`;
    const bound = (chapterText: string, partText: string | undefined, end: boolean): number | string => {
      const number = Number(chapterText);
      const chapter = chapters[number - 1];
      if (!chapter) return `Error: the book has chapters 1-${chapters.length}; '${token}' is not among them`;
      const part = partText ? Number(partText) : end ? chapter.parts.length : 1;
      if (part < 1 || part > chapter.parts.length) {
        return `Error: chapter ${number} has ${chapter.parts.length === 1 ? "one part" : `parts 1-${chapter.parts.length}`}; '${token}' is not among them`;
      }
      return indexOf({ chapter: number, part });
    };
    const first = bound(match[1], match[2], false);
    if (typeof first === "string") return first;
    const last = match[3] ? bound(match[3], match[4], true) : match[2] ? first : bound(match[1], undefined, true);
    if (typeof last === "string") return last;
    if (last < first) return `Error: '${token}' runs backwards`;
    for (let index = first; index <= last; index++) chosen.add(index);
  }
  return [...chosen].sort((a, b) => a - b).map((index) => all[index]);
}

/** *pieces* as the shortest pages that name them: runs of the book's order, a whole chapter by its number alone. */
function piecesText(pieces: Piece[], chapters: Chapter[]): string {
  // A run's first piece by its chapter alone when it starts the chapter, its last when it ends it
  const name = (piece: Piece, end: boolean): string => {
    const whole = end ? piece.part === chapters[piece.chapter - 1].parts.length : piece.part === 1;
    return whole ? String(piece.chapter) : `${piece.chapter}.${piece.part}`;
  };
  const next = (piece: Piece): Piece => (piece.part < chapters[piece.chapter - 1].parts.length
    ? { chapter: piece.chapter, part: piece.part + 1 } : { chapter: piece.chapter + 1, part: 1 });
  const runs: Piece[][] = [];
  for (const piece of pieces) {
    const run = runs[runs.length - 1];
    const following = run && next(run[run.length - 1]);
    if (following && following.chapter === piece.chapter && following.part === piece.part) run.push(piece);
    else runs.push([piece]);
  }
  return runs.map((run) => {
    const first = name(run[0], false);
    const last = name(run[run.length - 1], true);
    // A run inside one chapter that is the whole of it is just the chapter
    if (run[0].chapter === run[run.length - 1].chapter && run[0].part === 1
        && run[run.length - 1].part === chapters[run[0].chapter - 1].parts.length) return String(run[0].chapter);
    if (run.length === 1) return `${run[0].chapter}.${run[0].part}`;
    // The rest of one chapter names its last part too: "1.2-1.3", not "1.2-1"
    const end = run[run.length - 1];
    return `${first}-${end.chapter === run[0].chapter ? `${end.chapter}.${end.part}` : last}`;
  }).join(",");
}

/** The book in *parts* — its chapter list, or the chapters *pages* picks, as much as one answer holds. */
export function epubToMarkdown(parts: Map<string, string>, pages = ""): string {
  const book = epubBook(parts);
  const { chapters } = book;
  if (!chapters.length) return `The book${book.title ? ` "${book.title}"` : ""} has no readable chapters.`;
  if (!pages.trim()) {
    const list = chapters.map((chapter, index) => {
      const length = `${chapter.words} words${chapter.parts.length > 1 ? `, ${chapter.parts.length} parts` : ""}`;
      return `${"  ".repeat(chapter.depth)}${index + 1}. ${chapter.title} (${length})`;
    });
    const named = `${book.title ? `"${book.title}"` : ""}${book.author ? `${book.title ? " by " : "By "}${book.author}` : ""}`;
    const inParts = chapters.some((chapter) => chapter.parts.length > 1)
      ? `; a long chapter is read in parts ("3.2" is chapter 3's second)` : "";
    return `${named ? `${named} — ` : ""}${chapters.length} chapters. Read them with pages ("3", "1-2")${inParts}:\n\n${list.join("\n")}`;
  }
  const chosen = chapterPieces(pages, chapters);
  if (typeof chosen === "string") return chosen;
  const out: string[] = [];
  let length = 0;
  let shown = 0;
  for (const piece of chosen) {
    const chapter = chapters[piece.chapter - 1];
    const text = chapter.parts[piece.part - 1] || "(no text)";
    // At least one piece, then as many as fit in one answer
    if (shown && length + text.length > ANSWER_CHARS) break;
    const of = chapter.parts.length > 1 ? `, part ${piece.part}/${chapter.parts.length}` : "";
    out.push(`## Chapter ${piece.chapter}/${chapters.length}${of}\n\n${text}`);
    length += text.length;
    shown += 1;
  }
  const rest = chosen.slice(shown);
  if (rest.length) out.push(`[More to read: pages "${piecesText(rest, chapters)}".]`);
  return out.join("\n\n");
}

/**
 * The chapters *pages* picks, whole and one after another, for import_attachment (#331): no answer budget and no
 * "Chapter n/m" lines, as the text goes into a note, not to the model. The images the text names stay placeholders
 * (IMAGE_PLACEHOLDER); *images* lists their files in the archive. Every chapter when *pages* is empty.
 */
export function epubImportText(parts: Map<string, string>, pages = ""): { text: string; images: string[] } | string {
  const book = epubBook(parts, { images: true });
  if (!book.chapters.length) return `Error: the book${book.title ? ` "${book.title}"` : ""} has no readable chapters`;
  const chosen = chapterPieces(pages.trim() || `1-${book.chapters.length}`, book.chapters);
  if (typeof chosen === "string") return chosen;
  const text = chosen.map((piece) => book.chapters[piece.chapter - 1].parts[piece.part - 1]).filter(Boolean).join("\n\n");
  const images = [...new Set([...text.matchAll(IMAGE_PLACEHOLDER)].map((match) => match[1]))];
  return { text, images };
}
