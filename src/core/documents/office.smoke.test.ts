// @vitest-environment jsdom
// End to end through readDocument with the fixtures: the readers, the zip and the XML helpers together (#211).
import { describe, expect, it } from "vitest";

import { docx, para, pptx, table, xlsx } from "./fixtures";
import { readDocument } from "./index";

describe("readDocument", () => {
  it("reads a Word document as Markdown", () => {
    const file = docx(para("Plan", { style: "Heading1" }) + para("Intro text.") + para("one", { numId: 1 })
      + para("two", { numId: 1 }) + table([["Name", "Owner"], ["Atlas", "Maria"]]));
    expect(readDocument("docx", file, "Plan.docx")).toBe(
      "Word document 'Plan.docx':\n\n# Plan\n\nIntro text.\n\n- one\n- two\n\n| Name | Owner |\n| --- | --- |\n| Atlas | Maria |");
  });

  it("reads lists that their style defines, as Word's List Bullet and List Number 2", () => {
    const file = docx(para("milk", { style: "ListBullet" }) + para("first", { style: "ListNumber2" })
      + para("second", { style: "ListNumber2" }));
    expect(readDocument("docx", file, "l.docx")).toBe("Word document 'l.docx':\n\n- milk\n  1. first\n  2. second");
  });

  it("shows a formula that was never calculated, rather than an empty cell", () => {
    const file = xlsx([{ name: "S", rows: [["Sum"], [{ formula: "SUM(A1:A2)", value: Number.NaN }]] }]);
    expect(readDocument("xlsx", file, "f.xlsx")).toContain("| =SUM(A1:A2) |");
  });

  it("reads an Excel sheet as a table, dates as dates", () => {
    const file = xlsx([{ name: "Tasks", rows: [["Task", "Due"], ["Ship", { date: 46296 }]] }]);
    expect(readDocument("xlsx", file, "t.xlsx")).toBe(
      "Excel workbook 't.xlsx':\n\n## Sheet 1/1: Tasks (2 rows)\n\n| Task | Due |\n| --- | --- |\n| Ship | 2026-10-01 |");
  });

  it("reads a PowerPoint deck slide by slide with notes", () => {
    const file = pptx([{ title: "Kick-off", bullets: ["Goals", "  Budget"], notes: "Say hello" }]);
    expect(readDocument("pptx", file, "d.pptx")).toBe(
      "PowerPoint deck 'd.pptx':\n\n## Slide 1/1: Kick-off\n\n- Goals\n  - Budget\n\nNotes: Say hello");
  });
});
