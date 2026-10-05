/** Which pages of a PDF read_attachment shows (#166); in the core, so it is tested without Obsidian. */

/**
 * The page numbers *wanted* names — "3", "2-4", "1,3,5-6"; every page when empty — or the error to return (#166).
 */
export function pageNumbers(wanted: string, pages: number): number[] | string {
  if (!wanted.trim()) return Array.from({ length: pages }, (_, index) => index + 1);
  const chosen = new Set<number>();
  for (const part of wanted.split(",").map((piece) => piece.trim()).filter(Boolean)) {
    const match = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(part);
    if (!match) return `Error: pages must be numbers or ranges such as '2' or '1-3', not '${part}'`;
    const first = Number(match[1]);
    const last = match[2] ? Number(match[2]) : first;
    if (first < 1 || last > pages || first > last) return `Error: the PDF has pages 1-${pages}; '${part}' is not among them`;
    for (let number = first; number <= last; number++) chosen.add(number);
  }
  return [...chosen].sort((a, b) => a - b);
}
