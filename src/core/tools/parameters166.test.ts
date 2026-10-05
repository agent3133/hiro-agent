import { describe, expect, it } from "vitest";
import { utimes } from "node:fs/promises";
import { join } from "node:path";

import { makeVault } from "../testing/vault";
import { findSection } from "../sections";
import { pageNumbers } from "../pageNumbers";

describe("read_note with heading", () => {
  it("1a returns exactly the section text for heading 'Tasks'", async () => {
    const vault = await makeVault({
      "note.md": "# Day\n\n## Tasks\n- a\n- b\n\n## Notes\nx",
    });
    const result = await vault.tool("read_note").run({ path: "note.md", heading: "Tasks" });
    expect(result).toBe("## Tasks\n- a\n- b");
  });

  it("1b heading '## tasks' (any case, with hashes) gives the same", async () => {
    const vault = await makeVault({
      "note.md": "# Day\n\n## Tasks\n- a\n- b\n\n## Notes\nx",
    });
    const result = await vault.tool("read_note").run({ path: "note.md", heading: "## tasks" });
    expect(result).toBe("## Tasks\n- a\n- b");
  });
});

describe("read_note with missing heading", () => {
  it("2 answers starting 'Error: no heading' and lists the headings", async () => {
    const vault = await makeVault({
      "note.md": "# Day\n\n## Tasks\n- a\n- b\n\n## Notes\nx",
    });
    const result = await vault.tool("read_note").run({ path: "note.md", heading: "Missing" });
    expect(result.startsWith("Error: no heading 'Missing'")).toBe(true);
    expect(result).toContain("'Day'");
    expect(result).toContain("'Tasks'");
    expect(result).toContain("'Notes'");
  });
});

describe("read_note heading boundary", () => {
  it("3 a '### Sub' heading inside Tasks stays in the section; the next '## Notes' ends it", async () => {
    const vault = await makeVault({
      "note.md": "# Day\n\n## Tasks\n- a\n### Sub\n- b\n## Notes\nx",
    });
    const result = await vault.tool("read_note").run({ path: "note.md", heading: "Tasks" });
    expect(result).toBe("## Tasks\n- a\n### Sub\n- b");
  });
});

describe("findSection inside code fence", () => {
  it("4 a '## Tasks' line inside a code fence is not a heading", async () => {
    const vault = await makeVault({
      "note.md": "# Day\n\n```\n## Tasks\n- a\n```\n",
    });
    const text = await vault.read("note.md");
    const result = findSection(text, "Tasks");
    expect(result).toBeNull();
  });
});

describe("append_to_note with heading", () => {
  it("5a appends '- c' under '## Tasks' in the note of 1", async () => {
    const vault = await makeVault({
      "note.md": "# Day\n\n## Tasks\n- a\n- b\n\n## Notes\nx",
    });
    await vault.tool("append_to_note").run({ path: "note.md", heading: "Tasks", text: "- c" });
    const result = await vault.read("note.md");
    expect(result).toBe("# Day\n\n## Tasks\n- a\n- b\n- c\n\n## Notes\nx");
  });

  it("5b on a note whose last section is Tasks, appends at the end", async () => {
    const vault = await makeVault({
      "note.md": "## Tasks\n- a\n",
    });
    await vault.tool("append_to_note").run({ path: "note.md", heading: "Tasks", text: "- c" });
    const result = await vault.read("note.md");
    expect(result).toBe("## Tasks\n- a\n- c\n");
  });
});

describe("append_to_note with missing heading", () => {
  it("6 a heading the note does not have changes nothing and answers starting 'Error: no heading'", async () => {
    const vault = await makeVault({
      "note.md": "# Day\n\n## Tasks\n- a\n- b\n",
    });
    const before = await vault.read("note.md");
    const result = await vault.tool("append_to_note").run({ path: "note.md", heading: "Missing", text: "- c" });
    expect(result.startsWith("Error: no heading")).toBe(true);
    const after = await vault.read("note.md");
    expect(after).toBe(before);
  });
});

describe("list_notes and find_notes with sort 'modified'", () => {
  it("7a list_notes with sort 'modified' lists newest first", async () => {
    const vault = await makeVault({
      "old.md": "# old",
      "new.md": "# new",
    });
    const oldPath = join(vault.root, "old.md");
    const newPath = join(vault.root, "new.md");
    const oldTime = new Date("2025-01-01");
    const newTime = new Date("2025-02-01");
    await utimes(oldPath, newTime, oldTime);
    await utimes(newPath, newTime, newTime);

    const result = await vault.tool("list_notes").run({ sort: "modified" });
    // Newest first, each with the local day it was changed (midday-safe: both dates are far from midnight shifts)
    const lines = result.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^new\.md \(2025-0[12]-\d\d\)$/);
    expect(lines[1]).toMatch(/^old\.md \((2024-12-31|2025-01-01)\)$/);
  });

  it("7b find_notes with sort 'modified' orders the same way", async () => {
    const vault = await makeVault({
      "old.md": "# old",
      "new.md": "# new",
    });
    const oldPath = join(vault.root, "old.md");
    const newPath = join(vault.root, "new.md");
    const oldTime = new Date("2025-01-01");
    const newTime = new Date("2025-02-01");
    await utimes(oldPath, newTime, oldTime);
    await utimes(newPath, newTime, newTime);

    const result = await vault.tool("find_notes").run({ pattern: "*", sort: "modified" });
    const lines = result.split("\n").filter(Boolean);
    expect(lines[0]).toContain("new.md");
    expect(lines[1]).toContain("old.md");
  });
});

describe("pageNumbers", () => {
  it("8a ('', 3) → [1,2,3]", () => {
    expect(pageNumbers("", 3)).toEqual([1, 2, 3]);
  });

  it("8b ('2', 5) → [2]", () => {
    expect(pageNumbers("2", 5)).toEqual([2]);
  });

  it("8c ('1-3,5', 6) → [1,2,3,5]", () => {
    expect(pageNumbers("1-3,5", 6)).toEqual([1, 2, 3, 5]);
  });

  it("8d ('4', 3) returns a string starting 'Error:'", () => {
    const result = pageNumbers("4", 3);
    expect(typeof result).toBe("string");
    expect((result as string).startsWith("Error:")).toBe(true);
  });

  it("8e ('x', 3) returns a string starting 'Error:'", () => {
    const result = pageNumbers("x", 3);
    expect(typeof result).toBe("string");
    expect((result as string).startsWith("Error:")).toBe(true);
  });
});
