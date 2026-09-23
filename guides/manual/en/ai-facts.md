# AI fact library (a clause library for AI to read)

> One-line goal: the fact library comes in two kinds — the "general fact library" (md documents people read) and the "AI fact library" (minimal clauses AI reads). The AI fact library has an always-visible entry row in the expert team's left column; click it to browse. Agents deposit key conclusions into it while building architecture or workflows, and entries are evicted by hit count and score.

## Two kinds of fact library

### General fact library (team fact library)

Several independent md documents for people + review records + a shared image folder, maintained by experts in conversation; the entry is the last row of the **Experts** list in the team view's left column. See "AI team & roles".

### AI fact library

A minimal clause library for **AI to read**: one thing per entry, a line or a few lines, existing only so the model quickly knows where to look — not a document for people. It sits **side by side, never reading or writing** the general fact library; both live under the same "团队事实库" folder.

### Where to open it

In the expert team view (top bar "专家团"), the left column has an always-visible "**AI 事实库**" row showing the number of confirmed clauses:

1. With no canvas selected / no folder for this canvas, the row shows a placeholder hint;
2. Click the row to open the browse dialog — near full screen, minimizable to the status bar, and it never closes when you click outside (nothing you typed is lost);
3. The count badge covers **confirmed** clauses only.

## How clauses get in

### Agents deposit them automatically

After building project architecture, building or changing a workflow, or settling conventions and paths, the Agent writes the key conclusions (module split, key files and paths, conventions and their sources, ports and data flow, command entry points, known pitfalls) into this library as minimal clauses. The writing discipline is "one thing per entry, a searchable title, body only for information transfer" — the hit counter naturally evicts noise.

### Pending (AI proposals)

What the Agent wants to record but has not settled goes into the "**待确认**" (pending) area at the top of the dialog: confirm or reject them one by one, or all at once. **Pending proposals are not searchable, do not count against the cap, and are never evicted**; confirming one moves it into the library and starts counting.

### Manual add / edit

Click "＋ 新建条例" in the dialog to hand-write one (title + body, plus optional type / tags / source fields for retrieval and traceability); the row's "编辑 / 删除" buttons edit directly. A body over ~200 characters is only a **soft hint** — it is saved anyway.

### Search

The search box at the top filters by title and body (Chinese matches by 2-character sliding windows, English by words). Agents use the same library.

## Scoring and eviction

### Hit counting

Only entries that are **actually consulted** (an Agent's keyword query / fetch by id, or a search in the dialog) gain hits; listing everything, writing, pinning and deleting add nothing. Writing and confirming a clause adds half a point of write weight.

### Score

Score = weight ÷ (1 + days since last hit): the longer nobody looks, the lower it gets. Weight is "read once +1, write once +0.5".

### Eviction rules

- **100 entries** by default (adjustable in the dialog, max 1000);
- Beyond the cap, the **lowest-scoring** entries that are neither pinned nor in their protection window are evicted down to the cap;
- **Pinned (★) entries are never evicted**;
- **New zero-hit clauses get a 7-day protection window** and are not evicted during it (so a fresh clause has a chance to be read);
- Once "pinned + protected" entries already fill the cap, nothing more is evicted and the excess is kept;
- Eviction records stay under "**最近淘汰**" at the bottom of the dialog for review.

## How it differs from the general fact library and the database

| Library | Who reads it | Role |
|---------|--------------|------|
| **AI fact library** | AI (a compact index) | Quickly knows where to look; **not** authoritative |
| **General fact library** (team fact library) | People (experts too) | The written source of team conventions |
| **Database replica** (when a db_replica node is wired in) | AI (live queries with citations) | Authoritative facts |

When they conflict: the **current files** and the **database** win — the AI fact library is only an index that may lag. Agents follow this too and explain the disagreement in their answer.

## Where the files live

`<canvas folder>/团队事实库/AI/ai-facts.json` (a single file, one library per canvas).

- Bound to the canvas: **delete the canvas, rebuild it in the same folder, and the library loads immediately** — no re-entering needed;
- A missing file means an empty library; the file is **created on the first write** (read-only queries and opening the dialog write nothing);
- If the file is corrupted (invalid JSON) it is first backed up as `ai-facts.json.bak` and treated as empty — user data is never silently dropped;
- The dialog always shows the full path at the top, and the "导出…" button saves the whole library as a JSON backup / migration copy.

## What happened to the old "long-term memory"

The old long-term memory (the one in the status bar's memory manager) has been folded into the AI fact library: on the **first load** of this library the old data is imported after de-duplicating by "title + source", keeping the original created / updated times and starting hit counts at zero, with the old database file kept as a backup. From then on, recalling and recording long-term memory happens only in the AI fact library.
