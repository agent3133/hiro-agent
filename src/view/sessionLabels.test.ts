import { describe, expect, it } from "vitest";

import { listedSessions, readableName, sessionLabels, startedAt } from "./sessionLabels";

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

describe("the conversations the picker lists (2026-10-06)", () => {
  const made = (name: string) => ({ name, exchanges: 0 });
  const notes = [{ name: "2026-10-05-1104-hey", exchanges: 3 }, { name: "2026-10-04-0930-budget", exchanges: 1 }];

  it("lists the open conversation first while it has no note yet", () => {
    expect(listedSessions(notes, "2026-10-06-0900-summaries", made).map((s) => s.name))
      .toEqual(["2026-10-06-0900-summaries", "2026-10-05-1104-hey", "2026-10-04-0930-budget"]);
  });

  it("lists the notes as they are when the open one has its note, or none is open", () => {
    expect(listedSessions(notes, "2026-10-04-0930-budget", made)).toBe(notes);
    expect(listedSessions(notes, "", made)).toBe(notes);
  });
});
