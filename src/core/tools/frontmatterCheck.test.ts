import { describe, expect, it } from "vitest";

import { brokenByWrite, frontmatterProblem } from "../frontmatter";
import { makeVault } from "../testing/vault";

// #252: a write that leaves a note's frontmatter unparseable is refused, so the model fixes it instead of
// leaving a note whose properties Obsidian cannot show (Qwen3.6's "summary: Atlas Standup: …" in J2)
const BROKEN = "---\ndate: 2026-09-16\nsummary: Atlas Standup: API spec almost done\n---\n# Atlas\n";
const QUOTED = "---\ndate: 2026-09-16\nsummary: \"Atlas Standup: API spec almost done\"\n---\n# Atlas\n";

describe("frontmatterProblem", () => {
  it("is null for valid frontmatter, quoted colons, and a note without any", () => {
    expect(frontmatterProblem(QUOTED)).toBeNull();
    expect(frontmatterProblem("# Just a note\n\nkey: value: here\n")).toBeNull();
    expect(frontmatterProblem("---\ntags: [a, b]\n---\n")).toBeNull();
  });

  it("names the line of the note where the frontmatter breaks", () => {
    const problem = frontmatterProblem(BROKEN);
    expect(problem).not.toBeNull();
    expect(problem!.startsWith("line 3 of the note:")).toBe(true);
  });

  it("refuses frontmatter that is not a set of properties", () => {
    expect(frontmatterProblem("---\n- a\n- b\n---\n")).toBe("it is not a list of properties (key: value)");
  });
});

describe("brokenByWrite", () => {
  it("refuses a write that breaks frontmatter that parsed, or that was not there", () => {
    expect(brokenByWrite("", BROKEN)).toMatch(/^Error: the frontmatter would not parse \(line 3/);
    expect(brokenByWrite(QUOTED, BROKEN)).not.toBeNull();
  });

  it("lets a note whose frontmatter was already broken be written, and a valid write through", () => {
    expect(brokenByWrite(BROKEN, BROKEN + "more\n")).toBeNull();
    expect(brokenByWrite(BROKEN, QUOTED)).toBeNull();
    expect(brokenByWrite("", QUOTED)).toBeNull();
  });
});

describe("the write tools", () => {
  it("create_note refuses broken frontmatter and creates nothing", async () => {
    const vault = await makeVault();
    const result = await vault.tool("create_note").run({ path: "Meetings/Atlas.md", content: BROKEN });
    expect(result).toMatch(/^Error: the frontmatter would not parse/);
    expect(result).toContain("nothing was written");
    expect(await vault.exists("Meetings/Atlas.md")).toBe(false);
    expect(await vault.tool("create_note").run({ path: "Meetings/Atlas.md", content: QUOTED }))
      .toBe("Created note at 'Meetings/Atlas.md'");
  });

  it("edit_note refuses an edit that breaks the frontmatter and leaves the note as it was", async () => {
    const vault = await makeVault({ "Atlas.md": QUOTED });
    const result = await vault.tool("edit_note").run({
      path: "Atlas.md", old_text: "summary: \"Atlas Standup: API spec almost done\"",
      new_text: "summary: Atlas Standup: API spec almost done",
    });
    expect(result).toMatch(/^Error: the frontmatter would not parse/);
    expect(await vault.read("Atlas.md")).toBe(QUOTED);
  });

  it("edit_note may still change a note whose frontmatter the user left broken", async () => {
    const vault = await makeVault({ "Atlas.md": BROKEN });
    const result = await vault.tool("edit_note").run({ path: "Atlas.md", old_text: "# Atlas", new_text: "# Atlas standup" });
    expect(result).toBe("Edited 'Atlas.md' (1 replacement)");
  });

  it("update_note and append_to_note refuse it too", async () => {
    const vault = await makeVault({ "Atlas.md": QUOTED, "Empty.md": "" });
    expect(await vault.tool("update_note").run({ path: "Atlas.md", content: BROKEN }))
      .toMatch(/^Error: the frontmatter would not parse/);
    expect(await vault.read("Atlas.md")).toBe(QUOTED);
    expect(await vault.tool("append_to_note").run({ path: "Empty.md", text: BROKEN }))
      .toMatch(/^Error: the frontmatter would not parse/);
    expect(await vault.read("Empty.md")).toBe("");
  });
});
