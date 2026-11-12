// Which program a stdio MCP server's bare command starts (#391): the one on PATH, never one in the vault.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { childEnv, isInside, resolveCommand } from "./command";

const made: string[] = [];
function folder(): string {
  const path = mkdtempSync(join(tmpdir(), "mcp-command-"));
  made.push(path);
  return path;
}
afterEach(() => {
  for (const path of made.splice(0)) rmSync(path, { recursive: true, force: true });
});

function file(path: string): string {
  writeFileSync(path, "");
  return path;
}

describe("resolveCommand", () => {
  it("finds a bare command on PATH even when a file of that name is in the vault (the working folder)", () => {
    const vault = folder();
    const bin = folder();
    file(join(vault, "npx.cmd"));
    file(join(vault, "npx"));
    const real = file(join(bin, "npx.cmd"));
    const lookup = { path: `.;;${bin}`, pathext: ".EXE;.CMD", platform: "win32", vaultPath: vault };
    expect(resolveCommand("s", "npx", lookup)).toBe(real);
  });

  it("on Windows prefers the executable extensions to a file without one (npm's shell script)", () => {
    const bin = folder();
    file(join(bin, "npx"));
    const cmd = file(join(bin, "npx.cmd"));
    expect(resolveCommand("s", "npx", { path: bin, pathext: ".EXE;.CMD", platform: "win32", vaultPath: folder() }))
      .toBe(cmd);
  });

  it("takes a name that already has an extension as it is", () => {
    const bin = folder();
    const exe = file(join(bin, "uvx.exe"));
    expect(resolveCommand("s", "uvx.exe", { path: bin, pathext: ".EXE;.CMD", platform: "win32", vaultPath: folder() }))
      .toBe(exe);
  });

  it("refuses a command found in a PATH folder inside the vault, naming the path", () => {
    const vault = folder();
    const inside = join(vault, "tools");
    mkdirSync(inside);
    const planted = file(join(inside, "npx.cmd"));
    expect(() => resolveCommand("search", "npx", { path: inside, pathext: ".CMD", platform: "win32", vaultPath: vault }))
      .toThrow(`MCP server 'search' did not start: 'npx' was found at ${planted}, inside the vault`);
  });

  it("says a command that is not on PATH was not found", () => {
    expect(() => resolveCommand("s", "no-such-program", { path: folder(), platform: "linux", vaultPath: folder() }))
      .toThrow("MCP server 's' did not start: 'no-such-program' was not found on PATH");
  });

  it("leaves a command with a folder in it as written", () => {
    expect(resolveCommand("s", "C:\\tools\\server.exe", { path: "", platform: "win32", vaultPath: "C:\\vault" }))
      .toBe("C:\\tools\\server.exe");
    expect(resolveCommand("s", "./server", { path: "", platform: "linux", vaultPath: "/vault" })).toBe("./server");
  });

  // A Windows path has a ':' in it, PATH's delimiter elsewhere
  it.skipIf(process.platform === "win32")("on other systems looks the bare name up without extensions", () => {
    const bin = folder();
    const real = file(join(bin, "uvx"));
    expect(resolveCommand("s", "uvx", { path: `:${bin}`, platform: "linux", vaultPath: folder() })).toBe(real);
  });
});

describe("isInside", () => {
  it("compares case-insensitively on Windows only", () => {
    expect(isInside("C:\\Vault\\Tools\\npx.cmd", "c:\\vault", "win32")).toBe(true);
    expect(isInside("C:\\vault-other\\npx.cmd", "C:\\vault", "win32")).toBe(false);
    expect(isInside("/vault/x", "/vault", "linux")).toBe(true);
    expect(isInside("/vault/x", "", "linux")).toBe(false);
  });
});

describe("childEnv", () => {
  it("on Windows sets NoDefaultCurrentDirectoryInExePath, elsewhere changes nothing", () => {
    expect(childEnv({ A: "1" }, "win32")).toEqual({ A: "1", NoDefaultCurrentDirectoryInExePath: "1" });
    expect(childEnv({ NoDefaultCurrentDirectoryInExePath: "0" }, "win32")).toEqual({ NoDefaultCurrentDirectoryInExePath: "0" });
    expect(childEnv({ A: "1" }, "darwin")).toEqual({ A: "1" });
  });
});
