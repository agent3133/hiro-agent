/**
 * Conversations kept as vault notes in `.sessions/` — ported from src/obsidian_agent/session/memory.py (#85), in the
 * same format, so a conversation the Python runtime saved opens in the plugin and the other way round:
 *
 *     ---
 *     session: my-conversation
 *     agent: assistant
 *     ...
 *     ---
 *
 *     <!-- session-summary -->        (after compaction)
 *     ...
 *     <!-- /session-summary -->
 *
 *     <!-- session-message: human -->
 *     What is due this week?
 *
 *     <!-- session-message: assistant -->
 *     ...
 *
 * Difference from Python, on purpose: compaction keeps the note's connection and its history (Python dropped them,
 * so a compacted conversation forgot which connection answered it).
 */

import { Document, parseDocument, Scalar, visit } from "yaml";

import { SUMMARY_PREFIX, summaryPrompt } from "./compaction";
import { readFrontmatter } from "./frontmatter";
import type { ChatMessage } from "./llm/openaiChat";
import { redactSecrets } from "./redact";
import type { VaultPort } from "./vault";

export const SESSION_DIR = ".sessions";
const HUMAN = "<!-- session-message: human -->";
const ASSISTANT = "<!-- session-message: assistant -->";
const SUMMARY_START = "<!-- session-summary -->";
const SUMMARY_END = "<!-- /session-summary -->";
/** Where the connection that answered changed; rendered on every save, skipped on load. */
const CONNECTION_MARK = /<!-- session-connection: [^\n]*? -->/g;

/** An answer's tool calls, before its text (#282); taken out again on load, so the model never sees them. */
const TOOLS_START = "<!-- session-tools -->";
const TOOLS_END = "<!-- /session-tools -->";
/** How much of a call's result the note keeps: enough to see what came back, not a copy of what was read. */
const SAVED_RESULT_CHARS = 500;
const SAVED_ARGS_CHARS = 300;

/** A user or assistant message; the summary of a compacted conversation comes back as a system message. */
export type SessionMessage = Extract<ChatMessage, { role: "system" | "user" | "assistant" }>;

/** A tool call kept with the answer it led to (#282). */
export interface SavedCall {
  name: string;
  /** The arguments as JSON, cut to SAVED_ARGS_CHARS. */
  args: string;
  /** The result as text, cut to SAVED_RESULT_CHARS, the full length named. */
  result: string;
  error: boolean;
}

/** Each answer's tool calls, by the answer's message object. */
export type CallsByAnswer = Map<SessionMessage, SavedCall[]>;

/** A call as the note keeps it: its arguments and result cut short, an image's bytes not at all. */
export function savedCall(name: string, input: unknown, result: string, error: boolean): SavedCall {
  const cut = (text: string, limit: number): string =>
    text.length > limit ? `${text.slice(0, limit)}… [${text.length} characters]` : text;
  let args: string;
  try {
    args = JSON.stringify(input ?? {});
  } catch {
    args = "{}";
  }
  return { name, args: cut(args, SAVED_ARGS_CHARS), result: cut(result.replace(/data:[^;\s]+;base64,\S+/g, "[image]"), SAVED_RESULT_CHARS), error };
}

/** An answer's calls as folded callouts, one per call, between the tools marks. */
function renderCalls(calls: SavedCall[]): string {
  const callouts = calls.map((call) => {
    const head = `> [!tool]- ${call.name} ${call.args}${call.error ? " — failed" : ""}`;
    const body = call.result.split("\n").map((line) => (line ? `> ${line}` : ">"));
    return [head, ...body].join("\n");
  });
  return `${TOOLS_START}\n${callouts.join("\n\n")}\n${TOOLS_END}`;
}

/** The calls a tools block holds; what is not a callout is left out. */
function parseCalls(block: string): SavedCall[] {
  const calls: SavedCall[] = [];
  for (const callout of block.split(/\n\s*\n/)) {
    const lines = callout.trim().split("\n");
    const head = /^> \[!tool\]- (\S+) (.*?)( — failed)?$/.exec(lines[0] ?? "");
    if (!head) continue;
    calls.push({ name: head[1], args: head[2], error: Boolean(head[3]),
                 result: lines.slice(1).map((line) => line.replace(/^> ?/, "")).join("\n") });
  }
  return calls;
}

/** An assistant message's text without its tools block, and the calls the block held. */
function splitCalls(content: string): { content: string; calls: SavedCall[] } {
  const match = new RegExp(`^${escape(TOOLS_START)}\\n([\\s\\S]*?)\\n${escape(TOOLS_END)}\\s*`).exec(content);
  if (!match) return { content, calls: [] };
  return { content: content.slice(match[0].length).trim(), calls: parseCalls(match[1]) };
}

export interface ConnectionChange { exchange: number; connection: string; model: string }

export interface SessionSummary {
  name: string;
  /** What the user called it (#286); none until they rename it. */
  title?: string;
  agent: string;
  model: string;
  connection?: string;
  exchanges: number;
  updated: string;
}

/** How a connection reads in a note: 'cloud · gpt-5.4-mini' — `connection_label`. */
export function connectionLabel(connection: string | null | undefined, model: string | null | undefined): string {
  return [connection || "without a connection profile", model].filter(Boolean).join(" · ");
}

export function sanitiseName(name: string): string {
  // One file in .sessions/: a slash or a leading dot would reach another folder, or out of the vault (#135)
  const cleaned = name.trim().toLowerCase().replace(/ /g, "-").replace(/[\\/]+/g, "-").replace(/^\.+/, "");
  return cleaned || "session";
}

export function sessionPath(name: string): string {
  return `${SESSION_DIR}/${sanitiseName(name)}.md`;
}

/**
 * Give a kept conversation a title (#286): what the user typed, as typed, in its note's frontmatter. The note keeps
 * its file name, which is the conversation's identifier; a blank title takes the title away again. A conversation
 * not written yet gets it with its first save (SaveOptions.title).
 */
export async function setSessionTitle(vault: VaultPort, name: string, title: string): Promise<void> {
  const path = sessionPath(name);
  if (!(await vault.isFile(path))) return;
  const text = await readNote(vault, path);
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!match) return;
  const document = parseDocument(match[1]);
  if (title.trim()) document.set("title", title.trim());
  else document.delete("title");
  await vault.write(path, `---\n${document.toString({ lineWidth: 0, indentSeq: false })}---\n${text.slice(match[0].length)}`);
}

/** Python's `datetime.now().isoformat(timespec="seconds")`. */
function now(): string {
  const d = new Date();
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/**
 * YAML as PyYAML's `yaml.dump(..., sort_keys=False)` writes it for these notes: block style, and strings that would
 * read back as something else — a timestamp, a number, nothing — in single quotes.
 */
function dumpYaml(data: Record<string, unknown>): string {
  const document = new Document(data);
  visit(document, {
    Scalar(_key, node) {
      if (typeof node.value !== "string") return;
      const text = node.value;
      if (text === "" || /^\d{4}-\d\d-\d\d/.test(text) || /^[-+]?(\d+\.?\d*|\.\d+)$/.test(text)
          || /^(true|false|yes|no|null|on|off|~)$/i.test(text)) {
        (node as Scalar).type = Scalar.QUOTE_SINGLE;
      }
    },
  });
  return document.toString({ lineWidth: 0, indentSeq: false });
}

/**
 * A session note's text with CRLF read as LF, as Python's text mode reads it: the runtime writes its notes with
 * the platform's line endings, so a note it wrote on Windows has CRLF.
 */
async function readNote(vault: VaultPort, path: string): Promise<string> {
  return (await vault.read(path)).replace(/\r\n/g, "\n");
}

function frontmatterOf(text: string): Record<string, unknown> {
  return /^---\n[\s\S]*?\n---\n/.test(text) ? readFrontmatter(text).data : {};
}

function summaryOf(text: string): string | null {
  const match = new RegExp(`${escape(SUMMARY_START)}\\n([\\s\\S]*?)\\n${escape(SUMMARY_END)}`).exec(text);
  return match ? match[1].trim() : null;
}

/** A message's text as the note keeps it: an answer with its tool calls first, secrets redacted in both. */
function withCalls(message: SessionMessage, calls?: CallsByAnswer): string {
  const saved = message.role === "assistant" ? calls?.get(message) : undefined;
  const text = saved?.length ? `${renderCalls(saved)}\n\n${message.content}` : message.content;
  return redactSecrets(text);
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface SaveOptions {
  agent: string;
  model: string | null;
  connection?: string | null;
  connections?: ConnectionChange[];
  /** The title to give it (#286); without one, a title the note has already stays. */
  title?: string;
  /** Each answer's tool calls, written before its text (#282); an answer without any is written as before. */
  calls?: CallsByAnswer;
}

/** Write the conversation to its note, keeping its created time, title and summary — `save_session`. */
export async function saveSession(vault: VaultPort, name: string, messages: SessionMessage[],
                                  options: SaveOptions): Promise<void> {
  const path = sessionPath(name);
  const stamp = now();
  let created = stamp;
  let title = options.title;
  let summary: string | null = null;
  let compactedAt: string | undefined;
  let compactedExchanges: number | undefined;
  if (await vault.isFile(path)) {
    const existing = await readNote(vault, path);
    const meta = frontmatterOf(existing);
    if (meta.created !== undefined) created = String(meta.created);
    if (title === undefined && typeof meta.title === "string") title = meta.title;
    if (meta.compacted_at !== undefined) compactedAt = String(meta.compacted_at);
    if (meta.compacted_exchanges !== undefined) compactedExchanges = Number(meta.compacted_exchanges);
    summary = summaryOf(existing);
  }
  const conversation = messages.filter((m) => m.role !== "system");
  const frontmatter: Record<string, unknown> = {
    session: sanitiseName(name), agent: options.agent, model: options.model ?? "", connection: options.connection ?? "",
    created, updated: stamp, exchanges: conversation.filter((m) => m.role === "user").length,
  };
  if (title) frontmatter.title = title;
  if (options.connections?.length) frontmatter.connections = options.connections;
  if (compactedAt !== undefined) frontmatter.compacted_at = compactedAt;
  if (compactedExchanges !== undefined) frontmatter.compacted_exchanges = compactedExchanges;

  const parts = [`---\n${dumpYaml(frontmatter)}---\n`];
  if (summary !== null) parts.push(`\n${SUMMARY_START}\n${summary}\n${SUMMARY_END}\n`);
  // A mark before the exchange where the connection changed; the first entry is where it started, not a change
  const marks = new Map((options.connections ?? []).slice(1).map((c) => [c.exchange, connectionLabel(c.connection, c.model)]));
  let exchange = 0;
  for (const message of conversation) {
    if (message.role === "user") {
      exchange += 1;
      const mark = marks.get(exchange);
      if (mark) parts.push(`\n<!-- session-connection: ${mark} -->\n`);
    }
    // The note syncs with the vault; a key pasted into the chat does not go with it
    parts.push(`\n${message.role === "user" ? HUMAN : ASSISTANT}\n${withCalls(message, options.calls)}\n`);
  }
  await vault.write(path, parts.join(""));
}

/**
 * The conversation's messages; with *tokenBudget*, only the newest that fit (4 characters a token), the summary
 * always first as a system message — `load_session`.
 */
export async function loadSession(vault: VaultPort, name: string, tokenBudget?: number): Promise<SessionMessage[]> {
  return (await loadSessionWithCalls(vault, name, tokenBudget)).messages;
}

/**
 * loadSession, with each answer's saved tool calls (#282) by its message. The calls are taken out of the answers'
 * text, so the messages, and what the model gets back, are the same with or without them.
 */
export async function loadSessionWithCalls(vault: VaultPort, name: string, tokenBudget?: number):
    Promise<{ messages: SessionMessage[]; calls: CallsByAnswer }> {
  const calls: CallsByAnswer = new Map();
  const path = sessionPath(name);
  if (!(await vault.isFile(path))) return { messages: [], calls };
  let text = (await readNote(vault, path)).replace(/^---\n[\s\S]*?\n---\n/, "");
  const summaryMatch = new RegExp(`${escape(SUMMARY_START)}\\n([\\s\\S]*?)\\n${escape(SUMMARY_END)}`).exec(text);
  let summary: string | null = null;
  if (summaryMatch) {
    summary = summaryMatch[1].trim();
    text = text.slice(0, summaryMatch.index) + text.slice(summaryMatch.index + summaryMatch[0].length);
  }
  text = text.replace(CONNECTION_MARK, "");
  const pieces = text.split(new RegExp(`(${escape(HUMAN)}|${escape(ASSISTANT)})`));
  let messages: SessionMessage[] = [];
  for (let i = 0; i < pieces.length; i++) {
    if (pieces[i] !== HUMAN && pieces[i] !== ASSISTANT) continue;
    const text = (pieces[i + 1] ?? "").trim();
    if (pieces[i] === HUMAN) {
      messages.push({ role: "user", content: text });
    } else {
      const { content, calls: saved } = splitCalls(text);
      const message: SessionMessage = { role: "assistant", content };
      messages.push(message);
      if (saved.length) calls.set(message, saved);
    }
    i += 1;
  }
  if (tokenBudget !== undefined) {
    let remaining = tokenBudget - (summary !== null ? Math.floor(summary.length / 4) : 0);
    const kept: SessionMessage[] = [];
    for (const message of [...messages].reverse()) {
      if (remaining <= 0) break;
      kept.push(message);
      remaining -= Math.floor(message.content.length / 4);
    }
    messages = kept.reverse();
  }
  return { messages: summary !== null ? [{ role: "system", content: `${SUMMARY_PREFIX}${summary}` }, ...messages] : messages,
           calls };
}

/** A session note's frontmatter, or {} — `session_meta`. */
export async function sessionMeta(vault: VaultPort, name: string): Promise<Record<string, unknown>> {
  const path = sessionPath(name);
  return (await vault.isFile(path)) ? frontmatterOf(await readNote(vault, path)) : {};
}

/** Every session note, newest first — `list_sessions`. */
export async function listSessions(vault: VaultPort): Promise<SessionSummary[]> {
  const notes = (await vault.files()).filter((f) => f.startsWith(`${SESSION_DIR}/`) && f.endsWith(".md")
                                                   && !f.slice(SESSION_DIR.length + 1).includes("/"));
  const found: SessionSummary[] = [];
  for (const note of notes) {
    const stem = note.slice(SESSION_DIR.length + 1, -3);
    try {
      const meta = frontmatterOf(await readNote(vault, note));
      // The file names the session, not its frontmatter: a note arriving by sync decides nothing about paths (#135)
      found.push({ name: stem, ...(typeof meta.title === "string" && meta.title ? { title: meta.title } : {}),
                   agent: String(meta.agent ?? ""), model: String(meta.model ?? ""),
                   connection: String(meta.connection ?? ""), exchanges: Number(meta.exchanges ?? 0) || 0,
                   updated: String(meta.updated ?? "") });
    } catch {
      found.push({ name: stem, agent: "", model: "", exchanges: 0, updated: "" });
    }
  }
  // The last change first; a note without one (written by hand) last, the newest name first among those
  return found.sort((a, b) => (a.updated < b.updated ? 1 : a.updated > b.updated ? -1 : a.name < b.name ? 1 : a.name > b.name ? -1 : 0));
}

export async function deleteSession(vault: VaultPort, name: string): Promise<boolean> {
  const path = sessionPath(name);
  if (!(await vault.isFile(path))) return false;
  await vault.remove(path);
  return true;
}

/**
 * Summarise all but the newest *keepRecent* exchanges with *summarize* (the model) and rewrite the note with the
 * summary and the recent exchanges — `compact_session`. Returns how many exchanges were summarised.
 */
export async function compactSession(vault: VaultPort, name: string, summarize: (prompt: string) => Promise<string>,
                                     keepRecent = 10, maxChars = Infinity): Promise<number> {
  const path = sessionPath(name);
  const existing = (await vault.isFile(path)) ? await readNote(vault, path) : "";
  const previous = summaryOf(existing);
  const loaded = await loadSessionWithCalls(vault, name);
  const raw = loaded.messages.filter((m) => m.role !== "system");
  const pairs: [SessionMessage, SessionMessage][] = [];
  for (let i = 0; i < raw.length - 1;) {
    if (raw[i].role === "user" && raw[i + 1].role === "assistant") {
      pairs.push([raw[i], raw[i + 1]]);
      i += 2;
    } else {
      i += 1;
    }
  }
  const old = pairs.length > keepRecent ? pairs.slice(0, pairs.length - keepRecent) : [];
  const recent = pairs.length >= keepRecent ? pairs.slice(pairs.length - keepRecent) : pairs;
  if (!old.length) return 0;

  // With *maxChars*, the oldest exchanges are left out of the prompt so it fits the model that summarises (#154)
  const summary = (await summarize(summaryPrompt(previous, old, maxChars))).trim();
  if (!summary) return 0;  // an empty answer would lose the old exchanges for nothing

  const meta = frontmatterOf(existing);
  const stamp = now();
  const frontmatter: Record<string, unknown> = {
    session: sanitiseName(name), agent: String(meta.agent ?? "assistant"), model: String(meta.model ?? ""),
    connection: String(meta.connection ?? ""), created: String(meta.created ?? stamp), updated: stamp,
    // Same meaning as saveSession: exchanges kept verbatim in the note
    exchanges: recent.length, compacted_at: stamp, compacted_exchanges: old.length,
  };
  if (typeof meta.title === "string" && meta.title) frontmatter.title = meta.title;
  if (Array.isArray(meta.connections) && meta.connections.length) frontmatter.connections = meta.connections;
  const parts = [`---\n${dumpYaml(frontmatter)}---\n`, `\n${SUMMARY_START}\n${summary}\n${SUMMARY_END}\n`];
  // The exchanges kept word for word keep their tool calls too (#282)
  for (const [human, assistant] of recent) {
    parts.push(`\n${HUMAN}\n${human.content}\n`, `\n${ASSISTANT}\n${withCalls(assistant, loaded.calls)}\n`);
  }
  await vault.write(path, parts.join(""));
  return old.length;
}

