import { describe, expect, it } from "vitest";

import { makeVault } from "../testing/vault";
import { noteTags } from "./searchTools";
import { parseValue } from "./metadataTools";

describe("reviewGaps167", () => {
  it("noteTags from frontmatter list and inline", async () => {
    const text = `---
tags:
  - Alpha
  - beta/sub
---
Body with #Gamma
`;
    const tags = noteTags(text);
    expect(tags.has("alpha")).toBe(true);
    expect(tags.has("beta/sub")).toBe(true);
    expect(tags.has("gamma")).toBe(true);
  });

  it("noteTags from comma-separated frontmatter", async () => {
    const text = `---
tags: one, two
---
Body
`;
    const tags = noteTags(text);
    expect(tags.has("one")).toBe(true);
    expect(tags.has("two")).toBe(true);
  });

  it("noteTags from bracket frontmatter", async () => {
    const text = `---
tags: [x, "y"]
---
Body
`;
    const tags = noteTags(text);
    expect(tags.has("x")).toBe(true);
    expect(tags.has("y")).toBe(true);
  });

  it("parseValue converts [task, office] to list", async () => {
    const result = parseValue("[task, office]");
    expect(Array.isArray(result)).toBe(true);
    expect(result).toEqual(["task", "office"]);
  });

  it("parseValue converts [] to empty list", async () => {
    const result = parseValue("[]");
    expect(Array.isArray(result)).toBe(true);
    expect(result).toEqual([]);
  });

  it("edit_note replaces text with umlauts", async () => {
    const vault = await makeVault({ "gruss.md": "Hallo\nGrüße an Jürgen\n" });
    const result = await vault.tool("edit_note").run({
      path: "gruss.md",
      old_text: "Grüße an Jürgen",
      new_text: "Viele Grüße",
    });
    expect(result).toContain("Edited");
    const text = await vault.read("gruss.md");
    expect(text).toBe("Hallo\nViele Grüße\n");
  });

  it("read_notes with 21 paths reads 20 and shows ignored message", async () => {
    const notes: Record<string, string> = {};
    const paths: string[] = [];
    for (let i = 0; i < 21; i++) {
      const path = `${String(i).padStart(2, "0")}.md`;
      notes[path] = `# Note ${i}`;
      paths.push(path);
    }
    const vault = await makeVault(notes);
    const result = await vault.tool("read_notes").run({ paths });
    expect(result).toContain("1 more path(s) ignored; read at most 20 notes per call");
    // The first twenty are read, the 21st is not
    expect(result).toContain("# Note 19");
    expect(result).not.toContain("# Note 20");
    expect(result.match(/^## /gm)).toHaveLength(20);
  });
});
