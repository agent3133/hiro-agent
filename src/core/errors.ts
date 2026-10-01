/** Errors as the plugin reports them (#174). No Obsidian in here. */

/** The message of anything thrown: an Error's own, else the thing in words — never a TypeError of its own. */
export function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error) ?? String(error);
  } catch {
    return String(error);
  }
}

/**
 * Arguments that do not fit a tool's schema: what the model is told is a ValidationError, so it fixes its call.
 * A TypeError from a bug keeps its own name, and says so (#174).
 */
export class ArgumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArgumentError";
  }
}
