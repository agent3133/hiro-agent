/** Every tool the in-plugin agent has in Obsidian: the core's and the Obsidian-only ones — in Python's order. */

import type { App } from "obsidian";

import { inSpecOrder, makeTools, type MemorySettings, type Tool } from "../core/tools";
import { makeAttachmentTools } from "./attachmentTools";
import { makeIndexTools } from "./indexTools";
import { obsidianVault } from "./obsidianVault";
import { makePluginTools } from "./pluginTools";
import { DEFAULT_AUDIO, type AudioSettings } from "./media";
import { DEFAULT_WEB, makeWebTools, type WebSettings } from "./webTools";

export interface ToolsetOptions {
  memory: MemorySettings | null;
  web: WebSettings;
  audio: AudioSettings;
  /** The model's context window in tokens: a reopened conversation brings back what fits in a fifth of it. */
  contextWindow: number;
  /** The undo journal (`journal`): on, how many turns, how many bytes of earlier text. */
  journal: { enabled: boolean; turns: number; maxBytes: number };
}

export function obsidianToolset(app: App, scope: string[] | null, options: ToolsetOptions): Tool[] {
  const vault = obsidianVault(app);
  return inSpecOrder([...makeTools(vault, scope, { memory: options.memory }), ...makeIndexTools(app, vault, scope),
                      ...makePluginTools(app, vault, scope), ...makeAttachmentTools(app, scope, options.audio),
                      ...makeWebTools(options.web)]);
}

/** The tools' settings: from the agent's settings in the plugin (#86). */
export function toolsetOptions(config: { values: Record<string, unknown> } | null): ToolsetOptions {
  const builtin = (config?.values.builtin_tools ?? {}) as Record<string, Record<string, unknown>>;
  const fetch = builtin.web_fetch ?? {};
  const number = (value: unknown, fallback: number): number => (typeof value === "number" ? value : fallback);
  return {
    memory: memorySettings(config),
    audio: audioSettings(config),
    contextWindow: number((config?.values.llm as Record<string, unknown> | undefined)?.context_window, 128_000),
    journal: {
      enabled: (config?.values.journal as Record<string, unknown> | undefined)?.enabled !== false,
      turns: number((config?.values.journal as Record<string, unknown> | undefined)?.turns, 20),
      maxBytes: number((config?.values.journal as Record<string, unknown> | undefined)?.max_mb, 20) * 1_000_000,
    },
    web: {
      fetch: { enabled: fetch.enabled === true, timeoutSeconds: number(fetch.timeout, DEFAULT_WEB.fetch.timeoutSeconds),
               maxContentLength: number(fetch.max_content_length, DEFAULT_WEB.fetch.maxContentLength) },
    },
  };
}

/** The user-profile tools' settings; null when memory is off, so the tools are not offered — as in Python. */
export function memorySettings(config: { values: Record<string, unknown> } | null): MemorySettings | null {
  const memory = (config?.values.memory ?? {}) as Record<string, unknown>;
  if (memory.enabled !== true) return null;
  return {
    profilePath: typeof memory.profile_path === "string" ? memory.profile_path : ".memory/user-profile.md",
    maxProfileTokens: typeof memory.max_profile_tokens === "number" ? memory.max_profile_tokens : 2000,
    inject: memory.inject_into_system_prompt !== false,
  };
}

/** whisper.cpp and ffmpeg, from the runtime's `audio` settings (config/schema.py AudioConfig). */
export function audioSettings(config: { values: Record<string, unknown> } | null): AudioSettings {
  const audio = (config?.values.audio ?? {}) as Record<string, unknown>;
  const text = (value: unknown, fallback: string): string => (typeof value === "string" && value.trim() ? value.trim() : fallback);
  return {
    enabled: audio.enabled === true,
    whisperCli: text(audio.whisper_cli, DEFAULT_AUDIO.whisperCli),
    ffmpeg: text(audio.ffmpeg, DEFAULT_AUDIO.ffmpeg),
    model: typeof audio.model === "string" && audio.model.trim() ? audio.model.trim() : null,
    language: text(audio.language, DEFAULT_AUDIO.language),
    useGpu: audio.use_gpu === true,
    threads: typeof audio.threads === "number" ? audio.threads : null,
    timeoutFactor: typeof audio.timeout_factor === "number" ? audio.timeout_factor : DEFAULT_AUDIO.timeoutFactor,
    extraArgs: Array.isArray(audio.extra_args) ? audio.extra_args.map(String) : [],
  };
}
