/**
 * The chat's input box, resized by its top edge (split out of ChatView, #419): pulled up it grows into the
 * conversation, down it shrinks to two lines, a double-click goes back to the default; the height is kept on this
 * device (local storage, not the synced settings).
 */

import type { App } from "obsidian";

/** Where the height is kept on this device: the key it always had, so a kept height survives the move (#419). */
export const INPUT_HEIGHT_KEY = "hiro-agent-input-height";

/** Make *input* resizable by *handle*, up to most of *root*'s height, starting from the height kept last. */
export function resizableInput(app: App, input: HTMLTextAreaElement, handle: HTMLElement, root: HTMLElement): void {
  const apply = (height: number | null): void => {
    if (height === null) input.style.removeProperty("height");
    else input.style.height = `${Math.round(height)}px`;
  };
  const saved = Number(app.loadLocalStorage(INPUT_HEIGHT_KEY));
  if (saved > 0) apply(saved);
  handle.addEventListener("pointerdown", (start) => {
    start.preventDefault();
    // Captured, so the drag goes on outside the thin edge; a pointer that cannot be captured still drags over it
    try {
      handle.setPointerCapture(start.pointerId);
    } catch {
      // no active pointer by that id
    }
    const from = input.getBoundingClientRect().height;
    const style = getComputedStyle(input);
    // Two lines of text, and the padding around them
    const smallest = (parseFloat(style.lineHeight) || 20) * 2 + parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
    const move = (event: PointerEvent): void => {
      // Up makes it taller: the box grows into the conversation above it
      const wanted = from + (start.clientY - event.clientY);
      apply(Math.min(Math.max(wanted, smallest), root.getBoundingClientRect().height * 0.7));
    };
    const stop = (): void => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", stop);
      handle.removeEventListener("pointercancel", stop);
      app.saveLocalStorage(INPUT_HEIGHT_KEY, String(Math.round(input.getBoundingClientRect().height)));
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", stop);
    handle.addEventListener("pointercancel", stop);
  });
  handle.addEventListener("dblclick", () => {
    apply(null);
    app.saveLocalStorage(INPUT_HEIGHT_KEY, null);
  });
}
