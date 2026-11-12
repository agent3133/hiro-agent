/**
 * Whether an edit takes most of a note away (#404). edit_note and the like never asked, and models have emptied
 * notes with them after update_note was declined (#262 in agentLoop.ts); undo is the only net, and it is lost on a
 * restart. So an edit that leaves the note much shorter is asked about like update_note.
 *
 * Measured by how much shorter the note gets: a replacement removes what it shortens the note by, and a rewrite of
 * the same length removes nothing worth asking about. Small notes are left alone: a three-line note rewritten is
 * what an edit is for.
 */

/** Asked about from this share of the note's characters on. */
export const MOST_OF_A_NOTE = 0.5;
/** Notes shorter than this are not asked about, whatever share an edit removes. */
export const SMALL_NOTE = 200;

/** The share of *before* an edit to *after* removes, when it is enough to ask about; null otherwise. */
export function removesMost(before: string, after: string): number | null {
  const length = before.replace(/\r\n/g, "\n").length;
  if (length < SMALL_NOTE) return null;
  const share = (length - after.replace(/\r\n/g, "\n").length) / length;
  return share >= MOST_OF_A_NOTE ? share : null;
}

/** The sentence the confirmation shows: "it would remove 80 % of the note". */
export function removalSentence(share: number): string {
  return `it would remove ${Math.round(share * 100)} % of the note`;
}
