// Whether an MCP tool's calls ask first (#403): the user's Ask first, else http, else the server's hints.
import { describe, expect, it } from "vitest";

import { asksFirst, mcpServers } from "./servers";

describe("asksFirst (#403)", () => {
  it("follows the server's hints for a stdio server's tool the user has not set", () => {
    expect(asksFirst({ transport: "stdio", askFirst: {} }, "read", false)).toBe(false);
    expect(asksFirst({ transport: "stdio", askFirst: {} }, "read", true)).toBe(true);
  });

  it("asks for an http server's tool the user has not set, even one its server calls read-only", () => {
    expect(asksFirst({ transport: "http", askFirst: {} }, "search", false)).toBe(true);
  });

  it("does what the user set, over http and over the hints", () => {
    expect(asksFirst({ transport: "http", askFirst: { search: false } }, "search", true)).toBe(false);
    expect(asksFirst({ transport: "stdio", askFirst: { read: true } }, "read", false)).toBe(true);
  });
});

describe("mcpServers reading ask_first (#403)", () => {
  it("keeps the true and false entries and drops one that is not a boolean", () => {
    const spec = mcpServers({ mcp_servers: { s: { transport: "http", url: "https://x", ask_first: { a: true, b: "no" } } } });
    expect(spec[0].askFirst).toEqual({ a: true });
  });
});
