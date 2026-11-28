# Workflows & one-sentence builder

Every canvas in MTNode is a reusable **workflow**. Keep separate projects on separate canvases, or describe what you want in one sentence and let the Global assistant build the whole graph for you.

![Build a workflow in one sentence](img/mtnode-agent-01-flow.svg)

## Build a flow in one sentence

Don't want to drag and wire nodes by hand? Open the **Global assistant (✦)** on the right edge of the canvas:

1. Click **✦** at the top right of the canvas.
2. Describe three things in plain words: **what goes in → how to process it → what output you want**.
   - Example: "Build a workflow that takes a product brief, writes a 300-word spoken script, generates voice audio, and renders a captioned vertical Remotion `.mp4`."
   - You can also type `/` in the assistant box and pick the workflow-builder skill for structured templates.
3. The assistant creates the nodes, writes starter prompts, wires them up, and lays them out neatly. Swap in your own inputs and click **▶** to run.

> **Safe edits**: Unless you ask it to remove something, the assistant adds new nodes in open space without disturbing your existing work — and `Ctrl + Z` undoes any change in one step.

## Multi-canvas tabs & view memory

- **Create, rename, switch**: Use the top bar to create, rename, or delete canvases, and switch smoothly via the canvas tab bar.
- **The tab bar keeps your place**: Switching to another canvas and back remembers your exact pan, zoom, and nested node layer so you never lose your spot.
- **Set a project folder**: Pick a workspace folder at the top of each canvas so Save nodes, Agent nodes, Research notes, and the Files sidebar all stay neatly inside that project.

## Import, export & share

- **Export**: Click **Export** on the top bar to save the current canvas as a portable file for backup or teammates.
- **Import**: Click **Import** to open a shared workflow as a new canvas. Any node referencing a model you don't have configured silently switches to **No model** until you pick one on Run.
- **Browse ready-made flows**: Open **Workshop** in the top bar to download community workflow templates or publish your own. See [Workshop & forum](#community).
