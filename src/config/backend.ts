/**
 * The agent's configuration and agents as the settings tabs and the chat header ask for them — what the runtime's
 * HTTP API answered before (#86), now answered by the plugin itself: `/config`, `/agents`, `/tools`, the connection
 * list in `ready`, and the whisper.cpp / ffmpeg checks of `/extras`.
 */

import type {
  AgentDetail, AgentFields, AgentWrite, ConfigDocument, ConfigWriteResult, ProgramCheck, ProgramFound, ReadyInfo,
  ToolInfo,
} from "../api/types";
import type { AgentCatalog } from "./agents";
import { defaultProfileName, profileSummaries } from "./connections";
import type { ConfigStore } from "./store";

/** What a program check needs: running a program with one fixed argument, and finding one on PATH. */
export interface Programs {
  run(program: string, argument: string): Promise<ProgramCheck>;
  which(name: string): Promise<string | null>;
  isFile(path: string): Promise<boolean>;
}

/** The names each program goes by on PATH (extras_api.py). */
const PATH_NAMES: Record<"whisper" | "ffmpeg", string[]> = { whisper: ["whisper-cli", "whisper-cpp"], ffmpeg: ["ffmpeg"] };

export class PluginBackend {
  private ready: ReadyInfo;

  constructor(private readonly store: ConfigStore, private readonly catalog: AgentCatalog,
              private readonly programs: Programs, version: string, vaultName: string) {
    this.ready = { version, vault: vaultName, agents: [], profiles: [], defaultProfile: "" };
  }

  /** The agents and connections as the chat header lists them; call refresh() after they change. */
  info(): ReadyInfo {
    return this.ready;
  }

  async refresh(): Promise<ReadyInfo> {
    const values = this.store.values();
    this.ready = { ...this.ready, agents: await this.catalog.summaries(), profiles: profileSummaries(values),
                   defaultProfile: defaultProfileName(values) };
    return this.ready;
  }

  config(): Promise<ConfigDocument> {
    return this.store.config();
  }

  async putConfig(values: Record<string, unknown>): Promise<ConfigWriteResult> {
    const result = await this.store.putConfig(values);
    if (result.ok && result.changed.length) await this.refresh();
    return result;
  }

  tools(): Promise<ToolInfo[]> {
    return this.catalog.tools();
  }

  agent(name: string): Promise<AgentDetail> {
    return this.catalog.agent(name);
  }

  async saveAgent(name: string, change: { prompt?: string; fields?: Partial<AgentFields> }): Promise<AgentWrite> {
    const result = await this.catalog.saveAgent(name, change);
    await this.refresh();
    return result;
  }

  async createAgent(name: string, from?: string): Promise<AgentWrite> {
    const result = await this.catalog.createAgent(name, from);
    await this.refresh();
    return result;
  }

  async deleteAgent(name: string): Promise<void> {
    await this.catalog.deleteAgent(name);
    await this.refresh();
  }

  async resetAgent(name: string): Promise<AgentDetail> {
    const detail = await this.catalog.resetAgent(name);
    await this.refresh();
    return detail;
  }

  private audio(): { whisper: string; ffmpeg: string; model: string } {
    const audio = (this.store.values().audio ?? {}) as Record<string, unknown>;
    const text = (value: unknown, fallback: string): string => (typeof value === "string" && value.trim() ? value.trim() : fallback);
    return { whisper: text(audio.whisper_cli, "whisper-cli"), ffmpeg: text(audio.ffmpeg, "ffmpeg"), model: text(audio.model, "") };
  }

  /** What each configured program runs, and what PATH offers — `detect_programs`. */
  async detectPrograms(): Promise<Record<"whisper" | "ffmpeg", ProgramFound>> {
    const audio = this.audio();
    const resolve = async (value: string): Promise<string | null> =>
      (await this.programs.isFile(value)) ? value : this.programs.which(value);
    const found = async (name: "whisper" | "ffmpeg", configured: string): Promise<ProgramFound> => {
      let onPath: string | null = null;
      for (const candidate of PATH_NAMES[name]) if (!onPath) onPath = await this.programs.which(candidate);
      return { configured, resolved: await resolve(configured), on_path: onPath };
    };
    return { whisper: await found("whisper", audio.whisper), ffmpeg: await found("ffmpeg", audio.ffmpeg) };
  }

  /** Does the configured program run — `test_program`: whisper.cpp with its model, ffmpeg with ffprobe beside it. */
  async testProgram(program: "whisper" | "ffmpeg"): Promise<ProgramCheck> {
    const audio = this.audio();
    if (program === "whisper") {
      const check = await this.programs.run(audio.whisper, "-h");
      if (check.ok && !(audio.model && (await this.programs.isFile(audio.model)))) {
        return { ...check, ok: false, error: `whisper.cpp runs, but the model ${audio.model ? `${audio.model} is not a file` : "is not set"}` };
      }
      return check;
    }
    const check = await this.programs.run(audio.ffmpeg, "-version");
    const probe = await this.programs.run(ffprobeFor(audio.ffmpeg), "-version");
    if (check.ok && !probe.ok) return { ...check, ok: false, error: `ffmpeg runs, but ffprobe does not: ${probe.error}` };
    return check;
  }
}

/** ffprobe beside a configured ffmpeg path, or on PATH for a bare name — `programs.ffprobe`. */
export function ffprobeFor(ffmpeg: string): string {
  if (!/[\\/]/.test(ffmpeg)) return "ffprobe";
  const cut = Math.max(ffmpeg.lastIndexOf("/"), ffmpeg.lastIndexOf("\\"));
  return ffmpeg.slice(0, cut + 1) + ffmpeg.slice(cut + 1).replace(/ffmpeg/i, "ffprobe");
}
