// A token count as an answer's footer shows it (#414): 380, 4.2k, 12k, 1.3M.
import { describe, expect, it } from "vitest";

import { tokenCount } from "./tokenCount";

describe("tokenCount (#414)", () => {
  it("keeps short counts whole", () => {
    expect(tokenCount(380)).toBe("380");
  });

  it("shows thousands under ten with one decimal, dropping a .0", () => {
    expect(tokenCount(4200)).toBe("4.2k");
    expect(tokenCount(4000)).toBe("4k");
  });

  it("rounds larger thousands to whole k", () => {
    expect(tokenCount(12431)).toBe("12k");
  });

  it("shows millions with one decimal", () => {
    expect(tokenCount(1_300_000)).toBe("1.3M");
  });
});
