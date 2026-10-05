/**
 * One turn of the agent: the model calls tools until it answers — ported from AgentRunner.run and
 * _make_adaptive_agent (src/obsidian_agent/agent/runner.py).
 *
 * Kept from Python:
 * - with thinking on, the first call thinks and calls after a tool result do not (Qwen otherwise writes its tool
 *   calls inside <think> and the answer comes back empty);
 * - a tool that throws is reported to the model as "Error: <Type>: <message>" (_tool_node), and the third failure
 *   in a row of one tool says so (FailureStreak);
 * - the step limit is max_iterations tool rounds (LangGraph's recursion_limit of 2n+1), ending with Python's note;
 * - a turn whose last call produced only reasoning after tool calls ends with Python's note;
 * - between turns, only the question and the final answer are kept.
 */

import { ArgumentError } from "./errors";
import { ContextOverflowError, textOf, type ChatMessage, type ChatModel, type Completion, type ContentPart, type ToolCallRequest } from "./llm/openaiChat";
import { noteFile } from "./paths";
import type { Tool } from "./tools/tool";

export interface TurnEvents {
  onToken?(text: string): void;
  onThinking?(text: string): void;
  onToolCall?(callId: string, name: string, input: unknown): void;
  onToolResult?(callId: string, result: string, isError: boolean): void;
  /**
   * After each model call: the tokens the conversation takes up now — the request and its answer — as the server
   * counted them, or *estimated* from the characters when it did not say (#151).
   */
  onUsage?(tokens: number, estimated: boolean): void;
  /** Older tool results of this answer were set aside so the next request fits the window (#154); *total* so far. */
  onSetAside?(total: number): void;
  /** After each model call whose server said it: the service tier that served it (#295). */
  onServiceTier?(tier: string): void;
}

/**
 * Room kept free in the window for the answer — its thinking, its text, its next tool call: a request that leaves
 * less sets older tool results aside first (#154). Fixed rather than a share, so a large window is not trimmed long
 * before it is full: 2,048 tokens of 8k is 75 %, 15 % of 32k is 85 %.
 */
export function answerRoom(window: number): number {
  return Math.max(2048, Math.floor(window * 0.15));
}

/** Where a request starts setting older tool results aside. */
export function fitLimit(window: number): number {
  return window - answerRoom(window);
}

/** Down to this share of the fit limit, so it does not happen again at the very next step. */
const SET_ASIDE_TO = 0.8;
/** Past this even so — most of the answer's room gone — the agent answers with what it has, without tools. */
function wrapUpLimit(window: number): number {
  return window - Math.floor(answerRoom(window) * 0.4);
}
/** A tool result shorter than this is not worth setting aside. */
const SET_ASIDE_MIN_CHARS = 300;
/** A new tool result is cut to the room left, but never below this: a result too short to use helps no one. */
const MIN_RESULT_CHARS = 1500;
/** The most a gist of a set-aside result may take, in tokens. */
const GIST_TOKENS = 200;
const SET_ASIDE_MARK = "[Set aside to stay inside the context window:";

/** Said to the model when the window is nearly full: no more tools, answer now. */
export const WRAP_UP_NOTE = "[The context window is nearly full, so no more tools can be used in this answer. "
  + "Answer the request now with what you have found so far, and say plainly what you could not cover.]";

/** What set-aside results keep of what they said: a few lines written by the model, for the user's request. */
export type Gist = (call: string, text: string) => Promise<string>;

/** A Gist asking *model*: what in the result matters for *request*, in a few lines, without thinking. */
export function gistWith(model: ChatModel, request: string, signal?: AbortSignal): Gist {
  return async (call, text) => {
    const prompt = `The user asked: ${request}\n\nBelow is the result of ${call}. It is being set aside to save room. `
      + "Write down what in it matters for the user's request: names, facts, numbers, decisions — one short line per "
      + "note or item, at most 60 words in all. Return only those lines.\n\n" + text;
    const completion = await model.complete({ messages: [{ role: "user", content: prompt }], tools: [], thinking: false,
                                              maxTokens: GIST_TOKENS }, {}, signal);
    return completion.content.trim();
  };
}

/** The estimated tokens of a request: its messages and tool schemas, three characters a token. */
export function estimateRequest(messages: ChatMessage[], tools: unknown[]): number {
  return Math.ceil((JSON.stringify(messages).length + (tools.length ? JSON.stringify(tools).length : 0))
                   / ESTIMATE_CHARS_PER_TOKEN);
}

/**
 * Set the oldest tool results in *messages* aside — their text replaced by a note naming the call and, with *gist*,
 * what they said in a few lines — until *measure* says the request is at most *target*. The newest result is always
 * kept: it is what the model is about to read. Returns how many were set aside.
 */
export async function setAsideToolResults(messages: ChatMessage[], measure: () => number, target: number,
                                          gist?: Gist): Promise<number> {
  const calls = new Map<string, ToolCallRequest>();
  for (const message of messages) {
    if (message.role === "assistant") for (const call of message.tool_calls ?? []) calls.set(call.id, call);
  }
  const results = messages.map((message, index) => ({ message, index }))
    .filter((item): item is { message: Extract<ChatMessage, { role: "tool" }>; index: number } =>
      item.message.role === "tool");
  let count = 0;
  for (const { message, index } of results.slice(0, -1)) {
    if (measure() <= target) break;
    const text = textOf(message.content);
    if (text.startsWith(SET_ASIDE_MARK) || text.length < SET_ASIDE_MIN_CHARS) continue;
    const call = calls.get(message.tool_call_id);
    const what = call ? `${call.name}(${shortArguments(call.arguments)})` : "an earlier tool call";
    // What it said, kept in a few lines, so the agent does not read it all again to remember it
    let kept = "";
    if (gist) {
      try {
        kept = await gist(what, text);
      } catch {
        kept = "";
      }
    }
    messages[index] = { ...message, content: kept
      ? `${SET_ASIDE_MARK} ${what}. What it said, in short:\n${kept}]`
      : `${SET_ASIDE_MARK} ${what}. Call it again if you still need it.]` };
    count += 1;
  }
  return count;
}

function shortArguments(json: string): string {
  try {
    const args = JSON.parse(json) as Record<string, unknown>;
    const text = Object.values(args).filter((value) => typeof value === "string" || typeof value === "number")
      .map(String).join(", ");
    return text.length > 120 ? `${text.slice(0, 117)}…` : text;
  } catch {
    return "";
  }
}

/** Characters per token for an estimate: few, so a meter reads high rather than low in any language. */
const ESTIMATE_CHARS_PER_TOKEN = 3;

/** The tokens a request and its answer take, estimated from their characters when the server does not count. */
export function estimateTokens(messages: ChatMessage[], tools: unknown[], completion: Completion): number {
  const characters = JSON.stringify(messages).length + (tools.length ? JSON.stringify(tools).length : 0)
    + completion.content.length + completion.reasoning.length + JSON.stringify(completion.toolCalls).length;
  return Math.ceil(characters / ESTIMATE_CHARS_PER_TOKEN);
}

export interface TurnOptions {
  model: ChatModel;
  tools: Tool[];
  systemPrompt: string;
  /** Earlier exchanges: user and assistant messages only. */
  history: ChatMessage[];
  prompt: string;
  /** Tool rounds before the turn stops (the agent's max_iterations). */
  maxIterations: number;
  /** undefined: the server's default, no chat_template_kwargs sent. */
  thinking?: boolean;
  events?: TurnEvents;
  signal?: AbortSignal;
  /**
   * Asks the user before a destructive tool runs; true lets it run. Without one, destructive tools refuse — as
   * Python does with no terminal to ask in. There is no "allow from now on": each call is asked (server/ws.py).
   */
  confirm?: Confirm;
  /**
   * The longest tool result, in characters, handed to the model; a longer one is cut, with a note saying so.
   * Python had no such limit, and one long web page could outgrow a 32k context window. Unset: no limit.
   */
  maxToolResultChars?: number;
  /**
   * The model's context window, in tokens. With it, a request that would leave less than answerRoom of it sets the
   * answer's older tool results aside first, so reading many notes does not overflow the window (#154).
   */
  contextWindow?: number;
}

/** What the chat says when a turn fails: in words for a conversation that outgrew the model, else the error. */
export function turnFailure(error: unknown): string {
  if (error instanceof ContextOverflowError) {
    const count = (n: number): string => n.toLocaleString("en-US");
    const sizes = error.promptTokens && error.contextSize
      ? ` It needs ${count(error.promptTokens)} tokens; the model takes ${count(error.contextSize)}.` : "";
    return `This turn no longer fits the model's context window.${sizes} Usually one tool result was too long, `
      + "such as a whole web page or a long note. Try again asking for less, start a new conversation, or "
      + "give the model a larger context window (llama-server's -c).";
  }
  // Node's network errors, which say only a code: what that means for the model server
  const code = (error as { code?: unknown } | null)?.code;
  if (code === "ECONNREFUSED") {
    return "The model server does not answer. Is it running (llama-server for a local connection)? Start it, then "
      + "send the message again.";
  }
  if (code === "ECONNRESET" || code === "EPIPE") {
    return "The connection to the model server broke off in the middle of the answer — usually the server stopped "
      + "or crashed (for llama-server, see its console). Once it runs again, send the message again.";
  }
  if (code === "ETIMEDOUT" || code === "ENOTFOUND" || code === "EAI_AGAIN") {
    return `The model server cannot be reached (${String(code)}). Check the connection's address and the network.`;
  }
  return `The turn failed: ${error instanceof Error ? error.message : String(error)}`;
}

/** What one image costs the window, in tokens, for counting: a page or a frame, as vision models encode them. */
const IMAGE_TOKENS = 1000;

/**
 * A result with images (read_attachment: PDF pages, video frames) fitted to *limit* characters (#160): as many
 * images as the room holds, at least one, the rest named as left out; its words as fitToolResult cuts them.
 */
export function fitContent(parts: ContentPart[], limit: number): ContentPart[] {
  if (!Number.isFinite(limit)) return parts;
  const images = parts.filter((part) => part.type === "image_url").length;
  const room = Math.max(1, Math.floor(limit / ESTIMATE_CHARS_PER_TOKEN / IMAGE_TOKENS));
  if (images <= room) return parts;
  // An image left out goes with the label just before it ("Page 3/40:"), which would otherwise name nothing
  const isLabel = (part: ContentPart | undefined): boolean =>
    part?.type === "text" && /^(Page|Frame) \d+/.test(part.text);
  const kept: ContentPart[] = [];
  const droppedPages: number[] = [];
  let shown = 0;
  parts.forEach((part, index) => {
    if (part.type === "image_url") {
      if (shown < room) kept.push(part);
      shown += 1;
      return;
    }
    const nextIsDropped = isLabel(part) && parts[index + 1]?.type === "image_url" && shown >= room;
    if (!nextIsDropped) kept.push(part);
    const page = nextIsDropped ? /^Page (\d+)/.exec(part.text) : null;
    if (page) droppedPages.push(Number(page[1]));
  });
  kept.push({ type: "text", text: leftOutNote(images - room, room, droppedPages) });
  return kept;
}

/**
 * What fitContent says about the images it left out (#251). For PDF pages it names them and the next call: a model
 * told only "ask for fewer" read the first 8 pages of a 30-page report and answered that the report did not say.
 */
function leftOutNote(dropped: number, room: number, pages: number[]): string {
  if (!pages.length) {
    return `[${dropped} more image(s) left out to stay inside the context window — ask for fewer, e.g. specific pages]`;
  }
  const first = pages[0];
  const last = pages[pages.length - 1];
  const next = `${first}-${Math.min(last, first + room - 1)}`;
  return `[Pages ${first}-${last} left out to stay inside the context window. Read them with pages '${next}' and `
    + "onwards, a few at a time, or read the PDF with as_text, which is far smaller.]";
}

/** *result* cut to *limit* characters, saying so to the model; as it was when it fits. */
export function fitToolResult(result: string, limit?: number): string {
  if (!limit || result.length <= limit) return result;
  return `${result.slice(0, limit)}\n\n[Cut to ${limit} of ${result.length} characters to fit the model's context `
    + "window. Say so if the answer needs the rest, or read a smaller part.]";
}

export type Confirm = (callId: string, name: string, input: Record<string, unknown>) => Promise<boolean>;

export interface TurnResult {
  reply: string;
  toolCalls: number;
  hitStepLimit: boolean;
  /** The history to pass to the next turn. */
  history: ChatMessage[];
}

/** FailureStreak (runner.py): the third consecutive failure of one tool says so. */
export class FailureStreak {
  private failures = new Map<string, number>();

  note(name: string, result: string): string {
    if (!result.startsWith("Error:")) {
      this.failures.set(name, 0);
      return result;
    }
    const count = (this.failures.get(name) ?? 0) + 1;
    this.failures.set(name, count);
    if (count < 3) return result;
    return `${result}\n(Note: ${name} failed ${count} times in a row. Check what the vault `
           + "actually contains, or reach the goal another way.)";
  }
}

export function stepLimitNote(maxIterations: number): string {
  return `[Agent stopped after its limit of ${maxIterations} steps. Changes made so far `
         + "are saved; tell me how to continue, or give a smaller next step.]";
}

/** The answer to a call the user declined: what declining means, not only that it happened (#262). */
export function declined(toolName: string): string {
  return `Error: the user declined to run '${toolName}'. Do not make the same change another way; tell the user `
         + "it was not done.";
}

export const REASONING_ONLY_NOTE ="[Agent stopped: the model produced only reasoning content "
  + "after the last tool call. Try disabling thinking mode (/think) "
  + "or add --reasoning-budget 1024 to your llama-server startup flags.]";

/** The error text Python's ToolNode gives the model for a tool that raised. */
export function toolErrorText(error: unknown): string {
  const type = error instanceof Error ? pythonTypeName(error) : "Exception";
  const message = error instanceof Error ? error.message : String(error);
  return `Error: ${type}: ${message}`;
}

function pythonTypeName(error: Error): string {
  // The closest Python names, so the model reads the same thing from both runtimes. Only arguments that do not fit
  // are a ValidationError, telling the model to fix its call; a TypeError from a bug keeps its name (#174)
  if (error instanceof ArgumentError) return "ValidationError";
  if (error instanceof SyntaxError) return "JSONDecodeError";
  return error.name === "Error" ? "Exception" : error.name;
}

export async function runTurn(options: TurnOptions): Promise<TurnResult> {
  const { model, tools, events = {}, maxIterations, signal } = options;
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const schemas = tools.map(({ name, description, parameters }) => ({ name, description, parameters }));
  const messages: ChatMessage[] = [
    { role: "system", content: options.systemPrompt }, ...options.history, { role: "user", content: options.prompt },
  ];
  const streak = new FailureStreak();

  let finalContent = "";
  let lastCallHadText = false;
  let lastCompletion: Completion | null = null;
  let toolCalls = 0;
  let hitStepLimit = false;
  // The server's count over our estimate, from the last request it counted: estimates are calibrated with it
  let ratio = 1;
  let setAside = 0;
  const window = options.contextWindow;
  const measure = (withTools = true): number => estimateRequest(messages, withTools ? schemas : []) * ratio;
  const gist = gistWith(model, options.prompt, signal);
  let wrapUp = false;

  for (let round = 0; ; round++) {
    signal?.throwIfAborted();
    if (window && round > 0) {
      if (measure() > fitLimit(window)) {
        const count = await setAsideToolResults(messages, measure, fitLimit(window) * SET_ASIDE_TO, gist);
        if (count) {
          setAside += count;
          events.onSetAside?.(setAside);
        }
      }
      // Still too full: the answer now, with what was found, rather than an overflow the next step would hit
      if (measure() > wrapUpLimit(window)) {
        messages.push({ role: "user", content: WRAP_UP_NOTE });
        wrapUp = true;
      }
    }
    const afterTool = messages[messages.length - 1].role === "tool";
    // _make_adaptive_agent: thinking only where no tool result came last; with no tools at all, never
    const thinking = wrapUp ? false : options.thinking ? !afterTool && tools.length > 0 : options.thinking;
    const completion = await model.complete(
      { messages, tools: wrapUp ? [] : schemas, thinking },
      { onContent: events.onToken, onReasoning: events.onThinking },
      signal,
    );
    lastCompletion = completion;
    if (completion.serviceTier) events.onServiceTier?.(completion.serviceTier);
    if (completion.usage?.promptTokens) {
      ratio = Math.min(3, Math.max(0.3, completion.usage.promptTokens / Math.max(1, estimateRequest(messages, schemas))));
    }
    if (events.onUsage) {
      const counted = completion.usage ? completion.usage.promptTokens + completion.usage.completionTokens : undefined;
      events.onUsage(counted ?? estimateTokens(messages, schemas, completion), counted === undefined);
    }
    lastCallHadText = completion.content.length > 0;
    if (lastCallHadText) finalContent = completion.content;
    if (!completion.toolCalls.length || wrapUp) break;
    if (round >= maxIterations) {
      hitStepLimit = true;
      break;
    }

    // A call whose arguments were cut off (the answer ran out of room) goes back as "{}": a server reading the
    // history parses them, and llama.cpp refuses the whole request over one broken call
    const cutOff = new Set(completion.toolCalls.filter((call) => !isJsonObjectText(call.arguments)).map((call) => call.id));
    messages.push({ role: "assistant", content: completion.content,
                    tool_calls: completion.toolCalls.map((call) => (cutOff.has(call.id) ? { ...call, arguments: "{}" } : call)),
                    ...(completion.reasoningItems ? { reasoning_items: completion.reasoningItems } : {}) });
    // Each new result gets its share of the room the window has left, at least MIN_RESULT_CHARS
    const room = window
      ? Math.max(MIN_RESULT_CHARS, Math.floor(((fitLimit(window) - measure()) / Math.max(ratio, 0.1)) * ESTIMATE_CHARS_PER_TOKEN
                                              / completion.toolCalls.length))
      : Infinity;
    const limit = Math.min(options.maxToolResultChars ?? Infinity, room);
    for (const call of completion.toolCalls) {
      signal?.throwIfAborted();
      const output = await callTool(byName, call, events, options.confirm, limit);
      // The failure streak reads the words; a result with images is never a failure
      const noted = streak.note(call.name, textOf(output));
      const result = typeof output === "string" ? fitToolResult(noted, Number.isFinite(limit) ? limit : undefined)
        : fitContent(output, limit);
      toolCalls++;
      events.onToolResult?.(call.id, textOf(result), typeof result === "string" && result.startsWith("Error:"));
      messages.push({ role: "tool", content: result, tool_call_id: call.id });
    }
  }

  let reply: string;
  if (hitStepLimit) {
    const stopped = stepLimitNote(maxIterations);
    reply = finalContent.trim() ? `${finalContent}\n\n${stopped}` : stopped;
  } else if (!lastCallHadText && toolCalls > 0) {
    reply = REASONING_ONLY_NOTE;
  } else {
    reply = finalContent || (lastCompletion?.content.trim() ?? "");
  }
  return {
    reply, toolCalls, hitStepLimit,
    history: [...options.history, { role: "user", content: options.prompt }, { role: "assistant", content: reply }],
  };
}

/** Whether *text* is empty or a JSON object, as tool arguments must be. */
function isJsonObjectText(text: string): boolean {
  if (!text.trim()) return true;
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null && !Array.isArray(value);
  } catch {
    return false;
  }
}

async function callTool(byName: Map<string, Tool>, call: ToolCallRequest, events: TurnEvents,
                        confirm: Confirm | undefined, room = Infinity): Promise<string | ContentPart[]> {
  let input: unknown = call.arguments;
  try {
    input = call.arguments.trim() ? JSON.parse(call.arguments) : {};
  } catch (error) {
    events.onToolCall?.(call.id, call.name, input);
    // Usually the answer ran out of room halfway through the call: say so, so the model asks for less (#154)
    return `${toolErrorText(error)}. The arguments were not complete JSON — probably cut off — so it did not run; `
      + "ask for less at a time, fewer paths in one call, say.";
  }
  events.onToolCall?.(call.id, call.name, input);
  const tool = byName.get(call.name);
  if (!tool) {
    // LangGraph's ToolNode answers an unknown name the same way
    return `Error: ${call.name} is not a valid tool, try one of [${[...byName.keys()].join(", ")}].`;
  }
  try {
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
      throw new ArgumentError("tool arguments must be a JSON object");
    }
    let args = input as Record<string, unknown>;
    if (await asksFirst(tool, args)) {
      // Only the arguments the tool declares, for the dialog and for the run alike: a key the tool does not read
      // could make the dialog name another note than the one that changes — move_note with `path` beside
      // `from_path` — or reach an MCP server unseen (#135)
      // Arguments are checked before the user is asked, as Pydantic does before Python's gate runs — as sent, so a
      // name the tool does not take is an error here too, not dropped (#163)
      tool.validate?.(args);
      args = declaredArgs(tool, args);
      if (!confirm) return `Error: '${tool.name}' requires user confirmation, but no interactive terminal is available.`;
      // Best effort, and only for display: a resolver that fails shows the arguments as they came (runner.py)
      const asked = args;
      const shownArgs = await (tool.confirmArgs?.(asked) ?? Promise.resolve(confirmArgs(asked))).catch(() => asked);
      // Said in full: after a declined update_note, models emptied the note with edit_note and called it done (#262)
      if (!(await confirm(call.id, tool.name, shownArgs))) return declined(tool.name);
    }
    // A tool that fits its own answer gets the room it has (#160); the others are cut afterwards, as before
    if (tool.runWithin && Number.isFinite(room)) return await tool.runWithin(args, room);
    return await (tool.runContent ?? tool.run)(args);
  } catch (error) {
    return toolErrorText(error);
  }
}

/**
 * Whether this call is asked about before it runs: a destructive tool always, and a tool such as create_note when
 * its arguments replace what is there (#157). A check that fails asks rather than lets it through.
 */
export async function asksFirst(tool: Pick<Tool, "destructive" | "destructiveWhen" | "parameters">,
                                args: Record<string, unknown>): Promise<boolean> {
  if (tool.destructive) return true;
  if (!tool.destructiveWhen) return false;
  try {
    return await tool.destructiveWhen(declaredArgs(tool, args));
  } catch {
    return true;
  }
}

/** *args* without the keys *tool*'s schema does not declare; as they came when the schema declares none. */
export function declaredArgs(tool: Pick<Tool, "parameters">, args: Record<string, unknown>): Record<string, unknown> {
  const properties = tool.parameters?.properties;
  if (!properties || !Object.keys(properties).length) return args;
  return Object.fromEntries(Object.entries(args).filter(([key]) => Object.hasOwn(properties, key)));
}

/**
 * The arguments a confirmation names: the note the tool will really touch — `_confirm_args` (vault.py). `note_file`
 * adds the extension, so a dialog asking about 'Scratch' names 'Scratch.md', which is what changes.
 */
export function confirmArgs(args: Record<string, unknown>): Record<string, unknown> {
  const shown = { ...args };
  for (const key of ["path", "from_path", "to_path"]) {
    if (typeof shown[key] === "string") shown[key] = noteFile(shown[key] as string);
  }
  return shown;
}
