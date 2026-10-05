// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import { docx, para, run } from "./fixtures";
import { readDocument } from "./index";

describe("docx styles", () => {
  it("Heading2 becomes ## Text", () => {
    const file = docx(para("Text", { style: "Heading2" }));
    expect(readDocument("docx", file, "d.docx")).toContain("## Text");
  });

  it("Title becomes # Text", () => {
    const file = docx(para("Text", { style: "Title" }));
    expect(readDocument("docx", file, "d.docx")).toContain("# Text");
  });
});

describe("numbered lists", () => {
  it("numId 2 items become 1. and 2.", () => {
    const file = docx(para("a", { numId: 2 }) + para("b", { numId: 2 }));
    const result = readDocument("docx", file, "d.docx");
    expect(result).toContain("1. a");
    expect(result).toContain("2. b");
  });

  it("bullet at level 1 is indented", () => {
    const file = docx(para("c", { numId: 1, level: 1 }));
    const result = readDocument("docx", file, "d.docx");
    expect(result).toContain("  - c");
  });
});

describe("hyperlinks", () => {
  it("hyperlink becomes [label](url)", () => {
    const file = docx(
      `<w:p><w:hyperlink r:id="rId5">${run("site")}</w:hyperlink></w:p>`,
      { rId5: "https://example.com" }
    );
    const result = readDocument("docx", file, "d.docx");
    expect(result).toContain("[site](https://example.com)");
  });
});

describe("deleted text", () => {
  it("deleted text is left out", () => {
    const file = docx(
      `<w:p>${run("kept")}<w:del><w:r><w:delText>gone</w:delText></w:r></w:del></w:p>`
    );
    const result = readDocument("docx", file, "d.docx");
    expect(result).toContain("kept");
    expect(result).not.toContain("gone");
  });
});

describe("error cases", () => {
  it("old .doc format returns an error mentioning .docx", () => {
    const result = readDocument("doc", new Uint8Array([1, 2, 3]), "old.doc");
    expect(result.startsWith("Error: 'old.doc' is in the old binary .doc format")).toBe(true);
    expect(result).toContain(".docx");
  });

  it("unreadable .docx returns an error", () => {
    const result = readDocument("docx", new Uint8Array([1, 2, 3]), "bad.docx");
    expect(result.startsWith("Error: could not read 'bad.docx'")).toBe(true);
  });
});
