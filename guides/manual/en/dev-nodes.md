# Dev nodes

Building a real software project inside a single long chat quickly gets tangled. **Dev nodes** let you lay out your codebase as a visual map of modules on the canvas, where each feature block gets its own focused AI session.

![Dev nodes: organizing a software project on the canvas](img/mtnode-app-01-ui.svg)

## What Dev nodes are

A Dev node is a special node layer organized top-down as **Project → Module → File → Class / Interface / Enum**:

- **Clear two-part notes**: Each card separates "What it does" (plain summary) from "How it's built" (implementation notes and core files).
- **One session per block**: Clicking Develop or Refine on a block opens a session bound to that block and its canvas, keeping context clean and saving time and tokens.
- **Right-sized scope**: For a quick 20-line script, just open a regular Agent session — use Dev nodes when structuring a multi-module project.

## Four buttons on each block

- **Suggest**: Have AI inspect the codebase and propose options so you pick the direction first.
- **Develop**: Build files, edit code, and verify changes inside the project root. Inside the Develop dialog you can switch between **Grill-me** (ask clarifying questions first) and **Fast hotfix** (skip heavy ceremony for small, clear fixes) — the two are mutually exclusive.
- **Refine**: Break a module down one level further into files, classes, or interfaces.
- **Open** (File nodes): Open, edit, and save the source file directly inside MTNode's built-in editor.

## Consensus file & inherited settings

- **`AGENTS.md` consensus file**: Lives at your project root and spells out folder conventions, do-not-touch files, and project rules. Every dev session reads it before making edits.
- **Core files list**: Finishing a block records its key output files (up to 10 relative paths) right on the card.
- **Workspace & Files tab**: Set the project root once on the outer project block and nested blocks inherit it. Switch the left sidebar to **Files** to browse and edit project files directly.
- **Agent model / preset / thinking effort**: Configure provider/model, preset, and thinking effort on any block — child blocks inherit each setting independently from the nearest parent. When none is specified, default = 极简 (Minimal), and the preset does not override thinking effort. You can also color-code block frames by functional category.

## How to start

- **New project**: Open the Global assistant and describe what you want to build ("Design a Dev-node architecture for a local photo organizer in Python"). AI confirms key choices, then lays out the project skeleton and `AGENTS.md`.
- **Existing codebase**: Right-click the canvas → **Build workflow** → pick the Dev-node architect skill and point it at your folder to map out the existing structure automatically.
