/**
 * A Base's definition, made ready for query_base (#230): the YAML of a `.base` file or of a ```base block in a note,
 * with the one view to run set to the plugin's own view type, which is how the plugin gets the query's result.
 * No Obsidian here, so it is tested as it is.
 */

import { parse, stringify } from "yaml";

/** The Bases view type the plugin registers to receive a query's result (vault/basesQuery.ts). */
export const QUERY_VIEW_TYPE = "agent-query";

export interface PreparedBase {
  /** The definition to run: everything as given, and only the chosen view, with the plugin's view type. */
  yaml: string;
  /** The chosen view's name, as the answer names it. */
  view: string;
}

/** A ```base code block's content, when *text* is a whole fence rather than the YAML alone. */
function unfenced(text: string): string {
  const fence = /^\s*(`{3,}|~{3,})\s*base\s*\n([\s\S]*?)\n\s*\1\s*$/.exec(text);
  return fence ? fence[2] : text;
}

/**
 * The Bases embedded in a note: the content of each ```base block, in order (2026-10-05). A model that names the
 * note asks for its board — "the board in my Office Move project note" — and query_base runs it from there.
 */
export function embeddedBases(note: string): string[] {
  const lf = note.replace(/\r\n/g, "\n");
  return [...lf.matchAll(/^[ \t]*(`{3,}|~{3,})[ \t]*base[ \t]*\n([\s\S]*?)\n[ \t]*\1[ \t]*$/gm)].map((match) => match[2]);
}

/**
 * *value* with `this.file` meaning *note*: in a Base embedded in a note, `this` is that note, but the temporary
 * `.base` the query runs from is another file — so the note is named in its place (`file("path")`).
 */
function thisMeans(value: unknown, note: string): unknown {
  if (typeof value === "string") return value.replace(/\bthis\.file\b/g, `file(${JSON.stringify(note)})`);
  if (Array.isArray(value)) return value.map((item) => thisMeans(item, note));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, thisMeans(item, note)]));
  }
  return value;
}

/**
 * How a Base's filters are written, for the answers to a definition that failed or matched nothing: small models
 * hardly know the syntax, and teaching it there costs nothing in the requests that never touch a Base (#246).
 */
export const BASE_SYNTAX = [
  "A definition's filters, for example:",
  "filters:",
  "  and:",
  "    - file.hasTag(\"recipe\")          # a tag",
  "    - file.inFolder(\"Notes\")         # a folder",
  "    - 'status == \"open\"'             # a property",
  "    - file.hasLink(this.file)        # links to the note passed as note",
  "    - 'date(due) < today()'          # dates",
  "Use or: and not: for other combinations; quote an expression that contains : or \".",
].join("\n");

/**
 * *definition* ready to run with the view named *viewName* (the first when empty), or the error to answer. *note*,
 * for a definition taken from a ```base block, is the note it sits in, which `this.file` refers to (#230).
 */
export function prepareBase(definition: string, viewName = "", note = ""): PreparedBase | string {
  const yaml = unfenced(definition);
  // Line breaks sent as the two characters \n: the whole definition is one line YAML cannot read as meant (#270).
  // The answer shows it with real line breaks, so the next call only has to send it that way
  if (!yaml.includes("\n") && yaml.includes("\\n")) {
    const meant = yaml.replace(/\\n/g, "\n").replace(/\\"/g, "\"");
    return "Error: the definition came as one line, with the characters \\n where its line breaks should be. Send it "
      + `with real line breaks, like this:\n\n${meant}`;
  }
  let data: unknown;
  try {
    data = parse(yaml);
  } catch (error) {
    return `Error: the Base's definition is not valid YAML (${error instanceof Error ? error.message.split("\n")[0] : String(error)}).`
      + `\n\n${BASE_SYNTAX}`;
  }
  // A filter expression on its own: the model knows the filter but not where it goes (#270)
  if (typeof data === "string" && /[()=<>&|!]/.test(data)) {
    return "Error: a Base's definition is YAML with keys such as filters, formulas and views, and this is a filter "
      + `expression on its own. Put it under filters:, like this:\n\nfilters: '${data.trim().replace(/'/g, "''")}'`
      + `\n\n${BASE_SYNTAX}`;
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return `Error: a Base's definition is YAML with keys such as filters, formulas and views.\n\n${BASE_SYNTAX}`;
  }
  const base = (note ? thisMeans(data, note) : data) as Record<string, unknown>;
  const views = (Array.isArray(base.views) ? base.views : []).filter((v): v is Record<string, unknown> =>
    Boolean(v) && typeof v === "object" && !Array.isArray(v));
  let chosen: Record<string, unknown>;
  if (!views.length) {
    // A definition without views runs as one view: any name asked for is that one ("Query", "default", #270)
    chosen = { name: viewName.trim() || "Query" };
  } else if (viewName.trim()) {
    const wanted = viewName.trim().toLowerCase();
    // A view type for its name ("table"): the one view of that type, when there is exactly one (2026-10-05)
    const ofType = views.filter((v) => String(v.type ?? "").toLowerCase() === wanted);
    const found = views.find((v) => String(v.name ?? "").toLowerCase() === wanted) ?? (ofType.length === 1 ? ofType[0] : undefined);
    if (!found) {
      const names = views.map((v) => `'${String(v.name ?? "")}'`).join(", ");
      return `Error: the Base has no view '${viewName.trim()}'${names ? `; its views: ${names}` : ""}`;
    }
    chosen = found;
  } else {
    // No view at all: every note the filters let through, in the Base's own order
    chosen = views[0] ?? { name: "Query" };
  }
  const view = String(chosen.name ?? "Query");
  return { yaml: stringify({ ...base, views: [{ ...chosen, type: QUERY_VIEW_TYPE, name: view }] }), view };
}

/** A property as a filter or count_by names it, for comparing names: `note.status` and `status` are one. */
export function propertyKey(name: string): string {
  return name.trim().toLowerCase().replace(/^(note|file\.frontmatter|frontmatter|file\.properties)\./, "");
}

/**
 * *prepared* (prepareBase's YAML) with *property* among its view's columns, so that the query's result carries it
 * for count_by (#267); unchanged when the view shows it already.
 */
export function withColumn(prepared: string, property: string): string {
  const data = parse(prepared) as Record<string, unknown>;
  const view = (data.views as Record<string, unknown>[])[0];
  const order = Array.isArray(view.order) ? view.order.map(String) : [];
  if (order.some((p) => propertyKey(p) === propertyKey(property))) return prepared;
  // A view without order shows the Base's first properties; keep them, and add the one counted
  view.order = [...(order.length ? order : ["file.name"]), property.trim()];
  return stringify(data);
}

/**
 * The rows counted per value of one column (#267, #389): models that count 85 rows by hand get it wrong, differently
 * each time. *cells* holds each row's values, one per column, a list property's items each on their own. The rows'
 * count per value, the most first; or an error naming the columns when *by* is none of them.
 */
export function countTable(columns: string[], ids: string[], cells: string[][][], by: string): string {
  const wanted = propertyKey(by);
  const index = ids.findIndex((id, i) => propertyKey(id) === wanted || propertyKey(columns[i] ?? "") === wanted);
  if (index < 0) {
    return `Error: the result has no column '${by}' to count by; its columns: ${columns.map((c) => `'${c}'`).join(", ")}`;
  }
  const counts = new Map<string, number>();
  let several = false;
  for (const row of cells) {
    const items = [...new Set(row[index] ?? [])];
    if (items.length > 1) several = true;
    for (const item of items.length ? items : ["(empty)"]) counts.set(item, (counts.get(item) ?? 0) + 1);
  }
  // The most first; rows without a value last, as what is left over
  const empty = counts.get("(empty)");
  counts.delete("(empty)");
  const sorted = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  if (empty) sorted.push(["(empty)", empty]);
  return rowsTable([columns[index], "rows"], sorted.map(([value, n]) => [value, String(n)]), sorted.length)
    + (several ? "\n\nA row with several values is counted once under each of them." : "");
}

/** The filter expressions of a definition: every string under a filters key, in and/or/not lists too. */
export function filterExpressions(definition: string): string[] {
  let data: unknown;
  try {
    data = parse(unfenced(definition));
  } catch {
    return [];
  }
  const found: string[] = [];
  const strings = (value: unknown): void => {
    if (typeof value === "string") found.push(value);
    else if (Array.isArray(value)) value.forEach(strings);
    else if (value && typeof value === "object") Object.values(value).forEach(strings);
  };
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === "object") {
      for (const [key, item] of Object.entries(value)) (key === "filters" ? strings : walk)(item);
    }
  };
  walk(data);
  return found;
}

/**
 * The quoted strings in *expression* that stand as a condition of their own — `file.hasTag("task") && "open"` —
 * which every note passes (#389): not an argument of a call, and not one side of a comparison.
 */
export function bareStrings(expression: string): string[] {
  const found: string[] = [];
  for (const match of expression.matchAll(/"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'/g)) {
    const before = expression.slice(0, match.index).trimEnd();
    const after = expression.slice(match.index + match[0].length).trimStart();
    const opens = before === "" || /(&&|\|\||!)$/.test(before) || (/\($/.test(before) && !/[\w.]\s*\($/.test(before));
    const closes = after === "" || /^(&&|\|\||\))/.test(after);
    if (opens && closes) found.push(match[1] ?? match[2]);
  }
  return found;
}

/** The property comparisons in *expression* with a quoted value: `status == "open"`, and `status = "open"` too. */
export function comparisons(expression: string): { property: string; op: string; value: string }[] {
  return [...expression.matchAll(/([A-Za-z_][\w.]*)\s*(==|!=|=)\s*(["'])(.*?)\3/g)]
    .map((m) => ({ property: m[1], op: m[2], value: m[4] }));
}

/**
 * What to say about a definition's filters (#389), after the rows: a string standing as a condition, a comparison
 * written with one =, and — when nothing matched — the values each compared property really takes in the vault,
 * from *valuesOf* (empty: no note has it). Empty when there is nothing to say.
 */
export function filterHints(definition: string, matched: boolean,
                            valuesOf: (property: string) => Map<string, number>): string {
  const hints: string[] = [];
  const expressions = filterExpressions(definition);
  for (const text of new Set(expressions.flatMap(bareStrings))) {
    hints.push(`The filter "${text}" is a string on its own, which every note passes. To compare a property, write `
      + `it with the value, e.g. 'status == "${text}"'.`);
  }
  const compared = expressions.flatMap(comparisons);
  for (const c of compared.filter((c) => c.op === "=")) {
    hints.push(`Compare with ==, not =: '${c.property} == "${c.value}"'.`);
  }
  if (!matched) {
    const seen = new Set<string>();
    for (const { property } of compared) {
      const key = propertyKey(property);
      if (seen.has(key) || key.startsWith("file.") || key === "this") continue;
      seen.add(key);
      const values = [...valuesOf(key)].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
      const named = /^(file\.frontmatter|frontmatter|file\.properties)\./i.test(property)
        ? ` (write it as ${key} or note.${key})` : "";
      hints.push(values.length
        ? `${key} takes these values in the vault${named}: ${values.slice(0, 10).map(([v, n]) => `"${v}" (${n})`).join(", ")}`
          + (values.length > 10 ? `, and ${values.length - 10} more` : "") + "."
        : `No note in the vault has a property ${key}${named}.`);
    }
  }
  return hints.join("\n");
}

/** The rows of a query's result, as the model reads them: a Markdown table, cut at *limit* rows. */
export function rowsTable(columns: string[], rows: string[][], limit: number): string {
  const cell = (text: string): string => text.replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ").trim();
  const shown = rows.slice(0, limit);
  const lines = [`| ${columns.map(cell).join(" | ")} |`, `| ${columns.map(() => "---").join(" | ")} |`,
                 ...shown.map((row) => `| ${row.map(cell).join(" | ")} |`)];
  const left = rows.length - shown.length;
  return lines.join("\n") + (left ? `\n\n[${left} more rows not shown — pass a larger limit, or narrow the filters]` : "");
}
