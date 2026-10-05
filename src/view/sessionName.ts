/**
 * What a conversation is called once it is worth keeping.
 *
 * A session is a vault note, so its name is something the user will read in a file list months later — not a
 * uuid. It is taken from the first thing they asked, with the date and time in front: sortable, recognisable,
 * and unique enough that asking the same question twice in a day does not silently append to the older note.
 *
 * The name is built in the form the runtime stores — lowercase, hyphens for spaces — because the session picker
 * matches on it. Handing the runtime `2026-09-23 1432 move ideas` and then looking for it in a list that calls
 * it `2026-09-23-1432-move-ideas` matches nothing, and the picker sits blank on the conversation you are in.
 */

import { fold } from "../core/paths";

const MAX_WORDS = 6;
const MAX_SLUG = 48;

export function sessionNameFor(prompt: string, now: Date = new Date()): string {
  const stamp = `${localDate(now)}-${pad(now.getHours())}${pad(now.getMinutes())}`;
  const slug = slugify(prompt);
  return slug ? `${stamp}-${slug}` : stamp;
}

/** The local date, not `toISOString()`, which is UTC and names yesterday's session for anyone east of London. */
function localDate(now: Date): string {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/**
 * The first few words, as a file name can hold them. Letters are folded to their base form first, so "Grüße" is
 * "grusse", not "gr-e" (#164); anything else — punctuation, CJK, emoji — is dropped.
 */
function slugify(prompt: string): string {
  const words = fold(prompt)
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .slice(0, MAX_WORDS);
  return words.join("-").slice(0, MAX_SLUG).replace(/-+$/, "");
}
