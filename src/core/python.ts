/**
 * Values written the way Python writes them, where the text reaches the model: `json.dumps` with its default
 * separators, and `repr` of lists and dicts. The model then reads the same answer from both runtimes.
 */

/** `json.dumps(value, ensure_ascii=False)`: ", " and ": " between items. */
export function pyJson(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : value > 0 ? "Infinity" : value < 0 ? "-Infinity" : "NaN";
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(pyJson).join(", ")}]`;
  if (typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).map(([k, v]) => `${JSON.stringify(k)}: ${pyJson(v)}`).join(", ")}}`;
  }
  return JSON.stringify(String(value));
}

/** Python's `repr()` of a str: single quotes unless the text holds one and no double quote. */
function reprString(text: string): string {
  const quote = text.includes("'") && !text.includes('"') ? '"' : "'";
  const escaped = text.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t");
  return quote + (quote === "'" ? escaped.replace(/'/g, "\\'") : escaped) + quote;
}

/** Python's `repr()` of what YAML and JSON give: str, int/float, bool, None, list, dict. */
export function pyRepr(value: unknown): string {
  if (value === null || value === undefined) return "None";
  if (typeof value === "boolean") return value ? "True" : "False";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return reprString(value);
  if (Array.isArray(value)) return `[${value.map(pyRepr).join(", ")}]`;
  if (typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).map(([k, v]) => `${reprString(k)}: ${pyRepr(v)}`).join(", ")}}`;
  }
  return reprString(String(value));
}
