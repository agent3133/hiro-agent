/**
 * A tool the agent can call: its name, description and argument schema as the model sees them, and what it does.
 *
 * Name, description and schema come from specs.json — first exported from the Python tools, so the model was
 * told exactly what the Python runtime told it; the plugin's own since the runtime was removed (#88).
 */

import { ArgumentError } from "../errors";
import type { ContentPart } from "../llm/openaiChat";
import specs from "./specs.json";

export interface ToolSpec {
  name: string;
  description: string;
  parameters: { type: "object"; properties: Record<string, JsonProperty>; required: string[] };
}

interface JsonProperty {
  type?: string;
  default?: unknown;
  items?: { type?: string };
}

export interface Tool extends ToolSpec {
  run(args: Record<string, unknown>): Promise<string>;
  /** Changes or removes what is already there: the user is asked before it runs (vault.py marks the same tools). */
  destructive?: boolean;
  /**
   * For a tool that changes what is there only with some arguments — create_note replacing a note with
   * `overwrite` (#157): whether this call does, so it is asked about as a destructive one is.
   */
  destructiveWhen?(args: Record<string, unknown>): Promise<boolean>;
  /** Throws what run() would for arguments that do not fit the schema, without running anything. */
  validate?(args: Record<string, unknown>): void;
  /** The arguments a confirmation names, when the tool resolves its target itself (move_note's fuzzy source). */
  confirmArgs?(args: Record<string, unknown>): Promise<Record<string, unknown>>;
  /**
   * For a tool whose answer carries images (read_attachment): what the model is given. `run` then gives the same
   * answer in words, for the chat view and the command line.
   */
  runContent?(args: Record<string, unknown>): Promise<string | ContentPart[]>;
  /**
   * For a tool whose answer is several parts (read_notes): the answer fitted to *room* characters by the tool itself,
   * each part getting its share, rather than cut blindly at the end where the last parts would vanish (#160).
   */
  runWithin?(args: Record<string, unknown>, room: number): Promise<string>;
}

/** A tool with the spec exported from Python and *run* as its body. */
export function defineTool(name: string, run: (args: Args) => Promise<string>,
                           options: Pick<Tool, "destructive" | "confirmArgs"> & {
                             /** Whether a call with these arguments changes what is there (Tool.destructiveWhen). */
                             destructiveWhen?: (args: Args) => Promise<boolean>;
                             /** Replaces the exported description, where the plugin's tool works differently. */
                             description?: string;
                             content?: (args: Args) => Promise<string | ContentPart[]>;
                             /** The answer fitted to *room* characters (Tool.runWithin). */
                             within?: (args: Args, room: number) => Promise<string>;
                           } = {}): Tool {
  const exported = (specs as unknown as ToolSpec[]).find((s) => s.name === name);
  if (!exported) throw new Error(`no spec for tool '${name}' in specs.json`);
  const spec = options.description ? { ...exported, description: options.description } : exported;
  const content = options.content;
  const within = options.within;
  const when = options.destructiveWhen;
  return { ...spec, run: (raw) => run(readArgs(spec, raw)), destructive: options.destructive ?? false,
           destructiveWhen: when ? (raw) => when(readArgs(spec, raw)) : undefined,
           validate: (raw) => void readArgs(spec, raw), confirmArgs: options.confirmArgs,
           runContent: content ? (raw) => content(readArgs(spec, raw)) : undefined,
           runWithin: within ? (raw, room) => within(readArgs(spec, raw), room) : undefined };
}

/** Arguments as the tool body reads them: defaults filled in, strings a model sent for numbers and booleans read. */
export type Args = Record<string, unknown> & {
  str(name: string): string;
  int(name: string): number;
  bool(name: string): boolean;
};

/**
 * The arguments, checked and converted the way Pydantic does for the Python tools: a missing required argument is
 * an error, "true"/"false" and "5" are accepted for booleans and integers.
 */
export function readArgs(spec: ToolSpec, raw: Record<string, unknown>): Args {
  // A name the tool does not take is an error, not dropped: list_notes({ folder }) would list the vault's root, and
  // the model would believe the folder empty (#163)
  const takes = Object.keys(spec.parameters.properties);
  const unknown = Object.keys(raw).filter((name) => !takes.includes(name));
  if (unknown.length) {
    const said = unknown.map((name) => `'${name}'`).join(", ");
    throw new ArgumentError(`${spec.name} has no argument ${said}; it takes ${takes.length ? takes.join(", ") : "none"}`);
  }
  const values: Record<string, unknown> = {};
  for (const [name, property] of Object.entries(spec.parameters.properties)) {
    if (raw[name] === undefined || raw[name] === null) {
      if (spec.parameters.required.includes(name)) throw new ArgumentError(`missing required argument '${name}'`);
      values[name] = property.default;
      continue;
    }
    values[name] = coerce(name, raw[name], property.type);
  }
  return Object.assign(values, {
    str: (name: string) => String(values[name] ?? ""),
    int: (name: string) => Number(values[name]),
    bool: (name: string) => Boolean(values[name]),
  });
}

function coerce(name: string, value: unknown, type: string | undefined): unknown {
  if (type === "boolean") {
    if (typeof value === "boolean") return value;
    if (value === "true" || value === "True" || value === 1) return true;
    if (value === "false" || value === "False" || value === 0) return false;
    throw new ArgumentError(`argument '${name}' must be a boolean`);
  }
  if (type === "integer") {
    const number = typeof value === "string" ? Number(value.trim()) : value;
    if (typeof number === "number" && Number.isInteger(number)) return number;
    throw new ArgumentError(`argument '${name}' must be an integer`);
  }
  if (type === "array") {
    if (Array.isArray(value)) return value;
    throw new ArgumentError(`argument '${name}' must be a list`);
  }
  if (type === "string" && typeof value !== "string") return String(value);
  return value;
}
