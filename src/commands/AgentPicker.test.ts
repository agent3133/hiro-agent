// @vitest-environment jsdom
// "Ask an agent…" picks an agent from a list (#420, on the obsidian stub): the list holds every agent by its name,
// and choosing one calls back with that agent and closes the picker.
import { describe, expect, it, vi } from "vitest";

import type { AgentSummary } from "../api/types";
import { App } from "../testing/obsidian";

import { AgentPicker } from "./AgentPicker";

const AGENTS: AgentSummary[] = [
  { name: "Hiro", description: "The default helper" },
  { name: "daily-note" },
];

function picker(onChoose = vi.fn<(agent: AgentSummary) => void>()): { picker: AgentPicker; onChoose: typeof onChoose } {
  return { picker: new AgentPicker(new App(".") as never, AGENTS, onChoose), onChoose };
}

describe("AgentPicker", () => {
  it("lists every agent by its name", () => {
    const { picker: list } = picker();
    expect(list.getItems().map((agent) => agent.name)).toEqual(["Hiro", "daily-note"]);
    expect(list.getItemText(AGENTS[0])).toMatch(/^Hiro\b/);
    expect(list.getItemText(AGENTS[1])).toBe("daily-note");
  });

  it("calls back with the agent that is chosen, and closes", () => {
    const { picker: chooser, onChoose } = picker();
    chooser.open();
    (chooser as unknown as { choose(agent: AgentSummary): void }).choose(AGENTS[1]);
    expect(onChoose).toHaveBeenCalledExactlyOnceWith(AGENTS[1]);
    expect((chooser as unknown as { isOpen: boolean }).isOpen).toBe(false);
  });
});
