/**
 * Secrets in the agent's settings, as the settings UI sees them — ported from src/obsidian_agent/config/masking.py.
 *
 * The UI round-trips what it is shown, so the full value of a key is never handed to it, and a mask that comes back
 * is never stored as the new value. `${OPENAI_API_KEY}` is a reference, not a secret: it is shown as it is.
 */

import { holdsASecret } from "../core/redact";

// `authorization`: an MCP server's header (#87) — Python had no header a key could hide in
const SECRET_HINTS = ["api_key", "apikey", "secret", "token", "password", "passwd", "authorization"];
const REFERENCE = /\$\{[^}]+\}/g;

/**
 * Whether *value* points at a key rather than holding one: `${NAME}`, or a reference with a short word before it,
 * as an HTTP header wants it (`Bearer ${TOKEN}`). Anything else next to a reference could be part of a key.
 */
export function isReference(value: string): boolean {
  const text = value.trim();
  if (!text.match(REFERENCE)) return false;
  return /^[A-Za-z]{0,20}\s*$/.test(text.replace(REFERENCE, "").trim());
}

export const MASK_PREFIX = "…";

export function isSecretKey(key: string): boolean {
  const lowered = key.toLowerCase();
  return SECRET_HINTS.some((hint) => lowered.includes(hint));
}

export function mask(value: string): string {
  if (!value || isReference(value)) return value;
  return `${MASK_PREFIX}${value.length > 8 ? value.slice(-4) : ""}`;
}

export function isMask(value: unknown): boolean {
  return typeof value === "string" && value.startsWith(MASK_PREFIX);
}

export function maskSecrets(values: unknown): unknown {
  if (Array.isArray(values)) return values.map(maskSecrets);
  if (values && typeof values === "object") {
    return Object.fromEntries(Object.entries(values as Record<string, unknown>).map(([key, value]) =>
      [key, isSecretKey(key) && typeof value === "string" ? mask(value) : maskSecrets(value)]));
  }
  return values;
}

/** *values* without the fields that came back masked, so saving keeps what is stored. */
export function dropMasks(values: unknown): unknown {
  if (Array.isArray(values)) return values.map(dropMasks);
  if (values && typeof values === "object") {
    return Object.fromEntries(Object.entries(values as Record<string, unknown>)
      .filter(([, value]) => !isMask(value)).map(([key, value]) => [key, dropMasks(value)]));
  }
  return values;
}

/** `{"llm.api_key": true}` for every credential field: whether it holds anything. */
export function secretFlags(values: unknown): Record<string, boolean> {
  const found: Record<string, boolean> = {};
  const walk = (node: unknown, path: string): void => {
    if (!node || typeof node !== "object" || Array.isArray(node)) return;
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      const where = path ? `${path}.${key}` : key;
      if (isSecretKey(key) && (typeof value === "string" || value === null || value === undefined)) found[where] = Boolean(value);
      else walk(value, where);
    }
  };
  walk(values, "");
  return found;
}

/** Whether *value*, in a credential field, is a key written out rather than empty or a `${VAR}` reference. */
export function isLiteralSecret(value: unknown): boolean {
  return typeof value === "string" && value.trim() !== "" && !isReference(value) && !isMask(value);
}

/** The credential fields that hold a key itself rather than a `${VAR}` reference, e.g. `["llm.api_key"]`. */
export function literalSecrets(values: unknown): string[] {
  const found: string[] = [];
  const walk = (node: unknown, path: string): void => {
    if (!node || typeof node !== "object") return;
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      const where = path ? `${path}.${key}` : key;
      if (!Array.isArray(node) && isSecretKey(key) && typeof value === "string") {
        if (isLiteralSecret(value)) found.push(where);
      } else if (typeof value === "string") {
        // Anywhere else a key has a recognisable shape: an MCP server's arguments (--api-key sk-…), an env entry
        // under another name, a URL's query (?key=AIza…) — refused the same way (#138)
        if (!isReference(value) && holdsASecret(value)) found.push(where);
      } else walk(value, where);
    }
  };
  walk(values, "");
  return found;
}
