/**
 * An answer's tool calls as the chat shows them (split out of ChatView, #419): one folded row per call — its name, its
 * arguments on one line and in full when unfolded — and the result once it comes, opened by itself on an error.
 */

import type { ToolCall } from "../api/types";
import { displayName } from "../mcp/servers";
import { callArguments, callLine } from "./toolCallText";

/** How much of a result a row shows; the model got all of it. */
const RESULT_SHOWN = 2000;

/** A row for *call* in *container*, waiting ("…") for its result. */
export function addToolRow(container: HTMLElement, call: ToolCall): HTMLElement {
  const row = container.createEl("details", { cls: "obsidian-agent-tool" });
  const summary = row.createEl("summary");
  summary.createSpan({ cls: "obsidian-agent-tool-name", text: displayName(call.name) });
  // Every argument on the line, the main one first; the full set when the row is unfolded (2026-10-05)
  const line = callLine(call.input);
  const argument = summary.createSpan({ cls: "obsidian-agent-tool-arg", text: line });
  if (line) argument.setAttr("title", line);
  summary.createSpan({ cls: "obsidian-agent-tool-state", text: "…" });
  const all = callArguments(call.input);
  if (all) row.createEl("pre", { cls: "obsidian-agent-tool-args", text: all });
  row.createEl("pre", { cls: "obsidian-agent-tool-result" });
  return row;
}

/** The result into *row*: "done" or "failed", the text cut to what a row shows, an error unfolded. */
export function completeToolRow(row: HTMLElement | undefined, result: string, isError: boolean): void {
  if (!row) return;
  const state = row.querySelector(".obsidian-agent-tool-state");
  if (state) state.textContent = isError ? "failed" : "done";
  row.toggleClass("mod-error", isError);
  const pre = row.querySelector(".obsidian-agent-tool-result");
  if (pre) pre.textContent = result.length > RESULT_SHOWN ? `${result.slice(0, RESULT_SHOWN)}…` : result;
  if (isError) row.setAttr("open", "true");
}
