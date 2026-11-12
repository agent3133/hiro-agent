// The program glue for the Features tab's detection and Test buttons (#86, #420): run a program once with a fixed
// argument, and find a program on PATH. Node itself stands in for a real program, so the tests run on every OS.
import { describe, expect, it } from "vitest";

import { nodePrograms } from "./programs";

describe("nodePrograms", () => {
  it("finds a program given by its full path, and reports what it printed for its version argument", async () => {
    const check = await nodePrograms.run(process.execPath, "--version");
    expect(check.ok).toBe(true);
    expect(check.program).toBe(process.execPath);
    expect(check.said).toEqual([process.version]);
    expect(check.error).toBeUndefined();
  });

  it("reports a program at a path that does not exist as not found, without throwing", async () => {
    const missing = `${process.execPath}-no-such-program-420`;
    const check = await nodePrograms.run(missing, "--version");
    expect(check.ok).toBe(false);
    expect(check.program).toBe(missing);
    expect(check.said).toEqual([]);
    expect(check.error).toContain("was not found");
    expect(check.error).toContain("give its full path");
  });

  it("finds a bare name on PATH: node is found", async () => {
    const found = await nodePrograms.which("node");
    expect(found).not.toBeNull();
    expect(typeof found).toBe("string");
  });

  it("does not find a made-up bare name on PATH", async () => {
    expect(await nodePrograms.which("no-such-program-420-xyz")).toBeNull();
  });
});
