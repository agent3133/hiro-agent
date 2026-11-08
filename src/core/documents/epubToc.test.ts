// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { epubWithToc } from "./fixtures";
import { readDocument } from "./index";

describe("epubToc", () => {
  it("nav toc lists 3 chapters and pages 2 shows only the second chapter's paragraph", () => {
    const book = epubWithToc({
      title: "Test Book",
      files: {
        "book.xhtml": `<h2 id="c1">One</h2><p>First paragraph</p><h2 id="c2">Two</h2><p>Second paragraph</p><h2 id="c3">Three</h2><p>Third paragraph</p>`,
      },
      toc: "nav",
      entries: [
        { title: "One", href: "text/book.xhtml#c1" },
        { title: "Two", href: "text/book.xhtml#c2" },
        { title: "Three", href: "text/book.xhtml#c3" },
      ],
    });
    const result = readDocument("epub", book, "test.epub");
    expect(result).toContain("3 chapters");
    expect(result).toContain("1. One");
    expect(result).toContain("2. Two");
    expect(result).toContain("3. Three");
    const pageResult = readDocument("epub", book, "test.epub", "2");
    expect(pageResult).toContain("Second paragraph");
    expect(pageResult).not.toContain("First paragraph");
    expect(pageResult).not.toContain("Third paragraph");
  });

  it("ncx toc gives the same list", () => {
    const book = epubWithToc({
      title: "Test Book",
      files: {
        "book.xhtml": `<h2 id="c1">One</h2><p>First paragraph</p><h2 id="c2">Two</h2><p>Second paragraph</p><h2 id="c3">Three</h2><p>Third paragraph</p>`,
      },
      toc: "ncx",
      entries: [
        { title: "One", href: "text/book.xhtml#c1" },
        { title: "Two", href: "text/book.xhtml#c2" },
        { title: "Three", href: "text/book.xhtml#c3" },
      ],
    });
    const result = readDocument("epub", book, "test.epub");
    expect(result).toContain("3 chapters");
    expect(result).toContain("1. One");
    expect(result).toContain("2. Two");
    expect(result).toContain("3. Three");
  });

  it("nav entries with children list child indented and numbering continues through", () => {
    const book = epubWithToc({
      title: "Test Book",
      files: {
        "book.xhtml": `<h2 id="c1">Parent</h2><p>Parent para</p><h2 id="c2">Child</h2><p>Child para</p><h2 id="c3">Next</h2><p>Next para</p>`,
      },
      toc: "nav",
      entries: [
        { title: "Parent", href: "text/book.xhtml#c1", children: [
          { title: "Child", href: "text/book.xhtml#c2" },
        ]},
        { title: "Next", href: "text/book.xhtml#c3" },
      ],
    });
    const result = readDocument("epub", book, "test.epub");
    expect(result).toContain("\n1. Parent");
    expect(result).toContain("  2. Child");
    expect(result).toContain("\n3. Next");
  });

  it("preface before first anchor listed as 'Before the contents' and author shows in first line", () => {
    const book = epubWithToc({
      title: "My Title",
      author: "Author",
      files: {
        "book.xhtml": `<p>Preface words here</p><h2 id="c1">One</h2><p>First paragraph</p><h2 id="c2">Two</h2><p>Second paragraph</p>`,
      },
      toc: "nav",
      entries: [
        { title: "One", href: "text/book.xhtml#c1" },
        { title: "Two", href: "text/book.xhtml#c2" },
      ],
    });
    const result = readDocument("epub", book, "test.epub");
    expect(result).toContain('"My Title" by Author');
    expect(result).toContain("1. Before the contents");
  });

  it("toc links to non-existent anchors falls back to one chapter per file named by first heading", () => {
    const book = epubWithToc({
      title: "Test Book",
      files: {
        "a.xhtml": `<h1>Alpha</h1><p>Alpha content</p>`,
        "b.xhtml": `<h1>Beta</h1><p>Beta content</p>`,
      },
      toc: "nav",
      entries: [
        { title: "Contents A", href: "text/a.xhtml#nonexistent" },
        { title: "Contents B", href: "text/b.xhtml#nonexistent" },
      ],
    });
    const result = readDocument("epub", book, "test.epub");
    expect(result).toContain("1. Alpha");
    expect(result).toContain("2. Beta");
    expect(result).not.toContain("Contents A");
  });

  it("nav toc with only-heading entries merges them and pages 1 shows merged content", () => {
    const book = epubWithToc({
      title: "Test Book",
      files: {
        "book.xhtml": `<h1 id="t">Title</h1><h3 id="s">or</h3><h2 id="r">Rules</h2><p>Rule text here</p><h2 id="n">Next</h2><p>More text</p>`,
      },
      toc: "nav",
      entries: [
        { title: "Title", href: "text/book.xhtml#t" },
        { title: "Sub", href: "text/book.xhtml#s" },
        { title: "Rules", href: "text/book.xhtml#r" },
        { title: "Next", href: "text/book.xhtml#n" },
      ],
    });
    const result = readDocument("epub", book, "test.epub");
    expect(result).toContain("2 chapters");
    expect(result).toContain("1. Rules");
    expect(result).toContain("2. Next");
    const pageResult = readDocument("epub", book, "test.epub", "1");
    expect(pageResult).toContain("# Title");
    expect(pageResult).toContain("### or");
    expect(pageResult).toContain("## Rules");
    expect(pageResult).toContain("Rule text here");
  });

  it("last entry with only its heading stays as its own chapter", () => {
    const book = epubWithToc({
      title: "Test Book",
      files: {
        "book.xhtml": `<h2 id="a">A</h2><p>Text</p><h2 id="b">B</h2>`,
      },
      toc: "nav",
      entries: [
        { title: "A", href: "text/book.xhtml#a" },
        { title: "B", href: "text/book.xhtml#b" },
      ],
    });
    const result = readDocument("epub", book, "test.epub");
    expect(result).toContain("2 chapters");
    expect(result).toContain("2. B");
  });
});
