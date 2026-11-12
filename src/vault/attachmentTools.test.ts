/**
 * read_attachment on the obsidian stub (#379): finding the file, dispatch by type, the answers' wording.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_AUDIO } from "./media";
import { attachmentTarget, canvasPng, makeAttachmentTools } from "./attachmentTools";
import { obsidianVault } from "./obsidianVault";
import { makeApp, stubPdfJs, type TestApp } from "../testing/obsidian";

const PIXEL_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
const CANVAS = JSON.stringify({
  nodes: [{ id: "a", type: "text", text: "Idea", x: 0, y: 0, width: 10, height: 10 }],
  edges: [],
});

let t: TestApp;

beforeEach(async () => {
  t = await makeApp({
    "Docs/data.csv": "a,b\n1,2\n",
    "Docs/Note.md": "# Note\n",
    "Docs/board.canvas": CANVAS,
    "Docs/archive.zip": "PK nope",
    "Docs/old.doc": "x",
  });
  mkdirSync(join(t.root, "Docs"), { recursive: true });
  writeFileSync(join(t.root, "Docs", "pixel.png"), PIXEL_PNG);
  writeFileSync(join(t.root, "Docs", "r.pdf"), Buffer.from("%PDF-1.4 fake"));
});

afterEach(async () => {
  stubPdfJs(null);
  await t.cleanup();
});

/** The read_attachment tool, as the agent gets it, limited to *scope* when given. */
function toolFor(scope: string[] | null = null) {
  const tools = makeAttachmentTools(t.app as never, scope, { ...DEFAULT_AUDIO, enabled: false }, obsidianVault(t.app as never));
  const tool = tools.find((candidate) => candidate.name === "read_attachment");
  if (!tool) throw new Error("no tool read_attachment");
  return tool;
}

/** A fake PDF.js whose document has one text per page, as the stub's `stubPdfJs` takes it. */
function stubPdf(texts: string[]): void {
  const doc = {
    numPages: texts.length,
    getPage: async (n: number) => ({
      getTextContent: async () => ({ items: [{ str: texts[n - 1] }] }),
    }),
    destroy: async () => {},
  };
  stubPdfJs({ getDocument: () => ({ promise: Promise.resolve(doc) }) });
}

describe("finding the file", () => {
  it("reads a file given by its path, and answers with its lines", async () => {
    // The file's last newline stays: the CLI trims it, the model gets it
    expect(await toolFor().run({ path: "Docs/data.csv" })).toBe("File 'Docs/data.csv' — 2 lines:\n\na,b\n1,2\n");
  });

  it("finds a file given only by its bare name", async () => {
    expect((await toolFor().run({ path: "data.csv" })).startsWith("File 'data.csv' — 2 lines")).toBe(true);
  });

  // An accent rather than letter case: Windows and macOS find "DATA.csv" on disk, as Obsidian would not
  it("reads a file whose name is written another way, and says which file it is", async () => {
    expect((await toolFor().run({ path: "Docs/dàta.csv" }))
      .startsWith("[No file is named 'Docs/dàta.csv'; this is 'Docs/data.csv'.]")).toBe(true);
  });

  it("answers that a missing bare name is not found anywhere in the vault", async () => {
    expect(await toolFor().run({ path: "nothing.png" }))
      .toBe("Error: attachment 'nothing.png' not found anywhere in the vault");
  });

  it("answers that a missing path is not found at that path", async () => {
    expect(await toolFor().run({ path: "Docs/nothing.png" }))
      .toBe("Error: attachment not found at 'Docs/nothing.png'");
  });

  it("refuses a note, and says to read it with read_note", async () => {
    expect(await toolFor().run({ path: "Docs/Note.md" }))
      .toBe("Error: 'Docs/Note.md' is a note, not an attachment; read it with read_note");
  });

  it("refuses a file outside the agent's scope, by its path", async () => {
    expect((await toolFor(["Elsewhere"]).run({ path: "Docs/data.csv" }))
      .startsWith("Error: Path 'Docs/data.csv' is outside this agent's allowed scope")).toBe(true);
  });
});

describe("bare names for an agent limited to some folders (#387)", () => {
  it("finds a bare name inside the agent's folders", async () => {
    expect((await toolFor(["Docs"]).run({ path: "data.csv" })).startsWith("File 'data.csv' — 2 lines")).toBe(true);
  });

  it("does not find a bare name that is only outside them, and says not found rather than out of scope", async () => {
    await t.app.vault.adapter.write("Elsewhere/readme.txt", "x");
    expect(await toolFor(["Elsewhere"]).run({ path: "data.csv" }))
      .toBe("Error: attachment 'data.csv' not found anywhere in the vault");
  });

  it("of two files by one name, reads the one inside the folders", async () => {
    await t.app.vault.adapter.write("Elsewhere/data.csv", "inside\n");
    expect(await toolFor(["Elsewhere"]).run({ path: "data.csv" })).toBe("File 'data.csv' — 1 line:\n\ninside\n");
  });

  it("names no similar file from outside the folders", async () => {
    await t.app.vault.adapter.write("Elsewhere/readme.txt", "x");
    expect(await toolFor(["Elsewhere"]).run({ path: "data.cvs" })).not.toContain("Docs/");
  });

  it("still refuses an escape from the vault and a protected folder by a bare-looking name", async () => {
    expect(await toolFor(["Docs"]).run({ path: ".." })).toMatch(/^Error: Path escape attempt blocked/);
    expect(await toolFor(["Docs"]).run({ path: ".obsidian" })).toMatch(/^Error: '\.obsidian' .* not reachable by tools$/);
  });

  it("refuses a bare-looking name that climbs out of the agent's folders, as an escape from the vault", async () => {
    expect((await toolFor(["Docs"]).run({ path: "../x.png" })).startsWith("Error: Path escape attempt blocked")).toBe(true);
  });
});

describe("dispatch by type", () => {
  it("refuses a type it does not read, naming the extension", async () => {
    expect((await toolFor().run({ path: "Docs/archive.zip" })).startsWith("Error: unsupported attachment type '.zip'"))
      .toBe(true);
  });

  it("refuses an old binary .doc file, and names it as that format", async () => {
    expect((await toolFor().run({ path: "Docs/old.doc" }))
      .startsWith("Error: 'Docs/old.doc' is in the old binary .doc format")).toBe(true);
  });

  it("reads a canvas, naming its card count and listing each card", async () => {
    const answer = await toolFor().run({ path: "Docs/board.canvas" });
    expect(answer.startsWith("Canvas 'Docs/board.canvas' — 1 card")).toBe(true);
    expect(answer).toContain("1. text: Idea");
  });

  it("gives an image as a text label and the image itself", async () => {
    const parts = await toolFor().runContent!({ path: "Docs/pixel.png" });
    expect(Array.isArray(parts)).toBe(true);
    const [label, picture] = parts as { type: string; text?: string; image_url?: { url: string } }[];
    expect(label).toEqual({ type: "text", text: "Image 'Docs/pixel.png':" });
    expect(picture.type).toBe("image_url");
    expect(picture.image_url!.url.startsWith("data:image/png;base64,iVBORw0KGgo")).toBe(true);
  });

  it("shows an image as [image] in the text answer", async () => {
    expect(await toolFor().run({ path: "Docs/pixel.png" })).toBe("Image 'Docs/pixel.png':\n[image]");
  });

  it("refuses an old binary .xls file, and names it as that format", async () => {
    writeFileSync(join(t.root, "Docs", "old.xls"), "x");
    expect((await toolFor().run({ path: "Docs/old.xls" }))
      .startsWith("Error: 'Docs/old.xls' is in the old binary .xls format")).toBe(true);
  });

  it("refuses an old binary .ppt file, and names it as that format", async () => {
    writeFileSync(join(t.root, "Docs", "old.ppt"), "x");
    expect((await toolFor().run({ path: "Docs/old.ppt" }))
      .startsWith("Error: 'Docs/old.ppt' is in the old binary .ppt format")).toBe(true);
  });
});

describe("PDFs", () => {
  it("reads a PDF with text on its pages as text, page by page", async () => {
    stubPdf(["x".repeat(300), "y".repeat(300)]);
    const answer = await toolFor().run({ path: "Docs/r.pdf" });
    expect(answer.startsWith("PDF 'Docs/r.pdf' — 2 page(s), as text:")).toBe(true);
    expect(answer).toContain("Page 2/2:");
  });

  it("answers that a page number outside the PDF is not among its pages", async () => {
    stubPdf(["x".repeat(300), "y".repeat(300)]);
    expect(await toolFor().run({ path: "Docs/r.pdf", pages: "3" }))
      .toBe("Error: the PDF has pages 1-2; '3' is not among them");
  });

  it("says the PDF is probably scanned when asked for text and no page has any", async () => {
    stubPdf([""]);
    const answer = await toolFor().run({ path: "Docs/r.pdf", as_text: true });
    expect(answer.endsWith("[No text layer: the PDF is probably scanned. Read it with as_text false to see the pages.]"))
      .toBe(true);
  });
});

describe("names as notes write them, and answers that say why (#386)", () => {
  it("takes an embed's file name, without its size", () => {
    expect(attachmentTarget("![[photo.jpg|300]]")).toEqual({ path: "photo.jpg", page: "" });
  });

  it("takes a link's path and page, and drops its alias", () => {
    expect(attachmentTarget("[[Docs/r.pdf#page=2|the report]]")).toEqual({ path: "Docs/r.pdf", page: "2" });
  });

  it("takes a bare file name and its page from #page=N", () => {
    expect(attachmentTarget("r.pdf#page=3")).toEqual({ path: "r.pdf", page: "3" });
  });

  it("keeps a # that is part of the file's name", () => {
    expect(attachmentTarget("Issue #12.png")).toEqual({ path: "Issue #12.png", page: "" });
  });

  it("drops a link's heading, and keeps the file", () => {
    expect(attachmentTarget("[[x.png#Heading]]")).toEqual({ path: "x.png", page: "" });
  });

  it("reads an embed of a file by its name, as the note writes it", async () => {
    expect((await toolFor().run({ path: "![[data.csv]]" })).startsWith("File 'data.csv' — 2 lines")).toBe(true);
  });

  it("does not say no file is named when the embed's name is found", async () => {
    expect(await toolFor().run({ path: "![[data.csv]]" })).not.toContain("No file is named");
  });

  it("reads a link with an alias by its file name", async () => {
    expect((await toolFor().run({ path: "[[data.csv|my data]]" })).startsWith("File 'data.csv' — 2 lines")).toBe(true);
  });

  it("reads only the page named by a #page=N link, of a PDF of three pages", async () => {
    stubPdf(["x".repeat(300), "y".repeat(300), "z".repeat(300)]);
    const answer = await toolFor().run({ path: "r.pdf#page=2" });
    expect(answer.startsWith("PDF 'r.pdf' — page(s) 2 of 3, as text:")).toBe(true);
    expect(answer).toContain("Page 2/3:");
    expect(answer).not.toContain("Page 1/3:");
  });

  it("answers that a folder is not a file, and names the list_attachments call for it", async () => {
    expect(await toolFor().run({ path: "Docs" }))
      .toBe("Error: 'Docs' is a folder, not a file; list_attachments with path 'Docs' lists the files in it");
  });

  it("answers that no path was given, for an empty path and a blank one", async () => {
    const message = "Error: no path given: name the attachment by its path or file name (list_attachments lists them)";
    expect(await toolFor().run({ path: "" })).toBe(message);
    expect(await toolFor().run({ path: "  " })).toBe(message);
  });

  it("answers that a password-protected PDF cannot be read, and says what to ask the user", async () => {
    stubPdfJs({
      getDocument: () => ({ promise: Promise.reject(Object.assign(new Error("No password given"), { name: "PasswordException" })) }),
    });
    expect(await toolFor().run({ path: "Docs/r.pdf" }))
      .toBe("Error: 'Docs/r.pdf' is protected by a password, so it cannot be read. Ask the user for a copy without the password.");
  });

  it("says pages applies only to paged files, after the answer for a CSV given pages", async () => {
    expect((await toolFor().run({ path: "Docs/data.csv", pages: "2" })).endsWith(
      "\n\n[pages applies to PDFs, spreadsheets, presentations and EPUB books; this is the whole file.]")).toBe(true);
  });

  it("does not say pages applies to a PDF, which pages do apply to", async () => {
    stubPdf(["x".repeat(300), "y".repeat(300)]);
    expect(await toolFor().run({ path: "Docs/r.pdf", pages: "1" })).not.toContain("pages applies to");
  });

  it("does not say pages applies to an error, when the file is not there", async () => {
    expect(await toolFor().run({ path: "Docs/nothing.csv", pages: "2" })).not.toContain("pages applies to");
  });

  it("reads the page given by pages, not the one named by #page=N, of a PDF of three pages", async () => {
    stubPdf(["x".repeat(300), "y".repeat(300), "z".repeat(300)]);
    const answer = await toolFor().run({ path: "r.pdf#page=2", pages: "1" });
    expect(answer).toContain("Page 1/3:");
    expect(answer).not.toContain("Page 2/3:");
  });
});

/** The import_attachment tool, from the same call as toolFor. */
function importTool() {
  const tools = makeAttachmentTools(t.app as never, null, { ...DEFAULT_AUDIO, enabled: false }, obsidianVault(t.app as never));
  const tool = tools.find((candidate) => candidate.name === "import_attachment");
  if (!tool) throw new Error("no tool import_attachment");
  return tool;
}

describe("text in the encodings Windows saves (#382)", () => {
  it("reads a UTF-16 file with a byte-order mark as its text, lines and umlauts intact", async () => {
    const bytes = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("Hallo\r\nWelt äöü\r\n", "utf16le")]);
    writeFileSync(join(t.root, "Docs", "u16.txt"), bytes);
    expect(await toolFor().run({ path: "Docs/u16.txt" })).toBe("File 'Docs/u16.txt' — 2 lines:\n\nHallo\nWelt äöü\n");
  });

  it("reads a Windows-1252 CSV with its umlauts and ß, and no replacement character", async () => {
    writeFileSync(join(t.root, "Docs", "excel.csv"), Buffer.from("Name;Straße\nMüller;5\n", "latin1"));
    const answer = await toolFor().run({ path: "Docs/excel.csv" });
    expect(answer).toContain("Name;Straße");
    expect(answer).toContain("Müller;5");
    expect(answer).not.toContain("�");
  });

  it("reads a file without an extension when it is text, and counts its one line", async () => {
    writeFileSync(join(t.root, "Docs", "README"), "Read me first\n");
    expect(await toolFor().run({ path: "Docs/README" })).toBe("File 'Docs/README' — 1 line:\n\nRead me first\n");
  });

  it("says a file without an extension is not text, when its bytes are binary", async () => {
    writeFileSync(join(t.root, "Docs", "blob"), Buffer.from([0x00, 0x01, 0x02, 0x03, 0xff]));
    expect(await toolFor().run({ path: "Docs/blob" }))
      .toBe("Error: 'Docs/blob' has no extension and is not text, so read_attachment cannot tell what it is");
  });

  it("says a file with a text extension is not text when its bytes are binary", async () => {
    writeFileSync(join(t.root, "Docs", "bin.txt"), Buffer.from([0x50, 0x4b, 0x00, 0x03, 0x04]));
    expect(await toolFor().run({ path: "Docs/bin.txt" }))
      .toBe("Error: 'Docs/bin.txt' is not a text file, although its name says so");
  });

  it("imports a Windows-1252 CSV into a note with its umlauts and ß, and no replacement character", async () => {
    writeFileSync(join(t.root, "Docs", "excel.csv"), Buffer.from("Name;Straße\nMüller;5\n", "latin1"));
    await importTool().run({ path: "Docs/excel.csv", note: "Notes/Imported" });
    const note = readFileSync(join(t.root, "Notes/Imported.md"), "utf-8");
    expect(note).toContain("Straße");
    expect(note).toContain("Müller");
    expect(note).not.toContain("�");
  });
});

/** The read_attachment tool, with *toPng* as the converter for the formats the model cannot take as they are (#380). */
function imageToolFor(toPng: (bytes: Uint8Array) => Promise<string | null> = canvasPng) {
  const tools = makeAttachmentTools(t.app as never, null, { ...DEFAULT_AUDIO, enabled: false }, obsidianVault(t.app as never), toPng);
  const tool = tools.find((candidate) => candidate.name === "read_attachment");
  if (!tool) throw new Error("no tool read_attachment");
  return tool;
}

type Part = { type: string; text?: string; image_url?: { url: string } };

describe("images the model can load (#380)", () => {
  it("sends a JPEG saved under a .png name as a JPEG, by its bytes", async () => {
    writeFileSync(join(t.root, "Docs", "photo.png"), Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0]));
    const parts = await toolFor().runContent!({ path: "Docs/photo.png" });
    expect(Array.isArray(parts)).toBe(true);
    const picture = (parts as Part[])[1];
    expect(picture.type).toBe("image_url");
    expect(picture.image_url!.url.startsWith("data:image/jpeg;base64,")).toBe(true);
  });

  it("answers that an empty image file has no image to show, and sends no picture", async () => {
    writeFileSync(join(t.root, "Docs", "empty.png"), Buffer.alloc(0));
    expect(await toolFor().runContent!({ path: "Docs/empty.png" }))
      .toBe("Error: 'Docs/empty.png' is empty (0 bytes), so there is no image to show");
  });

  it("answers that a TIFF cannot be shown when no converter can decode it", async () => {
    writeFileSync(join(t.root, "Docs", "scan.tiff"), Buffer.from("II*\u0000\u0008\u0000\u0000\u0000"));
    expect(await toolFor().run({ path: "Docs/scan.tiff" }))
      .toBe("Error: 'Docs/scan.tiff' is a TIFF image, which cannot be shown to the model, so what it shows is unknown: "
        + "do not guess it from the file's name. Ask the user to save it as PNG or JPEG.");
  });

  it("sends a BMP as the PNG the converter makes of the file's bytes", async () => {
    const bmp = Buffer.from("BM\u0000\u0000\u0000\u0000");
    writeFileSync(join(t.root, "Docs", "icon.bmp"), bmp);
    const calls: Uint8Array[] = [];
    const toPng = async (bytes: Uint8Array): Promise<string | null> => {
      calls.push(bytes);
      return "data:image/png;base64,Qk0=";
    };
    const parts = await imageToolFor(toPng).runContent!({ path: "Docs/icon.bmp" });
    expect(Array.isArray(parts)).toBe(true);
    expect((parts as Part[])[1].image_url).toEqual({ url: "data:image/png;base64,Qk0=" });
    expect(calls).toHaveLength(1);
    expect(Buffer.from(calls[0]).equals(bmp)).toBe(true);
  });

  it("sends a PNG as it is, without calling the converter", async () => {
    const calls: Uint8Array[] = [];
    const toPng = async (bytes: Uint8Array): Promise<string | null> => {
      calls.push(bytes);
      return "data:image/png;base64,Qk0=";
    };
    const parts = await imageToolFor(toPng).runContent!({ path: "Docs/pixel.png" });
    expect(Array.isArray(parts)).toBe(true);
    expect((parts as Part[])[1].image_url!.url.startsWith("data:image/png;base64,iVBORw0KGgo")).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("answers an SVG as its XML, saying the drawing is not rendered", async () => {
    writeFileSync(join(t.root, "Docs", "logo.svg"), '<svg xmlns="http://www.w3.org/2000/svg"><text>Logo</text></svg>');
    const answer = await toolFor().run({ path: "Docs/logo.svg" });
    expect(answer.startsWith("SVG image 'Docs/logo.svg', as its XML (the drawing is not rendered):\n\n<svg")).toBe(true);
    expect(answer).toContain("<text>Logo</text>");
  });

  it("answers that a .jpg file holding text is not an image, though its name says so", async () => {
    writeFileSync(join(t.root, "Docs", "fake.jpg"), "hello, I am text");
    expect(await toolFor().run({ path: "Docs/fake.jpg" }))
      .toBe("Error: 'Docs/fake.jpg' is not an image, although its name says so: its bytes are no image format");
  });

  it("answers that a BMP cannot be shown when the converter gives no picture, and says what to ask the user", async () => {
    writeFileSync(join(t.root, "Docs", "icon.bmp"), Buffer.from("BM\u0000\u0000\u0000\u0000"));
    const toPng = async (): Promise<string | null> => null;
    expect(await imageToolFor(toPng).run({ path: "Docs/icon.bmp" }))
      .toBe("Error: 'Docs/icon.bmp' is a BMP image, which cannot be shown to the model, so what it shows is unknown: "
        + "do not guess it from the file's name. Ask the user to save it as PNG or JPEG.");
  });

  it("sends an AVIF as the PNG the converter makes of the file's bytes, once", async () => {
    const avif = Buffer.from("\u0000\u0000\u0000\u001cftypavif\u0000\u0000\u0000\u0000", "latin1");
    writeFileSync(join(t.root, "Docs", "pic.avif"), avif);
    const calls: Uint8Array[] = [];
    const toPng = async (bytes: Uint8Array): Promise<string | null> => {
      calls.push(bytes);
      return "data:image/png;base64,QUFB";
    };
    const parts = await imageToolFor(toPng).runContent!({ path: "Docs/pic.avif" });
    expect(Array.isArray(parts)).toBe(true);
    expect((parts as Part[])[1].type).toBe("image_url");
    expect((parts as Part[])[1].image_url).toEqual({ url: "data:image/png;base64,QUFB" });
    expect(calls).toHaveLength(1);
    expect(Buffer.from(calls[0]).equals(avif)).toBe(true);
  });

  it("sends an ICO as the PNG the converter makes of the file's bytes, once", async () => {
    const ico = Buffer.from([0, 0, 1, 0, 1, 0, 16, 16]);
    writeFileSync(join(t.root, "Docs", "fav.ico"), ico);
    const calls: Uint8Array[] = [];
    const toPng = async (bytes: Uint8Array): Promise<string | null> => {
      calls.push(bytes);
      return "data:image/png;base64,QUFB";
    };
    const parts = await imageToolFor(toPng).runContent!({ path: "Docs/fav.ico" });
    expect(Array.isArray(parts)).toBe(true);
    expect((parts as Part[])[1].type).toBe("image_url");
    expect((parts as Part[])[1].image_url).toEqual({ url: "data:image/png;base64,QUFB" });
    expect(calls).toHaveLength(1);
    expect(Buffer.from(calls[0]).equals(ico)).toBe(true);
  });
});
