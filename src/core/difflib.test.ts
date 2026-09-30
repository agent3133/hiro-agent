import { describe, expect, it } from "vitest";

import { linesKeepEnds, unifiedDiff } from "./difflib";

// Expected values are what Python's difflib.unified_diff prints for the same input (fromfile a/n.md, tofile b/n.md)
const diff = (a: string, b: string): string => unifiedDiff(linesKeepEnds(a), linesKeepEnds(b), "a/n.md", "b/n.md");

describe("unifiedDiff", () => {
  it("shows changes with three lines of context, in separate hunks when far apart", () => {
    expect(diff("a\nb\nc\nd\ne\nf\ng\nh\ni\nj\n", "a\nb\nX\nd\ne\nf\ng\nh\ni\nj\nk\n")).toBe(
      "--- a/n.md\n+++ b/n.md\n@@ -1,6 +1,6 @@\n a\n b\n-c\n+X\n d\n e\n f\n@@ -8,3 +8,4 @@\n h\n i\n j\n+k\n");
  });

  it("shows a new note as all insertions", () => {
    expect(diff("", "new\nnote\n")).toBe("--- a/n.md\n+++ b/n.md\n@@ -0,0 +1,2 @@\n+new\n+note\n");
  });

  it("keeps a last line without a newline as it is", () => {
    expect(diff("x\ny", "x\nz")).toBe("--- a/n.md\n+++ b/n.md\n@@ -1,2 +1,2 @@\n x\n-y+z");
  });

  it("shows a deleted note as all deletions", () => {
    expect(diff("one\ntwo\n", "")).toBe("--- a/n.md\n+++ b/n.md\n@@ -1,2 +0,0 @@\n-one\n-two\n");
  });

  it("is empty when nothing changed", () => {
    expect(diff("same\n", "same\n")).toBe("");
  });
});
