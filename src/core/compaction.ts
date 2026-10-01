/**
 * Summarising a conversation by its size in the context window (#154), for one held in memory and — through
 * sessions.ts's compactSession — for one kept in a note. The old exchanges become one summary; the newest that fit
 * in a share of the window stay word for word.
 */

import { ContextOverflowError } from "./llm/openaiChat";
import type { SessionMessage } from "./sessions";

/** Past this share of the window, the conversation is summarised after the answer, or before the next request. */
export const COMPACT_SHARE = 0.6;
/** The newest exchanges kept word for word fit in this share of the window. */
export const KEEP_SHARE = 0.2;
/** What the summariser is given at most, as a share of the window: the rest of the window is for its answer. */
const SUMMARISE_SHARE = 0.5;
/** Characters per token for an estimate: few, so an estimate reads high rather than low in any language. */
export const CHARS_PER_TOKEN = 3;

export const SUMMARY_PREFIX = "Earlier in this session:\n";

export type Pair = [SessionMessage, SessionMessage];

/** The estimated tokens of *messages*' text. */
export function estimateMessages(messages: { content: unknown }[]): number {
  const characters = messages.reduce((sum, message) => sum + (typeof message.content === "string"
    ? message.content.length : JSON.stringify(message.content ?? "").length), 0);
  return Math.ceil(characters / CHARS_PER_TOKEN);
}

/** A history's summary (the system message loadSession puts first) and its question-and-answer pairs. */
export function splitHistory(history: SessionMessage[]): { summary: string | null; pairs: Pair[] } {
  let summary: string | null = null;
  const pairs: Pair[] = [];
  for (let i = 0; i < history.length; i++) {
    const message = history[i];
    if (message.role === "system") {
      const text = String(message.content);
      summary = text.startsWith(SUMMARY_PREFIX) ? text.slice(SUMMARY_PREFIX.length) : text;
    } else if (message.role === "user" && history[i + 1]?.role === "assistant") {
      pairs.push([message, history[i + 1]]);
      i += 1;
    }
  }
  return { summary, pairs };
}

/** How many of the newest *pairs* fit in *budget* tokens — at least the last one, which the next question follows. */
export function recentThatFit(pairs: Pair[], budget: number): number {
  let used = 0;
  let count = 0;
  for (const pair of [...pairs].reverse()) {
    used += estimateMessages(pair);
    if (count > 0 && used > budget) break;
    count += 1;
  }
  return count;
}

/**
 * The summariser's prompt — `compact_if_due`'s wording. With *maxChars*, the oldest of the exchanges are left out
 * so the prompt fits the model: the earlier summary already stands for them in spirit.
 */
export function summaryPrompt(previous: string | null, old: Pair[], maxChars = Infinity): string {
  const lines = old.flatMap(([human, assistant]) => [`<human: ${human.content}>`, `<assistant: ${assistant.content}>`]);
  let conversation = lines.join("\n");
  if (conversation.length > maxChars) {
    conversation = `[The oldest exchanges are left out.]\n${conversation.slice(conversation.length - maxChars)}`;
  }
  const intro = previous
    ? "Below is a summary of the earliest part of a conversation, followed by later exchanges. Write ONE updated "
      + "summary covering both, preserving the important facts from the earlier summary. Focus on:\n"
    : "Summarise the following conversation exchanges concisely. Focus on:\n";
  const earlier = previous ? `Summary of earlier exchanges:\n${previous}\n\n` : "";
  return `${intro}- What the user was trying to accomplish\n- Key facts discovered (file names, values, decisions made)\n`
    + "- Actions taken (notes created/updated, searches performed)\n- Any unresolved questions or follow-ups\n\n"
    + `${earlier}Conversation:\n${conversation}\n\nReturn ONLY the summary text. Be concise — 3 to 10 sentences.`;
}

/** What the summariser may be given for a model with *contextWindow* tokens. */
export function summariseLimit(contextWindow: number): number {
  return Math.floor(contextWindow * SUMMARISE_SHARE * CHARS_PER_TOKEN);
}

/** Whether a conversation that took *tokens* of *contextWindow* is due to be summarised. */
export function dueForCompaction(tokens: number, contextWindow: number): boolean {
  return contextWindow > 0 && tokens > contextWindow * COMPACT_SHARE;
}

/**
 * *history* with its old exchanges summarised: the summary first, then the newest exchanges that fit in
 * KEEP_SHARE of the window. Null when there is nothing old enough to summarise.
 */
export async function compactHistory(history: SessionMessage[], summarize: (prompt: string) => Promise<string>,
                                     contextWindow: number): Promise<{ history: SessionMessage[]; compacted: number } | null> {
  const { summary, pairs } = splitHistory(history);
  const keep = recentThatFit(pairs, Math.floor(contextWindow * KEEP_SHARE));
  const old = pairs.slice(0, pairs.length - keep);
  if (!old.length) return null;
  const text = (await summarize(summaryPrompt(summary, old, summariseLimit(contextWindow)))).trim();
  if (!text) return null;
  return {
    history: [{ role: "system", content: `${SUMMARY_PREFIX}${text}` }, ...pairs.slice(pairs.length - keep).flat()],
    compacted: old.length,
  };
}

/**
 * Run *attempt*; when the conversation outgrew the window before anything ran, *compact* it and run once more
 * (#154). Once a tool has run (*toolsRan*), asking again would run it twice, so the overflow stands; so it does when
 * there was nothing to summarise, or the second attempt overflows too.
 */
export async function retryAfterCompaction<T>(attempt: () => Promise<T>, compact: () => Promise<number>,
                                              toolsRan: () => boolean): Promise<{ result: T; compacted: number }> {
  try {
    return { result: await attempt(), compacted: 0 };
  } catch (error) {
    if (!(error instanceof ContextOverflowError) || toolsRan()) throw error;
    const compacted = await compact();
    if (!compacted) throw error;
    return { result: await attempt(), compacted };
  }
}

