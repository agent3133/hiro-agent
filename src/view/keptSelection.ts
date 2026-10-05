/**
 * The note's selection, still shown while the cursor is in the chat (#218).
 *
 * Obsidian draws a selection with the browser's own highlight, which goes as soon as another input has the focus —
 * the editor keeps the selection, and a typed message sends it, but the user no longer sees what will go along. This
 * editor extension marks the selected ranges while the chat has the focus, and drops the marks as soon as the note
 * has it again or its text or selection changes.
 */

import { StateEffect, StateField, type Extension } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView } from "@codemirror/view";

const keep = StateEffect.define<{ from: number; to: number }[] | null>();
const mark = Decoration.mark({ class: "obsidian-agent-kept-selection" });

const kept = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(marks, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(keep)) {
        return effect.value?.length ? Decoration.set(effect.value.map((range) => mark.range(range.from, range.to)), true)
          : Decoration.none;
      }
    }
    // A changed text or selection means the user is back in the note: what was kept no longer is the selection
    return transaction.docChanged || transaction.selection ? Decoration.none : marks;
  },
  provide: (field) => EditorView.decorations.from(field),
});

/** The extension to register with `registerEditorExtension`. */
export const keptSelection: Extension = [
  kept,
  EditorView.focusChangeEffect.of((_state, focusing) => (focusing ? keep.of(null) : null)),
];

/** Mark *view*'s selected ranges as kept; nothing when nothing is selected. */
export function showKeptSelection(view: EditorView): void {
  const ranges = view.state.selection.ranges.filter((range) => !range.empty)
    .map((range) => ({ from: range.from, to: range.to }));
  if (ranges.length) view.dispatch({ effects: keep.of(ranges) });
}
