import { describe, expect, it } from "vitest";

import { writtenAs } from "./metadataTools";
import { makeVault } from "../testing/vault";

// ── writtenAs ──────────────────────────────────────────────────────────────

describe("writtenAs", () => {
  it('single [[link]] returns "a [[link]]"', () => {
    expect(writtenAs("[[Office Move]]")).toBe("a [[link]]");
  });

  it('array of [[links]] returns "a list of [[links]]"', () => {
    expect(writtenAs(["[[A]]", "[[B]]"])).toBe("a list of [[links]]");
  });

  it('array with mixed items returns "a list"', () => {
    expect(writtenAs(["a", "[[B]]"])).toBe("a list");
  });

  it('ISO date returns "a date like 2026-09-14"', () => {
    expect(writtenAs("2026-09-14")).toBe("a date like 2026-09-14");
  });

  it('DD.MM.YYYY date returns "a date like 14.09.2026"', () => {
    expect(writtenAs("14.09.2026")).toBe("a date like 14.09.2026");
  });

  it('number returns "a number"', () => {
    expect(writtenAs(3)).toBe("a number");
  });

  it('boolean returns "a checkbox"', () => {
    expect(writtenAs(true)).toBe("a checkbox");
  });

  it('empty string returns ""', () => {
    expect(writtenAs("")).toBe("");
  });

  it('empty array returns ""', () => {
    expect(writtenAs([])).toBe("");
  });

  it('null returns ""', () => {
    expect(writtenAs(null)).toBe("");
  });
});

// ── formHint via update_metadata ───────────────────────────────────────────

describe("formHint via update_metadata", () => {
  // Behaviour 2: hint when siblings share a different form
  it("hints when siblings write the property as a list of [[links]]", async () => {
    const vault = await makeVault({
      "TaskNotes/Tasks/A.md": "---\nprojects:\n  - '[[Website Relaunch]]'\n---\n",
      "TaskNotes/Tasks/B.md": "---\nprojects:\n  - '[[Website Relaunch]]'\n---\n",
      "TaskNotes/Tasks/C.md": "---\nstatus: open\n---\n",
    });

    const result = await vault.tool("update_metadata").run({
      path: "TaskNotes/Tasks/C.md",
      key: "projects",
      value: '["TaskNotes/Projects/Office Move"]',
    });

    // The "Set ..." line
    expect(result).toContain("Set projects to ");
    expect(result).toContain("in 'TaskNotes/Tasks/C.md'");

    // The hint line about other notes
    expect(result).toContain("[Other notes in 'TaskNotes/Tasks' write projects as a list of [[links]], e.");
    expect(result).toContain("If this one should match, set it again.]");
  });

  // Behaviour 3: no hint when the new value matches what siblings write
  it("no hint when the new value matches siblings' form", async () => {
    const vault = await makeVault({
      "TaskNotes/Tasks/A.md": "---\nprojects:\n  - '[[Office Move]]'\n---\n",
      "TaskNotes/Tasks/B.md": "---\nprojects:\n  - '[[Office Move]]'\n---\n",
      "TaskNotes/Tasks/C.md": "---\nstatus: open\n---\n",
    });

    const result = await vault.tool("update_metadata").run({
      path: "TaskNotes/Tasks/C.md",
      key: "projects",
      value: '["[[Office Move]]"]',
    });

    // Should be exactly the "Set ..." line, no hint
    expect(result).toContain("Set projects to ");
    expect(result).toContain("in 'TaskNotes/Tasks/C.md'");
    // No hint line
    expect(result).not.toContain("[Other notes");
    expect(result).not.toContain("If this one should match");
  });

  // Behaviour 4a: no hint when only one other note has the property
  it("no hint when only one other note in the folder has the property", async () => {
    const vault = await makeVault({
      "TaskNotes/Tasks/A.md": "---\nprojects:\n  - '[[Website Relaunch]]'\n---\n",
      "TaskNotes/Tasks/B.md": "---\nstatus: open\n---\n",
      "TaskNotes/Tasks/C.md": "---\nstatus: open\n---\n",
    });

    const result = await vault.tool("update_metadata").run({
      path: "TaskNotes/Tasks/C.md",
      key: "projects",
      value: '["TaskNotes/Projects/Office Move"]',
    });

    // Only one sibling has projects, so no hint
    expect(result).toContain("Set projects to ");
    expect(result).not.toContain("[Other notes");
    expect(result).not.toContain("If this one should match");
  });

  // Behaviour 4b: no hint when notes in another folder write it differently
  it("no hint when notes in another folder write it differently", async () => {
    const vault = await makeVault({
      "TaskNotes/Projects/A.md": "---\nprojects:\n  - '[[Website Relaunch]]'\n---\n",
      "TaskNotes/Tasks/B.md": "---\nstatus: open\n---\n",
      "TaskNotes/Tasks/C.md": "---\nstatus: open\n---\n",
    });

    const result = await vault.tool("update_metadata").run({
      path: "TaskNotes/Tasks/C.md",
      key: "projects",
      value: '["TaskNotes/Projects/Office Move"]',
    });

    // Notes in a different folder shouldn't count
    expect(result).toContain("Set projects to ");
    expect(result).not.toContain("[Other notes");
    expect(result).not.toContain("If this one should match");
  });

  // Behaviour 5: no hint when fewer than 2/3 share one form
  it("no hint when notes disagree among themselves", async () => {
    const vault = await makeVault({
      "TaskNotes/Tasks/A.md": "---\nprojects:\n  - '[[Website Relaunch]]'\n---\n",
      "TaskNotes/Tasks/B.md": "---\nprojects:\n  - '[[Office Move]]'\n---\n",
      "TaskNotes/Tasks/C.md": "---\nprojects: hello\n---\n",
      "TaskNotes/Tasks/D.md": "---\nprojects: world\n---\n",
      "TaskNotes/Tasks/E.md": "---\nstatus: open\n---\n",
    });

    const result = await vault.tool("update_metadata").run({
      path: "TaskNotes/Tasks/E.md",
      key: "projects",
      value: "5",
    });

    // Two write list of links (A, B), two write text (C, D) — no clear majority
    expect(result).toContain("Set projects to ");
    expect(result).not.toContain("[Other notes");
    expect(result).not.toContain("If this one should match");
  });
});
