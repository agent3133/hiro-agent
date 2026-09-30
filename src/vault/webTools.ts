/**
 * web_fetch — ported from make_web_tools (src/obsidian_agent/tools/builtin/web.py), on Obsidian's
 * `requestUrl`, which is not held to the renderer's cross-origin rules (#84).
 *
 * Differences from Python, on purpose: an HTML page becomes Markdown through Obsidian's own `htmlToMarkdown`
 * (Python stripped it to plain text, losing links and headings). There is no web_search: search is an MCP
 * server's job, with the engine and the account the user picks (#118).
 */

import { htmlToMarkdown, requestUrl } from "obsidian";

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

function withTimeout<T>(promise: Promise<T>, seconds: number): Promise<T> {
  return Promise.race([promise, new Promise<T>((_, reject) => window.setTimeout(
    () => reject(new Error(`no answer within ${seconds} seconds`)), seconds * 1000))]);
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

export function makeWebTools(settings: WebSettings): Tool[] {
  const webFetch = defineTool("web_fetch", async (args) => {
    if (!settings.fetch.enabled) {
      return "Error: opening web pages is switched off. The user can switch it on under Settings → Hiro Agent → "
        + "Features → Open web pages.";
    }
    const url = normalizeUrl(args.str("url"));
    try {
      const response = await withTimeout(requestUrl({ url, headers: { Accept: acceptHeader(args.str("format")) },
                                                      throw: false }), settings.fetch.timeoutSeconds);
      if (response.status >= 400) throw new Error(`HTTP ${response.status} for ${url}`);
      const type = (response.headers["content-type"] ?? response.headers["Content-Type"] ?? "").toLowerCase();
      const content = type.includes("text/html") ? pageMarkdown(response.text) : response.text;
      return truncateContent(content, settings.fetch.maxContentLength);
    } catch (error) {
      return `Error: Could not fetch URL: ${error instanceof Error ? error.message : String(error)}`;
    }
  });

  return [webFetch];
}
