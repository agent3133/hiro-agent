/**
 * Plain-text attachments — data exports, logs, configuration — as read_attachment gives them to the model (#210).
 * A long file is cut afterwards with the other tool results, to the room the context window has (agentLoop).
 */

/** The extensions read as text. Notes (`.md`) are read_note's. */
export const TEXT_EXTENSIONS = ["txt", "csv", "tsv", "json", "jsonl", "xml", "yaml", "yml", "log", "ini", "toml", "base"];

/**
 * A text file's *bytes* as text, whatever encoding Windows programs saved it in (#382): UTF-16 by its byte-order mark
 * (PowerShell's output, Excel's "Unicode text"), UTF-8 when the bytes are valid UTF-8, and Windows-1252 otherwise (a
 * CSV saved by an older or German Excel). Null for bytes that are not text: a NUL outside UTF-16.
 */
export function decodeText(bytes: Uint8Array): string | null {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes.subarray(2));
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes.subarray(2));
  if (bytes.includes(0)) return null;
  try {
    // A UTF-8 byte-order mark is dropped by the decoder itself
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("windows-1252").decode(bytes);
  }
}

/** *text* of the file *shown*, headed with its name and size; an error for a file that is not text after all. */
export function textAttachment(shown: string, text: string): string {
  const clean = text.replace(/^\uFEFF/, "");
  // A NUL never occurs in text: a binary file with a text extension is said, not dumped
  if (clean.includes("\u0000")) return `Error: '${shown}' is not a text file, although its name says so`;
  if (!clean.trim()) return `File '${shown}' is empty`;
  const lines = clean.replace(/\r?\n$/, "").split(/\r?\n/).length;
  return `File '${shown}' — ${lines} line${lines === 1 ? "" : "s"}:\n\n${clean.replace(/\r\n/g, "\n")}`;
}
