// Reading many notes in one answer does not overflow the window: older tool results are set aside (#154).
import { describe, expect, it } from "vitest";

import { answerRoom, estimateRequest, fitLimit, runTurn, setAsideToolResults, WRAP_UP_NOTE } from "./agentLoop";
import type { ChatMessage, ChatModel, ChatRequest, Completion } from "./llm/openaiChat";
import { defineTool } from "./tools/tool";

const NOTE = "x".repeat(3000);  // ~1000 tokens at three characters a token
const readNote = defineTool("read_note", async (args) => `${args.str("path")}\n${NOTE}`);

/** A model that reads *count* notes one call at a time, then answers; it records every request. */
function reader(count: number): ChatModel & { requests: ChatRequest[] } {
  const requests: ChatRequest[] = [];
  return {
    requests,
    async complete(request): Promise<Completion> {
      // A gist of a set-aside result
      if (String(request.messages[0].content).includes("It is being set aside")) {
        const path = /read_note\(([^)]*)\)/.exec(String(request.messages[0].content))?.[1] ?? "?";
        return { content: `gist of ${path}`, reasoning: "", toolCalls: [], finishReason: "stop" };
      }
      requests.push(structuredClone(request));
      const n = requests.length;
      if (n <= count) {
        return { content: "", reasoning: "", finishReason: "tool_calls",
                 toolCalls: [{ id: `c${n}`, name: "read_note", arguments: JSON.stringify({ path: `Notes/${n}.md` }) }] };
      }
      return { content: "Summary of all notes.", reasoning: "", toolCalls: [], finishReason: "stop" };
    },
  };
}

describe("setting tool results aside within an answer", () => {
  it("keeps every request of a long answer under the window's share", async () => {
    const model = reader(20);  // 20 notes of ~1000 tokens into an 8000-token window
    const totals: number[] = [];
    const result = await runTurn({ model, tools: [readNote], systemPrompt: "sys", history: [], prompt: "read all",
                                   maxIterations: 50, contextWindow: 8000,
                                   events: { onSetAside: (total) => totals.push(total) } });
    expect(result.reply).toBe("Summary of all notes.");
    for (const request of model.requests) {
      expect(estimateRequest(request.messages, [])).toBeLessThanOrEqual(8000 * 0.75 + 1100);
    }
    expect(totals.length).toBeGreaterThan(0);
    expect(totals).toEqual([...totals].sort((a, b) => a - b));  // a running total
  });

  it("names the call it set aside, and keeps the newest result whole", async () => {
    const model = reader(10);
    await runTurn({ model, tools: [readNote], systemPrompt: "sys", history: [], prompt: "read all",
                    maxIterations: 50, contextWindow: 6000 });
    const last = model.requests[model.requests.length - 1].messages;
    const results = last.filter((m) => m.role === "tool").map((m) => String(m.content));
    expect(results[0]).toBe("[Set aside to stay inside the context window: read_note(Notes/1.md). What it said, "
                            + "in short:\ngist of Notes/1.md]");
    expect(results[results.length - 1]).toContain(NOTE);
  });

  it("changes nothing without a window, or when it all fits", async () => {
    for (const contextWindow of [undefined, 1_000_000]) {
      const model = reader(5);
      await runTurn({ model, tools: [readNote], systemPrompt: "sys", history: [], prompt: "read", maxIterations: 50,
                      contextWindow });
      const results = model.requests[model.requests.length - 1].messages.filter((m) => m.role === "tool");
      expect(results.every((m) => String(m.content).includes(NOTE))).toBe(true);
    }
  });

  it("calibrates with the server's count: a server counting double sets aside sooner", async () => {
    const counted = reader(6);
    const doubled: ChatModel = {
      async complete(request, deltas, signal) {
        const completion = await counted.complete(request, deltas, signal);
        return { ...completion, usage: { promptTokens: estimateRequest(request.messages, []) * 2, completionTokens: 5 } };
      },
    };
    let setAside = 0;
    await runTurn({ model: doubled, tools: [readNote], systemPrompt: "sys", history: [], prompt: "read",
                    maxIterations: 50, contextWindow: 12000, events: { onSetAside: (total) => { setAside = total; } } });
    expect(setAside).toBeGreaterThan(0);  // ~7000 estimated would fit 75% of 12000; counted double, it does not
  });

  it("leaves short results and ones already set aside alone", async () => {
    const messages: ChatMessage[] = [
      { role: "assistant", content: "", tool_calls: [{ id: "a", name: "list_notes", arguments: "{}" },
                                                     { id: "b", name: "read_note", arguments: '{"path":"B.md"}' },
                                                     { id: "c", name: "read_note", arguments: '{"path":"C.md"}' }] },
      { role: "tool", tool_call_id: "a", content: "short" },
      { role: "tool", tool_call_id: "b", content: NOTE },
      { role: "tool", tool_call_id: "c", content: NOTE },
    ];
    expect(await setAsideToolResults(messages, () => 10_000, 0)).toBe(1);
    expect(messages[1].content).toBe("short");
    expect(String(messages[2].content)).toContain("read_note(B.md). Call it again");  // no gist: the plain note
    expect(messages[3].content).toBe(NOTE);
    expect(await setAsideToolResults(messages, () => 10_000, 0)).toBe(0);
  });

  it("answers without tools when even setting aside cannot make room", async () => {
    // A system prompt that alone takes most of a 3000-token window: the second step must wrap up
    const model = reader(10);
    const result = await runTurn({ model, tools: [readNote], systemPrompt: "s".repeat(7500), history: [],
                                   prompt: "read all", maxIterations: 50, contextWindow: 3000 });
    const last = model.requests[model.requests.length - 1];
    expect(last.tools).toEqual([]);
    expect(last.messages.at(-1)).toEqual({ role: "user", content: WRAP_UP_NOTE });
    expect(model.requests.length).toBeLessThan(10);
    expect(result.reply).not.toBe("");
  });
});

describe("the room kept for the answer", () => {
  it("is 2,048 tokens for a small window and 15% of a large one", () => {
    expect(answerRoom(8192)).toBe(2048);
    expect(fitLimit(8192)).toBe(6144);             // 75%, as tried against llama-server -c 8192
    expect(answerRoom(32768)).toBe(4915);
    expect(fitLimit(32768)).toBe(27853);           // 85%
  });

  it("leaves a 32k answer of T7's size (25k) alone, where a share of 75% set it aside", async () => {
    const model = reader(25);  // ~25k tokens of notes read
    let setAside = 0;
    await runTurn({ model, tools: [readNote], systemPrompt: "sys", history: [], prompt: "read all", maxIterations: 50,
                    contextWindow: 32768, events: { onSetAside: (total) => { setAside = total; } } });
    const largest = Math.max(...model.requests.map((request) => estimateRequest(request.messages, [])));
    expect(largest).toBeGreaterThan(32768 * 0.75);
    expect(largest).toBeLessThan(fitLimit(32768));
    expect(setAside).toBe(0);
  });
});

describe("a tool call cut off halfway", () => {
  it("goes back as {} with an error saying to ask for less, so the server can read the history", async () => {
    const requests: ChatRequest[] = [];
    const model: ChatModel = {
      async complete(request) {
        requests.push(structuredClone(request));
        return requests.length === 1
          ? { content: "", reasoning: "", finishReason: "length",
              toolCalls: [{ id: "c1", name: "read_note", arguments: '{"path": "Notes/A.md", "pa' }] }
          : { content: "done", reasoning: "", toolCalls: [], finishReason: "stop" };
      },
    };
    await runTurn({ model, tools: [readNote], systemPrompt: "sys", history: [], prompt: "read", maxIterations: 5 });
    const [assistant, tool] = requests[1].messages.slice(-2);
    expect(assistant).toMatchObject({ role: "assistant", tool_calls: [{ id: "c1", arguments: "{}" }] });
    expect(String(tool.content)).toMatch(/^Error: JSONDecodeError: .*probably cut off.*ask for less at a time/s);
  });
});
