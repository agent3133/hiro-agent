import { describe, expect, it } from "vitest";

import { canvasToMarkdown } from "./canvas";
import { makeVault } from "../testing/vault";

describe("canvasToMarkdown", () => {
  it("cards numbered in reading order top-to-bottom then left-to-right", () => {
    // Reading order: y=0,x=0 is 1; y=0,x=300 is 2; y=200,x=0 is 3
    const canvas = JSON.stringify({
      nodes: [
        { id: "a", type: "text", x: 0, y: 0, width: 100, height: 50, text: "A" },
        { id: "b", type: "text", x: 300, y: 0, width: 100, height: 50, text: "B" },
        { id: "c", type: "text", x: 0, y: 200, width: 100, height: 50, text: "C" },
      ],
      edges: [],
    });
    const result = canvasToMarkdown("test.canvas", canvas);
    const lines = result.split("\n");
    expect(lines).toContain("1. text: A");
    expect(lines).toContain("2. text: B");
    expect(lines).toContain("3. text: C");
  });

  it("file card shows note path, link card shows link url", () => {
    const canvas = JSON.stringify({
      nodes: [
        { id: "f", type: "file", x: 0, y: 0, width: 100, height: 50, file: "Notes/Plan.md" },
        { id: "l", type: "link", x: 0, y: 100, width: 100, height: 50, url: "https://example.com" },
      ],
      edges: [],
    });
    const result = canvasToMarkdown("test.canvas", canvas);
    expect(result).toContain("note Notes/Plan.md");
    expect(result).toContain("link https://example.com");
  });

  it("group with label lists member cards", () => {
    const canvas = JSON.stringify({
      nodes: [
        { id: "a", type: "text", x: 10, y: 10, width: 80, height: 40, text: "A" },
        { id: "b", type: "text", x: 200, y: 10, width: 80, height: 40, text: "B" },
        { id: "g", type: "group", x: 0, y: 0, width: 300, height: 100, label: "Ideas" },
      ],
      edges: [],
    });
    const result = canvasToMarkdown("test.canvas", canvas);
    expect(result).toContain("- Ideas: cards 1, 2");
  });

  it("edge with label appears under Connections", () => {
    const canvas = JSON.stringify({
      nodes: [
        { id: "a", type: "text", x: 0, y: 0, width: 100, height: 50, text: "A" },
        { id: "b", type: "text", x: 300, y: 0, width: 100, height: 50, text: "B" },
        { id: "c", type: "text", x: 0, y: 200, width: 100, height: 50, text: "C" },
      ],
      edges: [
        { fromNode: "a", toNode: "c", label: "leads to" },
      ],
    });
    const result = canvasToMarkdown("test.canvas", canvas);
    expect(result).toContain("- 1 → 3: leads to");
  });

  it("broken JSON returns error", () => {
    const result = canvasToMarkdown("b.canvas", "not json {");
    expect(result.startsWith("Error:")).toBe(true);
    expect(result).toContain("'b.canvas' is not a readable canvas");
  });

  it("empty canvas returns empty message", () => {
    const result = canvasToMarkdown("e.canvas", "{}");
    expect(result).toBe("Canvas 'e.canvas' is empty");
  });
});

describe("read_note canvas rejection", () => {
  it("read_note with .canvas path returns error", async () => {
    const vault = await makeVault({ "Board.canvas": "{}" });
    const result = await vault.tool("read_note").run({ path: "Board.canvas" });
    expect(result).toBe("Error: 'Board.canvas' is a canvas, not a note; read it with read_attachment");
  });
});

describe("canvas JSON that is not a canvas (#385)", () => {
  it("null JSON returns the not-a-canvas error", () => {
    const result = canvasToMarkdown("c.canvas", "null");
    expect(result).toBe("Error: 'c.canvas' is not a readable canvas (its JSON holds no list of cards)");
  });

  it("a canvas JSON with an empty node list and an object of edges returns the not-a-canvas error", () => {
    const result = canvasToMarkdown("c.canvas", JSON.stringify({ nodes: [], edges: {} }));
    expect(result).toBe("Error: 'c.canvas' is not a readable canvas (its JSON holds no list of cards)");
  });

  it("nodes that are not a list return the not-a-canvas error", () => {
    const result = canvasToMarkdown("c.canvas", JSON.stringify({ nodes: { a: 1 } }));
    expect(result).toBe("Error: 'c.canvas' is not a readable canvas (its JSON holds no list of cards)");
  });

  it("a top-level list returns the not-a-canvas error", () => {
    const result = canvasToMarkdown("c.canvas", "[]");
    expect(result).toBe("Error: 'c.canvas' is not a readable canvas (its JSON holds no list of cards)");
  });

  it("a node without coordinates counts as at 0,0", () => {
    const canvas = JSON.stringify({
      nodes: [
        // Listed second, so the order comes from the coordinates and not from the list
        { id: "a", type: "text", text: "A", x: 10, y: 10, width: 5, height: 5 },
        { id: "c", type: "text", text: "C", x: 20, y: 20, width: 5, height: 5 },
        { id: "b", type: "text", text: "B" },
      ],
      edges: [],
    });
    const result = canvasToMarkdown("c.canvas", canvas);
    const lines = result.split("\n");
    expect(lines).toContain("1. text: B");
    expect(lines).toContain("2. text: A");
    expect(lines).toContain("3. text: C");
  });

  it("a null node is skipped and the count reflects the rest", () => {
    const canvas = JSON.stringify({
      nodes: [
        null,
        { id: "a", type: "text", text: "A", x: 0, y: 0, width: 5, height: 5 },
      ],
      edges: [],
    });
    const result = canvasToMarkdown("c.canvas", canvas);
    expect(result.startsWith("Canvas 'c.canvas' — 1 card")).toBe(true);
    expect(result).toContain("1. text: A");
  });

  it("a node list with a null entry and one valid node reports one card", () => {
    const canvas = JSON.stringify({
      nodes: [
        null,
        { id: "a", type: "text", text: "A", x: 0, y: 0, width: 5, height: 5 },
      ],
      edges: [],
    });
    const result = canvasToMarkdown("c.canvas", canvas);
    expect(result.startsWith("Canvas 'c.canvas' — 1 card")).toBe(true);
  });
});
