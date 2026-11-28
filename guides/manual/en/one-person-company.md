# AI team & roles

When facing an open-ended decision — product strategy, design review, pricing, or editorial direction — asking a single generic assistant often gives a one-sided answer. **Expert team** (AI team) lets you assemble specialists tied to your current canvas, chat 1-on-1, or run a **Roundtable** discussion and turn the debate into an actionable **advice card**.

## Building your AI team

Open **Expert team** from the top bar. Each team belongs to the active canvas (switching canvases switches teams; deleting a canvas cleans up its team):

### Option 1: Hire manually or from the template library

1. Click **＋ Hire** at the top of the left sidebar.
2. Pick from the **template library** (39 built-in roles such as Research Analyst, Code Reviewer, Product Manager, and Financial Advisor) or start blank.
3. Fill in **name, role and icon**, and outline their prompt (Identity / Goal / Constraints / Output).
4. Pick the expert's **provider, model, preset, thinking effort, and temperature**.

### Option 2: Auto-hire in one sentence

Describe who you need in plain words — for example, "I need a financial advisor focused on cash flow and margins." HR drafts a custom role card from scratch, validates it, and adds the expert once you click **Confirm hire** (saving it to your template library for later reuse).

> **Copy across canvases**: Click **Copy** next to the title to copy your team incrementally to another canvas without overwriting existing members there.

## 1-on-1 chat, Roundtable & advice cards

- **1-on-1**: Click any expert in the sidebar to talk directly, or click **＋** next to their name to start a fresh thread.
- **Roundtable (group chat)**: Click **👥** to start a group chat with 2 or more experts (2–6 keeps focus sharp and token spend reasonable).
  - Each expert answers independently using their own model before seeing others on round 1, avoiding groupthink. Use `@ExpertName` to direct a follow-up.
  - Click **Converge advice** to have a moderator synthesize conclusions, rationale, minority views, open questions, and next steps into an **advice card**.
- **Adopt safely**: Nothing writes to disk until you decide — choose **Adopt as TODOs** (`advice/TODO.md`), **Adopt as decision** (`decisions/`), or **Archive only**.

## Team fact library

At the bottom of the Expert team sidebar sits the **Team fact library** — your project's shared reference shelf (policies, specs, confirmed findings):

- Click **＋** to add a document, or let experts capture confirmed facts during chat; click any row to review or edit.
- Experts check these documents first on factual questions and tell you openly when something isn't documented yet.
- Files are stored as plain Markdown in your canvas workspace under `团队事实库/`, and deleted items go to the system Recycle Bin.
