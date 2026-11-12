// What an answer reached beyond the vault and the model (#409): the sites and MCP servers, and the line saying so.
import { describe, expect, it } from "vitest";

import { whatLeft, whatLeftLine } from "./whatLeft";

describe("whatLeft (#409)", () => {
  it("names each site once, www. or not", () => {
    const left = whatLeft([
      { name: "web_fetch", input: { url: "https://www.example.com/a" }, result: "page" },
      { name: "web_fetch", input: { url: "https://example.com/b" }, result: "page" },
    ]);
    expect(left).toEqual({ sites: ["example.com"], servers: [] });
  });

  it("names the MCP server of a server__tool call", () => {
    expect(whatLeft([{ name: "search__query", input: {}, result: "ok" }])).toEqual({ sites: [], servers: ["search"] });
  });

  it("leaves out calls that never went out: declined, refused addresses, refused from the terminal", () => {
    const left = whatLeft([
      { name: "web_fetch", input: { url: "https://example.com/a" }, result: "Error: the user declined to run 'web_fetch'." },
      { name: "web_fetch", input: { url: "https://example.com/b" }, result: "Error: Could not fetch URL: x is on this computer or the local network (10.0.0.1)" },
      { name: "web_fetch", input: { url: "https://example.com/c" }, result: "web_fetch: refused — a request from the terminal needs allow=destructive for it" },
    ]);
    expect(left).toEqual({ sites: [], servers: [] });
  });
});

describe("whatLeftLine (#409)", () => {
  it("says the sites and the server in one sentence, and nothing when there are none", () => {
    expect(whatLeftLine({ sites: ["a.org", "b.org"], servers: ["s"] }))
      .toBe("Besides the model, this answer reached pages on a.org, b.org and the MCP server s.");
    expect(whatLeftLine({ sites: [], servers: [] })).toBe("");
  });
});
