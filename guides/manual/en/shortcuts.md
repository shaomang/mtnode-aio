# Shortcuts

> One-sentence goal: remember three key groups — **undo/redo / find & replace / select & group** — and look the rest up when you need them.

## Goal

After reading this you can, without leaving the keyboard, do the whole set of "step back, find a node, box-select an area, collapse it into a group, delete and start over" — and drive the `@` reference candidates entirely from the keyboard too.

## Before you start

- Focus is on the canvas, not while you are typing in an input box. When there is a text selection in a node body or prompt input, combinations like `Ctrl+C` go to the system's text handling and do not act on nodes.

## Steps

1. **Remember three groups first**: undo/redo (`Ctrl+Z` / `Ctrl+Y`), find and replace (`Ctrl+F` / `Ctrl+G`), select and group (`Ctrl+left-click` box-select / `G` to group / `Delete` to delete).
2. **Then the two scopes of find**: `Ctrl+F` searches the **current canvas** only, by title and content (a floating bar appears at the top of the canvas); `Ctrl+G` does replace and replace-all.
3. **Finally the single actions**: `Esc` clears the selection or closes transient popups, the wheel zooms, and clicking a node title renames it.
4. **`@` references are fully keyboard-driven**: after typing `@`, `↑` `↓` move the highlight, Enter (or `Tab`) confirms the current entry, `Esc` dismisses; while the menu is open Enter only picks an entry and does not run the node; use `Shift+Enter` for a newline in the body.

| Action | Keys |
| --- | --- |
| Undo | `Ctrl+Z` |
| Redo | `Ctrl+Y` or `Ctrl+Shift+Z` |
| Find nodes (title / content) | `Ctrl+F` (floating bar at the top of the canvas, current canvas only) |
| Replace / Replace all | `Ctrl+G` |
| Copy selected nodes / drawings | `Ctrl+C` (goes to the system copy when text is selected) |
| Delete selection | `Delete` / `Backspace` |
| Group / ungroup | `G` |
| Clear selection / close some dialogs | `Esc` |
| Box select | `Ctrl+left-click` drag, or turn on top-bar **▭ Box (▭ 框选)** and then left-drag |
| Zoom canvas | Mouse wheel |
| Rename node | Click the node title |
| Move / confirm `@` reference candidates | `↑` `↓` / Enter (or `Tab`) |
| Newline in the body (while the `@` menu is open) | `Shift+Enter` |

See [Find, overview, sidebar](#canvas-tools) for the full use of search and replace, and [Nodes, wires, @ refs](#nodes-wires) for the keyboard path through `@` reference candidates.

> 💡 Tip: the `Ctrl+F` floating bar searches the current canvas only; for content inside a super node you have to ↪ enter it first and search there.

> ⚠️ Danger: `Delete` deletes whatever is currently selected. Heavy operations like deleting a canvas or deleting a workflow go through top-bar buttons and a confirmation dialog, so they never fire from a stray `Delete`.

## Result

You can undo, find, box-select, group and delete without looking at the table; and the `@` reference menu can be driven entirely from the keyboard, without touching the mouse.

## Common mistakes

| Symptom | Cause | Fix |
| --- | --- | --- |
| `Ctrl+C` did not copy nodes | There is a text selection in an input box | Click empty canvas to clear the text selection, then copy |
| `Ctrl+F` cannot find a node | It is inside a super node, or in another canvas | ↪ Enter that super node first, or switch to the canvas it is on |
| Enter ran the node | You expected a newline and pressed Enter | While the `@` menu is open Enter only picks an entry; use `Shift+Enter` for a newline |
| `Esc` will not close the settings window | The settings window is a persistent dialog | Close it with its own button or the ✕ |
| Box-select turned into panning | You neither held `Ctrl` nor turned on the top-bar **▭ Box** | Hold `Ctrl` with the left button, or turn the box-select toggle on first |
| The send key does not match your habit | The default differs from what you are used to | Change it in the settings to **Enter to send (Enter 发送)** or **Enter newline + Ctrl+Enter send (Enter 换行 + Ctrl+Enter 发送)** |

## Next

- [Find, overview, sidebar](#canvas-tools)
- [Box, groups, layout](#marks-groups)
- [Where things are](#ui-tour)
