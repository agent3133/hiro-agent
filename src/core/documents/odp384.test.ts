// @vitest-environment jsdom
// ODP slides (#384): shapes inside draw:g groups, drawn shapes, tables in frames, and notes.
import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";

import { readDocument } from "./index";

const ODF = 'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" '
  + 'xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" '
  + 'xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" '
  + 'xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" '
  + 'xmlns:presentation="urn:oasis:names:tc:opendocument:xmlns:presentation:1.0"';

function odp(shapes: string): Uint8Array {
  return zipSync({
    "content.xml": strToU8(`<office:document-content ${ODF}><office:body><office:presentation>`
      + `<draw:page>${shapes}</draw:page></office:presentation></office:body></office:document-content>`),
  });
}

describe("odpToMarkdown (#384)", () => {
  it("1. a title frame and a frame inside a draw:g group", () => {
    const shapes = '<draw:frame presentation:class="title"><draw:text-box><text:p>Kickoff</text:p></draw:text-box></draw:frame>'
      + '<draw:g><draw:frame><draw:text-box><text:p>GROUPED</text:p></draw:text-box></draw:frame></draw:g>';
    const result = readDocument("odp", odp(shapes), "f.odp");
    expect(result).toContain("## Slide 1/1: Kickoff");
    expect(result).toContain("- GROUPED");
  });

  it("a draw:rect holding its text", () => {
    const shapes = '<draw:rect><text:p>RECT TEXT</text:p></draw:rect>';
    const result = readDocument("odp", odp(shapes), "f.odp");
    expect(result).toContain("- RECT TEXT");
  });

  it("frames and a grouped frame come out in document order", () => {
    const shapes = '<draw:frame><draw:text-box><text:p>FIRST</text:p></draw:text-box></draw:frame>'
      + '<draw:g><draw:frame><draw:text-box><text:p>SECOND</text:p></draw:text-box></draw:frame></draw:g>'
      + '<draw:frame><draw:text-box><text:p>THIRD</text:p></draw:text-box></draw:frame>';
    const result = readDocument("odp", odp(shapes), "f.odp");
    expect(result.indexOf("- FIRST")).toBeLessThan(result.indexOf("- SECOND"));
    expect(result.indexOf("- SECOND")).toBeLessThan(result.indexOf("- THIRD"));
  });

  it("2. a custom-shape holding its text", () => {
    const shapes = '<draw:custom-shape><text:p>SHAPE TEXT</text:p></draw:custom-shape>';
    const result = readDocument("odp", odp(shapes), "f.odp");
    expect(result).toContain("- SHAPE TEXT");
  });

  it("3. a table in a frame", () => {
    const cell = (text: string): string => `<table:table-cell><text:p>${text}</text:p></table:table-cell>`;
    const shapes = '<draw:frame><table:table>'
      + `<table:table-row>${cell("Q1")}${cell("Q2")}</table:table-row>`
      + `<table:table-row>${cell("10")}${cell("20")}</table:table-row>`
      + "</table:table></draw:frame>";
    const result = readDocument("odp", odp(shapes), "f.odp");
    expect(result).toContain("| Q1 | Q2 |");
    expect(result).toContain("| 10 | 20 |");
  });

  it("4. an outline frame and the slide's notes", () => {
    const shapes = '<draw:frame presentation:class="title"><draw:text-box><text:p>Kickoff</text:p></draw:text-box></draw:frame>'
      + '<draw:frame presentation:class="outline"><draw:text-box><text:p>Agenda</text:p></draw:text-box></draw:frame>'
      + '<presentation:notes><draw:frame presentation:class="notes"><draw:text-box><text:p>Speak slowly</text:p></draw:text-box></draw:frame></presentation:notes>';
    const result = readDocument("odp", odp(shapes), "f.odp");
    expect(result).toContain("## Slide 1/1: Kickoff");
    expect(result).toContain("- Agenda");
    expect(result).toContain("Notes: Speak slowly");
    expect(result.split("Speak slowly").length - 1).toBe(1);
  });
});
