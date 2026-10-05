/**
 * An Excel workbook (`.xlsx`) as Markdown tables, one per sheet (#211). Each cell shows the value Excel last
 * calculated — a formula's result, not the formula — and dates as dates, recognised from the cell's number format.
 * A long sheet is cut at MAX_ROWS rows, saying how many it left out.
 */

import { pageNumbers } from "../pageNumbers";
import { attr, child, children, descendants, markdownTable, parseXml, relationships, relId } from "./xml";
import { DocumentError, resolvePart } from "./zip";

const WORKBOOK = "xl/workbook.xml";
/** Rows per sheet: more would crowd out the context window, and a model reads a table's start best. */
export const MAX_ROWS = 300;

export const XLSX_PARTS = (name: string): boolean => name.startsWith("xl/") && (name.endsWith(".xml") || name.endsWith(".rels"));

/** Excel's built-in date and time formats (ECMA-376 §18.8.30). */
const BUILTIN_DATES = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);

/** Which cell styles show a date, by their index in cellXfs. */
function dateStyles(stylesXml: string | undefined): Set<number> {
  const dates = new Set<number>();
  if (!stylesXml) return dates;
  const document = parseXml(stylesXml);
  const custom = new Map<number, string>();
  for (const format of descendants(document, "numFmt")) custom.set(Number(attr(format, "numFmtId")), attr(format, "formatCode"));
  const xfs = descendants(document, "cellXfs")[0];
  children(xfs ?? document.documentElement, "xf").forEach((xf, index) => {
    const id = Number(attr(xf, "numFmtId") || "0");
    // A custom format is a date when it has date or time letters outside quoted text and [colour] brackets
    const code = (custom.get(id) ?? "").replace(/"[^"]*"|\[[^\]]*\]|\\./g, "");
    if (BUILTIN_DATES.has(id) || /[dmyhs]/i.test(code)) dates.add(index);
  });
  return dates;
}

/** An Excel date serial as ISO date (and time, when it has one). */
export function excelDate(serial: number, date1904 = false): string {
  // Days since 1970: serial 25569 is 1970-01-01 in the 1900 system, 24107 in the 1904 one (old Mac workbooks)
  const days = serial - (date1904 ? 24107 : 25569);
  const date = new Date(Math.round(days * 86_400_000));
  const iso = date.toISOString();
  return serial % 1 === 0 ? iso.slice(0, 10) : `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
}

/** "B3" → column index 1. */
function column(reference: string): number {
  let index = 0;
  for (const letter of reference.replace(/\d+$/, "")) index = index * 26 + (letter.charCodeAt(0) - 64);
  return index - 1;
}

/** The workbook's sheets as Markdown; *pages* picks sheets by number ("2", "1-3"), all when empty. */
export function xlsxToMarkdown(parts: Map<string, string>, pages = ""): string {
  const workbookXml = parts.get(WORKBOOK);
  if (!workbookXml) throw new DocumentError("it has no xl/workbook.xml, so it is not an Excel workbook");
  const workbook = parseXml(workbookXml);
  const date1904 = attr(descendants(workbook, "workbookPr")[0] ?? null, "date1904") === "1";
  const links = relationships(parts.get("xl/_rels/workbook.xml.rels"));
  const sheets = descendants(workbook, "sheet").map((sheet) => ({
    name: attr(sheet, "name"),
    path: resolvePart(WORKBOOK, links.get(relId(sheet))?.target ?? ""),
  }));
  if (!sheets.length) return "The workbook has no sheets.";
  const chosen = pageNumbers(pages, sheets.length);
  if (typeof chosen === "string") return chosen.replace("the PDF has pages", "the workbook has sheets");

  const shared = descendants(parseXml(parts.get("xl/sharedStrings.xml") ?? "<sst/>"), "si")
    .map((item) => descendants(item, "t").map((t) => t.textContent ?? "").join(""));
  const dates = dateStyles(parts.get("xl/styles.xml"));

  const value = (c: Element): string => {
    const type = attr(c, "t");
    const raw = child(c, "v")?.textContent ?? "";
    // A formula never calculated (a file written by a program, not saved by Excel): the formula, rather than nothing
    const formula = child(c, "f")?.textContent;
    if (!raw && formula) return `=${formula}`;
    if (type === "s") return shared[Number(raw)] ?? "";
    if (type === "inlineStr") return descendants(c, "t").map((t) => t.textContent ?? "").join("");
    if (type === "b") return raw === "1" ? "TRUE" : "FALSE";
    if (type === "e" || type === "str") return raw;
    if (raw && dates.has(Number(attr(c, "s") || "-1")) && !Number.isNaN(Number(raw))) return excelDate(Number(raw), date1904);
    return raw;
  };

  const out: string[] = [];
  for (const number of chosen) {
    const sheet = sheets[number - 1];
    const xml = parts.get(sheet.path);
    const heading = `## Sheet ${number}/${sheets.length}: ${sheet.name}`;
    if (!xml) {
      out.push(`${heading}\n\n(not a worksheet: a chart or macro sheet)`);
      continue;
    }
    const rows: string[][] = [];
    for (const row of descendants(parseXml(xml), "row")) {
      const cells: string[] = [];
      for (const c of children(row, "c")) cells[column(attr(c, "r") || "A1")] = value(c);
      const filled = Array.from(cells, (text) => text ?? "");
      if (filled.some((text) => text.trim())) rows.push(filled);
    }
    if (!rows.length) {
      out.push(`${heading}\n\n(empty)`);
      continue;
    }
    const shown = rows.slice(0, MAX_ROWS + 1);
    const left = rows.length - shown.length;
    const size = `${rows.length} row${rows.length === 1 ? "" : "s"}`;
    out.push(`${heading} (${size})\n\n${markdownTable(shown)}`
             + (left ? `\n\n[${left} more rows not shown — the sheet is cut at ${MAX_ROWS} rows]` : ""));
  }
  return out.join("\n\n");
}
