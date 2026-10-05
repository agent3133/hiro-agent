import { describe, expect, it } from "vitest";
import { textAttachment } from "./textFile";

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
