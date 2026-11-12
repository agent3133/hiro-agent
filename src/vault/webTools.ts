/**
 * web_fetch — ported from make_web_tools (src/obsidian_agent/tools/builtin/web.py). It fetches through
 * core/publicFetch.ts over Node's http/https, which opens pages on the internet only: every address, redirects
 * included, is checked before connecting (#138).
 *
 * Differences from Python, on purpose: an HTML page becomes Markdown through Obsidian's own `htmlToMarkdown`
 * (Python stripped it to plain text, losing links and headings). There is no web_search: search is an MCP
 * server's job, with the engine and the account the user picks (#118).
 */

import { htmlToMarkdown } from "obsidian";

import { fetchPublic } from "../core/publicFetch";

import { defineTool, type Tool } from "../core/tools/tool";

export interface WebSettings {
  fetch: { enabled: boolean; timeoutSeconds: number; maxContentLength: number };
}

export const DEFAULT_WEB: WebSettings = {
  fetch: { enabled: false, timeoutSeconds: 30, maxContentLength: 500_000 },
};

/** http → https, and a GitHub file page → its raw text — `_normalize_url`. */
export function normalizeUrl(url: string): string {
  let normalized = url.trim();
  if (normalized.startsWith("http://")) normalized = `https://${normalized.slice("http://".length)}`;
  const blob = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/(.+)$/.exec(normalized);
  return blob ? `https://raw.githubusercontent.com/${blob[1]}/${blob[2]}/${blob[3]}/${blob[4]}` : normalized;
}

function acceptHeader(format: string): string {
  const headers: Record<string, string> = {
    auto: "text/markdown, text/html", markdown: "text/markdown", html: "text/html", text: "text/plain",
  };
  return headers[format] ?? headers.auto;
}

export function truncateContent(content: string, maxLength: number): string {
  if (content.length <= maxLength) return content;
  return `${content.slice(0, maxLength)}\n\n[Content truncated to ${maxLength} characters.]`;
}

/** Text without its tags and entities. */
function plain(html: string): string {
  return html.replace(/<[^>]+>/g, "").replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").trim();
}

/**
 * An HTML page as Markdown, headed by its <title> when the body does not already say it — htmlToMarkdown drops
 * the head, and a page whose name is only in its title (example.com) would lose it.
 */
function pageMarkdown(html: string): string {
  const markdown = htmlToMarkdown(html).trim();
  const title = plain(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "").replace(/\s+/g, " ");
  return title && !markdown.includes(title) ? `# ${title}\n\n${markdown}` : markdown;
}

/** A byte count as people read it: 812 bytes, 14 KB, 2.3 MB. */
export function byteSize(bytes: number): string {
  if (bytes < 1000) return `${bytes} bytes`;
  if (bytes < 1_000_000) return `${Math.round(bytes / 1000)} KB`;
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

/**
 * Whether *error* is https failing to connect at all — refused, reset, or TLS that does not work there — after which
 * an address the model gave as http:// is worth trying as it was given (#417). A refused address, a timeout or an
 * HTTP error is not: those would fail, or mean the same, over http too.
 */
export function httpsFailedToConnect(error: unknown): boolean {
  const code = String((error as { code?: unknown } | null)?.code ?? "");
  return /^(ECONNREFUSED|ECONNRESET|EPROTO|EHOSTUNREACH|ENETUNREACH)$/.test(code)
    || /^(ERR_SSL_|ERR_TLS_|CERT_|UNABLE_TO_|DEPTH_ZERO_|SELF_SIGNED_)/.test(code);
}

/** The host a page address names, as web_fetch asks about it (#403): lowercase, without a leading "www."; "" if none. */
export function pageHost(url: string): string {
  try {
    return new URL(normalizeUrl(url)).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

/**
 * web_fetch; with *hosts*, the hosts this conversation may open pages on (#403). Opening a page sends its address
 * — and whatever a model put into it — to that host, so the first page on each host in a conversation is asked
 * about, and the host is added once allowed. Without *hosts* (the prompt preview, `agent:tool`) it does not ask.
 */
export function makeWebTools(settings: WebSettings, hosts?: Set<string>): Tool[] {
  // Switched off in Features: not offered at all; the prompt says so (config/features.ts, #145)
  if (!settings.fetch.enabled) return [];
  const webFetch = defineTool("web_fetch", async (args) => {
    const given = args.str("url").trim();
    const url = normalizeUrl(given);
    // Running means allowed: asked about, or allowed before in this conversation
    const host = pageHost(given);
    if (hosts && host) hosts.add(host);
    const options = {
      timeoutMs: settings.fetch.timeoutSeconds * 1000, headers: { Accept: acceptHeader(args.str("format")) },
      // Room for the markup a page loses on the way to Markdown; the text is cut to the limit afterwards
      maxBytes: settings.fetch.maxContentLength * 4,
      textOnly: true,
    };
    try {
      // Only pages on the internet: every address, redirects included, is checked before connecting (#138).
      // http:// is asked for as https first; a site without TLS is then asked once as given, under the same checks
      let response;
      let opened = url;
      try {
        response = await fetchPublic(url, options);
      } catch (error) {
        if (!/^http:\/\//i.test(given) || !httpsFailedToConnect(error)) throw error;
        opened = url.replace(/^https:/i, "http:");
        response = await fetchPublic(opened, options);
      }
      if (response.status >= 400) throw new Error(`HTTP ${response.status} for ${opened}`);
      if (response.binary) {
        const type = response.contentType.split(";")[0].trim() || "not text";
        const size = response.size === null ? "of unknown size" : byteSize(response.size);
        return `${opened} is ${type}, ${size}, not a page: web_fetch reads text only (web pages, Markdown, JSON, `
          + "plain text). To use the file, ask the user to save it into the vault; read_attachment reads PDFs, "
          + "documents and images there.";
      }
      const type = response.contentType.toLowerCase();
      const content = type.includes("text/html") ? pageMarkdown(response.text) : response.text;
      return truncateContent(content, settings.fetch.maxContentLength);
    } catch (error) {
      return `Error: Could not fetch URL: ${error instanceof Error ? error.message : String(error)}`;
    }
  }, {
    destructiveWhen: async (args) => {
      if (!hosts) return false;
      const host = pageHost(args.str("url"));
      return !host || !hosts.has(host);
    },
    confirmArgs: async (args) => ({ url: String(args.url ?? ""), host: pageHost(String(args.url ?? "")) }),
  });

  return [webFetch];
}
