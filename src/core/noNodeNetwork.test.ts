// The core reaches the network only through its port (#418): no file under core/ imports Node's network modules,
// so the core can run where Node does not (the mobile plan, M10). The Node implementation is net/nodeHttp.ts.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const CORE = fileURLToPath(new URL(".", import.meta.url));
const NETWORK = /from\s+["'](node:)?(http|https|http2|net|tls|dns|dgram)["']|require\(\s*["'](node:)?(http|https|net|tls|dns)["']\s*\)/;

function sources(folder: string): string[] {
  return readdirSync(folder).flatMap((name) => {
    const path = join(folder, name);
    if (statSync(path).isDirectory()) return name === "testing" ? [] : sources(path);
    return name.endsWith(".ts") && !name.endsWith(".test.ts") ? [path] : [];
  });
}

describe("core/ and the network (#418)", () => {
  it("finds the core's sources to check", () => {
    expect(sources(CORE).some((path) => path.endsWith("publicFetch.ts"))).toBe(true);
    expect(sources(CORE).some((path) => path.endsWith("openaiChat.ts"))).toBe(true);
  });

  it("imports none of Node's network modules under core/", () => {
    const offenders = sources(CORE).filter((path) => NETWORK.test(readFileSync(path, "utf-8")))
      .map((path) => path.slice(CORE.length));
    expect(offenders).toEqual([]);
  });

  it("would catch one: the pattern matches the imports it is meant to keep out", () => {
    expect(NETWORK.test('import * as https from "node:https";')).toBe(true);
    expect(NETWORK.test('import { lookup } from "dns";')).toBe(true);
    expect(NETWORK.test('import { readFile } from "node:fs/promises";')).toBe(false);
  });
});
