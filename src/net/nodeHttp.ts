/**
 * The core's network port (core/http.ts) on Node's http and https (#418): what the model clients and web_fetch used
 * directly before. Outside the core, so the core runs where Node does not (the mobile plan, M10).
 *
 * - A connection of its own per request (`agent: false`): Node's default agent keeps connections alive, and a request
 *   sent right after the last answer reused the socket llama-server was closing (ECONNRESET).
 * - The system's certificates too, as Obsidian's requestUrl trusts them (#113, net/tlsTrust.ts).
 * - A request pinned to a checked address connects there; the name still decides TLS and the Host header (#138).
 */

import { lookup as dnsLookup } from "node:dns";
import * as http from "node:http";
import * as https from "node:https";
import type { LookupFunction } from "node:net";

import type { HttpPort, HttpResponse, ResolvedAddress } from "../core/http";
import { certificateAuthorities } from "./tlsTrust";

export const nodeHttp: HttpPort = {
  request(request, onResponse, onError) {
    const secure = request.url.protocol === "https:";
    const transport = secure ? https : http;
    const ca = secure ? certificateAuthorities() : undefined;
    const pinned = request.address;
    const lookup: LookupFunction | undefined = pinned ? (_host, options, callback) => {
      if (options.all) callback(null, [pinned]);
      else callback(null, pinned.address, pinned.family);
    } : undefined;
    const req = transport.request(request.url, {
      method: request.method, headers: request.headers, signal: request.signal, agent: false,
      ...(ca ? { ca } : {}),
      ...(lookup ? { lookup } : {}),
    }, (res) => {
      const response: HttpResponse = {
        status: res.statusCode ?? 0,
        header: (name) => {
          const value = res.headers[name.toLowerCase()];
          return Array.isArray(value) ? value.join(", ") : String(value ?? "");
        },
        onData: (listener) => res.on("data", (chunk: Buffer) => listener(new Uint8Array(chunk))),
        onEnd: (listener) => res.on("end", listener),
        onError: (listener) => res.on("error", listener),
        destroy: () => res.destroy(),
      };
      onResponse(response);
    });
    req.on("error", onError);
    req.end(request.body);
    return { destroy: (error) => req.destroy(error) };
  },

  resolve(host) {
    // In the order the system gives them: dns.lookup's "verbatim" (#394)
    return new Promise<ResolvedAddress[]>((resolve, reject) => {
      dnsLookup(host, { all: true, order: "verbatim" }, (error, addresses) => (error ? reject(error) : resolve(addresses)));
    });
  },
};
