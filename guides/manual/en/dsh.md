# Agent sessions & permissions

When you want AI to do more than chat — read your project files, write reports, browse the web, or update your canvas — switch to the **Session** view in the top bar.

![Working smoothly in Agent Sessions](img/mtnode-agent-02-ui.svg)

## Getting started in a session

1. **Choose a workspace**: Click **Workspace** above the input box to point the session at a folder (by default it follows your active canvas). File reads and writes stay centered there.
2. **Pick model, preset, and thinking effort**: Click **⚙** to tune how the agent works.
   - **Presets** set style and tool posture (the preset does not touch the thinking level — thinking depth is controlled solely by **Thinking effort**):

| Preset | Best for |
| --- | --- |
| **Minimal (default)** | Fewest steps, least chatter, straight to the result |
| **Standard** | Balanced everyday canvas, file, and writing work |
| **Lean Thinking** | Careful reasoning with crisp, uncluttered output |
| **PTC Mode** | Step-by-step multi-stage execution you can check along the way |
| **Creative** | Open-ended writing and brainstorming with more room to explore |

   - **Thinking effort**: Off / Low / Medium / Standard / High / Max. Low or Medium handles most routine tasks; turn up High for deep reasoning or architecture work.
3. **Attach documents & enable web search**:
   - Click **＋** (or drag PDF, Word, text, or spreadsheet files into the input box) so the model reads them directly and cites exact passages.
   - Turn on **Web search** under **Settings → Agent capabilities** (on by default for official DeepSeek and MTNode Relay) to see clickable source cards and inline citations whenever AI searches online.

## Stay in control while it runs

- **Brief mode (Raw / Brief toggle)**: Long tool runs can look noisy. Switch to **Brief mode** to read a plain-language live summary of what the agent is doing, and expand raw details anytime.
- **Send a message mid-run**: Pressing Send while a turn is running asks whether to **Queue** (run after the current turn) or **⚡ Steer** (deliver immediately at the next step). Start a message with `/btw ` or press `Alt + Enter` to steer right away, or click **⏸ Pause** to hold and resume later.
- **Grill-me (on by default)**: In the **Mode** menu, when you ask to build or modify something complex, the agent first asks a crisp round of multiple-choice questions to clear up ambiguity before touching anything. Simple questions and lookups run directly without extra questions.
- **Trajectory view**: Switch to the **Trajectory** tab at the top of the session to inspect every step on an interactive timeline (drag and scroll to zoom, double-click a row to jump back to that exact spot in chat).
- **Zoom & visual annotations**: Hold `Ctrl + Scroll` inside a session to adjust font size across 10 steps. Highlight any AI reply to leave review notes — and attach screenshots right inside the note card.

## Managing long conversations: Context compaction

When a long chat starts getting heavy or pricey, click **Compact context** (or send `/compact`). After you confirm, older messages and tool results are condensed into one clean summary:

- **Nothing is deleted**: Compacted messages fold neatly in place under a collapsible row so you can always expand and read the original messages, while freeing model memory. Click **View summary** anytime to inspect the summary.
- **Auto-compaction**: Set an automatic trigger threshold (150K / 300K / 450K tokens, or custom) in the model menu, along with how much recent context to keep verbatim.

## Approvals, permissions & safety

Because sessions can edit files, run commands, and access the web, you stay in charge:

- **Approvals panel**: Click **Approvals** (shield icon) at the top right to pick a preset or set per-tool rules (Allow / Ask every time / Block).
- **Confirm before risky actions**: Commands and sensitive writes pause for a clear confirmation card where you approve or reject.
- **Subagent delegation**: Complex tasks can delegate focused sub-tasks to helper subagents so the main thread stays clean. Control the toggle and nesting depth (default 1 level) under **Settings → Agent capabilities → Subagents**.
- **Built-in local audio & video tools**: Ask the agent directly to transcribe audio, draft subtitles, or inspect video frames — it uses local offline speech recognition and frame inspection automatically.
