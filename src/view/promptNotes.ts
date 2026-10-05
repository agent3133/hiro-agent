/** The sentences under "Show as sent" (#67): kept apart from the dialog, so they are tested without Obsidian. */

import type { PromptAsSent } from "../inprocess/InProcessAgent";

/** What the preview says about how it was made: one sentence each. */
export function previewNotes(sent: PromptAsSent): string[] {
  const notes = [sent.model ? `For the model ${sent.model}, as the agent's connection names it now.`
    : "No model is named: neither the connection nor its server gives one."];
  if (sent.unsupported.length) {
    notes.push(`Left as written, since the plugin fills in plain placeholders only and runs no commands: `
               + `${sent.unsupported.join(", ")}.`);
  }
  if (sent.mcpFromCache) notes.push("MCP tools as this device last listed them; the servers were not started for this.");
  return notes;
}
