/**
 * From the runtime's config schema to a list of fields — no Obsidian in here, so it can be tested under Node.
 *
 * `GET /config` sends the JSON schema Pydantic makes of `AppConfig`, so a field added to the Python config shows up
 * in the settings without any TypeScript being written. This module reads that schema; `ConfigSections.ts` draws
 * what it returns.
 *
 * Only the shapes Pydantic actually emits are handled: a `$ref` to a nested model, `anyOf [X, null]` for an
 * optional field, an inline `enum` for a `Literal`, and arrays of strings. Anything else — a free-form map such as
 * `mcp_servers` — is reported as a map and left to a hand-written editor rather than guessed at.
 */

import type { JsonSchema } from "../api/types";

export type FieldKind = "boolean" | "integer" | "number" | "string" | "enum" | "list";

export interface ConfigField {
  path: string[];
  label: string;
  kind: FieldKind;
  /** The schema allows null, so an empty input means "not set" rather than an error. */
  nullable: boolean;
  options: string[];
  defaultValue: unknown;
  /** What the file says, or undefined when the file leaves it to the default. */
  value: unknown;
  secret: boolean;
  /** The field's docstring in the Python config, which is the help text shown under it. */
  help: string;
}

export interface ConfigSection {
  path: string[];
  title: string;
  fields: ConfigField[];
  sections: ConfigSection[];
  /** Keys whose value is an open-ended map (`llm_profiles`, `mcp_servers`): not generated, see the module note. */
  maps: string[];
}

export type Parsed = { ok: true; value: unknown } | { ok: false; error: string };

/** Mirrors `SECRET_HINTS` in `config/masking.py`, so both sides agree on which fields never show their value. */
const SECRET_HINTS = ["api_key", "apikey", "secret", "token", "password", "passwd"];

export function isSecretKey(key: string): boolean {
  const lowered = key.toLowerCase();
  return SECRET_HINTS.some((hint) => lowered.includes(hint));
}

/** Sentence case keeps an acronym in capitals: "whisper_cli" is "Whisper CLI", not "Whisper cli" (#108). */
const ACRONYMS: Record<string, string> = {
  api: "API", cli: "CLI", gpu: "GPU", id: "ID", k: "K", llm: "LLM", mb: "MB", mcp: "MCP", p: "P", url: "URL",
};

/** `max_content_length` → "Max content length". */
export function humanize(key: string): string {
  const words = key.replace(/_/g, " ").trim().split(" ").map((word) => ACRONYMS[word] ?? word).join(" ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** The schema a `$ref` points at, or the schema itself. Pydantic only ever refers into `#/$defs/`. */
function deref(schema: JsonSchema, root: JsonSchema): JsonSchema {
  if (!schema.$ref) return schema;
  const name = schema.$ref.split("/").pop() ?? "";
  return root.$defs?.[name] ?? {};
}

/** An optional field is `anyOf: [X, {type: null}]`; answer X, and whether null was one of the choices. */
function unwrapNullable(schema: JsonSchema, root: JsonSchema): { schema: JsonSchema; nullable: boolean } {
  if (schema.anyOf) {
    const choices = schema.anyOf.filter((choice) => choice.type !== "null");
    const nullable = choices.length < schema.anyOf.length;
    if (choices.length === 1) return { schema: { ...deref(choices[0], root), default: schema.default }, nullable };
    return { schema, nullable };
  }
  if (Array.isArray(schema.type)) {
    const types = schema.type.filter((type) => type !== "null");
    return { schema: { ...schema, type: types.length === 1 ? types[0] : types },
             nullable: types.length < schema.type.length };
  }
  return { schema: deref(schema, root), nullable: false };
}

function kindOf(schema: JsonSchema): FieldKind | "object" | "map" | null {
  if (schema.enum) return "enum";
  if (schema.properties) return "object";
  switch (schema.type) {
    case "boolean": return "boolean";
    case "integer": return "integer";
    case "number": return "number";
    case "string": return "string";
    case "array": return schema.items?.type === "string" ? "list" : null;
    case "object": return "map";
    default: return null;
  }
}

/**
 * The fields and sub-sections of one object in the schema, with the file's values beside them.
 *
 * `skip` holds dotted paths drawn elsewhere or not at all — `vault.path`, for one, is chosen by which vault
 * Obsidian has open, and a value typed here would be overridden at every start.
 */
export function buildSection(
  root: JsonSchema,
  schema: JsonSchema,
  values: Record<string, unknown> | undefined,
  path: string[] = [],
  skip: Set<string> = new Set(),
): ConfigSection {
  const section: ConfigSection = {
    path, title: path.length ? humanize(path[path.length - 1]) : "", fields: [], sections: [], maps: [],
  };
  for (const [key, raw] of Object.entries(schema.properties ?? {})) {
    const here = [...path, key];
    if (skip.has(here.join("."))) continue;
    const { schema: field, nullable } = unwrapNullable(raw, root);
    const kind = kindOf(field);
    const value = values?.[key];
    if (kind === "object") {
      section.sections.push(buildSection(root, field, value as Record<string, unknown> | undefined, here, skip));
    } else if (kind === "map") {
      section.maps.push(key);
    } else if (kind) {
      section.fields.push({
        path: here, label: humanize(key), kind, nullable,
        options: (field.enum ?? []).map(String),
        defaultValue: raw.default ?? field.default,
        value, secret: isSecretKey(key), help: raw.description ?? field.description ?? "",
      });
    }
  }
  return section;
}

/**
 * What the user typed, as the value to send — or why it cannot be sent.
 *
 * An empty input sends `null`, which removes the key from the file, so the field falls back to its default. That
 * is the one way to "unset" something, and it keeps the file holding only what the user actually chose.
 */
export function parseInput(field: ConfigField, input: string | boolean): Parsed {
  if (field.kind === "boolean") return { ok: true, value: Boolean(input) };
  const text = String(input).trim();
  if (text === "") return { ok: true, value: null };
  switch (field.kind) {
    case "integer": {
      if (!/^-?\d+$/.test(text)) return { ok: false, error: "a whole number" };
      return { ok: true, value: Number(text) };
    }
    case "number": {
      const value = Number(text);
      if (!Number.isFinite(value)) return { ok: false, error: "a number" };
      return { ok: true, value };
    }
    case "enum":
      return field.options.includes(text) ? { ok: true, value: text } : { ok: false, error: `one of ${field.options.join(", ")}` };
    case "list": {
      const items = text.split(/[\n,]/).map((item) => item.trim()).filter(Boolean);
      return { ok: true, value: items.length ? items : null };
    }
    default:
      return { ok: true, value: text };
  }
}

/**
 * Whether a secret field may take this input. Only an `${ENV}` reference is accepted: the value itself belongs in
 * Obsidian's keychain (Settings → Keychain), never in the settings, which are plain text in the vault.
 */
export function acceptsSecret(input: string): boolean {
  const text = input.trim();
  return text === "" || /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(text);
}

/** The schema of one `llm_profiles` entry — `LLMConfig`, the same model as the `llm` block. */
export function profileSchema(root: JsonSchema): JsonSchema {
  const map = root.properties?.llm_profiles;
  const entry = map && typeof map.additionalProperties === "object" ? map.additionalProperties : {};
  return deref(entry, root);
}

/** The field at a dotted path anywhere under *section*, or undefined. */
export function findField(section: ConfigSection, dotted: string): ConfigField | undefined {
  for (const field of section.fields) if (field.path.join(".") === dotted) return field;
  for (const child of section.sections) {
    const found = findField(child, dotted);
    if (found) return found;
  }
  return undefined;
}

/** Whether a section would draw anything at all once its skipped fields are gone. */
export function isEmpty(section: ConfigSection): boolean {
  return !section.fields.length && !section.maps.length && section.sections.every(isEmpty);
}

/** `["llm", "model"], "x"` → `{ llm: { model: "x" } }` — the partial change `PUT /config` expects. */
export function nest(path: string[], value: unknown): Record<string, unknown> {
  return path.reduceRight<unknown>((inner, key) => ({ [key]: inner }), value) as Record<string, unknown>;
}

/** How a value reads in an input box. Lists are one per line; unset is empty, with the default as placeholder. */
export function display(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (Array.isArray(value)) return value.join("\n");
  return String(value);
}
