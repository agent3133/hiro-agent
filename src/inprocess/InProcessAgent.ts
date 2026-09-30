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

import type { ReadyInfo, SessionSummary, TurnChanges, TurnHandlers, TurnSummary, UndoResult } from "../api/types";
import type { AgentCatalog } from "../config/agents";
import type { PluginBackend } from "../config/backend";
import { detectLlamaCpp, hasConnection, NO_CONNECTION, profileSummaries, resolveConnection } from "../config/connections";
import { runTurn, turnFailure, type Confirm } from "../core/agentLoop";
import { Journal, type Turn } from "../core/journal";
import { OpenAiChat, type ChatModel } from "../core/llm/openaiChat";
import { scopePrompt } from "../core/paths";
import { promptContext, renderPrompt } from "../core/prompt";
import {
  compactSession, deleteSession, listSessions, loadSession, saveSession, sessionMeta, sanitiseName,
  type ConnectionChange, type SessionMessage,
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
const HISTORY_SHARE = 0.2;
/**
 * One tool result may fill at most this share of the context window, counted at three characters a token — few
 * enough that a page in any language fits. A long web page is cut rather than ending the turn.
 */
const TOOL_RESULT_SHARE = 0.25;
const CHARS_PER_TOKEN = 3;
/** Conversations longer than this many exchanges are summarised after the turn (AgentSession.save_session). */
const COMPACT_AFTER_EXCHANGES = 50;

interface TurnOptions {
  agent?: string;
  session?: string;
  profile?: string;
  context?: Record<string, unknown>;
  /** false: the conversation is kept in memory under `session` for follow-ups, but never written to a note. */
  keep?: boolean;
}

/** One conversation: what goes into the next prompt, what is only in its note, and who answered it. */
interface Conversation {
  name: string | null;
  loaded: SessionMessage[];
  unloaded: SessionMessage[];
  connections: ConnectionChange[];
  pendingCompact: boolean;
  last?: { agent: string; model: string; connection: string };
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
  /** Open conversations by session name; "" is the one that is not kept. */
  private readonly conversations = new Map<string, Conversation>();
  /** Confirmations waiting for the user, by call id, with the turn they belong to. */
  private readonly pending = new Map<string, { turn: string; answer: (approved: boolean) => void }>();
  private journal: Journal | null = null;

  /** What llama.cpp servers said about themselves, by server — asked once per run (resolve_llm_config). */
  private readonly detected = new Map<string, { model?: string; contextWindow?: number; thinking?: boolean }>();

  constructor(private readonly app: App, private readonly source: InProcessSource,
              private readonly options: () => Promise<ToolsetOptions>) {}

  /** The agents and connections, for the chat header — the plugin's own (#86). */
  info(): ReadyInfo {
    return this.source.backend.info();
  }

  private get vault() {
    return obsidianVault(this.app);
  }

  // -- turns ---------------------------------------------------------------------------------------------------

  send(prompt: string, options: TurnOptions, handlers: TurnHandlers): string {
    const id = crypto.randomUUID();
    const controller = new AbortController();
    this.running.set(id, controller);
    void this.run(id, prompt, options, handlers, controller.signal)
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

  connected(): boolean {
    return true;
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
    const connection = await detectLlamaCpp(resolveConnection(values, chosen, this.source.env, {
      model: agent.model, temperature: agent.temperature, enableThinking: agent.enableThinking,
      samplingPreset: agent.samplingPreset,
    }), this.source.fetchJson, this.detected);
    if (!connection.baseUrl) throw new Error(`the connection '${connection.name || "llm"}' has no server address`);
    if (!connection.model && connection.provider !== "llamacpp") {
      throw new Error(`the connection '${connection.name || "llm"}' names no model. Set one under Settings → Hiro Agent `
                      + "→ General → Connections.");
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
      for (const failure of failures) new Notice(`Hiro Agent: an MCP server is left out of this turn — ${failure}`, 10_000);
    }
    // Exactly the tools the agent lists, in its order — none when it lists none (assemble_tools, runner.py)
    const tools = assembleTools(agent.tools, ported, mcpTools, scoped);
    const adapter = this.app.vault.adapter;
    const vaultPath = adapter instanceof FileSystemAdapter ? adapter.getBasePath() : this.app.vault.getName();
    let { text: systemPrompt } = renderPrompt(agent.prompt, promptContext(vaultPath, agent.name, model));
    // A restricted agent is told it is, so a note outside its folders is "out of reach", not "does not exist"
    systemPrompt += scopePrompt(agent.vaultScope) + mcpPrompt(tools);
    // What the agent knows about the user, when memory is on and meant for the prompt (runner.py)
    if (settings.memory?.inject) {
      const profileText = await readUserProfile(this.vault, settings.memory.profilePath, settings.memory.maxProfileTokens);
      if (profileText) systemPrompt += `\n\n---\n## What you know about the user\n\n${profileText}\n---`;
    }

    const key = options.session || "";
    const conversation = await this.conversation(key, connection.contextWindow, options.keep !== false);
    const llm: ChatModel = new OpenAiChat({
      baseUrl: connection.baseUrl, model, apiKey: connection.apiKey, temperature: connection.temperature,
      topP: connection.topP, topK: connection.topK, minP: connection.minP, presencePenalty: connection.presencePenalty,
      repetitionPenalty: connection.repetitionPenalty, maxTokens: connection.maxTokens,
    });
    const started = Date.now();
    this.journal?.begin(prompt);
    const result = await runTurn({
      model: llm, tools, systemPrompt, prompt: withContext(prompt, options.context),
      history: conversation.loaded,
      maxIterations: agent.maxIterations || DEFAULT_MAX_ITERATIONS,
      thinking: connection.enableThinking, signal, confirm: this.asker(turn, handlers),
      maxToolResultChars: Math.floor(connection.contextWindow * TOOL_RESULT_SHARE * CHARS_PER_TOKEN),
      events: {
        onToken: handlers.onToken,
        onThinking: handlers.onThinking,
        onToolCall: (callId, name, input) => handlers.onToolCall({ callId, name, input }),
        onToolResult: handlers.onToolResult,
      },
    });
    // Closed before the conversation is saved: the session note is not one of the turn's changes
    const changed = this.closeTurn();
    conversation.loaded = result.history as SessionMessage[];
    conversation.last = { agent: agent.name, model, connection: profileName };
    await this.save(conversation);
    const compacted = await this.compactIfDue(conversation, llm, connection.contextWindow);
    const seconds = Math.round((Date.now() - started) / 100) / 10;
    handlers.onDone(result.reply, false, { tool_calls: result.toolCalls, seconds, in_plugin: true }, changed, compacted);
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
    const conversation: Conversation = { name: keep && key ? key : null, loaded: [], unloaded: [], connections: [],
                                         pendingCompact: false };
    if (conversation.name) await this.load(conversation, contextWindow);
    this.conversations.set(key, conversation);
    return conversation;
  }

  private async load(conversation: Conversation, contextWindow: number): Promise<void> {
    const name = conversation.name!;
    const full = (await loadSession(this.vault, name)).filter((m) => m.role !== "system");
    const loaded = await loadSession(this.vault, name, Math.floor(contextWindow * HISTORY_SHARE));
    const kept = loaded.filter((m) => m.role !== "system").length;
    conversation.loaded = loaded;
    conversation.unloaded = full.slice(0, full.length - kept);
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
                      { agent, model, connection, connections: conversation.connections });
    if (Math.floor(messages.length / 2) >= COMPACT_AFTER_EXCHANGES) conversation.pendingCompact = true;
  }

  /**
   * Summarise the old part of a long kept conversation with the model that answered — `compact_if_due`. A failure
   * is swallowed: a conversation that could not be summarised is still a conversation.
   */
  private async compactIfDue(conversation: Conversation, llm: ChatModel, contextWindow: number): Promise<number> {
    if (!conversation.name || !conversation.pendingCompact) return 0;
    conversation.pendingCompact = false;
    try {
      const summarize = async (text: string): Promise<string> =>
        (await llm.complete({ messages: [{ role: "user", content: text }], tools: [], thinking: false }, {})).content;
      const compacted = await compactSession(this.vault, conversation.name, summarize);
      // Without this, the next save writes the full history back and undoes the compaction
      if (compacted) await this.load(conversation, contextWindow);
      return compacted;
    } catch (error) {
      this.source.log(`could not summarise the conversation ${conversation.name}: `
                      + (error instanceof Error ? error.message : String(error)));
      return 0;
    }
  }

  /** A new conversation that is not kept starts empty. */
  forget(session = ""): void {
    this.conversations.delete(session);
  }

  async sessions(): Promise<SessionSummary[]> {
    return listSessions(this.vault);
  }

  /** A conversation's messages and the connection that answered it last — as `GET /sessions/{name}`. */
  async session(name: string): Promise<{ messages: { role: string; content: string }[]; connection?: string;
                                         model?: string; connection_exists?: boolean }> {
    const messages = await loadSession(this.vault, name);
    if (!messages.length && !(await this.vault.isFile(`.sessions/${sanitiseName(name)}.md`))) {
      throw new Error(`no session '${name}'`);
    }
    const meta = await sessionMeta(this.vault, name);
    const connection = String(meta.connection ?? "");
    const profiles = profileSummaries(this.source.values());
    return {
      messages: messages.map((m) => ({ role: m.role === "user" ? "user" : "assistant", content: m.content })),
      connection, model: String(meta.model ?? ""),
      connection_exists: Boolean(connection) && profiles.some((p) => p.name === connection),
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
  nameSession(current: string, name: string): void {
    const conversation = this.conversations.get(current);
    if (!conversation || current === name) return;
    this.conversations.delete(current);
    conversation.name = name || null;
    this.conversations.set(name, conversation);
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
    if (!turn) throw new Error("that turn is no longer in the journal");
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

  async undoTurn(id: string): Promise<UndoResult> {
    const turn = this.found(id);
    if (turn.undone) {
      return { ok: false, undone: true, restored: [], refused: [{ path: "", reason: "this turn has already been taken back" }] };
    }
    const result = await this.journal!.undo(turn, this.vault);
    return { ok: result.restored.length > 0 && !result.refused.length, undone: turn.undone, restored: result.restored,
             refused: result.refused };
  }
}
