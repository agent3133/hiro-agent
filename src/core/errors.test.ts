// Errors as the plugin reports them (#174).
import { describe, expect, it } from "vitest";

import { runTurn, toolErrorText } from "./agentLoop";
import { ArgumentError, messageOf } from "./errors";
import type { ChatModel, ChatRequest } from "./llm/openaiChat";
import { defineTool } from "./tools/tool";

describe("messageOf", () => {
  it("gives an Error's message, a string as it is, and anything else in words", () => {
    expect(messageOf(new Error("broke"))).toBe("broke");
    expect(messageOf("plain text")).toBe("plain text");
    expect(messageOf({ code: 42 })).toBe('{"code":42}');
    expect(messageOf(undefined)).toBe("undefined");
    expect(messageOf(null)).toBe("null");
  });

  it("does not throw for something JSON cannot write", () => {
    const loop: Record<string, unknown> = {};
    loop.self = loop;
    expect(messageOf(loop)).toBe("[object Object]");
  });
});

describe("what the model is told a tool's error was", () => {
  it("calls arguments that do not fit a ValidationError, so the model fixes its call", () => {
    expect(toolErrorText(new ArgumentError("argument 'limit' must be an integer")))
      .toBe("Error: ValidationError: argument 'limit' must be an integer");
  });

  it("keeps a TypeError from a bug as a TypeError, instead of blaming the arguments", () => {
    expect(toolErrorText(new TypeError("Cannot read properties of undefined (reading 'path')")))
      .toBe("Error: TypeError: Cannot read properties of undefined (reading 'path')");
  });

  it("reports a wrong argument type from a real tool as a ValidationError", async () => {
    const tool = defineTool("list_notes", async () => "listed");
    const requests: ChatRequest[] = [];
    const model: ChatModel = {
      async complete(request) {
        requests.push(structuredClone(request));
        return requests.length === 1
          ? { content: "", reasoning: "", finishReason: "tool_calls",
              toolCalls: [{ id: "c1", name: "list_notes", arguments: '{"limit": "many"}' }] }
          : { content: "done", reasoning: "", toolCalls: [], finishReason: "stop" };
      },
    };
    await runTurn({ model, tools: [tool], systemPrompt: "sys", history: [], prompt: "list", maxIterations: 3 });
    expect(requests[1].messages.at(-1)!.content).toBe("Error: ValidationError: argument 'limit' must be an integer");
  });
});
