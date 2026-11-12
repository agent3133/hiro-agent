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

describe("moved text, text boxes and nested tables (#383)", () => {
  it("moved text is read at its new place, once", () => {
    const file = docx(
      `<w:p><w:moveFrom w:id="1" w:author="a">${run("MOVED")}</w:moveFrom></w:p>`
      + `<w:p><w:moveTo w:id="2" w:author="a">${run("MOVED")}</w:moveTo></w:p>`
    );
    const result = readDocument("docx", file, "f.docx");
    expect(result.split("MOVED").length - 1).toBe(1);
  });

  it("a whole moved paragraph is read", () => {
    const file = docx(`<w:moveTo w:id="3" w:author="a"><w:p>${run("Whole moved paragraph")}</w:p></w:moveTo>`);
    const result = readDocument("docx", file, "f.docx");
    expect(result).toContain("Whole moved paragraph");
  });

  it("an AlternateContent text box is read once, from its choice", () => {
    const MC = `xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"`;
    const file = docx(
      `<w:p>${run("Before ")}<w:r><mc:AlternateContent ${MC}>`
      + `<mc:Choice Requires="wps"><w:drawing><w:txbxContent><w:p>${run("BOXED")}</w:p></w:txbxContent></w:drawing></mc:Choice>`
      + `<mc:Fallback><w:pict><w:txbxContent><w:p>${run("BOXED")}</w:p></w:txbxContent></w:pict></mc:Fallback>`
      + `</mc:AlternateContent></w:r></w:p>`
    );
    const result = readDocument("docx", file, "f.docx");
    expect(result).toContain("Before BOXED");
    expect(result.split("BOXED").length - 1).toBe(1);
    expect(result).not.toContain("[image]");
  });

  it("an AlternateContent without a text box is an image", () => {
    const MC = `xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"`;
    const file = docx(
      `<w:p><w:r><mc:AlternateContent ${MC}>`
      + `<mc:Choice Requires="wps"><w:drawing/></mc:Choice>`
      + `<mc:Fallback><w:pict/></mc:Fallback>`
      + `</mc:AlternateContent></w:r></w:p>`
    );
    const result = readDocument("docx", file, "f.docx");
    expect(result.split("[image]").length - 1).toBe(1);
  });

  it("a table cell holding a nested table flattens it into the cell", () => {
    const file = docx(
      `<w:tbl><w:tr>`
      + `<w:tc>${para("A")}</w:tc>`
      + `<w:tc>${para("Outer")}<w:tbl><w:tr><w:tc>${para("IN-A")}</w:tc><w:tc>${para("IN-B")}</w:tc></w:tr></w:tbl></w:tc>`
      + `</w:tr></w:tbl>`
    );
    const result = readDocument("docx", file, "f.docx");
    expect(result).toContain("Outer<br>IN-A / IN-B");
  });

  it("an AlternateContent with only a Fallback text box is read once, from the fallback", () => {
    const MC = `xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"`;
    const file = docx(
      `<w:p><w:r><mc:AlternateContent ${MC}>`
      + `<mc:Fallback><w:pict><w:txbxContent><w:p>${run("FALLBACK")}</w:p></w:txbxContent></w:pict></mc:Fallback>`
      + `</mc:AlternateContent></w:r></w:p>`
    );
    const result = readDocument("docx", file, "f.docx");
    expect(result).toContain("FALLBACK");
    expect(result.split("FALLBACK").length - 1).toBe(1);
  });

  it("a drawing text box without AlternateContent gives the box text, not an image", () => {
    const file = docx(
      `<w:p><w:r><w:drawing><w:txbxContent><w:p>${run("PLAIN BOX")}</w:p></w:txbxContent></w:drawing></w:r></w:p>`
    );
    const result = readDocument("docx", file, "f.docx");
    expect(result).toContain("PLAIN BOX");
    expect(result).not.toContain("[image]");
  });

  it("a nested table with two rows gives one line per row, cells joined by /", () => {
    const file = docx(
      `<w:tbl><w:tr>`
      + `<w:tc><w:tbl>`
      + `<w:tr><w:tc>${para("R1A")}</w:tc><w:tc>${para("R1B")}</w:tc></w:tr>`
      + `<w:tr><w:tc>${para("R2A")}</w:tc><w:tc>${para("R2B")}</w:tc></w:tr>`
      + `</w:tbl></w:tc>`
      + `</w:tr></w:tbl>`
    );
    const result = readDocument("docx", file, "f.docx");
    expect(result).toContain("R1A / R1B<br>R2A / R2B");
  });
});
