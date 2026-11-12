import { describe, expect, it } from "vitest";

import { AnswerQueue } from "./answerQueue";

/** Flush microtasks so that promises settle and wake() callbacks fire. */
async function flush(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

describe("AnswerQueue", () => {
  // 1. Two answers on the same server with limit 1 and different conversations:
  //    the second does not start until the first has finished, and its onWait callback is called once;
  //    the first answer never calls onWait.
  it("serialises answers from different conversations on the same server (limit 1)", async () => {
    const queue = new AnswerQueue();
    let firstAnswerStarted = false;
    let firstResolve: (() => void) | null = null;

    // Start the first answer — it should run immediately
    const firstPromise = queue.answer(
      { server: "http://localhost:8080", limit: 1, conversation: "conv1" },
      async () => {
        firstAnswerStarted = true;
        await new Promise<void>((resolve) => {
          firstResolve = resolve;
        });
        return "first";
      },
      undefined, // onWait for first answer — should never be called
    );

    // Let the first answer start
    await flush();
    expect(firstAnswerStarted).toBe(true);
    expect(queue.running).toBe(1);

    // Now start the second answer — it should have to wait
    let secondOnWaitCalled = false;
    const secondPromise = queue.answer(
      { server: "http://localhost:8080", limit: 1, conversation: "conv2" },
      async () => "second",
      () => { secondOnWaitCalled = true; },
    );

    // The second answer should be waiting
    await flush();
    expect(secondOnWaitCalled).toBe(true);
    expect(queue.running).toBe(1); // still only first is running

    // Finish the first answer
    firstResolve!();
    await firstPromise;
    // After first finishes, wake() starts the second, so running is 1
    expect(queue.running).toBe(1);

    // Wait for second to complete
    const secondResult = await secondPromise;
    expect(secondResult).toBe("second");
    expect(queue.running).toBe(0);
  });

  // 2. Two answers on the same server with limit 2 and different conversations both start at once
  //    (queue.running is 2), and neither calls onWait.
  it("runs answers from different conversations in parallel when limit is 2", async () => {
    const queue = new AnswerQueue();
    let firstStarted = false;
    let secondStarted = false;
    let firstOnWaitCalled = false;
    let secondOnWaitCalled = false;
    let firstResolve: (() => void) | null = null;
    let secondResolve: (() => void) | null = null;

    const firstPromise = queue.answer(
      { server: "http://localhost:8080", limit: 2, conversation: "conv1" },
      async () => {
        firstStarted = true;
        await new Promise<void>((resolve) => {
          firstResolve = resolve;
        });
        return "first";
      },
      () => { firstOnWaitCalled = true; },
    );

    const secondPromise = queue.answer(
      { server: "http://localhost:8080", limit: 2, conversation: "conv2" },
      async () => {
        secondStarted = true;
        await new Promise<void>((resolve) => {
          secondResolve = resolve;
        });
        return "second";
      },
      () => { secondOnWaitCalled = true; },
    );

    await flush();
    expect(firstStarted).toBe(true);
    expect(secondStarted).toBe(true);
    expect(queue.running).toBe(2);
    expect(firstOnWaitCalled).toBe(false);
    expect(secondOnWaitCalled).toBe(false);

    // Complete both
    firstResolve!();
    secondResolve!();
    const [firstResult, secondResult] = await Promise.all([firstPromise, secondPromise]);
    expect(firstResult).toBe("first");
    expect(secondResult).toBe("second");
    expect(queue.running).toBe(0);
  });

  // 3. Two answers with limit 4 but the same conversation run one after the other,
  //    in the order they were asked for.
  it("serialises answers from the same conversation even with high limit", async () => {
    const queue = new AnswerQueue();
    let firstStarted = false;
    let secondStarted = false;
    let firstResolve: (() => void) | null = null;

    const firstPromise = queue.answer(
      { server: "http://localhost:8080", limit: 4, conversation: "conv1" },
      async () => {
        firstStarted = true;
        await new Promise<void>((resolve) => {
          firstResolve = resolve;
        });
        return "first";
      },
    );

    const secondPromise = queue.answer(
      { server: "http://localhost:8080", limit: 4, conversation: "conv1" },
      async () => {
        secondStarted = true;
        return "second";
      },
    );

    await flush();
    expect(firstStarted).toBe(true);
    expect(secondStarted).toBe(false);
    expect(queue.running).toBe(1);

    firstResolve!();
    await firstPromise;
    // After first finishes, wake() starts the second
    expect(queue.running).toBe(1);

    await flush();
    expect(secondStarted).toBe(true);
    const secondResult = await secondPromise;
    expect(secondResult).toBe("second");
    expect(queue.running).toBe(0);
  });

  // 4. queue.exclusive(work) asked for while an answer runs waits until that answer has finished;
  //    an answer asked for after the exclusive work (on another server, limit 4) does not start
  //    until the exclusive work has finished.
  it("exclusive work waits for running answers, and blocks later answers until it finishes", async () => {
    const queue = new AnswerQueue();
    let firstAnswerStarted = false;
    let exclusiveStarted = false;
    let secondAnswerStarted = false;
    let firstResolve: (() => void) | null = null;
    let secondResolve: (() => void) | null = null;

    // Start an answer that will be held
    const firstPromise = queue.answer(
      { server: "http://localhost:8080", limit: 4, conversation: "conv1" },
      async () => {
        firstAnswerStarted = true;
        await new Promise<void>((resolve) => {
          firstResolve = resolve;
        });
        return "first";
      },
    );

    await flush();
    expect(firstAnswerStarted).toBe(true);
    expect(queue.running).toBe(1);

    // Now ask for exclusive work — it should wait
    const exclusivePromise = queue.exclusive(async () => {
      exclusiveStarted = true;
      return "exclusive";
    });

    await flush();
    expect(exclusiveStarted).toBe(false); // exclusive hasn't started yet
    expect(queue.running).toBe(1); // first answer still running

    // Start an answer on a different server — it should also wait because exclusive is in the queue
    const secondPromise = queue.answer(
      { server: "http://localhost:9090", limit: 4, conversation: "conv2" },
      async () => {
        secondAnswerStarted = true;
        await new Promise<void>((resolve) => {
          secondResolve = resolve;
        });
        return "second";
      },
    );

    await flush();
    expect(exclusiveStarted).toBe(false);
    expect(secondAnswerStarted).toBe(false);
    expect(queue.running).toBe(1);

    // Finish the first answer
    firstResolve!();
    await firstPromise;
    // After first finishes, exclusive starts (wake() is called).
    // exclusive does not count as an answer (it has no place), so running is 0.
    expect(queue.running).toBe(0);

    // Exclusive finishes synchronously (it just returns), and then wake() starts the second answer
    await exclusivePromise;
    // After exclusive finishes, second answer should have started
    expect(secondAnswerStarted).toBe(true);
    // second started, so running is 1
    expect(queue.running).toBe(1);

    // Complete the second answer
    secondResolve!();
    const secondResult = await secondPromise;
    expect(secondResult).toBe("second");
    expect(queue.running).toBe(0);
  });

  // 5. An answer waiting behind another (limit 1) whose AbortSignal is aborted rejects with the
  //    signal's reason, its work never runs, and a third answer queued behind it starts as soon
  //    as the first finishes.
  it("aborted answer rejects immediately and lets the next one start", async () => {
    const queue = new AnswerQueue();
    let firstAnswerStarted = false;
    let secondWorkRun = false;
    let thirdAnswerStarted = false;
    const abortReason = new Error("cancelled");
    const abortController = new AbortController();
    let firstResolve: (() => void) | null = null;
    let thirdResolve: (() => void) | null = null;

    // Start the first answer
    const firstPromise = queue.answer(
      { server: "http://localhost:8080", limit: 1, conversation: "conv1" },
      async () => {
        firstAnswerStarted = true;
        await new Promise<void>((resolve) => {
          firstResolve = resolve;
        });
        return "first";
      },
    );

    await flush();
    expect(firstAnswerStarted).toBe(true);
    expect(queue.running).toBe(1);

    // Start the second answer with an abort signal — it will wait
    const secondPromise = queue.answer(
      { server: "http://localhost:8080", limit: 1, conversation: "conv2" },
      async () => {
        secondWorkRun = true;
        return "second";
      },
      undefined,
      abortController.signal,
    );

    await flush();
    // Second is waiting — its work should NOT have run yet
    expect(secondWorkRun).toBe(false);

    // Start the third answer — it waits behind the second
    const thirdPromise = queue.answer(
      { server: "http://localhost:8080", limit: 1, conversation: "conv3" },
      async () => {
        thirdAnswerStarted = true;
        await new Promise<void>((resolve) => {
          thirdResolve = resolve;
        });
        return "third";
      },
    );

    await flush();
    // Third is still waiting (behind the second which is still waiting behind first)
    expect(thirdAnswerStarted).toBe(false);

    // Abort the second answer
    abortController.abort(abortReason);

    // The second promise should reject with the abort reason
    await expect(secondPromise).rejects.toBe(abortReason);
    // Its work definitely did not run
    expect(secondWorkRun).toBe(false);

    // Now finish the first answer
    firstResolve!();
    await firstPromise;
    // After first finishes, third should start (second was aborted and removed from queue)
    expect(queue.running).toBe(1);
    expect(thirdAnswerStarted).toBe(true);

    // Complete the third answer
    thirdResolve!();
    const thirdResult = await thirdPromise;
    expect(thirdResult).toBe("third");
    expect(queue.running).toBe(0);
  });
});
