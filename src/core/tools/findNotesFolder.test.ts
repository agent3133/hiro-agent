import { describe, expect, it } from "vitest";

import { makeVault } from "../testing/vault";

// '2026-10-05' in Journal/Daily suggested two clippings next to the daily note (2026-10-05)
const NOTES = {
  "Journal/Daily/2026-06-05.md": "x", "Journal/Daily/2026-10-04.md": "x",
  "Clippings/Core Web Vitals after the March 2026 update.md": "x", "Clippings/2026-10-03 Reading list.md": "x",
};

describe("find_notes suggestions with a folder", () => {
  it("come from that folder when it has close names, and say so", async () => {
    const vault = await makeVault(NOTES);
    const answer = await vault.tool("find_notes").run({ pattern: "2026-10-05", folder: "Journal/Daily" });
    expect(answer).toMatch(/^No notes match '2026-10-05'\. Closest in 'Journal\/Daily': /);
    expect(answer).toContain("'Journal/Daily/2026-10-04.md'");
    expect(answer).not.toContain("Clippings/");
  });

  it("come from the whole vault when the folder has none close", async () => {
    const vault = await makeVault({ ...NOTES, "People/Tom Becker.md": "x" });
    const answer = await vault.tool("find_notes").run({ pattern: "Reading list", folder: "People" });
    expect(answer).toBe("No notes match 'Reading list'. Closest: 'Clippings/2026-10-03 Reading list.md'");
  });

  it("stay inside the agent's folders when the folder asked for is outside them", async () => {
    const vault = await makeVault(NOTES);
    const answer = await vault.tool("find_notes", ["Clippings"]).run({ pattern: "2026-10-05", folder: "Journal/Daily" });
    expect(answer).not.toContain("Journal/Daily/");
  });
});
