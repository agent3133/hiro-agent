// Ported from tests/test_tools_builtin.py — get_metadata and update_metadata (#81). Same inputs, same expected results.
import { describe, expect, it } from "vitest";

import { readFrontmatter } from "../frontmatter";
import { makeVault } from "../testing/vault";

describe("test_tools_builtin.py — metadata", () => {
  it("test_get_metadata_parses_frontmatter", async () => {
    const vault = await makeVault({ "meta.md": "---\ntitle: My Note\ntags:\n  - a\n  - b\n---\nBody" });
    const result = JSON.parse(await vault.tool("get_metadata").run({ path: "meta.md" }));
    expect(result.title).toBe("My Note");
    expect(result.tags).toEqual(["a", "b"]);
  });

  it("test_update_metadata_persists", async () => {
    const vault = await makeVault({ "meta.md": "---\ntitle: Old\n---\nBody" });
    await vault.tool("update_metadata").run({ path: "meta.md", key: "status", value: "done" });
    expect(readFrontmatter(await vault.read("meta.md")).data.status).toBe("done");
  });

  it("test_get_metadata_no_frontmatter_returns_empty_json", async () => {
    const vault = await makeVault({ "plain.md": "Just plain body text, no frontmatter." });
    const result = JSON.parse(await vault.tool("get_metadata").run({ path: "plain.md" }));
    expect(result).toEqual({});
  });

  it("test_get_metadata_missing_note_returns_error", async () => {
    const vault = await makeVault({});
    const result = await vault.tool("get_metadata").run({ path: "missing.md" });
    expect(result.toLowerCase()).toContain("error");
  });

  it("test_get_metadata_serialises_dates", async () => {
    const vault = await makeVault({ "task.md": "---\ntitle: Café\ndue: 2026-09-18\ndateCreated: 2026-09-01T09:00:00+02:00\n---\n" });
    const result = JSON.parse(await vault.tool("get_metadata").run({ path: "task.md" }));
    expect(result).toEqual({ title: "Café", due: "2026-09-18", dateCreated: "2026-09-01T09:00:00+02:00" });
  });

  it("test_update_metadata_overwrites_existing_key", async () => {
    const vault = await makeVault({ "meta.md": "---\ntitle: Old\n---\nBody text" });
    await vault.tool("update_metadata").run({ path: "meta.md", key: "title", value: "New" });
    expect(readFrontmatter(await vault.read("meta.md")).data.title).toBe("New");
  });

  it("test_update_metadata_preserves_body", async () => {
    const vault = await makeVault({ "meta.md": "---\ntitle: Test\n---\nKeep this body text intact." });
    await vault.tool("update_metadata").run({ path: "meta.md", key: "status", value: "done" });
    const content = await vault.read("meta.md");
    expect(content).toContain("Keep this body text intact.");
  });

  it("test_update_metadata_no_frontmatter_adds_key", async () => {
    const vault = await makeVault({ "plain.md": "No frontmatter here." });
    await vault.tool("update_metadata").run({ path: "plain.md", key: "author", value: "Alice" });
    expect(readFrontmatter(await vault.read("plain.md")).data.author).toBe("Alice");
  });

  it("test_update_metadata_missing_note_returns_error", async () => {
    const vault = await makeVault({});
    const result = await vault.tool("update_metadata").run({ path: "missing.md", key: "x", value: "y" });
    expect(result.toLowerCase()).toContain("error");
  });

  it("test_update_metadata_says_what_it_stored", async () => {
    const vault = await makeVault({ "meta.md": "---\ntitle: Test\n---\nBody" });
    expect(await vault.tool("update_metadata").run({ path: "meta.md", key: "reviewed", value: "true" })).toContain("reviewed to true (checkbox)");
    expect(await vault.tool("update_metadata").run({ path: "meta.md", key: "tags", value: '["project", "q4"]' })).toContain("(list of 2)");
    expect(await vault.tool("update_metadata").run({ path: "meta.md", key: "owner", value: "[[Maria Keller]]" })).toContain("(text)");
  });

  it.each([
    ['["task", "office"]', ["task", "office"]],
    ['["[[Website Relaunch]]"]', ["[[Website Relaunch]]"]],
    ['{"uid": "[[Choose CMS]]"}', { uid: "[[Choose CMS]]" }],
    ["[[Website Relaunch]]", "[[Website Relaunch]]"],
    ["[draft]", ["draft"]],
    ["[moc, borealis]", ["moc", "borealis"]],
    ["[Tom Becker, Lena Hoffmann]", ["Tom Becker", "Lena Hoffmann"]],
    ["42", 42],
    ["3.5", 3.5],
    ["true", true],
    ["False", false],
    ['"true"', "true"],
    ['[["Website Relaunch"]]', ["[[Website Relaunch]]"]],
    ['[["Tom Becker"], ["Lena Hoffmann"]]', ["[[Tom Becker]]", "[[Lena Hoffmann]]"]],
    ['[["a", "b"], ["c"]]', ["a", "b", "[[c]]"]],
  ])("test_update_metadata_stores_json_arrays_and_objects_as_yaml[%s]", async (value: string, expected: any) => {
    const vault = await makeVault({ "meta.md": "---\ntitle: Test\n---\nBody" });
    await vault.tool("update_metadata").run({ path: "meta.md", key: "field", value });
    expect(readFrontmatter(await vault.read("meta.md")).data.field).toEqual(expected);
  });
});
