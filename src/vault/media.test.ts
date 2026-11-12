// The media programs for read_attachment (#84, #420): ffprobe beside ffmpeg, and what a missing whisper-cli answers.
// Node stands in for every program here; whisper and ffmpeg never run.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { TranscriptionError } from "../core/recordings";

import { DEFAULT_AUDIO, ffprobeFor, nodeMedia, type AudioSettings } from "./media";

let folder: string;

beforeEach(async () => {
  folder = await mkdtemp(join(tmpdir(), "media-420-"));
});

afterEach(async () => {
  await rm(folder, { recursive: true, force: true });
});

function settings(overrides: Partial<AudioSettings> = {}): AudioSettings {
  return { ...DEFAULT_AUDIO, enabled: true, ...overrides };
}

describe("ffprobeFor", () => {
  it("gives the ffprobe beside a Windows ffmpeg.exe path", () => {
    expect(ffprobeFor("C:\\tools\\ffmpeg\\bin\\ffmpeg.exe")).toBe("C:\\tools\\ffmpeg\\bin\\ffprobe.exe");
  });

  it("gives the ffprobe beside a POSIX ffmpeg path", () => {
    expect(ffprobeFor("/usr/local/bin/ffmpeg")).toBe("/usr/local/bin/ffprobe");
  });

  it("keeps a folder named ffmpeg and changes only the program's name (#426)", () => {
    expect(ffprobeFor("/opt/ffmpeg/bin/ffmpeg")).toBe("/opt/ffmpeg/bin/ffprobe");
  });

  it("gives plain ffprobe for a bare ffmpeg, to be found on PATH", () => {
    expect(ffprobeFor("ffmpeg")).toBe("ffprobe");
  });
});

describe("nodeMedia", () => {
  it("answers an error naming the whisper setting to fix when whisper-cli is not there", async () => {
    const model = join(folder, "ggml-base.bin");
    await writeFile(model, "not a real model; whisper never reads it here");
    const media = nodeMedia(settings({ model, whisperCli: join(folder, "no-such-whisper-cli-420") }),
                            (path) => join(folder, path));

    // No recording is converted first, so ffmpeg is never started: the whisper run is the first program to fail
    const outcome = await media.transcribe([]).then(() => null, (error: unknown) => error);
    expect(outcome).toBeInstanceOf(TranscriptionError);
    const message = (outcome as Error).message;
    expect(message).toContain("whisper-cli not found");
    expect(message).toContain("Settings → Hiro Agent → Features → Audio transcription");
    expect(message).toContain("set the whisper.cpp program");
  });
});
