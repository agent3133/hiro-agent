/**
 * The command "Undo an earlier answer" (#410): the answers the undo journal still holds, newest first, to pick one and
 * take back what it changed in the usual undo dialog. The journal outlives a restart, but an answer's footer and its
 * Undo button do not; this is the way back to them, as `agent:undo` is from the terminal.
 */

import { App, FuzzySuggestModal, Notice } from "obsidian";

import type { TurnSummary } from "../api/types";
import type { InProcessAgent } from "../inprocess/InProcessAgent";
import { UndoModal } from "./UndoModal";

type Client = Pick<InProcessAgent, "turns" | "turnDiff" | "undoTurn">;

/** How the picker names an answer: when, what was asked, and how many files it changed. */
export function turnLabel(turn: TurnSummary): string {
  const when = new Date(turn.started);
  const day = Number.isNaN(when.getTime()) ? "" : `${when.toLocaleDateString()} ${when.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} · `;
  const prompt = turn.prompt.replace(/\s+/g, " ").trim();
  const short = prompt.length > 70 ? `${prompt.slice(0, 69)}…` : prompt || "(no message)";
  return `${day}${short} · ${turn.files.length === 1 ? "1 file" : `${turn.files.length} files`}`;
}

export class UndoPicker extends FuzzySuggestModal<TurnSummary> {
  constructor(app: App, private readonly client: Client, private readonly answers: TurnSummary[]) {
    super(app);
    this.setPlaceholder("Pick the answer whose changes to take back");
  }

  getItems(): TurnSummary[] {
    return this.answers;
  }

  getItemText(turn: TurnSummary): string {
    return turnLabel(turn);
  }

  onChooseItem(turn: TurnSummary): void {
    new UndoModal(this.app, this.client, { turn: turn.id, files: turn.files }, () => undefined).open();
  }
}

/** Opens the picker with the answers not undone yet, or says why there is nothing to pick. */
export async function openUndoPicker(app: App, client: Client): Promise<UndoPicker | null> {
  const { journalling, turns } = await client.turns();
  if (!journalling) {
    new Notice("Undo agent changes is off (Settings → Hiro Agent → Features).");
    return null;
  }
  const open = turns.filter((turn) => !turn.undone);
  if (!open.length) {
    new Notice("No answer's changes are left to undo.");
    return null;
  }
  const picker = new UndoPicker(app, client, open);
  picker.open();
  return picker;
}
