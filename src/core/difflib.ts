/**
 * The parts of Python's difflib the tools use, ported so answers match the Python runtime's:
 * `SequenceMatcher(None, a, b).ratio()` and `get_close_matches()` for the "Did you mean …?" suggestions, and
 * `unified_diff()` for a turn's diff in the undo journal. Same algorithm (Ratcliff/Obershelp with the autojunk
 * rule), same ties.
 */

type Sequence = ArrayLike<string>;

/** `difflib.SequenceMatcher(None, a, b).ratio()`. */
export function ratio(a: string, b: string): number {
  const total = a.length + b.length;
  const matched = matchingBlocks(a, b).reduce((sum, [, , size]) => sum + size, 0);
  return total ? (2 * matched) / total : 1;
}

/** `difflib.get_close_matches(word, possibilities, n, cutoff)`: best first, ties by the larger string. */
export function getCloseMatches(word: string, possibilities: string[], n = 3, cutoff = 0.6): string[] {
  const scored: [number, string][] = [];
  for (const candidate of possibilities) {
    // Python sets seq1 = candidate, seq2 = word
    const score = ratio(candidate, word);
    if (score >= cutoff) scored.push([score, candidate]);
  }
  scored.sort((x, y) => (y[0] - x[0]) || (y[1] > x[1] ? 1 : y[1] < x[1] ? -1 : 0));
  return scored.slice(0, n).map(([, candidate]) => candidate);
}

/** `get_matching_blocks()`: (i, j, size) triples in order, adjacent ones merged, without the final sentinel. */
export function matchingBlocks(a: Sequence, b: Sequence): [number, number, number][] {
  const b2j = new Map<string, number[]>();
  for (let j = 0; j < b.length; j++) {
    const at = b2j.get(b[j]);
    if (at) at.push(j);
    else b2j.set(b[j], [j]);
  }
  // autojunk: in a sequence of 200 or more, an element making up more than 1% of it is "popular" and not indexed
  if (b.length >= 200) {
    const ntest = Math.floor(b.length / 100) + 1;
    for (const [element, at] of b2j) if (at.length > ntest) b2j.delete(element);
  }

  const longest = (alo: number, ahi: number, blo: number, bhi: number): [number, number, number] => {
    let besti = alo;
    let bestj = blo;
    let bestsize = 0;
    let j2len = new Map<number, number>();
    for (let i = alo; i < ahi; i++) {
      const next = new Map<number, number>();
      for (const j of b2j.get(a[i]) ?? []) {
        if (j < blo) continue;
        if (j >= bhi) break;
        const k = (j2len.get(j - 1) ?? 0) + 1;
        next.set(j, k);
        if (k > bestsize) {
          besti = i - k + 1;
          bestj = j - k + 1;
          bestsize = k;
        }
      }
      j2len = next;
    }
    // Extend over equal elements that were not indexed (the popular ones), as Python does
    while (besti > alo && bestj > blo && a[besti - 1] === b[bestj - 1]) {
      besti--;
      bestj--;
      bestsize++;
    }
    while (besti + bestsize < ahi && bestj + bestsize < bhi && a[besti + bestsize] === b[bestj + bestsize]) {
      bestsize++;
    }
    return [besti, bestj, bestsize];
  };

  const blocks: [number, number, number][] = [];
  const queue: [number, number, number, number][] = [[0, a.length, 0, b.length]];
  while (queue.length) {
    const [alo, ahi, blo, bhi] = queue.pop()!;
    const [i, j, k] = longest(alo, ahi, blo, bhi);
    if (!k) continue;
    blocks.push([i, j, k]);
    if (alo < i && blo < j) queue.push([alo, i, blo, j]);
    if (i + k < ahi && j + k < bhi) queue.push([i + k, ahi, j + k, bhi]);
  }
  blocks.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  const merged: [number, number, number][] = [];
  for (const block of blocks) {
    const last = merged[merged.length - 1];
    if (last && last[0] + last[2] === block[0] && last[1] + last[2] === block[1]) last[2] += block[2];
    else merged.push([...block]);
  }
  return merged;
}

type Opcode = ["equal" | "replace" | "delete" | "insert", number, number, number, number];

/** `get_opcodes()`. */
export function opcodes(a: Sequence, b: Sequence): Opcode[] {
  let i = 0;
  let j = 0;
  const codes: Opcode[] = [];
  for (const [ai, bj, size] of [...matchingBlocks(a, b), [a.length, b.length, 0] as [number, number, number]]) {
    const tag = i < ai && j < bj ? "replace" : i < ai ? "delete" : j < bj ? "insert" : null;
    if (tag) codes.push([tag, i, ai, j, bj]);
    i = ai + size;
    j = bj + size;
    if (size) codes.push(["equal", ai, i, bj, j]);
  }
  return codes;
}

/** `get_grouped_opcodes(n)`: the changes, each with up to *n* lines of context. */
function groupedOpcodes(a: Sequence, b: Sequence, n = 3): Opcode[][] {
  let codes = opcodes(a, b);
  if (!codes.length) codes = [["equal", 0, 1, 0, 1]];
  if (codes[0][0] === "equal") {
    const [, i1, i2, j1, j2] = codes[0];
    codes[0] = ["equal", Math.max(i1, i2 - n), i2, Math.max(j1, j2 - n), j2];
  }
  const last = codes.length - 1;
  if (codes[last][0] === "equal") {
    const [, i1, i2, j1, j2] = codes[last];
    codes[last] = ["equal", i1, Math.min(i2, i1 + n), j1, Math.min(j2, j1 + n)];
  }
  const nn = n + n;
  const groups: Opcode[][] = [];
  let group: Opcode[] = [];
  for (const [tag, i1, i2, j1, j2] of codes) {
    let [ci1, cj1] = [i1, j1];
    if (tag === "equal" && i2 - i1 > nn) {
      group.push(["equal", i1, Math.min(i2, i1 + n), j1, Math.min(j2, j1 + n)]);
      groups.push(group);
      group = [];
      [ci1, cj1] = [Math.max(i1, i2 - n), Math.max(j1, j2 - n)];
    }
    group.push([tag, ci1, i2, cj1, j2]);
  }
  if (group.length && !(group.length === 1 && group[0][0] === "equal")) groups.push(group);
  return groups;
}

function range(start: number, stop: number): string {
  let beginning = start + 1;
  const length = stop - start;
  if (length === 1) return `${beginning}`;
  if (!length) beginning -= 1;
  return `${beginning},${length}`;
}

/** `difflib.unified_diff(a, b, fromfile, tofile)` over lines that keep their line endings. */
export function unifiedDiff(a: string[], b: string[], fromfile: string, tofile: string, n = 3): string {
  const out: string[] = [];
  for (const group of groupedOpcodes(a, b, n)) {
    if (!out.length) out.push(`--- ${fromfile}\n`, `+++ ${tofile}\n`);
    const first = group[0];
    const final = group[group.length - 1];
    out.push(`@@ -${range(first[1], final[2])} +${range(first[3], final[4])} @@\n`);
    for (const [tag, i1, i2, j1, j2] of group) {
      if (tag === "equal") {
        for (const line of Array.from(a).slice(i1, i2)) out.push(` ${line}`);
        continue;
      }
      if (tag === "replace" || tag === "delete") for (const line of a.slice(i1, i2)) out.push(`-${line}`);
      if (tag === "replace" || tag === "insert") for (const line of b.slice(j1, j2)) out.push(`+${line}`);
    }
  }
  return out.join("");
}

/** Python's `str.splitlines(keepends=True)` for \n and \r\n text. */
export function linesKeepEnds(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}
