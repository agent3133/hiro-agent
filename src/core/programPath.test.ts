// Obsidian started from the Dock on macOS has no Homebrew folders on PATH (#124).
import { describe, expect, it } from "vitest";

import { HOMEBREW_BIN, programEnv, programPath } from "./programPath";

const DOCK_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

describe("programPath", () => {
  it("adds Homebrew's folders after the Dock's PATH on macOS", () => {
    expect(programPath(DOCK_PATH, "darwin")).toBe(`${DOCK_PATH}:/opt/homebrew/bin:/usr/local/bin`);
  });

  it("adds each folder once, keeping the user's order when they are already there", () => {
    expect(programPath("/usr/local/bin:/usr/bin:/opt/homebrew/bin", "darwin"))
      .toBe("/usr/local/bin:/usr/bin:/opt/homebrew/bin");
  });

  it("gives Homebrew's folders alone when there is no PATH", () => {
    expect(programPath(undefined, "darwin")).toBe(HOMEBREW_BIN.join(":"));
  });

  it("leaves PATH as it is on Linux and Windows", () => {
    expect(programPath("/usr/bin:/bin", "linux")).toBe("/usr/bin:/bin");
    expect(programPath("C:\\Windows;C:\\Tools", "win32")).toBe("C:\\Windows;C:\\Tools");
  });
});

describe("programEnv", () => {
  it("is the environment with the wider PATH on macOS, the rest unchanged", () => {
    const env = programEnv({ PATH: DOCK_PATH, HOME: "/Users/a" }, "darwin");
    expect(env).toEqual({ PATH: `${DOCK_PATH}:/opt/homebrew/bin:/usr/local/bin`, HOME: "/Users/a" });
  });

  it("is undefined elsewhere, so the program inherits Obsidian's environment", () => {
    expect(programEnv({ PATH: "/usr/bin" }, "linux")).toBeUndefined();
    expect(programEnv({ Path: "C:\\Windows" }, "win32")).toBeUndefined();
  });
});
