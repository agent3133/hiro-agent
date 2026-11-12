import { describe, expect, it } from "vitest";
import { decodeText, textAttachment } from "./textFile";

describe("textAttachment", () => {
  it('returns "File \'data.csv\' — 2 lines:\\n\\na,b\\n1,2\\n"', () => {
    const result = textAttachment("data.csv", "a,b\n1,2\n");
    expect(result).toBe("File 'data.csv' — 2 lines:\n\na,b\n1,2\n");
  });

  it("removes a leading BOM and converts \\r\\n to \\n", () => {
    const result = textAttachment("x.txt", "\uFEFFhello\r\nworld\r\n");
    expect(result).toBe("File 'x.txt' — 2 lines:\n\nhello\nworld\n");
  });

  it('returns an error string starting with "Error: \'x.json\' is not a text file" for NUL content', () => {
    const result = textAttachment("x.json", "hello\u0000world");
    expect(result.startsWith("Error: 'x.json' is not a text file")).toBe(true);
  });

  it('returns "File \'x.txt\' is empty" for whitespace-only text', () => {
    const result = textAttachment("x.txt", "   \n  \t  ");
    expect(result).toBe("File 'x.txt' is empty");
  });

  it('says "1 line" (singular) for a one-line file', () => {
    const result = textAttachment("x.txt", "hello");
    expect(result).toBe("File 'x.txt' — 1 line:\n\nhello");
  });
});

describe("decodeText (#382)", () => {
  it("decodes a UTF-16LE BOM file and textAttachment shows it", () => {
    const bytes = new Uint8Array([0xff, 0xfe, ...Buffer.from("Hallo\r\nWelt äöü\r\n", "utf16le")]);
    const text = decodeText(bytes);
    expect(text).toBe("Hallo\r\nWelt äöü\r\n");
    expect(textAttachment("u.txt", text!)).toBe("File 'u.txt' — 2 lines:\n\nHallo\nWelt äöü\n");
  });

  it("decodes a UTF-16BE BOM file", () => {
    const bytes = new Uint8Array([0xfe, 0xff, 0x00, 0x48, 0x00, 0x69]);
    expect(decodeText(bytes)).toBe("Hi");
  });

  it("falls back to Windows-1252 for invalid UTF-8 bytes", () => {
    const bytes = Buffer.from("Name;Straße\nMüller;5\n", "latin1");
    const text = decodeText(bytes);
    expect(text).toBe("Name;Straße\nMüller;5\n");
    expect(text).not.toContain("\uFFFD");
  });

  it("drops a UTF-8 BOM so textAttachment sees the real first line", () => {
    const text = decodeText(Buffer.from("﻿a,b\n", "utf8"));
    expect(textAttachment("b.csv", text!)).toBe("File 'b.csv' — 1 line:\n\na,b\n");
  });

  it("keeps valid UTF-8 as UTF-8 and drops the byte-order mark", () => {
    const bytes = Buffer.from("\uFEFFJürgen,München\n", "utf8");
    expect(decodeText(bytes)).toBe("Jürgen,München\n");
  });

  it("returns null for bytes containing a NUL outside a BOM", () => {
    expect(decodeText(Uint8Array.from([0x50, 0x4b, 0x00, 0x03, 0x04]))).toBeNull();
  });
});
