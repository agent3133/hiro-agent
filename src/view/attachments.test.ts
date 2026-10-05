import { describe, expect, it } from "vitest";

import { kindOf, checkAttachment, formatSize, attachmentPrompt } from "./attachments";

describe("kindOf", () => {
  it("classifies photo.JPG as image", () => expect(kindOf("photo.JPG")).toBe("image"));
  it("classifies scan.pdf as pdf", () => expect(kindOf("scan.pdf")).toBe("pdf"));
  it("classifies memo.m4a as audio", () => expect(kindOf("memo.m4a")).toBe("audio"));
  it("classifies clip.webm as video", () => expect(kindOf("clip.webm")).toBe("video"));
  // Office documents and text files are read as text since #210/#211; the old binary formats are not
  it("returns document for notes.docx, budget.xlsx and data.csv", () => {
    expect(kindOf("notes.docx")).toBe("document");
    expect(kindOf("budget.xlsx")).toBe("document");
    expect(kindOf("data.csv")).toBe("document");
  });
  it("returns null for the old binary notes.doc and an archive", () => {
    expect(kindOf("notes.doc")).toBe(null);
    expect(kindOf("files.zip")).toBe(null);
  });
  it("returns null for README", () => expect(kindOf("README")).toBe(null));
});

describe("checkAttachment", () => {
  it("returns kind for video under limit", () =>
    expect(checkAttachment("clip.mp4", 100 * 1024 * 1024)).toEqual({ kind: "video" }));
  it("returns error for video over limit", () =>
    expect(checkAttachment("clip.mp4", 101 * 1024 * 1024)).toEqual({
      error: "clip.mp4 is 101 MB; a video may be at most 100 MB."
    }));
  it("returns error for image over limit", () =>
    expect(checkAttachment("photo.png", 21 * 1024 * 1024)).toEqual({
      error: "photo.png is 21 MB; an image may be at most 20 MB."
    }));
  it("returns error for unsupported kind", () =>
    expect(checkAttachment("notes.doc", 10)).toEqual({
      error: "notes.doc can't be added: the agent reads images, PDFs, recordings, videos, Office documents and text files."
    }));
});

describe("formatSize", () => {
  it("formats 500 as 500 B", () => expect(formatSize(500)).toBe("500 B"));
  it("formats 2048 as 2 KB", () => expect(formatSize(2048)).toBe("2 KB"));
  it("formats 1234567 as 1.2 MB", () => expect(formatSize(1234567)).toBe("1.2 MB"));
  it("formats 3 MB exactly as 3 MB", () => expect(formatSize(3 * 1024 * 1024)).toBe("3 MB"));
});

describe("attachmentPrompt", () => {
  it("adds attachments with prompt", () =>
    expect(attachmentPrompt("Summarise this", ["Attachments/a.pdf"]))
      .toBe("Summarise this\n\nAttached (saved in the vault; read it with read_attachment):\n- ![[Attachments/a.pdf]]"));
  it("adds multiple attachments without prompt", () =>
    expect(attachmentPrompt("", ["x.png", "y.m4a"]))
      .toBe("Attached (saved in the vault; read each one with read_attachment):\n- ![[x.png]]\n- ![[y.m4a]]"));
  it("returns prompt unchanged when no attachments", () =>
    expect(attachmentPrompt("Hello", [])).toBe("Hello"));
});
