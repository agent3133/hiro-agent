// Turns run one at a time, as they share one undo journal (#177).
import { describe, expect, it } from "vitest";

import { serially } from "./serial";

const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));

describe("serially", () => {
  it("starts each piece of work only after the one before it has finished", async () => {
    const run = serially();
    const events: string[] = [];
    const work = (name: string, ms: number) => run(async () => {
      events.push(`start ${name}`);
      await tick(ms);
      events.push(`end ${name}`);
      return name;
    });
    const results = await Promise.all([work("chat", 20), work("terminal", 5), work("third", 1)]);
    expect(results).toEqual(["chat", "terminal", "third"]);
    expect(events).toEqual(["start chat", "end chat", "start terminal", "end terminal", "start third", "end third"]);
  });

  it("goes on after a piece of work that failed, and gives each its own outcome", async () => {
    const run = serially();
    const failed = run(async () => { throw new Error("the model server is down"); });
    const next = run(async () => "answered");
    await expect(failed).rejects.toThrow("the model server is down");
    await expect(next).resolves.toBe("answered");
  });

  it("does not hold up separate queues", async () => {
    const a = serially();
    const b = serially();
    const order: string[] = [];
    const slow = a(async () => { await tick(20); order.push("a"); });
    const fast = b(async () => { order.push("b"); });
    await Promise.all([slow, fast]);
    expect(order).toEqual(["b", "a"]);
  });
});
