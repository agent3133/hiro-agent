/**
 * The index tools (links, tags, tasks, headings, deleting) on Obsidian's metadata cache, which the stand-in works out
 * from the files on disk (#369). Expected strings are the ones plugin/tests/obsidian-tools.smoke.ts checks in Obsidian.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { makeIndexTools } from "./indexTools";
import { obsidianVault } from "./obsidianVault";
import { makeApp, type TestApp } from "../testing/obsidian";

const ALPHA = "# Alpha\n\n## Section\n\n- [ ] open task\n- [x] done task\n\nLinks to [[Beta]] and [[Missing Note]]. #smoketag\n";
const BETA = "---\ntags: [smoketag, other]\nstatus: draft\n---\nBack to [[Alpha|the alpha]].\n";
const GAMMA = "#project\n";

let t: TestApp;

beforeEach(async () => {
  t = await makeApp({ "Smoke/Alpha.md": ALPHA, "Smoke/Beta.md": BETA, "Elsewhere/Gamma.md": GAMMA });
});

afterEach(async () => {
  await t.cleanup();
});

/** The index tools for the vault, as the agent gets them, limited to *scope* when given. */
function toolsFor(scope: string[] | null = null) {
  return makeIndexTools(t.app as never, obsidianVault(t.app as never), scope);
}

/** Run the tool called *name* with *args*, as the agent calls it. */
async function run(name: string, args: Record<string, unknown> = {}, scope: string[] | null = null): Promise<string> {
  const tool = toolsFor(scope).find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`no tool ${name}`);
  return tool.run(args);
}

describe("get_backlinks", () => {
  it("names the note that links to the given note, by its path", async () => {
    expect(await run("get_backlinks", { path: "Smoke/Beta.md" })).toBe("Smoke/Alpha.md");
  });

  it("counts a link written through an alias, when the note is given by its bare name", async () => {
    expect(await run("get_backlinks", { path: "Alpha" })).toBe("Smoke/Beta.md");
  });
});

describe("get_outlinks", () => {
  it("lists the resolved paths of a note's links, marking a missing note as unresolved", async () => {
    expect(await run("get_outlinks", { path: "Smoke/Alpha.md" })).toBe("Smoke/Beta.md\nMissing Note (unresolved)");
  });
});

describe("find_broken_links", () => {
  it("lists a link to a note that does not exist, with the note that holds it", async () => {
    const broken = await run("find_broken_links");
    expect(broken.split("\n")).toContain("Smoke/Alpha.md -> Missing Note");
  });

  it("leaves out the broken links of notes outside the agent's folders", async () => {
    const broken = await run("find_broken_links", {}, ["Elsewhere"]);
    expect(broken).not.toContain("Smoke/Alpha.md");
  });
});

describe("list_tags", () => {
  it("counts each tag once per note, frontmatter and inline tags alike", async () => {
    const tags = await run("list_tags");
    expect(tags.split("\n")).toContain("#smoketag (2)");
  });

  it("counts only the tags of the notes in the agent's folders", async () => {
    const tags = await run("list_tags", {}, ["Smoke"]);
    expect(tags).not.toContain("#project");
  });
});

describe("list_tasks", () => {
  it("lists the open tasks under a folder, with the line each is on", async () => {
    expect(await run("list_tasks", { path: "Smoke" })).toBe("Smoke/Alpha.md:5: - [ ] open task");
  });

  it("lists the done tasks when the status is done", async () => {
    expect(await run("list_tasks", { path: "Smoke", status: "done" })).toBe("Smoke/Alpha.md:6: - [x] done task");
  });

  it("answers with an error when the status is not todo, done or all", async () => {
    expect(await run("list_tasks", { status: "later" })).toBe("Error: status must be todo, done or all");
  });
});

describe("note_outline", () => {
  it("shows the headings as an indented tree, a level deeper per indent", async () => {
    expect(await run("note_outline", { path: "Smoke/Alpha.md" })).toBe("Alpha\n  Section");
  });

  it("says so when the note has no headings", async () => {
    expect(await run("note_outline", { path: "Smoke/Beta.md" })).toBe("No headings in this note");
  });
});

describe("delete_note", () => {
  it("refuses a note that does not exist, naming it as not found", async () => {
    const answer = await run("delete_note", { path: "Smoke/Nowhere.md" });
    expect(answer.startsWith("Error: note not found")).toBe(true);
  });

  it("removes an existing note from its folder, and answers saying it was moved away", async () => {
    const answer = await run("delete_note", { path: "Smoke/Beta.md" });
    expect(answer.startsWith("Moved note 'Smoke/Beta.md' to")).toBe(true);
    expect(await obsidianVault(t.app as never).isFile("Smoke/Beta.md")).toBe(false);
  });

  it("answers an error that names the missing note, when it does not exist", async () => {
    const answer = await run("delete_note", { path: "Smoke/Nowhere.md" });
    expect(answer).toContain("'Smoke/Nowhere.md'");
    expect(answer.startsWith("Error:")).toBe(true);
  });
});

describe("move_note (#420)", () => {
  it("moves a note into another folder, and answers with its new path", async () => {
    const answer = await run("move_note", { from_path: "Smoke/Beta.md", to_path: "Elsewhere/Beta.md" });
    expect(answer).toBe("Moved note from 'Smoke/Beta.md' to 'Elsewhere/Beta.md'");
    const vault = obsidianVault(t.app as never);
    expect(await vault.isFile("Elsewhere/Beta.md")).toBe(true);
    expect(await vault.isFile("Smoke/Beta.md")).toBe(false);
  });

  it("refuses a move onto a path that holds a note already, and changes neither note", async () => {
    const answer = await run("move_note", { from_path: "Smoke/Beta.md", to_path: "Smoke/Alpha.md", update_links: false });
    expect(answer).toBe("Error: a note already exists at 'Smoke/Alpha.md'");
    const vault = obsidianVault(t.app as never);
    expect(await vault.read("Smoke/Beta.md")).toBe(BETA);
    expect(await vault.read("Smoke/Alpha.md")).toBe(ALPHA);
  });
});

describe("a folder-restricted toolset (#420)", () => {
  const scoped = ["Smoke"];

  it("refuses to delete a note outside the allowed folder, and leaves it where it is", async () => {
    const answer = await run("delete_note", { path: "Elsewhere/Gamma.md" }, scoped);
    expect(answer.startsWith("Error:")).toBe(true);
    expect(answer).toContain("outside this agent's allowed scope");
    expect(await obsidianVault(t.app as never).isFile("Elsewhere/Gamma.md")).toBe(true);
  });

  it("refuses to move a note that lies outside the allowed folder, and leaves it where it is", async () => {
    const answer = await run("move_note", { from_path: "Elsewhere/Gamma.md", to_path: "Smoke/Gamma.md" }, scoped);
    expect(answer.startsWith("Error:")).toBe(true);
    const vault = obsidianVault(t.app as never);
    expect(await vault.isFile("Elsewhere/Gamma.md")).toBe(true);
    expect(await vault.isFile("Smoke/Gamma.md")).toBe(false);
  });

  it("refuses to move a note from inside the allowed folder to one outside it, and leaves it where it is", async () => {
    const answer = await run("move_note", { from_path: "Smoke/Beta.md", to_path: "Elsewhere/Beta.md" }, scoped);
    expect(answer.startsWith("Error:")).toBe(true);
    expect(answer).toContain("outside this agent's allowed scope");
    const vault = obsidianVault(t.app as never);
    expect(await vault.isFile("Smoke/Beta.md")).toBe(true);
    expect(await vault.isFile("Elsewhere/Beta.md")).toBe(false);
  });
});
