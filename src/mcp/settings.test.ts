// MCP servers in the agent's settings (#87): which tools an agent gets, what the Agents tab lists, what a stdio
// server needs before it may start, and the change the settings form saves.
import { describe, expect, it } from "vitest";

import { isLiteralSecret, isReference } from "../config/masking";
import { ConfigStore } from "../config/store";
import type { Tool } from "../core/tools/tool";
import { assembleTools, mcpPrompt, mcpToolInfos, wantsMcp } from "./agentTools";
import { McpApprovals } from "./approvals";
import { draftOf, emptyDraft, serverChange } from "./draft";
import { commandLine, displayName, fillReferences, mcpServers } from "./servers";

const tool = (name: string, destructive = false): Tool =>
  ({ name, description: `${name} does it.\nMore.`, parameters: { type: "object", properties: {}, required: [] },
     destructive, run: async () => name }) as Tool;

const BUILTIN = [tool("read_note"), tool("search_vault")];
const MCP = [tool("files__read"), tool("files__write", true), tool("web__fetch")];
const SERVERS = mcpServers({ mcp_servers: {
  files: { transport: "stdio", command: "npx", args: ["-y", "server files", "${vault_path}"], env: { TOKEN: "${FILES_TOKEN}" } },
  web: { transport: "http", url: "https://example.com/mcp", headers: { Authorization: "Bearer ${WEB}" } },
  broken: { transport: "carrier-pigeon" },
} });

describe("the agent's tools", () => {
  it("are exactly the listed ones, in the agent's order, mcp:* standing for every MCP tool", () => {
    const tools = assembleTools(["search_vault", "mcp:*", "read_note", "files__read"], BUILTIN, MCP, false);
    expect(tools.map((one) => one.name)).toEqual(["search_vault", "files__read", "files__write", "web__fetch", "read_note"]);
  });

  it("take one server's tool by its name", () => {
    expect(assembleTools(["web__fetch", "nope__tool"], BUILTIN, MCP, false).map((one) => one.name)).toEqual(["web__fetch"]);
  });

  it("have no MCP tool for a folder-restricted agent", () => {
    expect(assembleTools(["read_note", "mcp:*", "files__read"], BUILTIN, MCP, true).map((one) => one.name)).toEqual(["read_note"]);
  });

  it("ask the servers only when the agent lists an MCP tool and is not restricted", () => {
    expect(wantsMcp(["read_note"], false)).toBe(false);
    expect(wantsMcp(["read_note", "mcp:*"], false)).toBe(true);
    expect(wantsMcp(["files__read"], false)).toBe(true);
    expect(wantsMcp(["mcp:*"], true)).toBe(false);
  });
});

describe("the Agents tab's MCP switches", () => {
  it("are one MCP group, All MCP tools first, each tool shown as server: tool, all withheld when restricted", () => {
    const infos = mcpToolInfos(SERVERS, MCP);
    expect(infos.map((info) => [info.name, info.label, info.group])).toEqual([
      ["mcp:*", "All MCP tools", "MCP"], ["files__read", "files: read", "MCP"], ["files__write", "files: write", "MCP"],
      ["web__fetch", "web: fetch", "MCP"],
    ]);
    expect(infos.every((info) => info.ignores_scope)).toBe(true);
    expect(infos.find((info) => info.name === "files__read")).toMatchObject({ runs_programs: true, leaves_machine: false,
                                                                               description: "files__read does it." });
    expect(infos.find((info) => info.name === "web__fetch")).toMatchObject({ runs_programs: false, leaves_machine: true });
    expect(infos.find((info) => info.name === "files__write")!.destructive).toBe(true);
  });

  it("are none without a server", () => {
    expect(mcpToolInfos([], [])).toEqual([]);
  });
});

describe("what the model is told about MCP", () => {
  it("names each server and its tools, so it knows which of its tools are MCP's", () => {
    const text = mcpPrompt([...BUILTIN, MCP[0], MCP[2]]);
    expect(text).toContain("Some of your tools come from MCP (Model Context Protocol) servers");
    expect(text).toContain("\n- files: read\n- web: fetch\n");
    expect(text).toContain("You have no other MCP tools.");
  });

  it("is nothing for an agent without MCP tools", () => {
    expect(mcpPrompt(BUILTIN)).toBe("");
  });

  it("names a tool as a person reads it, and leaves a built-in one alone", () => {
    expect(displayName("everything__echo")).toBe("everything: echo");
    expect(displayName("everything__get__env")).toBe("everything: get__env");
    expect(displayName("read_note")).toBe("read_note");
  });
});

describe("the servers in the settings", () => {
  it("are read with Python's defaults, and one with an unknown transport is left out", () => {
    expect(SERVERS.map((spec) => spec.name)).toEqual(["files", "web"]);
    expect(SERVERS[1]).toMatchObject({ enabled: true, toolsFilter: ["*"], command: "", args: [] });
  });

  it("show a stdio server's command line as written, references and all", () => {
    expect(commandLine(SERVERS[0])).toBe('TOKEN="${FILES_TOKEN}" npx -y "server files" "${vault_path}"');
  });

  it("fill ${vault_path} and a keychain reference, and refuse one with no key", () => {
    const keychain = (name: string): string | undefined => ({ K: "secret" } as Record<string, string>)[name];
    expect(fillReferences("${vault_path}/x Bearer ${K}", "w", "C:/v", keychain)).toBe("C:/v/x Bearer secret");
    expect(() => fillReferences("${NONE}", "files's env TOKEN", "C:/v", keychain))
      .toThrow("files's env TOKEN names ${NONE}, which is not in Obsidian's keychain on this device (Settings → Keychain)");
  });
});

describe("approvals", () => {
  function approvals() {
    let stored: unknown = null;
    return new McpApprovals(() => stored, (value) => { stored = value; });
  }

  it("are needed by a stdio server, and by an http one that sends a key (#136)", () => {
    const made = approvals();
    expect(made.approved(SERVERS[0])).toBe(false);
    expect(made.approved(SERVERS[1])).toBe(false);
    made.approve(SERVERS[0]);
    made.approve(SERVERS[1]);
    expect(made.approved(SERVERS[0])).toBe(true);
    expect(made.approved(SERVERS[1])).toBe(true);
  });

  it("are not needed by an http server that sends no key", () => {
    expect(approvals().approved({ ...SERVERS[1], headers: {} })).toBe(true);
    expect(approvals().approved({ ...SERVERS[1], headers: { "X-Client": "hiro" } })).toBe(true);
  });

  it("hold for an http server's address and headers: another address is asked for again", () => {
    const made = approvals();
    made.approve(SERVERS[1]);
    expect(made.approved({ ...SERVERS[1], url: "https://peer.example/mcp" })).toBe(false);
    expect(made.approved({ ...SERVERS[1], headers: { Authorization: "Bearer ${OTHER}" } })).toBe(false);
    expect(made.approved({ ...SERVERS[1], enabled: false })).toBe(true);
  });

  it("survive a corrupt stored entry", () => {
    let stored: unknown = ["not json", "[\"x\"]"];
    const made = new McpApprovals(() => stored, (value) => { stored = value; });
    made.approve(SERVERS[0]);
    made.revoke("x");
    expect(made.approved(SERVERS[0])).toBe(true);
  });

  it("hold for one command line: a changed one is asked for again", () => {
    const made = approvals();
    made.approve(SERVERS[0]);
    expect(made.approved({ ...SERVERS[0], args: [...SERVERS[0].args, "--write"] })).toBe(false);
    expect(made.approved({ ...SERVERS[0], env: { TOKEN: "${OTHER}" } })).toBe(false);
    expect(made.approved({ ...SERVERS[0], enabled: false, toolsFilter: ["read"] })).toBe(true);
  });

  it("are replaced by a new approval of the same server, and taken back by name", () => {
    const made = approvals();
    made.approve(SERVERS[0]);
    const changed = { ...SERVERS[0], command: "node" };
    made.approve(changed);
    expect(made.approved(SERVERS[0])).toBe(false);
    expect(made.approved(changed)).toBe(true);
    made.revoke("files");
    expect(made.approved(changed)).toBe(false);
  });

  it("survive storage that holds something else", () => {
    expect(new McpApprovals(() => "garbage", () => undefined).approved(SERVERS[0])).toBe(false);
    expect(new McpApprovals(() => { throw new Error("no storage"); }, () => undefined).approved(SERVERS[0])).toBe(false);
  });
});

describe("the settings form's change", () => {
  it("writes a new stdio server whole, without nulls", () => {
    const draft = { ...emptyDraft(), name: "files", command: " npx ", args: "-y\n\n  pkg  ", env: "TOKEN=${T}" };
    expect(serverChange(draft, null, [])).toEqual({ mcp_servers: { files: {
      transport: "stdio", enabled: true, tools_filter: ["*"], command: "npx", args: ["-y", "pkg"], env: { TOKEN: "${T}" } } } });
  });

  it("removes what an edit took away: the other transport's fields, and env entries", () => {
    const draft = { ...draftOf(SERVERS[0]), env: "", toolsFilter: "read, write" };
    const change = serverChange(draft, SERVERS[0], ["files", "web"]).mcp_servers as Record<string, Record<string, unknown>>;
    expect(change.files).toMatchObject({ env: { TOKEN: null }, url: null, headers: null, tools_filter: ["read", "write"] });
  });

  it("moves a renamed server, dropping the old name", () => {
    const change = serverChange({ ...draftOf(SERVERS[1]), name: "remote" }, SERVERS[1], ["files", "web"]);
    expect(Object.keys(change.mcp_servers as object)).toEqual(["remote", "web"]);
    expect((change.mcp_servers as Record<string, unknown>).web).toBeNull();
  });

  it("refuses what cannot be a server, saying which field", () => {
    const base = { ...emptyDraft(), command: "npx" };
    expect(() => serverChange({ ...base, name: "a b" }, null, [])).toThrow("Name:");
    expect(() => serverChange({ ...base, name: "a__b" }, null, [])).toThrow("no double underscore");
    expect(() => serverChange({ ...base, name: "web" }, null, ["web"])).toThrow("already a server called 'web'");
    expect(() => serverChange({ ...base, name: "x", command: " " }, null, [])).toThrow("Command:");
    expect(() => serverChange({ ...base, name: "x", env: "NOEQUALS" }, null, [])).toThrow("Environment: 'NOEQUALS'");
    expect(() => serverChange({ ...emptyDraft(), name: "x", transport: "http", url: "ftp://x" }, null, [])).toThrow("URL:");
  });

  it("round-trips through the store's schema check", async () => {
    let stored: Record<string, unknown> = {};
    const store = new ConfigStore(() => stored, async (next) => { stored = next; }, () => "C:/vault");
    const draft = { ...emptyDraft(), name: "web", transport: "http" as const, url: "https://x/mcp",
                    headers: "Authorization: Bearer ${WEB}" };
    expect((await store.putConfig(serverChange(draft, null, []))).ok).toBe(true);
    const saved = mcpServers(stored)[0];
    expect(saved.headers).toEqual({ Authorization: "Bearer ${WEB}" });
    const edited = { ...draftOf(saved), transport: "stdio" as const, command: "node" };
    expect((await store.putConfig(serverChange(edited, saved, ["web"]))).ok).toBe(true);
    expect((stored.mcp_servers as Record<string, Record<string, unknown>>).web).toEqual({
      transport: "stdio", enabled: true, tools_filter: ["*"], command: "node", args: [], env: {} });
  });

  it("is refused by the store with a key written out in a header or env", async () => {
    const store = new ConfigStore(() => ({}), async () => undefined, () => "C:/vault");
    const header = { ...emptyDraft(), name: "web", transport: "http" as const, url: "https://x",
                     headers: "Authorization: Bearer sk-abc123" };
    const refused = await store.putConfig(serverChange(header, null, []));
    expect(refused.ok).toBe(false);
    expect(refused.fields.map((field) => field.path)).toContain("mcp_servers.web.headers.Authorization");
    const env = { ...emptyDraft(), name: "gh", command: "npx", env: "GITHUB_TOKEN=ghp_written_out" };
    expect((await store.putConfig(serverChange(env, null, []))).fields.map((field) => field.path))
      .toContain("mcp_servers.gh.env.GITHUB_TOKEN");
  });
});

describe("a reference, as a secret field may hold it", () => {
  it("is ${NAME} alone, or with a short word before it, as a header wants", () => {
    expect(isReference("${TOKEN}")).toBe(true);
    expect(isReference("Bearer ${TOKEN}")).toBe(true);
    expect(isReference("sk-abc${TOKEN}")).toBe(false);
    expect(isReference("Bearer abc123")).toBe(false);
    expect(isLiteralSecret("Bearer ${TOKEN}")).toBe(false);
    expect(isLiteralSecret("Bearer abc123")).toBe(true);
  });
});
