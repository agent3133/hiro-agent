import { requestUrl } from "obsidian";

import type { ProbeAnswer } from "./connections";

/**
 * GET a URL on the user's behalf, for "is anything there?" — llama-server detection and a connection's test.
 * `requestUrl`, like every call here, because the renderer's own fetch is blocked cross-origin. Credentials only
 * when a test on this device passes them (#149).
 */
export async function probe(url: string, headers?: Record<string, string>): Promise<ProbeAnswer | null> {
  try {
    const response = await requestUrl({ url, method: "GET", throw: false, headers });
    let body: unknown = response.text;
    try {
      body = JSON.parse(response.text);
    } catch {
      // not JSON; the status is what matters
    }
    return { status: response.status, body };
  } catch {
    return null;  // refused, or no such host
  }
}
