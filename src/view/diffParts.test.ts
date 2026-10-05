// The undo dialog's diff, split into files and typed lines (#131).
import { describe, expect, it } from "vitest";

import { Journal } from "../core/journal";
import { parseDiff } from "./diffParts";

describe("parseDiff", () => {
  it("types each line of an edited file and keeps the hunk header", () => {
    const files = parseDiff("--- a/Notes/x.md\n+++ b/Notes/x.md\n@@ -1,2 +1,2 @@\n keep\n-old\n+new\n");
    expect(files).toEqual([{
      title: "Notes/x.md", change: "edited",
      lines: [{ kind: "hunk", text: "@@ -1,2 +1,2 @@" }, { kind: "context", text: "keep" },
              { kind: "remove", text: "old" }, { kind: "add", text: "new" }],
    }]);
  });

  it("names created, deleted and moved files", () => {
    const files = parseDiff("--- /dev/null\n+++ b/New.md\n@@ -0,0 +1 @@\n+hi\n"
      + "--- a/Gone.md\n+++ /dev/null\n@@ -1 +0,0 @@\n-bye\n"
      + "--- Old.md\n+++ Moved/Old.md\n(moved)\n");
    expect(files.map((f) => [f.change, f.title])).toEqual([
      ["created", "New.md"], ["deleted", "Gone.md"], ["moved", "Old.md → Moved/Old.md"],
    ]);
    expect(files[2].lines).toEqual([]);
  });

  it("is empty for text without a file header", () => {
    expect(parseDiff("")).toEqual([]);
    expect(parseDiff("(nothing)")).toEqual([]);
  });

  it("reads the journal's own diff of a turn", async () => {
    const journal = new Journal(5);
    journal.begin("edit");
    journal.record({ op: "modify", path: "a.md", before: "one\ntwo\n", after: "one\nthree\n" });
    const turn = journal.finish()!;
    const files = parseDiff(journal.diff(turn));
    expect(files).toHaveLength(1);
    expect(files[0].title).toBe("a.md");
    expect(files[0].lines.filter((l) => l.kind === "remove").map((l) => l.text)).toEqual(["two"]);
    expect(files[0].lines.filter((l) => l.kind === "add").map((l) => l.text)).toEqual(["three"]);
  });
});
