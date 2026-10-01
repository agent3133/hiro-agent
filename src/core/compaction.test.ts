// Summarising a conversation by its size in the context window, not after 50 exchanges (#154).
import { describe, expect, it } from "vitest";

import {
  compactHistory, dueForCompaction, estimateMessages, recentThatFit, retryAfterCompaction, splitHistory, summaryPrompt,
  SUMMARY_PREFIX, type Pair,
} from "./compaction";
import { ContextOverflowError } from "./llm/openaiChat";
import type { SessionMessage } from "./sessions";

const H = (content: string): SessionMessage => ({ role: "user", content });
const A = (content: string): SessionMessage => ({ role: "assistant", content });

/** *n* exchanges of about *chars* characters each side. */
function exchanges(n: number, chars = 30): SessionMessage[] {
  return Array.from({ length: n }, (_, i) => [H(`q${i} ${"x".repeat(chars)}`), A(`a${i} ${"y".repeat(chars)}`)]).flat();
}

function summarizer(text: string): ((prompt: string) => Promise<string>) & { prompts: string[] } {
  const prompts: string[] = [];
  return Object.assign(async (prompt: string) => {
    prompts.push(prompt);
    return text;
  }, { prompts });
}

describe("dueForCompaction", () => {
  it("is due past 60% of the window, whatever the number of exchanges", () => {
    expect(dueForCompaction(19_000, 32_768)).toBe(false);
    expect(dueForCompaction(20_000, 32_768)).toBe(true);
    expect(dueForCompaction(20_000, 0)).toBe(false);
  });
});

describe("splitHistory and recentThatFit", () => {
  it("reads the summary and the pairs from a loaded history", () => {
    const { summary, pairs } = splitHistory([{ role: "system", content: `${SUMMARY_PREFIX}Before.` }, ...exchanges(2)]);
    expect(summary).toBe("Before.");
    expect(pairs).toHaveLength(2);
  });

  it("keeps the newest pairs that fit the budget, and always the last one", () => {
    const { pairs } = splitHistory(exchanges(10, 297));  // about 200 tokens a pair at three characters a token
    expect(recentThatFit(pairs, 650)).toBe(3);
    expect(recentThatFit(pairs, 10)).toBe(1);
    expect(recentThatFit([] as Pair[], 100)).toBe(0);
  });
});

describe("compactHistory (a conversation held in memory)", () => {
  it("summarises the old exchanges and keeps the newest that fit in a fifth of the window", async () => {
    const history = exchanges(10, 297);  // ~200 tokens a pair; a 3000-token window keeps 600 → 3 pairs
    const summarize = summarizer("They talked about q0 to q6.");
    const done = await compactHistory(history, summarize, 3000);
    expect(done?.compacted).toBe(7);
    expect(done?.history[0]).toEqual({ role: "system", content: `${SUMMARY_PREFIX}They talked about q0 to q6.` });
    expect(done?.history.slice(1).map((m) => String(m.content).slice(0, 2))).toEqual(["q7", "a7", "q8", "a8", "q9", "a9"]);
    expect(summarize.prompts[0]).toContain("<human: q0");
    expect(summarize.prompts[0]).not.toContain("<human: q7");
  });

  it("folds an earlier summary into the new one", async () => {
    const summarize = summarizer("Updated.");
    await compactHistory([{ role: "system", content: `${SUMMARY_PREFIX}Earlier facts.` }, ...exchanges(10, 297)],
                         summarize, 3000);
    expect(summarize.prompts[0]).toContain("Summary of earlier exchanges:\nEarlier facts.");
  });

  it("does nothing when everything fits, or the summary comes back empty", async () => {
    expect(await compactHistory(exchanges(2), summarizer("x"), 100_000)).toBeNull();
    expect(await compactHistory(exchanges(10, 297), summarizer("  "), 3000)).toBeNull();
  });

  it("gives the summariser at most half the window, leaving out the oldest", () => {
    const old = splitHistory(exchanges(50, 300)).pairs;
    const prompt = summaryPrompt(null, old, 3000);
    expect(prompt).toContain("[The oldest exchanges are left out.]");
    expect(prompt).not.toContain("<human: q0 ");
    expect(prompt).toContain("q49");
    expect(prompt.length).toBeLessThan(3000 + 800);
  });
});

describe("retryAfterCompaction (a request that no longer fits)", () => {
  const overflow = () => new ContextOverflowError("the request exceeds the available context size", 40_000, 32_768);

  it("summarises and asks once more when nothing has run yet", async () => {
    let calls = 0;
    const out = await retryAfterCompaction(async () => {
      calls += 1;
      if (calls === 1) throw overflow();
      return "answer";
    }, async () => 7, () => false);
    expect(out).toEqual({ result: "answer", compacted: 7 });
    expect(calls).toBe(2);
  });

  it("does not ask again once a tool has run, so no tool runs twice", async () => {
    let compactions = 0;
    await expect(retryAfterCompaction(async () => { throw overflow(); }, async () => ++compactions, () => true))
      .rejects.toBeInstanceOf(ContextOverflowError);
    expect(compactions).toBe(0);
  });

  it("fails as before when there is nothing to summarise, or it overflows again", async () => {
    await expect(retryAfterCompaction(async () => { throw overflow(); }, async () => 0, () => false))
      .rejects.toBeInstanceOf(ContextOverflowError);
    let calls = 0;
    await expect(retryAfterCompaction(async () => { calls += 1; throw overflow(); }, async () => 3, () => false))
      .rejects.toBeInstanceOf(ContextOverflowError);
    expect(calls).toBe(2);
  });

  it("passes other errors through untouched", async () => {
    await expect(retryAfterCompaction(async () => { throw new Error("ECONNREFUSED"); }, async () => 3, () => false))
      .rejects.toThrow("ECONNREFUSED");
  });
});

describe("estimateMessages", () => {
  it("counts three characters a token", () => {
    expect(estimateMessages([{ content: "x".repeat(300) }, { content: "y".repeat(3) }])).toBe(101);
  });
});
