/** The chat's context meter in words (#151) — no Obsidian in here, so it can be tested under Node. */

/**
 * How much of the model's window the conversation takes after an answer: what the next message carries — the
 * system prompt, the questions and the answers, estimated from their length (#154). *peak* is the most the answer
 * took along the way, with the notes and pages it read, which are not kept.
 */
export interface ContextUsage {
  tokens: number;
  window: number;
  estimated: boolean;
  peak?: number;
  /** While an answer runs: *tokens* is what its last request to the model took, with what the agent read. */
  answering?: boolean;
}

/** 12345 → "12.3k", 131072 → "131k". */
export function tokensShort(tokens: number): string {
  if (tokens < 1000) return String(tokens);
  const thousands = tokens / 1000;
  return `${thousands < 100 ? thousands.toFixed(1).replace(/\.0$/, "") : Math.round(thousands)}k`;
}

/**
 * What the meter says and how full it draws: "≈ 12.3k of 32k tokens · 38%", and a level for its colour — orange
 * as the conversation nears the point where it is summarised (60 %), red when it is past that and still growing.
 */
export function contextLine(tokens: number, window: number, estimated: boolean):
    { text: string; share: number; level: "low" | "high" | "full" } {
  const share = window > 0 ? Math.round((tokens / window) * 100) : 0;
  const level = share >= 80 ? "full" : share >= 50 ? "high" : "low";
  return { text: `${estimated ? "≈ " : ""}${tokensShort(tokens)} of ${tokensShort(window)} tokens · ${share}%`, share, level };
}

/** The meter's tooltip. */
export function contextTooltip(usage: ContextUsage): string {
  const share = (tokens: number): number => (usage.window > 0 ? Math.round((tokens / usage.window) * 100) : 0);
  if (usage.answering) {
    return "While the agent answers: how much of the model's context window its last request took, with the notes "
      + "and pages it read" + (usage.estimated ? ", estimated from their length." : ".")
      + " When the answer is done, the meter shows what the conversation keeps.";
  }
  const peak = usage.peak && usage.peak > usage.tokens
    ? ` While answering, the last message took up to ${share(usage.peak)}% (${tokensShort(usage.peak)}) with what `
      + "the agent read; that is not kept."
    : "";
  return "How much of the model's context window this conversation takes: what the next message carries, your "
    + "messages and the agent's answers"
    + (usage.estimated ? ", estimated from their length." : ".")
    + " Past 60% the older part is summarised." + peak;
}
