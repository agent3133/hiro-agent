/** The context meter as an item in Obsidian's status bar, beside the backlinks count (#151). */

import { contextLine, contextTooltip, type ContextUsage } from "./contextMeter";

export function renderContextStatus(item: HTMLElement, usage: ContextUsage | null): void {
  item.empty();
  item.toggleClass("is-hidden", !usage);
  if (!usage) return;
  const { text, share, level } = contextLine(usage.tokens, usage.window, usage.estimated);
  const track = item.createSpan({ cls: "obsidian-agent-context-track" });
  const fill = track.createSpan({ cls: `obsidian-agent-context-fill mod-${level}` });
  // A CSS variable the stylesheet reads, rather than an inline style (#173)
  fill.setCssProps({ "--obsidian-agent-context-share": `${Math.min(100, share)}%` });
  item.createSpan({ text });
  item.setAttr("aria-label", contextTooltip(usage));
  item.setAttr("data-tooltip-position", "top");
}
