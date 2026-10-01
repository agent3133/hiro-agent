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
const OBSOLETE_CONFIG: [string, string][] = [
  ["builtin_tools", "web_search"],
  // The Python runtime's, which the plugin never read (#180)
  ["memory", "auto_reflect_on_session_end"],
];
/** Whole sections of the Python runtime's that the plugin never read: its terminal UI, folders and CLI tools (#180). */
const OBSOLETE_SECTIONS = ["ui", "agents", "tools", "external_tools"];
/** Fields of a connection the plugin never read (#180), in `llm` and in every named connection. */
const OBSOLETE_CONNECTION_FIELDS = ["provider_class", "thinking_budget"];

/** *values* without the obsolete settings, or null when it has none. */
export function withoutObsolete(values: Values): Values | null {
  const isObject = (value: unknown): value is Values => Boolean(value) && typeof value === "object" && !Array.isArray(value);
  const patch: Values = {};
  const drop = (section: string, keys: string[]): Values | null => {
    const part = values[section];
    const found = isObject(part) ? keys.filter((key) => key in part) : [];
    return found.length ? Object.fromEntries(found.map((key) => [key, null])) : null;
  };
  for (const [section, key] of OBSOLETE_CONFIG) {
    const found = drop(section, [key]);
    if (found) patch[section] = { ...(patch[section] as Values | undefined), ...found };
  }
  for (const section of OBSOLETE_SECTIONS) if (section in values) patch[section] = null;
  const llm = drop("llm", OBSOLETE_CONNECTION_FIELDS);
  if (llm) patch.llm = llm;
  const profiles = values.llm_profiles;
  if (isObject(profiles)) {
    const perProfile: Values = {};
    for (const [name, profile] of Object.entries(profiles)) {
      const found = isObject(profile) ? OBSOLETE_CONNECTION_FIELDS.filter((key) => key in profile) : [];
      if (found.length) perProfile[name] = Object.fromEntries(found.map((key) => [key, null]));
    }
    if (Object.keys(perProfile).length) patch.llm_profiles = perProfile;
  }
  return Object.keys(patch).length ? merge(values, patch) : null;
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
    };
  }

  async putConfig(changes: Values): Promise<ConfigWriteResult> {
    const before = this.read();
    // Masks are what the UI was shown, not what the user typed: dropping them keeps the stored secret
    const after = merge(before, dropMasks(changes) as Values);
    // A key belongs in Obsidian's keychain; typed into a field it would sit in data.json, which syncs with the vault
    const fields = [
      ...literalSecrets(dropMasks(changes)).map((path) => ({
        path, message: "put the key in Obsidian's keychain (Settings → Keychain) and write ${its-name} here" })),
      ...validate(merge(after, { vault: { path: this.vaultPath() } }), SCHEMA),
    ];
    if (fields.length) {
      return { ok: false, changed: [], error: "the config would not be valid",
               fields };
    }
    const changed = changedKeys(before, after);
    if (changed.length) await this.write(after);
    return { ok: true, changed, fields: [] };
  }
}
