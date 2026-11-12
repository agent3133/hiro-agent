// search_vault as reworked in #416: its query terms, the lines it shows, the order of its results, sort=modified and
// the "[N more notes match" line. Tests the tool on a temporary folder, as toolsBuiltin.test.ts does.
import { describe, expect, it } from "vitest";

import { makeVault } from "../testing/vault";
import { makeSearchTools, queryTerms } from "./searchTools";

describe("search_vault (#416)", () => {
  it("splits a query into its words and quoted phrases, lowercased; an empty query has none", () => {
    expect(queryTerms('budget "project atlas" Budget')).toEqual(["budget", "project atlas"]);
    expect(queryTerms("")).toEqual([]);
  });

  it("finds a note whose words are on different lines, in any order, and not one with only some of them", async () => {
    const vault = await makeVault({
      "split.md": "The atlas kickoff\nnothing here\nthe budget was approved",
      "atlas-only.md": "The atlas kickoff only",
    });
    const result = await vault.tool("search_vault").run({ query: "budget atlas" });
    expect(result).toContain("split.md");
    expect(result).not.toContain("atlas-only.md");
  });

  it("matches a quoted phrase as one run of words, and not the same words in another order", async () => {
    const vault = await makeVault({
      "plan.md": "the Project Atlas plan",
      "other.md": "atlas for the project",
    });
    const result = await vault.tool("search_vault").run({ query: '"project atlas"' });
    expect(result).toContain("plan.md");
    expect(result).not.toContain("other.md");
  });

  it("shows the first three matching lines of a note with their numbers, and not a fourth", async () => {
    const lines = Array.from({ length: 12 }, (_, i) => (i + 1 === 2 || i + 1 === 5 || i + 1 === 9 || i + 1 === 12
      ? `budget entry ${i + 1}` : `filler ${i + 1}`));
    const vault = await makeVault({ "ledger.md": lines.join("\n") });
    const result = await vault.tool("search_vault").run({ query: "budget" });
    expect(result).toContain("line 2:");
    expect(result).toContain("line 5:");
    expect(result).toContain("line 9:");
    expect(result).not.toContain("line 12:");
    expect(result.split("\n").filter((ln) => ln.startsWith("ledger.md:"))).toHaveLength(1);
  });

  it("puts a note holding the whole phrase before notes that only hold the words, and a name match before the rest", async () => {
    const vault = await makeVault({
      // only the words, on separate lines; file order puts it first by name
      "a-split.md": "atlas here\nbudget there",
      // the whole phrase
      "z-phrase.md": "the budget atlas figures",
    });
    const phrase = await vault.tool("search_vault").run({ query: "budget atlas" });
    const phraseLines = phrase.split("\n");
    expect(phraseLines[0].startsWith("z-phrase.md:")).toBe(true);
    expect(phraseLines[1].startsWith("a-split.md:")).toBe(true);

    const named = await makeVault({
      "a-plain.md": "budget one\natlas two\nbudget three\natlas four\nbudget five\natlas six",
      "z-atlas.md": "budget notes\natlas notes",
    });
    const byName = await named.tool("search_vault").run({ query: "budget atlas" });
    const nameLines = byName.split("\n");
    expect(nameLines[0].startsWith("z-atlas.md:")).toBe(true);
    expect(nameLines[1].startsWith("a-plain.md:")).toBe(true);
  });

  it("sort=modified lists the newest note first", async () => {
    const vault = await makeVault({
      "a-old.md": "budget review",
      "b-mid.md": "budget review",
      "c-new.md": "budget review",
    });
    // The times are set here, so the order does not depend on when the files were written
    const times: Record<string, number> = { "a-old.md": 1000, "b-mid.md": 2000, "c-new.md": 3000 };
    const withTimes = { ...vault.vault, modified: async (path: string) => times[path] };
    const search = makeSearchTools(withTimes)[0];
    const result = await search.run({ query: "budget", sort: "modified" });
    const names = result.split("\n").map((ln) => ln.split(":")[0]);
    expect(names).toEqual(["c-new.md", "b-mid.md", "a-old.md"]);
  });

  it("with a limit of 2 and five matches, shows two notes and a last line saying three more match", async () => {
    const files: Record<string, string> = {};
    for (let i = 1; i <= 5; i++) files[`n${i}.md`] = "budget here";
    const vault = await makeVault(files);
    const result = await vault.tool("search_vault").run({ query: "budget", limit: 2 });
    const out = result.split("\n");
    expect(out).toHaveLength(3);
    expect(out.slice(0, 2).every((ln) => /^n\d\.md: /.test(ln))).toBe(true);
    expect(out[2].startsWith("[3 more notes match")).toBe(true);
  });
});
