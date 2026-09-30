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
  // *keychain* stands for the Secrets bindings (main.ts's secretValue), which read nothing else
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
