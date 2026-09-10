# Your first flow

> One-sentence goal: go from an empty canvas to "model output on screen" in just four steps: add a node → wire it → write an `@` → click ▶.

![Four steps to get started](img/mtnode-start-03-flow.svg)
*Figure 1: add a node → wire it → write an `@` reference → run with ▶; upstream steps that have not run yet are executed recursively first*

## Goal

Read this and follow along once, and you will end up with a canvas holding two nodes and one wire — and **a real model output you produced yourself**.

## Before you start

- You already have a working text provider and API key (see [Providers & API](#providers)). Without a key you can still edit the canvas as usual, but ▶ will report an error.
- Your computer can reach the internet (model calls go over the network).

## Steps

1. **Add an input node**: **right-click on empty canvas** → **Input Node (输入节点)** → **Text (文本)**. Click the title once to rename it.
2. **Fill in content**: click the node to select it and type some material into the body box; clicking elsewhere leaves edit mode.
3. **Add a processing node**: right-click empty canvas → **Process Node (处理节点)** → **Text processing (文本处理)**, and place it to the right of the input node.
4. **Wire them**: press and drag from the text input node's **output port on its right side** to the text processing node's **input port on its left side**; releasing connects them. If it will not connect, the port types usually do not match.
5. **Write a prompt and reference upstream**: click the text processing node to select it, type `@` in the prompt → pick the text node you just wired from the candidates → then add your request (for example "summarize @文本 into three points"). At run time the upstream content goes into "background information" and the prompt goes into "content".
6. **Pick a model**: click **⚙ Settings** on the node header and choose a provider and model; if you do not, the global defaults are used.
7. **Run**: click **▶** on the text processing node. If upstream has not run yet it **runs upstream first automatically**; and once this step finishes, downstream **runs automatically right after**.

> 💡 Tip: click **◈ Preview full request** to see exactly what is about to be sent to the model before spending money on the run.

> ⚠️ Danger: a processing node **runs downstream automatically** when it finishes; if downstream already has content, a prompt appears (Overwrite / Do not continue). On batch chains especially, read that prompt carefully first — choosing wrong will wipe existing results.

## Result

- The text processing node's output panel shows the model's returned text (Markdown is rendered), and the node goes from "running" back to idle.
- The save state in the bottom status bar shows saved; close the app and open it again, and this canvas and its contents are still there.

## Common mistakes

| Symptom | Cause | Fix |
| --- | --- | --- |
| ▶ reports "no provider configured / missing key" | No text provider configured yet | Go to [Providers & API](#providers) |
| The wire will not drag across | Port types do not match (for example an image output into an input that only takes text) | Switch to a node that accepts that type, or turn the content into text first |
| The output contains no upstream content | You forgot to write `@`, or did not confirm an entry from the candidates | Type `@` again and confirm the selected entry |
| Nothing happens after ▶ | Upstream is still running, or it is waiting for your approval / question | Check the run queue in the bottom-left corner and the question window below the screen |
| A result got overwritten | You chose "Overwrite" when downstream ran automatically | Use the tabs on the output panel to look back at other runs, and re-run if needed |
| A path-related error appears | A save node has no path set, or it left the workspace | See [Workspace & archives](#workspace) |

## Next

- [Nodes, wires, @ refs](#nodes-wires)
- [Parameters & runs](#params-runs)
- [Batch, split, merge](#batch)
