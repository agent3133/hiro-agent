/**
 * Keys by their name in Obsidian's keychain (#147). A setting refers to a key as `${name}`, where *name* is the
 * keychain entry's own name (Settings → Keychain: lowercase letters, digits, dashes) — no table in between.
 *
 * Until 0.9.1 a Secrets tab bound variable-style names to keychain entries (`${OPENAI_API_KEY}` → `openai-api-key`),
 * a leftover of the Python agent's environment variables. `migrateReferences` rewrites such references to the
 * entries they stood for, once, and says what it renamed so the device's approvals can follow.
 */

/** What Obsidian accepts as a keychain entry's name. */
export const KEYCHAIN_NAME = /^[a-z0-9-]{1,64}$/;

/** A binding of the old Secrets tab: a name the settings used, and the keychain entry it stood for. */
export interface OldBinding {
  env: string;
  id: string;
}

/** The keychain entry an old name got when its binding named none: `LLM_API_KEY` → `llm-api-key`. */
function defaultEntry(env: string): string {
  return env.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
}

/** Old name → keychain entry, for every binding that leads somewhere and actually changes the name. */
export function renames(bindings: unknown): Record<string, string> {
  const found: Record<string, string> = {};
  for (const binding of Array.isArray(bindings) ? bindings : []) {
    const env = typeof binding?.env === "string" ? binding.env.trim() : "";
    const id = typeof binding?.id === "string" && binding.id.trim() ? binding.id.trim() : defaultEntry(env);
    if (env && KEYCHAIN_NAME.test(id) && id !== env) found[env] = id;
  }
  return found;
}

/** *text* with every `${OLD}` in *renamed* written as `${entry}`. */
export function renameIn(text: string, renamed: Record<string, string>): string {
  return text.replace(/\$\{([^}]+)\}/g, (whole, name: string) => (renamed[name] ? `\${${renamed[name]}}` : whole));
}

/** *values* with the references renamed in every string, however deep. */
export function migrateReferences(values: unknown, renamed: Record<string, string>): unknown {
  if (typeof values === "string") return renameIn(values, renamed);
  if (Array.isArray(values)) return values.map((item) => migrateReferences(item, renamed));
  if (values && typeof values === "object") {
    return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, migrateReferences(value, renamed)]));
  }
  return values;
}

/**
 * The device approvals (config/deviceApprovals.ts) after the rename: a connection's fingerprint holds the key's
 * name as its second element. The plugin renames on this device, so what was approved stays approved.
 */
export function migrateDeviceApprovals(stored: unknown, renamed: Record<string, string>): Record<string, string> | null {
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) return null;
  return Object.fromEntries(Object.entries(stored as Record<string, string>).map(([id, fingerprint]) => {
    if (!id.startsWith("connection:")) return [id, fingerprint];
    try {
      const [url, name] = JSON.parse(fingerprint) as [string, string];
      return [id, JSON.stringify([url, renamed[name] ?? name])];
    } catch {
      return [id, fingerprint];
    }
  }));
}

/** This device's approval of the bare `llm` connection, kept under the name it moved to (#149); null when none. */
export function renameConnectionApproval(stored: unknown, name: string): Record<string, string> | null {
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) return null;
  const approvals = { ...(stored as Record<string, string>) };
  if (!("connection:llm" in approvals)) return null;
  approvals[`connection:${name}`] = approvals["connection:llm"];
  delete approvals["connection:llm"];
  return approvals;
}

/** The MCP approvals (mcp/approvals.ts) after the rename: the references appear as written in each fingerprint. */
export function migrateMcpApprovals(stored: unknown, renamed: Record<string, string>): string[] | null {
  if (!Array.isArray(stored)) return null;
  return stored.filter((item): item is string => typeof item === "string").map((item) => renameIn(item, renamed));
}
