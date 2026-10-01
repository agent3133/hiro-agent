/**
 * What this device has allowed of what the agent's settings ask for (#136, security review 2026-09-30).
 *
 * The settings live in data.json, which syncs with the vault: whoever can write the vault on another device can
 * change where a connection sends its key, or which program transcribes a recording. The keys themselves stay in
 * this device's keychain, but using them is the capability that matters. So, as for stdio MCP servers
 * (mcp/approvals.ts), anything that sends a keychain secret somewhere or runs a program is used only once this
 * device has approved it as it stands now: a connection's key and the address it goes to, and the audio programs.
 * Approvals are kept in Obsidian's local storage for this vault on this device, never in data.json.
 *
 * A change made on this device approves itself (main.ts compares the settings before and after each save); a change
 * that arrives by sync waits for Approve in the settings. The first start of a version with approvals on a device
 * approves what is already there: it all ran without asking before.
 */

export const DEVICE_APPROVALS_KEY = "agent-device-approved";

const OPENAI_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_PROGRAMS = { whisper: "whisper-cli", ffmpeg: "ffmpeg" };

/** One thing to approve: *id* names it, *fingerprint* is what it is now, *what* says it in words. */
export interface Approval {
  id: string;
  fingerprint: string;
  what: string;
}

type Values = Record<string, unknown>;

function section(values: Values, key: string): Values {
  const value = values[key];
  return value && typeof value === "object" && !Array.isArray(value) ? value as Values : {};
}

export class DeviceApprovals {
  constructor(private readonly load: () => unknown, private readonly save: (value: Record<string, string>) => void) {}

  private stored(): Record<string, string> | null {
    try {
      const value = this.load();
      return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, string> : null;
    } catch {
      return null;
    }
  }

  /** Whether this device has kept approvals before; false on the first start of a version that asks. */
  initialized(): boolean {
    return this.stored() !== null;
  }

  approved(approval: Approval): boolean {
    return this.stored()?.[approval.id] === approval.fingerprint;
  }

  approve(...approvals: Approval[]): void {
    const next = { ...(this.stored() ?? {}) };
    for (const approval of approvals) next[approval.id] = approval.fingerprint;
    this.save(next);
  }
}

/**
 * A connection's key and where it goes, or null when it sends no key. *name* is the profile, "" for the bare `llm`
 * section. A `${NAME}` reference is what sends a keychain secret; a local server without one needs no approval.
 */
export function connectionApproval(values: Values, name: string): Approval | null {
  const raw = name ? section(section(values, "llm_profiles"), name) : section(values, "llm");
  const reference = typeof raw.api_key === "string" ? /^\$\{([^}]+)\}$/.exec(raw.api_key.trim())?.[1] : undefined;
  if (!reference) return null;
  const provider = String(raw.provider ?? "openai");
  const baseUrl = typeof raw.base_url === "string" && raw.base_url.trim()
    ? raw.base_url.trim() : provider === "openai" ? OPENAI_BASE_URL : "";
  // Without an address the key goes nowhere — the turn stops first — so there is nothing to approve (#149)
  if (!baseUrl) return null;
  return {
    id: `connection:${name || "llm"}`,
    fingerprint: JSON.stringify([baseUrl, reference]),
    what: `sends the key ${reference} to ${baseUrl}`,
  };
}

/** The audio programs as set, or null when they are the plugin's own defaults (which run from PATH as they are). */
export function programsApproval(values: Values): Approval | null {
  const audio = section(values, "audio");
  const text = (value: unknown, fallback: string): string =>
    typeof value === "string" && value.trim() ? value.trim() : fallback;
  const whisper = text(audio.whisper_cli, DEFAULT_PROGRAMS.whisper);
  const ffmpeg = text(audio.ffmpeg, DEFAULT_PROGRAMS.ffmpeg);
  const extraArgs = Array.isArray(audio.extra_args) ? audio.extra_args.map(String) : [];
  if (whisper === DEFAULT_PROGRAMS.whisper && ffmpeg === DEFAULT_PROGRAMS.ffmpeg && !extraArgs.length) return null;
  return {
    id: "programs:audio",
    fingerprint: JSON.stringify([whisper, ffmpeg, extraArgs]),
    what: `runs ${[whisper, ...extraArgs].join(" ")} and ${ffmpeg}`,
  };
}

/** Everything in *values* that needs this device's approval. */
export function requiredApprovals(values: Values): Approval[] {
  const names = ["", ...Object.keys(section(values, "llm_profiles"))];
  return [...names.map((name) => connectionApproval(values, name)), programsApproval(values)]
    .filter((approval): approval is Approval => approval !== null);
}

/** What *after* needs approved that *before* did not have in this form — what a save on this device changed. */
export function changedApprovals(before: Values, after: Values): Approval[] {
  const previous = new Map(requiredApprovals(before).map((approval) => [approval.id, approval.fingerprint]));
  return requiredApprovals(after).filter((approval) => previous.get(approval.id) !== approval.fingerprint);
}
