import { describe, expect, it } from "vitest";

import { declined, FailureStreak, REASONING_ONLY_NOTE, runTurn, stepLimitNote, type TurnOptions } from "./agentLoop";
import type { ChatModel, ChatRequest, Completion } from "./llm/openaiChat";
import { defineTool, type Tool } from "./tools/tool";

type Step = Partial<Completion> | ((request: ChatRequest) => Partial<Completion>);

/** A model that answers with the scripted steps in order, and records every request. */
function scripted(...steps: Step[]): ChatModel & { requests: ChatRequest[] } {
  const requests: ChatRequest[] = [];
  return {
    requests,
    async complete(request, deltas) {
      requests.push(structuredClone(request));
      const step = steps[Math.min(requests.length - 1, steps.length - 1)];
      const completion = { content: "", reasoning: "", toolCalls: [], finishReason: "stop",
                           ...(typeof step === "function" ? step(request) : step) };
      if (completion.reasoning) deltas.onReasoning?.(completion.reasoning);
      if (completion.content) deltas.onContent?.(completion.content);
      return completion;
    },
  };
}

const call = (name: string, args: object = { path: "a.md" }, id = `c_${name}`) =>
  ({ id, name, arguments: JSON.stringify(args) });

const readNote: Tool = defineTool("read_note", async (args) => `text of ${args.str("path")}`);
const failing: Tool = defineTool("find_notes", async () => {
  throw new RangeError("boom");
});

function options(model: ChatModel, extra: Partial<TurnOptions> = {}): TurnOptions {
  return { model, tools: [readNote, failing], systemPrompt: "sys", history: [], prompt: "question",
           maxIterations: 5, ...extra };
}

describe("runTurn", () => {
  it("runs a tool and returns the model's answer", async () => {
    const model = scripted({ toolCalls: [call("read_note")] }, { content: "The answer." });
    const result = await runTurn(options(model));
    expect(result.reply).toBe("The answer.");
    expect(result.toolCalls).toBe(1);
    const second = model.requests[1].messages;
    expect(second.at(-1)).toEqual({ role: "tool", content: "text of a.md", tool_call_id: "c_read_note" });
  });

  it("thinks on the first call and not after a tool result", async () => {
    const model = scripted({ toolCalls: [call("read_note")] }, { content: "done" });
    await runTurn(options(model, { thinking: true }));
    expect(model.requests.map((r) => r.thinking)).toEqual([true, false]);
  });

  it("sends no thinking setting when none is configured", async () => {
    const model = scripted({ toolCalls: [call("read_note")] }, { content: "done" });
    await runTurn(options(model));
    expect(model.requests.map((r) => r.thinking)).toEqual([undefined, undefined]);
  });

  it("does not think without tools, so the model writes an answer", async () => {
    const model = scripted({ content: "hi" });
    await runTurn(options(model, { thinking: true, tools: [] }));
    expect(model.requests[0].thinking).toBe(false);
  });

  it("stops after max_iterations tool rounds with Python's note, keeping earlier text", async () => {
    const model = scripted({ content: "Working on it.", toolCalls: [call("read_note")] });
    const result = await runTurn(options(model, { maxIterations: 2 }));
    expect(model.requests).toHaveLength(3);
    expect(result.toolCalls).toBe(2);
    expect(result.hitStepLimit).toBe(true);
    expect(result.reply).toBe(`Working on it.\n\n${stepLimitNote(2)}`);
  });

  it("says when the last call after tool results produced only reasoning", async () => {
    const model = scripted({ toolCalls: [call("read_note")] }, { reasoning: "I think the answer is…" });
    const result = await runTurn(options(model));
    expect(result.reply).toBe(REASONING_ONLY_NOTE);
  });

  it("reports a throwing tool to the model as an error result instead of failing the turn", async () => {
    const results: [string, boolean][] = [];
    const model = scripted({ toolCalls: [call("find_notes", { pattern: "x" })] }, { content: "sorry" });
    const result = await runTurn(options(model, { events: { onToolResult: (_id, r, e) => results.push([r, e]) } }));
    expect(results).toEqual([["Error: RangeError: boom", true]]);
    expect(result.reply).toBe("sorry");
  });

  it("reports unparsable arguments and unknown tools as errors", async () => {
    const model = scripted({ toolCalls: [{ id: "x", name: "read_note", arguments: "{oops" },
                                         { id: "y", name: "delete_vault", arguments: "{}" }] },
                           { content: "ok" });
    await runTurn(options(model));
    const [bad, unknown] = model.requests[1].messages.slice(-2);
    expect(bad.content).toMatch(/^Error: JSONDecodeError: /);
    expect(unknown.content).toBe("Error: delete_vault is not a valid tool, try one of [read_note, find_notes].");
  });

  it("reports a missing required argument as an error", async () => {
    const model = scripted({ toolCalls: [{ id: "x", name: "read_note", arguments: "{}" }] }, { content: "ok" });
    await runTurn(options(model));
    expect(model.requests[1].messages.at(-1)!.content).toBe("Error: ValidationError: missing required argument 'path'");
  });

  it("adds the failure note on the third failure in a row of one tool", async () => {
    const model = scripted({ toolCalls: [call("find_notes", { pattern: "x" })] });
    const result = await runTurn(options(model, { maxIterations: 3 }));
    const toolResults = model.requests[3].messages.filter((m) => m.role === "tool").map((m) => m.content);
    expect(toolResults[1]).toBe("Error: RangeError: boom");
    expect(toolResults[2]).toContain("(Note: find_notes failed 3 times in a row.");
    expect(result.hitStepLimit).toBe(true);
  });

  it("keeps only the question and the answer for the next turn", async () => {
    const model = scripted({ toolCalls: [call("read_note")] }, { content: "Answer." });
    const earlier = [{ role: "user" as const, content: "q0" }, { role: "assistant" as const, content: "a0" }];
    const result = await runTurn(options(model, { history: earlier }));
    expect(result.history).toEqual([...earlier, { role: "user", content: "question" },
                                    { role: "assistant", content: "Answer." }]);
    expect(model.requests[0].messages).toEqual([{ role: "system", content: "sys" }, ...earlier,
                                                { role: "user", content: "question" }]);
  });

  it("streams thinking, tokens, tool calls and results as they happen", async () => {
    const seen: string[] = [];
    const model = scripted({ reasoning: "hm", toolCalls: [call("read_note")] }, { content: "A" });
    await runTurn(options(model, { events: {
      onThinking: (t) => seen.push(`thinking:${t}`), onToken: (t) => seen.push(`token:${t}`),
      onToolCall: (id, name, input) => seen.push(`call:${id}:${name}:${JSON.stringify(input)}`),
      onToolResult: (id, r) => seen.push(`result:${id}:${r}`),
    } }));
    expect(seen).toEqual(["thinking:hm", "call:c_read_note:read_note:{\"path\":\"a.md\"}",
                          "result:c_read_note:text of a.md", "token:A"]);
  });

  it("stops when the turn is cancelled", async () => {
    const controller = new AbortController();
    const model = scripted(() => {
      controller.abort();
      return { toolCalls: [call("read_note")] };
    });
    await expect(runTurn(options(model, { signal: controller.signal }))).rejects.toThrow();
  });
});

describe("FailureStreak", () => {
  it("counts per tool and resets on success", () => {
    const streak = new FailureStreak();
    streak.note("a", "Error: x");
    streak.note("a", "Error: x");
    expect(streak.note("b", "Error: y")).toBe("Error: y");
    expect(streak.note("a", "fine")).toBe("fine");
    expect(streak.note("a", "Error: x")).toBe("Error: x");
  });
});

describe("confirmations", () => {
  const ran: string[] = [];
  const updateNote: Tool = defineTool("update_note", async (args) => {
    ran.push(args.str("path"));
    return `Updated note at '${args.str("path")}'`;
  }, { destructive: true });
  const update = (args: object) => scripted({ toolCalls: [call("update_note", args, "u1")] }, { content: "ok" });
  const resultOf = (model: ReturnType<typeof scripted>) => model.requests[1].messages.at(-1)!.content;

  it("refuses a destructive tool when there is no one to ask", async () => {
    ran.length = 0;
    const model = update({ path: "a.md", content: "x" });
    await runTurn(options(model, { tools: [updateNote] }));
    expect(resultOf(model)).toBe("Error: 'update_note' requires user confirmation, but no interactive terminal is available.");
    expect(ran).toEqual([]);
  });

  it("does not run it when the user declines", async () => {
    ran.length = 0;
    const model = update({ path: "a.md", content: "x" });
    await runTurn(options(model, { tools: [updateNote], confirm: async () => false }));
    expect(resultOf(model)).toBe(declined("update_note"));
    expect(ran).toEqual([]);
  });

  it("runs it when allowed, and asks about the note the tool will touch", async () => {
    ran.length = 0;
    const asked: unknown[] = [];
    const model = update({ path: "Inbox/Scratch", content: "x" });
    await runTurn(options(model, { tools: [updateNote], confirm: async (id, name, input) => {
      asked.push([id, name, input]);
      return true;
    } }));
    expect(asked).toEqual([["u1", "update_note", { path: "Inbox/Scratch.md", content: "x" }]]);
    expect(ran).toEqual(["Inbox/Scratch"]);
  });

  it("reports bad arguments without asking", async () => {
    let asked = false;
    const model = update({ path: "a.md" });
    await runTurn(options(model, { tools: [updateNote], confirm: async () => (asked = true) }));
    expect(resultOf(model)).toBe("Error: ValidationError: missing required argument 'content'");
    expect(asked).toBe(false);
  });

  it("never asks for a tool that is not destructive", async () => {
    let asked = false;
    const model = scripted({ toolCalls: [call("read_note")] }, { content: "ok" });
    await runTurn(options(model, { confirm: async () => (asked = true) }));
    expect(asked).toBe(false);
  });
});

describe("tool results with images", () => {
  it("reach the model as content parts, and the chat as words with a marker", async () => {
    const picture = { type: "image_url" as const, image_url: { url: "data:image/png;base64,AAAA" } };
    const attachment: Tool = defineTool("read_attachment", async () => "Image 'a.png':\n[image]", {
      content: async () => [{ type: "text", text: "Image 'a.png':" }, picture],
    });
    const shown: [string, boolean][] = [];
    const model = scripted({ toolCalls: [call("read_attachment", { path: "a.png" })] }, { content: "A cat." });
    const result = await runTurn(options(model, { tools: [attachment],
                                                  events: { onToolResult: (_id, text, isError) => shown.push([text, isError]) } }));
    expect(model.requests[1].messages.at(-1)!.content).toEqual([{ type: "text", text: "Image 'a.png':" }, picture]);
    expect(shown).toEqual([["Image 'a.png':\n[image]", false]]);
    expect(result.reply).toBe("A cat.");
  });
});
