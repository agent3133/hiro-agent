// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { epub } from "./fixtures";
import { readDocument } from "./index";

describe("epub parts", () => {
  // Build a chapter with a heading and 30 paragraphs of ~1000 chars each
  const longChapter = "<h1>Long</h1>" + Array.from({ length: 30 }, () =>
    "<p>" + "word ".repeat(200) + "</p>"
  ).join("");

  const shortChapter = "<h1>Short</h1><p>Just a few words.</p>";

  it("1. long chapter listed with 3 parts and '(... words, 3 parts)'", () => {
    const doc = epub("Long Book", [longChapter]);
    const result = readDocument("epub", doc, "long.epub");
    expect(result).toContain("3 parts");
    expect(result).toContain("1. Long (");
    expect(result).toContain("words");
    // Should mention that a long chapter is read in parts
    expect(result).toContain("a long chapter is read in parts");
  });

  it("1b. pages 1.2 shows 'part 2/3' not 'part 1/3'", async () => {
    const doc = epub("Long Book", [longChapter]);
    const result = readDocument("epub", doc, "long.epub", "1.2");
    expect(result).toContain("## Chapter 1/1, part 2/3");
    expect(result).not.toContain("part 1/3");
  });

  it("1c. pages 1 shows part 1 only and ends with 'More to read' line", async () => {
    const doc = epub("Long Book", [longChapter]);
    const result = readDocument("epub", doc, "long.epub", "1");
    expect(result).toContain("## Chapter 1/1");
    expect(result).toContain("[More to read: pages \"1.2-1.3\".]");
    expect(result).not.toContain("part 2/3");
  });

  it("1d. pages 1.2 shows part 2 without the heading, which is in part 1", async () => {
    const doc = epub("Long Book", [longChapter]);
    const result = readDocument("epub", doc, "long.epub", "1.2");
    expect(result).toContain("## Chapter 1/1, part 2/3");
    expect(result).not.toContain("# Long");
  });

  it("2. two chapters: pages '1-2' ends with the pages still to read that include chapter 2", async () => {
    const doc = epub("Two Chaps", [longChapter, shortChapter]);
    const result = readDocument("epub", doc, "book.epub", "1-2");
    // Chapter 1 (3 parts) + chapter 2 (1 part) = 4 pieces total
    // Part 1 of chapter 1 should be shown, then "More to read" for the rest
    expect(result).toContain("## Chapter 1/2");
    expect(result).toContain("[More to read: pages");
    expect(result).toContain("[More to read: pages \"1.2-2\".]");
  });

  it("3. pages '2-1' is an error saying it runs backwards", async () => {
    const doc = epub("Two Chaps", [shortChapter, shortChapter]);
    const result = readDocument("epub", doc, "book.epub", "2-1");
    expect(result.startsWith("Error:")).toBe(true);
    expect(result).toContain("runs backwards");
  });

  it("4. pages '1.4' is an error naming the chapter's parts 1-3", async () => {
    const doc = epub("Long Book", [longChapter]);
    const result = readDocument("epub", doc, "long.epub", "1.4");
    expect(result.startsWith("Error:")).toBe(true);
    expect(result).toContain("parts 1-3");
  });

  it("5. pages 'x' is an error", async () => {
    const doc = epub("Book", [shortChapter]);
    const result = readDocument("epub", doc, "book.epub", "x");
    expect(result.startsWith("Error:")).toBe(true);
  });

  it("6. two short chapters with pages '1-2' shown together, no 'More to read'", async () => {
    const doc = epub("Two Short", [shortChapter, shortChapter]);
    const result = readDocument("epub", doc, "book.epub", "1-2");
    expect(result).toContain("## Chapter 1/2");
    expect(result).toContain("## Chapter 2/2");
    expect(result).not.toContain("[More to read:");
  });
});
