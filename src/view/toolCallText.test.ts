import { describe, expect, it } from "vitest";

import { callArguments, callLine } from "./toolCallText";

// The chat showed one argument at most, and none for list_notes, read_notes, query_base or web_fetch (2026-10-05)
describe("a tool call's line in the chat", () => {
  it("shows the main argument first, then the others as key: value", () => {
    expect(callLine({ path: "Welcome.md", heading: "Notes" })).toBe("Welcome.md · heading: Notes");
    expect(callLine({ base: "Tasks - Open by project", view: "Open tasks", limit: 5 }))
      .toBe("Tasks - Open by project · view: Open tasks · limit: 5");
    expect(callLine({ url: "https://httpbin.org/html" })).toBe("https://httpbin.org/html");
  });

  it("shows calls without a main argument, lists, booleans, and leaves empty ones out", () => {
    expect(callLine({ paths: ["Welcome.md", "Notes/Plan.md"] })).toBe("paths: [Welcome.md, Notes/Plan.md]");
    expect(callLine({ status: "open", project: "" })).toBe("status: open");
    expect(callLine({ path: "Notes", recursive: true, sort: "modified" })).toBe("Notes · recursive: true · sort: modified");
    expect(callLine({ pattern: "*", folder: "", limit: 50 })).toBe("* · limit: 50");
  });

  it("is empty for a call without arguments, and cut short for a long one", () => {
    expect(callLine({})).toBe("");
    expect(callLine(undefined)).toBe("");
    expect(callLine({ definition: "x".repeat(100) })).toBe(`definition: ${"x".repeat(40)}…`);
    expect(callLine({ query: "a\n  b" })).toBe("a b");
  });

  it("gives every argument, as indented JSON, for the unfolded row", () => {
    expect(callArguments({ path: "Welcome.md", limit: 5 })).toBe('{\n  "path": "Welcome.md",\n  "limit": 5\n}');
    expect(callArguments({})).toBe("");
  });
});
