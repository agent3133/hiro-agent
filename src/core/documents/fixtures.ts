/**
 * Small Office files built in memory, for the document readers' tests (#211): only the parts a reader looks at,
 * zipped with fflate as Word, Excel and PowerPoint write them.
 */

import { strToU8, zipSync } from "fflate";

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" '
  + 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const PKG = 'xmlns="http://schemas.openxmlformats.org/package/2006/relationships"';

function zip(files: Record<string, string>): Uint8Array {
  return zipSync(Object.fromEntries(Object.entries(files).map(([name, text]) => [name, strToU8(text)])));
}

/** A run of text. */
export const run = (text: string): string => `<w:r><w:t xml:space="preserve">${text}</w:t></w:r>`;
/** A paragraph, with a style ("Heading1") or a list (numId, level) when given. */
export function para(text: string, options: { style?: string; numId?: number; level?: number } = {}): string {
  const style = options.style ? `<w:pStyle w:val="${options.style}"/>` : "";
  const list = options.numId !== undefined
    ? `<w:numPr><w:ilvl w:val="${options.level ?? 0}"/><w:numId w:val="${options.numId}"/></w:numPr>` : "";
  return `<w:p>${style || list ? `<w:pPr>${style}${list}</w:pPr>` : ""}${run(text)}</w:p>`;
}
/** A table of plain-text cells. */
export const table = (rows: string[][]): string =>
  `<w:tbl>${rows.map((row) => `<w:tr>${row.map((c) => `<w:tc>${para(c)}</w:tc>`).join("")}</w:tr>`).join("")}</w:tbl>`;

/**
 * A .docx whose body is *body* (paragraphs and tables from para() and table()). Styles Heading1–3 and Title are
 * defined; numId 1 is a bullet list and numId 2 a numbered one; *links* are external hyperlink targets by id.
 */
export function docx(body: string, links: Record<string, string> = {}): Uint8Array {
  const styles = `<w:styles ${W}>`
    + [1, 2, 3].map((n) => `<w:style w:type="paragraph" w:styleId="Heading${n}"><w:name w:val="heading ${n}"/></w:style>`).join("")
    + `<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/></w:style>`
    // List styles without a numbering definition, as python-docx's default template has them
    + `<w:style w:type="paragraph" w:styleId="ListBullet"><w:name w:val="List Bullet"/></w:style>`
    + `<w:style w:type="paragraph" w:styleId="ListNumber2"><w:name w:val="List Number 2"/></w:style></w:styles>`;
  const level = (format: string): string => `<w:lvl w:ilvl="0"><w:numFmt w:val="${format}"/></w:lvl>`
    + `<w:lvl w:ilvl="1"><w:numFmt w:val="${format}"/></w:lvl>`;
  const numbering = `<w:numbering ${W}><w:abstractNum w:abstractNumId="0">${level("bullet")}</w:abstractNum>`
    + `<w:abstractNum w:abstractNumId="1">${level("decimal")}</w:abstractNum>`
    + `<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num><w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num></w:numbering>`;
  const rels = `<Relationships ${PKG}>${Object.entries(links).map(([id, target]) =>
    `<Relationship Id="${id}" Type="${REL}/hyperlink" Target="${target}" TargetMode="External"/>`).join("")}</Relationships>`;
  return zip({ "word/document.xml": `<w:document ${W}><w:body>${body}</w:body></w:document>`,
               "word/styles.xml": styles, "word/numbering.xml": numbering, "word/_rels/document.xml.rels": rels });
}

const S = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
  + 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';

/** A cell value: a number, a shared string (by its text), or a date (a number shown with style 1, a date format). */
export type Cell = number | string | { date: number } | { formula: string; value: number };

/** A .xlsx with *sheets*, each a name and rows of cells; strings go to the shared-string table. */
export function xlsx(sheets: { name: string; rows: Cell[][] }[], options: { date1904?: boolean } = {}): Uint8Array {
  const shared: string[] = [];
  const files: Record<string, string> = {};
  sheets.forEach((sheet, index) => {
    const rows = sheet.rows.map((row, r) => `<row r="${r + 1}">${row.map((cell, c) => {
      const ref = `${String.fromCharCode(65 + c)}${r + 1}`;
      if (typeof cell === "number") return `<c r="${ref}"><v>${cell}</v></c>`;
      if (typeof cell === "string") {
        if (!shared.includes(cell)) shared.push(cell);
        return `<c r="${ref}" t="s"><v>${shared.indexOf(cell)}</v></c>`;
      }
      if ("date" in cell) return `<c r="${ref}" s="1"><v>${cell.date}</v></c>`;
      // NaN: a formula never calculated, without a value
      return `<c r="${ref}"><f>${cell.formula}</f>${Number.isNaN(cell.value) ? "" : `<v>${cell.value}</v>`}</c>`;
    }).join("")}</row>`).join("");
    files[`xl/worksheets/sheet${index + 1}.xml`] = `<worksheet ${S}><sheetData>${rows}</sheetData></worksheet>`;
  });
  files["xl/workbook.xml"] = `<workbook ${S}>${options.date1904 ? '<workbookPr date1904="1"/>' : ""}<sheets>`
    + sheets.map((s, i) => `<sheet name="${s.name}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("") + "</sheets></workbook>";
  files["xl/_rels/workbook.xml.rels"] = `<Relationships ${PKG}>` + sheets.map((_, i) =>
    `<Relationship Id="rId${i + 1}" Type="${REL}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("") + "</Relationships>";
  files["xl/sharedStrings.xml"] = `<sst ${S}>${shared.map((s) => `<si><t>${s}</t></si>`).join("")}</sst>`;
  // Style 0 is general, style 1 the built-in date format 14
  files["xl/styles.xml"] = `<styleSheet ${S}><cellXfs><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs></styleSheet>`;
  return zip(files);
}

const P = 'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" '
  + 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" '
  + 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';

const shape = (type: string, paragraphs: { text: string; level?: number }[]): string =>
  `<p:sp><p:nvSpPr><p:cNvPr id="1" name="s"/><p:cNvSpPr/><p:nvPr>${type ? `<p:ph type="${type}"/>` : ""}</p:nvPr></p:nvSpPr>`
  + `<p:txBody>${paragraphs.map((p) => `<a:p>${p.level ? `<a:pPr lvl="${p.level}"/>` : ""}<a:r><a:t>${p.text}</a:t></a:r></a:p>`).join("")}</p:txBody></p:sp>`;

/** A .pptx with *slides*: a title, bullet lines ("  " per level of indent), and speaker notes. */
export function pptx(slides: { title?: string; bullets?: string[]; notes?: string }[]): Uint8Array {
  const files: Record<string, string> = {};
  slides.forEach((slide, index) => {
    const n = index + 1;
    const bullets = (slide.bullets ?? []).map((b) => ({ text: b.trim(), level: (b.length - b.trimStart().length) / 2 }));
    files[`ppt/slides/slide${n}.xml`] = `<p:sld ${P}><p:cSld><p:spTree>`
      + (slide.title ? shape("title", [{ text: slide.title }]) : "") + (bullets.length ? shape("body", bullets) : "")
      + "</p:spTree></p:cSld></p:sld>";
    if (slide.notes) {
      files[`ppt/notesSlides/notesSlide${n}.xml`] = `<p:notes ${P}><p:cSld><p:spTree>${shape("body", [{ text: slide.notes }])}`
        + "</p:spTree></p:cSld></p:notes>";
      files[`ppt/slides/_rels/slide${n}.xml.rels`] = `<Relationships ${PKG}><Relationship Id="rId9" `
        + `Type="${REL}/notesSlide" Target="../notesSlides/notesSlide${n}.xml"/></Relationships>`;
    }
  });
  files["ppt/presentation.xml"] = `<p:presentation ${P}><p:sldIdLst>`
    + slides.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 1}"/>`).join("") + "</p:sldIdLst></p:presentation>";
  files["ppt/_rels/presentation.xml.rels"] = `<Relationships ${PKG}>` + slides.map((_, i) =>
    `<Relationship Id="rId${i + 1}" Type="${REL}/slide" Target="slides/slide${i + 1}.xml"/>`).join("") + "</Relationships>";
  return zip(files);
}

const ODF = 'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" '
  + 'xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" '
  + 'xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" '
  + 'xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" '
  + 'xmlns:presentation="urn:oasis:names:tc:opendocument:xmlns:presentation:0.9" '
  + 'xmlns:xlink="http://www.w3.org/1999/xlink"';

/** An OpenDocument file whose `office:body` holds *body*; *styles* go to `office:automatic-styles`. */
function odf(body: string, styles = ""): Uint8Array {
  return zip({ "content.xml": `<office:document-content ${ODF}><office:automatic-styles>${styles}</office:automatic-styles>`
    + `<office:body>${body}</office:body></office:document-content>` });
}

/** A text document (.odt): *content* is the inside of `office:text`. List style "Num" numbers, "Bul" bullets. */
export function odt(content: string): Uint8Array {
  const styles = '<text:list-style style:name="Num" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0">'
    + '<text:list-level-style-number text:level="1"/></text:list-style>'
    + '<text:list-style style:name="Bul" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0">'
    + '<text:list-level-style-bullet text:level="1"/></text:list-style>';
  return odf(`<office:text>${content}</office:text>`, styles);
}

/** A spreadsheet (.ods): each sheet a name and rows; numbers as floats, { date } as ISO date strings. */
export function ods(sheets: { name: string; rows: (number | string | { date: string })[][] }[]): Uint8Array {
  const cell = (value: number | string | { date: string }): string => {
    if (typeof value === "number") return `<table:table-cell office:value-type="float" office:value="${value}"><text:p>${value}</text:p></table:table-cell>`;
    if (typeof value === "string") return `<table:table-cell office:value-type="string"><text:p>${value}</text:p></table:table-cell>`;
    return `<table:table-cell office:value-type="date" office:date-value="${value.date}"><text:p>x</text:p></table:table-cell>`;
  };
  // As LibreOffice writes it: the rest of each row, and of the sheet, as one huge repeated empty cell or row
  return odf(`<office:spreadsheet>${sheets.map((sheet) => `<table:table table:name="${sheet.name}">`
    + sheet.rows.map((row) => `<table:table-row>${row.map(cell).join("")}<table:table-cell table:number-columns-repeated="1020"/></table:table-row>`).join("")
    + '<table:table-row table:number-rows-repeated="1048000"><table:table-cell table:number-columns-repeated="1024"/></table:table-row>'
    + "</table:table>").join("")}</office:spreadsheet>`);
}

/** A presentation (.odp): slides with a title, bullet lines and notes. */
export function odp(slides: { title?: string; bullets?: string[]; notes?: string }[]): Uint8Array {
  const frame = (cls: string, inner: string): string =>
    `<draw:frame presentation:class="${cls}"><draw:text-box>${inner}</draw:text-box></draw:frame>`;
  return odf(`<office:presentation>${slides.map((slide, i) => `<draw:page draw:name="page${i + 1}">`
    + (slide.title ? frame("title", `<text:p>${slide.title}</text:p>`) : "")
    + (slide.bullets ? frame("outline", `<text:list>${slide.bullets.map((b) => `<text:list-item><text:p>${b}</text:p></text:list-item>`).join("")}</text:list>`) : "")
    + (slide.notes ? `<presentation:notes>${frame("notes", `<text:p>${slide.notes}</text:p>`)}</presentation:notes>` : "")
    + "</draw:page>").join("")}</office:presentation>`);
}

/** An EPUB with *chapters* (XHTML body contents) in spine order, and a title. */
export function epub(title: string, chapters: string[]): Uint8Array {
  const files: Record<string, string> = {
    "mimetype": "application/epub+zip",
    "META-INF/container.xml": '<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles>'
      + '<rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
    "OEBPS/content.opf": '<package xmlns="http://www.idpf.org/2007/opf" xmlns:dc="http://purl.org/dc/elements/1.1/">'
      + `<metadata><dc:title>${title}</dc:title></metadata><manifest>`
      + chapters.map((_, i) => `<item id="c${i + 1}" href="text/ch${i + 1}.xhtml" media-type="application/xhtml+xml"/>`).join("")
      + `</manifest><spine>${chapters.map((_, i) => `<itemref idref="c${i + 1}"/>`).join("")}</spine></package>`,
  };
  chapters.forEach((body, i) => {
    files[`OEBPS/text/ch${i + 1}.xhtml`] = `<html xmlns="http://www.w3.org/1999/xhtml"><head><title>c</title></head><body>${body}</body></html>`;
  });
  return zip(files);
}
