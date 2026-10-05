/**
 * read_attachment — ported from make_attachment_tools (src/obsidian_agent/tools/builtin/attachment.py) (#84): the
 * model is given an image, each PDF page rendered as one through Obsidian's own PDF.js, a recording's transcript
 * (whisper.cpp, cached below its embeds — core/recordings.ts), and a video's frames with the transcript of its sound.
 *
 * Difference from Python, on purpose: a bare file name is found the way Obsidian resolves an attachment link, and
 * only inside the agent's folders (Python searched the whole vault, past the scope).
 */

import { arrayBufferToBase64, FileSystemAdapter, loadPdfJs, TFile, type App } from "obsidian";

import { DOCUMENT_EXTENSIONS, readDocument } from "../core/documents";
import { canvasToMarkdown } from "../core/documents/canvas";
import { TEXT_EXTENSIONS, textAttachment } from "../core/documents/textFile";
import { textOf, type ContentPart } from "../core/llm/openaiChat";
import { closeNames, sameNameWrittenDifferently } from "../core/attachments";
import { pageNumbers } from "../core/pageNumbers";
import { PathError, safeResolve, within } from "../core/paths";
import { AUDIO_EXTENSIONS, isAudioFile, recordingAnswer, VIDEO_EXTENSIONS } from "../core/recordings";
import { defineTool, type Tool } from "../core/tools/tool";
import { nodeMedia, type AudioSettings } from "./media";
import { obsidianVault } from "./obsidianVault";

const IMAGE_MIME: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", bmp: "image/bmp",
  tiff: "image/tiff", tif: "image/tiff",
};
/** What a recording or video answers while the audio programs wait for this device's approval (#136). */
const PROGRAMS_NOT_APPROVED = "Error: the audio programs set in Settings → Hiro Agent → Features → Audio "
  + "transcription are not approved on this device (they may have come from another device's settings), so "
  + "nothing was run. Tell the user to check them there and approve them.";

/** 150 dpi balances legibility against the tokens a page costs (Python's _RENDER_DPI). */
const RENDER_DPI = 150;
/** Characters of text per page, on average, above which a PDF is read as text when as_text is not given (#246) */
export const TEXT_PER_PAGE = 200;

/** as_text as the model gave it: true, false, or null when it left it out and the PDF decides (#246) */
function asTextOf(args: Record<string, unknown>): boolean | null {
  const value = args.as_text;
  return value === undefined || value === null ? null : Boolean(value);
}

export function makeAttachmentTools(app: App, scope: string[] | null, audio: AudioSettings): Tool[] {
  const adapter = app.vault.adapter;
  // Programs need file paths; a vault that is not on disk (mobile) has recordings the agent cannot hear
  const media = adapter instanceof FileSystemAdapter ? nodeMedia(audio, (path) => adapter.getFullPath(path)) : null;
  const vault = obsidianVault(app);

  const scoped = scope && scope.length ? scope.map((s) => s.replace(/\/+$/, "")) : null;
  const inScope = (path: string): boolean => !scoped || scoped.some((root) => within(path, root));

  const find = (path: string): { file: TFile | null; error: string; note?: string } => {
    let resolved: string;
    try {
      resolved = safeResolve(path, scope);
    } catch (error) {
      if (error instanceof PathError) return { file: null, error: `Error: ${error.message}` };
      throw error;
    }
    const direct = app.vault.getAbstractFileByPath(resolved);
    if (direct instanceof TFile) return { file: direct, error: "" };
    const inFolder = path.includes("/") || path.includes("\\");
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

  const image = async (file: TFile, shown: string): Promise<ContentPart[] | string> => {
    try {
      const data = arrayBufferToBase64(await app.vault.readBinary(file));
      const mime = IMAGE_MIME[file.extension.toLowerCase()] ?? "image/jpeg";
      return [{ type: "text", text: `Image '${shown}':` }, { type: "image_url", image_url: { url: `data:${mime};base64,${data}` } }];
    } catch (error) {
      return `Error: could not read image: ${error instanceof Error ? error.message : String(error)}`;
    }
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
          const content = await (await document.getPage(number)).getTextContent();
          const items = content.items as { str?: string; hasEOL?: boolean }[];
          const text = items.map((item) => (item.str ?? "") + (item.hasEOL ? "\n" : "")).join("").trim();
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
        const canvas = window.document.createElement("canvas");
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
        parts.push({ type: "text", text: `Page ${number}/${pages}:` },
                   { type: "image_url", image_url: { url: canvas.toDataURL("image/png") } });
      }
      await document.destroy?.();
      return parts;
    } catch (error) {
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

  const read = async (path: string, pages = "", asText: boolean | null = null): Promise<ContentPart[] | string> => {
    const { file, error, note } = find(path);
    if (!file) return error;
    // Found under another name: the answer uses the real one, so the next call does too
    const answer = await readFile(file, note ? file.path : path, pages, asText);
    if (!note) return answer;
    return typeof answer === "string" ? `${note}\n\n${answer}` : [{ type: "text", text: note }, ...answer];
  };

  const readFile = async (file: TFile, path: string, pages: string, asText: boolean | null): Promise<ContentPart[] | string> => {
    const extension = file.extension.toLowerCase();
    const programs = audio.approved ? media : null;
    if (AUDIO_EXTENSIONS.includes(extension) || (extension === "webm" && programs && (await isAudioFile(file.path, programs)))) {
      if (!audio.approved) return PROGRAMS_NOT_APPROVED;
      if (!media) return "Error: recordings can be transcribed only where the vault is on disk (desktop)";
      return recordingAnswer(vault, file.path, media, audio.enabled, scope);
    }
    if (VIDEO_EXTENSIONS.includes(extension)) return video(file, path);
    if (extension === "pdf") return pdf(file, path, pages, asText);
    if (IMAGE_MIME[extension]) return image(file, path);
    // Data exports, logs, configuration: as text (#210)
    if (TEXT_EXTENSIONS.includes(extension)) return textAttachment(path, await app.vault.cachedRead(file));
    // A canvas: its cards, groups and arrows, read only (#214)
    if (extension === "canvas") return canvasToMarkdown(path, await app.vault.cachedRead(file));
    // Office documents as text; pages picks sheets or slides (#211)
    if (DOCUMENT_EXTENSIONS.includes(extension)) {
      return readDocument(extension, new Uint8Array(await app.vault.readBinary(file)), path, pages);
    }
    // A note is not an attachment: say which tool reads it, not that its type is unsupported (2026-10-05)
    if (extension === "md") return `Error: '${file.path}' is a note, not an attachment; read it with read_note`;
    return `Error: unsupported attachment type '.${extension}'. Supported: pdf, images (png/jpg/gif/webp/bmp/tiff), `
           + "video (mp4/webm/avi/mov/mkv), audio (m4a/mp3/wav/ogg/opus/flac/aac), Office documents (docx/xlsx/pptx), "
           + "OpenDocument (odt/ods/odp), EPUB books, canvases, "
           + `text files (${TEXT_EXTENSIONS.join("/")})`;
  };

  const readAttachment = defineTool(
    "read_attachment", async (args) => textOf(await read(args.str("path"), args.str("pages"), asTextOf(args))),
    { content: (args) => read(args.str("path"), args.str("pages"), asTextOf(args)) });
  return [readAttachment];
}
