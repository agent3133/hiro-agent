// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { odt, ods, epub } from "./fixtures";
import { readDocument } from "./index";

describe("odfEpub", () => {
  it("odt list with text:style-name='Bul' gives '- x' items", () => {
    const doc = odt(
      '<text:list text:style-name="Bul"><text:list-item><text:p>Item 1</text:p></text:list-item>'
      + '<text:list-item><text:p>Item 2</text:p></text:list-item></text:list>'
    );
    const result = readDocument("odt", doc, "test.odt");
    expect(result).toContain("- Item 1");
    expect(result).toContain("- Item 2");
  });

  it("nested text:list inside a text:list-item is indented by two spaces", () => {
    const doc = odt(
      '<text:list text:style-name="Bul"><text:list-item><text:p>Parent</text:p>'
      + '<text:list text:style-name="Bul"><text:list-item><text:p>Child</text:p></text:list-item></text:list>'
      + '</text:list-item></text:list>'
    );
    const result = readDocument("odt", doc, "test.odt");
    expect(result).toContain("- Parent");
    expect(result).toContain("  - Child");
  });

  it('ods with two sheets: pages "2" shows only "## Sheet 2/2: <name>"', () => {
    const doc = ods([
      { name: "Sheet 1", rows: [["A1", "B1"]] },
      { name: "Sheet 2", rows: [["C2", "D2"]] },
    ]);
    const result = readDocument("ods", doc, "test.ods", "2");
    expect(result).toContain("## Sheet 2/2: Sheet 2");
    expect(result).toContain("C2");
    expect(result).not.toContain("A1");
  });

  it('ods pages "3" returns a string starting "Error:" that mentions "sheets"', () => {
    const doc = ods([
      { name: "Sheet 1", rows: [["A1"]] },
      { name: "Sheet 2", rows: [["B2"]] },
    ]);
    const result = readDocument("ods", doc, "test.ods", "3");
    expect(result.startsWith("Error:")).toBe(true);
    expect(result).toContain("sheets");
  });

  it("ods sheet with 305 data rows plus a header row shows '[5 more rows not shown'", () => {
    const rows: (number | string)[][] = [["Header"]];
    for (let i = 0; i < 305; i++) {
      rows.push([`Row ${i}`]);
    }
    const doc = ods([{ name: "BigSheet", rows }]);
    const result = readDocument("ods", doc, "test.ods");
    expect(result).toContain("[5 more rows not shown");
  });

  it('epub without pages lists every chapter as "N. <first heading> (<words> words)"', () => {
    const doc = epub("My Book", [
      "<h1>Chapter One</h1><p>Hello world</p>",
      "<h1>Chapter Two</h1><p>More text here</p>",
    ]);
    const result = readDocument("epub", doc, "mybook.epub");
    expect(result).toContain('1. Chapter One');
    expect(result).toContain('2. Chapter Two');
    expect(result).toContain("words");
  });

  it("epub chapter without a heading is listed as 'Chapter N'", () => {
    const doc = epub("My Book", [
      "<p>No heading here</p>",
    ]);
    const result = readDocument("epub", doc, "mybook.epub");
    expect(result).toContain("1. Chapter 1 (3 words)");
  });

  it('epub with pages "1-2" shows "## Chapter 1/3" and "## Chapter 2/3" but not "## Chapter 3/3"', () => {
    const doc = epub("My Book", [
      "<h1>Chapter One</h1><p>First</p>",
      "<h1>Chapter Two</h1><p>Second</p>",
      "<h1>Chapter Three</h1><p>Third</p>",
    ]);
    const result = readDocument("epub", doc, "mybook.epub", "1-2");
    expect(result).toContain("## Chapter 1/3");
    expect(result).toContain("## Chapter 2/3");
    expect(result).not.toContain("## Chapter 3/3");
  });

  it("bytes of 'hello' returns a string starting 'Error: could not read'", () => {
    const bytes = new TextEncoder().encode("hello");
    const result = readDocument("epub", bytes, "not-an-epub.epub");
    expect(result.startsWith("Error: could not read")).toBe(true);
  });
});
