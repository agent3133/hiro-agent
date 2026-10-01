/**
 * ffprobe, ffmpeg and whisper-cli as child processes, for read_attachment's recordings and videos (#84) — ported
 * from src/obsidian_agent/audio/programs.py and transcription.py. Desktop only.
 *
 * Every child gets stdin closed ("ignore"): whisper-cli inherited a pipe once and hung the runtime (#65).
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import { programEnv } from "../core/programPath";
import { parseWhisperJson, TranscriptionError, type Media, type Transcript } from "../core/recordings";

export interface AudioSettings {
  enabled: boolean;
  whisperCli: string;
  ffmpeg: string;
  model: string | null;
  language: string;
  useGpu: boolean;
  threads: number | null;
  timeoutFactor: number;
  extraArgs: string[];
  /**
   * Whether this device approved the programs as set (#136): false when they came from another device's settings
   * and nobody here said yes; they do not run then.
   */
  approved: boolean;
}

export const DEFAULT_AUDIO: AudioSettings = {
  enabled: false, whisperCli: "whisper-cli", ffmpeg: "ffmpeg", model: null, language: "auto", useGpu: false,
  threads: null, timeoutFactor: 3, extraArgs: [], approved: true,
};

/** Frames sampled from a video at most (Python's _VIDEO_MAX_FRAMES). */
const VIDEO_MAX_FRAMES = 16;

interface Run { code: number; stdout: string; stderr: string; missing: boolean }

function run(program: string, args: string[], timeoutMs: number): Promise<Run> {
  return new Promise((resolve) => {
    const child = execFile(program, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 64 * 1024 * 1024,
                                            encoding: "utf8", env: programEnv(process.env, process.platform) }, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr), missing: (error as { code?: unknown })?.code === "ENOENT" });
    });
    child.stdin?.end();
  });
}

/** ffprobe beside a configured ffmpeg path, or the one on PATH when ffmpeg is a bare name — `programs.ffprobe`. */
export function ffprobeFor(ffmpeg: string): string {
  const configured = ffmpeg.trim() || "ffmpeg";
  if (!/[\\/]/.test(configured)) return "ffprobe";
  return join(dirname(configured), basename(configured).replace(/ffmpeg/i, "ffprobe"));
}

/**
 * The media programs for a vault on disk. *fullPath* turns a vault path into a file path for the programs.
 */
export function nodeMedia(settings: AudioSettings, fullPath: (path: string) => string): Media & {
  frames(path: string): Promise<{ fps: number; frames: string[] } | string>;
} {
  const ffmpeg = settings.ffmpeg.trim() || "ffmpeg";
  const ffprobe = ffprobeFor(ffmpeg);

  const probe = async (path: string, args: string[]): Promise<string | null> => {
    const result = await run(ffprobe, ["-v", "error", ...args, fullPath(path)], 60_000);
    return result.code === 0 ? result.stdout.trim() : null;
  };
  const duration = async (file: string): Promise<number | null> => {
    const result = await run(ffprobe, ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file], 60_000);
    const value = Number(result.stdout.trim());
    return result.code === 0 && Number.isFinite(value) && value > 0 ? value : null;
  };

  return {
    async hash(path) {
      return createHash("sha256").update(await readFile(fullPath(path))).digest("hex").slice(0, 16);
    },
    async hasVideo(path) {
      const output = await probe(path, ["-select_streams", "v", "-show_entries", "stream=codec_type", "-of", "csv=p=0"]);
      return output === null ? true : Boolean(output);  // without ffprobe, keep treating .webm as video
    },
    async hasAudio(path) {
      return Boolean(await probe(path, ["-select_streams", "a", "-show_entries", "stream=codec_type", "-of", "csv=p=0"]));
    },

    async transcribe(paths) {
      const model = settings.model?.trim();
      if (!model || !existsSync(model)) {
        throw new TranscriptionError(`whisper model not found: ${settings.model ?? "None"} (set it under Settings → Hiro Agent → Features → Audio transcription)`);
      }
      const folder = await mkdtemp(join(tmpdir(), "obsidian-agent-audio-"));
      try {
        const wavs: string[] = [];
        let total = 0;
        for (const [index, path] of paths.entries()) {
          const wav = join(folder, `${index}.wav`);
          const converted = await run(ffmpeg, ["-y", "-loglevel", "error", "-i", fullPath(path), "-vn", "-ar", "16000",
                                               "-ac", "1", "-c:a", "pcm_s16le", wav], 600_000);
          if (converted.missing) {
            throw new TranscriptionError("ffmpeg is required for audio transcription but was not found — set its path "
                                         + "under audio.ffmpeg, or put it on PATH");
          }
          if (converted.code !== 0) {
            throw new TranscriptionError(`ffmpeg could not convert ${basename(path)}: ${converted.stderr.trim().slice(-300)}`);
          }
          wavs.push(wav);
          total += (await duration(wav)) ?? 0;
        }
        const args = ["-m", model, "-l", settings.language, "-oj", "-np"];
        if (!settings.useGpu) args.push("-ng");
        if (settings.threads) args.push("-t", String(settings.threads));
        args.push(...settings.extraArgs.map(String));
        for (const wav of wavs) args.push("-f", wav);
        const timeout = Math.max(600, total * settings.timeoutFactor);
        const result = await run(settings.whisperCli, args, timeout * 1000);
        if (result.missing) throw new TranscriptionError(`whisper-cli not found: ${settings.whisperCli} (set audio.whisper_cli)`);
        if (result.code !== 0) {
          const detail = (result.stderr || result.stdout).trim().split(/\r?\n/).slice(-5).join(" ");
          throw new TranscriptionError(`whisper-cli failed (exit ${result.code}): ${detail}`);
        }
        const transcripts = new Map<string, Transcript>();
        for (const [index, path] of paths.entries()) {
          const wav = wavs[index];
          const output = [`${wav}.json`, wav.replace(/\.wav$/, ".json")].find((p) => existsSync(p));
          if (!output) throw new TranscriptionError(`whisper-cli wrote no JSON output for ${basename(path)}`);
          const data = JSON.parse(await readFile(output, "utf-8")) as Record<string, unknown>;
          transcripts.set(path, parseWhisperJson(data, basename(path), await this.hash(path), basename(model),
                                                 await duration(wav)));
        }
        return transcripts;
      } finally {
        await rm(folder, { recursive: true, force: true });
      }
    },

    /** Evenly spaced frames as PNG data URLs, at most VIDEO_MAX_FRAMES — `_video_to_block`; or the error. */
    async frames(path) {
      const probed = await run(ffprobe, ["-v", "quiet", "-print_format", "json", "-show_streams", "-select_streams", "v:0",
                                         fullPath(path)], 60_000);
      let seconds = 0;
      try {
        seconds = Number((JSON.parse(probed.stdout) as { streams?: { duration?: string }[] }).streams?.[0]?.duration ?? 0) || 0;
      } catch {
        seconds = 0;
      }
      const fps = seconds > 0 ? Math.min(1, VIDEO_MAX_FRAMES / seconds) : 1;
      const folder = await mkdtemp(join(tmpdir(), "obsidian-agent-frames-"));
      try {
        const result = await run(ffmpeg, ["-i", fullPath(path), "-vf", `fps=${fps}`, "-frames:v", String(VIDEO_MAX_FRAMES),
                                          "-f", "image2", join(folder, "frame_%04d.png"), "-y", "-loglevel", "error"], 600_000);
        if (result.missing) {
          return "Error: could not extract video frames — ffmpeg is required but not available. "
                 + "Install ffmpeg and ensure it is on PATH.";
        }
        if (result.code !== 0) return `Error: ffmpeg failed to extract frames from '${path}': ${result.stderr.trim()}`;
        const files = (await readdir(folder)).filter((f) => /^frame_\d+\.png$/.test(f)).sort();
        if (!files.length) return `Error: ffmpeg produced no frames from '${path}'`;
        const frames: string[] = [];
        for (const file of files) frames.push(`data:image/png;base64,${(await readFile(join(folder, file))).toString("base64")}`);
        return { fps, frames };
      } finally {
        await rm(folder, { recursive: true, force: true });
      }
    },
  };
}
