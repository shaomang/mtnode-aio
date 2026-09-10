# Batch, split, merge

> In one sentence: let one input node carry N items, run them either "one run per item" or "all in one run", and know which wiring will not blow up your call count.

![Batch vs aggregate](img/mtnode-flow-04-flow.svg)
*Figure 1: batch (one run per item) versus aggregate (everything fed in at once).*

## Goal

After this page you can turn batch on, pick the right batch / aggregate mode, pull out a single item with a split node, merge several lanes into one batch with a merge node, and make save nodes name files per item.

## Before you start

- A working "input → process → save" chain — see [Input / process / save](#io-proc).
- Knowing that a process node can tune parameters, roll gacha and preview requests — see [Parameters & runs](#params-runs).

## Steps

### 1. Turn batch on at the input node

1. **Click "Batch" in the top-right corner of the input node**.
2. **For text, add items in three ways**: **＋** one at a time / **Import** a file / **Paste YAML**. In YAML it is one item per line, in the form `title: content`:

```yaml
开场白一: 今天下雨了，写一句开场白。
开场白二: 今天是晴天，写一句开场白。
开场白三: 今天刮风了，写一句开场白。
```

3. **Image batch**: multi-select images, or drop several images onto the node at once.
4. **Mind the item titles**: a YAML key is that item's title; image items are named after the source file name remembered when they were loaded. Titles are used by `@` references and by saved file names, and **duplicates are de-duplicated**.

### 2. Choose "Batch" or "Aggregate" on the process node

The process node header has two modes:

- **Batch**: one run per item, each run seeing only that item; many outputs.
- **Aggregate**: all items **fed in at once**; one output.

> ⚠️ Danger: `batch` mode is **one run per item, each run fed only that item**. Never also stuff all N items of the batch into every run — that turns into ≈N² calls, exploding tokens and a bill several times over. Use `agg` only when you really need to see everything at once.

> 💡 Tip: for per-item runs, prefer an ordinary (non-agent) process node; use smart nodes only for aggregate cases where you genuinely need "everything at once" — it saves tokens and stays more predictable.

### 3. Run only one of them: pull out a single item

When you do not want to re-run the whole batch, add a **Split** node: it extracts one item from the batch into a read-only node, so the heavy work (long prompts, image generation, image reading) applies to that one item alone.

![Split and merge](img/mtnode-flow-05-flow.svg)
*Figure 2: a split node pulls out a single item; a merge node gathers several lanes into one batch.*

### 4. Gather several lanes into one batch: the merge node

A **Merge** node collects several inputs into one batch, which downstream then processes as a batch — handy for things like "three sets of material combined into one pass".

### 5. Make save nodes write one file per item

- On a batch chain a save node names files **`{filename}_{input node title}`**, **one file per item**; "auto-save on input change" uses the same naming (YAML items take the input node title).
- A text batch lands as YAML; with several lanes that all have entry field names it is written as a YAML mapping, otherwise the documents are concatenated.
- **Aggregate** mode produces a single file whose keys are the item fields, no longer the node titles.

![Batch per item and aggregate](img/mtnode-flow-04-demo.svg)
*Figure 3: on the left, 3 input items trigger 3 runs one after another; on the right, after switching to aggregate, the 3 items become 1 run (a 3–8 s looping animation; on a slow network or in a degraded mode it falls back to the static image `img/mtnode-flow-04-demo-static.svg`).*

## Result

- One input node carries N items, the process node runs them in the mode you chose, producing N outputs or 1.
- The save folder ends up with N files named per item, or 1 aggregated YAML.
- To re-run, just edit the items and hit ▶ — the chain structure does not change.

## Common mistakes

| Symptom | Cause | Fix |
| --- | --- | --- |
| Call count / tokens several times higher | In batch mode you also fed the whole batch into every run | Feed only that item per run; switch to `agg` only when you truly need everything at once |
| You wanted one item but the whole batch ran | The heavy work sits directly downstream of a batch input | Put a split node in between to extract that item, then wire the process node |
| Aggregate mode produces only one output | `agg` is one run, one output by definition | Switch back to `batch` if you want one output per item |
| Saved files overwrite each other | Item titles are duplicated and still collide after de-duplication | Make the YAML keys / image file names unique |
| Batch image order is not what you expected | Titles come from file names, and load order decides item order | Rename consistently before loading, or switch to text items that reference the images |
| A pasted YAML only brought in one item | The line format is not `title: content`, or the indentation / colon is full-width | Write it line by line as in the example above, separating key and content with a half-width colon |

## Next

- [Parameters & runs](#params-runs)
- [Input / process / save](#io-proc)
- [Tool & function nodes](#tools-functions)
- [Control flow & judges](#control-flow)
- [Save, import/export, workshop](#workflows)
