/**
 * read_user_memory and update_user_memory — ported from make_memory_tools (src/obsidian_agent/tools/builtin/memory.py)
 * and the profile helpers in src/obsidian_agent/session/user_profile.py. The profile is a note in the vault.
 */

import type { VaultPort } from "../vault";
import { defineTool, type Tool } from "./tool";

export interface MemorySettings {
  /** Where in the vault the profile is kept (`memory.profile_path`). */
  profilePath: string;
  /** Longest profile the agent reads, in tokens (`memory.max_profile_tokens`). */
  maxProfileTokens: number;
  /** Give the profile to the agent at the start of each turn (`memory.inject_into_system_prompt`). */
  inject?: boolean;
}

export const DEFAULT_MEMORY: MemorySettings = { profilePath: ".memory/user-profile.md", maxProfileTokens: 2000 };

const SECTIONS: [string, string][] = [
  ["Identity", "Name, location, occupation, timezone, or other personal identifiers"],
  ["Preferences", "Tool preferences, writing style, language, formatting preferences"],
  ["Projects & Context", "Active projects, goals, ongoing work the agent helps with"],
  ["Communication Style", "Preferred tone (formal/casual), verbosity, response format"],
  ["Learned Facts", "Specific facts, decisions, or patterns observed over time"],
];

/** Cut to about *maxTokens* tokens (4 characters each), at a line break where one is near — `_truncate_to_tokens`. */
export function truncateToTokens(content: string, maxTokens: number): string {
  const maxChars = maxTokens * 4;
  if (content.length <= maxChars) return content;
  let truncated = content.slice(0, maxChars);
  const lastBreak = truncated.lastIndexOf("\n");
  if (lastBreak > Math.floor(maxChars / 2)) truncated = truncated.slice(0, lastBreak);
  return `${truncated}\n\n_[Profile truncated to fit context window]_`;
}

/** The profile's body without its frontmatter, "" when there is none — `read_user_profile`. */
export async function readUserProfile(vault: VaultPort, profilePath: string, maxTokens?: number): Promise<string> {
  if (!(await vault.isFile(profilePath))) return "";
  const text = await vault.read(profilePath);
  const frontmatter = /^---\n[\s\S]*?\n---\n/.exec(text);
  const content = (frontmatter ? text.slice(frontmatter[0].length) : text).trim();
  return maxTokens === undefined ? content : truncateToTokens(content, maxTokens);
}

/** Python's `datetime.now().isoformat(timespec="seconds")`: local time, no zone. */
function localIsoSeconds(now: Date): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T`
         + `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
}

export async function saveUserProfile(vault: VaultPort, profilePath: string, content: string,
                                      now = new Date()): Promise<void> {
  const frontmatter = `---\ntype: user-profile\nupdated: ${localIsoSeconds(now)}\n---\n`;
  await vault.write(profilePath, `${frontmatter}${content.trim()}\n`);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Replace or add one section, then save — `update_profile_section`. Returns the new body. */
export async function updateProfileSection(vault: VaultPort, profilePath: string, section: string, content: string,
                                           maxProfileTokens?: number): Promise<string> {
  const current = (await readUserProfile(vault, profilePath))
    || SECTIONS.map(([name, hint]) => `## ${name}\n\n_${hint}_\n`).join("\n");
  const pattern = new RegExp(`(## ${escapeRegExp(section)}\\s*\\n)([\\s\\S]*?)(?=\\n## |$(?![\\s\\S]))`);
  const replacement = `## ${section}\n\n${content.trim()}\n`;
  let updated = pattern.test(current)
    ? current.replace(pattern, () => replacement)
    : `${current.trimEnd()}\n\n${replacement}`;
  if (maxProfileTokens !== undefined) updated = truncateToTokens(updated, maxProfileTokens);
  await saveUserProfile(vault, profilePath, updated);
  return updated;
}

export function makeMemoryTools(vault: VaultPort, settings: MemorySettings = DEFAULT_MEMORY): Tool[] {
  const updateUserMemory = defineTool("update_user_memory", async (args) => {
    const section = args.str("section");
    try {
      await updateProfileSection(vault, settings.profilePath, section, args.str("content"), settings.maxProfileTokens);
      return `Updated '${section}' in user profile.`;
    } catch (error) {
      return `Failed to update user profile: ${error instanceof Error ? error.message : String(error)}`;
    }
  });

  const readUserMemory = defineTool("read_user_memory", async () => {
    const profile = await readUserProfile(vault, settings.profilePath, settings.maxProfileTokens);
    return profile || "(User profile is empty)";
  });

  return [updateUserMemory, readUserMemory];
}
