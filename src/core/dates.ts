/**
 * Weekdays for the model (#261). Models get weekdays wrong and nothing told them one: Qwen3.6 called Friday
 * 2026-10-02 "Thursday" and moved the wrong meeting, and "by Friday" in a Wednesday's daily note lost its date.
 */

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** The English weekday of *date*, as the local clock sees it. */
export function weekday(date: Date): string {
  return WEEKDAYS[date.getDay()];
}

/** The date a note is named by (`2026-09-09`, `2026-09-09 Borealis Sync`), or null when its name has none. */
export function dateInName(path: string): string | null {
  const name = path.split("/").pop() ?? path;
  const found = /(?<!\d)(\d{4})-(\d{2})-(\d{2})(?!\d)/.exec(name);
  if (!found) return null;
  const [, year, month, day] = found.map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  // 2026-02-30 is not a date: Date would roll it over into March
  return date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? found[0] : null;
}

/** "2026-09-09 is a Wednesday" for a note named by a date, or "" when its name has none. */
export function namedDay(path: string): string {
  const date = dateInName(path);
  if (!date) return "";
  const [year, month, day] = date.split("-").map(Number);
  return `${date} is a ${WEEKDAYS[new Date(Date.UTC(year, month - 1, day)).getUTCDay()]}`;
}
