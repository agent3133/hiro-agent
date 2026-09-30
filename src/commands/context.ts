/**
 * What a request tells the agent about where it was asked from — no Obsidian in here, so it can be tested
 * under Node.
 *
 * The note goes as a path, never as its content: the agent reads it with its own tools, so an agent limited to
 * some folders (`vault_scope`) is still refused a note outside them, where pasting the content would slip past
 * that. A selection goes as text, since it is exactly what the user pointed at.
 */

/** The protocol's `chat.context` (plan §4.3). A type, not an interface, so it fits `Record<string, unknown>`. */
export type NoteContext = {
  active_note?: string;
  selection?: string;
};

/** A page or two. Larger is almost always a select-all by accident, and it would crowd the model's context. */
export const MAX_SELECTION = 20_000;

export interface BuiltContext {
  context: NoteContext | undefined;
  /** The selection was cut to MAX_SELECTION; the user is told. */
  truncated: boolean;
}

/**
 * The note's path, and the selection when there is one — or nothing, when the user unticked "Include".
 * An empty result is `undefined`, so the message carries no `context` key at all.
 */
export function buildContext(notePath: string, selection: string, include: boolean): BuiltContext {
  if (!include) return { context: undefined, truncated: false };
  const context: NoteContext = {};
  if (notePath) context.active_note = notePath;
  const truncated = selection.length > MAX_SELECTION;
  if (selection.trim()) context.selection = truncated ? selection.slice(0, MAX_SELECTION) : selection;
  return { context: Object.keys(context).length ? context : undefined, truncated };
}

/** The label of the "Include …" box in the request dialog, or "" when there is nothing to include. */
export function includeLabel(noteName: string, hasSelection: boolean): string {
  if (hasSelection && noteName) return `Include the selection and "${noteName}"`;
  if (hasSelection) return "Include the selection";
  if (noteName) return `Include "${noteName}"`;
  return "";
}
