# Project manifest: asset registry & incremental rebuild

A long text-to-video chain rots on consistency: the character turnaround gets a new version while half the
shots still use the old one. The project manifest is the ledger that makes this checkable — which asset is at
which revision, which shot consumes which revision, and what must be rebuilt after a change.

> Naming: this is the **project manifest** (`<canvas working folder>/manifest.json`). The delivery manifest of
> a long-running task lives at `<canvas working folder>/mtnode-deliverables/<uid>/manifest.json` — unrelated.

## What it holds

| Concept | Field | Notes |
| --- | --- | --- |
| Asset | `assets[id]` | character / scene / prop / voice…; `kind`, `files` (project-relative paths), `anchor` (model / seed / LoRA), `deps`, `rev` |
| Shot | `shots[id]` | `assets:["char_lin@3"]`, `deps`, `specRef`, `final`, `candidates`, `qa`, `gen`, `rev`, `stale` |
| Dependency graph | `edges` | derived from shot references (`asset:char_lin@3 → shot:S03_005@1`) plus manual edges |
| Needs review | `needsReview` | assets written outside the art stage (`stage≠"art"`) stay flagged until a human confirms |

## Revisions

- first registration → `rev = 1`;
- registering the same content again (same file bytes + anchor) does **not** bump the revision;
- new file bytes, or a changed anchor / kind / deps → `rev + 1`;
- references are always `id@rev` (`char_lin@3`): a missing asset or an outdated revision is **rejected** when
  you register the shot, with the offending reference named.

## Incremental rebuild

1. an asset changes revision (`asset_set`);
2. only shots that **directly** reference it are flagged `stale`, with the reason (`char_lin 2 → 3`) — no
   transitive spread;
3. `stale_plan` returns the rebuild list (shot id / rev / reason);
4. rebuild those shots and re-register them (`shot_set` pins the new revision and clears stale), or clear the
   flag explicitly with `rebuild_done`.

Nothing runs by itself: the plan is a list, and re-running is a human (or agent) decision.

## Using it

Agents get the tool `mtnode_manifest` with actions `init` / `get` / `asset_set` / `asset_del` / `shot_set` /
`shot_del` / `edge_add` / `edge_del` / `stale_plan` / `validate` / `validate_refs` / `rebuild_done`.
The project root defaults to the canvas working folder (top bar) and can be passed explicitly; with neither it
fails instead of creating a file somewhere.

Generation nodes (`proc_image`, `video_gen`) have an **asset anchoring** block in their ⚙ settings: turn on
"require asset" and the node must declare references such as `char_lin@3`, checked against `manifest.json`
before it runs. Missing / outdated / empty references (plain text-only output) make it refuse to run and name
what is missing. Leaving it off keeps the old behaviour — no migration needed.

## Rules

- assets are written in the art stage (`stage:"art"`); other stages are stored but flagged `needsReview`;
- asset files must be existing project-relative paths (absolute paths and `..` are rejected);
- writes accept `expectRev` as an optimistic lock: a mismatch rejects the write and returns the current rev;
- a `stale` shot's old `final` / `qa` files are outdated — do not deliver them as current.
