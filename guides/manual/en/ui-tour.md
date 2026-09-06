# Interface tour

![Layout](img/ui-tour.svg)

## Top bar

- **Workflow / Agent session**: two main views. Workflow is the node canvas; Agent session is a persistent agent chat.
- **Undo / Redo / Duplicate / Fit / Box / Group / Wrap super / Auto layout / Hide wires**
  - **Hide wires** is a toggle: click once to fade every wire (including relationship lines) to 95% transparency so you can read the layout alone; click again to restore. Purely visual — it never touches canvas data or the undo stack; a wire you are dragging and wires linked to the selected node still light up.
- **Settings · API/Config**: providers, agent engine, theme, grid.
- **New / workflow list / Rename / Export / Workshop / Import / Delete**
- Top-right: **Docs** (this manual), **Asset library** (a local content vault shared across canvases — see [Asset library & asset nodes](#asset-library)), **Plugins**, **Approvals**, language — the language you pick is also the agent's *taste*: it converses in it and answers in it; **Update** highlights when a new version exists.

## Canvas

**☰** opens the sidebar: **Current canvas** list above (click to center); **Super node** tree below (click to enter that super). The filter matches titles and subfolders. **✦** opens the global AI assistant (sees canvas state; graph edits ask for confirm).

After entering a task or super, a **breadcrumb** appears for going back.

The status bar shows workflow name, node/wire counts, providers, grid, zoom, and save state. Click `@ms2308` for the author page.

## Dialogs & panels

- **Every dialog and parameter panel is persistent**: the settings window, asset library, extension manager, YAML / Markdown editors, and the small panels on node headers (matte parameters, aspect-ratio pad settings, and the dev node's agent settings and frame color) — **clicking outside them or on empty canvas never closes them**, so half-typed parameters are never lost. To close: the window's own *Cancel / Done*, the panel's ✕, `Esc`, or clicking the same toggle button again.
- While a panel is open you keep editing the canvas normally; panning or zooming moves the panel back onto its own button, and it only disappears once its host node is gone.
- Two kinds of transient surfaces still dismiss on outside click, by design: **menus** (right-click menu, `@` reference and `/` command candidates, composer dropdowns) and the **image preview lightbox** (`Esc` works there too) — neither holds unsaved input.
- The **image preview lightbox** (click an image in a node, or right-click → *Preview image*) always shows the **original file**: opening it fits the whole picture into the window (image height ≈ window height, no scrolling to see the bottom half). The **wheel** zooms around the cursor, **clicking the image** steps up (`Shift`+click steps down), and once zoomed in you **drag to pan**. The footer carries `－ / percentage / ＋ / Fit / 1:1` — *Fit* returns to the whole image, *1:1* shows native pixels. Zooming makes the browser resample the source file instead of stretching an already-downscaled bitmap, so magnifying stays sharp and downscaling is free of aliasing.
