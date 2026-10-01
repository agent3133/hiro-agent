// Keys by their keychain name; the old Secrets tab's names migrate once (#147).
import { describe, expect, it } from "vitest";

import { connectionApproval } from "./deviceApprovals";
import { KEYCHAIN_NAME, migrateDeviceApprovals, migrateMcpApprovals, migrateReferences, renameIn, renames }
  from "./keychainRefs";

const BINDINGS = [{ env: "OPENAI_API_KEY", id: "openai-api-key" }, { env: "LLM_API_KEY", id: "" },
                  { env: "GITHUB_TOKEN", id: "work-github" }];

describe("renames", () => {
  it("maps each old name to its keychain entry, the default entry when the binding named none", () => {
    expect(renames(BINDINGS)).toEqual({ OPENAI_API_KEY: "openai-api-key", LLM_API_KEY: "llm-api-key",
                                        GITHUB_TOKEN: "work-github" });
  });

  it("skips bindings that lead nowhere or change nothing, and anything that is not a list", () => {
    expect(renames([{ env: "", id: "x" }, { env: "same", id: "same" }, { env: "BAD", id: "Not Valid!" }])).toEqual({});
    expect(renames(undefined)).toEqual({});
    expect(renames({ env: "X" })).toEqual({});
  });
});

describe("migrateReferences", () => {
  it("renames every reference in the settings, however deep, and nothing else", () => {
    const values = {
      llm_profiles: { cloud: { api_key: "${OPENAI_API_KEY}", base_url: "https://api.example.com" } },
      llm: { api_key: "${UNBOUND}" },
      mcp_servers: { gh: { env: { GITHUB_TOKEN: "${GITHUB_TOKEN}" }, args: ["--token", "${GITHUB_TOKEN}"] },
                     web: { headers: { Authorization: "Bearer ${LLM_API_KEY}" } } },
      temperature: 0.2,
    };
    expect(migrateReferences(values, renames(BINDINGS))).toEqual({
      llm_profiles: { cloud: { api_key: "${openai-api-key}", base_url: "https://api.example.com" } },
      llm: { api_key: "${UNBOUND}" },
      mcp_servers: { gh: { env: { GITHUB_TOKEN: "${work-github}" }, args: ["--token", "${work-github}"] },
                     web: { headers: { Authorization: "Bearer ${llm-api-key}" } } },
      temperature: 0.2,
    });
  });

  it("renames inside a longer text", () => {
    expect(renameIn("a ${LLM_API_KEY} b ${OTHER}", renames(BINDINGS))).toBe("a ${llm-api-key} b ${OTHER}");
  });
});

describe("the approvals follow the rename", () => {
  it("keeps a connection approved on this device under its new key name", () => {
    const before = { llm_profiles: { cloud: { api_key: "${OPENAI_API_KEY}", base_url: "https://api.example.com" } } };
    const after = migrateReferences(before, renames(BINDINGS)) as Record<string, unknown>;
    const stored = { [connectionApproval(before, "cloud")!.id]: connectionApproval(before, "cloud")!.fingerprint,
                     "programs:audio": "[\"w\",\"f\",[]]" };
    const migrated = migrateDeviceApprovals(stored, renames(BINDINGS))!;
    expect(migrated["connection:cloud"]).toBe(connectionApproval(after, "cloud")!.fingerprint);
    expect(migrated["programs:audio"]).toBe("[\"w\",\"f\",[]]");
  });

  it("renames references inside the MCP approvals' fingerprints", () => {
    const stored = [JSON.stringify(["gh", "npx", ["-y", "gh"], [["GITHUB_TOKEN", "${GITHUB_TOKEN}"]]])];
    expect(migrateMcpApprovals(stored, renames(BINDINGS))).toEqual(
      [JSON.stringify(["gh", "npx", ["-y", "gh"], [["GITHUB_TOKEN", "${work-github}"]]])]);
  });

  it("leaves stores that hold something else alone", () => {
    expect(migrateDeviceApprovals(null, {})).toBeNull();
    expect(migrateMcpApprovals("junk", {})).toBeNull();
  });
});

describe("KEYCHAIN_NAME", () => {
  it("is what Obsidian accepts as an entry's name", () => {
    expect(KEYCHAIN_NAME.test("openai-api-key")).toBe(true);
    expect(KEYCHAIN_NAME.test("OPENAI_API_KEY")).toBe(false);
    expect(KEYCHAIN_NAME.test("")).toBe(false);
  });
});
