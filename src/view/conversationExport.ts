/**
 * A kept conversation as a note to read (#412): kept conversations live in `.sessions/`, which Obsidian's file
 * explorer, search and links do not see, and their notes carry the markers that let the plugin read them back.
 * *Export as note* writes a plain copy where new notes go: a heading per message, the summary of what came before it
 * as a callout, nothing else. The copy is the user's; the conversation itself stays in `.sessions/`.
 */

export interface ExportedMessage {
  role: string;
  content: string;
}

/**
 * A message of the user's as a person reads it: without what the chat added for the agent — the open note's path
 * (`[Active note: …]`), the attached files' instructions — keeping a selection as a quote and the files as links.
 */
export function readableUserMessage(text: string): string {
  let out = text.replace(/\r\n/g, "\n");
  // The selection the chat sent along (withContext): kept, as a quote
  out = out.replace(/\n*\[Selected text\]\n([\s\S]*)$/, (_whole, selected: string) =>
    `\n\n${selected.trimEnd().split("\n").map((line) => `> ${line}`).join("\n")}`);
  out = out.replace(/\n*\[Active note: [^\]\n]*\]/g, "");
  // Files added to the message (attachmentPrompt): links, not embeds, so a recording or a book is not drawn whole
  out = out.replace(/Attached \(saved in the vault; read (?:it|each one) with read_attachment\):\n((?:- !\[\[[^\]]+\]\]\n?)+)/,
                    (_whole, list: string) => `Attached: ${[...list.matchAll(/!\[\[([^\]]+)\]\]/g)].map((m) => `[[${m[1]}]]`).join(", ")}`);
  return out.trim();
}

/**
 * The conversation as Markdown: a line saying what it is, the summary if it has one, then each question and answer.
 * No heading with the title: the note is named after it, and Obsidian shows the name above the text.
 */
export function conversationMarkdown(title: string, messages: ExportedMessage[],
                                     summary?: { text: string } | null, exported = new Date()): string {
  const day = exported.toISOString().slice(0, 10);
  const parts = [`*"${title}", a conversation with Hiro Agent, exported on ${day}.*`];
  if (summary?.text.trim()) {
    parts.push("", "> [!summary] Earlier in this conversation",
               ...summary.text.trim().split("\n").map((line) => `> ${line}`));
  }
  for (const message of messages) {
    if (message.role !== "user" && message.role !== "assistant") continue;
    const text = message.role === "user" ? readableUserMessage(message.content) : message.content.trim();
    if (!text) continue;
    parts.push("", `## ${message.role === "user" ? "You" : "Hiro Agent"}`, "", text);
  }
  return `${parts.join("\n")}\n`;
}

/** A note name from the conversation's title: what a file name cannot hold is left out. */
export function exportName(title: string): string {
  const name = title.replace(/[\\/:*?"<>|#^[\]]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
  return name || "Conversation";
}

/** The path in *folder* for *name*, numbered when one is taken: "Plan.md", "Plan 2.md". */
export function freePath(folder: string, name: string, taken: (path: string) => boolean): string {
  const prefix = folder && folder !== "/" ? `${folder.replace(/\/+$/, "")}/` : "";
  for (let n = 1; ; n += 1) {
    const path = `${prefix}${name}${n === 1 ? "" : ` ${n}`}.md`;
    if (!taken(path)) return path;
  }
}
