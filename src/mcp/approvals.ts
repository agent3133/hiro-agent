/**
 * Which stdio MCP servers may start on this device (#87, decided 2026-09-29).
 *
 * The agent's settings live in data.json, which syncs with the vault — so a server added on one device, or by
 * anyone who can write to the vault, would start a program on every other. An approval is kept outside the vault,
 * in Obsidian's local storage for this vault on this device, and is for one exact command line
 * (servers.fingerprint): a server that arrived by sync, or whose command, arguments or env changed, waits until
 * the user has seen what it runs and said yes, here.
 */

import { fingerprint, type McpServerSpec } from "./servers";

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

  /** An http server runs nothing here and needs none; a stdio server needs this exact command line approved. */
  approved(spec: McpServerSpec): boolean {
    return spec.transport !== "stdio" || this.all().includes(fingerprint(spec));
  }

  approve(spec: McpServerSpec): void {
    const others = this.all().filter((item) => JSON.parse(item)[0] !== spec.name);
    this.save([...others, fingerprint(spec)]);
  }

  /** Forget a server's approval — when it is removed, or its approval taken back. */
  revoke(name: string): void {
    this.save(this.all().filter((item) => JSON.parse(item)[0] !== name));
  }
}
