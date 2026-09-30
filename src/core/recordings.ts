/**
 * Recordings transcribed with whisper.cpp, and the transcripts cached next to the recording's embeds — ported from
 * src/obsidian_agent/audio/transcription.py (#84). A transcript is stored in every note that embeds the recording,
 * directly below the embed:
 *
 *     ![[Recording 20260914101500.webm]]
 *     > [!transcript]- Transcript: Recording 20260914101500.webm (3:42, de)
 *     > %% obsidian-agent-transcript audio="Recording 20260914101500.webm" sha="0123456789abcdef" ... %%
 *     > [00:00] Hello everyone ...
 *
 * The hidden marker carries a hash of the recording, so a transcript is reused until the recording changes. A
 * recording no note embeds gets a `<recording>.transcript.md` note next to it instead.
 *
 * This module is the text and the vault; running ffprobe, ffmpeg and whisper-cli is the `Media` it is given
 * (plugin/src/vault/media.ts in Obsidian, a stand-in in the tests).
 */

import { basename, within } from "./paths";
import { vaultNotes, type VaultPort } from "./vault";

export const MARKER = "obsidian-agent-transcript";
export const AUDIO_EXTENSIONS = ["m4a", "mp3", "wav", "ogg", "opus", "flac", "aac", "3gp"];
export const VIDEO_EXTENSIONS = ["mp4", "webm", "avi", "mov", "mkv"];

export class TranscriptionError extends Error {}

export interface Segment { startMs: number; text: string }

export interface Transcript {
  audioName: string;
  sha: string;
  model: string;
  language: string | null;
  durationS: number | null;
  segments: Segment[];
}

/** What running programs gives: a recording's hash and streams, and whisper.cpp's transcripts. */
export interface Media {
  /** The first 16 hex digits of the file's SHA-256 — `file_hash`. */
  hash(path: string): Promise<string>;
  hasVideo(path: string): Promise<boolean>;
  hasAudio(path: string): Promise<boolean>;
  /** One whisper-cli run for all of *paths*; throws TranscriptionError. */
  transcribe(paths: string[]): Promise<Map<string, Transcript>>;
}

export function transcriptText(transcript: Transcript): string {
  return transcript.segments.map((s) => `[${formatTimestamp(s.startMs)}] ${s.text}`).join("\n");
}

export function formatTimestamp(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  const pad = (n: number): string => String(n).padStart(2, "0");
  return hours ? `${hours}:${pad(minutes)}:${pad(secs)}` : `${pad(minutes)}:${pad(secs)}`;
}

export function parseTimestamp(value: string): number {
  return value.split(":").reduce((seconds, part) => seconds * 60 + Number(part), 0) * 1000;
}

/** whisper-cli's `-oj` output as a transcript — `parse_whisper_json`. */
export function parseWhisperJson(data: Record<string, unknown>, audioName: string, sha: string, model: string,
                                 durationS: number | null): Transcript {
  const items = Array.isArray(data.transcription) ? data.transcription as Record<string, unknown>[] : [];
  const segments: Segment[] = [];
  for (const item of items) {
    const text = String(item.text ?? "").split(/\s+/).filter(Boolean).join(" ");
    const offsets = (item.offsets ?? {}) as Record<string, unknown>;
    if (text) segments.push({ startMs: Math.trunc(Number(offsets.from ?? 0)), text });
  }
  const language = (data.result as Record<string, unknown> | undefined)?.language;
  return { audioName, sha, model, language: typeof language === "string" ? language : null, durationS, segments };
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Python's `urllib.parse.quote`: what a Markdown embed writes for a name with spaces. */
function quote(text: string): string {
  return encodeURIComponent(text).replace(/%2F/gi, "/").replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** Embeds of the recording: `![[name]]`, `![[folder/name|300]]`, `![](folder/name%20with%20spaces)` — `_embed_pattern`. */
export function embedPattern(audioName: string): RegExp {
  const names = [...new Set([escapeRegExp(audioName), escapeRegExp(quote(audioName))])].sort();
  const name = `(?:${names.join("|")})`;
  const wikilink = String.raw`!\[\[(?:[^\]|#]*/)?` + name + String.raw`(?:[|#][^\]]*)?\]\]`;
  const markdown = String.raw`!\[[^\]]*\]\((?:[^)]*/)?<?` + name + String.raw`>?\)`;
  return new RegExp(`${wikilink}|${markdown}`);
}

export function renderBlock(transcript: Transcript): string[] {
  const details = [transcript.durationS ? formatTimestamp(Math.trunc(transcript.durationS * 1000)) : null,
                   transcript.language].filter(Boolean);
  const suffix = details.length ? ` (${details.join(", ")})` : "";
  const name = transcript.audioName.replace(/"/g, "'");
  let attrs = `audio="${name}" sha="${transcript.sha}" model="${transcript.model}"`;
  if (transcript.language) attrs += ` language="${transcript.language}"`;
  if (transcript.durationS) attrs += ` duration="${transcript.durationS.toFixed(1)}"`;
  const lines = [`> [!transcript]- Transcript: ${transcript.audioName}${suffix}`, `> %% ${MARKER} ${attrs} %%`];
  const body = transcript.segments.map((s) => `> [${formatTimestamp(s.startMs)}] ${s.text}`);
  return [...lines, ...(body.length ? body : ["> (no speech detected)"])];
}

const MARKER_LINE = new RegExp(String.raw`^>\s*%%\s*` + MARKER + String.raw`\s+(.*?)\s*%%\s*$`);
const SEGMENT_LINE = /^>\s*\[(\d+(?::\d{2}){1,2})\]\s?(.*)$/;

function attributes(text: string): Record<string, string> {
  return Object.fromEntries([...text.matchAll(/(\w+)="([^"]*)"/g)].map((m) => [m[1], m[2]]));
}

/** The end of the transcript callout for *audioName* starting at *index*, and its marker's attributes — `_block_at`. */
function blockAt(lines: string[], index: number, audioName: string): { end: number; attrs: Record<string, string> } | null {
  if (index + 1 >= lines.length || !lines[index].trimStart().startsWith("> [!transcript]")) return null;
  const marker = MARKER_LINE.exec(lines[index + 1].trim());
  if (!marker) return null;
  const attrs = attributes(marker[1]);
  if (attrs.audio !== audioName.replace(/"/g, "'")) return null;
  let end = index + 2;
  while (end < lines.length && lines[end].startsWith(">")) end += 1;
  return { end, attrs };
}

/** *text* with the transcript callout inserted or refreshed below every embed of the recording — `upsert_transcript`. */
export function upsertTranscript(text: string, transcript: Transcript): { text: string; changed: boolean } {
  const pattern = embedPattern(transcript.audioName);
  const lines = text.split("\n");
  const block = renderBlock(transcript);
  const out: string[] = [];
  let changed = false;
  let i = 0;
  while (i < lines.length) {
    out.push(lines[i]);
    if (pattern.test(lines[i])) {
      const existing = blockAt(lines, i + 1, transcript.audioName);
      if (existing && existing.attrs.sha === transcript.sha) {
        out.push(...lines.slice(i + 1, existing.end));
        i = existing.end;
        continue;
      }
      out.push(...block);
      changed = true;
      i = existing ? existing.end : i + 1;
      continue;
    }
    i += 1;
  }
  return { text: out.join("\n"), changed };
}

export function parseTranscripts(text: string): Transcript[] {
  const lines = text.split("\n");
  const found: Transcript[] = [];
  lines.forEach((line, index) => {
    const marker = MARKER_LINE.exec(line.trim());
    if (!marker || index === 0 || !lines[index - 1].trimStart().startsWith("> [!transcript]")) return;
    const attrs = attributes(marker[1]);
    const segments: Segment[] = [];
    for (const body of lines.slice(index + 1)) {
      if (!body.startsWith(">")) break;
      const match = SEGMENT_LINE.exec(body);
      if (match) segments.push({ startMs: parseTimestamp(match[1]), text: match[2] });
    }
    found.push({ audioName: attrs.audio ?? "", sha: attrs.sha ?? "", model: attrs.model ?? "",
                 language: attrs.language ?? null, durationS: attrs.duration ? Number(attrs.duration) : null, segments });
  });
  return found;
}

export function sidecarPath(audioPath: string): string {
  return `${audioPath}.transcript.md`;
}

/** Notes (outside dot folders) that embed the recording — `find_embedding_notes`. */
export async function findEmbeddingNotes(vault: VaultPort, audioName: string): Promise<string[]> {
  const pattern = embedPattern(audioName);
  const found: string[] = [];
  for (const note of await vaultNotes(vault)) if (pattern.test(await vault.read(note))) found.push(note);
  return found.sort();
}

export async function findCached(vault: VaultPort, audioName: string, sha: string): Promise<Transcript | null> {
  for (const note of (await vault.files()).filter((f) => f.endsWith(".md"))) {
    const text = await vault.read(note);
    if (!text.includes(MARKER)) continue;
    for (const transcript of parseTranscripts(text)) {
      if (transcript.audioName === audioName.replace(/"/g, "'") && transcript.sha === sha) return transcript;
    }
  }
  return null;
}

/** Below the recording's embeds in the notes it may write, or in a sidecar note — `save_transcript`. */
export async function saveTranscript(vault: VaultPort, audioPath: string, transcript: Transcript,
                                     canWrite: (path: string) => boolean = () => true): Promise<string[]> {
  let notes = (await findEmbeddingNotes(vault, basename(audioPath))).filter(canWrite);
  if (!notes.length) {
    const sidecar = sidecarPath(audioPath);
    if (!canWrite(sidecar)) return [];
    if (!(await vault.isFile(sidecar))) await vault.write(sidecar, `![[${basename(audioPath)}]]\n`);
    notes = [sidecar];
  }
  for (const note of notes) {
    const { text, changed } = upsertTranscript(await vault.read(note), transcript);
    if (changed) await vault.write(note, text);
  }
  return notes;
}

export async function transcribeRecording(vault: VaultPort, audioPath: string, media: Media,
                                          canWrite: (path: string) => boolean = () => true):
    Promise<{ transcript: Transcript; cached: boolean; notes: string[] }> {
  const sha = await media.hash(audioPath);
  const cached = await findCached(vault, basename(audioPath), sha);
  if (cached) return { transcript: cached, cached: true, notes: await saveTranscript(vault, audioPath, cached, canWrite) };
  const transcript = (await media.transcribe([audioPath])).get(audioPath);
  if (!transcript) throw new TranscriptionError(`whisper-cli wrote no transcript for ${basename(audioPath)}`);
  return { transcript, cached: false, notes: await saveTranscript(vault, audioPath, transcript, canWrite) };
}

/** Whether read_attachment hears this file: an audio format, or a .webm without a picture (Obsidian's recorder). */
export async function isAudioFile(path: string, media: Media): Promise<boolean> {
  const extension = path.split(".").pop()?.toLowerCase() ?? "";
  return AUDIO_EXTENSIONS.includes(extension) || (extension === "webm" && !(await media.hasVideo(path)));
}

/**
 * read_attachment's answer for a recording — `_audio_to_text` (attachment.py): the transcript, where it was saved,
 * or why it could not be made. *scope* limits the notes the transcript may be written into.
 */
export async function recordingAnswer(vault: VaultPort, audioPath: string, media: Media, enabled: boolean,
                                      scope: string[] | null = null): Promise<string> {
  const name = basename(audioPath);
  if (!enabled) {
    return `Error: '${name}' is an audio recording, but audio transcription is disabled. `
           + "Switch on Settings → Hiro Agent → Features → Audio transcription and set its model.";
  }
  const roots = scope && scope.length ? scope.map((s) => s.replace(/\/+$/, "")) : null;
  const canWrite = (note: string): boolean => !roots || roots.some((root) => within(note, root));
  let result: Awaited<ReturnType<typeof transcribeRecording>>;
  try {
    result = await transcribeRecording(vault, audioPath, media, canWrite);
  } catch (error) {
    if (error instanceof TranscriptionError) return `Error: could not transcribe '${name}': ${error.message}`;
    throw error;
  }
  const where = result.notes.join(", ") || "not saved (outside vault_scope)";
  const details = [result.transcript.language, result.cached ? "from cache" : "new transcription"].filter(Boolean).join(", ");
  return `Transcript of '${name}' (${details}; saved in ${where}):\n${transcriptText(result.transcript) || "(no speech detected)"}`;
}
