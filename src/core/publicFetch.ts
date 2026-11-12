/**
 * GET a page from the public internet, and nothing else (#138, security review 2026-09-30).
 *
 * `web_fetch` is the model's to aim, and a note or a page can steer the model. So every address a request goes to
 * — the first and each redirect's — is resolved and checked before connecting: this computer (loopback), the local
 * network (private ranges), link-local addresses (cloud metadata at 169.254.169.254) and the like are refused. The
 * connection then goes to exactly the address that was checked, so a name that resolves differently a moment later
 * cannot slip past. Obsidian's requestUrl follows redirects out of sight, which is why this goes through the core's
 * network port (core/http.ts, #418), on desktop Node's http/https, as the model client does. The body is read up to
 * a byte limit.
 */

import { httpPort, type HttpPort, type ResolvedAddress } from "./http";

type LookupAddress = ResolvedAddress;

/** Whether *host* is an IP address as written: 4 or 6, or 0 for a name — as Node's `isIP`, without Node. */
export function ipFamily(host: string): 0 | 4 | 6 {
  if (/^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/.test(host)) return 4;
  return host.includes(":") && ipv6Bytes(host) !== null ? 6 : 0;
}

export interface PublicResponse {
  status: number;
  /** Where the page came from, after redirects. */
  url: string;
  contentType: string;
  text: string;
  /** The body was longer than the byte limit and was cut. */
  cut: boolean;
  /** The body's size as the server declared it (Content-Length), or the bytes read; null when neither is known. */
  size: number | null;
  /** The content type is not text, so the body was not read (#417): *text* is empty. */
  binary: boolean;
}

/** Whether a Content-Type names text a model can read: text/*, JSON, XML and their kin. No type counts as text. */
export function isTextType(contentType: string): boolean {
  const type = contentType.split(";")[0].trim().toLowerCase();
  if (!type || type.startsWith("text/")) return true;
  if (/\+(json|xml)$/.test(type)) return true;
  return /^application\/(json|xml|javascript|ecmascript|x-javascript|x-yaml|yaml|toml|x-toml|x-ndjson|ndjson|markdown|x-markdown|sql|graphql|x-sh|x-httpd-php)$/.test(type);
}

export interface FetchOptions {
  /** The whole fetch — looking the name up, every redirect, the download — ends after this long (#179). */
  timeoutMs: number;
  maxBytes: number;
  headers?: Record<string, string>;
  maxRedirects?: number;
  /** Leave a body that is not text unread: the answer says its type and size only (#417). */
  textOnly?: boolean;
}

/** What resolves a host name — `dns.lookup`, or a test's stand-in. */
export type Resolve = (host: string) => Promise<LookupAddress[]>;

/** How names are resolved and which addresses are refused; tests put a local server on the "internet". */
export interface FetchRules {
  resolve: Resolve;
  blocked: (address: string) => boolean;
  /** The network (#418): the plugin's registered port unless given. */
  http?: HttpPort;
}

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

/** The 16 bytes of an IPv6 address (`::` filled in, a dotted IPv4 tail read, a zone dropped); null if it is none. */
export function ipv6Bytes(address: string): number[] | null {
  let text = address.toLowerCase().replace(/%.*$/, "");
  const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (dotted) {
    const octets = dotted.slice(1).map(Number);
    if (octets.some((octet) => octet > 255)) return null;
    text = text.slice(0, dotted.index)
      + `${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const groups = (part: string): string[] => (part ? part.split(":") : []);
  const head = groups(halves[0]);
  const tail = halves.length === 2 ? groups(halves[1]) : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null;
  const all = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill("0"), ...tail];
  if (all.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return null;
  return all.flatMap((group) => [parseInt(group, 16) >> 8, parseInt(group, 16) & 0xff]);
}

const zero = (bytes: number[], from: number, to: number): boolean => bytes.slice(from, to).every((b) => b === 0);
const asV4 = (bytes: number[], at: number): string => bytes.slice(at, at + 4).join(".");

/**
 * Whether an IPv6 address is not public (#392). Forms that carry an IPv4 address (IPv4-mapped `::ffff:0:0/96`,
 * which a URL writes in hex as `[::ffff:7f00:1]`; IPv4-compatible `::/96`; SIIT `::ffff:0:0:0/96`; NAT64
 * `64:ff9b::/96`; 6to4 `2002::/16`) are judged by that IPv4 address. Teredo, local NAT64, discard, unique local,
 * link-local, site-local, multicast and documentation ranges are refused.
 */
function v6Blocked(bytes: number[]): boolean {
  if (zero(bytes, 0, 12)) return v4Blocked(asV4(bytes, 12));                                    // ::/96, :: and ::1 too
  if (zero(bytes, 0, 10) && bytes[10] === 0xff && bytes[11] === 0xff) return v4Blocked(asV4(bytes, 12));
  if (zero(bytes, 0, 8) && bytes[8] === 0xff && bytes[9] === 0xff && zero(bytes, 10, 12)) return v4Blocked(asV4(bytes, 12));
  const word = (at: number): number => (bytes[at] << 8) | bytes[at + 1];
  if (word(0) === 0x64 && word(2) === 0xff9b) {
    return zero(bytes, 4, 12) ? v4Blocked(asV4(bytes, 12)) : true;                              // 64:ff9b::/96, 64:ff9b:1::/48
  }
  if (word(0) === 0x2002) return v4Blocked(asV4(bytes, 2));
  if (word(0) === 0x2001 && word(2) === 0) return true;                                         // Teredo
  if (word(0) === 0x2001 && word(2) === 0xdb8) return true;                                     // documentation
  if (word(0) === 0x100 && zero(bytes, 2, 8)) return true;                                      // discard
  if ((bytes[0] & 0xfe) === 0xfc) return true;                                                  // fc00::/7
  if (bytes[0] === 0xfe && (bytes[1] & 0x80) === 0x80) return true;                             // fe80::/10, fec0::/10
  return bytes[0] === 0xff;                                                                     // multicast
}

/** Whether *address* (an IP) is somewhere a page from the internet may not lead the agent: not public. */
export function isBlockedAddress(address: string): boolean {
  const family = ipFamily(address);
  if (family === 4) return v4Blocked(address);
  if (family !== 6) return true;
  const bytes = ipv6Bytes(address);
  return bytes === null || v6Blocked(bytes);
}

/** The first public address *host* resolves to; an error naming why when there is none. */
async function publicAddress(host: string, rules: FetchRules): Promise<LookupAddress> {
  const bare = host.replace(/^\[|\]$/g, "");
  const family = ipFamily(bare);
  const addresses = family ? [{ address: bare, family }] : await rules.resolve(bare);
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
  const port = httpPort(rules.http);
  const checks: FetchRules = { resolve: rules.resolve ?? ((host) => port.resolve(host)),
                               blocked: rules.blocked ?? isBlockedAddress, http: port };
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
    const response = await get(checks.http!, current, target, options, signal);
    if (response.status >= 300 && response.status < 400 && response.location) {
      current = new URL(response.location, current);
      continue;
    }
    return { status: response.status, url: current.toString(), contentType: response.contentType,
             text: response.text, cut: response.cut, size: response.size, binary: response.binary };
  }
  throw new Error(`more than ${options.maxRedirects ?? 5} redirects`);
}

interface Raw {
  status: number; location: string; contentType: string; text: string; cut: boolean; size: number | null;
  binary: boolean;
}

function get(port: HttpPort, url: URL, address: LookupAddress, options: FetchOptions, signal: AbortSignal): Promise<Raw> {
  return new Promise((resolve, reject) => {
    // The connection goes to the address that was checked; the name still decides TLS and the Host header
    port.request({
      url, method: "GET", signal, address,
      headers: { "User-Agent": "Hiro Agent (Obsidian plugin)", ...options.headers },
    }, (response) => {
      const header = (name: string): string => response.header(name);
      const declared = Number.parseInt(header("content-length"), 10);
      const declaredSize = Number.isFinite(declared) && declared >= 0 ? declared : null;
      // A PDF, an image or a download: its bytes are of no use as text, so they are not fetched at all (#417)
      if (options.textOnly && !(response.status >= 300 && response.status < 400)
          && !isTextType(header("content-type"))) {
        response.destroy();
        resolve({ status: response.status, location: header("location"), contentType: header("content-type"),
                  text: "", cut: false, size: declaredSize, binary: true });
        return;
      }
      const chunks: Uint8Array[] = [];
      let size = 0;
      let cut = false;
      response.onData((chunk) => {
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
        resolve({ status: response.status, location: header("location"), contentType: header("content-type"),
                  text: utf8(chunks), cut, size: declaredSize ?? (cut ? null : size), binary: false });
      };
      response.onEnd(finish);
      response.onError((error) => (cut ? finish() : reject(error)));
    }, (error) => {
      // A cancelled request says why: the deadline's own message, not Node's "The operation was aborted"
      reject(signal.aborted ? signal.reason : error);
    });
  });
}

/** The chunks read as one UTF-8 text; a character split across two chunks is joined, not garbled. */
function utf8(chunks: Uint8Array[]): string {
  const decoder = new TextDecoder("utf-8");
  return chunks.map((chunk) => decoder.decode(chunk, { stream: true })).join("") + decoder.decode();
}
