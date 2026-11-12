/**
 * Which code-block languages another plugin handles, in this Obsidian (#395). A plugin's
 * `registerMarkdownCodeBlockProcessor` lands in `MarkdownPreviewRenderer.codeBlockPostProcessors`, keyed by the
 * language — not a published API, so it is read with a guard. Where it cannot be read, every language that is
 * neither Obsidian's own nor a common programming language counts as a plugin's: the block is then shown as code,
 * which costs its highlighting and nothing else.
 */

import { MarkdownPreviewRenderer } from "obsidian";

import { KNOWN_PLUGIN_BLOCKS, NATIVE_BLOCKS, type IsPluginBlock } from "../core/contentRisks";

/** Languages that are code to show, not something to run, for when the registry cannot be read. */
const CODE = new Set(["", "text", "txt", "plain", "plaintext", "markdown", "md", "js", "javascript", "ts", "typescript",
  "json", "jsonc", "yaml", "yml", "toml", "ini", "xml", "html", "css", "scss", "less", "python", "py", "bash", "sh",
  "shell", "zsh", "powershell", "ps1", "bat", "cmd", "c", "cpp", "c++", "h", "cs", "csharp", "java", "kotlin", "go",
  "rust", "rs", "ruby", "rb", "php", "perl", "lua", "r", "sql", "swift", "scala", "haskell", "elixir", "erlang",
  "clojure", "lisp", "dart", "diff", "dockerfile", "makefile", "graphql", "latex", "tex", "csv", "log", "regex",
  "vim", "nginx", "apache", "http", "tsx", "jsonl", "matlab", "julia", "fortran", "groovy", "objectivec", "ocaml"]);

/** The processors other plugins registered, by language; null when Obsidian does not show them. */
function registry(): Record<string, unknown> | null {
  const found = (MarkdownPreviewRenderer as unknown as { codeBlockPostProcessors?: unknown }).codeBlockPostProcessors;
  return found && typeof found === "object" ? (found as Record<string, unknown>) : null;
}

/** Whether a block of a language is another plugin's, asked at the moment it is needed (plugins load late). */
export const isPluginBlock: IsPluginBlock = (language) => {
  const lower = language.toLowerCase();
  if (NATIVE_BLOCKS.has(lower)) return false;
  const registered = registry();
  if (!registered) return !CODE.has(lower);
  return Object.prototype.hasOwnProperty.call(registered, language)
    || Object.prototype.hasOwnProperty.call(registered, lower) || KNOWN_PLUGIN_BLOCKS.has(lower);
};
