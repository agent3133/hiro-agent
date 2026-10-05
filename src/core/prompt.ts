/**
 * The agent's system prompt with its placeholders filled in.
 *
 * Python renders the prompt as a Jinja2 template (registry/agent_loader.py). The test port fills in plain
 * `{{ name }}` placeholders only — an unknown name renders empty, as Jinja's default Undefined does. Anything more
 * (filters, slices such as `current_date[:7]`, `shell(...)`) is left as written and reported, so the evaluation
 * can count what a full port would need.
 */

import { weekday } from "./dates";

export interface RenderedPrompt {
  text: string;
  /** Expressions the substitution could not evaluate, as written. */
  unsupported: string[];
}

export function promptContext(vaultPath: string, agentName: string, model: string, now = new Date()): Record<string, string> {
  const pad = (n: number): string => String(n).padStart(2, "0");
  return {
    vault_path: vaultPath,
    current_date: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
    // Its own variable, not part of current_date: current_date[:7] is the month (#261)
    current_weekday: weekday(now),
    current_time: `${pad(now.getHours())}:${pad(now.getMinutes())}`,
    agent_name: agentName,
    model,
  };
}

export function renderPrompt(template: string, context: Record<string, string>): RenderedPrompt {
  const unsupported: string[] = [];
  const text = template.replace(/\{\{\s*(.*?)\s*\}\}/g, (whole, expression: string) => {
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(expression)) return context[expression] ?? "";
    // A slice of a placeholder, as Jinja takes it from Python: {{ current_date[:7] }} is the month (weekly-review)
    const slice = /^([A-Za-z_][A-Za-z0-9_]*)\s*\[\s*(-?\d+)?\s*:\s*(-?\d+)?\s*\]$/.exec(expression);
    if (slice) {
      const value = context[slice[1]] ?? "";
      return value.slice(slice[2] === undefined ? 0 : Number(slice[2]), slice[3] === undefined ? undefined : Number(slice[3]));
    }
    unsupported.push(expression);
    return whole;
  });
  if (/\{%.*?%\}/.test(text)) unsupported.push(...(text.match(/\{%.*?%\}/g) ?? []));
  return { text, unsupported };
}
