import { describe, expect, it } from "vitest";

import { sentHistory, keepTrail, type Trails } from "./keptResults";
import { runTurn } from "./agentLoop";
import { defineTool } from "./tools/tool";
import type { ChatMessage, ChatModel, Completion } from "./llm/openaiChat";

describe("runTurn keeps tool calls and results", () => {
  it("trail has the assistant message with the tool call and the tool message, history ends with prompt and answer", async () => {
    const readNote = defineTool("read_note", async () => "the note text");

    let callCount = 0;
    const model: ChatModel = {
      complete: async () => {
        callCount += 1;
        if (callCount === 1) {
          return {
            content: "",
            reasoning: "",
            toolCalls: [{ id: "c1", name: "read_note", arguments: JSON.stringify({ path: "a.md" }) }],
            finishReason: null,
          } as Completion;
        }
        return {
          content: "done",
          reasoning: "",
          toolCalls: [],
          finishReason: "stop",
        } as Completion;
      },
    };

    const result = await runTurn({
      model,
      tools: [readNote],
      systemPrompt: "You are a helper.",
      history: [],
      prompt: "Read the note",
      maxIterations: 5,
    });

    // trail should have the assistant message with the tool call, then the tool message
    expect(result.trail.length).toBe(2);
    const assistantMsg = result.trail[0] as ChatMessage & { role: "assistant"; tool_calls?: unknown[] };
    expect(assistantMsg.role).toBe("assistant");
    expect((assistantMsg as { tool_calls?: unknown[] }).tool_calls).toHaveLength(1);
    expect((assistantMsg as { tool_calls?: { name: string }[] }).tool_calls?.[0].name).toBe("read_note");

    const toolMsg = result.trail[1] as ChatMessage & { role: "tool" };
    expect(toolMsg.role).toBe("tool");
    expect(toolMsg.content).toBe("the note text");

    // history should end with the user prompt and the final answer (no tool messages)
    expect(result.history.length).toBe(2);
    expect(result.history[0]).toEqual({ role: "user", content: "Read the note" });
    expect(result.history[1]).toEqual({ role: "assistant", content: "done" });
  });

  it("previous tool results in results map, but trail holds only this answer's calls", async () => {
    const readNote = defineTool("read_note", async () => "the note text");

    let callCount = 0;
    const model: ChatModel = {
      complete: async () => {
        callCount += 1;
        if (callCount === 1) {
          return {
            content: "",
            reasoning: "",
            toolCalls: [{ id: "c2", name: "read_note", arguments: JSON.stringify({ path: "b.md" }) }],
            finishReason: null,
          } as Completion;
        }
        return {
          content: "done",
          reasoning: "",
          toolCalls: [],
          finishReason: "stop",
        } as Completion;
      },
    };

    // Pre-existing history with an assistant message that has a tool call and its result
    const prevAssistant: ChatMessage = {
      role: "assistant",
      content: "",
      tool_calls: [{ id: "old", name: "read_note", arguments: JSON.stringify({ path: "x.md" }) }],
    };
    const prevTool: ChatMessage = {
      role: "tool",
      content: "earlier",
      tool_call_id: "old",
    };

    const result = await runTurn({
      model,
      tools: [readNote],
      systemPrompt: "You are a helper.",
      history: [prevAssistant, prevTool],
      prompt: "Read another note",
      maxIterations: 5,
    });

    // results.get("old") should be "earlier" from the history
    expect(result.results.get("old")).toBe("earlier");

    // trail should only have this answer's calls, not "old"
    const callIds = result.trail
      .filter((m) => m.role === "assistant")
      .flatMap((m) => ((m as { tool_calls?: { id: string }[] }).tool_calls ?? []).map((c) => c.id));
    expect(callIds).not.toContain("old");
    expect(callIds).toContain("c2");
  });
});

describe("sentHistory", () => {
  it("with keep true, interleaves trails before each answer; with keep false, returns loaded unchanged", () => {
    const u1 = { role: "user" as const, content: "hello" };
    const a1 = { role: "assistant" as const, content: "hi" };
    const u2 = { role: "user" as const, content: "how are you" };
    const a2 = { role: "assistant" as const, content: "fine" };
    const t1 = { role: "tool" as const, content: "tool1", tool_call_id: "x1" };
    const t2 = { role: "tool" as const, content: "tool2", tool_call_id: "x2" };

    const trails = new Map<ChatMessage, ChatMessage[]>();
    trails.set(a1, [t1, t2]);

    // keep true: should interleave trails
    const withKeep = sentHistory<ChatMessage>({ loaded: [u1, a1, u2, a2], trails }, true);
    expect(withKeep).toEqual([u1, t1, t2, a1, u2, a2]);

    // keep false: should return loaded unchanged
    const withoutKeep = sentHistory<ChatMessage>({ loaded: [u1, a1, u2, a2], trails }, false);
    expect(withoutKeep).toEqual([u1, a1, u2, a2]);
  });
});

describe("keepTrail", () => {
  it("deletes trails of answers no longer in loaded, updates tool message content, adds new trail", () => {
    const u1 = { role: "user" as const, content: "hello" };
    const a1 = { role: "assistant" as const, content: "hi" };
    const a2 = { role: "assistant" as const, content: "bye" };

    const t1 = { role: "tool" as const, content: "old content", tool_call_id: "x1" };
    const t2 = { role: "tool" as const, content: "still here", tool_call_id: "x2" };

    // a1 is no longer in loaded (summarised away), so its trail should be deleted
    // a2 is still in loaded, its tool message x2 should get updated content
    const trails = new Map<ChatMessage, ChatMessage[]>();
    trails.set(a1, [t1]);
    trails.set(a2, [t2]);

    const results = new Map<string, string>();
    results.set("x2", "new content for x2");

    const conversation: Trails<ChatMessage> = { loaded: [u1, a2], trails };

    // A new answer object (not the same reference as a2 in the map)
    const newAnswer = { role: "assistant" as const, content: "new answer" };
    const newTrail = [
      { role: "tool" as const, content: "new tool result", tool_call_id: "x3" },
    ];

    keepTrail(conversation, newAnswer, newTrail, results);

    // a1's trail should be deleted
    expect(conversation.trails.has(a1)).toBe(false);

    // a2's trail should have updated content for x2 (existing trail updated)
    const a2Trail = conversation.trails.get(a2);
    expect(a2Trail).toEqual([
      { role: "tool" as const, content: "new content for x2", tool_call_id: "x2" },
    ]);

    // new answer's trail should be added
    const newTrailEntry = conversation.trails.get(newAnswer);
    expect(newTrailEntry).toEqual(newTrail);
  });

  it("with an empty trail, adds nothing for the answer", () => {
    const a1 = { role: "assistant" as const, content: "hi" };
    const trails = new Map<ChatMessage, ChatMessage[]>();

    const conversation: Trails<ChatMessage> = { loaded: [a1], trails };
    keepTrail(conversation, a1, [], new Map());

    // empty trail should not add anything
    expect(conversation.trails.has(a1)).toBe(false);
  });
});
