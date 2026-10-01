// `obsidian agent:ask` (#74): checks before the turn, the turn's reply, destructive tools, the timeout.
import { afterEach, describe, expect, it, vi } from "vitest";

import type { TurnHandlers } from "../api/types";
import { ask, askText, renderAsk, type AskHost, type AskParams } from "./ask";

interface Fake {
  host: AskHost;
  sent: { prompt: string; options: Record<string, unknown> }[];
  handlers: () => TurnHandlers;
  confirmed: [string, boolean][];
  cancelled: string[];
  asked: string[];
  notices: string[];
}

/** A host whose agent does nothing until the test drives its handlers. */
function fake(options: { developer?: boolean; answerInObsidian?: boolean; notes?: string[] } = {}): Fake {
  const made: Fake = { sent: [], confirmed: [], cancelled: [], asked: [], notices: [], handlers: () => current!,
                       host: undefined as unknown as AskHost };
  let current: TurnHandlers | undefined;
  made.host = {
    info: () => ({ protocol: 0, version: "0.3.0", vault: "v", model: "",
                   agents: [{ name: "assistant", default: true }, { name: "research" }],
                   profiles: [{ name: "local" }, { name: "cloud" }], defaultProfile: "local" }),
    send: (prompt, sendOptions, handlers) => {
      made.sent.push({ prompt, options: sendOptions });
      current = handlers;
      return "t1";
    },
    cancel: (turn) => {
      made.cancelled.push(turn);
      current?.onDone("", true, {}, null, 0);  // as InProcessAgent does for a stopped turn
    },
    confirm: (_turn, callId, approved) => { made.confirmed.push([callId, approved]); },
    noteExists: async (path) => (options.notes ?? ["Notes/a.md"]).includes(path),
    askInObsidian: async (name) => {
      made.asked.push(name);
      return options.answerInObsidian ?? false;
    },
    developer: () => options.developer ?? false,
    notice: (text) => { made.notices.push(text); },
    sessionName: () => "2026-09-29-1200-do-it",
  };
  return made;
}

/** Starts `ask` and lets its checks run, so the turn has been sent; the answer comes wrapped, not awaited. */
async function started(made: Fake, params: AskParams) {
  const answer = ask(made.host, params);
  await vi.waitFor(() => expect(made.sent.length).toBe(1));
  return { answer };
}

afterEach(() => { vi.useRealTimers(); });

describe("agent:ask, before the turn", () => {
  it.each([
    [{ prompt: "  " }, "prompt= is empty"],
    [{ prompt: "x", agent: "nope" }, "there is no agent called 'nope' (there are: assistant, research)"],
    [{ prompt: "x", connection: "nope" }, "there is no connection called 'nope' (there are: local, cloud)"],
    [{ prompt: "x", note: "Missing.md" }, "there is no note 'Missing.md'"],
    [{ prompt: "x", timeout: "soon" }, "timeout= must be a number of seconds, not 'soon'"],
    [{ prompt: "x", allow: "everything" }, "allow= takes only 'destructive', not 'everything'"],
    [{ prompt: "x", keep: "no" }, "keep= takes true or false, not 'no'"],
  ])("refuses %o, saying why, and sends nothing", async (params, error) => {
    const made = fake();
    const result = await ask(made.host, params);
    expect(result.ok).toBe(false);
    expect(result.error).toContain(error);
    expect(askText(result)).toBe(`Error: ${result.error}`);
    expect(made.sent).toEqual([]);
    expect(made.notices).toEqual([]);
  });
});

describe("agent:ask, the turn", () => {
  it("runs the default agent in a new saved conversation, with the note as context, and prints the reply", async () => {
    const made = fake();
    const { answer } = await started(made, { prompt: "Summarise it", note: "Notes/a.md", connection: "cloud" });
    expect(made.sent[0]).toEqual({ prompt: "Summarise it", options: {
      agent: "assistant", session: "2026-09-29-1200-do-it", profile: "cloud", keep: true,
      context: { active_note: "Notes/a.md" } } });
    made.handlers().onToken("Sum");
    made.handlers().onDone("Summary.", false, { tool_calls: 2 }, { turn: "t1", files: ["Notes/a.md"] }, 0);
    const result = await answer;
    expect(result).toMatchObject({ ok: true, reply: "Summary.", agent: "assistant", connection: "cloud",
                                   session: "2026-09-29-1200-do-it", tool_calls: 2, changed: ["Notes/a.md"], stopped: false });
    expect(askText(result).startsWith("Summary.\n\n[changed: Notes/a.md]\n[assistant on cloud · 2 tool calls · ")).toBe(true);
    expect(made.notices[0]).toContain("a request from the terminal is running (assistant)");
    expect(made.notices[0]).toContain("Ctrl+C in the terminal does not stop it");
    expect(made.notices[1]).toContain('is done — saved as "2026-09-29-1200-do-it"');
  });

  it("continues a named conversation, and prints what streamed when the reply comes empty", async () => {
    const made = fake();
    const { answer } = await started(made, { prompt: "more", session: "old-one", agent: "research" });
    expect(made.sent[0].options).toMatchObject({ agent: "research", session: "old-one" });
    made.handlers().onToken("partial answer");
    made.handlers().onDone("", false, {}, null, 0);
    expect((await answer).reply).toBe("partial answer");
  });

  it("reports a failed turn as an error, keeping what was said", async () => {
    const made = fake();
    const { answer } = await started(made, { prompt: "x" });
    made.handlers().onError("The model server does not answer.", true);
    const result = await answer;
    expect(result).toMatchObject({ ok: false, error: "The model server does not answer." });
    expect(askText(result)).toBe("Error: The model server does not answer.");
    expect(made.notices[1]).toContain("failed");
  });

  it("stops the turn at the timeout and says so", async () => {
    vi.useFakeTimers();
    const made = fake();
    const answer = ask(made.host, { prompt: "x", timeout: "5" });
    await vi.advanceTimersByTimeAsync(0);
    made.handlers().onToken("half");
    await vi.advanceTimersByTimeAsync(5_000);
    const result = await answer;
    expect(made.cancelled).toEqual(["t1"]);
    expect(result).toMatchObject({ ok: true, stopped: true, reply: "half" });
    expect(askText(result)).toContain("[stopped after the timeout; what was said so far is above]");
    expect(made.notices[1]).toContain("was stopped after 5 s");
  });

  it("with keep=false keeps the conversation in memory under its name, but saves nothing, and says so", async () => {
    const made = fake();
    const { answer } = await started(made, { prompt: "x", session: "bench-R2", keep: "false" });
    expect(made.sent[0].options).toMatchObject({ session: "bench-R2", keep: false });
    made.handlers().onDone("ok", false, { tool_calls: 0 }, null, 0);
    const result = await answer;
    expect(result.kept).toBe(false);
    expect(askText(result)).toContain("· not saved]");
    expect(made.notices[1]).not.toContain("saved as");
  });

  it("reports each tool call with its arguments, result and whether it failed, in the JSON answer", async () => {
    const made = fake();
    const { answer } = await started(made, { prompt: "x" });
    made.handlers().onToolCall({ callId: "c1", name: "read_note", input: { path: "a.md" } });
    made.handlers().onToolCall({ callId: "c2", name: "find_notes", input: { pattern: "b" } });
    made.handlers().onToolResult("c2", "Error: nothing", true);
    made.handlers().onToolResult("c1", "x".repeat(5000), false);
    made.handlers().onDone("ok", false, { tool_calls: 2 }, null, 0);
    const calls = JSON.parse(renderAsk(await answer, "json")).calls;
    expect(calls.map((call: { name: string }) => call.name)).toEqual(["read_note", "find_notes"]);
    expect(calls[0]).toMatchObject({ args: { path: "a.md" }, error: false });
    expect(calls[0].result).toBe(`${"x".repeat(4000)}…`);
    expect(calls[1]).toMatchObject({ args: { pattern: "b" }, result: "Error: nothing", error: true });
  });

  it("answers JSON for format=json", async () => {
    const made = fake();
    const { answer } = await started(made, { prompt: "x" });
    made.handlers().onDone("ok", false, { tool_calls: 0 }, null, 0);
    expect(JSON.parse(renderAsk(await answer, "json"))).toMatchObject({ ok: true, reply: "ok", refused: [] });
  });
});

describe("agent:ask, destructive tools", () => {
  it("refuses them without allow=destructive, and the reply says so", async () => {
    const made = fake();
    const { answer } = await started(made, { prompt: "delete it" });
    made.handlers().onConfirmRequest("c1", "delete_note", { path: "a.md" });
    made.handlers().onDone("I could not delete it.", false, {}, null, 0);
    const result = await answer;
    expect(made.confirmed).toEqual([["c1", false]]);
    expect(made.asked).toEqual([]);
    expect(askText(result)).toContain("[delete_note: refused — a request from the terminal needs allow=destructive for it]");
  });

  it("with allow=destructive, asks in the Obsidian window and does what the user answers", async () => {
    const yes = fake({ answerInObsidian: true });
    const { answer } = await started(yes, { prompt: "delete it", allow: "destructive" });
    yes.handlers().onConfirmRequest("c1", "delete_note", {});
    await vi.waitFor(() => expect(yes.confirmed).toEqual([["c1", true]]));
    yes.handlers().onDone("done", false, {}, null, 0);
    expect((await answer).refused).toEqual([]);
    expect(yes.asked).toEqual(["delete_note"]);

    const no = fake({ answerInObsidian: false });
    const { answer: refused } = await started(no, { prompt: "delete it", allow: "destructive" });
    no.handlers().onConfirmRequest("c1", "delete_note", {});
    await vi.waitFor(() => expect(no.confirmed).toEqual([["c1", false]]));
    no.handlers().onDone("not done", false, {}, null, 0);
    expect((await refused).refused).toEqual(["delete_note: refused in the Obsidian window"]);
  });

  it("with allow=destructive and the Developer setting, runs them without asking — for unattended runs", async () => {
    const made = fake({ developer: true });
    const { answer } = await started(made, { prompt: "delete it", allow: "destructive" });
    made.handlers().onConfirmRequest("c1", "delete_note", {});
    made.handlers().onDone("deleted", false, {}, null, 0);
    const result = await answer;
    expect(made.confirmed).toEqual([["c1", true]]);
    expect(made.asked).toEqual([]);
    // Never unnoticed: the reply says the dialog was skipped, and why
    expect(result.unasked).toEqual(["delete_note: allowed without asking — the Developer setting is on"]);
    expect(askText(result)).toContain("[delete_note: allowed without asking — the Developer setting is on]");
  });

  it("with the Developer setting but no allow=destructive, still refuses them", async () => {
    const made = fake({ developer: true });
    const { answer } = await started(made, { prompt: "delete it" });
    made.handlers().onConfirmRequest("c1", "delete_note", {});
    made.handlers().onDone("no", false, {}, null, 0);
    await answer;
    expect(made.confirmed).toEqual([["c1", false]]);
  });
});
