# Interface tour

![Layout](img/ui-tour.svg)

## Top bar

- **Workflow / Agent session**: two main views. Workflow is the node canvas; Agent session is a persistent agent chat.
- **Undo / Redo / Duplicate / Fit / Box / Group / Wrap super / Auto layout / Hide wires**
  - **Hide wires** is a toggle: click once to fade every wire (including relationship lines) to 95% transparency so you can read the layout alone; click again to restore. Purely visual — it never touches canvas data or the undo stack; a wire you are dragging and wires linked to the selected node still light up.
- **Settings · API/Config**: providers, agent engine, theme, grid.
- **New / workflow list / Rename / Export / Workshop / Import / Delete**
- Top-right: **Docs** (this manual), **Plugins**, **Approvals**, language — the language you pick is also the agent's *taste*: it converses in it and answers in it; **Update** highlights when a new version exists.

## Canvas

**☰** opens the sidebar: **Current canvas** list above (click to center); **Super node** tree below (click to enter that super). The filter matches titles and subfolders. **✦** opens the global AI assistant (sees canvas state; graph edits ask for confirm).

After entering a task or super, a **breadcrumb** appears for going back.

The status bar shows workflow name, node/wire counts, providers, grid, zoom, and save state. Click `@ms2308` for the author page.
