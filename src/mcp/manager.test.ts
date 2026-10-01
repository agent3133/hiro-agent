// MCP servers as the plugin runs them (#87), against a real server: over stdio as a child process, and over
// streamable HTTP on a local port.
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import type { ContentPart } from "../core/llm/openaiChat";
import { McpManager, McpNotApproved, resultContent, type McpHost } from "./manager";
import { nodeFetch } from "./nodeFetch";
import { fingerprint, mcpServers, type McpServerSpec } from "./servers";
// @ts-expect-error — a plain ES module shared with the stdio server, without types
import { serveHttp } from "./testing/server.mjs";

const SERVER = fileURLToPath(new URL("./testing/server.mjs", import.meta.url));

/** A host that approves what *approve* names and keeps the keychain in *keys*. */
function hostWith(keys: Record<string, string> = {}, approve: (spec: McpServerSpec) => boolean = () => true) {
  const log: string[] = [];
  const host: McpHost = {
    vaultPath: () => process.cwd(), keychain: (name) => keys[name], approved: approve,
    log: (line) => log.push(line), fetch: nodeFetch, version: "test",
  };
  return { host, log };
}

function stdio(extra: Record<string, unknown> = {}): McpServerSpec {
  return mcpServers({ mcp_servers: { local: { transport: "stdio", command: process.execPath, args: [SERVER], ...extra } } })[0];
}

const managers: McpManager[] = [];
function manager(host: McpHost): McpManager {
  const made = new McpManager(host);
  managers.push(made);
  return made;
}
afterEach(async () => {
  await Promise.all(managers.splice(0).map((made) => made.closeAll()));
});

describe("a stdio server", () => {
  it("is started, listed and called, its tools named server__tool", async () => {
    const { host, log } = hostWith();
    const { tools, failures } = await manager(host).agentTools([stdio()]);
    expect(failures).toEqual([]);
    expect(tools.map((tool) => tool.name).sort())
      .toEqual(["local__add", "local__echo", "local__environment", "local__fail", "local__look", "local__picture", "local__wipe"]);
    const echo = tools.find((tool) => tool.name === "local__echo")!;
    expect(echo.parameters.required).toEqual(["text"]);
    expect(await echo.run({ text: "hi" })).toBe("echo: hi");
    expect(log[0]).toBe(`MCP: starting 'local': ${JSON.stringify(process.execPath).includes(" ") ? JSON.stringify(process.execPath) : process.execPath} ${SERVER.includes(" ") ? JSON.stringify(SERVER) : SERVER}`);
  }, 30_000);

  it("keeps its connection between calls, and starts once", async () => {
    const { host, log } = hostWith();
    const made = manager(host);
    await made.call(stdio(), "echo", { text: "1" });
    await made.call(stdio(), "echo", { text: "2" });
    expect(log.filter((line) => line.startsWith("MCP: starting"))).toHaveLength(1);
  }, 30_000);

  it("does not start before it is approved on this device", async () => {
    const { host, log } = hostWith({}, () => false);
    const made = manager(host);
    await expect(made.tools(stdio())).rejects.toBeInstanceOf(McpNotApproved);
    const { tools, failures } = await made.agentTools([stdio()]);
    expect(tools).toEqual([]);
    expect(failures[0]).toContain("has not been approved on this device");
    expect(log).toEqual([]);
  });

  it("gets its own env from the keychain, and none of Obsidian's environment", async () => {
    process.env.OBSIDIAN_AGENT_LEAK = "should not arrive";
    try {
      const { host } = hostWith({ TOKEN: "from-the-keychain" });
      const spec = stdio({ env: { TEST_TOKEN: "${TOKEN}" }, args: [SERVER, "${vault_path}"] });
      const answer = JSON.parse(String(await manager(host).call(spec, "environment", {})));
      expect(answer).toMatchObject({ token: "from-the-keychain", leaked: null, args: [process.cwd()] });
    } finally {
      delete process.env.OBSIDIAN_AGENT_LEAK;
    }
  }, 30_000);

  it("does not start with a reference the keychain has no key for", async () => {
    const { host, log } = hostWith({});
    await expect(manager(host).tools(stdio({ env: { TEST_TOKEN: "${MISSING}" } })))
      .rejects.toThrow("local's env TEST_TOKEN names ${MISSING}, which is not in Obsidian's keychain on this device (Settings → Keychain)");
    expect(log).toEqual([]);
  });

  it("applies tools_filter", async () => {
    const { host } = hostWith();
    const { tools } = await manager(host).agentTools([stdio({ tools_filter: ["echo"] })]);
    expect(tools.map((tool) => tool.name)).toEqual(["local__echo"]);
  }, 30_000);

  it("leaves a switched-off server alone", async () => {
    const { host, log } = hostWith();
    expect(await manager(host).agentTools([stdio({ enabled: false })])).toEqual({ tools: [], failures: [] });
    expect(log).toEqual([]);
  });

  it("asks first unless the server says the tool only reads or destroys nothing — the MCP defaults (#138)", async () => {
    const { host } = hostWith();
    const { tools } = await manager(host).agentTools([stdio()]);
    const destructive = (name: string) => tools.find((tool) => tool.name === `local__${name}`)!.destructive;
    expect(destructive("wipe")).toBe(true);
    expect(destructive("echo")).toBe(true);   // no annotations: the specification's destructiveHint default, true
    expect(destructive("look")).toBe(false);  // readOnlyHint
    expect(destructive("add")).toBe(false);   // destructiveHint false
  }, 30_000);

  it("is started again after its settings change, and not after a change elsewhere", async () => {
    const { host, log } = hostWith();
    const made = manager(host);
    await made.tools(stdio());
    await made.sync([stdio(), ...mcpServers({ mcp_servers: { other: { transport: "http", url: "http://x" } } })]);
    await made.tools(stdio());
    expect(log.filter((line) => line.startsWith("MCP: starting"))).toHaveLength(1);
    await made.sync([stdio({ tools_filter: ["echo"] })]);
    await made.tools(stdio({ tools_filter: ["echo"] }));
    expect(log.filter((line) => line.startsWith("MCP: starting"))).toHaveLength(1);  // the filter is ours, not the process's
    await made.sync([stdio({ args: [SERVER, "x"] })]);
    await made.tools(stdio({ args: [SERVER, "x"] }));
    expect(log.filter((line) => line.startsWith("MCP: starting"))).toHaveLength(2);
  }, 30_000);

  it("says why a program that does not exist did not start", async () => {
    const { host } = hostWith();
    await expect(manager(host).tools(stdio({ command: "no-such-program-for-mcp" })))
      .rejects.toThrow("MCP server 'local' did not start");
  }, 30_000);
});

describe("an HTTP server", () => {
  let served: { url: string; close: () => Promise<void> };
  beforeAll(async () => { served = await serveHttp("secret-token"); });
  afterAll(async () => { await served.close(); });

  function http(headers: Record<string, string>): McpServerSpec {
    return mcpServers({ mcp_servers: { remote: { transport: "http", url: served.url, headers } } })[0];
  }

  it("is called with the header's key from the keychain", async () => {
    const { host } = hostWith({ REMOTE_TOKEN: "secret-token" });
    const { tools, failures } = await manager(host).agentTools([http({ Authorization: "Bearer ${REMOTE_TOKEN}" })]);
    expect(failures).toEqual([]);
    expect(await tools.find((tool) => tool.name === "remote__echo")!.run({ text: "over http" })).toBe("echo: over http");
  }, 30_000);

  it("reports a refused key as a failure, and the other servers still count", async () => {
    const { host } = hostWith({ REMOTE_TOKEN: "wrong" });
    const { tools, failures } = await manager(host).agentTools([http({ Authorization: "Bearer ${REMOTE_TOKEN}" }), stdio()]);
    expect(failures).toHaveLength(1);
    expect(failures[0].startsWith("remote: MCP server 'remote' did not start")).toBe(true);
    expect(tools.some((tool) => tool.name === "local__echo")).toBe(true);
  }, 30_000);

  it("sending no key, needs no approval: it runs nothing on this computer and sends nothing of this device's", async () => {
    const { host } = hostWith({}, () => false);
    // The test server refuses a request without its token, so a start that fails for that reason is a start
    const { failures } = await manager(host).agentTools([http({})]);
    expect(failures.join("")).not.toContain("has not been approved");
  }, 30_000);

  it("sending a keychain key, is not connected before this device approves it, and the key is not sent (#170)", async () => {
    const { host, log } = hostWith({ REMOTE_TOKEN: "secret-token" }, () => false);
    const made = manager(host);
    await expect(made.tools(http({ Authorization: "Bearer ${REMOTE_TOKEN}" }))).rejects.toBeInstanceOf(McpNotApproved);
    const { tools, failures } = await made.agentTools([http({ Authorization: "Bearer ${REMOTE_TOKEN}" })]);
    expect(tools).toEqual([]);
    expect(failures[0]).toContain(`sends a key from this device's keychain to ${served.url} and has not been approved`);
    expect(log.filter((line) => line.startsWith("MCP: connecting"))).toEqual([]);
  }, 30_000);

  it("sending a keychain key, is connected once approved", async () => {
    const { host } = hostWith({ REMOTE_TOKEN: "secret-token" }, (spec) => spec.name === "remote");
    expect((await manager(host).agentTools([http({ Authorization: "Bearer ${REMOTE_TOKEN}" })])).failures).toEqual([]);
  }, 30_000);
});

describe("the tools the Agents tab draws (#178)", () => {
  it("come from the last listing, and asking for them connects to nothing", async () => {
    const { host, log } = hostWith();
    const made = manager(host);
    expect(made.knownTools([stdio()])).toEqual([]);
    expect(log).toEqual([]);  // nothing was started to answer
    await made.tools(stdio());
    const names = made.knownTools([stdio()]).map((tool) => tool.name);
    expect(names).toContain("local__echo");
    expect(log.filter((line) => line.startsWith("MCP: starting"))).toHaveLength(1);
  }, 30_000);

  it("are remembered on this device, so a restart lists them without starting the server", async () => {
    const kept: Record<string, unknown> = {};
    const { host } = hostWith();
    host.rememberTools = (server, tools) => { kept[server] = tools; };
    await manager(host).tools(stdio());
    const { host: later, log } = hostWith();
    later.rememberedTools = () => kept as never;
    expect(manager(later).knownTools([stdio()]).map((tool) => tool.name)).toContain("local__echo");
    expect(log).toEqual([]);
  }, 30_000);

  it("follow the server's filter as it is now", async () => {
    const { host } = hostWith();
    const made = manager(host);
    await made.tools(stdio());
    expect(made.knownTools([stdio({ tools_filter: ["echo"] })]).map((tool) => tool.name)).toEqual(["local__echo"]);
  }, 30_000);

  it("survive a remembered list that is not a list", () => {
    const { host } = hostWith();
    host.rememberedTools = () => ({ local: "broken" }) as never;
    expect(manager(host).knownTools([stdio()])).toEqual([]);
  });
});

describe("resultContent", () => {
  it("joins text, and gives images to the model as parts", async () => {
    const { host } = hostWith();
    const picture = await manager(host).call(stdio(), "picture", {});
    expect(Array.isArray(picture)).toBe(true);
    expect((picture as ContentPart[])[0]).toEqual({ type: "text", text: "a pixel" });
    expect((picture as ContentPart[])[1]).toMatchObject({ type: "image_url" });
  }, 30_000);

  it("says a failed call is an error, as a built-in tool's is", () => {
    expect(resultContent({ content: [{ type: "text", text: "it broke" }], isError: true })).toBe("Error: it broke");
    expect(resultContent({ content: [], isError: true })).toBe("Error: the tool failed");
  });

  it("gives structured content as JSON when there is nothing else", () => {
    expect(resultContent({ content: [], structuredContent: { a: 1 } })).toBe('{"a":1}');
  });
});

describe("fingerprint", () => {
  it("changes with the command line and env, not with the filter or a switch", () => {
    const base = fingerprint(stdio());
    expect(fingerprint(stdio({ tools_filter: ["echo"], enabled: false }))).toBe(base);
    expect(fingerprint(stdio({ args: [SERVER, "--more"] }))).not.toBe(base);
    expect(fingerprint(stdio({ env: { A: "${B}" } }))).not.toBe(base);
    expect(fingerprint(stdio({ command: "other" }))).not.toBe(base);
  });
});
