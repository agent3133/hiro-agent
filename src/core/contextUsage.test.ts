// How full the context window is: counted by the server when it says, estimated when not (#151).
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { contextLine, contextTooltip, tokensShort } from "../view/contextMeter";
import { estimateTokens, runTurn } from "./agentLoop";
import { CompletionBuilder, OpenAiChat, requestBody, type ChatModel, type Completion } from "./llm/openaiChat";

const settings = { baseUrl: "http://x/v1", model: "m", temperature: 0.7 };

describe("the stream's usage", () => {
  it("is asked for in the request, unless turned off", () => {
    expect(requestBody(settings, { messages: [], tools: [] }).stream_options).toEqual({ include_usage: true });
    expect(requestBody(settings, { messages: [], tools: [] }, false)).not.toHaveProperty("stream_options");
  });

  it("is read from OpenAI's usage chunk, which has no choices", () => {
    const builder = new CompletionBuilder();
    builder.add(JSON.stringify({ choices: [{ delta: { content: "Hi" }, finish_reason: "stop" }] }));
    builder.add(JSON.stringify({ choices: [], usage: { prompt_tokens: 1200, completion_tokens: 30, total_tokens: 1230 } }));
    expect(builder.result()).toMatchObject({ content: "Hi", usage: { promptTokens: 1200, completionTokens: 30 } });
  });

  it("falls back to llama.cpp's timings, counting the cached prompt too", () => {
    const builder = new CompletionBuilder();
    builder.add(JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }],
                                 timings: { cache_n: 10, prompt_n: 4, predicted_n: 5 } }));
    expect(builder.result().usage).toEqual({ promptTokens: 14, completionTokens: 5 });
  });

  it("prefers usage over timings when a server sends both", () => {
    const builder = new CompletionBuilder();
    builder.add(JSON.stringify({ choices: [], timings: { cache_n: 0, prompt_n: 99, predicted_n: 1 },
                                 usage: { prompt_tokens: 14, completion_tokens: 5 } }));
    expect(builder.result().usage).toEqual({ promptTokens: 14, completionTokens: 5 });
  });

  it("is absent when the server says nothing", () => {
    const builder = new CompletionBuilder();
    builder.add(JSON.stringify({ choices: [{ delta: { content: "x" } }] }));
    expect(builder.result()).not.toHaveProperty("usage");
  });
});

describe("runTurn's onUsage", () => {
  function model(...steps: Partial<Completion>[]): ChatModel {
    let n = 0;
    return {
      async complete() {
        return { content: "", reasoning: "", toolCalls: [], finishReason: "stop", ...steps[Math.min(n++, steps.length - 1)] };
      },
    };
  }

  it("reports the server's count after each model call", async () => {
    const seen: [number, boolean][] = [];
    await runTurn({ model: model({ content: "answer", usage: { promptTokens: 900, completionTokens: 100 } }),
                    tools: [], systemPrompt: "sys", history: [], prompt: "q", maxIterations: 3,
                    events: { onUsage: (tokens, estimated) => seen.push([tokens, estimated]) } });
    expect(seen).toEqual([[1000, false]]);
  });

  it("estimates from the characters when the server does not count", async () => {
    const seen: [number, boolean][] = [];
    await runTurn({ model: model({ content: "answer" }), tools: [], systemPrompt: "s".repeat(3000), history: [],
                    prompt: "q", maxIterations: 3, events: { onUsage: (tokens, estimated) => seen.push([tokens, estimated]) } });
    expect(seen).toHaveLength(1);
    expect(seen[0][1]).toBe(true);
    expect(seen[0][0]).toBeGreaterThanOrEqual(1000);  // 3000 characters of system prompt at three a token
  });

  it("estimates high rather than low: three characters a token", () => {
    const completion = { content: "x".repeat(300), reasoning: "", toolCalls: [], finishReason: "stop" };
    expect(estimateTokens([], [], completion)).toBeGreaterThanOrEqual(100);
  });
});

describe("a server that refuses stream_options", () => {
  let server: Server | undefined;
  afterEach(() => server?.close());

  it("is asked again without it, and not asked for it again", async () => {
    const bodies: Record<string, unknown>[] = [];
    server = createServer((req, res) => {
      let text = "";
      req.on("data", (part) => (text += part));
      req.on("end", () => {
        const body = JSON.parse(text) as Record<string, unknown>;
        bodies.push(body);
        if (body.stream_options) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: { message: "Unrecognized request argument supplied: stream_options" } }));
          return;
        }
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
      });
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    const chat = new OpenAiChat({ ...settings, baseUrl: `http://127.0.0.1:${port}/v1` });
    expect((await chat.complete({ messages: [{ role: "user", content: "hi" }], tools: [] }, {})).content).toBe("ok");
    expect((await chat.complete({ messages: [{ role: "user", content: "hi" }], tools: [] }, {})).content).toBe("ok");
    expect(bodies.map((body) => "stream_options" in body)).toEqual([true, false, false]);
  });
});

describe("the meter's words", () => {
  it("shortens token counts", () => {
    expect(tokensShort(950)).toBe("950");
    expect(tokensShort(12345)).toBe("12.3k");
    expect(tokensShort(32000)).toBe("32k");
    expect(tokensShort(131072)).toBe("131k");
  });

  it("says the share, marks an estimate, and turns orange nearing the summary, red past it", () => {
    expect(contextLine(12345, 32768, false)).toEqual({ text: "12.3k of 32.8k tokens · 38%", share: 38, level: "low" });
    expect(contextLine(12345, 32768, true).text).toBe("≈ 12.3k of 32.8k tokens · 38%");
    expect(contextLine(17000, 32000, false).level).toBe("high");
    expect(contextLine(27000, 32000, false).level).toBe("full");
  });

  it("says in the tooltip what is counted, and the answer's peak when it went higher", () => {
    expect(contextTooltip({ tokens: 3800, window: 32800, estimated: true })).toContain("estimated from their length");
    expect(contextTooltip({ tokens: 3800, window: 32800, estimated: true })).not.toContain("While answering");
    expect(contextTooltip({ tokens: 3800, window: 32800, estimated: true, peak: 24600 }))
      .toContain("took up to 75% (24.6k) with what the agent read");
  });

  it("says, while an answer runs, that it shows the last request with what the agent read (2026-10-06)", () => {
    const tip = contextTooltip({ tokens: 24600, window: 32800, estimated: false, peak: 24600, answering: true });
    expect(tip).toBe("While the agent answers: how much of the model's context window its last request took, with "
      + "the notes and pages it read. When the answer is done, the meter shows what the conversation keeps.");
    expect(contextTooltip({ tokens: 100, window: 1000, estimated: true, answering: true }))
      .toContain("it read, estimated from their length.");
  });
});
