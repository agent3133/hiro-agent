import { describe, expect, it } from "vitest";

import { readFrontmatter, setFrontmatter } from "./frontmatter";

describe("readFrontmatter", () => {
  it("parses the block and keeps dates as written", () => {
    expect(readFrontmatter("---\nstatus: open\ndue: 2026-10-01\ntags: [task]\n---\nBody\n"))
      .toEqual({ data: { status: "open", due: "2026-10-01", tags: ["task"] }, body: "Body\n" });
  });

  it("gives no data for a note without frontmatter, or with frontmatter that does not parse", () => {
    expect(readFrontmatter("Just text")).toEqual({ data: {}, body: "Just text" });
    expect(readFrontmatter("---\n: [\n---\nBody").data).toEqual({});
  });
});

describe("setFrontmatter", () => {
  it("changes one key and keeps order, the other keys' formatting and the body", () => {
    const note = "---\ntitle: Task\ntags: [task]\nstatus: open # was todo\n---\n\n# Body\n";
    expect(setFrontmatter(note, { status: "done", completedDate: "2026-09-28" }))
      .toBe("---\ntitle: Task\ntags: [task]\nstatus: done # was todo\ncompletedDate: 2026-09-28\n---\n\n# Body\n");
  });

  it("adds a block to a note that has none", () => {
    expect(setFrontmatter("Body\n", { status: "done" })).toBe("---\nstatus: done\n---\nBody\n");
  });
});
