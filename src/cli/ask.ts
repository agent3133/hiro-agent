/**
 * `obsidian agent:ask prompt="…"` (#74, M6): one turn of the agent from the terminal, its reply printed when the
 * turn ends. How the Obsidian CLI treats a long command was measured in #71, and shapes this:
 *
 * - The CLI does not time out and shows nothing meanwhile, so the turn runs to its end — or to `timeout=`
 *   (default 10 minutes), where it is stopped and the reply says so.
 * - Ctrl+C ends the terminal, not the turn, which runs on inside Obsidian. So a terminal turn is never invisible
 *   there: a notice says one is running and when it ends, and it is saved as a conversation (`.sessions/`) the
 *   chat's picker can open.
 * - The CLI's exit code is always 0: an error is a line starting with `Error:`, or `ok: false` in `format=json`.
 *
 * Destructive tools (decided 2026-09-29): refused unless the call says `allow=destructive`; then the usual dialog
 * asks in the Obsidian window while the terminal waits — or, with the Developer setting on, the call runs without
 * asking, so a benchmark can run unattended (as `agent:tool`'s confirm flag).
 */

import type { ReadyInfo, TurnChanges, TurnHandlers } from "../api/types";

export const DEFAULT_TIMEOUT_SECONDS = 600;

/** What `agent:ask` needs from the plugin. */
export interface AskHost {
  /** The agents and connections as they are now — read afresh, so an agent file just added is found. */
  info(): ReadyInfo | Promise<ReadyInfo>;
  send(prompt: string, options: { agent?: string; session?: string; profile?: string;
                                  context?: Record<string, unknown>; keep?: boolean }, handlers: TurnHandlers): string;
  cancel(turn: string): void;
  confirm(turn: string, callId: string, approved: boolean): void;
  noteExists(path: string): Promise<boolean>;
  /** The confirmation dialog in the Obsidian window; true lets the tool run. */
  askInObsidian(name: string, input: unknown): Promise<boolean>;
  /** The Developer setting: `allow=destructive` then runs without asking. */
  developer(): boolean;
  notice(text: string): void;
  /** A new conversation's name, from what was asked. */
  sessionName(prompt: string): string;
}

export interface AskParams {
  prompt?: string;
  agent?: string;
  connection?: string;
  note?: string;
  session?: string;
  timeout?: string;
  allow?: string;
  format?: string;
  /** "false": the conversation is not saved (session= still continues it while Obsidian runs). */
  keep?: string;
}

/** One tool call of the turn, as `format=json` reports it — what the benchmark grades (#12). */
export interface AskCall {
  name: string;
  args: unknown;
  result: string;
  error: boolean;
}

/** A tool result longer than this is cut in the JSON answer; the model saw it whole. */
const RESULT_CHARS = 4000;

export interface AskResult {
  ok: boolean;
  reply: string;
  error?: string;
  agent: string;
  connection: string;
  session: string;
  tool_calls: number;
  seconds: number;
  changed: string[];
  /** Destructive tools that were refused, and why. */
  refused: string[];
  /** Destructive tools that ran without anyone being asked (allow=destructive with the Developer setting). */
  unasked: string[];
  /** The turn was stopped at the timeout. */
  stopped: boolean;
  /** Whether the conversation was saved in .sessions/. */
  kept: boolean;
  calls: AskCall[];
}

function failure(error: string): AskResult {
  return { ok: false, reply: "", error, agent: "", connection: "", session: "", tool_calls: 0, seconds: 0, changed: [],
           refused: [], unasked: [], stopped: false, kept: false, calls: [] };
}

/** Runs the turn; never throws — a problem is `ok: false` with the error in words. */
export async function ask(host: AskHost, params: AskParams): Promise<AskResult> {
  const prompt = (params.prompt ?? "").trim();
  if (!prompt) return failure("prompt= is empty: say what the agent should do");
  const info = await host.info();
  const agents = info.agents.map((agent) => agent.name);
  const agent = params.agent || info.agents.find((one) => one.default)?.name || "assistant";
  if (params.agent && !agents.includes(params.agent) && params.agent !== "default") {
    return failure(`there is no agent called '${params.agent}' (there are: ${agents.join(", ")})`);
  }
  // The chat header's rule: a connection named here wins over the agent's own; an unknown one is an error
  const profiles = info.profiles.map((profile) => profile.name);
  if (params.connection && !profiles.includes(params.connection)) {
    return failure(`there is no connection called '${params.connection}' (there are: ${profiles.join(", ") || "none"})`);
  }
  const note = (params.note ?? "").replace(/\\/g, "/").replace(/^\/+/, "");
  if (note && !(await host.noteExists(note))) return failure(`there is no note '${params.note}'`);
  const timeout = params.timeout === undefined ? DEFAULT_TIMEOUT_SECONDS : Number(params.timeout);
  if (!Number.isFinite(timeout) || timeout <= 0) return failure(`timeout= must be a number of seconds, not '${params.timeout}'`);
  if (params.allow && params.allow !== "destructive") {
    return failure(`allow= takes only 'destructive', not '${params.allow}'`);
  }
  const allowDestructive = params.allow === "destructive";
  if (params.keep && params.keep !== "false" && params.keep !== "true") {
    return failure(`keep= takes true or false, not '${params.keep}'`);
  }
  const kept = params.keep !== "false";

  const session = params.session || host.sessionName(prompt);
  const connection = params.connection || "";
  const shown = prompt.length > 60 ? `${prompt.slice(0, 60)}…` : prompt;
  host.notice(`Hiro Agent: a turn from the terminal is running (${agent}) — "${shown}". Ctrl+C in the terminal does not `
              + `stop it; it stops after ${timeout} s at the latest.`);

  const refused: string[] = [];
  const unasked: string[] = [];
  const calls: AskCall[] = [];
  const byId = new Map<string, AskCall>();
  const started = Date.now();
  return new Promise<AskResult>((resolve) => {
    let reply = "";
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (result: Omit<AskResult, "agent" | "connection" | "session" | "refused" | "unasked" | "stopped"
                                  | "seconds" | "kept" | "calls">):
        void => {
      if (timer !== undefined) clearTimeout(timer);
      const seconds = Math.round((Date.now() - started) / 100) / 10;
      host.notice(`Hiro Agent: the turn from the terminal ${stopped ? `was stopped after ${timeout} s` : result.ok ? "is done"
                   : "failed"}${kept ? ` — saved as "${session}"` : ""}.`);
      resolve({ ...result, agent, connection, session, refused, unasked, stopped, seconds, kept, calls });
    };
    const handlers: TurnHandlers = {
      onToken: (text) => { reply += text; },
      onThinking: () => undefined,
      onToolCall: (call) => {
        const made: AskCall = { name: call.name, args: call.input ?? {}, result: "", error: false };
        calls.push(made);
        byId.set(call.callId, made);
      },
      onToolResult: (callId, result, isError) => {
        const made = byId.get(callId);
        if (!made) return;
        made.result = result.length > RESULT_CHARS ? `${result.slice(0, RESULT_CHARS)}…` : result;
        made.error = isError;
      },
      onConfirmRequest: (callId, name, input) => {
        if (!allowDestructive) {
          refused.push(`${name}: refused — a turn from the terminal needs allow=destructive for it`);
          host.confirm(turn, callId, false);
        } else if (host.developer()) {
          // Unattended, as agent:tool's confirm flag — and said in the reply, so it never passes unnoticed
          unasked.push(`${name}: allowed without asking — the Developer setting is on`);
          host.confirm(turn, callId, true);
        } else {
          void host.askInObsidian(name, input).then((yes) => {
            if (!yes) refused.push(`${name}: refused in the Obsidian window`);
            host.confirm(turn, callId, yes);
          });
        }
      },
      onDone: (final, _cancelled, usage, changed: TurnChanges | null) => {
        finish({ ok: true, reply: final || reply, tool_calls: Number(usage.tool_calls ?? 0) || 0,
                 changed: changed?.files ?? [] });
      },
      onError: (message) => finish({ ok: false, reply, error: message, tool_calls: 0, changed: [] }),
    };
    const turn = host.send(prompt, { agent, session, profile: connection || undefined, keep: kept,
                                     context: note ? { active_note: note } : undefined }, handlers);
    timer = setTimeout(() => {
      stopped = true;
      host.cancel(turn);
    }, timeout * 1000);
  });
}

/** The answer as the terminal prints it. */
export function askText(result: AskResult): string {
  if (!result.ok) return `Error: ${result.error}`;
  const notes: string[] = [];
  if (result.stopped) notes.push(`[stopped after the timeout; what was said so far is above]`);
  for (const line of result.refused) notes.push(`[${line}]`);
  for (const line of result.unasked) notes.push(`[${line}]`);
  if (result.changed.length) notes.push(`[changed: ${result.changed.join(", ")}]`);
  notes.push(`[${result.agent}${result.connection ? ` on ${result.connection}` : ""} · ${result.tool_calls} tool calls · `
             + `${result.seconds}s · ${result.kept ? `saved as ${result.session}` : "not saved"}]`);
  return `${result.reply.trim()}\n\n${notes.join("\n")}`;
}

export function renderAsk(result: AskResult, format: string | undefined): string {
  return format === "json" ? JSON.stringify(result, null, 2) : askText(result);
}
