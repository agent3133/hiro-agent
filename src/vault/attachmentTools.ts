/**
 * read_attachment — ported from make_attachment_tools (src/obsidian_agent/tools/builtin/attachment.py) (#84): the
 * model is given an image, each PDF page rendered as one through Obsidian's own PDF.js, a recording's transcript
 * (whisper.cpp, cached below its embeds — core/recordings.ts), and a video's frames with the transcript of its sound.
 *
 * Difference from Python, on purpose: a bare file name is found the way Obsidian resolves an attachment link, and
 * only inside the agent's folders (Python searched the whole vault, past the scope).
 */

import { arrayBufferToBase64, FileSystemAdapter, loadPdfJs, TFile, TFolder, type App } from "obsidian";

import { DOCUMENT_EXTENSIONS, importDocument, readDocument, type ImportedDocument } from "../core/documents";
import { IMAGE_PLACEHOLDER } from "../core/documents/epub";
import { brokenByWrite } from "../core/frontmatter";
import { placeImport } from "../core/importText";
import { canvasToMarkdown } from "../core/documents/canvas";
import { decodeText, TEXT_EXTENSIONS, textAttachment } from "../core/documents/textFile";
import { textOf, type ContentPart } from "../core/llm/openaiChat";
import { closeNames, importedImageName, sameNameWrittenDifferently } from "../core/attachments";
import { imageKind, SENDABLE } from "../core/images";
import { pageNumbers } from "../core/pageNumbers";
import { checkNoteName, noteFile, PathError, safeResolve } from "../core/paths";
import { AUDIO_EXTENSIONS, isAudioFile, recordingAnswer, VIDEO_EXTENSIONS } from "../core/recordings";
import { defineTool, type Tool } from "../core/tools/tool";
import type { VaultPort } from "../core/vault";
import { formatSize, kindOf, LIMITS_MB } from "../view/attachments";
import { nodeMedia, type AudioSettings } from "./media";
import { noteWrite, obsidianVault, recordChange } from "./obsidianVault";
import { Scope } from "../core/scope";

/** The extensions read as images; what each holds is told by its bytes (#380). */
const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "avif", "tiff", "tif", "heic", "heif", "svg"];
/** What a recording or video answers while the audio programs wait for this device's approval (#136). */
const PROGRAMS_NOT_APPROVED = "Error: the audio programs set in Settings → Hiro Agent → Features → Audio "
  + "transcription are not approved on this device (they may have come from another device's settings), so "
  + "nothing was run. Tell the user to check them there and approve them.";

/** An open PDF.js document, as far as the readers use it. */
interface PdfDocument {
  numPages: number;
  getPage(number: number): Promise<{ getTextContent(): Promise<{ items: unknown[] }> }>;
  destroy?(): Promise<void>;
}

/** 150 dpi balances legibility against the tokens a page costs (Python's _RENDER_DPI). */
const RENDER_DPI = 150;
/** Characters of text per page, on average, above which a PDF is read as text when as_text is not given (#246) */
export const TEXT_PER_PAGE = 200;

/** The extensions whose pages, sheets, slides or chapters `pages` picks. */
const PAGED = ["pdf", "xlsx", "xlsm", "pptx", "pptm", "ods", "odp", "epub"];

/**
 * An attachment as a model may name it (#386): a path, or an embed or link copied from a note (`![[photo.jpg|300]]`,
 * `[[report.pdf#page=3]]`, `report.pdf#page=3`). A link's alias and subpath are dropped; a `#page=N` gives the page.
 * A `#` outside a link and not before `page=` is kept: it may be part of the file's name.
 */
export function attachmentTarget(raw: string): { path: string; page: string } {
  let path = raw.trim();
  const link = /^!?\[\[([\s\S]*)\]\]$/.exec(path);
  if (link) path = link[1].split("|")[0];
  let page = "";
  const hash = path.indexOf("#");
  if (hash > 0) {
    const subpath = path.slice(hash + 1).trim();
    const numbered = /^page=(\d+)$/i.exec(subpath);
    if (numbered) page = numbered[1];
    if (numbered || link) path = path.slice(0, hash);
  }
  return { path: path.trim(), page };
}

/** as_text as the model gave it: true, false, or null when it left it out and the PDF decides (#246) */
function asTextOf(args: Record<string, unknown>): boolean | null {
  const value = args.as_text;
  return value === undefined || value === null ? null : Boolean(value);
}

/**
 * *bytes* of an image the app can decode (BMP, ICO, AVIF) as a PNG data URL, through the renderer's own decoder;
 * null when it cannot decode them (TIFF, HEIC) (#380).
 */
export async function canvasPng(bytes: Uint8Array): Promise<string | null> {
  try {
    const bitmap = await createImageBitmap(new Blob([bytes.slice().buffer]));
    const canvas = createEl("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext("2d")?.drawImage(bitmap, 0, 0);
    bitmap.close();
    return canvas.toDataURL("image/png");
  } catch {
    return null;
  }
}

export function makeAttachmentTools(app: App, scope: string[] | null, audio: AudioSettings,
                                    vault: VaultPort = obsidianVault(app),
                                    toPng: (bytes: Uint8Array) => Promise<string | null> = canvasPng): Tool[] {
  const adapter = app.vault.adapter;
  // Programs need file paths; a vault that is not on disk (mobile) has recordings the agent cannot hear
  const media = adapter instanceof FileSystemAdapter ? nodeMedia(audio, (path) => adapter.getFullPath(path)) : null;

  const limits = Scope.of(scope);
  const scoped = limits.restricted;
  const inScope = (path: string): boolean => limits.contains(path);

  /** Whether *path* would be allowed to an agent without folders: inside the vault, outside protected folders. */
  const allowedWithoutScope = (path: string): boolean => {
    try {
      safeResolve(path, null);
      return true;
    } catch (error) {
      if (error instanceof PathError) return false;
      throw error;
    }
  };

  const find = (path: string): { file: TFile | null; error: string; note?: string } => {
    if (!path.trim()) {
      return { file: null, error: "Error: no path given: name the attachment by its path or file name (list_attachments lists them)" };
    }
    const inFolder = path.includes("/") || path.includes("\\");
    let resolved: string | null = null;
    try {
      resolved = safeResolve(path, scope);
    } catch (error) {
      if (!(error instanceof PathError)) throw error;
      // A bare name is read at the vault's root, outside an agent's folders: refused for the scope alone, it is still
      // looked for by name below, inside the folders (#387). Escapes and protected folders stay refused.
      if (inFolder || !scoped || !allowedWithoutScope(path)) return { file: null, error: `Error: ${error.message}` };
    }
    const direct = resolved === null ? null : app.vault.getAbstractFileByPath(resolved);
    if (direct instanceof TFile) return { file: direct, error: "" };
    if (direct instanceof TFolder) {
      return { file: null, error: `Error: '${path}' is a folder, not a file; list_attachments with path '${direct.path}' lists the files in it` };
    }
    if (!inFolder) {
      // A bare file name, as notes embed it: resolved the way Obsidian resolves ![[photo.jpg]]
      const linked = app.metadataCache.getFirstLinkpathDest(path, "");
      const file = linked && inScope(linked.path) ? linked
        : app.vault.getFiles().find((f) => f.name === path && inScope(f.path)) ?? null;
      if (file) return { file, error: "" };
    }
    // The name written another way (an umlaut the file's name lost, a different Unicode form): the one such file is
    // read, and the answer gives its real name; otherwise the error names the closest ones
    const attachments = app.vault.getFiles().filter((f) => f.extension.toLowerCase() !== "md" && inScope(f.path))
      .map((f) => f.path);
    const same = sameNameWrittenDifferently(path, attachments);
    if (same.length === 1) {
      const file = app.vault.getAbstractFileByPath(same[0]);
      if (file instanceof TFile) return { file, error: "", note: `[No file is named '${path}'; this is '${same[0]}'.]` };
    }
    const similar = same.length ? same.slice(0, 3) : closeNames(path, attachments);
    const named = similar.length ? `; similar names: ${similar.map((p) => `'${p}'`).join(", ")}` : "";
    return { file: null, error: inFolder ? `Error: attachment not found at '${path}'${named}`
      : `Error: attachment '${path}' not found anywhere in the vault${named}` };
  };

  /**
   * An image as the model gets it (#380): its type from its bytes, PNG, JPEG, GIF and WebP as they are, other formats
   * converted to PNG where the app can decode them, an SVG as its XML. An image the server could not load would fail
   * the whole message, so an empty file, bytes that are no image and a format nothing decodes (TIFF) are errors.
   */
  const image = async (file: TFile, shown: string): Promise<ContentPart[] | string> => {
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await app.vault.readBinary(file));
    } catch (error) {
      return `Error: could not read image: ${error instanceof Error ? error.message : String(error)}`;
    }
    if (!bytes.length) return `Error: '${shown}' is empty (0 bytes), so there is no image to show`;
    const kind = imageKind(bytes);
    if (kind === "svg") {
      return `SVG image '${shown}', as its XML (the drawing is not rendered):\n\n${decodeText(bytes) ?? ""}`;
    }
    if (!kind) return `Error: '${shown}' is not an image, although its name says so: its bytes are no image format`;
    const mime = SENDABLE[kind];
    const url = mime ? `data:${mime};base64,${arrayBufferToBase64(bytes.slice().buffer)}` : await toPng(bytes);
    if (!url) {
      // The name is no evidence: a model told it cannot see "red.tiff" answered "Red" (2026-11-10)
      return `Error: '${shown}' is a ${kind.toUpperCase()} image, which cannot be shown to the model, so what it shows `
        + "is unknown: do not guess it from the file's name. Ask the user to save it as PNG or JPEG.";
    }
    return [{ type: "text", text: `Image '${shown}':` }, { type: "image_url", image_url: { url } }];
  };

  /** The text layer of one page of an open PDF.js *document*. */
  const pageText = async (document: PdfDocument, number: number): Promise<string> => {
    const content = await (await document.getPage(number)).getTextContent();
    const items = content.items as { str?: string; hasEOL?: boolean }[];
    return items.map((item) => (item.str ?? "") + (item.hasEOL ? "\n" : "")).join("").trim();
  };

  /**
   * A PDF's chosen pages. *asText* true gives the text layer, false page images, and null (not given) the text when
   * the pages hold enough of it, images otherwise (#246): text is far smaller (a 30-page report fits where only 8
   * page images did) and any model can read it, while a scan has no text worth giving.
   */
  const pdf = async (file: TFile, shown: string, wanted: string, asText: boolean | null): Promise<ContentPart[] | string> => {
    try {
      const pdfjs = await loadPdfJs();
      const document = await pdfjs.getDocument({ data: new Uint8Array(await app.vault.readBinary(file)) }).promise;
      const pages: number = document.numPages;
      if (!pages) return "Error: PDF has no pages";
      const chosen = pageNumbers(wanted, pages);
      if (typeof chosen === "string") return chosen;
      const which = chosen.length === pages ? `${pages} page(s)` : `page(s) ${wanted.trim()} of ${pages}`;
      if (asText !== false) {
        // The text layer, for a model that cannot see images — most local ones (#166)
        const texts: string[] = [];
        let characters = 0;
        for (const number of chosen) {
          const text = await pageText(document, number);
          characters += text.length;
          texts.push(`Page ${number}/${pages}:\n${text || "[no text on this page]"}`);
        }
        if (asText || characters / chosen.length >= TEXT_PER_PAGE) {
          await document.destroy?.();
          const blank = texts.every((text) => text.endsWith("[no text on this page]"));
          return `PDF '${shown}' — ${which}, as text:\n\n${texts.join("\n\n")}`
            + (blank ? "\n\n[No text layer: the PDF is probably scanned. Read it with as_text false to see the pages.]"
              : asText ? "" : "\n\n[As text, from the PDF's text layer. For the pages as images (tables, charts, "
                + "layout), read it with as_text false.]");
        }
        // Too little text to be the content: a scan, or pages that are mostly pictures — show them
      }
      const parts: ContentPart[] = [{ type: "text", text: `PDF '${shown}' — ${which}:` }];
      for (const number of chosen) {
        const page = await document.getPage(number);
        const viewport = page.getViewport({ scale: RENDER_DPI / 72 });
        const canvas = createEl("canvas");
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
        parts.push({ type: "text", text: `Page ${number}/${pages}:` },
                   { type: "image_url", image_url: { url: canvas.toDataURL("image/png") } });
      }
      await document.destroy?.();
      return parts;
    } catch (error) {
      // PDF.js says "No password given": the model needs to know what to tell the user (#386)
      if (error instanceof Error && error.name === "PasswordException") {
        return `Error: '${shown}' is protected by a password, so it cannot be read. Ask the user for a copy without the password.`;
      }
      return `Error: could not read attachment: ${error instanceof Error ? error.message : String(error)}`;
    }
  };

  /** A video's frames, with the transcript of its sound when there is one and audio is on — Python's order. */
  const video = async (file: TFile, shown: string): Promise<ContentPart[] | string> => {
    if (!audio.approved) return PROGRAMS_NOT_APPROVED;
    if (!media) return "Error: videos can be read only where the vault is on disk (desktop)";
    const sampled = await media.frames(file.path);
    const heard = audio.enabled && (await media.hasAudio(file.path))
      ? await recordingAnswer(vault, file.path, media, true, scope) : null;
    if (typeof sampled === "string") return heard ? `${sampled}\n\n${heard}` : sampled;
    const n = sampled.frames.length;
    const parts: ContentPart[] = [{ type: "text", text: `Video '${shown}' — ${n} frame(s) sampled at ${sampled.fps.toFixed(2)} fps:` }];
    sampled.frames.forEach((url, index) => parts.push({ type: "text", text: `Frame ${index + 1}/${n}:` },
                                                      { type: "image_url", image_url: { url } }));
    return heard ? [...parts, { type: "text", text: heard }] : parts;
  };

  const read = async (raw: string, given = "", asText: boolean | null = null): Promise<ContentPart[] | string> => {
    const { path, page } = attachmentTarget(raw);
    const pages = given.trim() ? given : page;
    const { file, error, note } = find(path);
    if (!file) return error;
    // Found under another name: the answer uses the real one, so the next call does too
    let answer = await readFile(file, note ? file.path : path, pages, asText);
    // pages given for a file that has none is said, so the model does not take the whole file for the page (#386)
    if (pages.trim() && !PAGED.includes(file.extension.toLowerCase()) && typeof answer === "string" && !answer.startsWith("Error:")) {
      answer += "\n\n[pages applies to PDFs, spreadsheets, presentations and EPUB books; this is the whole file.]";
    }
    if (!note) return answer;
    return typeof answer === "string" ? `${note}\n\n${answer}` : [{ type: "text", text: note }, ...answer];
  };

  const readFile = async (file: TFile, path: string, pages: string, asText: boolean | null): Promise<ContentPart[] | string> => {
    const extension = file.extension.toLowerCase();
    // The limits of a file added to a message hold for one already in the vault: a 300 MB photo would otherwise be
    // read whole and sent as base64 (#397)
    const kind = IMAGE_EXTENSIONS.includes(extension) ? "image" : kindOf(file.name);
    if (kind && file.stat.size > LIMITS_MB[kind] * 1024 * 1024) {
      return `Error: '${path}' is ${formatSize(file.stat.size)}, more than the ${LIMITS_MB[kind]} MB the agent reads of `
        + `a file of this kind, so it was not read. Ask the user for a smaller copy.`;
    }
    const programs = audio.approved ? media : null;
    if (AUDIO_EXTENSIONS.includes(extension) || (extension === "webm" && programs && (await isAudioFile(file.path, programs)))) {
      if (!audio.approved) return PROGRAMS_NOT_APPROVED;
      if (!media) return "Error: recordings can be transcribed only where the vault is on disk (desktop)";
      return recordingAnswer(vault, file.path, media, audio.enabled, scope);
    }
    if (VIDEO_EXTENSIONS.includes(extension)) return video(file, path);
    if (extension === "pdf") return pdf(file, path, pages, asText);
    if (IMAGE_EXTENSIONS.includes(extension)) return image(file, path);
    // Data exports, logs, configuration: as text (#210)
    // From the bytes, not Obsidian's UTF-8 read: UTF-16 and Windows-1252 files are common on Windows (#382)
    if (TEXT_EXTENSIONS.includes(extension)) {
      const text = decodeText(new Uint8Array(await app.vault.readBinary(file)));
      return text === null ? `Error: '${path}' is not a text file, although its name says so` : textAttachment(path, text);
    }
    // A file without an extension (README, LICENSE) is read when it is text (#382)
    if (!extension) {
      const text = decodeText(new Uint8Array(await app.vault.readBinary(file)));
      // Control characters other than tabs, line breaks and form feeds mark a binary file
      const binary = text === null || [...text.slice(0, 4096)].some((c) => c < " " && !"\t\n\r\f".includes(c));
      return binary
        ? `Error: '${path}' has no extension and is not text, so read_attachment cannot tell what it is`
        : textAttachment(path, text);
    }
    // A canvas: its cards, groups and arrows, read only (#214)
    if (extension === "canvas") return canvasToMarkdown(path, await app.vault.cachedRead(file));
    // Office documents as text; pages picks sheets or slides (#211)
    if (DOCUMENT_EXTENSIONS.includes(extension)) {
      return readDocument(extension, new Uint8Array(await app.vault.readBinary(file)), path, pages);
    }
    // A note is not an attachment: say which tool reads it, not that its type is unsupported (2026-10-05)
    if (extension === "md") return `Error: '${file.path}' is a note, not an attachment; read it with read_note`;
    return `Error: unsupported attachment type '.${extension}'. Supported: pdf, images (png/jpg/gif/webp/bmp/ico/avif/svg), `
           + "video (mp4/webm/avi/mov/mkv), audio (m4a/mp3/wav/ogg/opus/flac/aac), Office documents (docx/xlsx/pptx), "
           + "OpenDocument (odt/ods/odp), EPUB books, canvases, "
           + `text files (${TEXT_EXTENSIONS.join("/")})`;
  };

  const readAttachment = defineTool(
    "read_attachment", async (args) => textOf(await read(args.str("path"), args.str("pages"), asTextOf(args))),
    { content: (args) => read(args.str("path"), args.str("pages"), asTextOf(args)) });
  /** A PDF's text layer, the pages *wanted* picks one after another, for the import. */
  const pdfText = async (file: TFile, wanted: string): Promise<string> => {
    const pdfjs = await loadPdfJs();
    const document = (await pdfjs.getDocument({ data: new Uint8Array(await app.vault.readBinary(file)) }).promise) as PdfDocument;
    try {
      const chosen = pageNumbers(wanted, document.numPages);
      if (typeof chosen === "string") return chosen;
      const texts: string[] = [];
      for (const number of chosen) texts.push(await pageText(document, number));
      return texts.filter(Boolean).join("\n\n");
    } finally {
      await document.destroy?.();
    }
  };

  /** What *file* holds as Markdown for a note, or the error to return: documents, books, PDFs' text, text files. */
  const converted = async (file: TFile, shown: string, pages: string): Promise<ImportedDocument | string> => {
    const extension = file.extension.toLowerCase();
    if (DOCUMENT_EXTENSIONS.includes(extension)) {
      return importDocument(extension, new Uint8Array(await app.vault.readBinary(file)), shown, pages);
    }
    if (extension === "pdf") {
      const text = await pdfText(file, pages);
      if (text.startsWith("Error:")) return text;
      if (!text.trim()) return `Error: '${shown}' has no text layer (it is probably scanned), so there is no text to import`;
      return { what: "PDF", text, images: new Map() };
    }
    if (TEXT_EXTENSIONS.includes(extension)) {
      const text = decodeText(new Uint8Array(await app.vault.readBinary(file)));
      if (text === null) return `Error: '${shown}' is not a text file, although its name says so`;
      return { what: "text file", text, images: new Map() };
    }
    if (extension === "md") return `Error: '${file.path}' is a note, not an attachment`;
    return `Error: '${shown}' has no text to import: import_attachment copies documents (Word, OpenDocument, `
      + "PowerPoint, Excel), EPUB books, PDFs with a text layer and text files. Images, recordings and videos are "
      + "read with read_attachment.";
  };

  /**
   * A book's *images* saved for the note *note*: in Obsidian's folder for new attachments, or beside the note when that
   * folder is outside the agent's folders; named after the book, and an image saved before with the same size reused.
   * The embed of each, by its file in the archive.
   */
  const saveImages = async (images: Map<string, Uint8Array>, book: TFile,
                            note: string): Promise<{ embeds: Map<string, string>; saved: number; reused: number }> => {
    const embeds = new Map<string, string>();
    let saved = 0;
    let reused = 0;
    const noteFolder = note.includes("/") ? note.slice(0, note.lastIndexOf("/")) : "";
    for (const [archived, bytes] of images) {
      const name = importedImageName(book.basename, archived);
      const offered = await app.fileManager.getAvailablePathForAttachment(name, note);
      let folder = offered.includes("/") ? offered.slice(0, offered.lastIndexOf("/")) : "";
      if (!inScope(folder ? `${folder}/${name}` : name)) folder = noteFolder;
      const at = (file: string): string => (folder ? `${folder}/${file}` : file);
      let path = at(name);
      const there = app.vault.getAbstractFileByPath(path);
      if (there instanceof TFile && there.stat.size === bytes.length) {
        embeds.set(archived, `![[${path}]]`);
        reused += 1;
        continue;
      }
      // Another file by that name: the next free one, as Obsidian numbers pasted images
      const dot = name.lastIndexOf(".");
      for (let n = 1; app.vault.getAbstractFileByPath(path); n++) path = at(`${name.slice(0, dot)} ${n}${name.slice(dot)}`);
      if (folder && !app.vault.getAbstractFileByPath(folder)) await app.vault.createFolder(folder);
      await app.vault.createBinary(path, bytes.slice().buffer);
      noteWrite();
      // Undo takes it back while it is as saved: by its size, as an image has no text to compare (#331)
      recordChange(vault, { op: "create", path, before: null, after: "", binarySize: bytes.length });
      embeds.set(archived, `![[${path}]]`);
      saved += 1;
    }
    return { embeds, saved, reused };
  };

  /** The note import_attachment writes, resolved inside the agent's folders, or the error to return. */
  const targetNote = (raw: string): { path: string; error: string } => {
    const path = noteFile(raw);
    const problem = checkNoteName(path);
    if (problem) return { path, error: `Error: invalid note path '${path}': ${problem}` };
    try {
      return { path: safeResolve(path, scope), error: "" };
    } catch (error) {
      if (error instanceof PathError) return { path, error: `Error: ${error.message}` };
      throw error;
    }
  };

  const importAttachment = defineTool("import_attachment", async (args) => {
    const target = targetNote(args.str("note"));
    if (target.error) return target.error;
    const source = attachmentTarget(args.str("path"));
    const { file, error, note: renamed } = find(source.path);
    if (!file) return error;
    const pages = args.str("pages").trim() || source.page;
    const document = await converted(file, file.path, pages);
    if (typeof document === "string") return document;
    if (!document.text.trim()) return `Error: ${pages ? `pages '${pages}' of ` : ""}'${file.path}' hold no text to import`;
    const current = (await vault.isFile(target.path)) ? await vault.read(target.path) : null;
    const heading = args.str("heading");
    // A section of a note that is not there: a name mistyped or made up, not a note to create with a bare heading — the
    // caller makes it first, from its template (#331, 2026-10-07: an invented chapter title became a stray note)
    if (current === null && heading.trim()) {
      return `Error: there is no note '${target.path}' to put the text into its '${heading.trim()}' section. Check the `
        + "name; create the note first (from its template) and import again — or leave out heading to make a new note "
        + "holding just the text.";
    }
    // Frontmatter the import would break is refused before an image is saved
    const broken = current === null ? null : brokenByWrite(current, placeImport(current, document.text, heading).content);
    if (broken) return broken;
    const images = await saveImages(document.images, file, target.path);
    const text = document.text.replace(IMAGE_PLACEHOLDER, (_whole, archived: string) => images.embeds.get(archived) ?? "[image]");
    const placed = placeImport(current, text, heading);
    await vault.write(target.path, placed.content);
    const pictures = images.saved || images.reused
      ? ` ${images.saved + images.reused} image(s) embedded${images.saved ? `, ${images.saved} saved` : ""}`
        + `${images.reused ? `, ${images.reused} already in the vault` : ""}.` : "";
    return `${renamed ? `${renamed}\n` : ""}Imported ${text.length} characters of the ${document.what} '${file.path}'`
      + `${pages ? ` (pages "${pages}")` : ""} into ${placed.where} of '${target.path}'.${pictures} The text is as the `
      + "file has it; read_note shows it.";
  }, {
    // Replacing a section that holds text is overwriting it, asked about like update_note; creating and appending are not
    // The question names the note that changes; path is the attachment, not a note
    confirmArgs: async (args) => ({ ...args, note: targetNote(String(args.note ?? "")).path }),
    destructiveWhen: async (args) => {
      const target = targetNote(args.str("note"));
      if (target.error || !(await vault.isFile(target.path))) return false;
      return placeImport(await vault.read(target.path), "x", args.str("heading")).replaces;
    },
  });
  return [readAttachment, importAttachment];
}
