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

import { Document, Scalar, visit } from "yaml";

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

/** A user or assistant message; the summary of a compacted conversation comes back as a system message. */
export type SessionMessage = Extract<ChatMessage, { role: "system" | "user" | "assistant" }>;

export interface ConnectionChange { exchange: number; connection: string; model: string }

export interface SessionSummary {
  name: string;
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
  return name.trim().toLowerCase().replace(/ /g, "-");
}

export function sessionPath(name: string): string {
  return `${SESSION_DIR}/${sanitiseName(name)}.md`;
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

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface SaveOptions {
  agent: string;
  model: string | null;
  connection?: string | null;
  connections?: ConnectionChange[];
}

/** Write the conversation to its note, keeping its created time and summary — `save_session`. */
export async function saveSession(vault: VaultPort, name: string, messages: SessionMessage[],
                                  options: SaveOptions): Promise<void> {
  const path = sessionPath(name);
  const stamp = now();
  let created = stamp;
  let summary: string | null = null;
  let compactedAt: string | undefined;
  let compactedExchanges: number | undefined;
  if (await vault.isFile(path)) {
    const existing = await readNote(vault, path);
    const meta = frontmatterOf(existing);
    if (meta.created !== undefined) created = String(meta.created);
    if (meta.compacted_at !== undefined) compactedAt = String(meta.compacted_at);
    if (meta.compacted_exchanges !== undefined) compactedExchanges = Number(meta.compacted_exchanges);
    summary = summaryOf(existing);
  }
  const conversation = messages.filter((m) => m.role !== "system");
  const frontmatter: Record<string, unknown> = {
    session: sanitiseName(name), agent: options.agent, model: options.model ?? "", connection: options.connection ?? "",
    created, updated: stamp, exchanges: conversation.filter((m) => m.role === "user").length,
  };
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
    parts.push(`\n${message.role === "user" ? HUMAN : ASSISTANT}\n${redactSecrets(message.content)}\n`);
  }
  await vault.write(path, parts.join(""));
}

/**
 * The conversation's messages; with *tokenBudget*, only the newest that fit (4 characters a token), the summary
 * always first as a system message — `load_session`.
 */
export async function loadSession(vault: VaultPort, name: string, tokenBudget?: number): Promise<SessionMessage[]> {
  const path = sessionPath(name);
  if (!(await vault.isFile(path))) return [];
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
    messages.push({ role: pieces[i] === HUMAN ? "user" : "assistant", content: (pieces[i + 1] ?? "").trim() });
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
  return summary !== null ? [{ role: "system", content: `Earlier in this session:\n${summary}` }, ...messages] : messages;
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
      found.push({ name: String(meta.session ?? stem), agent: String(meta.agent ?? ""), model: String(meta.model ?? ""),
                   connection: String(meta.connection ?? ""), exchanges: Number(meta.exchanges ?? 0) || 0,
                   updated: String(meta.updated ?? "") });
    } catch {
      found.push({ name: stem, agent: "", model: "", exchanges: 0, updated: "" });
    }
  }
  return found.sort((a, b) => (a.updated < b.updated ? 1 : a.updated > b.updated ? -1 : 0));
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
                                     keepRecent = 10): Promise<number> {
  const path = sessionPath(name);
  const existing = (await vault.isFile(path)) ? await readNote(vault, path) : "";
  const previous = summaryOf(existing);
  const raw = (await loadSession(vault, name)).filter((m) => m.role !== "system");
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

  const conversation = old.flatMap(([h, a]) => [`<human: ${h.content}>`, `<assistant: ${a.content}>`]).join("\n");
  const intro = previous
    ? "Below is a summary of the earliest part of a conversation, followed by later exchanges. Write ONE updated "
      + "summary covering both, preserving the important facts from the earlier summary. Focus on:\n"
    : "Summarise the following conversation exchanges concisely. Focus on:\n";
  const earlier = previous ? `Summary of earlier exchanges:\n${previous}\n\n` : "";
  const prompt = `${intro}- What the user was trying to accomplish\n- Key facts discovered (file names, values, decisions made)\n`
    + "- Actions taken (notes created/updated, searches performed)\n- Any unresolved questions or follow-ups\n\n"
    + `${earlier}Conversation:\n${conversation}\n\nReturn ONLY the summary text. Be concise — 3 to 10 sentences.`;
  const summary = (await summarize(prompt)).trim();

  const meta = frontmatterOf(existing);
  const stamp = now();
  const frontmatter: Record<string, unknown> = {
    session: sanitiseName(name), agent: String(meta.agent ?? "assistant"), model: String(meta.model ?? ""),
    connection: String(meta.connection ?? ""), created: String(meta.created ?? stamp), updated: stamp,
    // Same meaning as saveSession: exchanges kept verbatim in the note
    exchanges: recent.length, compacted_at: stamp, compacted_exchanges: old.length,
  };
  if (Array.isArray(meta.connections) && meta.connections.length) frontmatter.connections = meta.connections;
  const parts = [`---\n${dumpYaml(frontmatter)}---\n`, `\n${SUMMARY_START}\n${summary}\n${SUMMARY_END}\n`];
  for (const [human, assistant] of recent) parts.push(`\n${HUMAN}\n${human.content}\n`, `\n${ASSISTANT}\n${assistant.content}\n`);
  await vault.write(path, parts.join(""));
  return old.length;
}

