// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import { xlsx } from "./fixtures";
import { readDocument } from "./index";
import { excelDate } from "./xlsx";

describe("xlsx", () => {
  it("formula cell shows calculated value, not formula text", () => {
    const file = xlsx([{ name: "Sheet1", rows: [["A", "B"], [42, { formula: "A1*2", value: 84 }]] }]);
    const result = readDocument("xlsx", file, "f.xlsx");
    expect(result).toContain("| 42 | 84 |");
    expect(result).not.toContain("A1*2");
  });

  it("excelDate(46296) is '2026-10-01'", () => {
    expect(excelDate(46296)).toBe("2026-10-01");
  });

  it("excelDate(46296.5) is '2026-10-01 12:00'", () => {
    expect(excelDate(46296.5)).toBe("2026-10-01 12:00");
  });

  it("excelDate(44834, true) is '2026-10-01' (1904 date system)", () => {
    expect(excelDate(44834, true)).toBe("2026-10-01");
  });

  it("pages '2' shows only sheet 2, not sheet 1", () => {
    const file = xlsx([
      { name: "Sheet 1", rows: [["A"], ["1"]] },
      { name: "Sheet 2", rows: [["B"], ["2"]] },
    ]);
    const result = readDocument("xlsx", file, "m.xlsx", "2");
    expect(result).toContain("## Sheet 2/2: Sheet 2");
    expect(result).not.toContain("## Sheet 1/2: Sheet 1");
  });

  it("pages '3' gives an error mentioning sheets", () => {
    const file = xlsx([
      { name: "Sheet 1", rows: [["A"]] },
      { name: "Sheet 2", rows: [["B"]] },
    ]);
    const result = readDocument("xlsx", file, "m.xlsx", "3");
    expect(result).toContain("Error:");
    expect(result).toContain("sheets");
  });

  it("305 data rows plus header shows '[5 more rows not shown' and row 300 but not 301", () => {
    const rows: (string | number)[][] = [["Header"]];
    for (let i = 1; i <= 305; i++) {
      rows.push([`Row ${i}`]);
    }
    const file = xlsx([{ name: "Sheet1", rows }]);
    const result = readDocument("xlsx", file, "m.xlsx");
    expect(result).toContain("[5 more rows not shown");
    // Row 300 is the 300th data row, which is row index 301 in the array (0-indexed: row 301)
    // MAX_ROWS is 300, so shown = rows.slice(0, 301) = header + 300 data rows
    // Row with 300th data row should be included
    expect(result).toContain("| Row 300 |");
    // Row 301 should not be included
    expect(result).not.toContain("| Row 301 |");
  });

  it("empty sheet shows '(empty)' under its heading", () => {
    const file = xlsx([{ name: "Empty", rows: [] }]);
    const result = readDocument("xlsx", file, "e.xlsx");
    expect(result).toContain("## Sheet 1/1: Empty");
    expect(result).toContain("(empty)");
  });
});
