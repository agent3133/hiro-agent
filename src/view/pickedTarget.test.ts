import { describe, expect, it } from "vitest";

import { pickedTarget } from "./pickedTarget";

const UNKEPT = "\u0000unkept";

describe("a conversation picked in the chat's picker (#301)", () => {
  it("opens in another window when Ctrl/Cmd was held, a new conversation too", () => {
    expect(pickedTarget("budget-review", "", UNKEPT, true)).toBe("window");
    expect(pickedTarget("", "budget-review", UNKEPT, true)).toBe("window");
    // The one open here, picked with Ctrl/Cmd: another window shows it (the plugin goes to where it is open)
    expect(pickedTarget("budget-review", "budget-review", UNKEPT, true)).toBe("window");
  });

  it("opens here otherwise, and a new conversation here", () => {
    expect(pickedTarget("budget-review", "monkey-king", UNKEPT, false)).toBe("here");
    expect(pickedTarget("", "monkey-king", UNKEPT, false)).toBe("here");
  });

  it("opens nothing for the conversation already open, or the unkept entry", () => {
    expect(pickedTarget("budget-review", "budget-review", UNKEPT, false)).toBe("none");
    expect(pickedTarget(UNKEPT, "", UNKEPT, false)).toBe("none");
    expect(pickedTarget(UNKEPT, "", UNKEPT, true)).toBe("none");
  });
});
