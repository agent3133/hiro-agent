/**
 * *Find a conversation…* in the chat's ⋯ menu (#412): the kept conversations by title, filtered as you type, which
 * the header's picker — a plain list — cannot be. The one picked opens in the chat.
 */

import { App, FuzzySuggestModal } from "obsidian";

export interface PickedConversation {
  name: string;
  label: string;
}

export class ConversationPicker extends FuzzySuggestModal<PickedConversation> {
  constructor(app: App, private readonly conversations: PickedConversation[],
              private readonly openConversation: (name: string) => void) {
    super(app);
    this.setPlaceholder("Type part of a conversation's title");
  }

  getItems(): PickedConversation[] {
    return this.conversations;
  }

  getItemText(conversation: PickedConversation): string {
    return conversation.label;
  }

  onChooseItem(conversation: PickedConversation): void {
    this.openConversation(conversation.name);
  }
}
