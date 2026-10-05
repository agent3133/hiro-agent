import { describe, expect, it } from "vitest";

import { declined } from "./agentLoop";
import { namedDay, weekday } from "./dates";
import { promptContext } from "./prompt";
import { makeVault } from "./testing/vault";
import { similarNames } from "./tools/vaultTools";

describe("weekdays (#261)", () => {
  it("names the weekday of a date, and of a note named by one", () => {
    expect(weekday(new Date(2026, 9, 2))).toBe("Friday");
    expect(promptContext("/v", "assistant", "qwen", new Date(2026, 9, 2)).current_weekday).toBe("Friday");
    expect(namedDay("Journal/Daily/2026-09-09.md")).toBe("2026-09-09 is a Wednesday");
    expect(namedDay("Meetings/2026-09-25 Borealis Sync.md")).toBe("2026-09-25 is a Friday");
  });

  it("finds no date in a name without one, or with an impossible one", () => {
    expect(namedDay("People/Tom Becker.md")).toBe("");
    expect(namedDay("Notes/2026-02-30.md")).toBe("");
    expect(namedDay("Notes/12026-09-09.md")).toBe("");
  });

  it("ends read_note's answer for a dated note with its weekday, a section's too", async () => {
    const text = "# 2026-09-09\n\n## Plans\n- Staging server by Friday\n";
    const vault = await makeVault({ "Journal/Daily/2026-09-09.md": text, "Notes/Plain.md": "# Plain\n" });
    expect(await vault.tool("read_note").run({ path: "Journal/Daily/2026-09-09.md" }))
      .toBe(`${text}\n\n[2026-09-09 is a Wednesday.]`);
    expect(await vault.tool("read_note").run({ path: "Journal/Daily/2026-09-09.md", heading: "Plans" }))
      .toMatch(/Staging server by Friday\n\n\[2026-09-09 is a Wednesday\.\]$/);
    expect(await vault.tool("read_note").run({ path: "Notes/Plain.md" })).toBe("# Plain\n");
  });

  it("puts the weekday in read_notes' heading of a dated note only", async () => {
    const vault = await makeVault({ "Journal/Daily/2026-09-09.md": "x\n", "Notes/Plain.md": "y\n" });
    const answer = await vault.tool("read_notes").run({ paths: ["Journal/Daily/2026-09-09.md", "Notes/Plain.md"] });
    expect(answer).toContain("## Journal/Daily/2026-09-09.md (2026-09-09 is a Wednesday)\nx");
    expect(answer).toContain("## Notes/Plain.md\ny");
  });
});

describe("a declined call (#262)", () => {
  it("tells the model not to reach the same result another way", () => {
    expect(declined("update_note")).toBe("Error: the user declined to run 'update_note'. Do not make the same change "
                                         + "another way; tell the user it was not done.");
  });
});

describe("create_note and a similar name in the folder (#265)", () => {
  it("points out a note with the same surname and initial, or nearly the same name", () => {
    const people = ["People/Tom Becker.md", "People/Maria Keller.md"];
    expect(similarNames("Thomas Becker", people)).toEqual(["People/Tom Becker.md"]);
    expect(similarNames("T. Becker", people)).toEqual(["People/Tom Becker.md"]);
    expect(similarNames("Maria Kellerr", people)).toEqual(["People/Maria Keller.md"]);
  });

  it("leaves other surnames, other initials and dated names alone", () => {
    expect(similarNames("Anna Becker", ["People/Tom Becker.md"])).toEqual([]);
    expect(similarNames("Tom Weber", ["People/Tom Becker.md"])).toEqual([]);
    expect(similarNames("2026-09-10", ["Journal/Daily/2026-09-09.md"])).toEqual([]);
  });

  it("adds the hint to the answer, for notes in the same folder only", async () => {
    const vault = await makeVault({ "People/Tom Becker.md": "# Tom\n", "Archive/Thomas Becker.md": "# Old\n" });
    expect(await vault.tool("create_note").run({ path: "People/Thomas Becker.md", content: "# Thomas\n" }))
      .toBe("Created note at 'People/Thomas Becker.md'\n[People/Tom Becker.md has a similar name; if it is the same "
            + "person or thing, use that note instead.]");
    expect(await vault.tool("create_note").run({ path: "People/Anna Weber.md", content: "# Anna\n" }))
      .toBe("Created note at 'People/Anna Weber.md'");
  });
});
