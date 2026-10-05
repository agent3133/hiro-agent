// fitContent and read_notes with budgets (#160): fitContent trims images to fit a token limit;
// read_notes uses runWithin to share room among notes.
import { describe, expect, it } from "vitest";

import { makeVault } from "./testing/vault";
import { fitContent } from "./agentLoop";

describe("fitContent", () => {
  it("returns parts unchanged when limit is Infinity", async () => {
    const parts: Parameters<typeof fitContent>[0] = [
      { type: "text", text: "hello" },
      { type: "image_url", image_url: { url: "data:x" } },
    ];
    const result = fitContent(parts, Infinity);
    expect(result).toBe(parts);
  });

  it("keeps 3 labelled pages when limit is 9000 (room for 3 images)", async () => {
    const parts: Parameters<typeof fitContent>[0] = [
      { type: "text", text: "PDF 'a.pdf' — 5 page(s):" },
      { type: "text", text: "Page 1/5:" },
      { type: "image_url", image_url: { url: "data:x" } },
      { type: "text", text: "Page 2/5:" },
      { type: "image_url", image_url: { url: "data:x" } },
      { type: "text", text: "Page 3/5:" },
      { type: "image_url", image_url: { url: "data:x" } },
    ];
    const result = fitContent(parts, 9000);
    // room = floor(9000 / 3 / 1000) = 3, all 3 images fit
    expect(result).toEqual(parts);
  });

  it("drops labels and images beyond room, adds summary text", async () => {
    const parts: Parameters<typeof fitContent>[0] = [
      { type: "text", text: "PDF 'a.pdf' — 5 page(s):" },
      { type: "text", text: "Page 1/5:" },
      { type: "image_url", image_url: { url: "data:x" } },
      { type: "text", text: "Page 2/5:" },
      { type: "image_url", image_url: { url: "data:x" } },
      { type: "text", text: "Page 3/5:" },
      { type: "image_url", image_url: { url: "data:x" } },
      { type: "text", text: "Page 4/5:" },
      { type: "image_url", image_url: { url: "data:x" } },
      { type: "text", text: "Page 5/5:" },
      { type: "image_url", image_url: { url: "data:x" } },
    ];
    const result = fitContent(parts, 6000);
    // room = floor(6000 / 3 / 1000) = 2
    // Keeps heading, Page 1/5: and its image, Page 2/5: and its image
    // Drops Page 3/5: through Page 5/5: and their images
    // Adds summary
    const textParts = result.filter((p) => p.type === "text");
    const imageParts = result.filter((p) => p.type === "image_url");
    expect(imageParts.length).toBe(2);
    const textResult = textParts.map((p) => p.text).join("\n");
    expect(textResult).toContain("PDF 'a.pdf' — 5 page(s):");
    expect(textResult).toContain("Page 1/5:");
    expect(textResult).toContain("Page 2/5:");
    expect(textResult).not.toContain("Page 3/5:");
    const lastPart = result[result.length - 1];
    expect(lastPart.type).toBe("text");
    const lastText = (lastPart as { type: "text"; text: string }).text;
    // The pages left out are named, with the next call (#251)
    expect(lastText).toBe("[Pages 3-5 left out to stay inside the context window. Read them with pages '3-4' and "
      + "onwards, a few at a time, or read the PDF with as_text, which is far smaller.]");
  });

  it("says only how many when the images are not pages (video frames)", () => {
    const parts: Parameters<typeof fitContent>[0] = [
      { type: "text", text: "Frame 1/3:" }, { type: "image_url", image_url: { url: "data:x" } },
      { type: "text", text: "Frame 2/3:" }, { type: "image_url", image_url: { url: "data:x" } },
      { type: "text", text: "Frame 3/3:" }, { type: "image_url", image_url: { url: "data:x" } },
    ];
    const last = fitContent(parts, 3000).at(-1) as { type: "text"; text: string };
    expect(last.text.startsWith("[2 more image(s) left out")).toBe(true);
  });

  it("keeps at least one image even when room is 0", async () => {
    const parts: Parameters<typeof fitContent>[0] = [
      { type: "text", text: "Page 1/1:" },
      { type: "image_url", image_url: { url: "data:x" } },
    ];
    const result = fitContent(parts, 100);
    // room = max(1, floor(100 / 3 / 1000)) = max(1, 0) = 1
    const imageParts = result.filter((p) => p.type === "image_url");
    expect(imageParts.length).toBe(1);
  });
});

describe("read_notes", () => {
  it("runWithin with room 2000 keeps heading and short b, cuts a.md", async () => {
    const vault = await makeVault({
      "a.md": "x".repeat(5000),
      "b.md": "short b",
    });
    const tool = vault.tool("read_notes");
    const result = await tool.runWithin!({ paths: ["a.md", "b.md"] }, 2000);
    expect(result).toContain("## a.md");
    expect(result).toContain("## b.md");
    expect(result).toContain("short b");
    expect(result).toContain("read_note('a.md') gives all of it");
  });

  it("run returns both notes whole when no room limit", async () => {
    const vault = await makeVault({
      "a.md": "x".repeat(5000),
      "b.md": "short b",
    });
    const tool = vault.tool("read_notes");
    const result = await tool.run({ paths: ["a.md", "b.md"] });
    expect(result).toContain("x".repeat(5000));
    expect(result).toContain("short b");
  });
});
