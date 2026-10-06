/**
 * Runs chat turns inside the plugin, with the TypeScript agent core — behind the experimental switch until the
 * cut-over (#88).
 *
 * It answers the chat view the way the runtime's socket client did until the cut-over (#88): turns (send, cancel, confirm), conversations kept as session
 * notes (#85: list, open, delete, keep or stop keeping, compaction), and the turns it can take back (diff, undo).
 * Its agents and connections are the plugin's own (#86): the catalog in config/agents.ts and the settings in
 * config/store.ts; the Python runtime is not needed for a turn.
 */

import { FileSystemAdapter, Notice, type App } from "obsidian";

import type { ReadyInfo, TurnChanges, TurnHandlers, TurnSummary, UndoResult } from "../api/types";
import type { AgentCatalog } from "../config/agents";
import type { PluginBackend } from "../config/backend";
import { detectConnection, type ServerCache, hasConnection, NO_CONNECTION, profileSummaries, resolveConnection, writtenOutKey }
  from "../config/connections";
import { connectionApproval, type DeviceApprovals } from "../config/deviceApprovals";
import { featurePrompt } from "../config/features";
import { runTurn, turnFailure, type Confirm } from "../core/agentLoop";
import { compactHistory, dueForCompaction, estimateMessages, KEEP_SHARE, recentThatFit, retryAfterCompaction,
         splitHistory, summariseLimit } from "../core/compaction";
import { serially } from "../core/serial";
import { Journal, type Turn } from "../core/journal";
import { undoTurns, withoutLast, type RewindResult } from "../core/rewind";
import { OpenAiChat, type ChatModel, type LlmSettings } from "../core/llm/openaiChat";
import { OpenAiResponses } from "../core/llm/openaiResponses";
import { scopePrompt, toolConventions } from "../core/paths";
import { promptContext, renderPrompt } from "../core/prompt";
import {
  type CallsByAnswer, compactSession, type ConnectionChange, deleteSession, listSessions, loadSessionWithCalls, sanitiseName,
  savedCall, type SavedCall, saveSession, setSessionTitle, type SessionMessage, sessionMeta, type SessionSummary,
} from "../core/sessions";
import { readUserProfile } from "../core/tools/memoryTools";
import type { Tool } from "../core/tools/tool";
import { assembleTools, mcpPrompt, wantsMcp } from "../mcp/agentTools";
import type { McpManager } from "../mcp/manager";
import { mcpServers } from "../mcp/servers";
import { obsidianVault, setRecorder } from "../vault/obsidianVault";
import { obsidianToolset, type ToolsetOptions } from "../vault/toolset";

/** The Python runtime's default for an agent that sets no max_iterations (registry/agent_loader.py). */
const DEFAULT_MAX_ITERATIONS = 50;
/** How long a confirmation waits for an answer before it counts as a refusal — the runtime's CONFIRM_TIMEOUT_S. */
const CONFIRM_TIMEOUT_MS = 300_000;
/** A reopened conversation brings back the newest messages within this share of the context window. */
const HISTORY_SHARE = KEEP_SHARE;
/**
 * One tool result may fill at most this share of the context window, counted at three characters a token — few
 * enough that a page in any language fits. A long web page is cut rather than ending the turn.
 */
const TOOL_RESULT_SHARE = 0.25;
const CHARS_PER_TOKEN = 3;
/**
 * Kept conversations longer than this many exchanges are summarised after the answer whatever their size, so the
 * note does not grow without end (AgentSession.save_session). Mostly, size in the window decides first (#154).
 */
const COMPACT_AFTER_EXCHANGES = 50;

interface TurnOptions {
  agent?: string;
  session?: string;
  profile?: string;
  context?: Record<string, unknown>;
  /** false: the conversation is kept in memory under `session` for follow-ups, but never written to a note. */
  keep?: boolean;
  /**
   * The chat view asking, for a conversation without a session: each view's unkept conversation is its own, so two
   * chats side by side never share a history (#153). Without it, the one unnamed conversation (agent:ask).
   */
  view?: string;
}

/**
 * The key an unkept conversation of chat view *view* is held under (#153): never a session name, which cannot
 * start with a NUL, and never written to a note. "" without a view.
 */
export function scratchKey(view?: string): string {
  return view ? `\u0000${view}` : "";
}

/** One conversation: what goes into the next prompt, what is only in its note, and who answered it. */
interface Conversation {
  name: string | null;
  loaded: SessionMessage[];
  unloaded: SessionMessage[];
  connections: ConnectionChange[];
  pendingCompact: boolean;
  last?: { agent: string; model: string; connection: string };
  /** What the user called it (#286), written with the next save. */
  title?: string;
  /** Each answer's tool calls, saved with the note when the setting is on (#282). */
  calls: CallsByAnswer;
}

/** An agent's unsaved edits in the Agents tab, previewed before they are saved (#67). */
export interface PromptDraft {
  prompt?: string;
  tools?: string[];
  vault_scope?: string[];
  llm_profile?: string | null;
  model?: string | null;
}

/** The system prompt as the next turn would send it, and what went into it (#67). */
export interface PromptAsSent {
  text: string;
  /** Template expressions left as written: the plugin fills in plain placeholders only. */
  unsupported: string[];
  /** The model named in it; empty when neither the settings nor the server name one. */
  model: string;
  /** Whether the MCP tools in it come from this device's last listing rather than a live one. */
  mcpFromCache: boolean;
}

/** Where the in-plugin agent gets its agents and connections, and how it reaches keys and servers. */
export interface InProcessSource {
  catalog: AgentCatalog;
  backend: PluginBackend;
  /** The agent's settings now (config/store.ts). */
  values(): Record<string, unknown>;
  /** A `${VAR}` reference's value: the keychain secret bound to it, and nothing else. */
  env(name: string): string | undefined;
  /** GET a JSON document (llama.cpp's /props and /v1/models). */
  fetchJson(url: string): Promise<unknown>;
  /** The MCP servers' connections (#87). */
  mcp: McpManager;
  /** What this device approved of what the synced settings send keys to or run (#136). */
  deviceApprovals: DeviceApprovals;
  /** A line for the plugin's log (the "Show the agent's log" command); the plugin writes nothing to the console. */
  log(line: string): void;
}

/** Append what the user is looking at, so "summarise this" has something to refer to — `_with_context` (ws.py). */
export function withContext(message: string, context: Record<string, unknown> = {}): string {
  let text = message;
  if (typeof context.active_note === "string" && context.active_note) text += `\n\n[Active note: ${context.active_note}]`;
  if (typeof context.selection === "string" && context.selection) text += `\n\n[Selected text]\n${context.selection}`;
  return text;
}

export class InProcessAgent {
  private readonly running = new Map<string, AbortController>();
  /**
   * Turns run one at a time (#177): they share one undo journal, and a turn from the terminal starting beside the
   * chat's would close the chat's journal entry early and take its later changes as its own. A later turn waits.
   */
  private readonly oneAtATime = serially();
  /** Open conversations by session name; "" is the one that is not kept. */
  private readonly conversations = new Map<string, Conversation>();
  /** Titles given to conversations not started yet, by name (#286). */
  private readonly pendingTitles = new Map<string, string>();
  /** Confirmations waiting for the user, by call id, with the turn they belong to. */
  private readonly pending = new Map<string, { turn: string; answer: (approved: boolean) => void }>();
  private journal: Journal | null = null;

  /** What llama.cpp servers said about themselves, by server — asked once per run (resolve_llm_config). */
  private readonly detected: ServerCache = new Map();

  constructor(private readonly app: App, private readonly source: InProcessSource,
              private readonly options: () => Promise<ToolsetOptions>) {}

  /** The agents and connections, for the chat header — the plugin's own (#86). */
  info(): ReadyInfo {
    return this.source.backend.info();
  }

  /** For the conversations' notes: not recorded, as they are written after a turn and are not its changes (#177). */
  private get vault() {
    return obsidianVault(this.app, { record: false });
  }

  // -- turns ---------------------------------------------------------------------------------------------------

  send(prompt: string, options: TurnOptions, handlers: TurnHandlers): string {
    const id = crypto.randomUUID();
    const controller = new AbortController();
    this.running.set(id, controller);
    void this.oneAtATime(async () => {
      // Stopped while it waited: it never starts
      controller.signal.throwIfAborted();
      await this.run(id, prompt, options, handlers, controller.signal);
    })
      .catch((error: unknown) => {
        // A turn stopped halfway is exactly the one you want back: close it in the journal and say what it changed
        const changed = this.closeTurn();
        if (controller.signal.aborted) handlers.onDone("", true, {}, changed, 0);
        else handlers.onError(turnFailure(error), true);
      })
      .finally(() => this.running.delete(id));
    return id;
  }

  cancel(id: string): void {
    this.running.get(id)?.abort();
    // A stopped turn changes nothing more: what it was waiting to be allowed is refused
    for (const [callId, waiting] of this.pending) if (waiting.turn === id) this.confirm(id, callId, false);
  }

  /** The user's answer to a confirmation, from the chat view's dialog. */
  confirm(_turn: string, callId: string, approved: boolean): void {
    const waiting = this.pending.get(callId);
    this.pending.delete(callId);
    waiting?.answer(approved);
  }

  /** Asks through the chat view's dialog, and waits; no answer in time, or a cancelled turn, is a refusal. */
  private asker(turn: string, handlers: TurnHandlers): Confirm {
    return (callId, name, input) => new Promise<boolean>((resolve) => {
      const timer = window.setTimeout(() => this.confirm(turn, callId, false), CONFIRM_TIMEOUT_MS);
      this.pending.set(callId, { turn, answer: (approved) => {
        window.clearTimeout(timer);
        resolve(approved);
      } });
      handlers.onConfirmRequest(callId, name, input);
    });
  }

  /** Close the journal's open turn; what it changed, for the chat view's footer and its undo. */
  private closeTurn(): TurnChanges | null {
    const turn = this.journal?.finish();
    return turn ? { turn: turn.id, files: this.journal!.paths(turn) } : null;
  }

  /**
   * The whole system prompt a turn of *agent* sends: its template filled in, then what the runner appends — the
   * folder restriction, the MCP tools, the features, and the user profile when memory goes into the prompt. One
   * place for turns and for the Agents tab's "Show as sent" (#67), so the preview cannot drift from the real thing.
   */
  private async systemPrompt(agent: { name: string; prompt: string; tools: string[]; vaultScope: string[] },
                             model: string, values: Record<string, unknown>, settings: ToolsetOptions,
                             tools: Tool[]): Promise<{ text: string; unsupported: string[] }> {
    const adapter = this.app.vault.adapter;
    const vaultPath = adapter instanceof FileSystemAdapter ? adapter.getBasePath() : this.app.vault.getName();
    const rendered = renderPrompt(agent.prompt, promptContext(vaultPath, agent.name, model));
    // A restricted agent is told it is, so a note outside its folders is "out of reach", not "does not exist"
    let text = rendered.text + toolConventions(tools.map((tool) => tool.name)) + scopePrompt(agent.vaultScope)
      + mcpPrompt(tools) + featurePrompt(agent.tools, values);
    // What the agent knows about the user, when memory is on and meant for the prompt (runner.py)
    if (settings.memory?.inject) {
      const profileText = await readUserProfile(this.vault, settings.memory.profilePath, settings.memory.maxProfileTokens);
      if (profileText) text += `\n\n---\n## What you know about the user\n\n${profileText}\n---`;
    }
    return { text, unsupported: rendered.unsupported };
  }

  /**
   * *name*'s system prompt as its next turn would send it (#67), with *draft*'s unsaved prompt, tools and folders
   * when given. Nothing runs: the template language has no shell(), and MCP tools come from the listing this device
   * kept, not from starting the servers. The model is the one the agent's connection names, or its server reports.
   */
  async promptAsSent(name: string, draft?: PromptDraft): Promise<PromptAsSent> {
    const saved = await this.source.catalog.get(name);
    if (!saved) throw new Error(`no agent called '${name}'`);
    const agent = {
      ...saved, prompt: draft?.prompt ?? saved.prompt, tools: draft?.tools ?? saved.tools,
      vaultScope: draft?.vault_scope ?? saved.vaultScope,
      llmProfile: draft?.llm_profile === undefined ? saved.llmProfile : (draft.llm_profile ?? ""),
      model: draft?.model === undefined ? saved.model : draft.model,
    };
    const values = this.source.values();
    const known = profileSummaries(values).map((p) => p.name);
    const chosen = agent.llmProfile && known.includes(agent.llmProfile) ? agent.llmProfile : "";
    const resolved = resolveConnection(values, chosen, this.source.env, {
      model: agent.model, temperature: agent.temperature, enableThinking: agent.enableThinking,
      samplingPreset: agent.samplingPreset,
    });
    let model = resolved.model;
    try {
      model = (await detectConnection(resolved, this.source.fetchJson, this.detected)).model;
    } catch {
      // The server is not answering: the model the settings name, if any
    }
    const settings = await this.options();
    const scoped = agent.vaultScope.length > 0;
    const ported = obsidianToolset(this.app, scoped ? agent.vaultScope : null, settings);
    const mcpFromCache = wantsMcp(agent.tools, scoped);
    const mcpTools = mcpFromCache ? this.source.mcp.knownTools(mcpServers(values)) : [];
    const tools = assembleTools(agent.tools, ported, mcpTools, scoped);
    const { text, unsupported } = await this.systemPrompt(agent, model, values, settings, tools);
    return { text, unsupported, model, mcpFromCache };
  }

  private async run(turn: string, prompt: string, options: TurnOptions, handlers: TurnHandlers,
                    signal: AbortSignal): Promise<void> {
    const catalog = this.source.catalog;
    const agent = await catalog.get(options.agent || await catalog.defaultName());
    if (!agent) throw new Error(`no agent called '${options.agent}'`);
    const values = this.source.values();
    if (!hasConnection(values)) throw new Error(NO_CONNECTION);
    // The chat's choice wins; an agent naming a connection that does not exist falls back to the default (runner.py)
    const known = profileSummaries(values).map((p) => p.name);
    const chosen = options.profile || (agent.llmProfile && known.includes(agent.llmProfile) ? agent.llmProfile : "");
    const connection = await detectConnection(resolveConnection(values, chosen, this.source.env, {
      model: agent.model, temperature: agent.temperature, enableThinking: agent.enableThinking,
      samplingPreset: agent.samplingPreset,
    }), this.source.fetchJson, this.detected);
    if (!connection.baseUrl) throw new Error(`the connection '${connection.name || "llm"}' has no server address`);
    // A key written out in the settings is never used: say so, rather than pass on the server's 401 (#146)
    if (!connection.server && writtenOutKey(values, connection.name)) {
      throw new Error(`the connection '${connection.name || "llm"}' has its API key written out in the settings, and `
        + "a key there is never used — keys come only from Obsidian's keychain. Put the key there (Settings → "
        + "Keychain) and pick it as the connection's API key (Settings → Hiro Agent → Connections).");
    }
    // A key goes only where this device approved it to go: the address sits beside the key's name in settings that
    // sync, so another device could have changed it (#136)
    const keyApproval = connectionApproval(values, connection.name);
    if (keyApproval && !this.source.deviceApprovals.approved(keyApproval)) {
      throw new Error(`the connection '${connection.name || "llm"}' ${keyApproval.what}, which this device has not `
        + "approved — the setting may have come from another device. Check it and approve it under Settings → "
        + "Hiro Agent → Connections.");
    }
    if (!connection.model && connection.server !== "llama.cpp") {
      throw new Error(`the connection '${connection.name || "llm"}' names no model, and its server lists none. Set `
                      + "one under Settings → Hiro Agent → Connections.");
    }
    const model = connection.model;
    const profileName = connection.name;
    const settings = await this.options();
    this.installJournal(settings);

    const scoped = agent.vaultScope.length > 0;
    const ported = obsidianToolset(this.app, scoped ? agent.vaultScope : null, settings);
    // MCP servers are asked only for an agent that lists their tools; one that fails is said, and left out
    let mcpTools: Tool[] = [];
    if (wantsMcp(agent.tools, scoped)) {
      const { tools: offered, failures } = await this.source.mcp.agentTools(mcpServers(values));
      mcpTools = offered;
      for (const failure of failures) new Notice(`Hiro Agent: an MCP server is left out of this answer — ${failure}`, 10_000);
    }
    // Exactly the tools the agent lists, in its order — none when it lists none (assemble_tools, runner.py)
    const tools = assembleTools(agent.tools, ported, mcpTools, scoped);
    const { text: systemPrompt } = await this.systemPrompt(agent, model, values, settings, tools);

    const key = options.session || scratchKey(options.view);
    const window = connection.contextWindow;
    const conversation = await this.conversation(key, window, options.keep !== false);
    const llmSettings: LlmSettings = {
      baseUrl: connection.baseUrl, model, apiKey: connection.apiKey, temperature: connection.temperature,
      topP: connection.topP, topK: connection.topK, minP: connection.minP, presencePenalty: connection.presencePenalty,
      repetitionPenalty: connection.repetitionPenalty, maxTokens: connection.maxTokens,
      serviceTier: connection.serviceTier, serviceTierFallback: connection.serviceTierFallback,
      reasoningEffort: connection.reasoningEffort, log: (line) => this.source.log(line),
    };
    const llm: ChatModel = connection.api === "responses" ? new OpenAiResponses(llmSettings) : new OpenAiChat(llmSettings);
    const started = Date.now();
    // Summarised by size in the window (#154): before the request when the history no longer fits well — another,
    // smaller model chosen, say — and after the answer when the conversation has grown past the share
    let compacted = 0;
    const estimate = (): number => estimateMessages([{ content: systemPrompt }, ...conversation.loaded]);
    // Each summary is told to the chat, which marks the place with a divider and shows the text on demand
    const summarise = async (when: "before" | "after"): Promise<number> => {
      const exchanges = await this.compact(conversation, llm, window);
      const summary = splitHistory(conversation.loaded).summary;
      if (exchanges && summary) handlers.onSummary?.(exchanges, summary, when);
      return exchanges;
    };
    if (dueForCompaction(estimate(), window)) compacted += await summarise("before");
    this.journal?.begin(prompt);
    let toolCalls = 0;
    let peak = 0;
    // This answer's calls, for its conversation's note when the setting is on (#282)
    const calls = new Map<string, SavedCall>();
    const inputs = new Map<string, { name: string; input: unknown }>();
    const attempt = (): ReturnType<typeof runTurn> => runTurn({
      model: llm, tools, systemPrompt, prompt: withContext(prompt, options.context),
      history: conversation.loaded,
      maxIterations: agent.maxIterations || DEFAULT_MAX_ITERATIONS,
      thinking: connection.enableThinking, signal, confirm: this.asker(turn, handlers),
      maxToolResultChars: Math.floor(window * TOOL_RESULT_SHARE * CHARS_PER_TOKEN),
      contextWindow: window,
      events: {
        // The most the answer took along the way, for the meter's tooltip (#154); and the meter follows each request
        // while the answer runs, so a long answer shows the window filling (2026-10-06)
        onUsage: (tokens, estimated) => {
          peak = Math.max(peak, tokens);
          handlers.onContext?.(tokens, window, estimated, peak, true);
        },
        onSetAside: (total) => handlers.onSetAside?.(total),
        onServiceTier: (tier) => handlers.onServiceTier?.(tier),
        onToken: handlers.onToken,
        onThinking: handlers.onThinking,
        onToolCall: (callId, name, input) => {
          toolCalls += 1;
          inputs.set(callId, { name, input });
          handlers.onToolCall({ callId, name, input });
        },
        onToolResult: (callId, result, isError) => {
          const call = inputs.get(callId);
          if (call) calls.set(callId, savedCall(call.name, call.input, result, isError));
          handlers.onToolResult?.(callId, result, isError);
        },
      },
    });
    // The conversation outgrew the window before anything ran: summarised, and asked once more
    const retried = await retryAfterCompaction(attempt, () => summarise("before"), () => toolCalls > 0);
    const result = retried.result;
    compacted += retried.compacted;
    // Closed before the conversation is saved: the session note is not one of the turn's changes
    const changed = this.closeTurn();
    conversation.loaded = result.history as SessionMessage[];
    const answer = conversation.loaded[conversation.loaded.length - 1];
    if (settings.saveToolCalls && calls.size && answer?.role === "assistant") conversation.calls.set(answer, [...calls.values()]);
    conversation.last = { agent: agent.name, model, connection: profileName };
    await this.save(conversation);
    // By what the next message carries — the questions and answers, not this answer's tool results, which are not
    // kept: one answer that read many notes does not make the conversation long
    if (conversation.pendingCompact || dueForCompaction(estimate(), window)) {
      const summarised = await summarise("after");
      compacted += summarised;
    }
    // What the next message carries, after any summary: the measure the summary goes by, so the meter and it agree
    handlers.onContext?.(estimate(), window, true, peak);
    const seconds = Math.round((Date.now() - started) / 100) / 10;
    handlers.onDone(result.reply, false, { tool_calls: result.toolCalls, seconds }, changed, compacted);
  }

  /** Journal the vault's writes from now on, as the runtime's journal settings say (AgentSession.__aenter__). */
  private installJournal(settings: ToolsetOptions): void {
    if (!settings.journal.enabled) {
      this.journal = null;
      setRecorder(null);
      return;
    }
    if (!this.journal) this.journal = new Journal(settings.journal.turns, settings.journal.maxBytes);
    const journal = this.journal;
    setRecorder((change) => journal.record(change));
  }

  // -- conversations -------------------------------------------------------------------------------------------

  /**
   * The open conversation for *key*; a kept one is loaded from its note, newest messages within the budget. One
   * that is not *kept* has no name, so nothing is ever written for it (agent:ask keep=false, the benchmark).
   */
  private async conversation(key: string, contextWindow: number, keep = true): Promise<Conversation> {
    const open = this.conversations.get(key);
    if (open) return open;
    // A view's own unkept conversation (scratchKey) is never named, so never written
    const named = keep && key && !key.startsWith("\u0000");
    const conversation: Conversation = { name: named ? key : null, loaded: [], unloaded: [], connections: [],
                                         pendingCompact: false, calls: new Map(),
                                         title: this.pendingTitles.get(key) };
    this.pendingTitles.delete(key);
    if (conversation.name) await this.load(conversation, contextWindow);
    this.conversations.set(key, conversation);
    return conversation;
  }

  private async load(conversation: Conversation, contextWindow: number): Promise<void> {
    const name = conversation.name!;
    const all = await loadSessionWithCalls(this.vault, name);
    const recent = await loadSessionWithCalls(this.vault, name, Math.floor(contextWindow * HISTORY_SHARE));
    const full = all.messages.filter((m) => m.role !== "system");
    const loaded = recent.messages;
    const kept = loaded.filter((m) => m.role !== "system").length;
    conversation.loaded = loaded;
    conversation.unloaded = full.slice(0, full.length - kept);
    // The saved calls stay with their answers, whichever list holds them; they are never part of the history sent
    conversation.calls = new Map([...all.calls, ...recent.calls]);
    const history = (await sessionMeta(this.vault, name)).connections;
    conversation.connections = Array.isArray(history) ? history as ConnectionChange[] : [];
  }

  /** Write a kept conversation to its note, with which connection answered from which exchange on. */
  private async save(conversation: Conversation): Promise<void> {
    if (!conversation.name || !conversation.last) return;
    const messages = [...conversation.unloaded, ...conversation.loaded.filter((m) => m.role !== "system")];
    const { agent, model, connection } = conversation.last;
    const exchange = messages.filter((m) => m.role === "user").length;
    const latest = conversation.connections[conversation.connections.length - 1];
    if (exchange && (!latest || latest.connection !== connection || latest.model !== model)) {
      conversation.connections.push({ exchange, connection, model });
    }
    await saveSession(this.vault, conversation.name, messages,
                      { agent, model, connection, connections: conversation.connections, calls: conversation.calls,
                        title: conversation.title });
    if (Math.floor(messages.length / 2) >= COMPACT_AFTER_EXCHANGES) conversation.pendingCompact = true;
  }

  /**
   * Summarise the old part of a conversation with the model that answered — `compact_if_due`, by size since #154:
   * the newest exchanges that fit in KEEP_SHARE of the window stay word for word. A kept conversation is summarised
   * in its note and read back; one that is not kept, in memory. A failure is swallowed: a conversation that could
   * not be summarised is still a conversation. Returns how many exchanges were summarised.
   */
  private async compact(conversation: Conversation, llm: ChatModel, contextWindow: number): Promise<number> {
    conversation.pendingCompact = false;
    try {
      const summarize = async (text: string): Promise<string> =>
        (await llm.complete({ messages: [{ role: "user", content: text }], tools: [], thinking: false }, {})).content;
      if (!conversation.name) {
        const done = await compactHistory(conversation.loaded, summarize, contextWindow);
        if (!done) return 0;
        conversation.loaded = done.history;
        return done.compacted;
      }
      const { pairs } = splitHistory([...conversation.unloaded, ...conversation.loaded]);
      const keep = recentThatFit(pairs, Math.floor(contextWindow * KEEP_SHARE));
      const compacted = await compactSession(this.vault, conversation.name, summarize, keep,
                                             summariseLimit(contextWindow));
      // Without this, the next save writes the full history back and undoes the compaction
      if (compacted) await this.load(conversation, contextWindow);
      return compacted;
    } catch (error) {
      this.source.log(`could not summarise the conversation ${conversation.name}: `
                      + (error instanceof Error ? error.message : String(error)));
      return 0;
    }
  }

  /** A new conversation that is not kept starts empty: chat view *view*'s, leaving the other views' alone (#153). */
  forget(view?: string): void {
    this.conversations.delete(scratchKey(view));
  }

  async sessions(): Promise<SessionSummary[]> {
    return listSessions(this.vault);
  }

  /** A conversation's messages and the connection that answered it last — as `GET /sessions/{name}`. */
  async session(name: string): Promise<{ messages: { role: string; content: string; calls?: SavedCall[] }[]; connection?: string;
                                         model?: string; connection_exists?: boolean;
                                         summary?: { text: string; exchanges: number } }> {
    const { messages, calls } = await loadSessionWithCalls(this.vault, name);
    if (!messages.length && !(await this.vault.isFile(`.sessions/${sanitiseName(name)}.md`))) {
      throw new Error(`no session '${name}'`);
    }
    const meta = await sessionMeta(this.vault, name);
    const connection = String(meta.connection ?? "");
    const profiles = profileSummaries(this.source.values());
    // The summary is not a message: the chat shows it as a divider, its text on demand (#154)
    const { summary } = splitHistory(messages);
    return {
      messages: messages.filter((m) => m.role !== "system")
        .map((m) => ({ role: m.role === "user" ? "user" : "assistant", content: m.content,
                       ...(calls.get(m) ? { calls: calls.get(m) } : {}) })),
      connection, model: String(meta.model ?? ""),
      connection_exists: Boolean(connection) && profiles.some((p) => p.name === connection),
      ...(summary !== null ? { summary: { text: summary, exchanges: Number(meta.compacted_exchanges ?? 0) } } : {}),
    };
  }

  async deleteSession(name: string): Promise<{ ok: boolean }> {
    const ok = await deleteSession(this.vault, name);
    // Its messages go with the note, so a later turn with this name starts the conversation again
    this.conversations.delete(name);
    return { ok };
  }

  /**
   * Start or stop keeping the conversation that is open, without losing it — `name_session` (ws.py). Naming one
   * takes its messages along and writes the note at once; unnaming stops saving and leaves the note alone.
   */
  /**
   * Call conversation *name* *title* (#286): in its note when there is one, and with the next save. The name, the
   * note's file name, stays. A blank title takes the title away. A conversation not started yet gets it when it is.
   */
  async titleSession(name: string, title: string): Promise<void> {
    const wanted = title.trim();
    const open = this.conversations.get(name);
    if (open) open.title = wanted || undefined;
    else if (wanted) this.pendingTitles.set(name, wanted);
    else this.pendingTitles.delete(name);
    await setSessionTitle(this.vault, name, wanted);
  }

  nameSession(current: string, name: string, view?: string): void {
    // An unkept conversation is the view's own (#153): "" stands for it on either side
    const from = current || scratchKey(view);
    const to = name || scratchKey(view);
    const conversation = this.conversations.get(from);
    if (!conversation || from === to) return;
    this.conversations.delete(from);
    conversation.name = name || null;
    this.conversations.set(to, conversation);
    if (name) void this.save(conversation);
  }

  // -- the journal ---------------------------------------------------------------------------------------------

  async turns(): Promise<{ journalling: boolean; turns: TurnSummary[] }> {
    if (!this.journal) return { journalling: false, turns: [] };
    return { journalling: true, turns: this.journal.turns().reverse().map((turn) => this.summary(turn)) };
  }

  private summary(turn: Turn): TurnSummary {
    return { id: turn.id, prompt: turn.prompt, started: turn.started.toISOString(), files: this.journal!.paths(turn),
             undone: turn.undone };
  }

  private found(id: string): Turn {
    const turn = this.journal?.find(id);
    if (!turn) throw new Error("what that answer changed is no longer kept for undo");
    return turn;
  }

  async turnDiff(id: string): Promise<{ files: string[]; diff: string; undone: boolean; stale: string[] }> {
    const turn = this.found(id);
    const stale: string[] = [];
    // Which files undo would refuse, asked before the user decides rather than reported after
    for (const change of turn.changes) {
      const target = change.movedTo ?? change.path;
      const now = (await this.vault.isFile(target)) ? await this.vault.read(target) : null;
      if (now !== change.after) stale.push(target);
    }
    return { files: this.journal!.paths(turn), diff: this.journal!.diff(turn), undone: turn.undone, stale };
  }

  /**
   * Go back to before an earlier message (#303): what the answers *turns* changed is taken back, newest first, then
   * the conversation loses its last *exchanges* questions and answers — in its note when it is kept, in memory when
   * not. In the queue of answers, so it never runs beside one.
   */
  async rewind(target: { session?: string; view?: string }, exchanges: number,
               turns: string[]): Promise<RewindResult & { removed: number }> {
    return this.oneAtATime(async () => {
      const result = await undoTurns(this.journal, this.vault, turns);
      const name = target.session;
      if (!name) {
        const conversation = this.conversations.get(scratchKey(target.view));
        const before = conversation?.loaded.filter((m) => m.role === "user").length ?? 0;
        if (conversation) conversation.loaded = withoutLast(conversation.loaded, exchanges);
        const after = conversation?.loaded.filter((m) => m.role === "user").length ?? 0;
        return { ...result, removed: before - after };
      }
      // A kept conversation is cut in its note, and read again from it at the next message
      this.conversations.delete(name);
      const { messages, calls } = await loadSessionWithCalls(this.vault, name);
      const said = messages.filter((m) => m.role !== "system");
      const kept = withoutLast(said, exchanges);
      const meta = await sessionMeta(this.vault, name);
      const count = kept.filter((m) => m.role === "user").length;
      const connections = (Array.isArray(meta.connections) ? meta.connections as ConnectionChange[] : [])
        .filter((change) => change.exchange <= count);
      await saveSession(this.vault, name, kept, {
        agent: String(meta.agent ?? ""), model: String(meta.model ?? ""), connection: String(meta.connection ?? ""),
        connections, calls,
      });
      return { ...result, removed: said.filter((m) => m.role === "user").length - count };
    });
  }

  async undoTurn(id: string): Promise<UndoResult> {
    const turn = this.found(id);
    if (turn.undone) {
      return { ok: false, undone: true, restored: [], refused: [{ path: "", reason: "what this answer changed is already undone" }] };
    }
    const result = await this.journal!.undo(turn, this.vault);
    return { ok: result.restored.length > 0 && !result.refused.length, undone: turn.undone, restored: result.restored,
             refused: result.refused };
  }
}
