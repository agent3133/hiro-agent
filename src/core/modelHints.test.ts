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

  it("leaves dated notes that end in the same word alone, as meetings do (M4, 2026-10-06)", () => {
    const meetings = ["Journal/Meetings/2026-08-21 Analytics Roadmap Review.md", "Journal/Meetings/2026-09-02 Budget Review.md"];
    expect(similarNames("2026-09-16 Website Relaunch Review", meetings)).toEqual([]);
    expect(similarNames("Q3 Review", ["Notes/Q2 Review.md"])).toEqual([]);
  });

  it("creates nothing at first next to a similar name, and the note on the same call again (#269)", async () => {
    const vault = await makeVault({ "People/Tom Becker.md": "# Tom\n", "Archive/Thomas Becker.md": "# Old\n" });
    const create = vault.tool("create_note");
    expect(await create.run({ path: "People/Thomas Becker.md", content: "# Thomas\n" }))
      .toBe("Not created yet: People/Tom Becker.md has a similar name. If it is the same person or thing, use that "
            + "note; if not, call create_note again with the same path.");
    expect(await vault.exists("People/Thomas Becker.md")).toBe(false);
    expect(await create.run({ path: "People/Thomas Becker.md", content: "# Thomas\n" }))
      .toBe("Created note at 'People/Thomas Becker.md'");
    expect(await vault.read("People/Thomas Becker.md")).toBe("# Thomas\n");
  });

  it("creates at once a name with no similar note in its folder", async () => {
    const vault = await makeVault({ "People/Tom Becker.md": "# Tom\n", "Archive/Thomas Becker.md": "# Old\n" });
    expect(await vault.tool("create_note").run({ path: "People/Anna Weber.md", content: "# Anna\n" }))
      .toBe("Created note at 'People/Anna Weber.md'");
    // A similar name in another folder does not count
    expect(await vault.tool("create_note").run({ path: "Notes/Thomas Becker.md", content: "# T\n" }))
      .toBe("Created note at 'Notes/Thomas Becker.md'");
  });

  it("holds back each new name once, and never an overwrite of a note that exists", async () => {
    const vault = await makeVault({ "People/Tom Becker.md": "# Tom\n", "People/Thomas Becker.md": "# Thomas\n" });
    const create = vault.tool("create_note");
    expect(await create.run({ path: "People/T. Becker.md", content: "x" })).toMatch(/^Not created yet: /);
    expect(await create.run({ path: "People/Tom Beckers.md", content: "x" })).toMatch(/^Not created yet: /);
    expect(await create.run({ path: "People/Thomas Becker.md", content: "# New\n", overwrite: true }))
      .toBe("Created note at 'People/Thomas Becker.md'");
  });
});
