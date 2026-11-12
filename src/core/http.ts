/**
 * The network as the core sees it (#418): one request at a time, the answer streamed. The core — the model clients
 * (llm/openaiChat.ts, llm/openaiResponses.ts) and web_fetch's checked fetch (publicFetch.ts) — reaches the network
 * only through this port, as it reaches the vault through VaultPort; the implementation on Node's http/https lives
 * outside the core (net/nodeHttp.ts). The mobile app has no Node, so this is the seam another implementation fits.
 *
 * The port is given where a client is made (`LlmSettings.http`, `fetchPublic`'s rules), or else the one the plugin
 * registered at its start (`setHttpPort`).
 */

/** An address a name resolved to: what the request connects to after the checks (publicFetch). */
export interface ResolvedAddress {
  address: string;
  family: number;
}

export interface HttpRequest {
  url: URL;
  method: "GET" | "POST";
  headers: Record<string, string | number>;
  body?: string;
  signal?: AbortSignal;
  /** Connect to this address, already checked, instead of looking the name up again; TLS still names the host. */
  address?: ResolvedAddress;
}

/** An answer, its body arriving in parts. */
export interface HttpResponse {
  status: number;
  /** A header's value, "" when absent; *name* in lowercase. */
  header(name: string): string;
  onData(listener: (chunk: Uint8Array) => void): void;
  onEnd(listener: () => void): void;
  onError(listener: (error: Error) => void): void;
  /** Stop reading: the rest of the body is not wanted. */
  destroy(): void;
}

/** A request on its way: destroyed, it ends with *error* (a timeout says why). */
export interface HttpCall {
  destroy(error?: Error): void;
}

export interface HttpPort {
  /** Send *request*; *onResponse* gets the answer once its head arrives, *onError* a failure before or after. */
  request(request: HttpRequest, onResponse: (response: HttpResponse) => void, onError: (error: Error) => void): HttpCall;
  /** Every address *host* resolves to, for the checks before connecting (publicFetch). */
  resolve(host: string): Promise<ResolvedAddress[]>;
}

let registered: HttpPort | null = null;

/** The port the plugin (or a test's setup) gives the core at its start. */
export function setHttpPort(port: HttpPort): void {
  registered = port;
}

/** *given*, or the registered port; a core used before one was registered says so. */
export function httpPort(given?: HttpPort): HttpPort {
  const port = given ?? registered;
  if (!port) throw new Error("no network port registered (setHttpPort): the plugin sets one when it starts");
  return port;
}
