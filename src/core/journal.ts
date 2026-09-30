/**
 * What the agent changed, per turn, so it can be shown and taken back — ported from src/obsidian_agent/agent/journal.py
 * (#85). Every write, move and delete the agent makes is reported here with what the file held before and what the
 * agent left; a diff renders a turn, and undo restores exactly those files — refusing any file that changed since,
 * because the agent's "before" is no longer what the user would get back.
 *
 * It holds the last few turns of one run; it is not version control, and what it does not see (edits made in
 * Obsidian itself) it does not pretend to cover.
 */

import { linesKeepEnds, unifiedDiff } from "./difflib";
import type { VaultPort } from "./vault";

export type Op = "create" | "modify" | "delete" | "move";

export interface Change {
  op: Op;
  path: string;
  /** null when the file did not exist */
  before: string | null;
  /** null when the agent deleted it */
  after: string | null;
  /** move only: where it went */
  movedTo?: string;
}

export interface Turn {
  id: string;
  prompt: string;
  started: Date;
  changes: Change[];
  undone: boolean;
}

export interface UndoResult {
  restored: string[];
  refused: { path: string; reason: string }[];
}

const size = (change: Change): number => (change.before?.length ?? 0) + (change.after?.length ?? 0);

export class Journal {
  private turnsKept: Turn[] = [];
  private open: Turn | null = null;
  /** set while undo writes, so an undo is not itself journalled */
  private replaying = false;

  constructor(private readonly maxTurns = 20, private readonly maxBytes = 20_000_000) {}

  /** Open a turn; one still open is closed first — a turn ends when the next one starts. */
  begin(prompt = ""): string {
    this.finish();
    const id = Math.random().toString(16).slice(2, 14).padEnd(12, "0");
    this.open = { id, prompt, started: new Date(), changes: [], undone: false };
    return id;
  }

  /** Close the open turn, and keep it if it changed anything. */
  finish(): Turn | null {
    const turn = this.open;
    this.open = null;
    if (!turn || !turn.changes.length) return null;
    this.turnsKept.push(turn);
    while (this.turnsKept.length > this.maxTurns
           || (this.turnsKept.length > 1 && this.totalSize() > this.maxBytes)) this.turnsKept.shift();
    return turn;
  }

  /** Called for every write, move and delete while a turn is open. */
  record(change: Change): void {
    if (!this.open || this.replaying) return;
    this.open.changes.push(change);
  }

  totalSize(): number {
    return this.turnsKept.reduce((sum, turn) => sum + turn.changes.reduce((s, c) => s + size(c), 0), 0);
  }

  turns(): Turn[] {
    return [...this.turnsKept];
  }

  /** The most recent turn that changed something and has not been undone. */
  last(): Turn | null {
    return [...this.turnsKept].reverse().find((turn) => !turn.undone) ?? null;
  }

  find(id: string): Turn | null {
    return this.turnsKept.find((turn) => turn.id === id) ?? null;
  }

  /** The files a turn left, where it left them. */
  paths(turn: Turn): string[] {
    return turn.changes.map((change) => change.movedTo ?? change.path);
  }

  /** The turn as a unified diff, one section per file. */
  diff(turn: Turn): string {
    const sections = turn.changes.map((change) => {
      if (change.op === "move") return `--- ${change.path}\n+++ ${change.movedTo}\n(moved)\n`;
      const from = change.op === "create" ? "/dev/null" : `a/${change.path}`;
      const to = change.op === "delete" ? "/dev/null" : `b/${change.path}`;
      const body = unifiedDiff(linesKeepEnds(change.before ?? ""), linesKeepEnds(change.after ?? ""), from, to);
      return body || `--- ${from}\n+++ ${to}\n(no textual change)\n`;
    });
    return sections.join("\n");
  }

  /** One line per change. */
  summary(turn: Turn): string[] {
    const words: Record<Op, string> = { create: "created", modify: "edited", delete: "deleted", move: "moved" };
    return turn.changes.map((c) => (c.op === "move" ? `moved ${c.path} -> ${c.movedTo}` : `${words[c.op]} ${c.path}`));
  }

  /** Put back what the turn changed, newest change first, skipping files touched since. */
  async undo(turn: Turn, vault: VaultPort): Promise<UndoResult> {
    const result: UndoResult = { restored: [], refused: [] };
    // Undone already: every file would report "changed after the agent wrote it", true but useless
    if (turn.undone) return result;
    this.replaying = true;
    try {
      for (const change of [...turn.changes].reverse()) {
        const target = change.movedTo ?? change.path;
        const current = (await vault.isFile(target)) ? await vault.read(target) : null;
        if (current !== change.after) {
          result.refused.push({ path: target, reason: "changed after the agent wrote it" });
          continue;
        }
        try {
          if (change.op === "move") await vault.move(change.movedTo!, change.path);
          else if (change.op === "create") await vault.remove(change.path);
          else await vault.write(change.path, change.before ?? "");  // modify and delete: the earlier text back
        } catch (error) {
          result.refused.push({ path: target, reason: error instanceof Error ? error.message : String(error) });
          continue;
        }
        result.restored.push(change.path);
      }
    } finally {
      this.replaying = false;
    }
    turn.undone = !result.refused.length;
    return result;
  }
}

/** *vault*, with every write, move and delete reported to *journal* — how the core's tools are journalled. */
export function journalled(vault: VaultPort, journal: Journal): VaultPort {
  const current = async (path: string): Promise<string | null> => ((await vault.isFile(path)) ? vault.read(path) : null);
  return {
    ...vault,
    write: async (path, text) => {
      const before = await current(path);
      await vault.write(path, text);
      journal.record({ op: before === null ? "create" : "modify", path, before, after: text });
    },
    remove: async (path) => {
      const before = await current(path);
      await vault.remove(path);
      journal.record({ op: "delete", path, before, after: null });
    },
    move: async (from, to) => {
      await vault.move(from, to);
      journal.record({ op: "move", path: from, before: null, after: await current(to), movedTo: to });
    },
  };
}
