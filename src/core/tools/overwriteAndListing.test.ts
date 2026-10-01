// Replacing a note with create_note asks first (#157); listing leaves out notes in dot folders (#158).
import { describe, expect, it } from "vitest";

import { asksFirst, runTurn, type Confirm } from "../agentLoop";
import type { ChatModel, Completion } from "../llm/openaiChat";
import { makeVault } from "../testing/vault";

/** A model that makes one create_note call with *args*, then answers "done". */
function creating(args: Record<string, unknown>): ChatModel {
  let n = 0;
  return {
    async complete(): Promise<Completion> {
      n += 1;
      return n === 1
        ? { content: "", reasoning: "", finishReason: "tool_calls",
            toolCalls: [{ id: "c1", name: "create_note", arguments: JSON.stringify(args) }] }
        : { content: "done", reasoning: "", toolCalls: [], finishReason: "stop" };
    },
  };
}

/** Runs one turn making that call; the confirmation answers *answer*, or there is none. */
async function turn(vault: Awaited<ReturnType<typeof makeVault>>, args: Record<string, unknown>,
                    answer?: boolean): Promise<{ asked: Record<string, unknown>[]; result: string }> {
  const asked: Record<string, unknown>[] = [];
  let result = "";
  const confirm: Confirm | undefined = answer === undefined ? undefined : async (_id, _name, input) => {
    asked.push(input);
    return answer;
  };
  await runTurn({ model: creating(args), tools: [vault.tool("create_note")], systemPrompt: "sys", history: [],
                  prompt: "write it", maxIterations: 3, confirm,
                  events: { onToolResult: (_id, text) => { result = text; } } });
  return { asked, result };
}

describe("create_note replacing a note (#157)", () => {
  it("asks first, naming the note, and writes nothing when declined", async () => {
    const vault = await makeVault({ "Notes/Plan.md": "the old plan" });
    const { asked, result } = await turn(vault, { path: "Notes/Plan", content: "gone", overwrite: true }, false);
    expect(asked).toHaveLength(1);
    expect(asked[0].path).toBe("Notes/Plan.md");
    expect(result).toBe("Error: the user declined to run 'create_note'.");
    expect(await vault.read("Notes/Plan.md")).toBe("the old plan");
  });

  it("replaces the note once allowed", async () => {
    const vault = await makeVault({ "Notes/Plan.md": "the old plan" });
    const { asked } = await turn(vault, { path: "Notes/Plan.md", content: "the new plan", overwrite: true }, true);
    expect(asked).toHaveLength(1);
    expect(await vault.read("Notes/Plan.md")).toBe("the new plan");
  });

  it("is refused where no one can be asked", async () => {
    const vault = await makeVault({ "Notes/Plan.md": "the old plan" });
    const { result } = await turn(vault, { path: "Notes/Plan.md", content: "x", overwrite: true });
    expect(result).toContain("requires user confirmation");
    expect(await vault.read("Notes/Plan.md")).toBe("the old plan");
  });

  it("does not ask to create a new note, with or without overwrite", async () => {
    const vault = await makeVault();
    const withFlag = await turn(vault, { path: "New.md", content: "a", overwrite: true }, false);
    const without = await turn(vault, { path: "Other.md", content: "b" }, false);
    expect(withFlag.asked).toEqual([]);
    expect(without.asked).toEqual([]);
    expect(await vault.read("New.md")).toBe("a");
    expect(await vault.read("Other.md")).toBe("b");
  });

  it("does not ask when the note exists but overwrite is not set: it refuses as before", async () => {
    const vault = await makeVault({ "Plan.md": "old" });
    const { asked, result } = await turn(vault, { path: "Plan.md", content: "new" }, true);
    expect(asked).toEqual([]);
    expect(result).toBe("Error: note already exists at 'Plan.md'");
  });

  it("asks when the check itself fails, rather than letting the call through", async () => {
    const tool = { destructive: false, parameters: { type: "object", properties: {} },
                   destructiveWhen: async () => { throw new Error("broken"); } };
    expect(await asksFirst(tool as never, {})).toBe(true);
  });
});

describe("list_notes and dot folders (#158)", () => {
  const notes = {
    "Inbox/Idea.md": "i", "Top.md": "t",
    ".sessions/2026-09-30 chat.md": "s", ".memory/user-profile.md": "m", ".trash/Old.md": "o",
    "Projects/.drafts/Hidden.md": "h",
  };

  it("leaves out notes below a dot folder, recursively and at the root", async () => {
    const vault = await makeVault(notes);
    const all = await vault.tool("list_notes").run({ recursive: true });
    expect(all.split("\n").sort()).toEqual(["Inbox/Idea.md", "Top.md"]);
    expect(await vault.tool("list_notes").run({})).toBe("Top.md");
  });

  it("lists the trash when it is named, so a deleted note can be restored", async () => {
    const vault = await makeVault(notes);
    expect(await vault.tool("list_notes").run({ path: ".trash" })).toBe(".trash/Old.md");
  });

  it("still refuses to list a protected folder", async () => {
    const vault = await makeVault(notes);
    expect(await vault.tool("list_notes").run({ path: ".sessions" })).toMatch(/^Error: /);
  });
});
