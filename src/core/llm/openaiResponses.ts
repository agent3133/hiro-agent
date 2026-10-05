/**
 * OpenAI's Responses API (`/v1/responses`), beside chat completions behind the same ChatModel (#295): OpenAI's
 * current reasoning models take function tools only here.
 *
 * Nothing is stored at OpenAI (`store: false`). The reasoning items of an answer come back encrypted
 * (`include: ["reasoning.encrypted_content"]`) and go with the tool calls' results into the next request, as a
 * reasoning model needs them to carry on; the conversation stays the plugin's.
 */

import {
  type ChatMessage, type ChatModel, type ChatRequest, type Completion, type ContentPart, type Deltas, type LlmSettings,
  type StreamParser, type ToolCallRequest, flexFallback, postStream, serverError,
} from "./openaiChat";

/**
 * OpenAI had no flex capacity for the request. The Responses API says so in the stream, as an `error` event,
 * where chat completions answers HTTP 429.
 */
export class FlexUnavailableError extends Error {
  constructor(readonly body: string) {
    super("Flex processing is unavailable.");
    this.name = "FlexUnavailableError";
  }
}

/** The JSON body of a Responses request; *summary* asks for the reasoning's summary, *encrypted* for its items. */
export function responsesBody(settings: LlmSettings, request: ChatRequest,
                              options: { summary?: boolean; encrypted?: boolean } = {}): Record<string, unknown> {
  const { summary = true, encrypted = true } = options;
  const body: Record<string, unknown> = { model: settings.model, input: request.messages.flatMap(inputItems),
                                          stream: true, store: false };
  if (encrypted) body.include = ["reasoning.encrypted_content"];
  // Strict is the Responses API's default, and it refuses a schema with optional fields: the tools' are not strict
  if (request.tools.length) {
    body.tools = request.tools.map((tool) => ({ type: "function", name: tool.name, description: tool.description,
                                                parameters: tool.parameters, strict: false }));
  }
  const reasoning: Record<string, unknown> = {};
  if (settings.reasoningEffort) reasoning.effort = settings.reasoningEffort;
  if (summary) reasoning.summary = "auto";
  if (Object.keys(reasoning).length) body.reasoning = reasoning;
  const optional: [string, unknown][] = [
    ["temperature", settings.temperature], ["top_p", settings.topP], ["max_output_tokens", settings.maxTokens],
    ["service_tier", settings.serviceTier],
  ];
  for (const [key, value] of optional) if (value !== undefined && value !== null) body[key] = value;
  if (request.maxTokens) body.max_output_tokens = request.maxTokens;
  return body;
}

/** A message as the Responses API's input items: a call and its result are items of their own. */
export function inputItems(message: ChatMessage): unknown[] {
  if (message.role === "tool") {
    return [{ type: "function_call_output", call_id: message.tool_call_id, output: outputOf(message.content) }];
  }
  if (message.role !== "assistant") return [{ role: message.role, content: message.content }];
  const items: unknown[] = [...(message.reasoning_items ?? [])];
  if (message.content) items.push({ role: "assistant", content: message.content });
  for (const call of message.tool_calls ?? []) {
    items.push({ type: "function_call", call_id: call.id, name: call.name, arguments: call.arguments });
  }
  return items;
}

function outputOf(content: string | ContentPart[]): unknown {
  if (typeof content === "string") return content;
  return content.map((part) => (part.type === "text" ? { type: "input_text", text: part.text }
    : { type: "input_image", image_url: part.image_url.url }));
}

interface OutputItem {
  type?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
}

interface EventError {
  message?: string;
  code?: string;
  type?: string;
}

interface ResponsesEvent extends EventError {
  delta?: string;
  output_index?: number;
  summary_index?: number;
  item?: OutputItem;
  /** An `error` event's error: nested in what OpenAI sends, at the top level in its reference. */
  error?: EventError;
  response?: {
    status?: string;
    error?: { message?: string; code?: string } | null;
    incomplete_details?: { reason?: string } | null;
    usage?: { input_tokens?: number; output_tokens?: number } | null;
    service_tier?: string | null;
  };
}

/** Builds a completion from the Responses API's stream events, as they come. */
export class ResponsesBuilder implements StreamParser {
  private content = "";
  private reasoning = "";
  private calls = new Map<number, ToolCallRequest>();
  private reasoningItems: unknown[] = [];
  private finishReason: string | null = null;
  private usage?: { promptTokens: number; completionTokens: number };
  private serviceTier?: string;

  constructor(private readonly deltas: Deltas = {}) {}

  add(payload: string): void {
    if (payload.trim() === "[DONE]") return;
    const event = JSON.parse(payload) as ResponsesEvent;
    switch (event.type) {
      case "response.output_text.delta":
        if (event.delta) {
          this.content += event.delta;
          this.deltas.onContent?.(event.delta);
        }
        break;
      case "response.reasoning_summary_text.delta":
        if (event.delta) {
          this.reasoning += event.delta;
          this.deltas.onReasoning?.(event.delta);
        }
        break;
      case "response.reasoning_summary_part.added":
        // Each part of the summary is a paragraph of its own
        if (this.reasoning) {
          this.reasoning += "\n\n";
          this.deltas.onReasoning?.("\n\n");
        }
        break;
      case "response.output_item.added":
        if (event.item?.type === "function_call") this.call(event).name = event.item.name ?? "";
        break;
      case "response.function_call_arguments.delta":
        if (event.delta) this.call(event).arguments += event.delta;
        break;
      case "response.output_item.done":
        this.itemDone(event);
        break;
      case "response.completed":
      case "response.incomplete":
        this.finish(event);
        break;
      case "response.failed": {
        const error = event.response?.error ?? {};
        throw serverError(error, error.message ?? "The answer failed.");
      }
      case "error": {
        const error = event.error ?? event;
        if (error.code === "flex_unavailable") throw new FlexUnavailableError(JSON.stringify({ error }));
        throw serverError({ message: error.message, code: error.code }, error.message ?? JSON.stringify(event));
      }
      default:
        break;
    }
  }

  /** The call at the event's place in the output, started when it is new. */
  private call(event: ResponsesEvent): ToolCallRequest {
    const index = event.output_index ?? this.calls.size;
    let call = this.calls.get(index);
    if (!call) {
      call = { id: event.item?.call_id ?? "", name: "", arguments: "" };
      this.calls.set(index, call);
    }
    return call;
  }

  /** A finished item: a call complete with its arguments, or a reasoning item to pass back. */
  private itemDone(event: ResponsesEvent): void {
    const item = event.item;
    if (item?.type === "function_call") {
      const call = this.call(event);
      if (item.call_id) call.id = item.call_id;
      if (item.name) call.name = item.name;
      if (typeof item.arguments === "string") call.arguments = item.arguments;
    } else if (item?.type === "reasoning") {
      this.reasoningItems.push(item);
    }
  }

  private finish(event: ResponsesEvent): void {
    const usage = event.response?.usage;
    if (usage && typeof usage.input_tokens === "number") {
      this.usage = { promptTokens: usage.input_tokens, completionTokens: usage.output_tokens ?? 0 };
    }
    if (typeof event.response?.service_tier === "string") this.serviceTier = event.response.service_tier;
    const reason = event.response?.incomplete_details?.reason;
    this.finishReason = event.type === "response.incomplete"
      ? (reason === "max_output_tokens" ? "length" : reason ?? "incomplete")
      : this.calls.size ? "tool_calls" : "stop";
  }

  result(): Completion {
    const toolCalls = [...this.calls.entries()].sort(([a], [b]) => a - b)
      .map(([index, call]) => ({ ...call, id: call.id || `call_${index}` }));
    const completion: Completion = { content: this.content, reasoning: this.reasoning, toolCalls,
                                     finishReason: this.finishReason };
    if (this.usage) completion.usage = this.usage;
    if (this.reasoningItems.length) completion.reasoningItems = this.reasoningItems;
    if (this.serviceTier) completion.serviceTier = this.serviceTier;
    return completion;
  }
}

/** A ChatModel talking to OpenAI's Responses API. */
export class OpenAiResponses implements ChatModel {
  /** Off once the API refused it: a reasoning summary (an organisation not verified for one), encrypted items. */
  private summary = true;
  private encrypted = true;

  constructor(private readonly settings: LlmSettings) {}

  complete(request: ChatRequest, deltas: Deltas, signal?: AbortSignal): Promise<Completion> {
    const asked = { summary: this.summary, encrypted: this.encrypted };
    const body = responsesBody(this.settings, request, asked);
    const host = new URL(this.settings.baseUrl).host;
    const fallback = (fallback: LlmSettings): Promise<Completion> => new OpenAiResponses(fallback).complete(request, deltas, signal);
    const answer = postStream(this.settings, "responses", body, new ResponsesBuilder(deltas), signal, (status, text) => {
      // What this model or account does not offer is asked for no more, and the request sent again without it
      if (status === 400 && asked.summary && /summary/i.test(text)) {
        this.summary = false;
        return this.complete(request, deltas, signal);
      }
      if (status === 400 && asked.encrypted && /encrypted_content|\binclude\b/i.test(text)) {
        this.encrypted = false;
        return this.complete(request, deltas, signal);
      }
      return flexFallback(this.settings, status, text, host, fallback);
    });
    // No flex capacity, said in the stream before anything was answered: as a 429, once more at tier auto
    return answer.catch((error: unknown) => {
      if (!(error instanceof FlexUnavailableError)) throw error;
      const outcome = flexFallback(this.settings, 429, error.body, host, fallback);
      if (outcome instanceof Error) throw outcome;
      return outcome;
    });
  }
}
