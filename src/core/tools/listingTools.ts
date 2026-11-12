/**
 * list_notes, find_notes and list_attachments: the vault tools that list rather than read or write (#419, split
 * out of vaultTools.ts, which keeps the reading and writing ones). Same results, errors and limits as before.
 */

import { attachmentKind, isAttachment, readableSize } from "../attachments";
import { fnmatch } from "../fnmatch";
import { basename, scopeHint } from "../paths";
import { Scope } from "../scope";
import { hiddenBelow, newestFirst, resolveFolder, suggestNotes, vaultFiles, vaultNotes, type VaultPort } from "../vault";
import { defineTool, type Tool } from "./tool";

/** Notes per listing: "list everything" in a vault of a few hundred notes would crowd out the context. */
export const LIST_LIMIT = 100;
/** Attachments find_notes names when notes match as well (#248). */
const ATTACHMENTS_NAMED = 3;

export function makeListingTools(vault: VaultPort, scope: string[] | null = null): Tool[] {
  const listNotes = defineTool("list_notes", async (args) => {
    const path = args.str("path");
    const recursive = args.bool("recursive");
    const limit = args.int("limit");
    // Quotes a model put around the path, and an empty one ('""'), are no folder to look for (#159)
    const asked = path.trim().replace(/^"+|"+$/g, "");
    const byModified = args.str("sort").toLowerCase() === "modified";
    const listing = async (found: string[], empty = ""): Promise<string> => {
      if (!found.length) return empty;
      // Newest first, each with its day, the folders still first (#166)
      const paths = byModified ? [...found.filter((p) => p.endsWith("/")),
                                  ...(await newestFirst(vault, found.filter((p) => !p.endsWith("/"))))] : found;
      const shown = paths.slice(0, limit);
      const left = paths.length - shown.length;
      return shown.join("\n") + (left ? `\n[${left} more, name a folder to narrow the list]` : "");
    };
    // Not the notes below a dot folder — .sessions, .memory, .trash — as no other tool shows them either, and none
    // may read them (#158). Naming one (.trash, to restore from it) lists what is directly in it.
    const notesUnder = async (base: string): Promise<string[]> => (await vault.files())
      .filter((file) => file.endsWith(".md") && (base ? file.startsWith(`${base}/`) : true))
      .filter((file) => !hiddenBelow(file, base))
      .filter((file) => recursive || !file.slice(base ? base.length + 1 : 0).includes("/"));
    // Not recursive: the folders directly inside too, first, as "Name/", so one call shows where notes live (#159)
    const foldersIn = async (base: string): Promise<string[]> => recursive ? [] : (await vault.folders())
      .filter((folder) => (base ? folder.startsWith(`${base}/`) : true))
      .filter((folder) => !folder.slice(base ? base.length + 1 : 0).includes("/"))
      .filter((folder) => !hiddenBelow(`${folder}/x`, base))
      .sort().map((folder) => `${folder}/`);
    const under = async (base: string): Promise<string[]> => [...(await foldersIn(base)), ...(await notesUnder(base)).sort()];
    // A folder's attachments are not listed, only counted, with the tool that lists them (#235): a model looking
    // for "the invoice in my Inbox" otherwise decides it is not there
    const attachmentsIn = async (base: string): Promise<string> => {
      const count = (await vault.files()).filter((file) => isAttachment(file)
        && (base ? file.startsWith(`${base}/`) : true) && !hiddenBelow(file, base)
        && (recursive || !file.slice(base ? base.length + 1 : 0).includes("/"))).length;
      return count ? `[and ${count} attachment(s)${base ? ` in '${base}'` : ""}: list_attachments lists them, or find_notes with their type, such as '*.pdf']` : "";
    };
    const withAttachments = async (text: string, base: string): Promise<string> => {
      const more = await attachmentsIn(base);
      return more ? (text ? `${text}\n${more}` : more) : text;
    };

    // "." and "/" are the vault itself: the folder "" that resolveFolder finds for them is no error (#235)
    if (asked && !/^[./]+$/.test(asked)) {
      const { folder, error } = await resolveFolder(vault, asked, scope);
      if (folder === null) return error;
      return withAttachments(await listing(await under(folder), `No notes in '${folder}'`), folder);
    }
    const limits = Scope.of(scope);
    if (limits.restricted) {
      const all: string[] = [];
      for (const dir of limits.roots()) {
        if (!(await vault.isFolder(dir))) continue;
        all.push(...(await under(dir)));
      }
      return listing(all);
    }
    return withAttachments(await listing(await under("")), "");
  });

  const findNotes = defineTool("find_notes", async (args) => {
    const pattern = args.str("pattern");
    const folder = args.str("folder");
    const limit = args.int("limit");
    const needle = pattern.replace(/\\/g, "/").trim().replace(/^"+|"+$/g, "").toLowerCase();
    if (!needle) return "Error: pattern must not be empty";
    const wild = needle.includes("*") || needle.includes("?");
    const wantedFolder = folder.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "").toLowerCase();
    const matching = (candidates: string[]): string[] => candidates.filter((rel) => {
      if (folder && !rel.toLowerCase().startsWith(`${wantedFolder}/`)) return false;
      const haystack = rel.toLowerCase();
      // A folder in the pattern matches at any depth: 'Projects/*' finds TaskNotes/Projects/x.md too (#159)
      return wild ? fnmatch(haystack, needle) || fnmatch(basename(haystack), needle)
                    || (needle.includes("/") && !needle.startsWith("/") && fnmatch(haystack, `*/${needle}`))
        : haystack.includes(needle);
    });
    // A pattern naming another file type (`*.png`, `report.pdf`) asks for attachments, which Python's find_notes
    // never finds — a model then told the user the vault had no images (#95). Those files are searched first; a
    // note whose name merely has a dot in it ("Meeting 26.09", "v1.2") is still found when no file matches.
    const extension = /\.([a-z][a-z0-9]{0,7})$/.exec(needle)?.[1];
    let matches: string[] = [];
    if (extension !== undefined && extension !== "md") {
      const files = matching(await vaultFiles(vault, scope, (file) => file.toLowerCase().endsWith(`.${extension}`)));
      if (files.length) return attachmentList(files.sort(), limit);
      matches = matching(await vaultNotes(vault, scope));
      if (!matches.length) return `No files or notes match '${pattern}'${scopeHint(scope)}`;
    } else {
      matches = matching(await vaultNotes(vault, scope));
    }
    if (!matches.length) {
      // No note by that name, but an attachment: "the kickoff slides", "Pasted image*", "*png" (#235)
      const files = matching(await vaultFiles(vault, scope, isAttachment));
      if (files.length) return `No notes match '${pattern}', but these attachments do:\n${attachmentList(files.sort(), limit)}`;
      // With a folder, the closest names in that folder first: '2026-10-05' in Journal/Daily suggested two
      // clippings next to the daily note (2026-10-05). Outside the agent's folders it suggests nothing extra
      const asked = folder.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
      const inside = asked && Scope.of(scope).contains(asked);
      let hint = inside ? await suggestNotes(vault, pattern, [asked]) : [];
      const where = hint.length ? ` in '${asked}'` : "";
      if (!hint.length) hint = await suggestNotes(vault, pattern, scope);
      return `No notes match '${pattern}'${scopeHint(scope)}`
        + (hint.length ? `. Closest${where}: ${hint.map((h) => `'${h}'`).join(", ")}` : "");
    }
    const sorted = args.str("sort").toLowerCase() === "modified" ? await newestFirst(vault, matches) : matches.sort();
    const listed = sorted.slice(0, limit).join("\n") + (sorted.length > limit ? `\n[${sorted.length - limit} more]` : "");
    // Notes matched, and an attachment by the same name may be what was meant: "the kickoff slides" found the
    // project note and never showed the deck beside it (#248). A pattern naming a file type was answered above.
    const alsoFiles = extension === undefined ? matching(await vaultFiles(vault, scope, isAttachment)).sort() : [];
    if (!alsoFiles.length) return listed;
    const named = alsoFiles.slice(0, ATTACHMENTS_NAMED).join(", ")
      + (alsoFiles.length > ATTACHMENTS_NAMED ? `, and ${alsoFiles.length - ATTACHMENTS_NAMED} more` : "");
    return `${listed}\n[and ${alsoFiles.length} attachment(s) match too: ${named}; read_attachment reads them]`;
  });

  const listAttachments = defineTool("list_attachments", async (args) => {
    const asked = args.str("path").replace(/\\/g, "/").trim().replace(/^"+|"+$/g, "");
    const pattern = args.str("pattern");
    const needle = pattern.replace(/\\/g, "/").trim().replace(/^"+|"+$/g, "").toLowerCase();
    const limit = args.int("limit");
    let base = "";
    if (asked && !/^[./]+$/.test(asked)) {
      const { folder, error } = await resolveFolder(vault, asked, scope);
      if (folder === null) return error;
      base = folder;
    }
    const found = (await vaultFiles(vault, scope, (file) => isAttachment(file) && (!base || file.startsWith(`${base}/`))))
      .filter((file) => !needle || pathMatches(file, needle));
    if (!found.length) {
      return `No attachments${base ? ` in '${base}'` : ""}${needle ? ` match '${pattern}'` : ""}${scopeHint(scope)}`;
    }
    const dated = args.str("sort").toLowerCase() === "modified" && vault.modified;
    const times = new Map<string, number>();
    if (dated) for (const file of found) times.set(file, await vault.modified!(file).catch(() => 0));
    const sorted = dated ? found.sort((a, b) => times.get(b)! - times.get(a)! || (a < b ? -1 : 1)) : found.sort();
    const lines: string[] = [];
    for (const file of sorted.slice(0, limit)) {
      const facts = [attachmentKind(file)];
      if (vault.size) facts.push(readableSize(await vault.size(file).catch(() => 0)));
      if (dated) facts.push(`changed ${day(times.get(file)!)}`);
      lines.push(`${file} (${facts.join(", ")})`);
    }
    const left = sorted.length - lines.length;
    return lines.join("\n") + (left ? `\n[${left} more; name a folder or a pattern to narrow the list]` : "")
      + "\n(read_attachment reads them)";
  });

  // Python's order (make_vault_tools), so the model sees the tools as it does from the runtime
  return [listNotes, findNotes, listAttachments];
}

/** Whether a vault path matches a find_notes pattern: wildcards against the path or the file name, else a substring. */
function pathMatches(rel: string, needle: string): boolean {
  const haystack = rel.toLowerCase();
  if (!(needle.includes("*") || needle.includes("?"))) return haystack.includes(needle);
  // A folder in the pattern matches at any depth: 'Projects/*' finds TaskNotes/Projects/x.md too (#159)
  return fnmatch(haystack, needle) || fnmatch(basename(haystack), needle)
    || (needle.includes("/") && !needle.startsWith("/") && fnmatch(haystack, `*/${needle}`));
}

/** A local day, YYYY-MM-DD. */
function day(time: number): string {
  const date = new Date(time);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** find_notes' answer for attachments: the files, and that they are read with read_attachment, not read_note. */
function attachmentList(found: string[], limit: number): string {
  const shown = found.slice(0, limit).join("\n") + (found.length > limit ? `\n[${found.length - limit} more]` : "");
  return `${shown}\n(Attachments, not notes: read_attachment reads images, PDFs and recordings; read_note does not.)`;
}
