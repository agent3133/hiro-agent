// The holes the security review of 2026-09-30 found in the tool layer's structural limits (#135).
import { afterEach, describe, expect, it } from "vitest";

import { declaredArgs, runTurn, type TurnOptions } from "./agentLoop";
import type { ChatModel, ChatRequest } from "./llm/openaiChat";
import { PathError, protectVaultPaths, safeResolve } from "./paths";
import { listSessions, sanitiseName, sessionPath } from "./sessions";
import { makeVault } from "./testing/vault";
import { defineTool, type Tool } from "./tools/tool";

afterEach(() => protectVaultPaths({}));

describe("protected folders (F1, F10)", () => {
  it.each([
    ".obsidian/app.json", ".Obsidian/plugins/other/data.json", ".OBSIDIAN/x",
    ".agents/assistant.md", ".Agents/assistant.md", ".AGENTS/new.md", ".Tools/x.md",
    ".sessions/2026-09-30 chat.md", ".Sessions/x.md", ".memory/user-profile.md", ".Memory/user-profile.md",
  ])("refuse %s, whatever the letter case", (path) => {
    expect(() => safeResolve(path)).toThrow(PathError);
  });

  it("say what the folder holds, named as it is", () => {
    expect(() => safeResolve(".Agents/assistant.md")).toThrow("'.agents' holds agent definitions and is not reachable by tools");
  });

  it("leave notes that only begin like a protected folder alone", () => {
    expect(safeResolve(".agents-notes/x.md")).toBe(".agents-notes/x.md");
    expect(safeResolve("Notes/.agents/x.md")).toBe("Notes/.agents/x.md");
    expect(safeResolve(".trash/old.md")).toBe(".trash/old.md");
  });

  it("protect a renamed config folder and a profile kept elsewhere once the vault names them", () => {
    expect(safeResolve(".config/app.json")).toBe(".config/app.json");
    protectVaultPaths({ configDir: ".config", profilePath: "About me.md" });
    expect(() => safeResolve(".Config/plugins/x/data.json")).toThrow("'.config' holds Obsidian's own configuration");
    expect(() => safeResolve("about ME.md")).toThrow("'About me.md' is the profile the agent keeps of the user");
    expect(safeResolve("About me/other.md")).toBe("About me/other.md");
  });
});

describe("folder scope entries that name the vault itself (F8)", () => {
  it.each([[".."], ["."], ["/"], ["./"], [""]])("%j allows nothing, rather than everything", (entry) => {
    expect(() => safeResolve("Secret/x.md", [entry])).toThrow("outside this agent's allowed scope");
  });

  it("does not spoil the valid folders beside it", () => {
    expect(safeResolve("Journal/x.md", ["Journal", ".."])).toBe("Journal/x.md");
    expect(() => safeResolve("Secret/x.md", ["Journal", ".."])).toThrow("outside this agent's allowed scope");
  });
});

describe("session names (F2)", () => {
  it.each([
    ["../.agents/assistant", ".sessions/-.agents-assistant.md"],
    ["../../outside", ".sessions/-..-outside.md"],
    ["..\\Windows\\x", ".sessions/-windows-x.md"],
    ["..", ".sessions/session.md"],
    ["2026-09-30 1432 plan the week", ".sessions/2026-09-30-1432-plan-the-week.md"],
  ])("%j stays one file in .sessions/", (name, path) => {
    expect(sessionPath(name)).toBe(path);
    expect(sessionPath(name).split("/")).toHaveLength(2);
  });

  it("keep a normal name as it was", () => {
    expect(sanitiseName("Move Ideas")).toBe("move-ideas");
  });

  it("are listed by their file, not by what their frontmatter claims", async () => {
    const { vault } = await makeVault({
      ".sessions/hello.md": "---\nsession: ../.agents/assistant\nagent: assistant\nupdated: 2026-09-30T10:00:00\n---\n",
    });
    expect((await listSessions(vault)).map((s) => s.name)).toEqual(["hello"]);
  });
});

describe("what a confirmation names (F3)", () => {
  const moved: string[] = [];
  const moveNote: Tool = defineTool("move_note", async (args) => {
    moved.push(args.str("from_path"));
    return "moved";
  }, { destructive: true });

  it("drops arguments the tool does not declare", () => {
    expect(declaredArgs(moveNote, { path: "Inbox/Scratch.md", from_path: "Projects/Plan.md", to_path: "x.md" }))
      .toEqual({ from_path: "Projects/Plan.md", to_path: "x.md" });
  });

  it("keeps everything when the tool declares no arguments", () => {
    const bare = { ...moveNote, parameters: { type: "object", properties: {}, required: [] } } as Tool;
    expect(declaredArgs(bare, { a: 1 })).toEqual({ a: 1 });
  });

  it("never asks about a decoy the model added: the call is refused before any dialog (#163)", async () => {
    moved.length = 0;
    const requests: ChatRequest[] = [];
    const args = { path: "Inbox/Scratch.md", from_path: "Projects/Plan.md", to_path: "Archive/x.md" };
    const model: ChatModel = {
      async complete(request) {
        requests.push(request);
        return requests.length === 1
          ? { content: "", reasoning: "", finishReason: "tool_calls",
              toolCalls: [{ id: "m1", name: "move_note", arguments: JSON.stringify(args) }] }
          : { content: "done", reasoning: "", toolCalls: [], finishReason: "stop" };
      },
    };
    const asked: Record<string, unknown>[] = [];
    const options: TurnOptions = { model, tools: [moveNote], systemPrompt: "sys", history: [], prompt: "q",
                                   maxIterations: 3, confirm: async (_id, _name, input) => {
                                     asked.push(input as Record<string, unknown>);
                                     return true;
                                   } };
    await runTurn(options);
    // Since #163 an argument the tool does not take is an error: no dialog at all, so none can name the decoy,
    // nothing moves, and the model is told which arguments move_note takes
    expect(asked).toEqual([]);
    expect(moved).toEqual([]);
    const told = String(requests[1].messages.at(-1)!.content);
    expect(told).toContain("move_note has no argument 'path'");
    expect(told).toContain("from_path");
  });

  it("asks about the note that moves when the arguments are the tool's own", async () => {
    moved.length = 0;
    const requests: ChatRequest[] = [];
    const args = { from_path: "Projects/Plan.md", to_path: "Archive/x.md" };
    const model: ChatModel = {
      async complete(request) {
        requests.push(request);
        return requests.length === 1
          ? { content: "", reasoning: "", finishReason: "tool_calls",
              toolCalls: [{ id: "m1", name: "move_note", arguments: JSON.stringify(args) }] }
          : { content: "done", reasoning: "", toolCalls: [], finishReason: "stop" };
      },
    };
    const asked: Record<string, unknown>[] = [];
    await runTurn({ model, tools: [moveNote], systemPrompt: "sys", history: [], prompt: "q", maxIterations: 3,
                    confirm: async (_id, _name, input) => {
                      asked.push(input as Record<string, unknown>);
                      return true;
                    } });
    expect(asked).toHaveLength(1);
    expect(asked[0].from_path).toBe("Projects/Plan.md");
    expect(moved).toEqual(["Projects/Plan.md"]);
  });
});
