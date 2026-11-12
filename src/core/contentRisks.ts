/**
 * What a piece of Markdown would load or run by itself once Obsidian shows it (#395, security review 2026-11-11).
 *
 * The chat already shows remote images as links (safeMarkdown, #137). A note is shown by Obsidian, not the chat: a
 * remote image the agent writes into a note, and then opens, sends whatever its address carries — note text in a
 * query string — with `web_fetch` off. A code block for another plugin's processor (`dataviewjs`, `js-engine`)
 * runs JavaScript with Node's reach when the note is shown. So the write tools ask before they add either, and say
 * which. No Obsidian in here: which languages another plugin handles is the caller's to say.
 */

import { isRemote } from "./remoteUrl";

/** Code-block languages Obsidian handles itself, which load and run nothing of a plugin's. */
export const NATIVE_BLOCKS = new Set(["base", "query", "mermaid", "math"]);

/**
 * Languages of popular plugins that run code or queries, for where nothing better is known (outside Obsidian, or
 * when its registry cannot be read): Obsidian itself passes the languages its plugins registered.
 */
export const KNOWN_PLUGIN_BLOCKS = new Set(["dataview", "dataviewjs", "js-engine", "js-engine-debug", "run-js",
  "jsx", "templater", "tasks", "chart", "contextual-typography", "button", "meta-bind-js-view", "meta-bind-embed"]);

/** Whether a code block of *language* is handled by another plugin: true for a known plugin's language. */
export type IsPluginBlock = (language: string) => boolean;

export const knownPluginBlock: IsPluginBlock = (language) => KNOWN_PLUGIN_BLOCKS.has(language.toLowerCase());

// Inline images, `![alt](url "title")`, and reference definitions, `[id]: url`
const INLINE_IMAGE = /!\[[^\]\n]*\]\(\s*(<[^>\n]*>|[^)\s]+)/g;
const REFERENCE_IMAGE = /!\[([^\]\n]*)\](?:\[([^\]\n]*)\])?(?![([])/g;
const DEFINITION = /^ {0,3}\[([^\]\n]+)\]:\s*(<[^>\n]*>|\S+)/gm;
// An HTML tag and its attributes; any remote address in them can load (src, srcset, style's url(), poster, data)
const HTML_TAG = /<([a-z][a-z0-9-]*)\b([^>]*)>/gi;
const URL_IN_ATTRIBUTE = /(?:https?:)?\/\/[^\s"'()<>]+/gi;
const FENCE = /^ {0,3}(`{3,}|~{3,})[ \t]*([^\s`]*)/;
// Dataview's inline queries: `= expression` and `$= javascript`
const INLINE_QUERY = /`\s*\$?=[^`\n]*`/g;

/**
 * An address as a risk names it: whole, since what it carries in its query is what would leave — a second image
 * from the same host with other text in it is a new risk — and cut for the dialog.
 */
function address(url: string): string {
  const bare = url.trim().replace(/^<|>$/g, "");
  return bare.length > 120 ? `${bare.slice(0, 120)}…` : bare;
}

/** Each fenced block's language, and the prose between the blocks. */
function split(text: string): { languages: string[]; prose: string } {
  const languages: string[] = [];
  const prose: string[] = [];
  let fence: string | null = null;
  for (const line of text.split("\n")) {
    const match = FENCE.exec(line);
    if (fence) {
      if (match && match[1][0] === fence[0] && match[1].length >= fence.length && !match[2]) fence = null;
    } else if (match) {
      fence = match[1];
      if (match[2]) languages.push(match[2].toLowerCase());
    } else {
      prose.push(line);
    }
  }
  return { languages, prose: prose.join("\n") };
}

/**
 * What *text* would load or run when shown, one entry per occurrence:
 * "loads <address>" for a remote image or an HTML tag with a remote address, "runs a <language> block" for a
 * block another plugin handles, "runs an inline query" for Dataview's inline syntax.
 */
export function contentRisks(text: string, isPluginBlock: IsPluginBlock = knownPluginBlock): string[] {
  const { languages, prose } = split(text);
  const risks: string[] = [];
  for (const language of languages) {
    if (!NATIVE_BLOCKS.has(language) && isPluginBlock(language)) risks.push(`runs a ${language} block`);
  }
  // Inline code is where inline queries live; it is taken out before looking for images and tags
  for (const query of prose.match(INLINE_QUERY) ?? []) risks.push(`runs an inline query (${query.slice(0, 40)})`);
  const plain = prose.replace(/`[^`\n]*`/g, "");
  for (const match of plain.matchAll(INLINE_IMAGE)) if (isRemote(match[1])) risks.push(`loads ${address(match[1])}`);
  const definitions = new Map<string, string>();
  for (const match of plain.matchAll(DEFINITION)) definitions.set(match[1].trim().toLowerCase(), match[2]);
  for (const match of plain.matchAll(REFERENCE_IMAGE)) {
    const target = definitions.get((match[2] || match[1]).trim().toLowerCase());
    if (target && isRemote(target)) risks.push(`loads ${address(target)}`);
  }
  for (const match of plain.matchAll(HTML_TAG)) {
    // A link loads nothing until it is clicked
    if (match[1].toLowerCase() === "a") continue;
    for (const url of match[2].match(URL_IN_ATTRIBUTE) ?? []) risks.push(`loads ${address(url)}`);
    if (["script", "iframe", "object", "embed"].includes(match[1].toLowerCase())) risks.push(`runs a <${match[1]}> tag`);
  }
  return risks;
}

/**
 * What *after* would load or run that *before* did not: each risk of *after* beyond the times *before* has it, so
 * keeping an image the note already shows is not asked about, and adding a second one is.
 */
export function introducedRisks(before: string, after: string, isPluginBlock: IsPluginBlock = knownPluginBlock): string[] {
  const had = new Map<string, number>();
  for (const risk of contentRisks(before, isPluginBlock)) had.set(risk, (had.get(risk) ?? 0) + 1);
  const added: string[] = [];
  for (const risk of contentRisks(after, isPluginBlock)) {
    const left = had.get(risk) ?? 0;
    if (left > 0) had.set(risk, left - 1);
    else if (!added.includes(risk)) added.push(risk);
  }
  return added;
}

/** What a confirmation says after "When the note is shown, it would": "load https://… and run a dataviewjs block". */
export function risksSentence(risks: string[]): string {
  const said = risks.map((risk) => risk.replace(/^loads/, "load").replace(/^runs/, "run"));
  return said.length <= 1 ? said.join("") : `${said.slice(0, -1).join(", ")} and ${said[said.length - 1]}`;
}
