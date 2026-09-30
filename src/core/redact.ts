/**
 * Secrets do not reach a session note — ported from src/obsidian_agent/session/redact.py (#85).
 *
 * A session note is a vault note: synced wherever the vault syncs. A key pasted into the chat would otherwise be
 * written there and carried to every device. This recognises the shapes of the credentials people paste and
 * replaces them on the way to the file. It is not a guarantee — a secret with no recognisable shape goes through —
 * and the patterns are narrow on purpose, because the note is read back into the model's context.
 */

/** (what it is, how it looks). The name goes into the marker, so a reader knows what was removed. */
const SECRETS: [string, RegExp][] = [
  // OpenAI and Anthropic both start `sk-`; `sk-ant-…` and `sk-proj-…` are covered by the same rule
  ["API key", /\bsk-[A-Za-z0-9_-]{16,}/g],
  ["GitHub token", /\bgh[pousr]_[A-Za-z0-9]{20,}/g],
  ["AWS access key id", /\bAKIA[0-9A-Z]{16}\b/g],
  ["Google API key", /\bAIza[0-9A-Za-z_-]{35,}/g],
  ["Slack token", /\bxox[abprs]-[A-Za-z0-9-]{10,}/g],
  ["Hugging Face token", /\bhf_[A-Za-z0-9]{20,}/g],
  ["token", /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g],
  // A whole armoured key block, newlines included
  ["private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g],
];

/**
 * `api_key: sk_live_…`, `OPENAI_API_KEY=…`, `"token": "…"` — a pasted config file. Only the value is replaced; it
 * must be long and unbroken to match, which keeps "password: ask Anna" out of it.
 */
const ASSIGNED = /(\b[A-Za-z0-9_-]*(?:api[_-]?key|secret|token|password|passwd)[A-Za-z0-9_-]*)(\s*[:=]\s*["']?)([A-Za-z0-9_\-./+=]{16,})/gi;

const marker = (what: string): string => `[redacted ${what}]`;

/** *text* with anything that looks like a credential replaced by a marker naming what it was. */
export function redactSecrets(text: string): string {
  if (!text) return text;
  let redacted = text;
  for (const [what, pattern] of SECRETS) redacted = redacted.replace(pattern, marker(what));
  return redacted.replace(ASSIGNED, (_whole, key: string, gap: string) => `${key}${gap}${marker("secret")}`);
}

/** Whether redactSecrets would change *text* — for telling the user their key did not reach the note. */
export function holdsASecret(text: string): boolean {
  return redactSecrets(text) !== text;
}
