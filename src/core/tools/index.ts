/** The ported tools, in the order the Python runtime offers them (make_all_builtin_tools). */

import type { VaultPort } from "../vault";
import { makeMemoryTools, type MemorySettings } from "./memoryTools";
import { makeMetadataTools } from "./metadataTools";
import { makeSearchTools } from "./searchTools";
import specs from "./specs.json";
import { makeTaskNotesTools } from "./tasknotesTools";
import type { Tool } from "./tool";
import { makeVaultTools } from "./vaultTools";

export type { Tool } from "./tool";
export type { MemorySettings } from "./memoryTools";

export interface ToolOptions {
  /** The user-profile tools, offered only when memory is on — as in Python. */
  memory?: MemorySettings | null;
  /** The vault's config folder, where TaskNotes keeps its settings (Obsidian's `configDir`, #164). */
  configDir?: string;
}

/** The tools that run anywhere: on the file system under Node, and on Obsidian's vault. */
export function makeTools(vault: VaultPort, scope: string[] | null = null, options: ToolOptions = {}): Tool[] {
  return inSpecOrder([
    ...makeVaultTools(vault, scope),
    ...makeSearchTools(vault, scope),
    ...makeTaskNotesTools(vault, scope, options.configDir),
    ...makeMetadataTools(vault, scope),
    ...(options.memory ? makeMemoryTools(vault, options.memory) : []),
  ]);
}

/**
 * *tools* in the order specs.json lists them (the Python runtime's order, kept) — so the core's tools and the
 * Obsidian-only ones (plugin/src/vault/indexTools.ts) reach the model in one fixed order.
 */
export function inSpecOrder(tools: Tool[]): Tool[] {
  const order = new Map((specs as { name: string }[]).map((spec, index) => [spec.name, index]));
  return [...tools].sort((a, b) => (order.get(a.name) ?? Infinity) - (order.get(b.name) ?? Infinity));
}
