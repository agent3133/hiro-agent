// The zip layer of the document readers (#211): what it unpacks, and what it refuses.
import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";

import { DocumentError, resolvePart, unzipText } from "./zip";

describe("unzipText", () => {
  const archive = zipSync({ "a.xml": strToU8("<a/>"), "b.bin": strToU8("x".repeat(5000)) });

  it("unpacks only the entries asked for, as text", () => {
    expect([...unzipText(archive, (name) => name.endsWith(".xml")).entries()]).toEqual([["a.xml", "<a/>"]]);
  });

  it("refuses an archive whose entries unpack past the limit, before unpacking them", () => {
    expect(() => unzipText(archive, () => true, 1000)).toThrow(DocumentError);
    expect(() => unzipText(archive, () => true, 1000)).toThrow(/unpacks to more than/);
  });

  it("says a file that is not a zip archive is not a readable document", () => {
    expect(() => unzipText(strToU8("plain text"), () => true)).toThrow(/not a readable document/);
  });
});

describe("resolvePart", () => {
  it("resolves a relationship target against the part that names it", () => {
    expect(resolvePart("xl/workbook.xml", "worksheets/sheet1.xml")).toBe("xl/worksheets/sheet1.xml");
    expect(resolvePart("ppt/slides/slide1.xml", "../notesSlides/notesSlide1.xml")).toBe("ppt/notesSlides/notesSlide1.xml");
    expect(resolvePart("word/document.xml", "/word/media/a.png")).toBe("word/media/a.png");
  });
});
