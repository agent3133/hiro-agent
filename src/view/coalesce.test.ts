// Rendering a streamed answer: one run at a time, of the newest text (#172).
import { describe, expect, it } from "vitest";

import { coalesce } from "./coalesce";

/** A run that takes a tick and records what it ran and how many ran at once. */
function recorder() {
  const ran: string[] = [];
  let running = 0;
  let most = 0;
  const run = async (value: string): Promise<void> => {
    running += 1;
    most = Math.max(most, running);
    await new Promise((resolve) => setTimeout(resolve, 5));
    ran.push(value);
    running -= 1;
  };
  return { ran, run, most: () => most };
}

describe("coalesce", () => {
  it("never runs two at once", async () => {
    const { run, most } = recorder();
    const answer = coalesce(run);
    for (const text of ["a", "ab", "abc", "abcd"]) answer.push(text);
    await answer.settled();
    expect(most()).toBe(1);
  });

  it("collapses values that arrive during a run into one run of the newest", async () => {
    const { ran, run } = recorder();
    const answer = coalesce(run);
    answer.push("a");            // runs at once
    answer.push("ab");           // waiting…
    answer.push("abc");          // …replaced
    await answer.settled();
    expect(ran).toEqual(["a", "abc"]);
  });

  it("settles only after the run of the last value pushed", async () => {
    const { ran, run } = recorder();
    const answer = coalesce(run);
    answer.push("partial");
    await new Promise((resolve) => setTimeout(resolve, 1));
    answer.push("final");
    await answer.settled();
    expect(ran.at(-1)).toBe("final");
  });

  it("keeps going after a run that fails", async () => {
    const ran: string[] = [];
    const answer = coalesce(async (value: string) => {
      if (value === "bad") throw new Error("render failed");
      ran.push(value);
    });
    answer.push("bad");
    answer.push("good");
    await answer.settled();
    expect(ran).toEqual(["good"]);
  });

  it("pauses between runs, not before the first", async () => {
    const events: string[] = [];
    const answer = coalesce(async (value: string) => { events.push(`run ${value}`); },
                            async () => { events.push("pause"); });
    answer.push("a");
    answer.push("b");
    await answer.settled();
    expect(events).toEqual(["run a", "pause", "run b"]);
  });

  it("settles at once when nothing was pushed", async () => {
    await expect(coalesce(async () => {}).settled()).resolves.toBeUndefined();
  });
});
