/**
 * The agent's configuration, kept by the plugin in its own settings (#86) — what config.yaml was for the runtime.
 *
 * It answers the settings tabs the way the runtime's `GET/PUT /config` did (server/config_api.py): the schema, the
 * values with secrets masked, which secret fields are set; a change is merged into what is stored, checked against
 * the schema, and refused field by field when it would not be valid, so nothing half-applied is ever saved.
 * Settings live per vault now, by construction (#57).
 */

import type { ConfigDocument, ConfigWriteResult } from "../api/types";
import { dropMasks, literalSecrets, maskSecrets, secretFlags } from "./masking";
import schemaJson from "./schema.json";
import { validate, type JsonSchema } from "./validate";

export const SCHEMA = schemaJson as unknown as JsonSchema;

type Values = Record<string, unknown>;

/** *base* with *changes* applied, recursing into sections; null removes a key — `merge` (config/writer.py). */
export function merge(base: Values, changes: Values): Values {
  const merged: Values = { ...base };
  for (const [key, value] of Object.entries(changes)) {
    if (value === null || value === undefined) delete merged[key];
    else if (value && typeof value === "object" && !Array.isArray(value)
             && merged[key] && typeof merged[key] === "object" && !Array.isArray(merged[key])) {
      merged[key] = merge(merged[key] as Values, value as Values);
    } else {
      merged[key] = value;
    }
  }
  return merged;
}

/** Dotted keys whose value differs — `_changed_keys`. */
function changedKeys(before: Values, after: Values, prefix = ""): string[] {
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  const changed: string[] = [];
  for (const key of keys) {
    const where = prefix ? `${prefix}.${key}` : key;
    const old = before[key];
    const now = after[key];
    const isObject = (v: unknown): v is Values => Boolean(v) && typeof v === "object" && !Array.isArray(v);
    if (isObject(old) && isObject(now)) changed.push(...changedKeys(old, now, where));
    else if (JSON.stringify(old) !== JSON.stringify(now)) changed.push(where);
  }
  return changed;
}

/** Settings the agent no longer has; stored, they would fail the schema on every change — web_search's (#118). */
const OBSOLETE_CONFIG: [string, string][] = [["builtin_tools", "web_search"]];

/** *values* without the obsolete settings, or null when it has none. */
export function withoutObsolete(values: Values): Values | null {
  const found = OBSOLETE_CONFIG.filter(([section, key]) => {
    const part = values[section];
    return Boolean(part) && typeof part === "object" && key in (part as Values);
  });
  if (!found.length) return null;
  return merge(values, Object.fromEntries(found.map(([section, key]) => [section, { [key]: null }])));
}

export class ConfigStore {
  /**
   * @param read what is stored now
   * @param write store new values
   * @param vaultPath the open vault — the config's required `vault.path`, which is always this vault here
   */
  constructor(private readonly read: () => Values, private readonly write: (values: Values) => Promise<void>,
              private readonly vaultPath: () => string) {}

  /** The stored values, unmasked, with `vault.path` the open vault — what the agent uses. */
  values(): Values {
    return merge(this.read(), { vault: { path: this.vaultPath() } });
  }

  async config(): Promise<ConfigDocument> {
    const raw = this.read();
    return {
      path: "the plugin's settings for this vault",
      exists: true,
      values: maskSecrets(raw) as Values,
      secrets: secretFlags(raw),
      schema: SCHEMA as ConfigDocument["schema"],
      restart_required_keys: [],
    };
  }

  async putConfig(changes: Values): Promise<ConfigWriteResult> {
    const before = this.read();
    // Masks are what the UI was shown, not what the user typed: dropping them keeps the stored secret
    const after = merge(before, dropMasks(changes) as Values);
    // A key belongs in Obsidian's keychain; typed into a field it would sit in data.json, which syncs with the vault
    const fields = [
      ...literalSecrets(dropMasks(changes)).map((path) => ({
        path, message: "write a ${VARIABLE} reference; the key itself goes in Secrets" })),
      ...validate(merge(after, { vault: { path: this.vaultPath() } }), SCHEMA),
    ];
    if (fields.length) {
      return { ok: false, changed: [], restart_required: [], reloaded: false, error: "the config would not be valid",
               fields };
    }
    const changed = changedKeys(before, after);
    if (changed.length) await this.write(after);
    return { ok: true, changed, restart_required: [], reloaded: changed.length > 0, fields: [] };
  }
}
