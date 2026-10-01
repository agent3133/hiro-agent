/**
 * Tools that belong to a Features switch (Settings → Hiro Agent → Features). The switch decides whether the vault
 * allows the feature at all; an agent's tool list decides which agents get it. While a switch is off its tools are
 * not offered to the model — it cannot waste a call on them — and the prompt says what is off and where the user
 * turns it on, so the agent can still answer "can you open this page?" (#145).
 */

type Values = Record<string, unknown>;

/** A switch: where it lives in the settings, whether it is on by default, and its name in the Features tab. */
interface FeatureSwitch {
  path: string[];
  onByDefault: boolean;
  label: string;
  /** What the model is told the switch allows. */
  allows: string;
}

const WEB: FeatureSwitch = { path: ["builtin_tools", "web_fetch", "enabled"], onByDefault: false,
                             label: "Open web pages", allows: "opening web pages" };
const MEMORY: FeatureSwitch = { path: ["memory", "enabled"], onByDefault: false, label: "Memory",
                                allows: "keeping a profile of the user" };

/** Which switch each tool belongs to. */
export const FEATURE_TOOLS: Record<string, FeatureSwitch> = {
  web_fetch: WEB,
  read_user_memory: MEMORY,
  update_user_memory: MEMORY,
};

function isOn(values: Values, feature: FeatureSwitch): boolean {
  let node: unknown = values;
  for (const key of feature.path) node = node && typeof node === "object" ? (node as Values)[key] : undefined;
  return typeof node === "boolean" ? node : feature.onByDefault;
}

/** The tools whose Features switch is off in *values*, with the switch's name. */
export function switchedOffTools(values: Values): Record<string, string> {
  return Object.fromEntries(Object.entries(FEATURE_TOOLS)
    .filter(([, feature]) => !isOn(values, feature)).map(([tool, feature]) => [tool, feature.label]));
}

/** The prompt's paragraph for the tools *listed* that are switched off; empty when none is. */
export function featurePrompt(listed: string[], values: Values): string {
  const off = new Map<string, FeatureSwitch>();
  for (const tool of listed) {
    const feature = FEATURE_TOOLS[tool];
    if (feature && !isOn(values, feature)) off.set(feature.label, feature);
  }
  if (!off.size) return "";
  const lines = [...off.values()].map((feature) => `${feature.allows} is switched off in this vault's settings `
    + `(Settings → Hiro Agent → Features → ${feature.label})`);
  return `\n\n---\n${lines.map((line) => line[0].toUpperCase() + line.slice(1)).join(". ")}. Those tools are not `
    + "available to you now. When the user asks for it, say that it is switched off and where they can switch it "
    + "on — do not claim you cannot do it at all.\n---";
}
