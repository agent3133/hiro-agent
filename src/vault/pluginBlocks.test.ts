// Which code-block languages another plugin handles, from Obsidian's registry, on the stand-in (#395).
import { MarkdownPreviewRenderer } from "obsidian";
import { afterEach, describe, expect, it } from "vitest";

import { describe as describeConfirm } from "../view/ConfirmModal";
import { isPluginBlock } from "./pluginBlocks";

const renderer = MarkdownPreviewRenderer as unknown as { codeBlockPostProcessors: Record<string, unknown> | undefined };

afterEach(() => {
  renderer.codeBlockPostProcessors = {};
});

describe("isPluginBlock", () => {
  it("is true for a language a plugin registered, and false for Obsidian's own blocks even when registered", () => {
    renderer.codeBlockPostProcessors = { dataviewjs: () => undefined, base: () => undefined, query: () => undefined };
    expect(isPluginBlock("dataviewjs")).toBe(true);
    expect(isPluginBlock("DataviewJS")).toBe(true);
    expect(isPluginBlock("base")).toBe(false);
    expect(isPluginBlock("query")).toBe(false);
    expect(isPluginBlock("python")).toBe(false);
  });

  it("counts a known plugin's language even when the registry does not list it", () => {
    renderer.codeBlockPostProcessors = {};
    expect(isPluginBlock("js-engine")).toBe(true);
  });

  it("without a registry, counts every language that is neither Obsidian's own nor common code", () => {
    renderer.codeBlockPostProcessors = undefined;
    expect(isPluginBlock("some-plugin-lang")).toBe(true);
    expect(isPluginBlock("typescript")).toBe(false);
    expect(isPluginBlock("mermaid")).toBe(false);
  });
});

describe("the confirmation (#395)", () => {
  it("says what the note would load or run once shown", () => {
    const { summary } = describeConfirm({ name: "create_note",
      input: { path: "Inbox/x.md", content: "…", when_shown: "load https://evil.example/p" } });
    expect(summary).toBe("Create Inbox/x.md. When the note is shown, it would load https://evil.example/p.");
  });

  it("says nothing more when there is nothing to load", () => {
    expect(describeConfirm({ name: "append_to_note", input: { path: "a.md", text: "x" } }).summary).toBe("Append to a.md");
  });
});
