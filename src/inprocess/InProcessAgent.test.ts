// The in-plugin agent (#368): a message through InProcessAgent on the obsidian stub's App, against a fake model server.
import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { makeApp, type TestApp } from "../testing/obsidian";

import type { TurnChanges, TurnHandlers } from "../api/types";
import { AgentCatalog } from "../config/agents";
import { NO_CONNECTION } from "../config/connections";
import { DeviceApprovals } from "../config/deviceApprovals";
import type { SavedJournal } from "../core/journal";
import { obsidianVault } from "../vault/obsidianVault";
import { toolsetOptions } from "../vault/toolset";
import { InProcessAgent, type InProcessSource } from "./InProcessAgent";

// web_fetch reaches no internet here: every page is given back as its address, so a test sees the page reached the model
vi.mock("../core/publicFetch", () => ({
  fetchPublic: async (url: string) => ({ status: 200, url, contentType: "text/plain", text: `page at ${url}`,
                                         cut: false, size: null, binary: false }),
}));

/** The tokens one model call reports, as the server counts them (a final usage chunk, as OpenAI and llama.cpp send). */
interface Usage {
  input: number;
  output: number;
}

/**
 * One answer of the fake server: text, or one tool call. `wait` holds the answer back that many ms; `usage`, when
 * given, is what the server reports for the call — none when it is left out, as a server that does not count.
 */
type Reply = ({ text: string; wait?: number } | { tool: string; args: Record<string, unknown> }) & { usage?: Usage };

let server: Server | null = null;
let test: TestApp | null = null;

/** A chat-completions server that streams *replies* in order, one per request; what it was sent, in `bodies`. */
async function fakeModel(replies: Reply[]): Promise<{ url: string; bodies: Record<string, unknown>[] }> {
  const bodies: Record<string, unknown>[] = [];
  server = createServer((req, res) => {
    let text = "";
    req.on("data", (part) => (text += part));
    req.on("end", () => {
      bodies.push(JSON.parse(text) as Record<string, unknown>);
      const reply = replies.shift() ?? { text: "(no more replies)" };
      // Each tool call has its own id, as a model's do: one answer may call tools several times
      const callId = `call_${bodies.length}`;
      const send = (): void => {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        const chunk = (body: unknown): string => `data: ${JSON.stringify(body)}\n\n`;
        const counted = reply.usage
          ? chunk({ choices: [], usage: { prompt_tokens: reply.usage.input, completion_tokens: reply.usage.output } })
          : "";
        if ("tool" in reply) {
          res.write(chunk({ choices: [{ delta: { tool_calls: [{ index: 0, id: callId, type: "function",
            function: { name: reply.tool, arguments: JSON.stringify(reply.args) } }] }, finish_reason: null }] }));
          res.end(chunk({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }) + counted + "data: [DONE]\n\n");
        } else {
          res.write(chunk({ choices: [{ delta: { content: reply.text }, finish_reason: null }] }));
          res.end(chunk({ choices: [{ delta: {}, finish_reason: "stop" }] }) + counted + "data: [DONE]\n\n");
        }
      };
      if ("wait" in reply && reply.wait) setTimeout(send, reply.wait);
      else send();
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, bodies };
}

/**
 * The agent on *test*'s app, with *values* as its settings (no connection unless they name one). *extra* replaces
 * what the source gives: a journal store, or a log to read.
 */
function agentOn(app: TestApp["app"], values: Record<string, unknown>, extra: Partial<InProcessSource> = {}): InProcessAgent {
  const catalog = new AgentCatalog(obsidianVault(app as never, { record: false }),
                                   () => ({ defaultAgent: "assistant", profiles: [], configDir: ".obsidian" }));
  const source = {
    catalog,
    backend: { info: () => ({}) },
    values: () => values,
    env: () => undefined,
    fetchJson: () => Promise.reject(new Error("not a llama.cpp server")),
    mcp: { agentTools: async () => ({ tools: [], failures: [] }), knownTools: () => [] },
    deviceApprovals: { approved: () => true },
    log: () => undefined,
    ...extra,
  } as unknown as InProcessSource;
  return new InProcessAgent(app as never, source, async () => toolsetOptions({ values }));
}

/** A confirmation the dialog was asked: the tool and the arguments it would show. */
interface Asked {
  name: string;
  input: Record<string, unknown>;
}

/** The user's answer to a confirmation: approved, and "Allow for this answer" when *rest*. */
interface Decision {
  approved: boolean;
  rest?: boolean;
}

interface Outcome {
  reply: string;
  cancelled: boolean;
  changed: TurnChanges | null;
  error: string;
  tokens: string;
  calls: string[];
  /** The confirmations the answer asked for, in order. */
  asked: Asked[];
  /** The usage the answer's onDone was given: input_tokens and output_tokens when the model counted them. */
  usage: Record<string, unknown>;
}

/**
 * Send *prompt* and wait for its onDone or onError; *started* gets the turn's id at once. *decide* answers each
 * confirmation the way the chat's dialog would; without it, no confirmation is answered.
 */
function ask(agent: InProcessAgent, prompt: string, started?: (id: string) => void,
             decide?: (asked: Asked) => Decision | undefined, sent:{ session?: string; keep?: boolean } = { keep: false }): Promise<Outcome> {
  return new Promise((resolve) => {
    const outcome: Outcome = { reply: "", cancelled: false, changed: null, error: "", tokens: "", calls: [], asked: [],
                               usage: {} };
    let id = "";
    const handlers: TurnHandlers = {
      onToken: (text) => (outcome.tokens += text),
      onThinking: () => undefined,
      onToolCall: (call) => outcome.calls.push(call.name),
      onToolResult: () => undefined,
      onConfirmRequest: (callId, name, input) => {
        const asked = { name, input: input as Record<string, unknown> };
        outcome.asked.push(asked);
        const answer = decide?.(asked);
        if (answer) agent.confirm(id, callId, answer.approved, answer.rest);
      },
      onDone: (reply, cancelled, usage, changed) => resolve({ ...outcome, reply, cancelled, changed, usage }),
      onError: (message) => resolve({ ...outcome, error: message }),
    };
    id = agent.send(prompt, sent, handlers);
    started?.(id);
  });
}

beforeEach(async () => {
  test = await makeApp({ "Notes/Existing.md": "# Existing\n" });
});

afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = null;
  await test?.cleanup();
  test = null;
});

describe("InProcessAgent", () => {
  it("answers a message with what the model says, streamed and in full", async () => {
    const model = await fakeModel([{ text: "Hello from the model" }]);
    const agent = agentOn(test!.app, { llm: { base_url: model.url, model: "test-model" } });
    const outcome = await ask(agent, "Say hello");
    expect(outcome.error).toBe("");
    expect(outcome.reply).toBe("Hello from the model");
    expect(outcome.tokens).toBe("Hello from the model");
    expect(outcome.cancelled).toBe(false);
    // The request carried the user's message and the agent's tools
    const sent = model.bodies[0];
    expect(JSON.stringify(sent.messages)).toContain("Say hello");
    expect((sent.tools as { function: { name: string } }[]).map((t) => t.function.name)).toContain("create_note");
  });

  it("says no connection is set up, and sends nothing, when the settings name none", async () => {
    const agent = agentOn(test!.app, {});
    const outcome = await ask(agent, "Say hello");
    expect(outcome.error).toContain(NO_CONNECTION);
    expect(outcome.reply).toBe("");
  });

  it("ends a cancelled message as cancelled, with no reply", async () => {
    const model = await fakeModel([{ text: "too late", wait: 2000 }]);
    const agent = agentOn(test!.app, { llm: { base_url: model.url, model: "test-model" } });
    const outcome = await ask(agent, "Take your time", (id) => setTimeout(() => agent.cancel(id), 100));
    expect(outcome.cancelled).toBe(true);
    expect(outcome.reply).toBe("");
  });

  it("writes the note a tool call asks for, says what changed, and takes it back on undo", async () => {
    const model = await fakeModel([
      { tool: "create_note", args: { path: "Notes/New.md", content: "Made by the agent" } },
      { text: "Created Notes/New.md" },
    ]);
    const agent = agentOn(test!.app, { llm: { base_url: model.url, model: "test-model" } });
    const outcome = await ask(agent, "Create a note");
    expect(outcome.calls).toEqual(["create_note"]);
    expect(outcome.reply).toBe("Created Notes/New.md");
    expect(await readFile(join(test!.root, "Notes/New.md"), "utf-8")).toBe("Made by the agent");
    expect(outcome.changed?.files).toEqual(["Notes/New.md"]);

    const undone = await agent.undoTurn(outcome.changed!.turn);
    expect(undone).toMatchObject({ ok: true, restored: ["Notes/New.md"] });
    await expect(readFile(join(test!.root, "Notes/New.md"), "utf-8")).rejects.toThrow();
    // An undone note goes where deleted files go: here the vault's .trash
    expect(await readFile(join(test!.root, ".trash/New.md"), "utf-8")).toBe("Made by the agent");
  });

  it("keeps the note it was told about untouched when the model only reads", async () => {
    const model = await fakeModel([
      { tool: "read_note", args: { path: "Notes/Existing.md" } },
      { text: "It says Existing" },
    ]);
    const agent = agentOn(test!.app, { llm: { base_url: model.url, model: "test-model" } });
    const outcome = await ask(agent, "What does Existing say?");
    expect(outcome.reply).toBe("It says Existing");
    expect(outcome.changed).toBeNull();
    // The tool's result went back to the model in the second request
    expect(JSON.stringify(model.bodies[1].messages)).toContain("# Existing");
  });

  it("reports the tokens of an answer as the sum over its model calls", async () => {
    const model = await fakeModel([
      { tool: "read_note", args: { path: "Notes/Existing.md" }, usage: { input: 100, output: 10 } },
      { text: "It says Existing", usage: { input: 200, output: 20 } },
    ]);
    const agent = agentOn(test!.app, { llm: { base_url: model.url, model: "test-model" } });
    const outcome = await ask(agent, "What does Existing say?");
    // Two model calls and one tool call really ran, so the sum is of both
    expect(model.bodies).toHaveLength(2);
    expect(outcome.calls).toEqual(["read_note"]);
    expect(outcome.reply).toBe("It says Existing");
    expect(outcome.usage).toMatchObject({ input_tokens: 300, output_tokens: 30 });
  });

  it("reports an answer without token counts when the model reports none", async () => {
    const model = await fakeModel([{ text: "Hello from the model" }]);
    const agent = agentOn(test!.app, { llm: { base_url: model.url, model: "test-model" } });
    const outcome = await ask(agent, "Say hello");
    expect(outcome.reply).toBe("Hello from the model");
    expect(outcome.usage).not.toHaveProperty("input_tokens");
    expect(outcome.usage).not.toHaveProperty("output_tokens");
  });

  it("runs an answer's second update_note without asking again, once the first is allowed for this answer", async () => {
    await test!.app.vault.adapter.write("Notes/A.md", "old A\n");
    await test!.app.vault.adapter.write("Notes/B.md", "old B\n");
    const model = await fakeModel([
      { tool: "update_note", args: { path: "Notes/A.md", content: "new A\n" } },
      { tool: "update_note", args: { path: "Notes/B.md", content: "new B\n" } },
      { text: "Updated both" },
    ]);
    const agent = agentOn(test!.app, { llm: { base_url: model.url, model: "test-model" } });
    const outcome = await ask(agent, "Update both notes", undefined, () => ({ approved: true, rest: true }));
    expect(outcome.error).toBe("");
    expect(outcome.calls).toEqual(["update_note", "update_note"]);
    // One question for the two calls: the second ran on the first's allowance
    expect(outcome.asked.map((a) => a.name)).toEqual(["update_note"]);
    expect(outcome.asked[0].input).toMatchObject({ path: "Notes/A.md" });
    expect(await readFile(join(test!.root, "Notes/A.md"), "utf-8")).toBe("new A\n");
    expect(await readFile(join(test!.root, "Notes/B.md"), "utf-8")).toBe("new B\n");
    expect(outcome.reply).toBe("Updated both");
  });

  it("still asks about a delete_note later in the same answer, after an update_note was allowed for this answer", async () => {
    await test!.app.vault.adapter.write("Notes/A.md", "old A\n");
    await test!.app.vault.adapter.write("Notes/B.md", "to be deleted\n");
    const model = await fakeModel([
      { tool: "update_note", args: { path: "Notes/A.md", content: "new A\n" } },
      { tool: "delete_note", args: { path: "Notes/B.md" } },
      { text: "Done" },
    ]);
    const agent = agentOn(test!.app, { llm: { base_url: model.url, model: "test-model" } });
    const outcome = await ask(agent, "Tidy up", undefined,
      (asked) => (asked.name === "update_note" ? { approved: true, rest: true } : { approved: true }));
    expect(outcome.asked.map((a) => a.name)).toEqual(["update_note", "delete_note"]);
    expect(outcome.asked[1].input).toMatchObject({ path: "Notes/B.md" });
    // The approval given for the delete was used: the note is gone
    await expect(readFile(join(test!.root, "Notes/B.md"), "utf-8")).rejects.toThrow();
  });

  it("asks again for update_note in the next answer, though the last one allowed it for its own answer", async () => {
    await test!.app.vault.adapter.write("Notes/A.md", "old A\n");
    const model = await fakeModel([
      { tool: "update_note", args: { path: "Notes/A.md", content: "first\n" } },
      { text: "First done" },
      { tool: "update_note", args: { path: "Notes/A.md", content: "second\n" } },
      { text: "Second done" },
    ]);
    const agent = agentOn(test!.app, { llm: { base_url: model.url, model: "test-model" } });
    const first = await ask(agent, "First change", undefined, () => ({ approved: true, rest: true }));
    expect(first.asked.map((a) => a.name)).toEqual(["update_note"]);
    const second = await ask(agent, "Second change", undefined, () => ({ approved: true }));
    expect(second.reply).toBe("Second done");
    expect(second.asked.map((a) => a.name)).toEqual(["update_note"]);
    expect(await readFile(join(test!.root, "Notes/A.md"), "utf-8")).toBe("second\n");
  });

  it("still asks about a create_note with a remote image, after create_note was allowed for this answer", async () => {
    const model = await fakeModel([
      // An overwrite asks, and "Allow for this answer" allows create_note for the rest of the answer
      { tool: "create_note", args: { path: "Notes/Existing.md", content: "Replaced\n", overwrite: true } },
      { tool: "create_note", args: { path: "Notes/Remote.md", content: "![x](https://example.com/a.png)\n" } },
      { text: "Both written" },
    ]);
    const agent = agentOn(test!.app, { llm: { base_url: model.url, model: "test-model" } });
    const outcome = await ask(agent, "Write two notes", undefined,
      (asked) => (asked.input.when_shown === undefined ? { approved: true, rest: true } : { approved: true }));
    expect(outcome.asked.map((a) => a.name)).toEqual(["create_note", "create_note"]);
    expect(outcome.asked[1].input).toMatchObject({ path: "Notes/Remote.md" });
    expect(typeof outcome.asked[1].input.when_shown).toBe("string");
    expect(await readFile(join(test!.root, "Notes/Remote.md"), "utf-8")).toBe("![x](https://example.com/a.png)\n");
  });
});

describe("web_fetch in an answer asks once per host (#403)", () => {
  /** The settings with Open web pages on, as the Features tab saves them. */
  const withWeb = (url: string) => ({ llm: { base_url: url, model: "test-model" },
                                      builtin_tools: { web_fetch: { enabled: true } } });

  it("asks once when an answer calls web_fetch twice on the same host", async () => {
    const model = await fakeModel([
      { tool: "web_fetch", args: { url: "https://example.com/a" } },
      { tool: "web_fetch", args: { url: "https://example.com/b" } },
      { text: "Both read" },
    ]);
    const agent = agentOn(test!.app, withWeb(model.url));
    const outcome = await ask(agent, "Read two pages", undefined, () => ({ approved: true }));
    expect(outcome.error).toBe("");
    expect(outcome.calls).toEqual(["web_fetch", "web_fetch"]);
    expect(outcome.asked.map((a) => a.name)).toEqual(["web_fetch"]);
    expect(outcome.asked[0].input).toMatchObject({ url: "https://example.com/a", host: "example.com" });
    // Both pages were fetched, and the first one's text reached the model
    expect(JSON.stringify(model.bodies[2].messages)).toContain("page at https://example.com/b");
    expect(outcome.reply).toBe("Both read");
  });

  it("does not ask again for a host in a second answer of the same conversation", async () => {
    const model = await fakeModel([
      { tool: "web_fetch", args: { url: "https://example.com/a" } },
      { text: "First read" },
      { tool: "web_fetch", args: { url: "https://www.example.com/c" } },
      { text: "Second read" },
    ]);
    const agent = agentOn(test!.app, withWeb(model.url));
    const sent = { session: "same-conversation", keep: true };
    const first = await ask(agent, "Read a page", undefined, () => ({ approved: true }), sent);
    expect(first.asked.map((a) => a.name)).toEqual(["web_fetch"]);
    const second = await ask(agent, "Read another page", undefined, () => ({ approved: true }), sent);
    expect(second.error).toBe("");
    expect(second.calls).toEqual(["web_fetch"]);
    expect(second.asked).toEqual([]);
    expect(second.reply).toBe("Second read");
  });

  it("asks again for the same host in a new conversation", async () => {
    const model = await fakeModel([
      { tool: "web_fetch", args: { url: "https://example.com/a" } },
      { text: "First read" },
      { tool: "web_fetch", args: { url: "https://example.com/a" } },
      { text: "Read in the new conversation" },
    ]);
    const agent = agentOn(test!.app, withWeb(model.url));
    const first = await ask(agent, "Read a page", undefined, () => ({ approved: true }),
                            { session: "first-conversation", keep: true });
    expect(first.asked.map((a) => a.name)).toEqual(["web_fetch"]);
    const next = await ask(agent, "Read a page", undefined, () => ({ approved: true }),
                           { session: "new-conversation", keep: true });
    expect(next.reply).toBe("Read in the new conversation");
    expect(next.asked.map((a) => a.name)).toEqual(["web_fetch"]);
  });
});

describe("the undo journal kept across restarts (#410)", () => {
  /** A journal store stand-in: `load` answers what *read* gives; `save` records what it is given. */
  function journalStore(read: () => Promise<unknown>) {
    const load = vi.fn(read);
    const save = vi.fn(async (_data: SavedJournal) => undefined);
    return { load, save, store: { load, save } };
  }

  /** The journal the store was given last. */
  function lastSaved(save: { mock: { calls: unknown[][] } }): SavedJournal {
    const calls = save.mock.calls;
    return calls[calls.length - 1][0] as SavedJournal;
  }

  const withModel = (url: string) => ({ llm: { base_url: url, model: "test-model" } });

  it("saves the journal once an answer's tool has written a note, with that answer's turn in it", async () => {
    const model = await fakeModel([
      { tool: "create_note", args: { path: "Notes/New.md", content: "Made by the agent" } },
      { text: "Created Notes/New.md" },
    ]);
    const stand = journalStore(async () => null);
    const agent = agentOn(test!.app, withModel(model.url), { journalStore: stand.store });
    const outcome = await ask(agent, "Create a note");
    expect(outcome.changed?.turn).toBeTruthy();
    await vi.waitFor(() => expect(stand.save).toHaveBeenCalled());
    const saved = lastSaved(stand.save);
    expect(saved.turns).toHaveLength(1);
    expect(saved.turns[0].id).toBe(outcome.changed!.turn);
    expect(saved.turns[0].changes.map((change) => change.path)).toEqual(["Notes/New.md"]);
  });

  it("lists a turn saved before a restart before any message, and undo takes its note back and saves again", async () => {
    // The first run: the answer writes a note, and the journal is saved
    const first = journalStore(async () => null);
    const model = await fakeModel([
      { tool: "create_note", args: { path: "Notes/New.md", content: "Made by the agent" } },
      { text: "Created Notes/New.md" },
    ]);
    const before = agentOn(test!.app, withModel(model.url), { journalStore: first.store });
    const made = await ask(before, "Create a note");
    await vi.waitFor(() => expect(first.save).toHaveBeenCalled());
    const saved = lastSaved(first.save);

    // A restart: a new agent on the same vault, whose store gives the saved journal back, and no message is sent
    const second = journalStore(async () => saved);
    const after = agentOn(test!.app, withModel(model.url), { journalStore: second.store });
    expect(await after.turns()).toMatchObject({
      journalling: true,
      turns: [{ id: made.changed!.turn, files: ["Notes/New.md"], undone: false }],
    });

    const undone = await after.undoTurn(made.changed!.turn);
    expect(undone).toMatchObject({ ok: true, restored: ["Notes/New.md"] });
    await expect(readFile(join(test!.root, "Notes/New.md"), "utf-8")).rejects.toThrow();
    await vi.waitFor(() => expect(second.save).toHaveBeenCalled());
    expect(lastSaved(second.save).turns[0]).toMatchObject({ id: made.changed!.turn, undone: true });
  });

  it("lists no turns, and logs why, when the saved journal cannot be read", async () => {
    const stand = journalStore(() => Promise.reject(new Error("the file is locked")));
    const lines: string[] = [];
    const agent = agentOn(test!.app, withModel("http://127.0.0.1:9/v1"),
                          { journalStore: stand.store, log: (line: string) => void lines.push(line) });
    expect(await agent.turns()).toEqual({ journalling: true, turns: [] });
    expect(lines.join("\n")).toContain("undo: the saved journal could not be read");
  });

  it("reads the saved journal once, however many answers and turn lists follow", async () => {
    const stand = journalStore(async () => null);
    const model = await fakeModel([
      { tool: "create_note", args: { path: "Notes/One.md", content: "one\n" } },
      { text: "One" },
      { tool: "create_note", args: { path: "Notes/Two.md", content: "two\n" } },
      { text: "Two" },
    ]);
    const agent = agentOn(test!.app, withModel(model.url), { journalStore: stand.store });
    const first = await ask(agent, "Create the first note");
    const second = await ask(agent, "Create the second note");
    expect(first.changed).not.toBeNull();
    expect(second.changed).not.toBeNull();
    await agent.turns();
    await agent.turns();
    expect(stand.load).toHaveBeenCalledTimes(1);
    expect((await agent.turns()).turns).toHaveLength(2);
  });
});

describe("confirmations nobody answers, and the connections this device refuses (#420)", () => {
  /** InProcessAgent's CONFIRM_TIMEOUT_MS: not exported, so its value is written out here. */
  const FIVE_MINUTES = 300_000;

  const withModel = (url: string) => ({ llm: { base_url: url, model: "test-model" } });

  it("refuses a delete nobody answers once five minutes pass: the note stays, the model is told, the answer ends", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      await test!.app.vault.adapter.write("Notes/B.md", "to be kept\n");
      const model = await fakeModel([
        { tool: "delete_note", args: { path: "Notes/B.md" } },
        { text: "Not deleted" },
      ]);
      const agent = agentOn(test!.app, withModel(model.url));
      let seeAsk!: (asked: Asked) => void;
      const seen = new Promise<Asked>((resolve) => (seeAsk = resolve));
      // The dialog is shown and nothing answers it
      const outcome = ask(agent, "Delete B", undefined, (asked) => {
        seeAsk(asked);
        return undefined;
      });
      expect((await seen).name).toBe("delete_note");

      await vi.advanceTimersByTimeAsync(FIVE_MINUTES - 1);
      expect(model.bodies).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);

      const done = await outcome;
      expect(done.error).toBe("");
      expect(done.cancelled).toBe(false);
      expect(done.reply).toBe("Not deleted");
      expect(await readFile(join(test!.root, "Notes/B.md"), "utf-8")).toBe("to be kept\n");
      // The refusal went back to the model as the tool's result
      expect(JSON.stringify(model.bodies[1].messages)).toContain("the user declined to run 'delete_note'");
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses a waiting delete at once when the answer is cancelled: the note stays, the answer ends cancelled", async () => {
    await test!.app.vault.adapter.write("Notes/B.md", "to be kept\n");
    const model = await fakeModel([
      { tool: "delete_note", args: { path: "Notes/B.md" } },
      { text: "Not deleted" },
    ]);
    const agent = agentOn(test!.app, withModel(model.url));
    let turn = "";
    let seeAsk!: (asked: Asked) => void;
    const seen = new Promise<Asked>((resolve) => (seeAsk = resolve));
    const outcome = ask(agent, "Delete B", (id) => (turn = id), (asked) => {
      seeAsk(asked);
      return undefined;
    });
    expect((await seen).name).toBe("delete_note");

    agent.cancel(turn);
    const done = await outcome;
    expect(done.cancelled).toBe(true);
    expect(done.error).toBe("");
    expect(done.calls).toEqual(["delete_note"]);
    expect(await readFile(join(test!.root, "Notes/B.md"), "utf-8")).toBe("to be kept\n");
  });

  it("ends a message whose key goes to an address this device has not approved, naming the approval, and sends no request", async () => {
    const model = await fakeModel([{ text: "should not be sent" }]);
    const values = { llm: { base_url: model.url, model: "test-model", api_key: "${LAB_KEY}" } };
    const agent = agentOn(test!.app, values, { deviceApprovals: new DeviceApprovals(() => ({}), () => undefined) });
    const outcome = await ask(agent, "Say hello");
    expect(outcome.error).toContain("has not approved");
    expect(outcome.error).toContain("Settings → Hiro Agent → Connections");
    expect(outcome.reply).toBe("");
    expect(model.bodies).toHaveLength(0);
  });

  it("ends a message whose key is written out in the settings, saying such a key is never used, and sends no request", async () => {
    const model = await fakeModel([{ text: "should not be sent" }]);
    const agent = agentOn(test!.app, { llm: { base_url: model.url, model: "test-model", api_key: "sk-123" } });
    const outcome = await ask(agent, "Say hello");
    expect(outcome.error).toContain("written out in the settings");
    expect(outcome.error).toContain("a key there is never used");
    // The refusal does not repeat the key it refuses
    expect(outcome.error).not.toContain("sk-123");
    expect(outcome.reply).toBe("");
    expect(model.bodies).toHaveLength(0);
  });
});
