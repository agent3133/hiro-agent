/**
 * Tool calls and results kept between messages (#332): each answer's, by the answer, beside a conversation's history
 * of questions and answers — never in it, so summarising, going back and the conversation's note work as before.
 */

import type { ChatMessage } from "./llm/openaiChat";

/** What the helpers need of a conversation: its history, and the tool calls and results kept by answer. */
export interface Trails<M extends ChatMessage> {
  loaded: M[];
  trails: Map<M, ChatMessage[]>;
}

/**
 * The history a request sends: with *keep*, each answer preceded by its tool calls and results, where the model
 * left them; otherwise the questions and answers alone.
 */
export function sentHistory<M extends ChatMessage>(conversation: Trails<M>, keep: boolean): ChatMessage[] {
  if (!keep || !conversation.trails.size) return conversation.loaded;
  return conversation.loaded.flatMap((message) => [...(conversation.trails.get(message) ?? []), message]);
}

/**
 * After an answer: its *trail* kept with it, and the results earlier answers left set aside as the request had them
 * (*results*, by call id) — so the next request does not set them aside, and summarise them, again. Trails of answers
 * no longer in the history (summarised, gone back past) are dropped.
 */
export function keepTrail<M extends ChatMessage>(conversation: Trails<M>, answer: M, trail: ChatMessage[],
                                                 results: Map<string, string>): void {
  for (const [kept, messages] of conversation.trails) {
    if (!conversation.loaded.includes(kept)) {
      conversation.trails.delete(kept);
      continue;
    }
    conversation.trails.set(kept, messages.map((message) => (message.role === "tool" && results.has(message.tool_call_id)
      ? { ...message, content: results.get(message.tool_call_id)! } : message)));
  }
  if (trail.length) conversation.trails.set(answer, trail);
}
