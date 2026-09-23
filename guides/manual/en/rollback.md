# Undo & rollback

> One-sentence goal: undo and redo canvas edits with the shortcuts, and remember the safe habits for switching canvases and for big changes.

## Undo / redo / rollback

- `Ctrl+Z` / `Ctrl+Y`: undo and redo canvas edits (renaming, wiring and moving all count).
- `Ctrl+F` opens global search; when the focus is already inside an input field, it instead opens
  the "find in this field" bar, which highlights and jumps to text **within that field**
  (Enter next / Shift+Enter previous / Esc close).
- Actions such as deleting a node or deleting a canvas ask for confirmation first.
- The undo stack belongs only to the canvas in front of you; switch to another canvas and undo does not reach across it.
- Safe habit: copy the canvas before a big change, or save the input text somewhere else.
