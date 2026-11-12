// The tools that follow Obsidian's core plugins (#82), on the obsidian stub's App (#369): daily_note, list_templates
// and create_from_template. The expected answers are the ones plugin/tests/obsidian-tools.smoke.ts checks in Obsidian.
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { makeApp, moment, type TestApp } from "../testing/obsidian";

import { obsidianVault } from "./obsidianVault";
import { makePluginTools } from "./pluginTools";

let test: TestApp | null = null;

afterEach(async () => {
  await test?.cleanup();
  test = null;
});

/** An App with the Templates core plugin on, its folder set to Templates, and *files* alongside. */
async function withTemplates(files: Record<string, string> = {}): Promise<TestApp> {
  test = await makeApp({
    ".obsidian/core-plugins.json": JSON.stringify({ templates: true }),
    ".obsidian/templates.json": JSON.stringify({ folder: "Templates" }),
    "Templates/T.md": "# {{title}}\n{{date}}",
    ...files,
  });
  return test;
}

function toolNamed(app: TestApp, name: string) {
  const scope: string[] | null = null;
  const tools = makePluginTools(app.app as never, obsidianVault(app.app as never), scope);
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`no tool ${name}`);
  return tool;
}

describe("makePluginTools: templates", () => {
  it("list_templates names the templates in the Templates folder, and not the notes beside it", async () => {
    const t = await withTemplates({ "Notes/N.md": "a note" });

    const answer = await toolNamed(t, "list_templates").run({});

    expect(answer.split("\n")).toEqual(["T"]);
  });

  it("create_from_template answers the error the smoke suite expects for a template that does not exist", async () => {
    const t = await withTemplates();

    const answer = await toolNamed(t, "create_from_template").run({ template: "nope", path: "Notes/X" });

    expect(answer).toBe("Error: no template 'nope' (use list_templates)");
  });

  it("create_from_template does not overwrite a note that exists: its text is unchanged", async () => {
    const t = await withTemplates({ "Notes/Existing.md": "keep me" });

    const answer = await toolNamed(t, "create_from_template").run({ template: "T", path: "Notes/Existing" });

    expect(answer).toMatch(/^Error: note already exists at 'Notes\/Existing\.md'$/);
    expect(await readFile(join(t.root, "Notes/Existing.md"), "utf-8")).toBe("keep me");
  });

  it("creates a note with the title and the dates filled in", async () => {
    const t = await withTemplates({ "Templates/Dated.md": "# {{title}}\nDate: {{date}}\nYear: {{date:YYYY}}\n" });
    const answer = await toolNamed(t, "create_from_template").run({ template: "Dated", path: "Notes/From template", title: "Hello" });
    expect(answer).toBe("Created 'Notes/From template.md' from template 'Dated'");
    expect(await readFile(join(t.root, "Notes/From template.md"), "utf-8"))
      .toBe(`# Hello\nDate: ${moment().format("YYYY-MM-DD")}\nYear: ${moment().format("YYYY")}\n`);
  });
});

describe("makePluginTools: daily notes", () => {
  async function withDailyNotes(files: Record<string, string> = {}): Promise<TestApp> {
    test = await makeApp({
      ".obsidian/core-plugins.json": JSON.stringify({ "daily-notes": true }),
      ".obsidian/daily-notes.json": JSON.stringify({ folder: "Journal/Daily", format: "YYYY-MM-DD" }),
      ...files,
    });
    return test;
  }

  it("names today's note as the Daily notes settings file it", async () => {
    const t = await withDailyNotes();
    const answer = await toolNamed(t, "daily_note").run({});
    expect(answer.split("\n")[0]).toBe(`Journal/Daily/${moment().format("YYYY-MM-DD")}.md`);
  });

  it("says a day's note is not created yet, and names it plainly once it is", async () => {
    const t = await withDailyNotes({ "Journal/Daily/2026-01-06.md": "# Tuesday" });
    expect(await toolNamed(t, "daily_note").run({ date: "2026-01-05" })).toBe("Journal/Daily/2026-01-05.md\n[Not created yet.]");
    expect(await toolNamed(t, "daily_note").run({ date: "2026-01-06" })).toBe("Journal/Daily/2026-01-06.md");
  });

  it("says a date that is not one is not", async () => {
    const t = await withDailyNotes();
    expect(await toolNamed(t, "daily_note").run({ date: "soon" })).toMatch(/^Error: 'soon' is not a date/);
  });
});
