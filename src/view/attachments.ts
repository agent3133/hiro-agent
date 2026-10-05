/**
 * Files added to a message (#190): which ones the agent can read, how large they may be, and how the message names
 * them. No Obsidian in here, so it can be tested under Node. The files themselves are saved to the vault's
 * attachment location when the message is sent, and the agent reads them with read_attachment.
 */

import { DOCUMENT_EXTENSIONS } from "../core/documents";
import { TEXT_EXTENSIONS } from "../core/documents/textFile";
import { AUDIO_EXTENSIONS, VIDEO_EXTENSIONS } from "../core/recordings";

export type AttachmentKind = "image" | "pdf" | "audio" | "video" | "document";

/** Office documents and text files, which read_attachment reads as text (#210, #211); not the old binary formats. */
export const READABLE_DOCUMENTS = [...DOCUMENT_EXTENSIONS.filter((ext) => !["doc", "xls", "ppt"].includes(ext)),
                                   ...TEXT_EXTENSIONS];

/** What read_attachment reads as an image. */
export const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "webp", "bmp", "tiff", "tif"];

/** The largest file of each kind, in MB: a video is sampled and transcribed, so a longer one adds time, not much else. */
export const LIMITS_MB: Record<AttachmentKind, number> = { image: 20, pdf: 50, audio: 100, video: 100, document: 50 };

const KIND_NAMES: Record<AttachmentKind, string> = { image: "an image", pdf: "a PDF", audio: "a recording", video: "a video",
                                                     document: "a document" };

/** For the file picker: every extension the agent can read. */
export const ACCEPT = [...IMAGE_EXTENSIONS, "pdf", ...AUDIO_EXTENSIONS, ...VIDEO_EXTENSIONS, ...READABLE_DOCUMENTS]
  .map((ext) => `.${ext}`).join(",");

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/** The kind of file *name* is, by its extension; null for one the agent cannot read. A .webm counts as a video. */
export function kindOf(name: string): AttachmentKind | null {
  const extension = extensionOf(name);
  if (IMAGE_EXTENSIONS.includes(extension)) return "image";
  if (extension === "pdf") return "pdf";
  if (VIDEO_EXTENSIONS.includes(extension)) return "video";
  if (AUDIO_EXTENSIONS.includes(extension)) return "audio";
  if (READABLE_DOCUMENTS.includes(extension)) return "document";
  return null;
}

/** 1234567 → "1.2 MB", 2048 → "2 KB". */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1).replace(/\.0$/, "")} MB`;
}

/** Whether a file of *name* and *size* bytes can be added, and why not. */
export function checkAttachment(name: string, size: number): { kind: AttachmentKind } | { error: string } {
  const kind = kindOf(name);
  if (!kind) {
    return { error: `${name} can't be added: the agent reads images, PDFs, recordings, videos, Office documents and text files.` };
  }
  const limit = LIMITS_MB[kind];
  if (size > limit * 1024 * 1024) {
    return { error: `${name} is ${formatSize(size)}; ${KIND_NAMES[kind]} may be at most ${limit} MB.` };
  }
  return { kind };
}

/**
 * The message the agent is sent: what was typed, then the files as embeds — so a kept conversation's note shows
 * them — and how to read them.
 */
export function attachmentPrompt(prompt: string, paths: string[]): string {
  if (!paths.length) return prompt;
  const files = paths.map((path) => `- ![[${path}]]`).join("\n");
  const ask = paths.length === 1 ? "read it" : "read each one";
  const head = prompt ? `${prompt}\n\n` : "";
  return `${head}Attached (saved in the vault; ${ask} with read_attachment):\n${files}`;
}
