/**
 * Work that only its latest input matters for, such as rendering a streamed answer (#172): at most one run at a
 * time, and inputs that arrive meanwhile collapse into one run with the newest. No Obsidian in here, so it can be
 * tested under Node.
 */

export interface Coalesced<T> {
  /** Ask for a run with *value*; replaces a value still waiting. */
  push(value: T): void;
  /** Resolves once nothing is running or waiting — after the run for the last value pushed. */
  settled(): Promise<void>;
}

/** Runs *run* for the newest value pushed, one at a time, with *pause* between runs (a frame, say). */
export function coalesce<T>(run: (value: T) => Promise<void>, pause: () => Promise<void> = async () => {}): Coalesced<T> {
  let waiting: { value: T } | null = null;
  let loop: Promise<void> | null = null;

  const drain = async (): Promise<void> => {
    try {
      while (waiting) {
        const { value } = waiting;
        waiting = null;
        try {
          await run(value);
        } catch {
          // One failed run does not stop the next: the newest value is rendered again anyway
        }
        if (waiting) await pause();
      }
    } finally {
      loop = null;
    }
  };

  return {
    push(value) {
      waiting = { value };
      if (!loop) loop = drain();
    },
    async settled() {
      while (loop) await loop;
    },
  };
}
