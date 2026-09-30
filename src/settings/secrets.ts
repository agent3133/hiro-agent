/**
 * The Secrets bindings: a name the settings refer to as `${NAME}`, and the secret in Obsidian's keychain it stands
 * for. The plugin's settings hold only the names; the values stay in Obsidian's secret store — DPAPI on Windows,
 * the Keychain on macOS, libsecret or KWallet on Linux — and are read when a turn or an MCP server needs one.
 */

export interface SecretBinding {
  /** The name the settings refer to, e.g. `LLM_API_KEY` in `api_key: ${LLM_API_KEY}`. The name is the user's. */
  env: string;
  /** The id of the secret in Obsidian's keychain, e.g. `llm-api-key`. */
  id: string;
}

/** Obsidian's own limit on a secret id. */
const MAX_ID = 64;

/**
 * The keychain id a name gets by default: `LLM_API_KEY` → `llm-api-key`.
 *
 * Obsidian accepts lowercase letters, digits and dashes, up to 64 characters, and throws on anything else — so an
 * underscore must become a dash before it is used as an id.
 */
export function defaultSecretId(envName: string): string {
  return envName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, MAX_ID);
}

/** Whether Obsidian would accept this as a secret id, so we can say so instead of letting `setSecret` throw. */
export function isValidSecretId(id: string): boolean {
  return id.length > 0 && id.length <= MAX_ID && /^[a-z0-9-]+$/.test(id);
}
