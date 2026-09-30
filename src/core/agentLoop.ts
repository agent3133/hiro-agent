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

import { ContextOverflowError, textOf, type ChatMessage, type ChatModel, type Completion, type ContentPart, type ToolCallRequest } from "./llm/openaiChat";
import { noteFile } from "./paths";
import type { Tool } from "./tools/tool";

export interface TurnEvents {
  onToken?(text: string): void;
  onThinking?(text: string): void;
  onToolCall?(callId: string, name: string, input: unknown): void;
  onToolResult?(callId: string, result: string, isError: boolean): void;
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
}

/** What the chat says when a turn fails: in words for a conversation that outgrew the model, else the error. */
export function turnFailure(error: unknown): string {
  if (error instanceof ContextOverflowError) {
    const count = (n: number): string => n.toLocaleString("en-US");
    const sizes = error.promptTokens && error.contextSize
      ? ` It needs ${count(error.promptTokens)} tokens; the model takes ${count(error.contextSize)}.` : "";
    return `This turn no longer fits the model's context window.${sizes} Usually one tool result was too long, `
      + "such as a whole web page or a long note. Try again asking for less, start a new conversation (+), or "
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

export const REASONING_ONLY_NOTE = "[Agent stopped: the model produced only reasoning content "
  + "after the last tool call. Try disabling thinking mode (/think) "
  + "or add --reasoning-budget 1024 to your llama-server startup flags.]";

/** The error text Python's ToolNode gives the model for a tool that raised. */
export function toolErrorText(error: unknown): string {
  const type = error instanceof Error ? pythonTypeName(error) : "Exception";
  const message = error instanceof Error ? error.message : String(error);
  return `Error: ${type}: ${message}`;
}

function pythonTypeName(error: Error): string {
  // The closest Python names, so the model reads the same thing from both runtimes
  if (error instanceof TypeError) return "ValidationError";
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

  for (let round = 0; ; round++) {
    signal?.throwIfAborted();
    const afterTool = messages[messages.length - 1].role === "tool";
    // _make_adaptive_agent: thinking only where no tool result came last; with no tools at all, never
    const thinking = options.thinking ? !afterTool && tools.length > 0 : options.thinking;
    const completion = await model.complete(
      { messages, tools: schemas, thinking },
      { onContent: events.onToken, onReasoning: events.onThinking },
      signal,
    );
    lastCompletion = completion;
    lastCallHadText = completion.content.length > 0;
    if (lastCallHadText) finalContent = completion.content;
    if (!completion.toolCalls.length) break;
    if (round >= maxIterations) {
      hitStepLimit = true;
      break;
    }

    messages.push({ role: "assistant", content: completion.content, tool_calls: completion.toolCalls });
    for (const call of completion.toolCalls) {
      signal?.throwIfAborted();
      const output = await callTool(byName, call, events, options.confirm);
      // The failure streak reads the words; a result with images is never a failure
      const noted = streak.note(call.name, textOf(output));
      const result = typeof output === "string" ? fitToolResult(noted, options.maxToolResultChars) : output;
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

async function callTool(byName: Map<string, Tool>, call: ToolCallRequest, events: TurnEvents,
                        confirm: Confirm | undefined): Promise<string | ContentPart[]> {
  let input: unknown = call.arguments;
  try {
    input = call.arguments.trim() ? JSON.parse(call.arguments) : {};
  } catch (error) {
    events.onToolCall?.(call.id, call.name, input);
    return toolErrorText(error);
  }
  events.onToolCall?.(call.id, call.name, input);
  const tool = byName.get(call.name);
  if (!tool) {
    // LangGraph's ToolNode answers an unknown name the same way
    return `Error: ${call.name} is not a valid tool, try one of [${[...byName.keys()].join(", ")}].`;
  }
  try {
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
      throw new TypeError("tool arguments must be a JSON object");
    }
    const args = input as Record<string, unknown>;
    if (tool.destructive) {
      // Arguments are checked before the user is asked, as Pydantic does before Python's gate runs
      tool.validate?.(args);
      if (!confirm) return `Error: '${tool.name}' requires user confirmation, but no interactive terminal is available.`;
      // Best effort, and only for display: a resolver that fails shows the arguments as they came (runner.py)
      const shownArgs = await (tool.confirmArgs?.(args) ?? Promise.resolve(confirmArgs(args))).catch(() => args);
      if (!(await confirm(call.id, tool.name, shownArgs))) return `Error: the user declined to run '${tool.name}'.`;
    }
    return await (tool.runContent ?? tool.run)(args);
  } catch (error) {
    return toolErrorText(error);
  }
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
