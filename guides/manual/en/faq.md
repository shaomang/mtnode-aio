# FAQ & glossary

Hit a snag? Check this quick reference first — most everyday issues take under a minute to solve.

## Quick troubleshooting

| Symptom | Common cause | Fix |
| --- | --- | --- |
| **Clicking ▶ does nothing** | Missing API key, empty upstream input, or blocked by a Wait-for-file node | Check **Settings → Model services** for an active key; confirm upstream nodes have output |
| **Result wasn't saved to disk** | Normal text/image node has no Save node connected | Attach a **Save** node after normal processing nodes (Agent nodes write files themselves) |
| **Upstream edit didn't reach downstream** | Prompt has pasted static text instead of `@NodeTitle` | Replace static text by typing `@` and picking the upstream node |
| **Audio/video node waits in queue** | Local media backends share the GPU one job at a time | Wait for the active job (check **AI working** on the bottom bar), or lower resolution / toggle **Lean** |
| **Batch run cost more than expected** | Whole batch fed into every call | Use **Batch mode** to process items one by one; use **Aggregate mode** only when AI must read everything at once |
| **Imported node shows "No model"** | Original workflow used a provider you haven't set up | Open the node's **⚙ Settings** and pick one of your configured models |
| **Confusing error message** | Network hiccup or parameter mismatch | Paste the error to the Global assistant (**✦**) or ask **Docs Q&A** in this manual |

## Windows "Protected your PC / Unrecognized app" prompt

Right after a brand-new release, Windows SmartScreen may show a blue warning. To launch safely:

1. Click **More info** in the blue dialog.
2. Click **Run anyway** at the bottom.
3. Windows remembers your choice for that version from then on.

## Freeing disk space

Two built-in cleanup tools clear temporary files without touching your work:

- **Global cache**: Open **Settings → Storage & cleanup**, inspect sizes, and clear only what you choose.
- **Plugin output cache**: Open **Plugins**, click **ⓘ** on any plugin card, and clean **Output cache** (**Keep last 7 days** or **Clean all**) without touching model weights or environments.

## Plain-English glossary

- **Node**: One building block on the canvas (Input, Process, Save, Control, etc.).
- **Port**: The small dot on a node's left (input) or right (output) edge where wires connect.
- **Node layer**: A collapsible container holding a group of nodes — double-click to step inside.
- **Agent node**: A node powered by an AI agent that can read files, run multiple steps, and write outputs on its own.
- **Dev node**: A node layer designed for software projects, organized into modules, files, and classes.
- **Thinking effort**: Controls how deeply a model reasons (`Off` to `Max`). Deeper thinking can improve complex answers but takes more time and tokens.
- **Preset**: Sets the agent's working style (default `Minimal` for crisp direct results) without altering thinking effort.
- **Batch vs. Aggregate**: Given multiple inputs, **Batch** runs once per item; **Aggregate** combines everything into one run.
- **W coins**: MTNode account credits used for MTNode Relay models and tipping creators in Workshop/Apps.

## Still need help?

- **Docs Q&A**: Click **Ask** at the top right of this manual to ask questions in plain language.
- **Global assistant**: Click **✦** on the canvas — it can see your flow and help debug it live.
- **Forum**: Sign in and open **Forum** at the top right with your steps and error screenshot.
