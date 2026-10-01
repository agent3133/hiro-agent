/**
 * Which stdio MCP servers may start on this device (#87, decided 2026-09-29).
 *
 * The agent's settings live in data.json, which syncs with the vault — so a server added on one device, or by
 * anyone who can write to the vault, would start a program on every other. An approval is kept outside the vault,
 * in Obsidian's local storage for this vault on this device, and is for one exact command line
 * (servers.fingerprint): a server that arrived by sync, or whose command, arguments or env changed, waits until
 * the user has seen what it runs and said yes, here.
 */

import { fingerprint, needsApproval, type McpServerSpec } from "./servers";

export const APPROVALS_KEY = "agent-mcp-approved";

export class McpApprovals {
  constructor(private readonly load: () => unknown, private readonly save: (value: string[]) => void) {}

  private all(): string[] {
    try {
      const stored = this.load();
      return Array.isArray(stored) ? stored.filter((item): item is string => typeof item === "string") : [];
    } catch {
      return [];
    }
  }

  /**
   * A stdio server needs this exact command line approved; an http server needs its URL and headers approved when
   * they send a key (#136), and nothing otherwise.
   */
  approved(spec: McpServerSpec): boolean {
    return !needsApproval(spec) || this.all().includes(fingerprint(spec));
  }

  approve(spec: McpServerSpec): void {
    const others = this.all().filter((item) => nameOf(item) !== spec.name);
    this.save([...others, fingerprint(spec)]);
  }

  /** Forget a server's approval — when it is removed, or its approval taken back. */
  revoke(name: string): void {
    this.save(this.all().filter((item) => nameOf(item) !== name));
  }
}

/** The server an approval is for; "" for an entry that is not one (a corrupt one is dropped, not thrown). */
function nameOf(item: string): string {
  try {
    const parsed: unknown = JSON.parse(item);
    return Array.isArray(parsed) && typeof parsed[0] === "string" ? parsed[0] : "";
  } catch {
    return "";
  }
}
