import { describe, expect, it } from "vitest";

import { sessionNameFor } from "./sessionName";

const now = new Date(2026, 8, 23, 14, 32);

describe("sessionNameFor", () => {
  it("returns a sortable stamp with the full prompt slugified", () => {
    expect(sessionNameFor("Move ideas to the archive", now)).toBe(
      "2026-09-23-1432-move-ideas-to-the-archive",
    );
  });

  it("keeps only the first six words", () => {
    expect(
      sessionNameFor("one two three four five six seven", now),
    ).toBe("2026-09-23-1432-one-two-three-four-five-six");
  });

  it("drops punctuation and lowercases letters", () => {
    expect(sessionNameFor("What's UP, doc?!", now)).toBe(
      "2026-09-23-1432-what-s-up-doc",
    );
  });

  it("returns just the stamp when the prompt has no letters or digits", () => {
    expect(sessionNameFor("???", now)).toBe("2026-09-23-1432");
  });

  it("pads month, day, hour and minute to two digits", () => {
    const early = new Date(2026, 0, 5, 7, 3);
    expect(sessionNameFor("hi", early)).toBe("2026-01-05-0703-hi");
  });
});
