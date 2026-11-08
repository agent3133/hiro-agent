// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { epubWithToc } from "./fixtures";
import { importDocument, type ImportedDocument } from "./index";
import { Journal } from "../journal";

describe("importDocument", () => {
  it("selects the second chapter (page 2) from a nav toc book", () => {
    const book = epubWithToc({
      title: "Test Book",
      files: {
        "book.xhtml": `<h2 id="c1">One</h2><p>First paragraph</p><h2 id="c2">Two</h2><p>Second paragraph</p>`,
      },
      toc: "nav",
      entries: [
        { title: "One", href: "text/book.xhtml#c1" },
        { title: "Two", href: "text/book.xhtml#c2" },
      ],
    });
    const result = importDocument("epub", book, "b.epub", "2");
    expect(typeof result).toBe("object");
    const doc = result as ImportedDocument;
    expect(doc.text).toContain("Second paragraph");
    expect(doc.text).not.toContain("First paragraph");
    expect(doc.text).not.toContain("## Chapter");
  });

  it("replaces images with placeholders and collects image bytes", async () => {
    const book = epubWithToc({
      title: "Test Book",
      files: {
        "book.xhtml": `<p><img src="../images/a.png" alt="A"/></p><p>Text after image</p>`,
      },
      toc: "nav",
      entries: [
        { title: "Chapter", href: "text/book.xhtml#chapter" },
      ],
      images: { "images/a.png": new Uint8Array([1, 2, 3, 4]) },
    });
    const result = importDocument("epub", book, "b.epub", "1");
    expect(typeof result).toBe("object");
    const doc = result as ImportedDocument;
    expect(doc.text).toContain("![[epub:OEBPS/images/a.png]]");
    expect(doc.text).toContain("Text after image");
    expect(doc.images.has("OEBPS/images/a.png")).toBe(true);
    const imgBytes = doc.images.get("OEBPS/images/a.png");
    expect(imgBytes).toBeDefined();
    expect([...(imgBytes ?? [])]).toEqual([1, 2, 3, 4]);
  });

  it("imports a long chapter (over 12000 chars) whole without 'More to read'", () => {
    const paragraphs = Array.from({ length: 30 }, () => "word ".repeat(200));
    const book = epubWithToc({
      title: "Test Book",
      files: {
        "book.xhtml": `<p>${paragraphs.join("</p><p>")}</p>`,
      },
      toc: "nav",
      entries: [
        { title: "Chapter", href: "text/book.xhtml#chapter" },
      ],
    });
    const result = importDocument("epub", book, "b.epub", "1");
    expect(typeof result).toBe("object");
    const doc = result as ImportedDocument;
    expect(doc.text.length).toBeGreaterThan(30000);
    expect(doc.text).not.toContain("More to read");
  });

  it("returns an Error string for unknown pages and legacy binary formats", () => {
    const book = epubWithToc({
      title: "Test Book",
      files: {
        "book.xhtml": `<h2 id="c1">One</h2><p>First paragraph</p><h2 id="c2">Two</h2><p>Second paragraph</p>`,
      },
      toc: "nav",
      entries: [
        { title: "One", href: "text/book.xhtml#c1" },
        { title: "Two", href: "text/book.xhtml#c2" },
      ],
    });
    const result1 = importDocument("epub", book, "b.epub", "9");
    expect(typeof result1).toBe("string");
    expect((result1 as string).startsWith("Error:")).toBe(true);

    const result2 = importDocument("doc", new Uint8Array([1]), "x.doc");
    expect(typeof result2).toBe("string");
    expect((result2 as string).startsWith("Error:")).toBe(true);
  });
});

describe("Journal undo", () => {
  it("undoes a create (remove called when size matches)", async () => {
    const removeCalls: string[] = [];
    const vault = {
      isFile: async () => true,
      read: async () => "",
      write: async () => {},
      remove: async (path: string) => { removeCalls.push(path); },
      move: async () => {},
      files: async () => [],
      folders: async () => [],
      isFolder: async () => false,
      size: async (path: string) => {
        if (path === "img.png") return 4;
        return 0;
      },
    };
    const journal = new Journal();
    journal.begin();
    journal.record({ op: "create", path: "img.png", before: null, after: "", binarySize: 4 });
    const turn = journal.finish();
    if (!turn) throw new Error("no turn");

    const result = await journal.undo(turn, vault);
    expect(result.restored).toContain("img.png");
    expect(removeCalls).toContain("img.png");
    expect(result.refused).toHaveLength(0);
  });

  it("refuses undo when file changed after agent wrote it", async () => {
    const vault = {
      isFile: async () => true,
      read: async () => "",
      write: async () => {},
      remove: async () => {},
      move: async () => {},
      files: async () => [],
      folders: async () => [],
      isFolder: async () => false,
      size: async () => 5,
    };
    const journal = new Journal();
    journal.begin();
    journal.record({ op: "create", path: "img.png", before: null, after: "", binarySize: 4 });
    const turn = journal.finish();
    if (!turn) throw new Error("no turn");

    const result = await journal.undo(turn, vault);
    expect(result.restored).toHaveLength(0);
    expect(result.refused).toHaveLength(1);
    expect(result.refused[0].path).toBe("img.png");
    expect(result.refused[0].reason).toBe("changed after the agent wrote it");
  });
});
