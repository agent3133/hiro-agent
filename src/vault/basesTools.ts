/**
 * query_base (#230): a Base's rows — of a `.base` file, or of a definition the agent passes, such as a ```base
 * block it read in a note — as Obsidian's Bases compute them (filters, formulas, sorting, grouping, limits).
 *
 * Withheld from an agent limited to some folders, as create_tasknote is: a Base's filters reach the whole vault.
 * Not offered when the Bases core plugin is off (the view type could not be registered).
 */

import { type App, TFile } from "obsidian";

import { BASE_SYNTAX, countTable, embeddedBases, filterHints, prepareBase, rowsTable, withColumn } from "../core/baseDefinition";
import { getCloseMatches } from "../core/difflib";
import { defineTool, type Tool } from "../core/tools/tool";
import { basesAvailable, runBase } from "./basesQuery";
import { windowHidden } from "./obsidianVault";

/** Rows shown when the call names no limit. */
const DEFAULT_LIMIT = 50;
/** From this many rows on, the answer names count_by (#267). */
const COUNT_HINT_ROWS = 20;

/** The values a note property takes across the vault's notes, with how many notes have each (#389). */
function propertyValues(app: App, property: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const file of app.vault.getMarkdownFiles()) {
    const frontmatter = app.metadataCache.getFileCache(file)?.frontmatter;
    if (!frontmatter) continue;
    const key = Object.keys(frontmatter).find((k) => k.toLowerCase() === property);
    if (key === undefined) continue;
    const value: unknown = frontmatter[key];
    for (const item of Array.isArray(value) ? value : [value]) {
      if (item === null || item === undefined || item === "") continue;
      const text = typeof item === "object" ? JSON.stringify(item) : String(item);
      counts.set(text, (counts.get(text) ?? 0) + 1);
    }
  }
  return counts;
}

/** The `.base` file *path* names: as given, with `.base` added, or found by its name anywhere in the vault. */
function findBase(app: App, path: string): TFile | null {
  const given = path.trim().replace(/\\/g, "/").replace(/^\/+/, "");
  const withExtension = /\.base$/i.test(given) ? given : `${given}.base`;
  const direct = app.vault.getAbstractFileByPath(withExtension);
  if (direct instanceof TFile) return direct;
  const name = withExtension.split("/").pop()!.toLowerCase();
  return app.vault.getFiles().find((file) => file.extension === "base" && file.name.toLowerCase() === name) ?? null;
}

/** The note *path* names, when it names one: as given, with `.md` added, or by its name as a link finds it. */
function findNote(app: App, path: string): TFile | null {
  const given = path.trim().replace(/\\/g, "/").replace(/^\/+/, "").replace(/\.base$/i, "");
  const direct = app.vault.getAbstractFileByPath(/\.md$/i.test(given) ? given : `${given}.md`);
  if (direct instanceof TFile) return direct;
  const linked = app.metadataCache.getFirstLinkpathDest(given.replace(/\.md$/i, ""), "");
  return linked && linked.extension === "md" ? linked : null;
}

export function makeBasesTools(app: App, scope: string[] | null): Tool[] {
  if (scope && scope.length) return [];
  if (!basesAvailable()) return [];

  const queryBase = defineTool("query_base", async (args) => {
    const path = args.str("base").trim();
    const definition = args.str("definition").trim();
    // Both, to run a saved Base with other filters: say what each one does, and how the filters are written (#270)
    if (path && definition) {
      return "Error: give base or definition, not both. base runs a saved .base file as it is; definition runs a Base "
        + `you write. To filter differently from '${path}', pass only definition.\n\n${BASE_SYNTAX}`;
    }
    if (!path && !definition) return "Error: give base (a .base file) or definition (a Base's YAML)";
    // A minimized window runs nothing on time (#207)
    if (windowHidden()) {
      return "Error: Obsidian's window is minimized, and while it is, Obsidian does not run a Base. Ask the user to "
        + "bring the Obsidian window up, then try again.";
    }
    let source = definition;
    let label = "the definition given";
    let embeddedIn = "";
    if (path) {
      const file = findBase(app, path);
      // A note with a Base in it, named as the Base: "the board in my Office Move project note" (2026-10-05). The
      // one Base it holds is run, `this.file` meaning that note; with several, or none, the answer says what to do
      const holder = file ? null : findNote(app, path);
      if (holder) {
        const blocks = embeddedBases(await app.vault.cachedRead(holder));
        if (blocks.length !== 1) {
          return blocks.length
            ? `Error: '${holder.path}' is a note with ${blocks.length} Bases in it; pass the one you want as definition, `
              + `with note '${holder.path}'`
            : `Error: '${holder.path}' is a note without a Base in it; find_notes with '*.base' lists the vault's Bases`;
        }
        source = blocks[0];
        embeddedIn = holder.path;
        label = `the Base in '${holder.path}'`;
      } else if (!file) {
        // A name one word off ("MOC - Projects - …" for "MOC Projects - …"): name the closest Bases (2026-10-05)
        const bases = app.vault.getFiles().filter((f) => f.extension === "base");
        const close = getCloseMatches(path.replace(/\.base$/i, "").toLowerCase(),
                                      bases.map((f) => f.basename.toLowerCase()), 3, 0.6)
          .map((name) => bases.find((f) => f.basename.toLowerCase() === name)!.path);
        return `Error: no Base '${path}' (a .base file)`
          + (close.length ? `; similar names: ${close.map((p) => `'${p}'`).join(", ")}` : "; find_notes with '*.base' lists them");
      } else {
        source = await app.vault.cachedRead(file);
        label = file.path;
      }
    }
    // The note an embedded Base sits in, which its `this.file` means: given, the note it was found in, or the .base
    // file itself
    let note = args.str("note").trim();
    if (note && !/\.md$/i.test(note)) note = `${note}.md`;
    const prepared = prepareBase(source, args.str("view"), note || embeddedIn || (path ? label : ""));
    if (typeof prepared === "string") return prepared;
    const countBy = args.str("count_by").trim();
    let result;
    try {
      result = await runBase(app, countBy ? withColumn(prepared.yaml, countBy) : prepared.yaml);
    } catch (error) {
      const why = `Error: the Base could not be run: ${error instanceof Error ? error.message : String(error)}`;
      return definition ? `${why}\n\n${BASE_SYNTAX}` : why;
    }
    const limit = args.int("limit") > 0 ? args.int("limit") : DEFAULT_LIMIT;
    const columns = result.groups.length ? ["group", ...result.columns] : result.columns;
    const rows = result.groups.length ? result.rows.map((row, i) => [result.groups[i], ...row]) : result.rows;
    const head = `${label === "the definition given" || embeddedIn ? `Base ${label}` : `Base '${label}'`}, view '${prepared.view}' — `
      + `${rows.length} row${rows.length === 1 ? "" : "s"}`;
    // A definition the model wrote: what is wrong with its filters, and when nothing matched, the values the
    // properties it compares really take (#389). A saved Base's filters are the user's
    const hints = definition ? filterHints(definition, rows.length > 0, (property) => propertyValues(app, property)) : "";
    const withHints = (text: string): string => (hints ? `${text}\n\n${hints}` : text);
    if (rows.length && countBy) {
      const counted = countTable(result.columns, result.ids, result.cells, countBy);
      return counted.startsWith("Error:") ? counted : withHints(`${head}, counted by ${countBy}:\n\n${counted}`);
    }
    if (rows.length) {
      // Many rows: a model counting them by hand miscounts (#267), so name the way to count them
      const many = rows.length > COUNT_HINT_ROWS && result.ids.length > 1
        ? `\n\n[To count the rows per value of a column, call again with count_by, e.g. count_by: "${result.ids[result.ids.length - 1]}"]`
        : "";
      return withHints(`${head}:\n\n${rowsTable(columns, rows, limit)}${many}`);
    }
    // A definition the model wrote that matches nothing is often a filter written wrong: say how they are written.
    // A saved Base's filters are the user's, and matching nothing is an answer
    return definition
      ? withHints(`${head}: no note matches its filters. If some should, check how they are written.\n\n${BASE_SYNTAX}`)
      : `${head}: no note matches its filters`;
  });

  return [queryBase];
}
