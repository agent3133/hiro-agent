// OpenAI's Responses API (#295): the request, the stream, reasoning passed back with tool results, and the
// refusals it answers by asking again.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { resolveConnection, wireFormat } from "../../config/connections";
import { runTurn } from "../agentLoop";
import { defineTool } from "../tools/tool";
import { CompletionBuilder, requestBody } from "./openaiChat";
import { inputItems, OpenAiResponses, responsesBody, ResponsesBuilder } from "./openaiResponses";

const settings = { baseUrl: "http://x/v1", model: "gpt" };
const ask = { messages: [{ role: "user" as const, content: "hi" }], tools: [] };
const reasoningItem = { type: "reasoning", id: "rs_1", summary: [], encrypted_content: "gAAA…" };

/** Server-sent events as the Responses API streams them. */
const sse = (...events: object[]): string => events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
const completed = (input = 10, output = 5) =>
  ({ type: "response.completed", response: { status: "completed", usage: { input_tokens: input, output_tokens: output } } });
const text = (words: string) => [{ type: "response.output_text.delta", delta: words }, completed()];

describe("a Responses request", () => {
  it("sends the messages as input items, the tools not strict, and nothing to store", () => {
    const body = responsesBody({ ...settings, reasoningEffort: "low", maxTokens: 500, serviceTier: "flex" }, {
      messages: [{ role: "system", content: "sys" }, { role: "user", content: "q" }],
      tools: [{ name: "read_note", description: "Reads.", parameters: { type: "object" } }],
      thinking: true,
    });
    expect(body).toMatchObject({
      model: "gpt", stream: true, store: false, include: ["reasoning.encrypted_content"],
      input: [{ role: "system", content: "sys" }, { role: "user", content: "q" }],
      tools: [{ type: "function", name: "read_note", description: "Reads.", parameters: { type: "object" }, strict: false }],
      reasoning: { effort: "low", summary: "auto" }, max_output_tokens: 500, service_tier: "flex",
    });
    // llama.cpp's thinking switch and chat completions' names are not the Responses API's
    expect(body).not.toHaveProperty("chat_template_kwargs");
    expect(body).not.toHaveProperty("max_tokens");
    expect(body).not.toHaveProperty("temperature");
  });

  it("puts an answer's reasoning items before its calls, and each result after them", () => {
    expect(inputItems({ role: "assistant", content: "Let me look.", reasoning_items: [reasoningItem],
                        tool_calls: [{ id: "c1", name: "read_note", arguments: "{\"path\":\"a.md\"}" }] })).toEqual([
      reasoningItem,
      { role: "assistant", content: "Let me look." },
      { type: "function_call", call_id: "c1", name: "read_note", arguments: "{\"path\":\"a.md\"}" },
    ]);
    expect(inputItems({ role: "tool", tool_call_id: "c1", content: "text" }))
      .toEqual([{ type: "function_call_output", call_id: "c1", output: "text" }]);
  });

  it("sends a result with an image as input parts", () => {
    expect(inputItems({ role: "tool", tool_call_id: "c1", content: [
      { type: "text", text: "a picture" }, { type: "image_url", image_url: { url: "data:image/png;base64,AA" } }] }))
      .toEqual([{ type: "function_call_output", call_id: "c1", output: [
        { type: "input_text", text: "a picture" }, { type: "input_image", image_url: "data:image/png;base64,AA" }] }]);
  });

  it("keeps reasoning items away from a chat completions server", () => {
    const body = requestBody(settings, { tools: [], messages: [
      { role: "assistant", content: "x", reasoning_items: [reasoningItem] },
      { role: "assistant", content: "", reasoning_items: [reasoningItem], tool_calls: [{ id: "c", name: "n", arguments: "{}" }] },
    ] });
    expect(JSON.stringify(body)).not.toContain("reasoning_items");
  });
});

describe("the Responses stream", () => {
  it("builds the text, the reasoning summary, the calls, the reasoning items and the usage", () => {
    const content: string[] = [];
    const reasoning: string[] = [];
    const builder = new ResponsesBuilder({ onContent: (t) => content.push(t), onReasoning: (t) => reasoning.push(t) });
    const events = [
      { type: "response.reasoning_summary_part.added", summary_index: 0 },
      { type: "response.reasoning_summary_text.delta", delta: "Two notes." },
      { type: "response.reasoning_summary_part.added", summary_index: 1 },
      { type: "response.reasoning_summary_text.delta", delta: "Read both." },
      { type: "response.output_item.done", output_index: 0, item: reasoningItem },
      { type: "response.output_text.delta", delta: "Reading." },
      { type: "response.output_item.added", output_index: 2, item: { type: "function_call", call_id: "c1", name: "read_note", arguments: "" } },
      { type: "response.function_call_arguments.delta", output_index: 2, delta: "{\"path\":" },
      { type: "response.function_call_arguments.delta", output_index: 2, delta: "\"a.md\"}" },
      { type: "response.output_item.added", output_index: 3, item: { type: "function_call", call_id: "c2", name: "read_note", arguments: "" } },
      { type: "response.output_item.done", output_index: 3,
        item: { type: "function_call", call_id: "c2", name: "read_note", arguments: "{\"path\":\"b.md\"}" } },
      completed(120, 30),
    ];
    for (const event of events) builder.add(JSON.stringify(event));
    expect(builder.result()).toEqual({
      content: "Reading.", reasoning: "Two notes.\n\nRead both.",
      toolCalls: [{ id: "c1", name: "read_note", arguments: "{\"path\":\"a.md\"}" },
                  { id: "c2", name: "read_note", arguments: "{\"path\":\"b.md\"}" }],
      finishReason: "tool_calls", usage: { promptTokens: 120, completionTokens: 30 }, reasoningItems: [reasoningItem],
    });
    expect(content).toEqual(["Reading."]);
    expect(reasoning.join("")).toBe("Two notes.\n\nRead both.");
  });

  it("records the service tier OpenAI says served the answer, on either API", () => {
    const responses = new ResponsesBuilder();
    responses.add(JSON.stringify({ type: "response.completed", response: { status: "completed", service_tier: "flex" } }));
    expect(responses.result().serviceTier).toBe("flex");
    const chat = new CompletionBuilder();
    chat.add(JSON.stringify({ service_tier: "default", choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }));
    expect(chat.result().serviceTier).toBe("default");
    expect(new ResponsesBuilder().result()).not.toHaveProperty("serviceTier");
  });

  it("says an answer cut off by its length as finish reason length", () => {
    const builder = new ResponsesBuilder();
    builder.add(JSON.stringify({ type: "response.incomplete",
                                 response: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } } }));
    expect(builder.result().finishReason).toBe("length");
  });

  it("fails with the API's message on a failed answer or an error event", () => {
    expect(() => new ResponsesBuilder().add(JSON.stringify({ type: "response.failed",
      response: { status: "failed", error: { code: "server_error", message: "The model broke." } } }))).toThrow("The model broke.");
    expect(() => new ResponsesBuilder().add(JSON.stringify({ type: "error", code: "context_length_exceeded",
      message: "Your input exceeds the context window." }))).toThrow(/exceeds the context window/);
    expect(() => new ResponsesBuilder().add(JSON.stringify({ type: "error", error: { code: "server_error",
      message: "Something broke." } }))).toThrow("Something broke.");
  });
});

describe("which API a connection speaks", () => {
  it("is the Responses API for OpenAI's address on auto, and chat completions for any other", () => {
    expect(wireFormat(undefined, "https://api.openai.com/v1")).toBe("responses");
    expect(wireFormat("auto", "http://127.0.0.1:8080/v1")).toBe("chat_completions");
    expect(wireFormat("auto", "https://openrouter.ai/api/v1")).toBe("chat_completions");
    expect(wireFormat("responses", "https://example.com/v1")).toBe("responses");
    expect(wireFormat("chat_completions", "https://api.openai.com/v1")).toBe("chat_completions");
  });

  it("is read from a connection, OpenAI's own when it names no address", () => {
    const read = (values: Record<string, unknown>) =>
      resolveConnection({ llm_profiles: { c: { model: "gpt", ...values } } }, "c", () => undefined).api;
    expect(read({})).toBe("responses");
    expect(read({ base_url: "http://127.0.0.1:8080" })).toBe("chat_completions");
    expect(read({ api: "chat_completions" })).toBe("chat_completions");
  });
});

describe("a Responses server", () => {
  let server: Server | undefined;
  afterEach(() => server?.close());

  /** A server answering each request with the next script; the bodies it was sent and the paths it was asked at. */
  async function serve(...scripts: ((body: Record<string, unknown>) => { status?: number; body: string })[]) {
    const bodies: Record<string, unknown>[] = [];
    const paths: string[] = [];
    server = createServer((req, res) => {
      let raw = "";
      req.on("data", (part) => (raw += part));
      req.on("end", () => {
        const body = JSON.parse(raw) as Record<string, unknown>;
        bodies.push(body);
        paths.push(req.url ?? "");
        const answer = scripts[Math.min(bodies.length - 1, scripts.length - 1)](body);
        const status = answer.status ?? 200;
        res.writeHead(status, { "Content-Type": status === 200 ? "text/event-stream" : "application/json" });
        res.end(answer.body);
      });
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    return { baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, bodies, paths };
  }

  it("runs a tool and passes the reasoning back with its result", async () => {
    const { baseUrl, bodies, paths } = await serve(
      () => ({ body: sse(
        { type: "response.output_item.done", output_index: 0, item: reasoningItem },
        { type: "response.output_item.added", output_index: 1, item: { type: "function_call", call_id: "c1", name: "read_note", arguments: "" } },
        { type: "response.output_item.done", output_index: 1,
          item: { type: "function_call", call_id: "c1", name: "read_note", arguments: "{\"path\":\"a.md\"}" } },
        completed()) }),
      () => ({ body: sse(...text("It says hello.")) }),
    );
    const readNote = defineTool("read_note", async (args) => `text of ${args.str("path")}`);
    const result = await runTurn({ model: new OpenAiResponses({ ...settings, baseUrl }), tools: [readNote],
                                   systemPrompt: "sys", history: [], prompt: "What does a.md say?", maxIterations: 5 });
    expect(result.reply).toBe("It says hello.");
    expect(paths).toEqual(["/v1/responses", "/v1/responses"]);
    expect(bodies[1].input).toEqual([
      { role: "system", content: "sys" }, { role: "user", content: "What does a.md say?" },
      reasoningItem,
      { type: "function_call", call_id: "c1", name: "read_note", arguments: "{\"path\":\"a.md\"}" },
      { type: "function_call_output", call_id: "c1", output: "text of a.md" },
    ]);
  });

  it("asks without a reasoning summary once the API refuses one, and from then on", async () => {
    const { baseUrl, bodies } = await serve(
      (body) => ((body.reasoning as { summary?: string } | undefined)?.summary
        ? { status: 400, body: JSON.stringify({ error: { message: "Your organization must be verified to generate reasoning summaries.", param: "reasoning.summary" } }) }
        : { body: sse(...text("ok")) }),
    );
    const model = new OpenAiResponses({ ...settings, baseUrl, reasoningEffort: "low" });
    expect((await model.complete(ask, {})).content).toBe("ok");
    expect((await model.complete(ask, {})).content).toBe("ok");
    expect(bodies.map((body) => body.reasoning)).toEqual([{ effort: "low", summary: "auto" }, { effort: "low" }, { effort: "low" }]);
  });

  it("sends a refused flex request once more at tier auto when the fallback is on", async () => {
    const { baseUrl, bodies } = await serve(
      (body) => (body.service_tier === "flex"
        ? { status: 429, body: JSON.stringify({ error: { message: "Resource unavailable for flex processing" } }) }
        : { body: sse(...text("ok")) }),
    );
    const model = new OpenAiResponses({ ...settings, baseUrl, serviceTier: "flex", serviceTierFallback: true });
    expect((await model.complete(ask, {})).content).toBe("ok");
    expect(bodies.map((body) => body.service_tier)).toEqual(["flex", "auto"]);
  });

  it("answers a flex refusal said in the stream like a 429: at tier auto with the fallback, else said plainly", async () => {
    // What OpenAI sent on 2026-10-05: an error event, nested, after the response was created
    const unavailable = sse({ type: "response.created", response: { status: "in_progress" } }, { type: "error", error: {
      type: "resource_unavailable", code: "flex_unavailable",
      message: "Flex processing is temporarily unavailable. Please try again later or use standard processing." } });
    const { baseUrl, bodies } = await serve(
      (body) => (body.service_tier === "flex" ? { body: unavailable } : { body: sse(...text("ok")) }),
    );
    const flex = { ...settings, baseUrl, serviceTier: "flex" };
    const log: string[] = [];
    expect((await new OpenAiResponses({ ...flex, serviceTierFallback: true, log: (line) => log.push(line) })
      .complete(ask, {})).content).toBe("ok");
    expect(log).toEqual([expect.stringMatching(/no flex capacity.*sent again at service tier auto/)]);
    expect(bodies.map((body) => body.service_tier)).toEqual(["flex", "auto"]);
    await expect(new OpenAiResponses({ ...flex, serviceTierFallback: false }).complete(ask, {}))
      .rejects.toThrow(/refused the request at the flex service tier.*temporarily unavailable/s);
  });

  it("fails with the API's own message for any other refusal", async () => {
    const { baseUrl } = await serve(
      () => ({ status: 400, body: JSON.stringify({ error: { message: "Unsupported value: 'reasoning.effort' does not support 'none' with this model." } }) }),
    );
    await expect(new OpenAiResponses({ ...settings, baseUrl, reasoningEffort: "none" }).complete(ask, {}))
      .rejects.toThrow(/answered HTTP 400: Unsupported value: 'reasoning.effort'/);
  });
});
