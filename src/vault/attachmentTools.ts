/**
 * read_attachment — ported from make_attachment_tools (src/obsidian_agent/tools/builtin/attachment.py) (#84): the
 * model is given an image, each PDF page rendered as one through Obsidian's own PDF.js, a recording's transcript
 * (whisper.cpp, cached below its embeds — core/recordings.ts), and a video's frames with the transcript of its sound.
 *
 * Difference from Python, on purpose: a bare file name is found the way Obsidian resolves an attachment link, and
 * only inside the agent's folders (Python searched the whole vault, past the scope).
 */

import { arrayBufferToBase64, FileSystemAdapter, loadPdfJs, TFile, type App } from "obsidian";

import { textOf, type ContentPart } from "../core/llm/openaiChat";
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

export function makeAttachmentTools(app: App, scope: string[] | null, audio: AudioSettings): Tool[] {
  const adapter = app.vault.adapter;
  // Programs need file paths; a vault that is not on disk (mobile) has recordings the agent cannot hear
  const media = adapter instanceof FileSystemAdapter ? nodeMedia(audio, (path) => adapter.getFullPath(path)) : null;
  const vault = obsidianVault(app);

  const scoped = scope && scope.length ? scope.map((s) => s.replace(/\/+$/, "")) : null;
  const inScope = (path: string): boolean => !scoped || scoped.some((root) => within(path, root));

  const find = (path: string): { file: TFile | null; error: string } => {
    let resolved: string;
    try {
      resolved = safeResolve(path, scope);
    } catch (error) {
      if (error instanceof PathError) return { file: null, error: `Error: ${error.message}` };
      throw error;
    }
    const direct = app.vault.getAbstractFileByPath(resolved);
    if (direct instanceof TFile) return { file: direct, error: "" };
    if (path.includes("/") || path.includes("\\")) return { file: null, error: `Error: attachment not found at '${path}'` };
    // A bare file name, as notes embed it: resolved the way Obsidian resolves ![[photo.jpg]]
    const linked = app.metadataCache.getFirstLinkpathDest(path, "");
    const file = linked && inScope(linked.path) ? linked
      : app.vault.getFiles().find((f) => f.name === path && inScope(f.path)) ?? null;
    return file ? { file, error: "" } : { file: null, error: `Error: attachment '${path}' not found anywhere in the vault` };
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

  const pdf = async (file: TFile, shown: string): Promise<ContentPart[] | string> => {
    try {
      const pdfjs = await loadPdfJs();
      const document = await pdfjs.getDocument({ data: new Uint8Array(await app.vault.readBinary(file)) }).promise;
      const pages: number = document.numPages;
      if (!pages) return "Error: PDF has no pages";
      const parts: ContentPart[] = [{ type: "text", text: `PDF '${shown}' — ${pages} page(s):` }];
      for (let number = 1; number <= pages; number++) {
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

  const read = async (path: string): Promise<ContentPart[] | string> => {
    const { file, error } = find(path);
    if (!file) return error;
    const extension = file.extension.toLowerCase();
    const programs = audio.approved ? media : null;
    if (AUDIO_EXTENSIONS.includes(extension) || (extension === "webm" && programs && (await isAudioFile(file.path, programs)))) {
      if (!audio.approved) return PROGRAMS_NOT_APPROVED;
      if (!media) return "Error: recordings can be transcribed only where the vault is on disk (desktop)";
      return recordingAnswer(vault, file.path, media, audio.enabled, scope);
    }
    if (VIDEO_EXTENSIONS.includes(extension)) return video(file, path);
    if (extension === "pdf") return pdf(file, path);
    if (IMAGE_MIME[extension]) return image(file, path);
    return `Error: unsupported attachment type '.${extension}'. Supported: pdf, images (png/jpg/gif/webp/bmp/tiff), `
           + "video (mp4/webm/avi/mov/mkv), audio (m4a/mp3/wav/ogg/opus/flac/aac)";
  };

  const readAttachment = defineTool("read_attachment", async (args) => textOf(await read(args.str("path"))),
                                    { content: (args) => read(args.str("path")) });
  return [readAttachment];
}
