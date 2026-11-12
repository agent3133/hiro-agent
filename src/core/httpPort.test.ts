// The network port the core reaches the network through (#418): the registry, the model client and web_fetch sending
// through a port that is not Node's, and the Node implementation pinning a checked address.
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { httpPort, setHttpPort, type HttpPort, type HttpRequest, type HttpResponse, type ResolvedAddress } from "./http";
import { OpenAiChat } from "./llm/openaiChat";
import { fetchPublic, ipFamily } from "./publicFetch";
import { nodeHttp } from "../net/nodeHttp";

/** A port that answers each request with *status*, *headers* and the body in *chunks*; it records what it was asked. */
function fakePort(reply: { status: number; headers?: Record<string, string>; chunks: Uint8Array[] }) {
  const requests: HttpRequest[] = [];
  const resolve = vi.fn(async (host: string): Promise<ResolvedAddress[]> => [{ address: `resolved-${host}`, family: 4 }]);
  const port: HttpPort = {
    request(request, onResponse) {
      requests.push(request);
      setTimeout(() => {
        const data: ((chunk: Uint8Array) => void)[] = [];
        const end: (() => void)[] = [];
        const response: HttpResponse = {
          status: reply.status,
          header: (name) => reply.headers?.[name.toLowerCase()] ?? "",
          onData: (listener) => data.push(listener),
          onEnd: (listener) => end.push(listener),
          onError: () => undefined,
          destroy: () => undefined,
        };
        onResponse(response);
        // The listeners are in place once onResponse has returned: the body arrives after that
        setTimeout(() => {
          for (const chunk of reply.chunks) for (const listener of data) listener(chunk);
          for (const listener of end) listener();
        }, 0);
      }, 0);
      return { destroy: () => undefined };
    },
    resolve,
  };
  return { port, requests, resolve };
}

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

describe("the registered port", () => {
  afterEach(() => setHttpPort(nodeHttp));

  it("is the one given when one is given", () => {
    const given: HttpPort = { request: () => ({ destroy: () => undefined }), resolve: async () => [] };
    expect(httpPort(given)).toBe(given);
  });

  it("is the registered one when none is given, which is Node's at the start of a test", () => {
    expect(httpPort()).toBe(nodeHttp);
  });

  it("is the port set last, once setHttpPort has run", () => {
    const other: HttpPort = { request: () => ({ destroy: () => undefined }), resolve: async () => [] };
    setHttpPort(other);
    expect(httpPort()).toBe(other);
    expect(httpPort(nodeHttp)).toBe(nodeHttp);
  });
});

describe("OpenAiChat through a given port", () => {
  it("sends its request through the port, to the chat completions path, with the key as a bearer token", async () => {
    const body = "data: {\"choices\":[{\"delta\":{\"content\":\"hi\"}}]}\n\ndata: [DONE]\n\n";
    const fake = fakePort({ status: 200, chunks: [encode(body)] });
    const chat = new OpenAiChat({ http: fake.port, baseUrl: "http://model.test:8080/v1", model: "m", apiKey: "k" });
    await chat.complete({ messages: [{ role: "user", content: "hello" }], tools: [] }, {});
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0].url.toString()).toBe("http://model.test:8080/v1/chat/completions");
    expect(fake.requests[0].method).toBe("POST");
    expect(fake.requests[0].headers.Authorization).toBe("Bearer k");
  });

  it("joins a character split across two chunks of the stream, so the answer reads whole", async () => {
    const bytes = encode("data: {\"choices\":[{\"delta\":{\"content\":\"hé\"}}]}\n\ndata: [DONE]\n\n");
    // "é" is two bytes, C3 A9: the stream is cut between them
    const cut = bytes.indexOf(0xc3) + 1;
    expect(bytes[cut - 1]).toBe(0xc3);
    const fake = fakePort({ status: 200, chunks: [bytes.slice(0, cut), bytes.slice(cut)] });
    const chat = new OpenAiChat({ http: fake.port, baseUrl: "http://model.test:8080/v1", model: "m", apiKey: "k" });
    const completion = await chat.complete({ messages: [{ role: "user", content: "hello" }], tools: [] }, {});
    expect(completion.content).toBe("hé");
  });

  it("rejects with an error naming the status when the port answers 401", async () => {
    const fake = fakePort({ status: 401, chunks: [encode("bad key")] });
    const chat = new OpenAiChat({ http: fake.port, baseUrl: "http://model.test:8080/v1", model: "m", apiKey: "k" });
    await expect(chat.complete({ messages: [{ role: "user", content: "hello" }], tools: [] }, {}))
      .rejects.toThrow("HTTP 401: bad key");
  });
});

describe("fetchPublic through a given port", () => {
  it("connects to the address the resolve rule gave, and never calls the port's own resolve", async () => {
    const fake = fakePort({ status: 200, headers: { "content-type": "text/html" }, chunks: [encode("<p>hi</p>")] });
    const checked: ResolvedAddress = { address: "93.184.216.34", family: 4 };
    const resolve = vi.fn(async () => [checked]);
    const page = await fetchPublic("http://public.example/page", { timeoutMs: 5_000, maxBytes: 100_000 },
                                   { http: fake.port, resolve, blocked: () => false });
    expect(page.text).toBe("<p>hi</p>");
    expect(resolve).toHaveBeenCalledWith("public.example");
    expect(fake.resolve).not.toHaveBeenCalled();
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0].address).toEqual(checked);
  });
});

describe("ipFamily", () => {
  it("is 4 for an IPv4 address, 6 for an IPv6 one, and 0 for a name or a malformed address", () => {
    expect(ipFamily("1.2.3.4")).toBe(4);
    expect(ipFamily("::1")).toBe(6);
    expect(ipFamily("example.com")).toBe(0);
    expect(ipFamily("1.2.3.999")).toBe(0);
  });
});

describe("nodeHttp", () => {
  let server: http.Server;
  let port = 0;
  let seen: { host?: string; url?: string } = {};

  beforeAll(async () => {
    server = http.createServer((request, response) => {
      seen = { host: request.headers.host, url: request.url };
      response.writeHead(200, { "Content-Type": "text/plain" });
      response.end("pong");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(() => new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  }));

  it("reaches a server at the pinned address when the name in the URL does not resolve, and sends the name as Host", async () => {
    const answer = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      nodeHttp.request({ url: new URL(`http://unresolvable.invalid:${port}/ping`), method: "GET", headers: {},
                         address: { address: "127.0.0.1", family: 4 } },
        (response) => {
          const chunks: Uint8Array[] = [];
          response.onData((chunk) => chunks.push(chunk));
          response.onEnd(() => resolve({ status: response.status, body: Buffer.concat(chunks).toString("utf8") }));
          response.onError(reject);
        }, reject);
    });
    expect(answer.status).toBe(200);
    expect(answer.body).toBe("pong");
    expect(seen.url).toBe("/ping");
    expect(seen.host).toBe(`unresolvable.invalid:${port}`);
  });
});
