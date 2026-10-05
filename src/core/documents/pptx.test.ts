// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import { pptx } from "./fixtures";
import { readDocument } from "./index";

describe("pptx slides", () => {
  it("three slides with titles A, B, C appear in order", () => {
    const file = pptx([
      { title: "A" },
      { title: "B" },
      { title: "C" },
    ]);
    const result = readDocument("pptx", file, "d.pptx");
    expect(result).toContain("## Slide 1/3: A");
    expect(result).toContain("## Slide 2/3: B");
    expect(result).toContain("## Slide 3/3: C");
    const aIndex = result.indexOf("## Slide 1/3: A");
    const bIndex = result.indexOf("## Slide 2/3: B");
    const cIndex = result.indexOf("## Slide 3/3: C");
    expect(aIndex < bIndex).toBe(true);
    expect(bIndex < cIndex).toBe(true);
  });

  it("pages '2' shows only slide 2", () => {
    const file = pptx([
      { title: "A" },
      { title: "B" },
      { title: "C" },
    ]);
    const result = readDocument("pptx", file, "d.pptx", "2");
    expect(result).toContain("## Slide 2/3: B");
    expect(result).not.toContain("## Slide 1/3: A");
    expect(result).not.toContain("## Slide 3/3: C");
  });

  it("pages '1,3' shows slides 1 and 3 but not 2", () => {
    const file = pptx([
      { title: "A" },
      { title: "B" },
      { title: "C" },
    ]);
    const result = readDocument("pptx", file, "d.pptx", "1,3");
    expect(result).toContain("## Slide 1/3: A");
    expect(result).toContain("## Slide 3/3: C");
    expect(result).not.toContain("## Slide 2/3: B");
  });

  it("a slide without notes has no 'Notes:' line", () => {
    const file = pptx([{ title: "A" }]);
    const result = readDocument("pptx", file, "d.pptx");
    expect(result).toContain("## Slide 1/1: A");
    expect(result).not.toContain("Notes:");
  });

  it("a slide with notes ends with 'Notes: Remember the budget'", () => {
    const file = pptx([{ title: "A", notes: "Remember the budget" }]);
    const result = readDocument("pptx", file, "d.pptx");
    expect(result).toContain("Notes: Remember the budget");
  });

  it("a slide without a title is headed just '## Slide 1/1'", () => {
    const file = pptx([{ bullets: ["item one"] }]);
    const result = readDocument("pptx", file, "d.pptx");
    expect(result).toContain("## Slide 1/1");
    expect(result).not.toContain(": item");
  });

  it("pages '4' on a three-slide deck gives an error mentioning slides", () => {
    const file = pptx([
      { title: "A" },
      { title: "B" },
      { title: "C" },
    ]);
    const result = readDocument("pptx", file, "d.pptx", "4");
    expect(result).toContain("Error:");
    expect(result).toContain("slides");
  });
});
