// @vitest-environment jsdom
// Column placement (#381): a cell without a reference is the one after the last placed cell (xlsx),
// and empty repeated cells keep their count (ods).
import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";

import { readDocument } from "./index";

const XLSX = 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ';
const ODF = 'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" '
  + 'xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" '
  + 'xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0"';

function xlsx(row: string): Uint8Array {
  return zipSync(Object.fromEntries(Object.entries({
    "xl/workbook.xml": strToU8(`<workbook ${XLSX}><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>`),
    "xl/_rels/workbook.xml.rels": strToU8(
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>'),
    "xl/worksheets/sheet1.xml": strToU8(`<worksheet ${XLSX}><sheetData>${row}</sheetData></worksheet>`),
  })));
}

function ods(row: string): Uint8Array {
  return zipSync({
    "content.xml": strToU8(`<office:document-content ${ODF}><office:body><office:spreadsheet>`
      + `<table:table table:name="S">${row}</table:table></office:spreadsheet></office:body></office:document-content>`),
  });
}

const cell = (text: string, r = ""): string =>
  `<c${r ? ` r="${r}"` : ""} t="inlineStr"><is><t>${text}</t></is></c>`;

const ocell = (text: string): string =>
  `<table:table-cell office:value-type="string"><text:p>${text}</text:p></table:table-cell>`;

describe("column placement (#381)", () => {
  it("1. xlsx: a row of three cells without an r attribute keeps them in order", () => {
    const row = `<row>${cell("one")}${cell("two")}${cell("three")}</row>`;
    const result = readDocument("xlsx", xlsx(row), "f.xlsx");
    expect(result).toContain("| one | two | three |");
  });

  it("2. xlsx: a cell without an r follows the last referenced one, leaving gaps", () => {
    const row = `<row>${cell("a", "A1")}${cell("b")}${cell("d", "D1")}</row>`;
    const result = readDocument("xlsx", xlsx(row), "f.xlsx");
    expect(result).toContain("| a | b |  | d |");
  });

  it("3. ods: repeated empty cells keep their count, so later cells stay put", () => {
    const row = `<table:table-row>${ocell("A")}`
      + '<table:table-cell table:number-columns-repeated="3"/>'
      + `${ocell("E")}</table:table-row>`;
    const result = readDocument("ods", ods(row), "f.ods");
    expect(result).toContain("| A |  |  |  | E |");
  });

  it("4. ods: the empty rest of a row is not widened into columns", () => {
    const row = `<table:table-row>${ocell("A")}`
      + '<table:table-cell table:number-columns-repeated="16000"/>'
      + `</table:table-row>`;
    const result = readDocument("ods", ods(row), "f.ods");
    expect(result).toContain("| A |\n| --- |");
  });

  it("5. xlsx: two rows without r attributes give two table lines, one per row", () => {
    const rows = `<row>${cell("a")}</row><row>${cell("b")}</row>`;
    const result = readDocument("xlsx", xlsx(rows), "f.xlsx");
    expect(result).toContain("| a |");
    expect(result).toContain("| b |");
    expect(result.indexOf("| a |")).toBeLessThan(result.indexOf("| b |"));
  });
});
