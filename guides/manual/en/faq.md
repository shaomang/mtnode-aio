# FAQ

> One-sentence goal: match the usual "nothing happened / nothing landed on disk / the bill multiplied" symptoms to their causes, and know where to ask and report.

## Quick FAQ

- Pressing ▶ does nothing: check whether there is upstream input, whether a Wait for file node is holding it back, and whether the provider and its Key are configured.
- Nothing lands on disk: save nodes follow ordinary nodes only; an agent node writes files itself, so do not put a save node after one.
- Downstream did not update: the prompt pastes the body text instead of an `@title`, so re-running upstream never updates it.
- Several images generated / the bill multiplied: text-to-image produces exactly one image per run; for more, use one batch item per image or raise the rolls count.
- Media generation hangs: music and video share one VRAM lock, so only one runs at a time.
- A batch task is unusually expensive: check whether the whole batch of N items is being fed into every run (≈N² calls); use Aggregate mode only when one run really must see everything.
- The error makes no sense: send the error text plus the node title to the assistant in the right-hand panel — it can read the canvas and locate things directly.

## Where to ask and report

### Questions about the canvas

Ask the assistant in the right-hand panel (✦) directly: it can see the canvas in front of you and can edit it too.

### To save effort

Describe "input → processing → output format → where to save" in one sentence, let the assistant build the nodes, and then adjust the parameters yourself.

### The four pieces for a request or a bug report

1. Environment: OS, GPU, VRAM, RAM; local backend or API.
2. The result you want.
3. What actually happened (error text / screenshot).
4. What you already tried.

### When writing a tutorial

Keep every section in the same shape: overview + node description + several usages + a re-runnable example; later iterations change only the body, never the structure.
