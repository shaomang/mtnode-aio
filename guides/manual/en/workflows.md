# Save, import/export, workshop

> One-sentence goal: see what each of the five example chains in the canvas's "Quick start" does, and how one sentence lets the global assistant build an editable, one-click re-runnable content pipeline.

![Overview of the five example chains](img/mtnode-canvas-01-flow.svg)

*Figure: the five example chains in the canvas's "Quick start"; each one only needs its input changed and its zone's ▶ re-run.*

## Global assistant & workflows

The "Global assistant & workflows" section demonstrates how one sentence to the global assistant builds an editable, one-click re-runnable content pipeline. It contains 5 examples:

- **① Text processing**: a simple single-chain example that processes text.
- **② Image processing**: a simple single-chain example that processes images.
- **③ Image to copy**: a simple single-chain example that turns an image into copy.
- **④ One-click talking-head video**: a simple single-chain example that produces a subtitled talking-head video in one go.
- **⑤ Complex example**: a complete release package for a single product — an 800-word long intro + short social copy + landscape key visual + square detail close-up + a 15-second short's storyboard/first frame + TTS voice-over + H3 clip, 18 nodes / 33 wires / 7 output files, and the one that costs the most to configure by hand.

Chains ①②③④ are simple single-chain examples generated entirely by MTNode on its own; ⑤'s "shot list → visual prompt → vertical first frame → TTS voice-over → H3 clip" run is genuinely time-consuming to configure by hand. Each zone only needs its input changed and its ▶ re-run.

## ③ Assistant notes · build a workflow in one sentence

### How to make the global assistant build a workflow

1. Click the 【◆】 button in the right sidebar and tell the global assistant: build me a workflow (or type `/` or `、` and pick the workflow-generation tool). Then describe which kind of workflow you need — what the input is (a piece of text / an image / a script file / a product brief), what processing is needed, and so on.
2. Example in one sentence: "/generate-workflow build a subtitled talking-head video workflow from this script: turn the script into a spoken script, then generate speech, then generate a Remotion video, save as mp4".
3. The assistant creates the nodes, the wires and the layout directly on this canvas; you only change the inputs and click the control node ▶.
4. Unless you explicitly ask otherwise, it only adds, and never touches the nodes you already have; `Ctrl+Z` undoes anything you dislike.
5. Workflow generation has no size limit — it can even be used to decompose a novel.
