/**
 * Attachments: the vault's files that are not notes (#235). What kind each is, in words, so a listing says what
 * read_attachment will make of it, and a size a person can read.
 */

import { getCloseMatches } from "./difflib";
import { basename } from "./paths";

const KINDS: [string[], string][] = [
  [["png", "jpg", "jpeg", "gif", "webp", "bmp", "tiff", "tif", "svg", "avif", "heic"], "image"],
  [["pdf"], "PDF"],
  [["m4a", "mp3", "wav", "ogg", "opus", "flac", "aac", "3gp"], "recording"],
  [["mp4", "webm", "avi", "mov", "mkv"], "video"],
  [["docx", "docm", "doc"], "Word document"],
  [["xlsx", "xlsm", "xls"], "Excel workbook"],
  [["pptx", "pptm", "ppt"], "PowerPoint deck"],
  [["odt"], "OpenDocument text"],
  [["ods"], "OpenDocument spreadsheet"],
  [["odp"], "OpenDocument presentation"],
  [["epub"], "EPUB book"],
  [["canvas"], "canvas"],
  [["base"], "Base"],
  [["txt", "csv", "tsv", "json", "jsonl", "xml", "yaml", "yml", "log", "ini", "toml"], "text file"],
];

/** Whether *path* is an attachment: any file that is not a note. */
export function isAttachment(path: string): boolean {
  return !path.toLowerCase().endsWith(".md");
}

/** What kind of file *path* is, e.g. "PDF", "Word document", "CSV text file"; the extension for anything else. */
export function attachmentKind(path: string): string {
  const extension = /\.([^./]+)$/.exec(path)?.[1]?.toLowerCase() ?? "";
  const kind = KINDS.find(([extensions]) => extensions.includes(extension))?.[1];
  if (kind === "text file") return `${extension.toUpperCase()} text file`;
  return kind ?? (extension ? `.${extension} file` : "file");
}

/**
 * The forms of a file name a model may write differently from the vault: case, Unicode form, accents folded
 * (Einverständnis → einverstandnis), letters a download dropped (Einverstndnis, or a space where the ä was), and German
 * spelled out (Einverstaendnis). Only letters, digits and dots are kept.
 */
function nameKeys(path: string): string[] {
  const name = basename(path).normalize("NFC").toLowerCase();
  const kept = (text: string): string => text.replace(/[^a-z0-9.]/g, "");
  return [
    kept(name.normalize("NFKD").replace(/[̀-ͯ]/g, "")),
    kept(name),
    kept(name.replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").replace(/ß/g, "ss")),
  ];
}

/**
 * The files among *paths* whose name is *wanted* written another way (nameKeys). The vault's file
 * "Einverstndniserklrung.pdf" had lost its umlauts; the model asked for "Einverständniserklärung.pdf" eight times
 * and was told only "not found" (2026-10-05).
 */
export function sameNameWrittenDifferently(wanted: string, paths: string[]): string[] {
  const keys = new Set(nameKeys(wanted));
  return paths.filter((path) => nameKeys(path).some((key) => keys.has(key)));
}

/** The files among *paths* with a name close to *wanted*'s, at most three, the closest first. */
export function closeNames(wanted: string, paths: string[]): string[] {
  const byName = new Map<string, string>();
  for (const path of paths) if (!byName.has(basename(path).toLowerCase())) byName.set(basename(path).toLowerCase(), path);
  return getCloseMatches(basename(wanted).toLowerCase(), [...byName.keys()], 3, 0.6).map((name) => byName.get(name)!);
}

/** A size as a person reads it: "812 bytes", "14 KB", "2.3 MB". */
export function readableSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
