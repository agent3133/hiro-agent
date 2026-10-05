// Tests for edit_note with \r\n line endings, trailing spaces, closest line, LF preservation
// and update_metadata with "null" value.
import { describe, expect, it } from "vitest";

import { readFrontmatter } from "../frontmatter";
import { makeVault } from "../testing/vault";

describe("edit_note with \\r\\n line endings (#161)", () => {
  it("keeps \\r\\n endings when old_text is LF and replaced", async () => {
    const vault = await makeVault({ "crlf.md": "x\r\na\r\nb\r\ny" });
    const result = await vault.tool("edit_note").run({
      path: "crlf.md",
      old_text: "a\nb",
      new_text: "NEW",
    });
    expect(result).toContain("Edited");
    expect(await vault.read("crlf.md")).toBe("x\r\nNEW\r\ny");
  });
});

describe("edit_note ignoring trailing spaces (#161)", () => {
  it("replaces text with trailing spaces when old_text omits them", async () => {
    const vault = await makeVault({
      "tasks.md": "- task one   \n- task two",
    });
    const result = await vault.tool("edit_note").run({
      path: "tasks.md",
      old_text: "- task one\n- task two",
      new_text: "- done one\n- done two",
    });
    expect(result).toContain("ignoring spaces at line ends");
    expect(await vault.read("tasks.md")).toBe("- done one\n- done two");
  });
});

describe("edit_note with two loose matches (#161)", () => {
  it("replaces neither and says the text was not found", async () => {
    const text = "- one  \n- two\n\n- one \n- two";
    const vault = await makeVault({ "twice.md": text });
    const result = await vault.tool("edit_note").run({ path: "twice.md", old_text: "- one\n- two", new_text: "x" });
    expect(result.startsWith("Error: old_text not found")).toBe(true);
    expect(await vault.read("twice.md")).toBe(text);
  });
});

describe("edit_note closest line error (#161)", () => {
  it("shows the closest line when old_text matches nothing", async () => {
    const vault = await makeVault({ "shop.md": "- buy milk" });
    const result = await vault.tool("edit_note").run({
      path: "shop.md",
      old_text: "- buy milks",
      new_text: "- buy eggs",
    });
    expect(result.startsWith("Error: old_text not found")).toBe(true);
    expect(result).toContain("The closest line in the note is: '- buy milk'");
  });
});

describe("edit_note preserves LF line endings (#161)", () => {
  it("writes LF when the note uses LF", async () => {
    const vault = await makeVault({ "lf.md": "a\nb\nc" });
    const result = await vault.tool("edit_note").run({
      path: "lf.md",
      old_text: "b",
      new_text: "B",
    });
    expect(result).toContain("Edited");
    const text = await vault.read("lf.md");
    expect(text).not.toContain("\r");
    expect(text).toBe("a\nB\nc");
  });
});

describe("update_metadata with null value (#161)", () => {
  it("removes an existing key when value is null", async () => {
    const vault = await makeVault({
      "meta.md": "---\ntitle: Test\nstatus: active\ntags:\n  - a\n---\nBody",
    });
    const result = await vault.tool("update_metadata").run({
      path: "meta.md",
      key: "status",
      value: "null",
    });
    expect(result).toBe("Removed status from 'meta.md'");
    const fm = readFrontmatter(await vault.read("meta.md"));
    expect(fm.data.status).toBeUndefined();
    expect(fm.data.title).toBe("Test");
    expect(fm.data.tags).toEqual(["a"]);
  });

  it('stores the text "null" when value is "null" (quoted)', async () => {
    const vault = await makeVault({
      "meta.md": "---\ntitle: Test\n---\nBody",
    });
    const result = await vault.tool("update_metadata").run({
      path: "meta.md",
      key: "status",
      value: '"null"',
    });
    expect(result).toContain("null");
    const fm = readFrontmatter(await vault.read("meta.md"));
    expect(fm.data.status).toBe("null");
  });

  it("keeps \\r\\n line endings in the frontmatter when setting and removing", async () => {
    const vault = await makeVault({ "crlf.md": "---\r\ntitle: Test\r\nstatus: draft\r\n---\r\nBody\r\n" });
    await vault.tool("update_metadata").run({ path: "crlf.md", key: "status", value: "null" });
    await vault.tool("update_metadata").run({ path: "crlf.md", key: "priority", value: "2" });
    expect(await vault.read("crlf.md")).toBe("---\r\ntitle: Test\r\npriority: 2\r\n---\r\nBody\r\n");
  });

  it("says nothing to remove when key is not set", async () => {
    const vault = await makeVault({
      "meta.md": "---\ntitle: Test\n---\nBody",
    });
    const result = await vault.tool("update_metadata").run({
      path: "meta.md",
      key: "ghost",
      value: "null",
    });
    expect(result).toContain("nothing to remove");
    expect(await vault.read("meta.md")).toBe("---\ntitle: Test\n---\nBody");
  });
});
