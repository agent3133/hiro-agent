// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { chapterToMarkdown, closeEmptyTags } from "./epub";

describe("chapterToMarkdown", () => {
  it("1. bold and italic inline elements become ** and *", () => {
    const result = chapterToMarkdown("<p>A <strong>bold</strong> and <em>soft</em> word, <b> spaced </b>end</p>");
    expect(result).toBe("A **bold** and *soft* word, **spaced** end");
  });

  it("1b. heading with inline element strips formatting", () => {
    const result = chapterToMarkdown("<h2>A <em>title</em></h2>");
    expect(result).toBe("## A title");
  });

  it("2. <hr/> becomes --- separator", () => {
    const result = chapterToMarkdown("<p>one</p><hr/><p>two</p>");
    expect(result).toContain("one");
    expect(result).toContain("---");
    expect(result).toContain("two");
    const lines = result.split("\n");
    const hrIndex = lines.indexOf("---");
    expect(hrIndex).toBe(2);
    expect(lines[hrIndex - 2]).toBe("one");
    expect(lines[hrIndex + 2]).toBe("two");
  });

  it("3. <br/> keeps a line break in the text", () => {
    const result = chapterToMarkdown("<p>Roses are red,<br/>violets are blue</p>");
    expect(result).toContain("Roses are red,\nviolets are blue");
  });

  it("4a. empty <pre/> does not swallow following blocks", () => {
    const result = chapterToMarkdown("<pre/><h1>Title</h1><p>Text</p>");
    expect(result).toContain("# Title");
    expect(result).toContain("Text");
    // The text should be a separate block, not on the same line as the heading
    const lines = result.split("\n");
    const headingIndex = lines.indexOf("# Title");
    const textIndex = lines.indexOf("Text");
    expect(headingIndex).toBeGreaterThanOrEqual(0);
    expect(textIndex).toBeGreaterThan(headingIndex!);
  });

  it("4b. closeEmptyTags closes self-closing tags", () => {
    const result = closeEmptyTags('<pre/><br/><span class="x"/>');
    expect(result).toBe("<pre></pre><br/><span class=\"x\"></span>");
  });

  it("5a. blockquote with nested div and paragraphs is quoted", () => {
    const result = chapterToMarkdown("<blockquote><div><p>First</p><p>Second</p></div></blockquote>");
    expect(result).toBe("> First\n>\n> Second");
  });

  it("5b. list with bullet character strips the bullet", () => {
    const result = chapterToMarkdown("<ul><li>• Item</li></ul>");
    expect(result).toBe("- Item");
  });
});
