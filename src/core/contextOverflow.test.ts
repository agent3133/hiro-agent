// A conversation that outgrows the model's context window: tool results are cut to fit, and when a request still
// does not fit, the chat says so in words rather than with the server's JSON.
import { describe, expect, it } from "vitest";

import { fitToolResult, runTurn, turnFailure } from "./agentLoop";
import { CompletionBuilder, ContextOverflowError, httpError, type ChatModel, type ChatRequest } from "./llm/openaiChat";
import type { Tool } from "./tools/tool";

/** llama.cpp's answer to a request longer than its context (the one from the chat, shortened). */
const LLAMA_OVERFLOW = JSON.stringify({ error: {
  code: 400, message: "request (178047 tokens) exceeds the available context size (32768 tokens), try increasing it",
  type: "exceed_context_size_error", n_prompt_tokens: 178047, n_ctx: 32768 } });

describe("httpError", () => {
  it("recognises llama.cpp's context error, with its token counts", () => {
    const error = httpError(400, "127.0.0.1:8080", LLAMA_OVERFLOW);
    expect(error).toBeInstanceOf(ContextOverflowError);
    expect(error).toMatchObject({ promptTokens: 178047, contextSize: 32768 });
  });

  it("recognises OpenAI's context_length_exceeded", () => {
    const body = JSON.stringify({ error: { code: "context_length_exceeded", message: "This model's maximum…" } });
    expect(httpError(400, "api.openai.com", body)).toBeInstanceOf(ContextOverflowError);
  });

  it("says a refused key in words, without the stars, and where the key is set", () => {
    const body = JSON.stringify({ error: { message: "Incorrect API key provided: sk-proj-********************abcd. "
      + "You can find your API key at https://platform.openai.com/account/api-keys.", code: "invalid_api_key" } });
    const error = httpError(401, "api.openai.com", body);
    expect(error).not.toBeInstanceOf(ContextOverflowError);
    expect(error.message).toBe("api.openai.com did not accept the API key (HTTP 401: Incorrect API key provided: "
      + "sk-proj-…abcd. You can find your API key at https://platform.openai.com/account/api-keys.). Check the key "
      + "this connection names in Settings → Hiro Agent → Secrets.");
  });

  it("gives any other error the server's message rather than its JSON", () => {
    expect(httpError(500, "h", JSON.stringify({ error: { message: "model not loaded" } })).message)
      .toBe("h answered HTTP 500: model not loaded");
    expect(httpError(503, "h", JSON.stringify({ error: "Loading model" })).message).toBe("h answered HTTP 503: Loading model");
    expect(httpError(502, "h", "Bad Gateway").message).toBe("h answered HTTP 502: Bad Gateway");
  });

  it("recognises the error when it comes inside the stream", () => {
    expect(() => new CompletionBuilder().add(LLAMA_OVERFLOW)).toThrow(ContextOverflowError);
  });
});

describe("turnFailure", () => {
  it("says in words that the turn outgrew the model, with the numbers", () => {
    const text = turnFailure(httpError(400, "127.0.0.1:8080", LLAMA_OVERFLOW));
    expect(text).toContain("no longer fits the model's context window");
    expect(text).toContain("It needs 178,047 tokens; the model takes 32,768.");
    expect(text).not.toContain("{");
  });

  it("leaves the numbers out when the server gave none", () => {
    expect(turnFailure(new ContextOverflowError("x"))).not.toContain("It needs");
  });

  it("reports any other failure with its message", () => {
    expect(turnFailure(new Error("model not loaded"))).toBe("The turn failed: model not loaded");
  });

  it("says what a network error means for the model server", () => {
    const failing = (code: string): Error => Object.assign(new Error(`read ${code}`), { code });
    expect(turnFailure(failing("ECONNRESET"))).toContain("broke off in the middle of the answer");
    expect(turnFailure(failing("ECONNREFUSED"))).toContain("does not answer. Is it running");
    expect(turnFailure(failing("ETIMEDOUT"))).toContain("cannot be reached (ETIMEDOUT)");
  });
});

describe("fitToolResult", () => {
  it("leaves a result that fits, and one with no limit, as it was", () => {
    expect(fitToolResult("short", 10)).toBe("short");
    expect(fitToolResult("x".repeat(1000), undefined)).toBe("x".repeat(1000));
  });

  it("cuts a longer one and tells the model how much there was", () => {
    const cut = fitToolResult("a".repeat(50), 20);
    expect(cut.startsWith(`${"a".repeat(20)}\n\n[Cut to 20 of 50 characters`)).toBe(true);
    expect(cut).not.toContain("a".repeat(21));
  });

  it("is what the model is given in a turn", async () => {
    const page: Tool = {
      name: "web_fetch", description: "", parameters: { type: "object", properties: {} },
      destructive: false, run: async () => "p".repeat(500),
    } as unknown as Tool;
    const requests: ChatRequest[] = [];
    let call = 0;
    const model: ChatModel = {
      complete: async (request) => {
        requests.push(structuredClone(request));
        call += 1;
        return call === 1
          ? { content: "", reasoning: "", toolCalls: [{ id: "c1", name: "web_fetch", arguments: "{}" }], finishReason: null }
          : { content: "done", reasoning: "", toolCalls: [], finishReason: "stop" };
      },
    };
    await runTurn({ model, tools: [page], systemPrompt: "", history: [], prompt: "q", maxIterations: 5,
                    maxToolResultChars: 100 });
    const tool = requests[1].messages.at(-1)!;
    expect(tool.role).toBe("tool");
    expect(String(tool.content).startsWith(`${"p".repeat(100)}\n\n[Cut to 100 of 500 characters`)).toBe(true);
  });
});
