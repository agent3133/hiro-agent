import { describe, expect, it } from "vitest";

import { CompletionBuilder, requestBody, SseDecoder } from "./openaiChat";

/** Chunk streams shaped like llama.cpp's (server b6xxx, Qwen3.6), one `data:` event per string. */
const sse = (...chunks: object[]): string =>
  chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n";
const delta = (d: object, finish: string | null = null): object => ({ choices: [{ index: 0, delta: d, finish_reason: finish }] });

function parse(stream: string, splitEvery = 0): { result: ReturnType<CompletionBuilder["result"]>; thinking: string[]; tokens: string[] } {
  const thinking: string[] = [];
  const tokens: string[] = [];
  const decoder = new SseDecoder();
  const builder = new CompletionBuilder({ onReasoning: (t) => thinking.push(t), onContent: (t) => tokens.push(t) });
  const parts = splitEvery ? stream.match(new RegExp(`[\\s\\S]{1,${splitEvery}}`, "g"))! : [stream];
  for (const part of parts) for (const payload of decoder.push(part)) builder.add(payload);
  for (const payload of decoder.flush()) builder.add(payload);
  return { result: builder.result(), thinking, tokens };
}

describe("SSE parsing", () => {
  it("separates reasoning from content and streams both", () => {
    const { result, thinking, tokens } = parse(sse(
      delta({ role: "assistant", content: null }),
      delta({ reasoning_content: "The user " }), delta({ reasoning_content: "asks." }),
      delta({ content: "Octo" }), delta({ content: "ber 1." }),
      delta({}, "stop"),
    ));
    expect(result.reasoning).toBe("The user asks.");
    expect(result.content).toBe("October 1.");
    expect(thinking).toEqual(["The user ", "asks."]);
    expect(tokens).toEqual(["Octo", "ber 1."]);
    expect(result.finishReason).toBe("stop");
    expect(result.toolCalls).toEqual([]);
  });

  it("assembles a tool call whose name and arguments arrive in pieces", () => {
    const { result } = parse(sse(
      delta({ tool_calls: [{ index: 0, id: "call_a", type: "function", function: { name: "read_", arguments: "" } }] }),
      delta({ tool_calls: [{ index: 0, function: { name: "note", arguments: "{\"path\": " } }] }),
      delta({ tool_calls: [{ index: 0, function: { arguments: "\"Projects/Atlas.md\"}" } }] }),
      delta({}, "tool_calls"),
    ));
    expect(result.toolCalls).toEqual([{ id: "call_a", name: "read_note", arguments: "{\"path\": \"Projects/Atlas.md\"}" }]);
    expect(result.finishReason).toBe("tool_calls");
  });

  it("keeps two parallel tool calls apart by index, in index order", () => {
    const { result } = parse(sse(
      delta({ tool_calls: [{ index: 1, id: "b", function: { name: "find_notes", arguments: "{\"pattern\":" } }] }),
      delta({ tool_calls: [{ index: 0, id: "a", function: { name: "read_note", arguments: "{\"path\":\"x\"}" } }] }),
      delta({ tool_calls: [{ index: 1, function: { arguments: "\"*.md\"}" } }] }),
    ));
    expect(result.toolCalls).toEqual([
      { id: "a", name: "read_note", arguments: "{\"path\":\"x\"}" },
      { id: "b", name: "find_notes", arguments: "{\"pattern\":\"*.md\"}" },
    ]);
  });

  it("gives a tool call without an id one", () => {
    const { result } = parse(sse(delta({ tool_calls: [{ index: 0, function: { name: "list_notes", arguments: "{}" } }] })));
    expect(result.toolCalls[0].id).toBe("call_0");
  });

  it("gets the same result when events are split across network chunks", () => {
    const stream = sse(delta({ reasoning_content: "hmm" }), delta({ content: "Grüße, 👋" }),
                       delta({ tool_calls: [{ index: 0, id: "c", function: { name: "read_note", arguments: "{}" } }] }));
    const whole = parse(stream).result;
    for (const size of [1, 3, 7, 64]) expect(parse(stream, size).result).toEqual(whole);
  });

  it("reads CRLF line endings and a last event without a blank line", () => {
    const decoder = new SseDecoder();
    expect(decoder.push("data: {\"a\":1}\r\n\r\ndata: [DONE]")).toEqual(["{\"a\":1}"]);
    expect(decoder.flush()).toEqual(["[DONE]"]);
  });

  it("ignores comments and non-data fields", () => {
    expect(new SseDecoder().push(": keep-alive\n\nevent: x\ndata: 1\n\n")).toEqual(["1"]);
  });

  it("raises a server error sent inside the stream", () => {
    const builder = new CompletionBuilder();
    expect(() => builder.add(JSON.stringify({ error: { message: "context size exceeded" } })))
      .toThrow("context size exceeded");
  });

  it("marks the end of the stream", () => {
    const builder = new CompletionBuilder();
    builder.add("[DONE]");
    expect(builder.done).toBe(true);
  });
});

describe("requestBody", () => {
  const settings = { baseUrl: "http://x/v1", model: "m" };

  it("sends thinking as chat_template_kwargs only when it is set", () => {
    expect(requestBody(settings, { messages: [], tools: [], thinking: false }).chat_template_kwargs)
      .toEqual({ enable_thinking: false });
    expect(requestBody(settings, { messages: [], tools: [] })).not.toHaveProperty("chat_template_kwargs");
  });

  it("sends the sampling settings that are set, under Python's names", () => {
    const body = requestBody({ ...settings, temperature: 0.6, topK: 20, minP: 0, repetitionPenalty: 1.05 },
                             { messages: [], tools: [] });
    expect(body).toMatchObject({ temperature: 0.6, top_k: 20, min_p: 0, repetition_penalty: 1.05, stream: true });
    expect(body).not.toHaveProperty("top_p");
  });

  it("wraps tools as functions and leaves `tools` out when there are none", () => {
    const tool = { name: "read_note", description: "d", parameters: { type: "object" } };
    expect(requestBody(settings, { messages: [], tools: [tool] }).tools).toEqual([{ type: "function", function: tool }]);
    expect(requestBody(settings, { messages: [], tools: [] })).not.toHaveProperty("tools");
  });

  it("sends an assistant's tool calls in the OpenAI shape", () => {
    const body = requestBody(settings, { tools: [], messages: [
      { role: "assistant", content: "", tool_calls: [{ id: "c1", name: "read_note", arguments: "{}" }] },
      { role: "tool", content: "text", tool_call_id: "c1" },
    ] });
    expect(body.messages).toEqual([
      { role: "assistant", content: "",
        tool_calls: [{ id: "c1", type: "function", function: { name: "read_note", arguments: "{}" } }] },
      { role: "tool", content: "text", tool_call_id: "c1" },
    ]);
  });
});
