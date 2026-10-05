import { describe, expect, it } from "vitest";

import { makeVault } from "../testing/vault";

const NOTES = {
  "TaskNotes/Tasks/Draft sitemap.md": "---\nstatus: open\n---\nbody",
  "TaskNotes/Projects/Atlas.md": "a",
  "Inbox/Idea.md": "i",
  "Top.md": "t",
};

describe("note and folder resolution", () => {
  it("append_to_note with wrong folder finds the note", async () => {
    const vault = await makeVault(NOTES);
    const result = await vault.tool("append_to_note").run({ path: "Tasks/Draft sitemap.md", text: "more" });
    expect(result).toBe("Appended to note at 'TaskNotes/Tasks/Draft sitemap.md'");
    const text = await vault.read("TaskNotes/Tasks/Draft sitemap.md");
    expect(text).toContain("more");
  });

  it("update_metadata with bare name finds the note", async () => {
    const vault = await makeVault(NOTES);
    const result = await vault.tool("update_metadata").run({ path: "Draft sitemap", key: "status", value: "done" });
    expect(result).toContain("TaskNotes/Tasks/Draft sitemap.md");
    const text = await vault.read("TaskNotes/Tasks/Draft sitemap.md");
    expect(text).toContain("status: done");
  });

  it("list_notes with partial path, quoted path, and empty path", async () => {
    const vault = await makeVault(NOTES);
    const listTool = vault.tool("list_notes");

    const r1 = await listTool.run({ path: "Projects" });
    expect(r1).toContain("TaskNotes/Projects/Atlas.md");

    const r2 = await listTool.run({ path: '"Inbox"' });
    expect(r2).toContain("Inbox/Idea.md");

    const r3 = await listTool.run({ path: '""' });
    expect(r3).toBe("Inbox/\nTaskNotes/\nTop.md");
  });

  it("list_notes with no arguments and recursive", async () => {
    const vault = await makeVault(NOTES);
    const listTool = vault.tool("list_notes");

    const r1 = await listTool.run({});
    expect(r1).toBe("Inbox/\nTaskNotes/\nTop.md");

    const r2 = await listTool.run({ recursive: true });
    expect(r2.split("\n").sort()).toEqual(["Inbox/Idea.md", "TaskNotes/Projects/Atlas.md", "TaskNotes/Tasks/Draft sitemap.md", "Top.md"]);
  });

  it("find_notes with wildcard pattern", async () => {
    const vault = await makeVault(NOTES);
    const result = await vault.tool("find_notes").run({ pattern: "Projects/*" });
    expect(result).toBe("TaskNotes/Projects/Atlas.md");
  });
});
