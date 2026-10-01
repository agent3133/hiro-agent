// Ported from tests/test_session_memory.py — session notes: saving, loading within a token budget, summaries,
// compaction and connection marks (#85). Python's HumanMessage/AIMessage/SystemMessage are messages with the roles
// "user", "assistant" and "system"; the LLM that compacts is a `summarize(prompt)` function.
import { describe, expect, it } from "vitest";

import {
  compactSession, listSessions, loadSession, saveSession, sessionMeta, sessionPath, type SessionMessage,
} from "./sessions";
import { makeVault } from "./testing/vault";

const SUMMARY_START = "<!-- session-summary -->";
const SUMMARY_END = "<!-- /session-summary -->";
const H = (content: string): SessionMessage => ({ role: "user", content });
const A = (content: string): SessionMessage => ({ role: "assistant", content });

/** `_make_session_text`: a minimal session note from (human, assistant) pairs. */
function makeSessionText(pairs: [string, string][], summary: string | null = null): string {
  const parts = ["---\nsession: test\nagent: default\nmodel: m\ncreated: 2026-01-01T00:00:00\nupdated: 2026-01-01T00:00:00\nexchanges: 0\n---\n"];
  if (summary !== null) parts.push(`\n${SUMMARY_START}\n${summary}\n${SUMMARY_END}\n`);
  for (const [h, a] of pairs) {
    parts.push(`\n<!-- session-message: human -->\n${h}\n`, `\n<!-- session-message: assistant -->\n${a}\n`);
  }
  return parts.join("");
}

/** `_write_session`: the note written as is, as `.sessions/<name>.md`. */
function sessionNote(name: string, content: string): Record<string, string> {
  return { [`.sessions/${name}.md`]: content };
}

/** The mocked LLM: answers every prompt with *summary*, and keeps the prompts it was given. */
function summarizer(summary: string): ((prompt: string) => Promise<string>) & { prompts: string[] } {
  const prompts: string[] = [];
  return Object.assign(async (prompt: string) => {
    prompts.push(prompt);
    return summary;
  }, { prompts });
}

describe("test_session_memory.py", () => {
  it("test_compact_rewrites_file", async () => {
    const pairs = Array.from({ length: 15 }, (_, i) => [`q${i}`, `a${i}`] as [string, string]);
    const vault = await makeVault(sessionNote("test", makeSessionText(pairs)));
    const compacted = await compactSession(vault.vault, "test", summarizer("Compacted summary."), 10);
    expect(compacted).toBe(5);
    const text = await vault.read(sessionPath("test"));
    expect(text).toContain(SUMMARY_START);
    expect(text).toContain("Compacted summary.");
    expect(text).toContain(SUMMARY_END);
  });

  it("keeps the note as it was when the summary comes back empty (#154)", async () => {
    const pairs = Array.from({ length: 15 }, (_, i) => [`q${i}`, `a${i}`] as [string, string]);
    const vault = await makeVault(sessionNote("test", makeSessionText(pairs)));
    const before = await vault.read(sessionPath("test"));
    expect(await compactSession(vault.vault, "test", summarizer("  "), 10)).toBe(0);
    expect(await vault.read(sessionPath("test"))).toBe(before);
  });

  it("test_save_session_connection_marker", async () => {
    const vault = await makeVault();
    await saveSession(vault.vault, "s1", [H("a"), A("b"), H("c"), A("d")], {
      agent: "default", model: "gpt", connection: "cloud",
      connections: [{ exchange: 1, connection: "local", model: "qwen" }, { exchange: 2, connection: "cloud", model: "gpt" }],
    });
    const text = await vault.read(sessionPath("s1"));
    const marker = "<!-- session-connection: cloud · gpt -->";
    expect(text.split(marker).length - 1).toBe(1);
    const first = text.indexOf("<!-- session-message: human -->");
    const second = text.indexOf("<!-- session-message: human -->", first + 1);
    expect(first < text.indexOf(marker) && text.indexOf(marker) < second).toBe(true);
  });

  it("test_no_budget_returns_all_messages", async () => {
    const pairs = Array.from({ length: 5 }, (_, i) => [`q${i}`, `a${i}`] as [string, string]);
    const vault = await makeVault(sessionNote("test", makeSessionText(pairs)));
    const messages = await loadSession(vault.vault, "test");
    expect(messages.length).toBe(10);
  });

  it("test_budget_zero_returns_empty", async () => {
    const pairs = [["hello", "world"]] as [string, string][];
    const vault = await makeVault(sessionNote("test", makeSessionText(pairs)));
    const messages = await loadSession(vault.vault, "test", 0);
    expect(messages.every(m => m.role === "system")).toBe(true);
  });

  it("test_budget_keeps_newest_messages", async () => {
    const pairs = Array.from({ length: 10 }, (_, i) => [`q${i}`, `a${i}`] as [string, string]);
    const vault = await makeVault(sessionNote("test", makeSessionText(pairs)));
    const budget = 8;
    const messages = await loadSession(vault.vault, "test", budget);
    expect(messages.length).toBeGreaterThanOrEqual(2);
    const lastHuman = [...messages].reverse().find(m => m.role === "user");
    expect(lastHuman).toBeDefined();
    expect(lastHuman!.content).toBe("q9");
  });

  it("test_budget_larger_than_total_returns_all", async () => {
    const pairs = [["hi", "hello"]] as [string, string][];
    const vault = await makeVault(sessionNote("test", makeSessionText(pairs)));
    const messages = await loadSession(vault.vault, "test", 100_000);
    expect(messages.length).toBe(2);
  });

  it("test_budget_none_is_backward_compatible", async () => {
    const pairs = [["a", "b"], ["c", "d"]] as [string, string][];
    const vault = await makeVault(sessionNote("test", makeSessionText(pairs)));
    const allMsgs = await loadSession(vault.vault, "test", undefined as any);
    const sameMsgs = await loadSession(vault.vault, "test");
    expect(allMsgs.length).toBe(sameMsgs.length);
    expect(allMsgs.length).toBe(4);
  });

  it("test_summary_block_produces_system_message_first", async () => {
    const content = makeSessionText([["q", "a"]], "This is a summary.");
    const vault = await makeVault(sessionNote("test", content));
    const messages = await loadSession(vault.vault, "test");
    expect(messages[0].role).toBe("system");
    expect(messages[0].content).toContain("This is a summary.");
    expect(messages[0].content).toContain("Earlier in this session:");
  });

  it("test_summary_plus_regular_messages", async () => {
    const pairs: [string, string][] = [["q1", "a1"], ["q2", "a2"]];
    const content = makeSessionText(pairs, "Summary here.");
    const vault = await makeVault(sessionNote("test", content));
    const messages = await loadSession(vault.vault, "test");
    expect(messages.length).toBe(5);
    expect(messages[0].role).toBe("system");
    expect(messages[1].role).toBe("user");
  });

  it("test_no_summary_block_no_system_message", async () => {
    const content = makeSessionText([["q", "a"]]);
    const vault = await makeVault(sessionNote("test", content));
    const messages = await loadSession(vault.vault, "test");
    expect(messages.some(m => m.role === "system")).toBe(false);
  });

  it("test_summary_with_token_budget_summary_always_included", async () => {
    const pairs: [string, string][] = Array.from({ length: 5 }, (_, i) => [`q${i}`, `a${i}`] as [string, string]);
    const content = makeSessionText(pairs, "Key facts: XYZ.");
    const vault = await makeVault(sessionNote("test", content));
    const messages = await loadSession(vault.vault, "test", 1);
    const sysMsgs = messages.filter(m => m.role === "system");
    expect(sysMsgs.length).toBeGreaterThan(0);
    const sysMsg = sysMsgs[0];
    expect(sysMsg.content).toContain("Key facts: XYZ.");
  });

  it("test_compact_keeps_recent_verbatim", async () => {
    const pairs: [string, string][] = Array.from({ length: 12 }, (_, i) => [`question${i}`, `answer${i}`] as [string, string]);
    const content = makeSessionText(pairs);
    const vault = await makeVault(sessionNote("test", content));
    const sum = summarizer("Brief summary.");
    await compactSession(vault.vault, "test", sum, 10);
    const messages = await loadSession(vault.vault, "test");
    const humanMsgs = messages.filter(m => m.role === "user");
    expect(humanMsgs.length).toBe(10);
    const expected = Array.from({ length: 10 }, (_, i) => `question${i + 2}`);
    expect(humanMsgs.map(m => m.content)).toEqual(expected);
  });

  it("test_compact_returns_zero_when_nothing_to_compact", async () => {
    const pairs: [string, string][] = [["a", "b"], ["c", "d"]];
    const vault = await makeVault(sessionNote("test", makeSessionText(pairs)));
    const sum = summarizer("Whatever.");
    const result = await compactSession(vault.vault, "test", sum, 10);
    expect(result).toBe(0);
    expect(sum.prompts.length).toBe(0);  // the LLM is not asked
  });

  it("test_compact_adds_frontmatter_keys", async () => {
    const pairs: [string, string][] = Array.from({ length: 12 }, (_, i) => [`q${i}`, `a${i}`] as [string, string]);
    const vault = await makeVault(sessionNote("test", makeSessionText(pairs)));
    const sum = summarizer("Summary text.");
    await compactSession(vault.vault, "test", sum, 10);
    const text = await vault.read(sessionPath("test"));
    const fmMatch = text.match(/^---\n(.*?)\n---\n/s);
    expect(fmMatch).not.toBeNull();
    const fmLines = fmMatch![1];
    expect(fmLines).toContain("compacted_at:");
    expect(fmLines).toContain("compacted_exchanges: 2");
  });

  it("test_compact_loads_summary_after_rewrite", async () => {
    const pairs: [string, string][] = Array.from({ length: 12 }, (_, i) => [`q${i}`, `a${i}`] as [string, string]);
    const vault = await makeVault(sessionNote("test", makeSessionText(pairs)));
    const sum = summarizer("Important summary.");
    await compactSession(vault.vault, "test", sum, 10);
    const messages = await loadSession(vault.vault, "test");
    expect(messages[0].role).toBe("system");
    expect(messages[0].content).toContain("Important summary.");
  });

  it("test_compact_folds_previous_summary_into_prompt", async () => {
    const pairs: [string, string][] = Array.from({ length: 12 }, (_, i) => [`q${i}`, `a${i}`] as [string, string]);
    const vault = await makeVault(sessionNote("test", makeSessionText(pairs, "User is planning a trip to Oslo.")));
    const sum = summarizer("Merged summary.");
    await compactSession(vault.vault, "test", sum, 10);
    expect(sum.prompts.length).toBe(1);
    const prompt = sum.prompts[0];
    expect(prompt).toContain("User is planning a trip to Oslo.");
    expect(prompt).toContain("q0");
    const text = await vault.read(sessionPath("test"));
    expect(text.split(SUMMARY_START).length - 1).toBe(1);
    expect(text).toContain("Merged summary.");
  });

  it("test_second_compaction_receives_first_summary", async () => {
    const pairs: [string, string][] = Array.from({ length: 12 }, (_, i) => [`q${i}`, `a${i}`] as [string, string]);
    const vault = await makeVault(sessionNote("test", makeSessionText(pairs)));
    await compactSession(vault.vault, "test", summarizer("First summary."), 10);

    const messages: SessionMessage[] = (await loadSession(vault.vault, "test")).filter((m) => m.role !== "system");
    for (let i = 12; i < 15; i++) messages.push(H(`q${i}`), A(`a${i}`));
    await saveSession(vault.vault, "test", messages, { agent: "default", model: "m" });

    const sum2 = summarizer("Second summary.");
    const compacted = await compactSession(vault.vault, "test", sum2, 10);
    expect(compacted).toBe(3);
    expect(sum2.prompts.length).toBe(1);
    const prompt = sum2.prompts[0];
    expect(prompt).toContain("First summary.");
    expect(prompt).not.toContain("q0");
  });

  it("test_save_preserves_summary_block", async () => {
    const pairs = Array.from({ length: 12 }, (_, i) => [`q${i}`, `a${i}`] as [string, string]);
    const vault = await makeVault(sessionNote("test", makeSessionText(pairs)));
    const llm = summarizer("The summary.");
    await compactSession(vault.vault, "test", llm, 10);

    const messages = await loadSession(vault.vault, "test");
    const humanAi = messages.filter(m => m.role !== "system");
    humanAi.push(H("new question"));
    humanAi.push(A("new answer"));

    await saveSession(vault.vault, "test", humanAi, { agent: "default", model: "model-x" });

    const text = await vault.read(sessionPath("test"));
    expect(text).toContain(SUMMARY_START);
    expect(text).toContain("The summary.");
    expect(text).toContain(SUMMARY_END);
  });

  it("test_save_without_prior_summary_writes_no_summary", async () => {
    const vault = await makeVault();
    const messages = [H("hi"), A("hello")];
    await saveSession(vault.vault, "test", messages, { agent: "default", model: "model" });

    const text = await vault.read(sessionPath("test"));
    expect(text).not.toContain(SUMMARY_START);
  });

  it("test_save_preserves_compacted_frontmatter_keys", async () => {
    const pairs = Array.from({ length: 12 }, (_, i) => [`q${i}`, `a${i}`] as [string, string]);
    const vault = await makeVault(sessionNote("test", makeSessionText(pairs)));
    await compactSession(vault.vault, "test", summarizer("Summary."), 10);

    const messages = [H("x"), A("y")];
    await saveSession(vault.vault, "test", messages, { agent: "default", model: "model" });

    const text = await vault.read(sessionPath("test"));
    const fmMatch = text.match(/^---\n(.*?)\n---\n/s);
    expect(fmMatch).toBeTruthy();
    const fmYaml = fmMatch![1];
    expect(fmYaml).toContain("compacted_at");
    expect(fmYaml).toContain("compacted_exchanges");
  });

  it("test_load_session_ignores_connection_marker", async () => {
    const vault = await makeVault();
    await saveSession(vault.vault, "s1", [H("a"), A("b"), H("c"), A("d")], {
      agent: "default", model: "gpt", connection: "cloud",
      connections: [
        { exchange: 1, connection: "local", model: "qwen" },
        { exchange: 2, connection: "cloud", model: "gpt" },
      ],
    });

    const messages = await loadSession(vault.vault, "s1");
    expect(messages.length).toBe(4);
    for (const msg of messages) {
      const content = typeof msg.content === "string" ? msg.content : "";
      expect(content).not.toContain("session-connection");
    }
  });

  it("test_session_meta_connection_and_connections", async () => {
    const vault = await makeVault();
    await saveSession(vault.vault, "s1", [H("a"), A("b")], {
      agent: "default", model: "gpt", connection: "cloud",
      connections: [
        { exchange: 1, connection: "local", model: "qwen" },
        { exchange: 2, connection: "cloud", model: "gpt" },
      ],
    });

    const meta = await sessionMeta(vault.vault, "s1");
    expect(meta["connection"]).toBe("cloud");
    expect(meta["model"]).toBe("gpt");
    expect(meta).toHaveProperty("connections");
    expect((meta["connections"] as unknown[]).length).toBe(2);

    expect(await sessionMeta(vault.vault, "missing")).toEqual({});
  });

  it("test_list_sessions_includes_connection", async () => {
    const vault = await makeVault();
    await saveSession(vault.vault, "s1", [H("a"), A("b")], {
      agent: "default", model: "gpt", connection: "cloud",
      connections: [{ exchange: 1, connection: "local", model: "qwen" }, { exchange: 2, connection: "cloud", model: "gpt" }],
    });
    const sessions = await listSessions(vault.vault);
    const s1Entry = sessions.find(s => s.name === "s1") ?? null;
    expect(s1Entry).not.toBeNull();
    expect(s1Entry!.connection).toBe("cloud");
  });
});


