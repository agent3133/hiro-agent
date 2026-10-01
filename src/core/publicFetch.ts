/**
 * GET a page from the public internet, and nothing else (#138, security review 2026-09-30).
 *
 * `web_fetch` is the model's to aim, and a note or a page can steer the model. So every address a request goes to
 * — the first and each redirect's — is resolved and checked before connecting: this computer (loopback), the local
 * network (private ranges), link-local addresses (cloud metadata at 169.254.169.254) and the like are refused. The
 * connection then goes to exactly the address that was checked, so a name that resolves differently a moment later
 * cannot slip past. Obsidian's requestUrl follows redirects out of sight, which is why this uses Node's http/https,
 * as the model client does. The body is read up to a byte limit.
 */

import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import * as http from "node:http";
import * as https from "node:https";
import { isIP } from "node:net";

import { certificateAuthorities } from "./tlsTrust";

export interface PublicResponse {
  status: number;
  /** Where the page came from, after redirects. */
  url: string;
  contentType: string;
  text: string;
  /** The body was longer than the byte limit and was cut. */
  cut: boolean;
}

export interface FetchOptions {
  /** The whole fetch — looking the name up, every redirect, the download — ends after this long (#179). */
  timeoutMs: number;
  maxBytes: number;
  headers?: Record<string, string>;
  maxRedirects?: number;
}

/** What resolves a host name — `dns.lookup`, or a test's stand-in. */
export type Resolve = (host: string) => Promise<LookupAddress[]>;

/** How names are resolved and which addresses are refused; tests put a local server on the "internet". */
export interface FetchRules {
  resolve: Resolve;
  blocked: (address: string) => boolean;
}

const resolveWithDns: Resolve = (host) => new Promise((resolve, reject) => {
  dnsLookup(host, { all: true, verbatim: true }, (error, addresses) => (error ? reject(error) : resolve(addresses)));
});

/** IPv4 ranges that are not the public internet, as [first octets, prefix length]. */
const PRIVATE_V4: [number[], number][] = [
  [[0], 8], [[10], 8], [[100, 64], 10], [[127], 8], [[169, 254], 16], [[172, 16], 12], [[192, 0, 0], 24],
  [[192, 0, 2], 24], [[192, 168], 16], [[198, 18], 15], [[198, 51, 100], 24], [[203, 0, 113], 24], [[224], 4],
  [[240], 4],
];

function v4Blocked(address: string): boolean {
  const value = address.split(".").reduce((sum, part) => sum * 256 + Number(part), 0);
  return PRIVATE_V4.some(([octets, prefix]) => {
    const base = [...octets, 0, 0, 0, 0].slice(0, 4).reduce((sum, part) => sum * 256 + part, 0);
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    return ((value & mask) >>> 0) === ((base & mask) >>> 0);
  });
}

/** Whether *address* (an IP) is somewhere a page from the internet may not lead the agent: not public. */
export function isBlockedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return v4Blocked(address);
  if (family !== 6) return true;
  const lower = address.toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower)?.[1];
  if (mapped) return v4Blocked(mapped);
  if (lower === "::" || lower === "::1") return true;
  // fc00::/7 unique local, fe80::/10 link-local, ff00::/8 multicast, 2001:db8::/32 documentation
  return /^f[cd]/.test(lower) || /^fe[89ab]/.test(lower) || lower.startsWith("ff") || lower.startsWith("2001:db8:");
}

/** The first public address *host* resolves to; an error naming why when there is none. */
async function publicAddress(host: string, rules: FetchRules): Promise<LookupAddress> {
  const bare = host.replace(/^\[|\]$/g, "");
  const addresses = isIP(bare) ? [{ address: bare, family: isIP(bare) }] : await rules.resolve(bare);
  if (!addresses.length) throw new Error(`${host} does not resolve`);
  // Every address it resolves to must be public: a name that also points inward is refused as a whole
  const blocked = addresses.find((one) => rules.blocked(one.address));
  if (blocked) {
    throw new Error(`${host} is on this computer or the local network (${blocked.address}); web_fetch opens only `
      + "pages on the internet");
  }
  return addresses[0];
}

/** GET *url* from the public internet, following up to *maxRedirects* redirects, each one checked again. */
export async function fetchPublic(url: string, options: FetchOptions, rules: Partial<FetchRules> = {}):
    Promise<PublicResponse> {
  const checks: FetchRules = { resolve: rules.resolve ?? resolveWithDns, blocked: rules.blocked ?? isBlockedAddress };
  // One deadline for all of it, which cancels what is running when it passes (#179)
  const deadline = new AbortController();
  const stop = setTimeout(() => deadline.abort(new Error(`no answer within ${Math.round(options.timeoutMs / 1000)} seconds`)),
                          options.timeoutMs);
  try {
    return await fetchWithin(url, options, checks, deadline.signal);
  } finally {
    clearTimeout(stop);
  }
}

async function fetchWithin(url: string, options: FetchOptions, checks: FetchRules, signal: AbortSignal):
    Promise<PublicResponse> {
  const abortable = <T>(work: Promise<T>): Promise<T> => new Promise<T>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    work.then(resolve, reject);
  });
  let current = new URL(url);
  for (let hop = 0; hop <= (options.maxRedirects ?? 5); hop += 1) {
    if (current.protocol !== "https:" && current.protocol !== "http:") {
      throw new Error(`only http and https pages can be opened, not ${current.protocol}`);
    }
    const target = await abortable(publicAddress(current.hostname, checks));
    const response = await get(current, target, options, signal);
    if (response.status >= 300 && response.status < 400 && response.location) {
      current = new URL(response.location, current);
      continue;
    }
    return { status: response.status, url: current.toString(), contentType: response.contentType,
             text: response.text, cut: response.cut };
  }
  throw new Error(`more than ${options.maxRedirects ?? 5} redirects`);
}

interface Raw { status: number; location: string; contentType: string; text: string; cut: boolean }

function get(url: URL, address: LookupAddress, options: FetchOptions, signal: AbortSignal): Promise<Raw> {
  const secure = url.protocol === "https:";
  return new Promise((resolve, reject) => {
    const request = (secure ? https : http).request(url, {
      method: "GET",
      signal,
      headers: { "User-Agent": "Hiro Agent (Obsidian plugin)", ...options.headers },
      ca: secure ? certificateAuthorities() : undefined,
      // The connection goes to the address that was checked; the name still decides TLS and the Host header
      lookup: (_host, lookupOptions, callback) => {
        if ((lookupOptions as { all?: boolean }).all) callback(null, [address]);
        else callback(null, address.address, address.family);
      },
    }, (response) => {
      const chunks: Uint8Array[] = [];
      let size = 0;
      let cut = false;
      response.on("data", (chunk: Uint8Array) => {
        if (cut) return;
        size += chunk.length;
        if (size > options.maxBytes) {
          chunks.push(chunk.subarray(0, chunk.length - (size - options.maxBytes)));
          cut = true;
          response.destroy();
          finish();
          return;
        }
        chunks.push(chunk);
      });
      let done = false;
      const finish = (): void => {
        if (done) return;
        done = true;
        const header = (name: string): string => String(response.headers[name] ?? "");
        resolve({ status: response.statusCode ?? 0, location: header("location"), contentType: header("content-type"),
                  text: utf8(chunks), cut });
      };
      response.on("end", finish);
      response.on("error", (error) => (cut ? finish() : reject(error)));
    });
    // A cancelled request says why: the deadline's own message, not Node's "The operation was aborted"
    request.on("error", (error) => reject(signal.aborted ? signal.reason : error));
    request.end();
  });
}

/** The chunks read as one UTF-8 text; a character split across two chunks is joined, not garbled. */
function utf8(chunks: Uint8Array[]): string {
  const decoder = new TextDecoder("utf-8");
  return chunks.map((chunk) => decoder.decode(chunk, { stream: true })).join("") + decoder.decode();
}
