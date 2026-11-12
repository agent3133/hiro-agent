// @vitest-environment jsdom
// The chat view on the obsidian stub (#368): the message box and the agent picker, a message sent to the agent and
// shown in the chat, an answer streamed in and finished, the send button that stops it, and an error shown in the chat.
// The agent is a fake that keeps the handlers each send was given, so a test drives the answer as the runtime would.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { TurnHandlers } from "../api/types";
import { makeApp, Notice, WorkspaceLeaf, type TestApp } from "../testing/obsidian";

import { ChatView, EXAMPLE_REQUESTS } from "./ChatView";
import { ConversationPicker } from "./ConversationPicker";

type Deps = ConstructorParameters<typeof ChatView>[1];

interface Sent {
  id: string;
  prompt: string;
  options: Record<string, unknown>;
  handlers: TurnHandlers;
}

/** The InProcessAgent methods the chat calls on open, on send, on cancel and on a reopened conversation. */
function fakeAgent() {
  const sent: Sent[] = [];
  return {
    sent,
    info: vi.fn(() => ({
      version: "test", vault: "test-vault", agents: [{ name: "Helper" }, { name: "Writer" }],
      profiles: [], defaultProfile: "",
    })),
    sessions: vi.fn(async () => []),
    session: vi.fn(async (_name: string) => ({ messages: [] as { role: string; content: string }[], summary: undefined })),
    send: vi.fn((prompt: string, options: Record<string, unknown>, handlers: TurnHandlers) => {
      const id = `turn-${sent.length + 1}`;
      sent.push({ id, prompt, options, handlers });
      return id;
    }),
    cancel: vi.fn(),
    forget: vi.fn(),
    nameSession: vi.fn(),
  };
}

type FakeAgent = ReturnType<typeof fakeAgent>;

/** The ViewDeps the view is given: a connection exists, so no setup card is shown. */
function makeDeps(agent: FakeAgent): Deps {
  return {
    agent: () => agent as never,
    defaultAgent: vi.fn(() => "Helper"),
    lastSession: vi.fn(() => ""),
    rememberSession: vi.fn(),
    keepByDefault: vi.fn(() => false),
    rememberKeep: vi.fn(),
    lastProfile: vi.fn(() => ""),
    rememberProfile: vi.fn(),
    setup: {
      ready: vi.fn(() => true),
      findLocal: vi.fn(async () => []),
      addLocal: vi.fn(async () => null),
      addKey: vi.fn(),
      openSettings: vi.fn(),
    },
    context: vi.fn(),
    used: vi.fn(),
    rereadAgents: vi.fn(async () => undefined),
    current: vi.fn(() => false),
    openElsewhere: vi.fn(() => false),
    sessionsChanged: vi.fn(),
    loaded: vi.fn(async () => undefined),
    newWindow: vi.fn(async () => undefined),
  };
}

let t: TestApp;
let agent: FakeAgent;
let view: ChatView;

beforeEach(async () => {
  Notice.shown = [];
  document.body.replaceChildren();
  t = await makeApp();
  agent = fakeAgent();
  view = new ChatView(new WorkspaceLeaf(t.app) as never, makeDeps(agent));
  await view.onOpen();
  document.body.appendChild(view.containerEl);
});

afterEach(async () => {
  await view.onClose();
  view.containerEl.remove();
  await t.cleanup();
});

/** The first element of the chat matching *selector*; a test fails here when the view does not draw it. */
function el<T extends HTMLElement = HTMLElement>(selector: string): T {
  const found = view.containerEl.querySelector<T>(selector);
  if (!found) throw new Error(`no ${selector} in the chat`);
  return found;
}

const messageBox = (): HTMLTextAreaElement => el<HTMLTextAreaElement>("textarea.obsidian-agent-input");
const sendButton = (): HTMLButtonElement => el<HTMLButtonElement>(".obsidian-agent-send");
const agentBody = (): HTMLElement => el(".mod-agent .obsidian-agent-body");
const userMessages = (): (string | null)[] =>
  Array.from(view.containerEl.querySelectorAll(".mod-user .obsidian-agent-body"), (body) => body.textContent);

/** Type into the message box as the user does: the text, then the input event. */
function typeIntoMessageBox(text: string): void {
  messageBox().value = text;
  messageBox().dispatchEvent(new Event("input"));
}

describe("the chat view", () => {
  it("opens with a message box, and an agent picker that lists the agents the agent reports", () => {
    expect(messageBox()).toBeTruthy();
    expect(agent.info).toHaveBeenCalled();
    const picker = el<HTMLSelectElement>(".obsidian-agent-picker");
    expect(Array.from(picker.options, (option) => option.value)).toEqual(["Helper", "Writer"]);
  });

  it("sends the text typed in the message box to the agent, and shows it as the user's message", async () => {
    typeIntoMessageBox("Hello");
    sendButton().click();
    await vi.waitFor(() => expect(agent.send).toHaveBeenCalled());
    expect(agent.send.mock.calls[0][0]).toBe("Hello");
    expect(userMessages()).toEqual(["Hello"]);
  });

  it("sends the text typed in the message box when Enter is pressed", async () => {
    typeIntoMessageBox("Hello");
    messageBox().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(agent.send).toHaveBeenCalled());
    expect(agent.send.mock.calls[0][0]).toBe("Hello");
  });

  it("streams the tokens into the chat while the answer runs, and shows the reply with the box usable once it is done", async () => {
    typeIntoMessageBox("Hello");
    sendButton().click();
    await vi.waitFor(() => expect(agent.send).toHaveBeenCalled());
    const { handlers } = agent.sent[0];

    handlers.onToken("Hi");
    await vi.waitFor(() => expect(agentBody().textContent).toBe("Hi"));
    expect(sendButton().getAttribute("aria-label")).toBe("Stop (Escape)");

    handlers.onDone("Hi there", false, {}, null, 0);
    await vi.waitFor(() => expect(agentBody().textContent).toBe("Hi there"));
    expect(sendButton().getAttribute("aria-label")).toBe("Send (Enter)");
    expect(messageBox().disabled).toBe(false);

    // Usable: a second message goes to the agent
    typeIntoMessageBox("Again");
    sendButton().click();
    await vi.waitFor(() => expect(agent.send).toHaveBeenCalledTimes(2));
    expect(agent.sent[1].prompt).toBe("Again");
  });

  it("cancels the running answer when the send button, now Stop, is clicked", async () => {
    typeIntoMessageBox("Hello");
    sendButton().click();
    await vi.waitFor(() => expect(agent.send).toHaveBeenCalled());
    expect(sendButton().getAttribute("aria-label")).toBe("Stop (Escape)");

    sendButton().click();
    expect(agent.cancel).toHaveBeenCalledWith("turn-1");
    expect(agent.send).toHaveBeenCalledTimes(1);
  });

  it("shows the error text in the chat when the answer fails", async () => {
    typeIntoMessageBox("Hello");
    sendButton().click();
    await vi.waitFor(() => expect(agent.send).toHaveBeenCalled());

    agent.sent[0].handlers.onError("the server is down", true);
    expect(el(".mod-agent .obsidian-agent-error").textContent).toBe("the server is down");
  });
});

describe("the chat's first minutes (#400)", () => {
  /** Let what a keydown or a click started run to its end (the send waits on the attachments first). */
  const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

  /** A keydown in the message box, as the keyboard makes it. */
  function pressKey(init: KeyboardEventInit): void {
    messageBox().dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
  }

  /** Replace the open chat with one built on *deps*, as a window opened with that setup would be. */
  async function reopen(deps: Deps): Promise<void> {
    await view.onClose();
    view.containerEl.remove();
    view = new ChatView(new WorkspaceLeaf(t.app) as never, deps);
    await view.onOpen();
    document.body.appendChild(view.containerEl);
  }

  const exampleButtons = (): HTMLButtonElement[] =>
    Array.from(view.containerEl.querySelectorAll<HTMLButtonElement>(".obsidian-agent-example"));

  it("does not send on an Enter that ends an input method's composition", async () => {
    typeIntoMessageBox("Hello");
    pressKey({ key: "Enter", isComposing: true });
    await settle();
    expect(agent.send).not.toHaveBeenCalled();
    expect(messageBox().value).toBe("Hello");
  });

  it("does not send on Shift+Enter, which starts a new line", async () => {
    typeIntoMessageBox("Hello");
    pressKey({ key: "Enter", shiftKey: true });
    await settle();
    expect(agent.send).not.toHaveBeenCalled();
    expect(messageBox().value).toBe("Hello");
  });

  it("sends on Enter when no composition is running", async () => {
    typeIntoMessageBox("Hello");
    pressKey({ key: "Enter", isComposing: false });
    await vi.waitFor(() => expect(agent.send).toHaveBeenCalled());
    expect(agent.send.mock.calls[0][0]).toBe("Hello");
  });

  it("shows the setup card when no connection is set up, and its Use an API key button calls addKey once", async () => {
    const deps = makeDeps(agent);
    deps.setup.ready = () => false;
    await reopen(deps);

    const card = el(".obsidian-agent-setup");
    const key = Array.from(card.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent === "Use an API key");
    expect(key).toBeDefined();
    key!.click();
    expect(deps.setup.addKey).toHaveBeenCalledTimes(1);
  });

  it("shows the example requests in an empty chat, one button for each", () => {
    expect(view.containerEl.querySelector(".obsidian-agent-examples")).not.toBeNull();
    expect(exampleButtons().map((button) => button.textContent)).toEqual(EXAMPLE_REQUESTS);
  });

  it("puts a clicked example request into the message box, and sends nothing to the agent", async () => {
    exampleButtons()[0].click();
    expect(messageBox().value).toBe(EXAMPLE_REQUESTS[0]);
    await settle();
    expect(agent.send).not.toHaveBeenCalled();
    expect(userMessages()).toEqual([]);
  });

  it("removes the example requests once a message is sent", async () => {
    typeIntoMessageBox("Hello");
    sendButton().click();
    await vi.waitFor(() => expect(agent.send).toHaveBeenCalled());
    expect(view.containerEl.querySelector(".obsidian-agent-examples")).toBeNull();
    expect(exampleButtons()).toHaveLength(0);
  });
});

describe("closing the chat while an answer runs (#413)", () => {
  beforeEach(() => {
    Notice.all = [];
    Notice.shown = [];
  });

  /** Send a message and let its answer start; the handlers are the ones the fake agent was given for it. */
  async function startAnswer(): Promise<TurnHandlers> {
    typeIntoMessageBox("Hello");
    sendButton().click();
    await vi.waitFor(() => expect(agent.send).toHaveBeenCalled());
    return agent.sent[0].handlers;
  }

  /** The notice saying the chat closing stopped its answer; a test fails here when no such notice was shown. */
  function stoppedNotice(): Notice {
    const found = Notice.all.find((notice) => notice.message.startsWith("Closing the chat stopped its answer"));
    if (!found) throw new Error(`no notice about a stopped answer (there are: ${Notice.shown.join(" | ")})`);
    return found;
  }

  it("cancels the running answer when the chat is closed, by its turn id", async () => {
    await startAnswer();
    await view.onClose();
    expect(agent.cancel).toHaveBeenCalledWith("turn-1");
  });

  it("says the stopped answer changed files, with an undo button, and draws nothing more in the chat", async () => {
    const handlers = await startAnswer();
    const messages = el(".obsidian-agent-messages");
    await view.onClose();

    handlers.onDone("", true, {}, { turn: "t1", files: ["a.md", "b.md"] }, 0);

    const notice = stoppedNotice();
    expect(notice.messageEl?.textContent).toContain("Closing the chat stopped its answer");
    expect(notice.messageEl?.textContent).toContain("2 files");
    expect(notice.messageEl?.querySelector("button")?.textContent).toBe("Undo its changes");
    expect(messages.textContent).not.toContain("Cancelled.");
    expect(messages.querySelector(".obsidian-agent-footer")).toBeNull();
  });

  it("hides the notice and opens the undo dialog for the answer's turn when its undo button is clicked", async () => {
    const turnDiff = vi.fn(async () => ({ files: ["a.md", "b.md"], diff: "", undone: false, stale: [] }));
    Object.assign(agent, { turnDiff });
    const handlers = await startAnswer();
    await view.onClose();
    handlers.onDone("", true, {}, { turn: "t1", files: ["a.md", "b.md"] }, 0);
    const notice = stoppedNotice();

    notice.messageEl!.querySelector("button")!.click();

    expect(notice.hidden).toBe(true);
    await vi.waitFor(() => expect(turnDiff).toHaveBeenCalledWith("t1"));
    expect(document.body.textContent).toContain("Undo what this answer changed?");
    const listed = Array.from(document.body.querySelectorAll(".obsidian-agent-undo-files li"), (li) => li.textContent);
    expect(listed).toEqual(["a.md", "b.md"]);
  });

  it("says the stopped answer changed nothing, and offers no undo button", async () => {
    const handlers = await startAnswer();
    await view.onClose();

    handlers.onDone("", true, {}, null, 0);

    const notice = stoppedNotice();
    expect(notice.messageEl?.textContent).toContain("It had changed nothing.");
    expect(notice.messageEl?.querySelector("button")).toBeNull();
  });

  it("shows no notice when the chat is closed with no answer running", async () => {
    await view.onClose();
    expect(Notice.all).toHaveLength(0);
    expect(agent.cancel).not.toHaveBeenCalled();
  });
});

describe("the tokens an answer spent (#414)", () => {
  /** Send *text* and return the handlers of the answer it started. */
  async function sendAndHandlers(text: string): Promise<TurnHandlers> {
    const before = agent.sent.length;
    typeIntoMessageBox(text);
    sendButton().click();
    await vi.waitFor(() => expect(agent.send).toHaveBeenCalledTimes(before + 1));
    return agent.sent[before].handlers;
  }

  /** The last token count drawn in the chat: the footer of the newest answer. */
  function lastTokenSpan(): HTMLElement {
    const spans = view.containerEl.querySelectorAll<HTMLElement>(".obsidian-agent-footer-tokens");
    const last = spans[spans.length - 1];
    if (!last) throw new Error("no .obsidian-agent-footer-tokens in the chat");
    return last;
  }

  it("shows an answer's tokens in its footer, and this answer's own counts in the tooltip", async () => {
    const handlers = await sendAndHandlers("Hello");
    handlers.onDone("Hi there", false, { seconds: 2, tool_calls: 1, input_tokens: 12431, output_tokens: 380 }, null, 0);

    expect(el(".obsidian-agent-footer-tokens").textContent).toBe(" · 12k tokens in, 380 out");
    expect(el(".obsidian-agent-footer-tokens").getAttribute("aria-label"))
      .toContain("This answer: 12,431 tokens sent to the model, 380 received.");
  });

  it("gives the conversation's total in the tooltip, adding up the answers of this chat", async () => {
    const first = await sendAndHandlers("Hello");
    first.onDone("Hi there", false, { seconds: 2, tool_calls: 1, input_tokens: 12431, output_tokens: 380 }, null, 0);
    const second = await sendAndHandlers("Again");
    second.onDone("Still here", false, { seconds: 1, tool_calls: 0, input_tokens: 1000, output_tokens: 20 }, null, 0);

    expect(lastTokenSpan().getAttribute("aria-label")).toContain("13,431 sent, 400 received");
  });

  it("shows no token count for an answer whose server did not count its tokens", async () => {
    const handlers = await sendAndHandlers("Hello");
    handlers.onDone("Hi there", false, { seconds: 2, tool_calls: 0 }, null, 0);

    // The answer is drawn, so the absence is not just an empty chat
    expect(view.containerEl.querySelector(".obsidian-agent-footer")).not.toBeNull();
    expect(view.containerEl.querySelector(".obsidian-agent-footer-tokens")).toBeNull();
  });

  it("starts the conversation's total over after a new conversation", async () => {
    const first = await sendAndHandlers("Hello");
    first.onDone("Hi there", false, { seconds: 1, tool_calls: 0, input_tokens: 1000, output_tokens: 20 }, null, 0);

    await view.newConversation();
    const second = await sendAndHandlers("Fresh start");
    second.onDone("Hello again", false, { seconds: 1, tool_calls: 0, input_tokens: 500, output_tokens: 10 }, null, 0);

    expect(lastTokenSpan().getAttribute("aria-label")).toContain("This conversation in this chat: 500 sent, 10 received.");
    expect(lastTokenSpan().getAttribute("aria-label")).not.toContain("1,500");
  });
});

describe("what the answer reached beyond the vault (#409)", () => {
  /** Send *text* and return the handlers of the answer it started. */
  async function sendAndHandlers(text: string): Promise<TurnHandlers> {
    const before = agent.sent.length;
    typeIntoMessageBox(text);
    sendButton().click();
    await vi.waitFor(() => expect(agent.send).toHaveBeenCalledTimes(before + 1));
    return agent.sent[before].handlers;
  }

  /** The what-left line drawn under the answer; a test fails here when the view draws none. */
  function whatLeftLine(): HTMLElement {
    const found = view.containerEl.querySelector<HTMLElement>(".mod-agent .obsidian-agent-what-left");
    if (!found) throw new Error("no .obsidian-agent-what-left under the answer");
    return found;
  }

  it("says under the answer that a page on a site was opened, naming the site", async () => {
    const handlers = await sendAndHandlers("Read the example page");
    handlers.onToolCall({ callId: "c1", name: "web_fetch", input: { url: "https://example.com/a" } });
    handlers.onToolResult("c1", "The page text: an example domain.", false);
    handlers.onDone("The page is about an example.", false, { seconds: 1, tool_calls: 1 }, null, 0);

    expect(whatLeftLine().textContent)
      .toBe("Besides the model, this answer reached a page on example.com.");
    // Under the answer, after its footer: the line belongs to this answer's turn
    expect(whatLeftLine().closest(".obsidian-agent-message")?.classList.contains("mod-agent")).toBe(true);
    expect(el(".mod-agent .obsidian-agent-footer")).toBeTruthy();
  });

  it("shows no what-left line for an answer that only read a note in the vault", async () => {
    const handlers = await sendAndHandlers("What is in my note?");
    handlers.onToolCall({ callId: "c1", name: "read_note", input: { path: "Notes/a.md" } });
    handlers.onToolResult("c1", "# A\n\nSome text in the vault.", false);
    handlers.onDone("Your note says some text.", false, { seconds: 1, tool_calls: 1 }, null, 0);

    // The answer is drawn, so the absence is not just an empty chat
    expect(el(".mod-agent .obsidian-agent-footer")).toBeTruthy();
    expect(view.containerEl.querySelector(".obsidian-agent-what-left")).toBeNull();
  });

  it("names the MCP server an answer called, and names no site for a page the user declined to open", async () => {
    const handlers = await sendAndHandlers("Search and read the page");
    handlers.onToolCall({ callId: "c1", name: "search__query", input: { q: "hiro" } });
    handlers.onToolResult("c1", "three results", false);
    handlers.onToolCall({ callId: "c2", name: "web_fetch", input: { url: "https://example.com/b" } });
    handlers.onToolResult("c2", "Error: the user declined to run 'web_fetch'. The page was not opened.", true);
    handlers.onDone("Found it.", false, { seconds: 1, tool_calls: 2 }, null, 0);

    expect(whatLeftLine().textContent).toBe("Besides the model, this answer reached the MCP server search.");
    expect(whatLeftLine().textContent).not.toContain("example");
  });
});

describe("the [[ note list in the message box (#411)", () => {
  const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

  it("puts a link to the note picked with Enter in place of [[, and does not send the message", async () => {
    await t.app.vault.adapter.write("Projects/Atlas.md", "# Atlas\n");
    typeIntoMessageBox("[[");
    expect(view.containerEl.querySelectorAll(".obsidian-agent-link-suggestion")).toHaveLength(1);

    messageBox().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    await settle();

    expect(messageBox().value).toBe("[[Projects/Atlas]]");
    expect(agent.send).not.toHaveBeenCalled();
    expect(userMessages()).toEqual([]);
  });
});

describe("exporting a kept conversation as a note (#412)", () => {
  const SESSION = "2026-11-11-0930-trip-plan";

  it("writes a note at the vault root named after the conversation's title, with its messages, and leaves the session note as it was", async () => {
    const sessionPath = join(t.root, ".sessions", `${SESSION}.md`);
    await t.app.vault.adapter.write(`.sessions/${SESSION}.md`, "---\nconnection: local\n---\nthe session note\n");
    const sessionBefore = readFileSync(sessionPath, "utf-8");

    agent.sessions.mockResolvedValue([
      { name: SESSION, title: "Trip plan", agent: "Helper", model: "", exchanges: 1, updated: "" },
    ] as never);
    await view.refreshSessions();
    agent.session.mockResolvedValue({
      messages: [{ role: "user", content: "Where should we go?" }, { role: "assistant", content: "The coast." }],
      summary: undefined,
    });
    await view.openSession(SESSION);
    // The stub's workspace has no getLeaf: the export opens its note in a tab, which this test does not need
    (t.app.workspace as unknown as Record<string, unknown>).getLeaf = () => ({ openFile: async () => undefined });

    const file = await view.exportConversation();

    expect(file).not.toBeNull();
    expect(file!.path).toBe("Trip plan.md");
    expect(readdirSync(t.root)).toContain("Trip plan.md");
    const note = readFileSync(join(t.root, "Trip plan.md"), "utf-8");
    expect(note).toContain("## You");
    expect(note).toContain("Where should we go?");
    expect(note).toContain("The coast.");
    expect(readFileSync(sessionPath, "utf-8")).toBe(sessionBefore);
  });
});

describe("exporting with no kept conversation open (#412)", () => {
  it("returns null and writes no note when no conversation is open", async () => {
    const before = readdirSync(t.root).sort();

    const file = await view.exportConversation();

    expect(file).toBeNull();
    expect(readdirSync(t.root).sort()).toEqual(before);
    expect(agent.session).not.toHaveBeenCalled();
  });
});

describe("the Find a conversation picker (#412)", () => {
  it("shows each conversation by its label, and choosing one opens the conversation it names", () => {
    const open = vi.fn();
    const items = [{ name: "a", label: "Trip" }, { name: "b", label: "Taxes" }];
    const picker = new ConversationPicker(t.app as never, items, open);

    expect(picker.getItemText(items[0])).toBe("Trip");
    expect(picker.getItemText(items[1])).toBe("Taxes");

    picker.onChooseItem(items.find((item) => item.label === "Taxes")!);

    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith("b");
  });
});
