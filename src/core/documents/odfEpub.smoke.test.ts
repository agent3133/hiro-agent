// @vitest-environment jsdom
// End to end through readDocument with the OpenDocument and EPUB fixtures (#212, #213).
import { describe, expect, it } from "vitest";

import { epub, odp, ods, odt } from "./fixtures";
import { readDocument } from "./index";

describe("OpenDocument and EPUB", () => {
  it("reads an .odt as Markdown", () => {
    const file = odt('<text:h text:outline-level="1">Plan</text:h><text:p>Intro <text:a xlink:href="https://x.org">site</text:a>.</text:p>'
      + '<text:list text:style-name="Num"><text:list-item><text:p>one</text:p></text:list-item><text:list-item><text:p>two</text:p></text:list-item></text:list>');
    expect(readDocument("odt", file, "p.odt")).toBe("OpenDocument text 'p.odt':\n\n# Plan\n\nIntro [site](https://x.org).\n\n1. one\n2. two");
  });

  it("reads an .ods sheet without LibreOffice's repeated empty cells and rows", () => {
    const file = ods([{ name: "Budget", rows: [["Item", "Due"], ["Movers", { date: "2026-10-15" }]] }]);
    expect(readDocument("ods", file, "b.ods")).toBe(
      "OpenDocument spreadsheet 'b.ods':\n\n## Sheet 1/1: Budget (2 rows)\n\n| Item | Due |\n| --- | --- |\n| Movers | 2026-10-15 |");
  });

  it("reads an .odp slide by slide with notes", () => {
    const file = odp([{ title: "Kick-off", bullets: ["Goals"], notes: "Say hello" }, { title: "Plan" }]);
    expect(readDocument("odp", file, "d.odp", "1")).toBe(
      "OpenDocument presentation 'd.odp':\n\n## Slide 1/2: Kick-off\n\n- Goals\n\nNotes: Say hello");
  });

  it("lists an EPUB's chapters, and reads the ones pages picks", () => {
    const file = epub("A Book", ["<h1>Start</h1><p>One two three.</p>", "<h1>End</h1><p>Done&nbsp;now.</p><ul><li>a<ul><li>b</li></ul></li></ul>"]);
    expect(readDocument("epub", file, "b.epub")).toBe(
      "EPUB book 'b.epub':\n\n\"A Book\" — 2 chapters. Read them with pages (\"3\", \"1-2\"):\n\n1. Start (5 words)\n2. End (8 words)");
    expect(readDocument("epub", file, "b.epub", "2")).toBe(
      "EPUB book 'b.epub':\n\n## Chapter 2/2\n\n# End\n\nDone now.\n\n- a\n  - b");
  });
});
