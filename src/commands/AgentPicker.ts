/** Choose an agent by typing part of its name or description, for "Ask an agent…". */

import { App, FuzzySuggestModal } from "obsidian";

import type { AgentSummary } from "../api/types";

export class AgentPicker extends FuzzySuggestModal<AgentSummary> {
  constructor(app: App, private readonly agents: AgentSummary[], private readonly onChoose: (agent: AgentSummary) => void) {
    super(app);
    this.setPlaceholder("Which agent?");
  }

  override getItems(): AgentSummary[] {
    return this.agents;
  }

  override getItemText(agent: AgentSummary): string {
    return agent.description ? `${agent.name} — ${agent.description}` : agent.name;
  }

  override onChooseItem(agent: AgentSummary): void {
    this.onChoose(agent);
  }
}
