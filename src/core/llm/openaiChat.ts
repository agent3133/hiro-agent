/**
 * A small streaming client for OpenAI-compatible chat completions (llama.cpp, vLLM, OpenAI), without a dependency.
 *
 * It goes over Node's http/https, which Obsidian's desktop app and Node both have: Obsidian's requestUrl cannot
 * stream, and the renderer's fetch is blocked cross-origin (see plugin/src/api/http.ts).
 *
 * Thinking arrives as `reasoning_content` deltas (docs/thinking-model-streaming.md); tool calls arrive in pieces,
 * keyed by `index`.
 */

import * as http from "node:http";
import * as https from "node:https";

import { certificateAuthorities } from "../tlsTrust";

export interface ToolCallRequest {
  id: string;
  name: string;
  /** The arguments as the model wrote them: JSON, not yet parsed. */
  arguments: string;
}

/** Part of a message that carries more than text: an image, as a data URL (OpenAI's content-part shape). */
export type ContentPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };

export type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string; tool_calls?: ToolCallRequest[];
      /** The Responses API's reasoning items for these calls, passed back with their results (#295); opaque. */
      reasoning_items?: unknown[] }
  | { role: "tool"; content: string | ContentPart[]; tool_call_id: string };

/** What a tool result says in words — images shown as a marker — for the chat view and the failure streak. */
export function textOf(content: string | ContentPart[]): string {
  if (typeof content === "string") return content;
  return content.map((part) => (part.type === "text" ? part.text : "[image]")).join("\n");
}

export interface ToolSchema {
  name: string;
  description: string;
  parameters: object;
}

/** The conversation is longer than the model can take in one request. */
export class ContextOverflowError extends Error {
  constructor(message: string, readonly promptTokens?: number, readonly contextSize?: number) {
    super(message);
    this.name = "ContextOverflowError";
  }
}

/** An error body as servers send it: llama.cpp's `exceed_context_size_error`, OpenAI's `context_length_exceeded`. */
interface ServerError {
  message?: string;
  type?: string;
  code?: string | number;
  n_prompt_tokens?: number;
  n_ctx?: number;
}

/** *error* as an Error: a ContextOverflowError when the server says the request does not fit. */
export function serverError(error: ServerError, message: string): Error {
  const overflow = error.type === "exceed_context_size_error" || error.code === "context_length_exceeded"
    || /context (size|length|window)/i.test(error.message ?? "");
  return overflow ? new ContextOverflowError(message, error.n_prompt_tokens, error.n_ctx) : new Error(message);
}

/**
 * A failed request's answer as an Error a person can read: the server's own message rather than its JSON, and for
 * a refused key, where the key is set.
 */
export function httpError(status: number, host: string, body: string): Error {
  let error: ServerError | undefined;
  try {
    const parsed = JSON.parse(body) as { error?: ServerError | string };
    error = typeof parsed.error === "string" ? { message: parsed.error } : parsed.error ?? undefined;
  } catch {
    // not JSON: the status and the text say what there is to say
  }
  if (!error || typeof error !== "object") return new Error(`${host} answered HTTP ${status}: ${body.slice(0, 300)}`);
  // OpenAI names the key it refused as sk-proj-****…****abcd: the stars say nothing
  const said = (error.message ?? "").replace(/\*{4,}/g, "…").slice(0, 300);
  if (status === 401 || status === 403) {
    return new Error(`${host} did not accept the API key (HTTP ${status}${said ? `: ${said}` : ""}). Check the key `
      + "this connection names in Obsidian's keychain (Settings → Keychain).");
  }
  return serverError(error, `${host} answered HTTP ${status}${said ? `: ${said}` : ""}`);
}

/** A flex request refused (HTTP 429), as a person reads it: what happened and the two ways on. */
export function flexRefused(host: string, body: string): Error {
  const said = httpError(429, host, body).message;
  return new Error(`${host} refused the request at the flex service tier (HTTP 429): it has no flex capacity right `
    + "now, or a rate limit was reached. Send the message again later, or turn on Service tier fallback in the "
    + `connection's settings (Settings → Hiro Agent → Connections), which uses tier auto at the normal price. (${said})`);
}

/**
 * How long a server may stay silent (#179): before its first byte — llama.cpp sends nothing while it reads a long
 * prompt, which can take minutes on a small machine — and between two chunks once it has started.
 */
export const FIRST_BYTE_TIMEOUT_MS = 10 * 60_000;
export const IDLE_TIMEOUT_MS = 2 * 60_000;

/** The connection and the sampling settings Python's `_sampling_kwargs` sends (runner.py). */
export interface LlmSettings {
  /** Silence allowed before the first byte and between chunks; FIRST_BYTE_TIMEOUT_MS and IDLE_TIMEOUT_MS unless set. */
  timeouts?: { firstByteMs: number; idleMs: number };
  baseUrl: string;
  model: string;
  apiKey?: string;
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  presencePenalty?: number;
  topK?: number;
  minP?: number;
  repetitionPenalty?: number;
  /** OpenAI's `service_tier` — flex at about half the price, priority faster; not sent when unset. */
  serviceTier?: string;
  /** Send a flex request OpenAI refuses for capacity (HTTP 429) once more with tier auto. */
  serviceTierFallback?: boolean;
  /** OpenAI's `reasoning_effort` for a reasoning model; not sent when unset. */
  reasoningEffort?: string;
  /** A line for the plugin's log: a flex request sent again at tier auto is said there (#295). */
  log?: (line: string) => void;
}

/** How long a flex request may wait for its first byte: OpenAI asks for up to 15 minutes. */
export const FLEX_FIRST_BYTE_TIMEOUT_MS = 15 * 60_000;

export interface ChatRequest {
  messages: ChatMessage[];
  tools: ToolSchema[];
  /** llama.cpp's chat_template_kwargs.enable_thinking; left out when undefined. */
  thinking?: boolean;
  /** The most tokens this answer may take, over the connection's own max_tokens: a gist is short (#154). */
  maxTokens?: number;
}

export interface Completion {
  content: string;
  reasoning: string;
  toolCalls: ToolCallRequest[];
  finishReason: string | null;
  /** Tokens the request and the answer took, when the server said (#151). */
  usage?: { promptTokens: number; completionTokens: number };
  /** The Responses API's reasoning items, which go back with the tool calls' results (#295). */
  reasoningItems?: unknown[];
  /** The service tier OpenAI says served the answer — flex, or default after a fallback — when it says (#295). */
  serviceTier?: string;
}

export interface Deltas {
  onContent?(text: string): void;
  onReasoning?(text: string): void;
}

/** What the agent loop needs from a model: one streamed completion. Tests pass a scripted one. */
export interface ChatModel {
  complete(request: ChatRequest, deltas: Deltas, signal?: AbortSignal): Promise<Completion>;
}

/**
 * The JSON body of a chat completion request. *streamUsage* asks for the tokens used in the stream's last chunk
 * (OpenAI's `stream_options`), for the chat's context meter (#151).
 */
export function requestBody(settings: LlmSettings, request: ChatRequest, streamUsage = true): Record<string, unknown> {
  const body: Record<string, unknown> = { model: settings.model, messages: request.messages.map(wireMessage),
                                          stream: true };
  if (streamUsage) body.stream_options = { include_usage: true };
  if (request.tools.length) {
    body.tools = request.tools.map((tool) => ({ type: "function", function: tool }));
  }
  const optional: [string, unknown][] = [
    ["temperature", settings.temperature], ["max_tokens", settings.maxTokens], ["top_p", settings.topP],
    ["presence_penalty", settings.presencePenalty],
    // llama.cpp / vLLM extensions, which Python sends through extra_body
    ["top_k", settings.topK], ["min_p", settings.minP], ["repetition_penalty", settings.repetitionPenalty],
    ["service_tier", settings.serviceTier], ["reasoning_effort", settings.reasoningEffort],
  ];
  for (const [key, value] of optional) if (value !== undefined && value !== null) body[key] = value;
  if (request.maxTokens) body.max_tokens = request.maxTokens;
  if (request.thinking !== undefined) body.chat_template_kwargs = { enable_thinking: request.thinking };
  return body;
}

function wireMessage(message: ChatMessage): Record<string, unknown> {
  if (message.role === "assistant" && message.tool_calls?.length) {
    return {
      role: "assistant", content: message.content,
      tool_calls: message.tool_calls.map((call) => ({ id: call.id, type: "function",
                                                       function: { name: call.name, arguments: call.arguments } })),
    };
  }
  // Reasoning items are the Responses API's: a chat completions server does not know them
  if (message.role === "assistant") return { role: "assistant", content: message.content };
  return message;
}

/** Splits a server-sent-events stream into its `data:` payloads, across chunk boundaries. */
export class SseDecoder {
  private buffer = "";

  push(text: string): string[] {
    this.buffer += text;
    const payloads: string[] = [];
    let end: number;
    while ((end = this.buffer.search(/\r?\n\r?\n/)) >= 0) {
      const event = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end).replace(/^\r?\n\r?\n/, "");
      const data = event.split(/\r?\n/).filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).replace(/^ /, ""));
      if (data.length) payloads.push(data.join("\n"));
    }
    return payloads;
  }

  /** Whatever is left when the stream closes without a final blank line. */
  flush(): string[] {
    const rest = this.buffer;
    this.buffer = "";
    return rest.trim() ? this.push(`${rest}\n\n`) : [];
  }
}

/** Builds a completion from the stream's chunks, as they come. */
export class CompletionBuilder {
  private content = "";
  private reasoning = "";
  private calls = new Map<number, ToolCallRequest>();
  private finishReason: string | null = null;
  private usage?: { promptTokens: number; completionTokens: number };
  private serviceTier?: string;
  done = false;

  constructor(private readonly deltas: Deltas = {}) {}

  /** One `data:` payload; "[DONE]" ends the stream. */
  add(payload: string): void {
    if (payload.trim() === "[DONE]") {
      this.done = true;
      return;
    }
    const chunk = JSON.parse(payload) as { choices?: ChunkChoice[]; error?: ServerError; usage?: ChunkUsage | null;
                                           timings?: ChunkTimings; service_tier?: string | null };
    if (chunk.error) throw serverError(chunk.error, chunk.error.message ?? JSON.stringify(chunk.error));
    if (typeof chunk.service_tier === "string") this.serviceTier = chunk.service_tier;
    this.takeUsage(chunk.usage, chunk.timings);
    for (const choice of chunk.choices ?? []) {
      const delta = choice.delta ?? {};
      if (typeof delta.reasoning_content === "string" && delta.reasoning_content) {
        this.reasoning += delta.reasoning_content;
        this.deltas.onReasoning?.(delta.reasoning_content);
      }
      if (typeof delta.content === "string" && delta.content) {
        this.content += delta.content;
        this.deltas.onContent?.(delta.content);
      }
      for (const piece of delta.tool_calls ?? []) {
        const index = piece.index ?? this.calls.size;
        const call = this.calls.get(index) ?? { id: "", name: "", arguments: "" };
        if (piece.id) call.id = piece.id;
        if (piece.function?.name) call.name += piece.function.name;
        if (piece.function?.arguments) call.arguments += piece.function.arguments;
        this.calls.set(index, call);
      }
      if (choice.finish_reason) this.finishReason = choice.finish_reason;
    }
  }

  /** OpenAI's `usage`, or else llama.cpp's `timings` (sent without being asked): what the request took. */
  private takeUsage(usage: ChunkUsage | null | undefined, timings: ChunkTimings | undefined): void {
    if (usage && typeof usage.prompt_tokens === "number") {
      this.usage = { promptTokens: usage.prompt_tokens, completionTokens: usage.completion_tokens ?? 0 };
    } else if (!this.usage && timings && typeof timings.prompt_n === "number") {
      this.usage = { promptTokens: timings.prompt_n + (timings.cache_n ?? 0), completionTokens: timings.predicted_n ?? 0 };
    }
  }

  result(): Completion {
    const toolCalls = [...this.calls.entries()].sort(([a], [b]) => a - b)
      .map(([index, call]) => ({ ...call, id: call.id || `call_${index}` }));
    const completion: Completion = { content: this.content, reasoning: this.reasoning, toolCalls,
                                     finishReason: this.finishReason };
    if (this.usage) completion.usage = this.usage;
    if (this.serviceTier) completion.serviceTier = this.serviceTier;
    return completion;
  }
}

interface ChunkUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
}

/** llama.cpp's own counts: tokens processed now, taken from its cache, and generated. */
interface ChunkTimings {
  prompt_n?: number;
  cache_n?: number;
  predicted_n?: number;
}

interface ChunkChoice {
  delta?: {
    content?: string | null;
    reasoning_content?: string | null;
    tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[];
  };
  finish_reason?: string | null;
}

/** A ChatModel talking to an OpenAI-compatible server. */
export class OpenAiChat implements ChatModel {
  /** Whether to ask for usage in the stream; off for a server that refused `stream_options` once (#151). */
  private streamUsage = true;

  constructor(private readonly settings: LlmSettings) {}

  complete(request: ChatRequest, deltas: Deltas, signal?: AbortSignal): Promise<Completion> {
    const asked = this.streamUsage;
    const body = requestBody(this.settings, request, asked);
    return postStream(this.settings, "chat/completions", body, new CompletionBuilder(deltas), signal, (status, text, host) => {
      // A strict server that does not know stream_options: ask again without it, and from now on
      if (asked && status === 400 && /stream_options/i.test(text)) {
        this.streamUsage = false;
        return this.complete(request, deltas, signal);
      }
      return flexFallback(this.settings, status, text, host,
                          (fallback) => new OpenAiChat(fallback).complete(request, deltas, signal));
    });
  }
}

/** What a wire format makes of a stream: its `data:` payloads in, a completion out. */
export interface StreamParser {
  add(payload: string): void;
  result(): Completion;
}

/**
 * A refused request (HTTP 400 and up), seen by the client that sent it: an answer got another way — the request
 * asked again differently — or the error to fail with.
 */
export type Refusal = (status: number, text: string, host: string) => Promise<Completion> | Error;

/**
 * A flex request OpenAI refused for capacity (HTTP 429): once more at tier auto through *again* when the
 * connection allows it, else said plainly. Any other refusal is the server's own error.
 */
export function flexFallback(settings: LlmSettings, status: number, text: string, host: string,
                             again: (fallback: LlmSettings) => Promise<Completion>): Promise<Completion> | Error {
  if (settings.serviceTier === "flex" && status === 429) {
    if (settings.serviceTierFallback) {
      settings.log?.(`${host} had no flex capacity for a request; sent again at service tier auto.`);
      return again({ ...settings, serviceTier: "auto", serviceTierFallback: false });
    }
    return flexRefused(host, text);
  }
  return httpError(status, host, text);
}

/**
 * POSTs *payload* to *path* under the connection's address and streams the answer through *parser*: the transport,
 * the key and the timeouts both wire formats share.
 */
export function postStream(settings: LlmSettings, path: string, payload: Record<string, unknown>, parser: StreamParser,
                           signal: AbortSignal | undefined, refused: Refusal): Promise<Completion> {
  const url = new URL(`${settings.baseUrl.replace(/\/+$/, "")}/${path}`);
  const body = JSON.stringify(payload);
  const transport = url.protocol === "https:" ? https : http;
  const headers: Record<string, string | number> = {
    "Content-Type": "application/json", Accept: "text/event-stream",
    "Content-Length": new TextEncoder().encode(body).byteLength,
  };
  if (settings.apiKey) headers.Authorization = `Bearer ${settings.apiKey}`;

  const flex = settings.serviceTier === "flex";
  const { firstByteMs, idleMs } = settings.timeouts
    ?? { firstByteMs: flex ? FLEX_FIRST_BYTE_TIMEOUT_MS : FIRST_BYTE_TIMEOUT_MS, idleMs: IDLE_TIMEOUT_MS };
  return new Promise((resolve, reject) => {
    // A server that stops sending ends the answer with a message, instead of leaving the chat waiting (#179)
    let timer: ReturnType<typeof setTimeout> | undefined;
    const quiet = (ms: number, what: string): void => {
      clearTimeout(timer);
      timer = setTimeout(() => req.destroy(new Error(
        `${url.host} ${what} for ${Math.round(ms / 1000)} seconds, so the answer was stopped. Is the model server `
        + "still running?")), ms);
    };
    const done = (): void => clearTimeout(timer);
    // A connection of its own per request (agent: false). Node's default agent keeps connections alive, and a
    // request sent right after the last response — a tool that answers at once — reused the socket llama-server
    // was closing, and the turn died with ECONNRESET.
    // The system's certificates too, as requestUrl trusts them: a reverse proxy with one's own CA (#113)
    const ca = url.protocol === "https:" ? certificateAuthorities() : undefined;
    const req = transport.request(url, { method: "POST", headers, signal, agent: false, ...(ca ? { ca } : {}) }, (res) => {
      res.setEncoding("utf-8");
      quiet(idleMs, "sent nothing more");
      if ((res.statusCode ?? 0) >= 400) {
        let text = "";
        res.on("data", (part: string) => (text += part));
        res.on("end", () => {
          done();
          const outcome = refused(res.statusCode ?? 0, text, url.host);
          if (outcome instanceof Error) reject(outcome);
          else resolve(outcome);
        });
        return;
      }
      const decoder = new SseDecoder();
      const take = (payloads: string[]): boolean => {
        try {
          for (const payload of payloads) parser.add(payload);
          return true;
        } catch (error) {
          req.destroy();
          reject(error);
          return false;
        }
      };
      res.on("data", (part: string) => {
        quiet(idleMs, "sent nothing more");
        void take(decoder.push(part));
      });
      res.on("end", () => {
        done();
        if (take(decoder.flush())) resolve(parser.result());
      });
      res.on("error", (error) => {
        done();
        reject(error);
      });
    });
    req.on("error", (error) => {
      done();
      reject(error);
    });
    quiet(firstByteMs, "did not start answering");
    req.end(body);
  });
}
