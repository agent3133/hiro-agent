/**
 * The agent's settings checked against their schema (schema.json, first exported from Python) before they are saved — the
 * part of Pydantic's validation the settings rely on: types, enums, required keys, no unknown keys (the config
 * models forbid extras), and `$ref`/`anyOf` as Pydantic writes them.
 */

export interface JsonSchema {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  additionalProperties?: boolean | JsonSchema;
  items?: JsonSchema;
  anyOf?: JsonSchema[];
  enum?: unknown[];
  required?: string[];
  $ref?: string;
  $defs?: Record<string, JsonSchema>;
  [key: string]: unknown;
}

export interface FieldError { path: string; message: string }

function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  return typeof value;
}

function matchesType(value: unknown, type: string): boolean {
  const actual = typeOf(value);
  return actual === type || (type === "number" && actual === "integer");
}

/** Every problem with *value* against *schema*, by dotted path; empty when it is valid. */
export function validate(value: unknown, schema: JsonSchema, root: JsonSchema = schema, path = ""): FieldError[] {
  if (schema.$ref) {
    const name = schema.$ref.replace(/^#\/\$defs\//, "");
    const target = root.$defs?.[name];
    return target ? validate(value, target, root, path) : [];
  }
  if (schema.anyOf) {
    const attempts = schema.anyOf.map((option) => validate(value, option, root, path));
    return attempts.some((errors) => !errors.length) ? [] : attempts.sort((a, b) => a.length - b.length)[0];
  }
  const errors: FieldError[] = [];
  const at = path || "(settings)";
  if (schema.enum && !schema.enum.includes(value)) {
    return [{ path: at, message: `must be one of ${schema.enum.map((v) => JSON.stringify(v)).join(", ")}` }];
  }
  const types = schema.type === undefined ? [] : Array.isArray(schema.type) ? schema.type : [schema.type];
  if (types.length && !types.some((type) => matchesType(value, type))) {
    return [{ path: at, message: `must be ${types.join(" or ")}, not ${typeOf(value)}` }];
  }
  if (typeOf(value) === "object") {
    const object = value as Record<string, unknown>;
    for (const key of schema.required ?? []) {
      if (!(key in object)) errors.push({ path: path ? `${path}.${key}` : key, message: "is required" });
    }
    for (const [key, item] of Object.entries(object)) {
      const where = path ? `${path}.${key}` : key;
      const property = schema.properties?.[key];
      if (property) errors.push(...validate(item, property, root, where));
      else if (schema.additionalProperties === false && schema.properties) {
        errors.push({ path: where, message: "is not a setting" });
      } else if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
        errors.push(...validate(item, schema.additionalProperties, root, where));
      }
    }
  }
  if (typeOf(value) === "array" && schema.items) {
    (value as unknown[]).forEach((item, index) => errors.push(...validate(item, schema.items!, root, `${path}.${index}`)));
  }
  return errors;
}
