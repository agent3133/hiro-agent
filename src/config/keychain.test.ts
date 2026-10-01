// Keys live only in Obsidian's keychain (#86): which fields hold one written out, and where a connection's key comes from.
import { describe, expect, it } from "vitest";

import { resolveConnection } from "./connections";
import { literalSecrets } from "./masking";

describe("literalSecrets", () => {
  it("names the credential fields that hold a key rather than a reference", () => {
    const values = {
      llm: { api_key: "sk-written-out", model: "m" },
      llm_profiles: { cloud: { api_key: "${OPENAI_API_KEY}" }, other: { api_key: "" }, third: { api_key: "k" } },
      mcp: { servers: [{ env: { GITHUB_TOKEN: "ghp_x" } }] },
    };
    expect(literalSecrets(values)).toEqual(["llm.api_key", "llm_profiles.third.api_key", "mcp.servers.0.env.GITHUB_TOKEN"]);
  });
});

describe("resolveConnection's key: from the keychain only", () => {
  // *keychain* stands for Obsidian's keychain (main.ts's secretValue), which is read and nothing else
  const keychain = (vars: Record<string, string>) => (name: string): string | undefined => vars[name];

  it("reads the key a ${VAR} reference names", () => {
    expect(resolveConnection({ llm: { provider: "openai", api_key: "${LLM_API_KEY}" } }, "",
                              keychain({ LLM_API_KEY: "mine" })).apiKey).toBe("mine");
  });

  it("has no OPENAI_API_KEY fallback, unlike Python's OpenAI client", () => {
    expect(resolveConnection({ llm: { provider: "openai" } }, "", keychain({ OPENAI_API_KEY: "k" })).apiKey)
      .toBeUndefined();
  });

  it("never uses a key written into the settings", () => {
    expect(resolveConnection({ llm: { provider: "openai", api_key: "sk-written-out" } }, "", keychain({})).apiKey)
      .toBeUndefined();
  });

  it("has no key when the reference names nothing in the keychain", () => {
    expect(resolveConnection({ llm: { provider: "openai", api_key: "${NOT_BOUND}" } }, "", keychain({})).apiKey)
      .toBeUndefined();
  });
});

describe("literalSecrets beyond the credential fields (#138)", () => {
  // Joined at runtime, so no file holds a whole token for secret scanners to flag
  const fake = (...parts: string[]): string => parts.join("");
  const KEY = fake("sk-", "abcdefghijklmnopqrstuvwxyz0123456789");
  const GOOGLE = fake("AIza", "SyD-1234567890abcdefghijklmnopqrstuvw");

  it("finds a key written into an MCP server's arguments, env under another name, or URL", () => {
    const values = { mcp_servers: {
      local: { transport: "stdio", command: "npx", args: ["-y", "server", "--api-key", KEY], env: { OPENAI_KEY: KEY } },
      remote: { transport: "http", url: `https://maps.example/mcp?key=${GOOGLE}` },
    } };
    expect(literalSecrets(values)).toEqual(["mcp_servers.local.args.3", "mcp_servers.local.env.OPENAI_KEY",
                                            "mcp_servers.remote.url"]);
  });

  it("leaves references and ordinary values alone", () => {
    const values = { mcp_servers: { local: { command: "npx", args: ["-y", "server", "--api-key", "${SERVER_KEY}"],
                                             env: { MODE: "fast", OPENAI_KEY: "${OPENAI_API_KEY}" } },
                                    remote: { url: "https://maps.example/mcp?region=eu" } },
                     llm: { model: "gpt-5", base_url: "https://api.example.com/v1" } };
    expect(literalSecrets(values)).toEqual([]);
  });
});
