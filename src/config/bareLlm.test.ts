// A connection without a name becomes a named one on the first start (#149, usability review).
import { describe, expect, it } from "vitest";

import { connectionApproval } from "./deviceApprovals";
import { migrateBareLlm } from "./connections";
import { renameConnectionApproval } from "./keychainRefs";

describe("migrateBareLlm", () => {
  it("moves a cloud connection to 'cloud', makes it the default and drops llm", () => {
    const moved = migrateBareLlm({ llm: { base_url: "https://api.example.com/v1", api_key: "${openai-api-key}", model: "m" } });
    expect(moved?.name).toBe("cloud");
    expect(moved?.values).toEqual({
      llm_profiles: { cloud: { base_url: "https://api.example.com/v1", api_key: "${openai-api-key}", model: "m" } },
      default_llm_profile: "cloud",
    });
  });

  it("names a llama.cpp server 'local'", () => {
    expect(migrateBareLlm({ llm: { provider: "llamacpp", base_url: "http://127.0.0.1:8080" } })?.name).toBe("local");
  });

  it("picks a free name and keeps a valid default", () => {
    const moved = migrateBareLlm({
      llm: { api_key: "${k}" },
      llm_profiles: { cloud: { base_url: "x" }, "cloud-2": { base_url: "y" } },
      default_llm_profile: "cloud",
    });
    expect(moved?.name).toBe("cloud-3");
    expect(moved?.values.default_llm_profile).toBe("cloud");
    expect(Object.keys(moved?.values.llm_profiles as object)).toEqual(["cloud", "cloud-2", "cloud-3"]);
  });

  it("replaces a default that names no connection", () => {
    const moved = migrateBareLlm({ llm: { api_key: "${k}" }, default_llm_profile: "gone" });
    expect(moved?.values.default_llm_profile).toBe("cloud");
  });

  it("leaves settings without an address or a key alone", () => {
    expect(migrateBareLlm({})).toBeNull();
    expect(migrateBareLlm({ llm: { temperature: 0.2 } })).toBeNull();
  });

  it("keeps the connection approved under its new name", () => {
    const before = { llm: { api_key: "${k}", base_url: "https://a.example/v1" } };
    const bare = connectionApproval(before, "");
    const moved = migrateBareLlm(before);
    const stored = renameConnectionApproval({ [bare!.id]: bare!.fingerprint, "programs:audio": "p" }, moved!.name);
    const after = connectionApproval(moved!.values, moved!.name);
    expect(stored).toEqual({ [after!.id]: after!.fingerprint, "programs:audio": "p" });
  });

  it("changes no approvals when the bare connection had none", () => {
    expect(renameConnectionApproval({ "programs:audio": "p" }, "cloud")).toBeNull();
    expect(renameConnectionApproval(null, "cloud")).toBeNull();
  });
});
