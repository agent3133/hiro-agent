// A server that stops sending ends the request with a message, and nothing keeps running (#179).
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { OpenAiChat } from "./llm/openaiChat";
import { fetchPublic, type FetchRules } from "./publicFetch";

let server: http.Server | undefined;
afterEach(() => new Promise<void>((resolve) => {
  if (!server) return resolve();
  server.closeAllConnections();
  server.close(() => resolve());
  server = undefined;
}));

/** A local server answering with *handle*; resolves to its port, and records when a request's socket closes. */
async function serve(handle: (request: http.IncomingMessage, response: http.ServerResponse) => void) {
  const closed: string[] = [];
  server = http.createServer((request, response) => {
    request.socket.on("close", () => closed.push(String(request.url)));
    handle(request, response);
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  return { port: (server.address() as AddressInfo).port, closed };
}

const until = async (check: () => boolean): Promise<void> => {
  for (let i = 0; i < 100 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 10));
};

describe("the model stream", () => {
  const chat = (port: number) => new OpenAiChat({ baseUrl: `http://127.0.0.1:${port}/v1`, model: "m",
                                                  timeouts: { firstByteMs: 300, idleMs: 200 } });
  const ask = { messages: [{ role: "user" as const, content: "hi" }], tools: [] };

  it("is stopped when the server goes quiet in the middle of an answer, with a message saying so", async () => {
    const { port } = await serve((_request, response) => {
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "Half an" } }] })}\n\n`);
      // …and then nothing more
    });
    const tokens: string[] = [];
    await expect(chat(port).complete(ask, { onContent: (text) => tokens.push(text) }))
      .rejects.toThrow(`127.0.0.1:${port} sent nothing more for 0 seconds, so the answer was stopped`);
    expect(tokens).toEqual(["Half an"]);
  });

  it("is stopped when the server never starts answering", async () => {
    const { port } = await serve(() => { /* never answers */ });
    await expect(chat(port).complete(ask, {})).rejects.toThrow("did not start answering");
  });

  it("keeps waiting while the server keeps sending, however long the whole answer takes", async () => {
    const { port } = await serve((_request, response) => {
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      let n = 0;
      const tick = setInterval(() => {
        n += 1;
        if (n <= 6) {
          response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: `${n}` } }] })}\n\n`);
          return;
        }
        clearInterval(tick);
        response.end(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
      }, 100);  // 700 ms in all: more than the idle limit, but never 200 ms silent
    });
    expect((await chat(port).complete(ask, {})).content).toBe("123456");
  });
});

describe("web_fetch's deadline", () => {
  const rules: FetchRules = { resolve: async () => [{ address: "127.0.0.1", family: 4 }], blocked: () => false };

  it("ends a page that trickles in forever, and closes the connection", async () => {
    const { port, closed } = await serve((_request, response) => {
      response.writeHead(200, { "Content-Type": "text/plain" });
      const tick = setInterval(() => response.write("x"), 20);
      response.on("close", () => clearInterval(tick));
    });
    await expect(fetchPublic(`http://public.example:${port}/drip`, { timeoutMs: 300, maxBytes: 100_000 }, rules))
      .rejects.toThrow("no answer within 0 seconds");
    await until(() => closed.includes("/drip"));
    expect(closed).toContain("/drip");
  });

  it("counts a slow name lookup against the same deadline", async () => {
    const slow: FetchRules = { resolve: () => new Promise(() => { /* never resolves */ }), blocked: () => false };
    await expect(fetchPublic("http://public.example/", { timeoutMs: 200, maxBytes: 100 }, slow))
      .rejects.toThrow("no answer within 0 seconds");
  });
});
