# AI team & roles

> In one sentence: give one canvas a crew of AI experts — a four-section persona + model + preset + thinking effort + tool permissions, hired by hand or automatically from one sentence, one-on-one chats and 2–6 person roundtables, with the converged advice card adopted into advice/ or decisions/.

## Team overview

### Team overview

Give one canvas a crew of AI experts, then open one-on-one chats or a group chat around that canvas so several experts each have their say before a summary is formed.

### Entry

The **专家团 (Team)** view in the top bar. The team is bound to the current canvas, the title shows the current canvas name, and switching canvases switches the team context automatically.

### How to use it

1. An expert has a complete agent identity: persona (identity / goal / constraints / output format) + model + preset + thinking effort + tool permissions.
2. A one-on-one chat is question and answer; a roundtable (group chat) has 2–6 experts each run a round, and the facilitator finally "converges into advice" and produces an advice card.
3. An advice card writes no file at all before adoption; only when you click "Adopt and create to-dos / Adopt as a decision record" does it land under advice/ or decisions/.

## Team · what it is

### Why a team

The expert team lets you give the AI several identities and talk to you from the standpoint and knowledge base of each one. The same question often gets completely different answers from different experts, covering more ground than ordinary Q&A.

### How it differs from agent sessions and dev nodes

- **Global assistant**: a single session, good for pipelines and canvas orchestration.
- **Dev node**: splits a project by module and iterates, good for software development.
- **Expert team**: several different "personas" each give advice on the same thing. By default it only reads and writes text and never interferes with the project or the canvas.

### Further points

- **A record of the discussion**: once the discussion converges it can be archived into the fact library, which experts can build and the user can revise.
- **Backed by facts**: experts answering factual questions consult this team's fact library first.
- **Minimal clauses for AI to read**: the "AI 事实库" row in the left column is a separate compact index for AI (one thing per entry); agents deposit key conclusions into it automatically while building architecture or workflows, and entries are evicted by hit count and score — see "AI fact library".
- **Converged into advice**: after gathering information and suggestions in a group chat (roundtable), click the "Converge into advice" button at the top right and the AI facilitator writes the whole meeting up as a document.

## Team · assembling and calling it

### Hiring an expert (manual)

1. Enter the **专家团 (Team)** view from the top bar → click ＋ Hire at the top of the left column.
2. Pick one from the template library (**39** built-in preset roles, such as research analyst / code reviewer / product manager / financial advisor) or start from blank.
3. Fill in the name, role and icon.
4. In the **模型 (Model)** area on the right, pick provider / model / thinking effort / preset / temperature.

### Hiring an expert (automatic)

Describe your hiring need in one sentence in the dialog, for example "I want a financial advisor who watches cash flow"; the HR generates a strict JSON role card, and it is written in only after local validation (required fields / length / forbidden content / tool permissions / a valid icon) passes and you click 确认录用 (Confirm hire). A failed validation or a cancellation writes nothing; once hired it is also filed into the template library for one-click reuse next time. That persona card is generated completely from the requirement and never reuses an existing template.

### The four-section prompt

身份 Identity / 目标 Goal / 约束 Constraints / 输出格式 Output.

### Calling it

- **One-on-one**: click an expert in the left column to chat directly; the ＋ on the right of a role row opens a new conversation with that role.
- **Roundtable**: 👥 in the session area creates a group chat; pick two or more participants, and it is not advisable to pick too many at once, to avoid wasting tokens.

### Default permissions

Read files, write files, web search, ask the user; confirm each time: run commands.

### Across canvases

**复制 (Copy)** to the right of the title incrementally copies the current canvas's team to another canvas: it only appends, never deleting or overwriting what the target canvas already has.

## Team · roundtable and advice card

### Roundtable (group chat)

- Create a group chat and pick two or more experts.
- Each round every expert speaks independently in turn, each with its own model. Round 1 is blind to the others, to avoid anchoring and repetition.
- You can **@某位专家 (@ an expert)** to ask a targeted question and keep everyone from repeating the same point.

### Converging into advice

Click **收敛出建议 (Converge into advice)** and the facilitator, doing only a structured aggregation and adding no new opinions, produces an advice card:

Conclusion / rationale / evidence / minority opinions (kept verbatim) / unresolved disagreements / assumptions to verify / next steps.

### Adopting and landing files

- **采纳并生成待办 (Adopt and create to-dos)** → appended to `<workspace>/advice/TODO.md`
- **采纳为决策记录 (Adopt as a decision record)** → writes `<workspace>/decisions/DEC-YYYYMMDD-NN.md` (status = confirmed)
- **仅存档 (Archive only)** → writes no file at all

Advice files produced during the discussion land in `<workspace>/advice/ADV-*.md`.

## Team · the team fact library

### What the fact library is

The fact library holds this project's "sources of truth", so experts answering factual questions have something to check against. Its entry is not on the canvas but on the last row of the **专家 (Experts)** list in the left column of the team view.

### How to use it

1. **New document**: click ＋ New document, always visible on the library row; when an expert finds a stable fact in a conversation it also creates or edits a document automatically, which appears in the left column right away.
2. **List**: the document names and update times are listed below; click a row to open the review window.

### How experts consult the fact library

The fact library automatically tells experts the name and path of every document, and experts decide for themselves whether to consult them. The usual order is: read the most relevant fact-library document first → if that is not enough, check the project content → if still not enough, ask for more with "the fact library does not contain that information".

### Where the fact library files live

`<canvas project folder>/团队事实库/`, where each document has three files: `<document name>.md` (the body), `<document name>.review.json` (the review record) and a shared `assets/`. Deleting moves them to the system recycle bin, where they can be restored from the file manager.
