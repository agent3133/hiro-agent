/**
 * Which config fields the settings tab shows plainly rather than under Advanced — no Obsidian in here, so the
 * smoke test can check Advanced leaves them out.
 */

/**
 * Features, as switches, with the label a person would use rather than the config key, and each feature's own
 * further settings, folded under its switch while it is on (#149, usability review) — one place per feature.
 */
export const FEATURES: { path: string; label: string; more: string[] }[] = [
  { path: "builtin_tools.web_fetch.enabled", label: "Open web pages",
    more: ["builtin_tools.web_fetch.timeout", "builtin_tools.web_fetch.max_content_length"] },
  { path: "journal.enabled", label: "Undo agent changes", more: ["journal.turns", "journal.max_mb"] },
  { path: "memory.enabled", label: "Memory",
    more: ["memory.profile_path", "memory.max_profile_tokens", "memory.inject_into_system_prompt"] },
  { path: "audio.enabled", label: "Audio transcription",
    more: ["audio.language", "audio.use_gpu", "audio.threads", "audio.timeout_factor", "audio.extra_args"] },
];

/** What audio transcription needs, shown only while it is switched on. */
export const AUDIO_DETAILS = ["audio.whisper_cli", "audio.model", "audio.ffmpeg"];

/** The bare `llm` connection, which the plugin turns into a named one on load (#149): never drawn. */
export const UNUSED_PATHS = ["llm"];

/** Labels for fields whose config key reads as jargon (#149). */
export const LABELS: Record<string, string> = {
  "audio.whisper_cli": "whisper.cpp program",
  "audio.model": "Whisper model file",
  "audio.ffmpeg": "ffmpeg program",
  "audio.language": "Language",
  "audio.use_gpu": "Use the graphics card",
  "audio.threads": "CPU threads",
  "audio.timeout_factor": "Time allowed per minute of audio",
  "audio.extra_args": "Extra whisper.cpp arguments",
  "builtin_tools.web_fetch.timeout": "Time limit (seconds)",
  "builtin_tools.web_fetch.max_content_length": "Largest page (characters)",
  "journal.turns": "Answers that can be undone",
  "journal.max_mb": "Memory kept for undo (MB)",
  "memory.profile_path": "Profile note",
  "memory.max_profile_tokens": "Largest profile (tokens)",
  "memory.inject_into_system_prompt": "Read the profile at the start of each conversation",
};

export const BASIC_PATHS = ["vault.default_agent", ...FEATURES.flatMap((feature) => [feature.path, ...feature.more]),
                            ...AUDIO_DETAILS, ...UNUSED_PATHS];
