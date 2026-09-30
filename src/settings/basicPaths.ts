/**
 * Which config fields the settings tab shows plainly rather than under Advanced — no Obsidian in here, so the
 * smoke test can check Advanced leaves them out.
 */

/** Features, as switches, with the label a person would use rather than the config key. */
export const FEATURES: { path: string; label: string }[] = [
  { path: "builtin_tools.web_fetch.enabled", label: "Open web pages" },
  { path: "journal.enabled", label: "Undo" },
  { path: "memory.enabled", label: "Memory" },
  { path: "audio.enabled", label: "Audio transcription" },
];

/** What audio transcription needs, shown only while it is switched on. */
export const AUDIO_DETAILS = ["audio.whisper_cli", "audio.model", "audio.ffmpeg"];

export const BASIC_PATHS = ["vault.default_agent", ...FEATURES.map((item) => item.path), ...AUDIO_DETAILS];
