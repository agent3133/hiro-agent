/**
 * How a tool call reads in the chat: one line with its arguments next to the tool's name, and all of them when the
 * row is unfolded. No Obsidian in here, so it is tested as it is.
 */

/** The argument that says what a call is about, shown first and without its name. */
const MAIN_ARGUMENTS = ["path", "from_path", "query", "pattern", "base", "url", "template", "task", "title", "date"];
/** The longest a single value or the whole line gets before it is cut. */
const VALUE_CHARS = 40;
const LINE_CHARS = 160;

function cut(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

function empty(value: unknown): boolean {
  return value === undefined || value === null || value === "" || (Array.isArray(value) && !value.length);
}

/** A value as the line shows it: text as it is, a list as its items, anything else as JSON; each cut short. */
function shown(value: unknown): string {
  if (typeof value === "string") return cut(value.replace(/\s+/g, " "), VALUE_CHARS);
  if (Array.isArray(value)) return `[${cut(value.map((item) => (typeof item === "string" ? item : JSON.stringify(item))).join(", "), VALUE_CHARS)}]`;
  if (typeof value === "object") return cut(JSON.stringify(value), VALUE_CHARS);
  return String(value);
}

/**
 * The call's arguments on one line: the main one first, by itself ("Welcome.md"), then the others as
 * "key: value" ("heading: Notes · limit: 5"). Empty ones are left out; a call without arguments gives "".
 */
export function callLine(input: unknown): string {
  const values = (input && typeof input === "object" && !Array.isArray(input) ? input : {}) as Record<string, unknown>;
  const main = MAIN_ARGUMENTS.find((key) => typeof values[key] === "string" && values[key]);
  const parts = main ? [shown(values[main])] : [];
  for (const [key, value] of Object.entries(values)) {
    if (key !== main && !empty(value)) parts.push(`${key}: ${shown(value)}`);
  }
  return cut(parts.join(" · "), LINE_CHARS);
}

/** All of the call's arguments, for the unfolded row: indented JSON, or "" when there are none. */
export function callArguments(input: unknown): string {
  if (!input || typeof input !== "object" || !Object.keys(input).length) return "";
  return JSON.stringify(input, null, 2);
}
