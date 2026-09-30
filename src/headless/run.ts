/**
 * One agent turn in Node, against a folder — the test port's viability check without Obsidian (#76).
 *
 *   npm run agent -- --vault <dir> [--base-url http://127.0.0.1:8080/v1] [--model <name>] [--thinking on|off]
 *                    [--max-iterations 50] [--prompt-file <agent.md>] [--allow-destructive] "<question>"
 *
 * Prints thinking, tool calls, results and the answer as they come.
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { runTurn } from "../core/agentLoop";
import { OpenAiChat } from "../core/llm/openaiChat";
import { nodeVault } from "../core/nodeVault";
import { promptContext, renderPrompt } from "../core/prompt";
import { makeTools } from "../core/tools";

const DEFAULT_PROMPT = `You are an assistant for the Obsidian vault at {{ vault_path }}. Today is {{ current_date }}.
Use the tools to look things up in the vault before answering, and answer briefly.`;

/** Options that take no value. */
const FLAGS = ["allow-destructive"];

function parseArgs(argv: string[]): { options: Map<string, string>; question: string } {
  const options = new Map<string, string>();
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (FLAGS.includes(argv[i].slice(2))) options.set(argv[i].slice(2), "on");
    else if (argv[i].startsWith("--")) options.set(argv[i].slice(2), argv[++i] ?? "");
    else rest.push(argv[i]);
  }
  return { options, question: rest.join(" ") };
}

/** The body of an agent definition file: the prompt after its frontmatter. */
function promptBody(text: string): string {
  const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(text);
  return match ? text.slice(match[0].length) : text;
}

async function main(): Promise<number> {
  const { options, question } = parseArgs(process.argv.slice(2));
  const vaultDir = options.get("vault");
  if (!vaultDir || !question) {
    console.error('usage: npm run agent -- --vault <dir> [--base-url <url>] [--model <name>] "<question>"');
    return 2;
  }
  const baseUrl = options.get("base-url") ?? "http://127.0.0.1:8080/v1";
  const model = options.get("model") ?? "local";
  const thinking = options.has("thinking") ? options.get("thinking") === "on" : undefined;
  const template = options.has("prompt-file")
    ? promptBody(await readFile(options.get("prompt-file")!, "utf-8"))
    : DEFAULT_PROMPT;
  const { text: systemPrompt, unsupported } = renderPrompt(
    template, promptContext(resolve(vaultDir), "headless", model));
  if (unsupported.length) console.error(`[prompt: left as written: ${unsupported.join(", ")}]`);

  let thinkingOpen = false;
  const endThinking = (): void => {
    if (thinkingOpen) process.stdout.write("\n[/thinking]\n");
    thinkingOpen = false;
  };
  const started = Date.now();
  const result = await runTurn({
    model: new OpenAiChat({ baseUrl, model, temperature: 0.6, topK: 20, minP: 0 }),
    tools: makeTools(nodeVault(resolve(vaultDir))),
    systemPrompt,
    history: [],
    prompt: question,
    maxIterations: Number(options.get("max-iterations") ?? 50),
    thinking,
    // No one to ask here: destructive tools refuse unless the run allows them up front
    confirm: options.has("allow-destructive") ? async (_id, name, input) => {
      process.stdout.write(`\n[allowed: ${name} ${JSON.stringify(input)}]\n`);
      return true;
    } : undefined,
    events: {
      onThinking: (text) => {
        if (!thinkingOpen) process.stdout.write("[thinking]\n");
        thinkingOpen = true;
        process.stdout.write(text);
      },
      onToken: (text) => {
        endThinking();
        process.stdout.write(text);
      },
      onToolCall: (_id, name, input) => {
        endThinking();
        process.stdout.write(`\n-> ${name} ${JSON.stringify(input)}\n`);
      },
      onToolResult: (_id, result, isError) => {
        const shown = result.length > 300 ? `${result.slice(0, 300)}…` : result;
        process.stdout.write(`<- ${isError ? "[error] " : ""}${shown.replace(/\n/g, "\n   ")}\n`);
      },
    },
  });
  endThinking();
  process.stdout.write(`\n\n=== reply (${result.toolCalls} tool calls, ${((Date.now() - started) / 1000).toFixed(1)} s`
                       + `${result.hitStepLimit ? ", step limit" : ""}) ===\n${result.reply}\n`);
  return 0;
}

main().then((code) => process.exit(code), (error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exit(1);
});
