/**
 * The certificate authorities the agent's own HTTPS requests trust (#113): Node's (its bundled list, plus any in
 * NODE_EXTRA_CA_CERTS) and the operating system's.
 *
 * The model and MCP requests go through Node's `https` so they can stream, and Node trusts only its bundled list —
 * while Obsidian's `requestUrl` (a connection's Test, the llama.cpp detection) and the browser use the system's
 * store. A reverse proxy with a certificate from one's own CA, installed in the system, then passed the Test and
 * failed in the chat. With both lists, the agent trusts what the rest of Obsidian does; a certificate no store
 * trusts is still refused.
 */

import * as tls from "node:tls";

type Lookup = (type: "default" | "system") => string[];

let cached: string[] | undefined;

/** Both lists, without duplicates; undefined (Node's own default) where Node cannot list the system's. */
export function trustedCertificates(lookup: Lookup | undefined = tls.getCACertificates): string[] | undefined {
  if (typeof lookup !== "function") return undefined;
  try {
    return [...new Set([...lookup("default"), ...lookup("system")])];
  } catch {
    return undefined;  // a system store that cannot be read: Node's default, as before
  }
}

/** `ca` for an https request: read once, since the system's store is not cheap to list. */
export function certificateAuthorities(): string[] | undefined {
  cached ??= trustedCertificates();
  return cached;
}
