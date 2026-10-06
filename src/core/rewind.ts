/**
 * Going back to an earlier message (#303): the conversation without its last exchanges, and what the answers of
 * those exchanges changed in the vault taken back, newest first, as the chat's undo does one answer at a time.
 */

import type { Journal } from "./journal";
import type { VaultPort } from "./vault";

/**
 * *messages* without their last *exchanges* questions and everything said after the first of them. A summary
 * (a system message) before them stays. Asking for more exchanges than there are leaves only the summary.
 */
export function withoutLast<T extends { role: string }>(messages: T[], exchanges: number): T[] {
  if (exchanges <= 0) return [...messages];
  let seen = 0;
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index].role !== "user") continue;
    seen += 1;
    if (seen === exchanges) return messages.slice(0, index);
  }
  return messages.filter((message) => message.role === "system");
}

export interface RewindResult {
  /** Files put back as they were before the answers. */
  restored: string[];
  /** Files left alone, and why: edited since, or an answer no longer kept for undo. */
  refused: { path: string; reason: string }[];
}

/**
 * Take back what the answers *turns* changed, newest first, each as the chat's undo would. An answer undone
 * already is skipped; one the journal no longer holds is named.
 */
export async function undoTurns(journal: Journal | null, vault: VaultPort, turns: string[]): Promise<RewindResult> {
  const result: RewindResult = { restored: [], refused: [] };
  for (const id of turns) {
    const turn = journal?.find(id);
    if (!turn) {
      result.refused.push({ path: "", reason: "an answer's changes are no longer kept for undo" });
      continue;
    }
    if (turn.undone) continue;
    const undone = await journal!.undo(turn, vault);
    result.restored.push(...undone.restored);
    result.refused.push(...undone.refused);
  }
  return result;
}
