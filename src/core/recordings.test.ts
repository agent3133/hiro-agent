// Ported from tests/test_audio_transcription.py — transcripts, their callouts in notes, and the cache (#84).
// Where Python calls read_attachment on a recording, the port calls recordingAnswer, which is what the plugin's
// read_attachment answers for one; FakeMedia stands in for ffprobe, ffmpeg and whisper-cli, as in Python.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { basename } from "./paths";
import {
  embedPattern, isAudioFile, parseTranscripts, parseWhisperJson, recordingAnswer, renderBlock, sidecarPath,
  transcriptText, TranscriptionError, type Media, type Transcript,
} from "./recordings";
import { makeVault, type TestVault } from "./testing/vault";

/** Stands in for ffprobe and whisper-cli: every recording says the same two German sentences, 42 s long. */
class FakeMedia implements Media {
  whisperCalls: string[][] = [];

  constructor(private readonly root: string, private readonly options: { videoFiles?: string[]; silentFiles?: string[];
                                                                        failWhisper?: boolean } = {}) {}

  async hash(path: string): Promise<string> {
    return createHash("sha256").update(readFileSync(join(this.root, path))).digest("hex").slice(0, 16);
  }

  async hasVideo(path: string): Promise<boolean> {
    return (this.options.videoFiles ?? []).includes(basename(path));
  }

  async hasAudio(path: string): Promise<boolean> {
    return !(this.options.silentFiles ?? []).includes(basename(path));
  }

  async transcribe(paths: string[]): Promise<Map<string, Transcript>> {
    this.whisperCalls.push(paths);
    if (this.options.failWhisper) throw new TranscriptionError("whisper-cli failed (exit 1): error: failed to load model");
    const transcripts = new Map<string, Transcript>();
    for (const [index, path] of paths.entries()) {
      transcripts.set(path, parseWhisperJson({
        result: { language: "de" },
        transcription: [{ offsets: { from: 0, to: 4000 }, text: ` Memo ${index + 1} beginnt hier.` },
                        { offsets: { from: 65000, to: 70000 }, text: " Nächster Punkt: Budget." }],
      }, basename(path), await this.hash(path), "ggml-large-v3-turbo-q5_0.bin", 42.0));
    }
    return transcripts;
  }
}

const MEMO = "Recording 20260914101500.m4a";

/** The Python `audio_env` fixture with `_memo`: a vault with the recording in Attachments/, plus *notes*. */
async function audioEnv(notes: Record<string, string> = {}, content = "audio-v1"): Promise<{ vault: TestVault; media: FakeMedia }> {
  const vault = await makeVault({ [`Attachments/${MEMO}`]: content, ...notes });
  await vault.folder("Meetings");
  return { vault, media: new FakeMedia(vault.root) };
}

describe("test_audio_transcription.py", () => {
  it("test_whisper_json_to_timestamped_text", () => {
    const transcript = parseWhisperJson({ result: { language: "en" }, transcription: [
      { offsets: { from: 3_725_000 }, text: "  late   remark " }, { offsets: { from: 0 }, text: " " }] },
    "a.m4a", "abc", "model.bin", 3800.0);
    expect(transcript.language).toBe("en");
    expect(transcriptText(transcript)).toBe("[1:02:05] late remark");
  });

  it("test_transcript_is_appended_below_embed_in_any_note", async () => {
    const { vault, media } = await audioEnv({ "Meetings/Kickoff.md": `# Kickoff\n\n![[${MEMO}]]\n\n## Next steps\n` });
    const result = await recordingAnswer(vault.vault, `Attachments/${MEMO}`, media, true);
    expect(result).toContain("[00:00] Memo 1 beginnt hier.");
    expect(result).toContain("[01:05] Nächster Punkt: Budget.");
    expect(result).toContain("new transcription");
    expect(result).toContain("Meetings");
    const lines = (await vault.read("Meetings/Kickoff.md")).split("\n");
    const embed = lines.indexOf(`![[${MEMO}]]`);
    expect(lines[embed + 1].startsWith(`> [!transcript]- Transcript: ${MEMO} (00:42, de)`)).toBe(true);
    expect(lines[embed + 2]).toContain("%% obsidian-agent-transcript");
    expect(lines).toContain("## Next steps");
    // Python also checks that whisper-cli ran with -ng; the arguments are built in plugin/src/vault/media.ts
  });

  it("test_rendered_block_round_trips", () => {
    const transcript: Transcript = {
      audioName: "Memo.m4a",
      sha: "0123456789abcdef",
      model: "m.bin",
      language: "de",
      durationS: 42.0,
      segments: [
        { startMs: 0, text: "Hallo" },
        { startMs: 65000, text: "Budget" },
      ],
    };
    const parsed = parseTranscripts(["![[Memo.m4a]]", ...renderBlock(transcript)].join("\n"));
    expect(parsed.length).toBe(1);
    expect([parsed[0].sha, parsed[0].language, transcriptText(parsed[0])]).toEqual(["0123456789abcdef", "de", transcriptText(transcript)]);
  });

  it.each([
    "![[Recording 1.webm]]",
    "![[Attachments/Recording 1.webm|300]]",
    "![](Attachments/Recording%201.webm)",
    "Text before ![[Recording 1.webm]] text after",
  ])("test_embed_forms_are_recognised (%s)", (line) => {
    expect(line.search(embedPattern("Recording 1.webm"))).not.toBe(-1);
  });

  it.each([
    "[[Recording 1.webm]]",
    "![[Recording 10.webm]]",
    "![[Other.webm]]",
  ])("test_non_embeds_are_ignored (%s)", (line) => {
    expect(line.search(embedPattern("Recording 1.webm"))).toBe(-1);
  });

  it("test_second_read_uses_cache_without_running_whisper", async () => {
    const { vault, media } = await audioEnv({ "Meetings/Kickoff.md": `![[${MEMO}]]\n` });
    const memo = MEMO;

    await recordingAnswer(vault.vault, `Attachments/${memo}`, media, true);
    const afterFirst = await vault.read("Meetings/Kickoff.md");
    const result = await recordingAnswer(vault.vault, `Attachments/${memo}`, media, true);

    expect(media.whisperCalls.length).toBe(1);
    expect(result).toContain("from cache");
    expect(result).toContain("Memo 1 beginnt hier.");
    expect(await vault.read("Meetings/Kickoff.md")).toBe(afterFirst);
  });

  it("test_changed_recording_replaces_the_old_transcript", async () => {
    const { vault, media } = await audioEnv({ "Meetings/Kickoff.md": `![[${MEMO}]]\nafter\n` });
    const memo = MEMO;
    const notePath = "Meetings/Kickoff.md";

    await recordingAnswer(vault.vault, `Attachments/${memo}`, media, true);

    await vault.write(`Attachments/${memo}`, "audio-v2");
    await recordingAnswer(vault.vault, `Attachments/${memo}`, media, true);

    const text = await vault.read(notePath);
    expect(media.whisperCalls.length).toBe(2);
    expect(text.split("[!transcript]").length - 1).toBe(1);
    expect(text).toContain(await media.hash(`Attachments/${memo}`));
    expect(text.trimEnd().endsWith("after")).toBe(true);
  });

  it("test_unembedded_recording_gets_sidecar_note", async () => {
    const { vault, media } = await audioEnv();
    const memo = MEMO;

    await recordingAnswer(vault.vault, `Attachments/${memo}`, media, true);

    const sidecar = sidecarPath(`Attachments/${memo}`);
    expect(await vault.exists(sidecar)).toBe(true);
    const text = await vault.read(sidecar);
    expect(text.startsWith(`![[${memo}]]\n> [!transcript]-`)).toBe(true);
  });

  it("test_note_outside_vault_scope_is_not_modified", async () => {
    const { vault, media } = await audioEnv({ "Meetings/Kickoff.md": `![[${MEMO}]]\n` });
    const memo = MEMO;

    const result = await recordingAnswer(vault.vault, `Attachments/${memo}`, media, true, ["Attachments"]);

    expect(result).toContain("Memo 1 beginnt hier.");
    const outside = await vault.read("Meetings/Kickoff.md");
    expect(outside).not.toContain("[!transcript]");
    const sidecar = sidecarPath(`Attachments/${memo}`);
    expect(await vault.exists(sidecar)).toBe(true);
  });

  it("test_disabled_audio_returns_actionable_error", async () => {
    const { vault, media } = await audioEnv();
    const memo = MEMO;

    const result = await recordingAnswer(vault.vault, `Attachments/${memo}`, media, false);

    expect(result.startsWith("Error:")).toBe(true);
    // Python named config.yaml's audio.enabled; the plugin names the switch in its settings (#109)
    expect(result).toContain("Features → Audio transcription");
    expect(media.whisperCalls.length).toBe(0);
  });

  it("test_whisper_failure_is_reported", async () => {
    const { vault } = await audioEnv();
    const memo = MEMO;
    const failMedia = new FakeMedia(vault.root, { failWhisper: true });

    const result = await recordingAnswer(vault.vault, `Attachments/${memo}`, failMedia, true);

    expect(result.startsWith("Error: could not transcribe")).toBe(true);
    expect(result).toContain("failed to load model");
  });

  it("test_audio_only_webm_is_transcribed_but_video_webm_is_not", async () => {
    const { vault } = await audioEnv();
    const media = new FakeMedia(vault.root, { videoFiles: ["Clip.webm"] });

    await vault.write("Attachments/Recording 1.webm", "audio-v1");
    await vault.write("Attachments/Clip.webm", "audio-v1");

    expect(await isAudioFile("Attachments/Recording 1.webm", media)).toBe(true);
    expect(await isAudioFile("Attachments/Clip.webm", media)).toBe(false);
  });
});
