/**
 * WP7's rules for what a request tells the agent — pure, so no runtime is started.
 *
 * The key name is checked on purpose: the chat view once sent `note`, the runtime reads `active_note`, and the
 * active note silently never reached the model.
 *
 * Run from plugin/:  node tests/run-smoke.mjs <vault path> tests/commands.smoke.ts
 */

import { buildContext, includeLabel, MAX_SELECTION } from "../src/commands/context";

let failures = 0;
function check(what: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "ok  " : "FAIL"}  ${what}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
}

const both = buildContext("Daily/2026-09-27.md", "two lines", true).context;
check("a selection goes with the note's path", both?.active_note === "Daily/2026-09-27.md" && both?.selection === "two lines",
      JSON.stringify(both));
check("the note travels under the protocol's key, active_note", both !== undefined && "active_note" in both && !("note" in both));

const pathOnly = buildContext("Daily/2026-09-27.md", "", true).context;
check("without a selection, only the path", JSON.stringify(pathOnly) === JSON.stringify({ active_note: "Daily/2026-09-27.md" }),
      JSON.stringify(pathOnly));
check("a whitespace-only selection counts as none", buildContext("a.md", "  \n ", true).context?.selection === undefined);

check("unticking Include sends no context at all", buildContext("a.md", "text", false).context === undefined);
check("no note and no selection sends no context", buildContext("", "", true).context === undefined);

const long = buildContext("a.md", "x".repeat(MAX_SELECTION + 5), true);
check("a long selection is cut and says so", long.truncated && long.context?.selection?.length === MAX_SELECTION);

check("the Include label names the selection and the note", includeLabel("Meeting", true) === 'Include the selection and "Meeting"');
check("the Include label names just the note", includeLabel("Meeting", false) === 'Include "Meeting"');
check("with nothing to include there is no box", includeLabel("", false) === "");

console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
