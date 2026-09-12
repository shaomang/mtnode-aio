# What agent mode is

> One-sentence goal: one AI collaboration is one session — see what a session is first, then where sessions come from.

## Session overview

A session = one continuous collaboration with the AI. Behind the side assistant, an agent node and a dev node's buttons, it is always the same kind of session.

Three points:

1. **Sessions have state**: a session remembers what was said before, so “keep changing it” beats describing it all over again — but a bloated session can waste tokens and time instead.
2. **Sessions have switches**: model, preset, thinking effort and tool permissions can all be set to fit the job.
3. **Sessions can read and write files and search the web**: a session can hold file read/write permissions, which is what makes it powerful, and also what puts you at risk if it slips up.

The 示例 · 智能任务（可运行）(Example · agent task, runnable) item on the canvas is one session entry point: change the task description, hit ▶, and watch it read a file, write a file and return only a path.

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
