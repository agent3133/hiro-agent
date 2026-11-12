// Small hardening from the review of 2026-11-11 (#397), on the obsidian stand-in: the size limits of read_attachment
// for files already in the vault, and agent:tool refused while Developer is off.
import { existsSync, readFileSync, truncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { makeApp, Plugin, type TestApp } from "../testing/obsidian";
import { makeAttachmentTools } from "./attachmentTools";
import { DEFAULT_AUDIO } from "./media";
import { obsidianVault } from "./obsidianVault";
import { DEVELOPER_OFF, registerToolCli } from "./toolCli";
import { DEFAULT_WEB } from "./webTools";

let t: TestApp;

beforeEach(async () => {
  t = await makeApp({ "Docs/small.csv": "a,b\n1,2\n" });
});

afterEach(async () => {
  await t.cleanup();
});

describe("read_attachment's size limits (L7)", () => {
  const read = () => makeAttachmentTools(t.app as never, null, { ...DEFAULT_AUDIO, enabled: false }, obsidianVault(t.app as never))
    .find((tool) => tool.name === "read_attachment")!;

  it("does not read an image over 20 MB, and says the limit", async () => {
    const path = join(t.root, "Docs", "huge.png");
    writeFileSync(path, "");
    truncateSync(path, 21 * 1024 * 1024);
    const answer = await read().run({ path: "Docs/huge.png" });
    expect(answer).toBe("Error: 'Docs/huge.png' is 21 MB, more than the 20 MB the agent reads of a file of this kind, "
      + "so it was not read. Ask the user for a smaller copy.");
  });

  it("still reads a small file", async () => {
    expect(await read().run({ path: "Docs/small.csv" })).toContain("1,2");
  });
});

describe("agent:tool and the Developer switch (L12)", () => {
  /** The handler registered for agent:tool, called with *params*, with Developer as *on* says at call time. */
  function handler(on: { value: boolean }): (params: Record<string, string>) => Promise<string> {
    let registered: ((params: Record<string, string>) => Promise<string>) | null = null;
    const plugin = new Plugin(t.app);
    (plugin as unknown as { registerCliHandler: unknown }).registerCliHandler =
      (_name: string, _desc: string, _flags: unknown, run: (params: Record<string, string>) => Promise<string>) => {
        registered = run;
      };
    const options = async () => ({ memory: null, web: DEFAULT_WEB, audio: DEFAULT_AUDIO, contextWindow: 8192,
                                    journal: { enabled: false, turns: 0, maxBytes: 0 }, saveToolCalls: false,
                                    keepToolResults: false });
    registerToolCli(plugin as never, t.app as never, options, () => on.value);
    return registered!;
  }

  it("is refused while Developer is off, and runs once it is on, without a reload", async () => {
    const developer = { value: false };
    const run = handler(developer);
    expect(await run({ name: "list_notes", args: "{}" })).toBe(DEVELOPER_OFF);
    developer.value = true;
    expect(await run({ name: "list_notes", args: "{}" })).toContain("Docs/");
    developer.value = false;
    expect(await run({ name: "list_notes", args: "{}" })).toBe(DEVELOPER_OFF);
  });

  // agent:tool's answers, with Developer on (#420, toolCli.ts)
  it("runs nothing while Developer is off: a write tool leaves the vault as it was", async () => {
    const run = handler({ value: false });
    expect(await run({ name: "create_note", args: JSON.stringify({ path: "Made.md", content: "x" }) })).toBe(DEVELOPER_OFF);
    expect(existsSync(join(t.root, "Made.md"))).toBe(false);
  });

  it("answers an error naming a tool that does not exist", async () => {
    expect(await handler({ value: true })({ name: "no_such_tool", args: "{}" })).toBe("Error: no tool 'no_such_tool'");
  });

  it("answers an error saying so when args is not JSON", async () => {
    expect(await handler({ value: true })({ name: "list_notes", args: "{not json" })).toMatch(/^Error: JSONDecodeError: /);
  });

  it("answers an error saying so when args is JSON but not an object", async () => {
    const run = handler({ value: true });
    for (const args of ["[1, 2]", "42", "\"text\"", "null"]) {
      expect(await run({ name: "list_notes", args })).toBe("Error: args must be a JSON object");
    }
  });

  it("refuses a destructive tool without the confirm flag, and changes nothing", async () => {
    await t.app.vault.adapter.write("Alpha.md", "old text\n");
    const answer = await handler({ value: true })({
      name: "update_note", args: JSON.stringify({ path: "Alpha.md", content: "new text\n" }),
    });
    expect(answer).toMatch(/^Error: 'update_note' is destructive; pass the confirm flag to run it \(it would change /);
    expect(readFileSync(join(t.root, "Alpha.md"), "utf-8")).toBe("old text\n");
  });

  it("runs a destructive tool when the confirm flag is given", async () => {
    await t.app.vault.adapter.write("Alpha.md", "old text\n");
    const answer = await handler({ value: true })({
      name: "update_note", args: JSON.stringify({ path: "Alpha.md", content: "new text\n" }), confirm: "true",
    });
    expect(answer).toBe("Updated note at 'Alpha.md'");
    expect(readFileSync(join(t.root, "Alpha.md"), "utf-8")).toBe("new text\n");
  });
});
