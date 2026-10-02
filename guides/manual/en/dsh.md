# What agent mode is

> One-sentence goal: one AI collaboration is one session — see what a session is first, then where sessions come from.

## Session overview

A session = one continuous collaboration with the AI. Behind the side assistant, an agent node and a dev node's buttons, it is always the same kind of session.

Three points:

1. **Sessions have state**: a session remembers what was said before, so “keep changing it” beats describing it all over again — but a bloated session can waste tokens and time instead.
2. **Sessions have switches**: model, preset, thinking effort and tool permissions can all be set to fit the job.
3. **Sessions can read and write files and search the web**: a session can hold file read/write permissions, which is what makes it powerful, and also what puts you at risk if it slips up.

The 示例 · 智能任务（可运行）(Example · agent task, runnable) item on the canvas is one session entry point: change the task description, hit ▶, and watch it read a file, write a file and return only a path.

### Presets

Five presets are shared by sessions and agent nodes (the default is Minimal; **a preset only
sets the persona and the tool surface — it does not touch the thinking level**, which is decided
solely by the Thinking level control in the UI):

| Preset | What it is for |
| --- | --- |
| **Minimal (default)** | Least steps, least talk, straight to the result |
| **Standard** | General purpose: canvas work plus file and content tasks |
| **Lean Thinking** | Work that needs some reasoning: keep the structure, drop restating and prose |
| **PTC** | Multi-step sequencing: break work into checkable next actions |
| **Creative** | Open-ended writing and divergence: room for longer output |

## Where sessions come from

### Four entries

- **The global assistant (✦)**: it sees and changes the canvas in front of you — build a workflow in one sentence, tidy the layout, create nodes. It is mainly for canvas work and is generally not allowed to edit local files.
- **An agent node** (an agent task node, or a text-process node with agent mode on): each run opens a session inside it, right for “read files + several steps + write files”, and it never goes outside the canvas project folder.
- **A dev node's Develop / Refine**: it runs in a new session bound to that block and serves only the project folder that block belongs to, though it may read content outside the project — this suits most development work.

### How to choose

- One question and answer whose result must land on disk → an ordinary text-process node.
- A more complex job along the canvas that reads and writes files by itself → an agent node.
- Changing the canvas itself → the right-hand assistant.
- Programs and software development → use a session directly (close to how Codex is used), or click a dev node's Develop button to create one.

### Ask me first (grill-me · on by default)

**Where:** the first row of the Modes menu above the session input — “Ask me first (grill-me)”.
The right-hand assistant panel has the same switch. It is **on by default**: whenever a round is
judged to be a requirement / development / change request, the agent **asks before acting** — it
maps that round into a decision tree and clears the whole current frontier in one go through
MTNode's question dialog (the “🐋 the model is waiting for you” card): candidates go into the card,
your recommended option comes first and is marked “（推荐）”, and the reason sits on the line below.
Pick an option or write your own; from your answers it recomputes the frontier and asks the next
round, and only starts working once you explicitly confirm there is no ambiguity.

- **Which rounds get grilled:** ones that create or change something (files, the canvas, nodes,
  config, features, plans). Plain Q&A, lookups, explanations, small talk and continuing work you
  already confirmed are done straight away — no string of counter-questions. **When in doubt it does
  not grill** (better to just do the work than to turn an ordinary question into an interrogation).
- **While grilling it does not quietly start:** no implementation plan, no edits. Looking at the
  current state read-only (files, canvas) is allowed, so the questions can be sharp.
- **When it does not grill:** pure mode is on (the whole system prompt is dropped), auto-continue
  rounds, resumed rounds, and module-bound sessions that carry a dev task brief (that brief's own
  grill paragraph is their contract). Your own slash commands (`/plan`, `/compact`, …) are commands,
  not requirements, and are never blocked by a question.
- **Turning it off:** click that row in the same Modes menu (the whole row is clickable). A session
  you switched off stays off across restarts; sessions you never touched count as on. **You can
  always see the state** — a small “Grill me” tag above the input appears while it is on.
- **The right-hand assistant panel** has the same switch, with “Pure mode” next to it; the rules are
  identical to a session (its value is a global preference persisted with the config).

### Turns and cleanup

The top of the conversation area shows one line, “Turn N · HH:MM” — turn N is **how many times you
have sent in this session** (the same number the trajectory view uses). The instant a new turn
starts, the previous turn's *finished* Plan and Task list are cleared automatically (the data is
deleted too, so switching sessions or restarting never brings them back) — that way last turn's
records are not mistaken for what this turn should do. If the previous turn still has **unfinished**
items the panel is kept as is and its header shows “N item(s) left over from the previous turn”;
press Continue in the panel to keep going. While a plan is running, or while the session is paused,
nothing is cleared (you never lose running progress or the Continue button).

