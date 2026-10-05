import { describe, expect, it } from "vitest";

import { readableName, sessionLabels, startedAt } from "./sessionLabels";

// The picker showed file names ("2026-10-05-1143-go-through-every-tool-in-your"); it shows titles now (#286)
describe("how a conversation is called in the picker", () => {
  it("reads a generated name as words, and a bare one as its date and time", () => {
    expect(readableName("2026-10-05-1143-go-through-every-tool-in-your")).toBe("go through every tool in your");
    expect(readableName("2026-10-05-1143")).toBe("5 Oct 11:43");
    expect(readableName("my-own-name")).toBe("my-own-name");
    expect(startedAt("2026-01-09-0805-x")).toBe("9 Jan 08:05");
    expect(startedAt("my-own-name")).toBe("");
  });

  it("shows the title when there is one, the readable name otherwise, and no count of messages", () => {
    const labels = sessionLabels([
      { name: "2026-10-05-1143-go-through-every-tool", title: "Plan: Q4 / Budget?", exchanges: 3 },
      { name: "2026-10-05-1104-hey", exchanges: 0 },
    ]);
    expect(labels.get("2026-10-05-1143-go-through-every-tool")).toBe("Plan: Q4 / Budget?");
    expect(labels.get("2026-10-05-1104-hey")).toBe("hey");
  });

  it("adds when they were started to two that would read the same", () => {
    const labels = sessionLabels([
      { name: "2026-10-05-1104-hey", exchanges: 1 },
      { name: "2026-10-04-0930-hey", exchanges: 2 },
      { name: "2026-10-03-0800-budget", title: "Hey", exchanges: 0 },
    ]);
    expect(labels.get("2026-10-05-1104-hey")).toBe("hey · 5 Oct 11:04");
    expect(labels.get("2026-10-04-0930-hey")).toBe("hey · 4 Oct 09:30");
    expect(labels.get("2026-10-03-0800-budget")).toBe("Hey · 3 Oct 08:00");
  });
});
