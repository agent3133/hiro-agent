// `obsidian agent:stop` (#415): stop an answer started with `agent:ask`.
import { describe, expect, it, type Mock, vi } from "vitest";

import { RunningAsks, type RunningAsk, stop } from "./stop";

function entry(session: string, prompt = "hello", started = 0): RunningAsk & { stop: Mock<() => void> } {
  return { session, prompt, agent: "assistant", started, stop: vi.fn<() => void>() };
}

function two(): { asks: RunningAsks; a: ReturnType<typeof entry>; b: ReturnType<typeof entry> } {
  const asks = new RunningAsks();
  const a = entry("a", "hello", 1);
  const b = entry("b", "world", 2);
  asks.add(a);
  asks.add(b);
  return { asks, a, b };
}

describe("agent:stop (#415)", () => {
  it("stops every running answer and names them", () => {
    const { asks, a, b } = two();
    expect(stop(asks, {})).toMatch(/^Stopped 2 answers: a, b\./);
    expect(a.stop).toHaveBeenCalledTimes(1);
    expect(b.stop).toHaveBeenCalledTimes(1);
  });

  it("stops only the conversation session= names", () => {
    const { asks, a, b } = two();
    expect(stop(asks, { session: "b" })).toMatch(/^Stopped 1 answer: b\./);
    expect(a.stop).not.toHaveBeenCalled();
    expect(b.stop).toHaveBeenCalledTimes(1);
  });

  it("stops nothing for a conversation with no answer running, and names the running ones", () => {
    const { asks, a, b } = two();
    const text = stop(asks, { session: "zzz" });
    expect(text.startsWith("Error: no answer from the terminal is running in 'zzz'")).toBe(true);
    expect(text).toContain("a, b");
    expect(a.stop).not.toHaveBeenCalled();
    expect(b.stop).not.toHaveBeenCalled();
  });

  it("says when nothing runs, and lists nothing as JSON", () => {
    const asks = new RunningAsks();
    expect(stop(asks, {})).toBe("No answer from the terminal is running.");
    expect(JSON.parse(stop(asks, { list: "true", format: "json" }))).toEqual({ ok: true, running: [] });
  });

  it("lists the running answers without stopping them", () => {
    const { asks, a } = two();
    const listed = JSON.parse(stop(asks, { list: "true", format: "json" }, 5000)) as { running: { session: string }[] };
    expect(listed.running.map((one) => one.session)).toEqual(["a", "b"]);
    expect(a.stop).not.toHaveBeenCalled();
  });

  it("forgets an answer once agent:ask removes it, but not a newer one under the same name", () => {
    const asks = new RunningAsks();
    const removeFirst = asks.add(entry("a"));
    const second = entry("a");
    const removeSecond = asks.add(second);
    removeFirst();
    expect(asks.list()).toEqual([second]);
    removeSecond();
    expect(asks.list()).toEqual([]);
  });
});
