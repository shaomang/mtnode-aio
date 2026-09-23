# Build a flow in one sentence

> One-sentence goal: say one sentence to the global assistant and it builds an editable, one-click re-runnable content pipeline on this canvas — you only change the inputs and click ▶.

![One sentence → the assistant creates and wires nodes → you edit inputs → ▶ re-run](img/mtnode-agent-01-flow.svg)

*Figure: hand one sentence to the right-hand assistant; it builds the nodes, the wires and the layout, and you only edit the inputs and click ▶.*

## ③ Assistant notes · build a workflow in one sentence

### How to make the global assistant build a workflow

1. Click the 【◆】 button in the right sidebar and tell the global assistant: build me a workflow (or type `/` or `、` and pick the workflow-generation tool). Then describe which kind of workflow you need — what the input is (a piece of text / an image / a script file / a product brief), what processing is needed, and so on.
2. Example in one sentence: "/generate-workflow build a subtitled talking-head video workflow from this script: turn the script into a spoken script, then generate speech, then generate a Remotion video, save as mp4".
3. The assistant creates the nodes, the wires and the layout directly on this canvas; you only change the inputs and click the control node ▶.
4. The simple single-chain example workflows on the canvas are generated entirely by MTNode on its own; ⑤ is the complex example — from nothing but a product brief it produces: a long intro + social copy + 2 images + voice-over + a 15-second short (shot list → visual prompt → vertical first frame → TTS voice-over → H3 clip), 18 nodes / 33 wires / 7 output files (the long copy + the two images + the voice-over + the clip), and configuring that by hand is genuinely time-consuming.
5. Unless you explicitly ask otherwise, it only adds, and never touches the nodes you already have; `Ctrl+Z` undoes anything you dislike.
6. Workflow generation has no size limit — it can even be used to decompose a novel.
