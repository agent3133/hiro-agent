// edit_note's destructiveWhen and confirmArgs for an edit that removes most of a note (#404), and removesMost.
import { describe, expect, it } from "vitest";

import { declined, runTurn } from "../agentLoop";
import type { ChatModel, ChatRequest, Completion } from "../llm/openaiChat";
import { removesMost } from "../removal";
import { makeVault } from "../testing/vault";

/** A model that answers with the scripted steps in order, and records every request. */
function scripted(...steps: Partial<Completion>[]): ChatModel & { requests: ChatRequest[] } {
  const requests: ChatRequest[] = [];
  return {
    requests,
    async complete(request) {
      requests.push(structuredClone(request));
      const step = steps[Math.min(requests.length - 1, steps.length - 1)];
      return { content: "", reasoning: "", toolCalls: [], finishReason: "stop", ...step };
    },
  };
}

// Ten distinct lines of 40 characters each: 409 characters with the newlines between them
const TEN_LINES = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`.padEnd(40, "."));
const LONG_NOTE = TEN_LINES.join("\n");
// The last eight lines, which an edit takes away; the note keeps its first two lines and the newline after them
const TAKEN = TEN_LINES.slice(2).join("\n");
const KEPT = `${TEN_LINES[0]}\n${TEN_LINES[1]}\n`;

describe("edit_note asks about an edit that removes most of a note (#404)", () => {
  it("asks when the edit takes the last eight of ten long lines away", async () => {
    const vault = await makeVault({ "Long.md": LONG_NOTE });
    const edit = vault.tool("edit_note");
    expect(await edit.destructiveWhen!({ path: "Long.md", old_text: TAKEN, new_text: "" })).toBe(true);
  });

  it("does not ask when one line is replaced by another of the same length", async () => {
    const vault = await makeVault({ "Long.md": LONG_NOTE });
    const edit = vault.tool("edit_note");
    const replacement = "replaced".padEnd(40, "#");
    expect(await edit.destructiveWhen!({ path: "Long.md", old_text: TEN_LINES[4], new_text: replacement })).toBe(false);
  });

  it("does not ask about emptying a note shorter than 200 characters", async () => {
    const short = "A short note.\nIt has two lines.\n";
    const vault = await makeVault({ "Short.md": short });
    const edit = vault.tool("edit_note");
    expect(await edit.destructiveWhen!({ path: "Short.md", old_text: short.trimEnd(), new_text: "" })).toBe(false);
  });

  it("shows the share it would remove, and the note as the edit leaves it", async () => {
    const vault = await makeVault({ "Long.md": LONG_NOTE });
    const edit = vault.tool("edit_note");
    const shown = await edit.confirmArgs!({ path: "Long.md", old_text: TAKEN, new_text: "" });
    expect(shown).toMatchObject({ removes: "it would remove 80 % of the note", planned_content: KEPT });
  });

  it("removesMost gives the share an edit removes, and null below half of a note of 200 characters or more", () => {
    expect(removesMost("x".repeat(300), "x".repeat(100))).toBeCloseTo(0.667, 2);
    expect(removesMost("x".repeat(300), "x".repeat(200))).toBeNull();
  });

  it("leaves the note unchanged when the user declines the edit, and asks once", async () => {
    const vault = await makeVault({ "Long.md": LONG_NOTE });
    const asked: string[] = [];
    const model = scripted(
      { toolCalls: [{ id: "e1", name: "edit_note", arguments: JSON.stringify({ path: "Long.md", old_text: TAKEN, new_text: "" }) }] },
      { content: "ok" },
    );
    await runTurn({
      model, tools: [vault.tool("edit_note")], systemPrompt: "sys", history: [], prompt: "shorten it",
      maxIterations: 5,
      confirm: async (_id, name) => {
        asked.push(name);
        return false;
      },
    });
    expect(await vault.read("Long.md")).toBe(LONG_NOTE);
    expect(asked).toEqual(["edit_note"]);
    expect(model.requests[1].messages.at(-1)).toEqual(expect.objectContaining({ content: declined("edit_note") }));
  });
});
