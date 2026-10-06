/**
 * Plain-text attachments — data exports, logs, configuration — as read_attachment gives them to the model (#210).
 * A long file is cut afterwards with the other tool results, to the room the context window has (agentLoop).
 */

/** The extensions read as text. Notes (`.md`) are read_note's. */
export const TEXT_EXTENSIONS = ["txt", "csv", "tsv", "json", "jsonl", "xml", "yaml", "yml", "log", "ini", "toml", "base"];

/** *text* of the file *shown*, headed with its name and size; an error for a file that is not text after all. */
export function textAttachment(shown: string, text: string): string {
  const clean = text.replace(/^\uFEFF/, "");
  // A NUL never occurs in text: a binary file with a text extension is said, not dumped
  if (clean.includes("\u0000")) return `Error: '${shown}' is not a text file, although its name says so`;
  if (!clean.trim()) return `File '${shown}' is empty`;
  const lines = clean.replace(/\r?\n$/, "").split(/\r?\n/).length;
  return `File '${shown}' — ${lines} line${lines === 1 ? "" : "s"}:\n\n${clean.replace(/\r\n/g, "\n")}`;
}
