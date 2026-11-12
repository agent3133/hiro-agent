// @vitest-environment jsdom
// The request dialog every agent command opens before anything runs (#420, on the obsidian stub): what it shows,
// what Enter and the Ask button send, and that Escape, Cancel and closing send nothing.
import { beforeEach, describe, expect, it, vi } from "vitest";

import { App, buttonNamed, settingNamed, ToggleComponent } from "../testing/obsidian";

import { RequestModal, type Request } from "./RequestModal";

const ABOUT = { agent: "Hiro", noteName: "Alpha.md", hasSelection: false };

function open(about = ABOUT): { modal: RequestModal; onSubmit: ReturnType<typeof vi.fn<(request: Request) => void>> } {
  const onSubmit = vi.fn<(request: Request) => void>();
  const modal = new RequestModal(new App(".") as never, about, onSubmit);
  modal.open();
  return { modal, onSubmit };
}

function textarea(modal: RequestModal): HTMLTextAreaElement {
  return modal.contentEl.querySelector("textarea")!;
}

function type(modal: RequestModal, text: string): void {
  textarea(modal).value = text;
}

function press(modal: RequestModal, key: string): void {
  textarea(modal).dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
}

function isOpen(modal: RequestModal): boolean {
  return (modal as unknown as { isOpen: boolean }).isOpen;
}

describe("RequestModal", () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  it("shows the agent's name, a box for the request, and the note's include box", () => {
    const { modal } = open();
    expect(modal.titleEl.textContent).toBe("Ask Hiro");
    expect(textarea(modal).placeholder).toBe("What should it do?");
    expect(settingNamed(modal.contentEl, 'Include "Alpha.md"').components[0]).toBeInstanceOf(ToggleComponent);
    expect(buttonNamed(modal.contentEl, "Ask").buttonEl).toBeTruthy();
    expect(buttonNamed(modal.contentEl, "Cancel").buttonEl).toBeTruthy();
  });

  it("sends what was typed when Enter is pressed, with the note included, and closes", () => {
    const { modal, onSubmit } = open();
    type(modal, "Summarise this");
    press(modal, "Enter");
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith({ message: "Summarise this", include: true });
    expect(isOpen(modal)).toBe(false);
  });

  it("sends what was typed when the Ask button is clicked, and closes", async () => {
    const { modal, onSubmit } = open();
    type(modal, "  Tidy the headings  ");
    await buttonNamed(modal.contentEl, "Ask").click();
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith({ message: "Tidy the headings", include: true });
    expect(isOpen(modal)).toBe(false);
  });

  it("sends include as false when the note's box was unticked", async () => {
    const { modal, onSubmit } = open();
    const box = settingNamed(modal.contentEl, 'Include "Alpha.md"').components[0] as { type(value: boolean): Promise<void> };
    await box.type(false);
    type(modal, "Just the question");
    press(modal, "Enter");
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith({ message: "Just the question", include: false });
  });

  it("sends nothing for an empty request, by Enter or by the Ask button, and stays open", async () => {
    const { modal, onSubmit } = open();
    press(modal, "Enter");
    type(modal, "   ");
    press(modal, "Enter");
    await buttonNamed(modal.contentEl, "Ask").click();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(isOpen(modal)).toBe(true);
  });

  it("sends nothing when Escape is pressed in the box, and leaves the dialog as it was", () => {
    const { modal, onSubmit } = open();
    type(modal, "half a thought");
    press(modal, "Escape");
    expect(onSubmit).not.toHaveBeenCalled();
    expect(isOpen(modal)).toBe(true);
  });

  it("sends nothing when the dialog is closed, and by Cancel", async () => {
    const closed = open();
    type(closed.modal, "never sent");
    closed.modal.close();
    expect(closed.onSubmit).not.toHaveBeenCalled();
    expect(isOpen(closed.modal)).toBe(false);

    const cancelled = open();
    type(cancelled.modal, "never sent either");
    await buttonNamed(cancelled.modal.contentEl, "Cancel").click();
    expect(cancelled.onSubmit).not.toHaveBeenCalled();
    expect(isOpen(cancelled.modal)).toBe(false);
  });
});
