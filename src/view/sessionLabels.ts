/**
 * How a conversation is called in the chat (#286): its title when the user gave it one, otherwise its name made
 * readable. The name — the note's file name — stays the conversation's identifier and never changes.
 */

const STAMP = /^(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})(?:-|$)/;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** When a generated name says it was started, as "5 Oct 11:43"; "" for a name without one. */
export function startedAt(name: string): string {
  const stamp = STAMP.exec(name);
  if (!stamp) return "";
  const [, , month, day, hours, minutes] = stamp;
  return `${Number(day)} ${MONTHS[Number(month) - 1] ?? month} ${hours}:${minutes}`;
}

/**
 * A generated name as words: "2026-10-05-1143-go-through-every-tool" → "go through every tool"; a name of only a
 * date and time reads as that ("5 Oct 11:43"); any other name as it is.
 */
export function readableName(name: string): string {
  const stamp = STAMP.exec(name);
  if (!stamp) return name;
  const rest = name.slice(stamp[0].length).replace(/-+/g, " ").trim();
  return rest || startedAt(name);
}

/**
 * The picker's label for each conversation: its title or its readable name. Two that would read the same also show
 * when they were started, so they can be told apart; nothing else is added (#286).
 */
export function sessionLabels(sessions: { name: string; title?: string; exchanges: number }[]): Map<string, string> {
  const base = new Map(sessions.map((session) => [session.name, session.title?.trim() || readableName(session.name)]));
  const counts = new Map<string, number>();
  for (const label of base.values()) counts.set(label.toLowerCase(), (counts.get(label.toLowerCase()) ?? 0) + 1);
  const labels = new Map<string, string>();
  for (const session of sessions) {
    let label = base.get(session.name)!;
    const started = startedAt(session.name);
    if (counts.get(label.toLowerCase())! > 1 && started && label !== started) label = `${label} · ${started}`;
    labels.set(session.name, label);
  }
  return labels;
}

/**
 * The conversations the picker lists, newest first: the vault's notes, and the one open in this chat even before its
 * note is written — its first answer still running (2026-10-06). Listing only the notes, a refresh in that moment left
 * the picker blank on the conversation you were in.
 */
export function listedSessions<T extends { name: string }>(notes: T[], open: string, made: (name: string) => T): T[] {
  if (!open || notes.some((session) => session.name === open)) return notes;
  return [made(open), ...notes];
}
