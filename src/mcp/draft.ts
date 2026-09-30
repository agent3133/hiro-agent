/**
 * An MCP server as the settings form edits it, and the change that saves it — kept apart from the form so it can
 * be tested without Obsidian.
 */

import type { McpServerSpec, Transport } from "./servers";

export interface McpDraft {
  name: string;
  transport: Transport;
  command: string;
  /** One argument per line. */
  args: string;
  /** `KEY=value`, one per line. */
  env: string;
  url: string;
  /** `Name: value`, one per line. */
  headers: string;
  /** Tool names separated by commas; empty or `*` for all of them. */
  toolsFilter: string;
  enabled: boolean;
}

export function emptyDraft(): McpDraft {
  return { name: "", transport: "stdio", command: "", args: "", env: "", url: "", headers: "", toolsFilter: "",
           enabled: true };
}

export function draftOf(spec: McpServerSpec): McpDraft {
  return {
    name: spec.name, transport: spec.transport, command: spec.command, args: spec.args.join("\n"),
    env: Object.entries(spec.env).map(([key, value]) => `${key}=${value}`).join("\n"), url: spec.url,
    headers: Object.entries(spec.headers).map(([key, value]) => `${key}: ${value}`).join("\n"),
    toolsFilter: spec.toolsFilter.includes("*") ? "" : spec.toolsFilter.join(", "), enabled: spec.enabled,
  };
}

function lines(text: string): string[] {
  return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

/** `KEY<sep>value` lines as a record; a line without the separator is an error naming it. */
function pairs(text: string, separator: string, what: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of lines(text)) {
    const at = line.indexOf(separator);
    if (at <= 0) throw new Error(`${what}: '${line}' is not "name${separator === "=" ? "=" : ": "}value"`);
    result[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  return result;
}

const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/**
 * The settings change that stores *draft*, replacing the server *previous* was (null for a new one): a renamed
 * server's old entry goes, and env or header entries that were removed are removed (null deletes, store.merge).
 * Throws with a message for the form when the draft cannot be a server.
 */
export function serverChange(draft: McpDraft, previous: McpServerSpec | null, taken: string[]):
    Record<string, unknown> {
  const name = draft.name.trim();
  if (!NAME.test(name)) throw new Error("Name: letters, digits, - and _ only, starting with a letter or digit");
  if (name.includes("__")) throw new Error("Name: no double underscore — it separates the server from its tool");
  if (name !== previous?.name && taken.includes(name)) throw new Error(`Name: there is already a server called '${name}'`);
  const filter = draft.toolsFilter.split(",").map((item) => item.trim()).filter(Boolean);
  const server: Record<string, unknown> = {
    transport: draft.transport, enabled: draft.enabled, tools_filter: filter.length ? filter : ["*"],
  };
  if (draft.transport === "stdio") {
    if (!draft.command.trim()) throw new Error("Command: the program to start");
    server.command = draft.command.trim();
    server.args = lines(draft.args);
    server.env = pairs(draft.env, "=", "Environment");
  } else {
    if (!/^https?:\/\//.test(draft.url.trim())) throw new Error("URL: an http:// or https:// address");
    server.url = draft.url.trim();
    server.headers = pairs(draft.headers, ":", "Headers");
  }
  // Editing in place, what is no longer there must be removed: merge keeps a key the change does not name, and
  // null removes it. A new or renamed entry is written whole, where a null would be stored as it is.
  const renamed = previous !== null && previous.name !== name;
  if (previous && !renamed) {
    const other = draft.transport === "stdio" ? ["url", "headers"] : ["command", "args", "env"];
    for (const field of other) server[field] = null;
    for (const [field, old] of [["env", previous.env], ["headers", previous.headers]] as const) {
      const now = server[field] as Record<string, unknown> | null | undefined;
      if (!now) continue;
      for (const key of Object.keys(old)) if (!(key in now)) now[key] = null;
    }
  }
  const change: Record<string, unknown> = { [name]: server };
  if (renamed) change[previous!.name] = null;
  return { mcp_servers: change };
}
