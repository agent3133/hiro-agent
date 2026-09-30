/**
 * `fetch` over Node's http/https, for the MCP SDK's streamable HTTP transport.
 *
 * Obsidian's renderer has the browser's fetch, which a server without CORS headers refuses, and `requestUrl`,
 * which cannot stream — and an MCP answer may come as a stream of server-sent events. Node's http has neither
 * limit (the same reason core/llm/openaiChat.ts uses it). The answer is a web `Response` whose body streams.
 */

import * as http from "node:http";
import * as https from "node:https";

import { certificateAuthorities } from "../core/tlsTrust";

export async function nodeFetch(input: string | URL, init: RequestInit = {}): Promise<Response> {
  const url = new URL(String(input));
  const transport = url.protocol === "https:" ? https : url.protocol === "http:" ? http : null;
  if (!transport) throw new TypeError(`cannot fetch ${url.protocol} URLs`);
  const headers: Record<string, string> = {};
  new Headers(init.headers).forEach((value, key) => { headers[key] = value; });
  const body = typeof init.body === "string" ? init.body : init.body == null ? undefined : String(init.body);
  if (body !== undefined) headers["content-length"] = String(Buffer.byteLength(body));
  const signal = init.signal ?? undefined;
  signal?.throwIfAborted();

  return new Promise((resolve, reject) => {
    // A connection of its own per request, as for the model (openaiChat.ts: agent: false)
    // The system's certificates too, as requestUrl trusts them (#113)
    const ca = url.protocol === "https:" ? certificateAuthorities() : undefined;
    const req = transport.request(url, { method: init.method ?? "GET", headers, agent: false, signal, ...(ca ? { ca } : {}) },
                                  (res) => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          res.on("data", (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk)));
          res.on("end", () => controller.close());
          res.on("error", (error) => controller.error(error));
        },
        cancel() {
          res.destroy();
        },
      });
      const responseHeaders = new Headers();
      for (const [key, value] of Object.entries(res.headers)) {
        if (value === undefined) continue;
        for (const one of Array.isArray(value) ? value : [value]) responseHeaders.append(key, one);
      }
      const status = res.statusCode ?? 0;
      // A Response cannot carry a body with these statuses
      const empty = status === 204 || status === 205 || status === 304 || init.method === "HEAD";
      if (empty) res.resume();
      resolve(new Response(empty ? null : stream, { status, statusText: res.statusMessage, headers: responseHeaders }));
    });
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}
