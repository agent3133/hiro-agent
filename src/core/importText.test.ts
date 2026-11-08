import { describe, expect, it } from "vitest";
import { demoteHeadings, placeImport } from "./importText";

describe("placeImport", () => {
  it("new note (null current) gives content 'Text\\n' and replaces false", () => {
    const result = placeImport(null, "Text", "");
    expect(result.content).toBe("Text\n");
    expect(result.replaces).toBe(false);
  });

  it("new note with title heading moves text heading below new section heading", () => {
    const result = placeImport(null, "# Title\nText", "Content");
    expect(result.content.startsWith("## Content\n\n### Title")).toBe(true);
    expect(result.replaces).toBe(false);
  });

  it("existing note with Content section replaces old text, keeps Related section", () => {
    const current = "# N\n\n## Content\n\nold words\n\n## Related\n\n- [[X]]\n";
    const result = placeImport(current, "New text", "Content");
    expect(result.content).toContain("New text");
    expect(result.content).toContain("## Related\n\n- [[X]]");
    expect(result.content).not.toContain("old words");
    expect(result.replaces).toBe(true);
  });

  it("existing note with empty Content section does not replace", () => {
    const current = "# N\n\n## Content\n\n## Related\n";
    const result = placeImport(current, "New text", "Content");
    expect(result.content).toContain("New text");
    expect(result.replaces).toBe(false);
  });

  it("text with its own heading comes out demoted under the section heading", () => {
    const current = "# N\n\n## Content\n\nold words\n";
    const result = placeImport(current, "## Chapter\nSome text", "Content");
    expect(result.content).toContain("### Chapter\nSome text");
  });

  it("second import replaces the first import's text, no leftovers", () => {
    const current = "# N\n\n## Content\n\nold text\n";
    const first = placeImport(current, "## Chapter\nSome text", "Content");
    const second = placeImport(first.content, "## Other\nMore text", "Content");
    expect(second.content).toContain("\n### Other\nMore text");
    expect(second.content).not.toContain("Some text");
    expect(second.content).not.toContain("old text");
  });

  it("missing heading adds ## Missing with text at end of note", () => {
    const current = "# N\n\nSome intro\n";
    const result = placeImport(current, "Body text", "Missing");
    expect(result.content).toContain("## Missing");
    expect(result.content).toContain("Body text");
    expect(result.replaces).toBe(false);
  });

  it("no heading appends text at end after a blank line", () => {
    const current = "# N\n\nSome intro\n";
    const result = placeImport(current, "Body text", "");
    expect(result.content).toContain("Some intro\n\nBody text");
    expect(result.replaces).toBe(false);
  });
});

describe("demoteHeadings", () => {
  it("headings inside a code fence are left alone", () => {
    const text = "# Title\n\n```\n# Not a heading\n## Also not\n```\n## Sub";
    const result = demoteHeadings(text, 3);
    expect(result).toContain("```\n# Not a heading\n## Also not\n```");
    expect(result.startsWith("### Title")).toBe(true);
    expect(result.endsWith("\n#### Sub")).toBe(true);
  });
});

describe("CRLF line endings", () => {
  it("a note with CRLF line endings keeps CRLF in the result", () => {
    const current = "# N\r\n\r\n## Content\r\n\r\nold words\r\n";
    const result = placeImport(current, "New text", "Content");
    const lines = result.content.split("\r\n");
    for (const line of lines) {
      expect(line).not.toContain("\n");
    }
    expect(result.content).toContain("New text");
  });
});
