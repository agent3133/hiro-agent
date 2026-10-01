/**
 * Work that must not overlap — turns, which share one undo journal (#177): each runs after the one before it has
 * finished, whether that one succeeded or failed. No Obsidian in here, so it can be tested under Node.
 */

export type Serially = <T>(work: () => Promise<T>) => Promise<T>;

/** A queue: `run(work)` starts *work* once everything run before it has settled, and gives its result. */
export function serially(): Serially {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(work: () => Promise<T>): Promise<T> => {
    const result = tail.then(work, work);
    tail = result.catch(() => undefined);
    return result;
  };
}
