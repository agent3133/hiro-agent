/**
 * A turn's unified diff (core/journal.ts `diff`) split into files and typed lines, so the undo dialog can show it
 * colour-coded rather than as one block of monospace text (#131). No Obsidian here: tested as it is.
 */

export type DiffLineKind = "add" | "remove" | "context" | "hunk" | "note";

export interface DiffLine {
  kind: DiffLineKind;
  /** The line without its leading "+", "-" or " ". */
  text: string;
}

export interface DiffFile {
  /** How the dialog names the file: its path, or "old → new" for a move. */
  title: string;
  /** What happened to it. */
  change: "created" | "deleted" | "edited" | "moved";
  lines: DiffLine[];
}

const strip = (name: string): string => name.replace(/^[ab]\//, "");

/** *diff* as files, each with its lines; text before the first file header is dropped. */
export function parseDiff(diff: string): DiffFile[] {
  const files: DiffFile[] = [];
  const lines = diff.replace(/\r\n/g, "\n").split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  let current: DiffFile | null = null;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const next = lines[index + 1];
    if (line.startsWith("--- ") && next?.startsWith("+++ ")) {
      const from = line.slice(4).trim();
      const to = next.slice(4).trim();
      const moved = lines[index + 2] === "(moved)";
      const change = moved ? "moved" : from === "/dev/null" ? "created" : to === "/dev/null" ? "deleted" : "edited";
      const title = moved ? `${strip(from)} → ${strip(to)}` : strip(change === "created" ? to : from);
      current = { title, change, lines: [] };
      files.push(current);
      index += moved ? 2 : 1;
      continue;
    }
    if (!current) continue;
    if (line.startsWith("@@")) current.lines.push({ kind: "hunk", text: line });
    else if (line.startsWith("+")) current.lines.push({ kind: "add", text: line.slice(1) });
    else if (line.startsWith("-")) current.lines.push({ kind: "remove", text: line.slice(1) });
    else if (line.startsWith(" ")) current.lines.push({ kind: "context", text: line.slice(1) });
    else current.lines.push({ kind: "note", text: line });
  }
  return files;
}
