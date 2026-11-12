/**
 * Which answers may run at the same time (#206). Answers in different chats run side by side as far as their server
 * allows: a llama.cpp server with one slot answers one at a time, and two requests at once would only queue there
 * and push each other's prompt out of its cache. Within one conversation, answers stay in order. Work that must see
 * no answer running — going back to an earlier message, which rewrites a conversation and undoes answers — runs
 * alone. No Obsidian in here, so it can be tested under Node.
 */

/** Where an answer runs: its server (its address) and how many answers that server takes at once, its conversation. */
export interface AnswerPlace {
  server: string;
  limit: number;
  conversation: string;
}

interface Waiter {
  place: AnswerPlace | null;  // null: work that runs alone
  start: () => void;
}

export class AnswerQueue {
  private readonly waiting: Waiter[] = [];
  private readonly perServer = new Map<string, number>();
  private readonly conversations = new Set<string>();
  private answers = 0;
  private alone = false;

  /** How many answers are running now. */
  get running(): number {
    return this.answers;
  }

  /**
   * Run *work* as an answer at *place*, once its server has room, its conversation has no answer running and no
   * work that runs alone is waiting before it. *onWait* is called when it has to wait, before it does. Aborted
   * while it waits, it leaves the queue at once with the signal's reason, and *work* never runs.
   */
  async answer<T>(place: AnswerPlace, work: () => Promise<T>, onWait?: () => void, signal?: AbortSignal): Promise<T> {
    await this.enter(place, onWait, signal);
    try {
      return await work();
    } finally {
      this.answers -= 1;
      this.perServer.set(place.server, (this.perServer.get(place.server) ?? 1) - 1);
      this.conversations.delete(place.conversation);
      this.wake();
    }
  }

  /** Run *work* once no answer runs; answers asked for after it wait until it is done. */
  async exclusive<T>(work: () => Promise<T>): Promise<T> {
    await this.enter(null);
    try {
      return await work();
    } finally {
      this.alone = false;
      this.wake();
    }
  }

  private enter(place: AnswerPlace | null, onWait?: () => void, signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason);
        return;
      }
      const leave = (): void => {
        const index = this.waiting.indexOf(waiter);
        if (index < 0) return;
        this.waiting.splice(index, 1);
        reject(signal!.reason);
        // Those it held back may start now
        this.wake();
      };
      const waiter: Waiter = { place, start: () => {
        signal?.removeEventListener("abort", leave);
        resolve();
      } };
      this.waiting.push(waiter);
      signal?.addEventListener("abort", leave, { once: true });
      this.wake();
      // Still in the queue: it waits
      if (this.waiting.includes(waiter)) onWait?.();
    });
  }

  /** Whether the waiter at *index* can start now. */
  private ready(index: number): boolean {
    const { place } = this.waiting[index];
    if (this.alone) return false;
    const earlier = this.waiting.slice(0, index);
    if (!place) return this.answers === 0;
    // Work that runs alone and was asked for first goes first; so does an earlier answer in the same conversation
    if (earlier.some((waiter) => !waiter.place || waiter.place.conversation === place.conversation)) return false;
    if (this.conversations.has(place.conversation)) return false;
    return (this.perServer.get(place.server) ?? 0) < Math.max(1, place.limit);
  }

  /** Start every waiter that can start, in the order they came. */
  private wake(): void {
    for (let index = 0; index < this.waiting.length;) {
      if (!this.ready(index)) {
        index += 1;
        continue;
      }
      const [waiter] = this.waiting.splice(index, 1);
      if (waiter.place) {
        this.answers += 1;
        this.perServer.set(waiter.place.server, (this.perServer.get(waiter.place.server) ?? 0) + 1);
        this.conversations.add(waiter.place.conversation);
      } else {
        this.alone = true;
      }
      waiter.start();
    }
  }
}
