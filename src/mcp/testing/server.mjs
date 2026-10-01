// A small MCP server for the tests: over stdio when run as a program, and over streamable HTTP through `serveHttp`.
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

/** 1x1 transparent PNG. */
const PIXEL = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

export function makeServer() {
  const server = new McpServer({ name: "test-server", version: "1.0.0" });
  server.registerTool("echo", { description: "Says the text back.", inputSchema: { text: z.string() } },
    async ({ text }) => ({ content: [{ type: "text", text: `echo: ${text}` }] }));
  server.registerTool("picture", { description: "A picture.", inputSchema: {} },
    async () => ({ content: [{ type: "text", text: "a pixel" }, { type: "image", data: PIXEL, mimeType: "image/png" }] }));
  server.registerTool("fail", { description: "Always fails.", inputSchema: {} },
    async () => ({ content: [{ type: "text", text: "it broke" }], isError: true }));
  server.registerTool("wipe", { description: "Destroys something.", inputSchema: {},
                                annotations: { destructiveHint: true } },
    async () => ({ content: [{ type: "text", text: "wiped" }] }));
  server.registerTool("look", { description: "Only reads.", inputSchema: {}, annotations: { readOnlyHint: true } },
    async () => ({ content: [{ type: "text", text: "looked" }] }));
  server.registerTool("add", { description: "Adds without destroying.", inputSchema: {},
                               annotations: { destructiveHint: false } },
    async () => ({ content: [{ type: "text", text: "added" }] }));
  // What the process was given: its own env entry, and whether Obsidian's environment leaked in
  server.registerTool("environment", { description: "Reports the environment.", inputSchema: {} },
    async () => ({ content: [{ type: "text", text: JSON.stringify({
      token: process.env.TEST_TOKEN ?? null, leaked: process.env.OBSIDIAN_AGENT_LEAK ?? null, cwd: process.cwd(),
      args: process.argv.slice(2) }) }] }));
  return server;
}

/** A streamable HTTP MCP server on a free port, stateless; checks `Authorization` when *token* is given. */
export async function serveHttp(token) {
  const http = createServer(async (req, res) => {
    if (token && req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405).end();
      return;
    }
    let body = "";
    for await (const chunk of req) body += chunk;
    const server = makeServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => { void transport.close(); void server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res, JSON.parse(body));
  });
  await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve));
  const { port } = http.address();
  return { url: `http://127.0.0.1:${port}/mcp`, close: () => new Promise((resolve) => http.close(resolve)) };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await makeServer().connect(new StdioServerTransport());
}
