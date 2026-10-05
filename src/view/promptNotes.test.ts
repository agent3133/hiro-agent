// The notes under the Agents tab's "Show as sent" (#67).
import { describe, expect, it } from "vitest";

import { previewNotes } from "./promptNotes";

describe("previewNotes", () => {
  it("names the model, and only that when nothing else applies", () => {
    expect(previewNotes({ text: "", unsupported: [], model: "qwen3", mcpFromCache: false }))
      .toEqual(["For the model qwen3, as the agent's connection names it now."]);
  });

  it("says when no model is named", () => {
    expect(previewNotes({ text: "", unsupported: [], model: "", mcpFromCache: false })[0]).toContain("No model is named");
  });

  it("lists the expressions left as written, and says nothing ran", () => {
    const notes = previewNotes({ text: "", unsupported: ["shell('git log')", "{% if x %}"], model: "m", mcpFromCache: false });
    expect(notes[1]).toBe("Left as written, since the plugin fills in plain placeholders only and runs no commands: "
                          + "shell('git log'), {% if x %}.");
  });

  it("says the MCP tools come from the last listing", () => {
    expect(previewNotes({ text: "", unsupported: [], model: "m", mcpFromCache: true })[1]).toContain("last listed");
  });
});
