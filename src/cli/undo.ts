/**
 * `obsidian agent:undo` (#302): take back what an answer changed, from the terminal — the chat's undo button for
 * answers run with `agent:ask`, and for any other the journal still holds. It reads the same journal as the chat,
 * so neither can undo over the other, and like the chat it skips a file edited since the agent wrote it.
 *
 * The journal lives in memory (the last 20 answers): a plugin reload forgets what can be undone.
 */

import type { TurnSummary, UndoResult } from "../api/types";

/** What `agent:undo` needs from the plugin: InProcessAgent's journal. */
export interface UndoHost {
  turns(): Promise<{ journalling: boolean; turns: TurnSummary[] }>;
  turnDiff(id: string): Promise<{ files: string[]; diff: string; undone: boolean; stale: string[] }>;
  undoTurn(id: string): Promise<UndoResult>;
}

export interface UndoParams {
  /** The answer's id, as `agent:ask` prints it; the newest answer not undone yet when not given. */
  turn?: string;
  /** "true": list the answers that can be undone. */
  list?: string;
  /** "true": show what would be undone, and change nothing. */
  dry?: string;
  format?: string;
}

/** The answers that can be undone, newest first, one per line. */
export function listText(turns: TurnSummary[]): string {
  if (!turns.length) return "Nothing to undo: no answer changed anything since Obsidian started the plugin.";
  return turns.map((turn) => {
    const prompt = turn.prompt.replace(/\s+/g, " ").trim();
    const short = prompt.length > 60 ? `${prompt.slice(0, 59)}…` : prompt;
    return `${turn.id}  ${turn.started}  ${turn.undone ? "(undone) " : ""}"${short}"  ${turn.files.join(", ")}`;
  }).join("\n");
}

/** Runs the command; never throws — a problem is a line starting with `Error:`, or `ok: false` in JSON. */
export async function undo(host: UndoHost, params: UndoParams): Promise<string> {
  const json = params.format === "json";
  const failed = (error: string): string => (json ? JSON.stringify({ ok: false, error }, null, 2) : `Error: ${error}`);
  const { journalling, turns } = await host.turns();
  if (!journalling) return failed("undo is off — Settings → Hiro Agent → Features → Undo");
  if (params.list === "true") return json ? JSON.stringify({ ok: true, turns }, null, 2) : listText(turns);

  const id = params.turn?.trim();
  const turn = id ? turns.find((t) => t.id === id) : turns.find((t) => !t.undone);
  if (!turn) {
    return failed(id ? `no answer '${id}' is kept for undo; agent:undo list shows the ones that are`
      : "nothing to undo: no answer changed anything since Obsidian started the plugin");
  }
  if (turn.undone) return failed(`what answer '${turn.id}' changed is already undone`);

  if (params.dry === "true") {
    const diff = await host.turnDiff(turn.id);
    if (json) return JSON.stringify({ ok: true, turn: turn.id, prompt: turn.prompt, ...diff }, null, 2);
    const skipped = diff.stale.length ? `\n\n[would be skipped, edited since: ${diff.stale.join(", ")}]` : "";
    return `Undo would take back "${turn.prompt}" (${turn.id}):\n\n${diff.diff}${skipped}`;
  }

  const result = await host.undoTurn(turn.id);
  if (json) return JSON.stringify({ turn: turn.id, prompt: turn.prompt, ...result }, null, 2);
  const lines = [`Undid "${turn.prompt}" (${turn.id}).`];
  if (result.restored.length) lines.push(`[restored: ${result.restored.join(", ")}]`);
  for (const refused of result.refused) lines.push(`[not restored: ${refused.path ? `${refused.path} — ` : ""}${refused.reason}]`);
  if (!result.restored.length) lines[0] = `Error: nothing of "${turn.prompt}" (${turn.id}) was undone.`;
  return lines.join("\n");
}
