// Which kind of server answers at an address, found out rather than picked (#149). The answers are the shapes each
// server documents: llama.cpp's /props, vLLM's ModelCard, Ollama's /api/version and /api/ps, LM Studio's /api/v0.
import { describe, expect, it } from "vitest";

import { detectConnection, resolveConnection, type ServerCache } from "./connections";
import { apiBase, detectServer, serverRoot, type GetJson } from "./servers";

/** A server where only *answers* answer; anything else throws, as requestUrl does on a 404. */
function server(answers: Record<string, unknown>): { get: GetJson; asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    get: async (url) => {
      asked.push(url);
      if (!(url in answers)) throw new Error("404");
      return answers[url];
    },
  };
}

const LLAMA = "http://127.0.0.1:8080";
const OLLAMA = "http://127.0.0.1:11434";
const VLLM = "http://gpu-box:8000";
const STUDIO = "http://127.0.0.1:1234";

describe("apiBase", () => {
  it("adds /v1 to an address without a path, and keeps any other path", () => {
    expect(apiBase("http://127.0.0.1:8080")).toBe("http://127.0.0.1:8080/v1");
    expect(apiBase("http://127.0.0.1:8080/")).toBe("http://127.0.0.1:8080/v1");
    expect(apiBase("http://127.0.0.1:8080/v1")).toBe("http://127.0.0.1:8080/v1");
    expect(apiBase("https://openrouter.ai/api/v1/")).toBe("https://openrouter.ai/api/v1");
    expect(apiBase("")).toBe("https://api.openai.com/v1");
    expect(serverRoot("http://127.0.0.1:11434/v1")).toBe("http://127.0.0.1:11434");
  });
});

describe("detectServer", () => {
  it("finds llama.cpp by /props: its context window and whether it thinks", async () => {
    const { get } = server({
      [`${LLAMA}/v1/models`]: { object: "list", data: [{ id: "qwen3.6-27b", owned_by: "llamacpp" }] },
      [`${LLAMA}/props`]: { default_generation_settings: { n_ctx: 65536, params: { top_k: 20 } },
                            chat_template_caps: { supports_preserve_reasoning: true } },
    });
    expect(await detectServer(LLAMA, get)).toEqual({ kind: "llama.cpp", models: ["qwen3.6-27b"], contextWindow: 65536,
                                                      thinking: true });
  });

  it("finds vLLM by its model cards, with the chosen model's max_model_len", async () => {
    const { get, asked } = server({
      [`${VLLM}/v1/models`]: { object: "list", data: [
        { id: "Qwen/Qwen3-8B", object: "model", owned_by: "vllm", max_model_len: 32768 },
        { id: "lora-notes", object: "model", owned_by: "vllm", root: "Qwen/Qwen3-8B", max_model_len: 16384 },
      ] },
    });
    expect(await detectServer(VLLM, get, "lora-notes")).toEqual({ kind: "vLLM", models: ["Qwen/Qwen3-8B", "lora-notes"],
                                                                  contextWindow: 16384 });
    expect(asked).toEqual([`${VLLM}/v1/models`]);  // nothing else asked once it is known
  });

  it("finds Ollama by /api/version, with the loaded model's context_length from /api/ps", async () => {
    const { get } = server({
      [`${OLLAMA}/v1/models`]: { object: "list", data: [{ id: "qwen3:14b" }, { id: "gemma3:12b" }] },
      [`${OLLAMA}/api/version`]: { version: "0.12.3" },
      [`${OLLAMA}/api/ps`]: { models: [{ name: "gemma3:12b", model: "gemma3:12b", context_length: 8192 }] },
    });
    expect(await detectServer(OLLAMA, get, "gemma3:12b"))
      .toEqual({ kind: "Ollama", models: ["qwen3:14b", "gemma3:12b"], contextWindow: 8192 });
  });

  it("gives an Ollama model that is not loaded the small default window", async () => {
    const { get } = server({
      [`${OLLAMA}/v1/models`]: { object: "list", data: [{ id: "qwen3:14b" }] },
      [`${OLLAMA}/api/version`]: { version: "0.5.1" },
      [`${OLLAMA}/api/ps`]: { models: [] },
    });
    expect((await detectServer(OLLAMA, get)).contextWindow).toBe(4096);
  });

  it("finds LM Studio by /api/v0/models: the loaded window, else at most the usual default", async () => {
    const models = { object: "list", data: [{ id: "qwen2-vl-7b-instruct" }, { id: "phi-4" }] };
    const loaded = server({
      [`${STUDIO}/v1/models`]: models,
      [`${STUDIO}/api/v0/models`]: { object: "list", data: [
        { id: "qwen2-vl-7b-instruct", type: "vlm", state: "not-loaded", max_context_length: 32768 },
        { id: "phi-4", type: "llm", state: "loaded", max_context_length: 16384, loaded_context_length: 12000 },
      ] },
    });
    expect(await detectServer(STUDIO, loaded.get, "phi-4"))
      .toEqual({ kind: "LM Studio", models: ["qwen2-vl-7b-instruct", "phi-4"], contextWindow: 12000 });
    expect((await detectServer(STUDIO, loaded.get, "qwen2-vl-7b-instruct")).contextWindow).toBe(4096);
  });

  it("calls anything else an ordinary API, keeping what it lists", async () => {
    const { get } = server({ "https://openrouter.ai/api/v1/models": { data: [{ id: "a/b" }] } });
    expect(await detectServer("https://openrouter.ai/api/v1", get)).toEqual({ models: ["a/b"] });
    expect(await detectServer("http://127.0.0.1:9", server({}).get)).toEqual({ models: [] });
  });

  it("does not ask OpenAI itself anything", async () => {
    const { get, asked } = server({});
    expect(await detectServer("", get)).toEqual({ models: [] });
    expect(asked).toEqual([]);
  });
});

describe("detectConnection", () => {
  const values = (base_url: string, model = "") => ({ llm_profiles: { x: { base_url, model } } });

  it("fills the server's model, window and kind into the connection", async () => {
    const { get } = server({
      [`${OLLAMA}/v1/models`]: { data: [{ id: "qwen3:14b" }] },
      [`${OLLAMA}/api/version`]: { version: "0.12.3" },
      [`${OLLAMA}/api/ps`]: { models: [{ name: "qwen3:14b", context_length: 32768 }] },
    });
    const connection = await detectConnection(resolveConnection(values(OLLAMA), "x", () => undefined), get);
    expect(connection).toMatchObject({ server: "Ollama", baseUrl: `${OLLAMA}/v1`, model: "qwen3:14b",
                                       contextWindow: 32768 });
  });

  it("keeps an ordinary API's configured window, and names no kind", async () => {
    const resolved = resolveConnection({ llm_profiles: { x: { base_url: "https://api.example.com/v1", model: "m",
                                                              context_window: 200000 } } }, "x", () => undefined);
    const connection = await detectConnection(resolved, server({}).get);
    expect(connection.server).toBeUndefined();
    expect(connection.contextWindow).toBe(200000);
  });

  it("asks a server again only after a while", async () => {
    const { get, asked } = server({ [`${LLAMA}/props`]: { default_generation_settings: { n_ctx: 8192 } } });
    const cache: ServerCache = new Map();
    const resolved = resolveConnection(values(LLAMA), "x", () => undefined);
    await detectConnection(resolved, get, cache, 0);
    const once = asked.length;
    await detectConnection(resolved, get, cache, 60_000);
    expect(asked.length).toBe(once);
    await detectConnection(resolved, get, cache, 10 * 60_000);
    expect(asked.length).toBe(2 * once);
  });
});

describe("resolveConnection's address", () => {
  it("is OpenAI's when empty, and a stored llama.cpp connection without one has none", () => {
    expect(resolveConnection({ llm_profiles: { x: {} } }, "x", () => undefined).baseUrl).toBe("https://api.openai.com/v1");
    expect(resolveConnection({ llm_profiles: { x: { provider: "llamacpp" } } }, "x", () => undefined).baseUrl).toBe("");
  });
});
