# Start here

> One-sentence goal: get MTNode running within a few minutes — configure a provider, wire the shortest possible pipeline, and see your first result.

MTNode gathers AI work onto **one visual canvas**: a **node** is a step, a **wire** is the direction data flows. Input (text / image / audio / video), LLM processing, image generation, music and audio/video generation, batch production, task orchestration and agents running errands all live on this graph. Permanently free and open source (MIT license), and workflows export as `.mtnodes` packs you can share.

## Goal

After reading this page you can, within ten minutes, find the entries you need in the interface, configure a text provider with an API key, and produce your first real model output yourself.

## Before you start

- MTNode is installed and running (**no key needed** just to open the interface, add nodes and wire them).
- To actually run with ▶ you need an API key for an OpenAI-compatible provider; image generation / image understanding need their own providers on top of that.

## Steps

1. **Learn the interface**: start with [Where things are](#ui-tour) and get to know all five regions — the top bar, the canvas, the left ☰, the right ✦ and the bottom-left corner.
2. **Configure a provider**: follow [Providers & API](#providers) to enter your key, then confirm on a node header under **⚙ Settings** that the model can be selected.
3. **Wire a pipeline**: follow [Your first flow](#first-run) to add two nodes, connect one wire, write one `@` reference and click ▶.
4. **When you are stuck**: look up your symptom in [Troubleshooting](#troubleshoot) instead of changing the configuration on a hunch.

## The five most-used entry points

| I want to… | Go to | Roughly |
| --- | --- | --- |
| Find the buttons in the interface first | [Where things are](#ui-tour) | 2 minutes |
| Actually make a model run | [Providers & API](#providers) | 5 minutes |
| Produce my first result | [Your first flow](#first-run) | 3 minutes |
| Connect two nodes | [Nodes, wires, @ refs](#nodes-wires) | 3 minutes |
| I'm stuck or it threw an error | [Troubleshooting](#troubleshoot) | look it up by symptom |

## How to reach everything else

The left side of this manual is a **section tree**, with a **filter box** at the top; the filter narrows the left tree by page title and section name only, it **does not search the body text** (for questions about the content, use **Ask (答疑)** in the top-right of a page — it answers from this manual alone and never edits the canvas). Pages link to each other with a title link such as `[Where things are](#ui-tour)`; one click switches pages.

- Want to know **which ports and buttons a node kind has, and how it fails**: right-click that node on the canvas → **Node guide (节点指南)**; this manual covers how the whole application works. Index: [Node guide index](#node-guide).
- Want to know **what a word means**: check the [Glossary](#glossary).
- Want to check **how this manual itself is maintained and regenerated**: see [How this manual is built](#manual-notes).

**Every page of this manual follows the same structure**: Goal → Before you start → Steps → Result → Common mistakes → Next. When you are in a hurry, jump straight to "Steps" and click along; when something goes wrong, come back to "Common mistakes".

> 💡 Tip: on your first time through you only need "Where things are" and "Providers & API"; come back to the other pages when you actually need them — there is no need to read cover to cover.

> ⚠️ Danger: every path in this manual follows your local data directory (on Windows usually `%APPDATA%\pipeline-console\`). The **application folder (install directory / next to the exe) is read-only and never modified** — no user data is ever written there.

## Result

The first real model output appears on screen; and in the section tree on the left you can reach any page beyond the five cards above by section.

## Common mistakes

| Symptom | Cause | Fix |
| --- | --- | --- |
| You do not know which page to start from | The manual has 39 pages | Use only the five cards above; look up the rest when you need them |
| The filter box cannot find a word in the body text | It only filters page titles | Use `Ctrl+F` to search nodes on the canvas, or ask the manual with **Ask** in the top-right |
| Clicking a link says "document not found" | The link was written as a title instead of a page id | Enter via the section tree; a link's target must be a real page id from the manual index, such as `(#ui-tour)` |
| Some pages are in Chinese under the English interface | When a page's English version is missing it falls back to Chinese | Normal, and it does not affect reading |

## Next

- [Where things are](#ui-tour)
- [Providers & API](#providers)
- [Your first flow](#first-run)
