# Long-running tasks

Big projects rarely finish in one click — they move through stages like "research → first draft → human review → supply assets → generate visuals → final sign-off." **Long-running tasks** map these stages onto a live flow strip at the top of your canvas: AI handles automated steps and pauses cleanly whenever it needs your approval or files.

![Long-running tasks with human checkpoints](img/mtnode-longtask-flow.svg)

## The task strip at the top of the canvas

Once enabled and bound to a canvas, a status strip appears above the canvas (click to open the stage graph):

- **Clear stage status**: Color badges show which stages are pending, running, waiting for you, completed, or failed.
- **Resizable cards**: Stage cards keep text neatly clipped to card width; drag the bottom-right handle to resize any card and reveal more lines (sizes save with your canvas).
- **Bind / Unbind**: Use **Enable & bind** in task settings to attach a task chain, and **Disable & unbind** whenever you want to turn it off.

## Three dedicated canvas nodes

As a long-running task runs, MTNode places three special nodes inside a tidy container on your canvas automatically:

- **Output node**: Holds text reports, plans, and file references produced by each stage. Click **✎** to edit directly — downstream stages automatically pick up your edits.
- **Delivery node**: Appears when the workflow needs files from you (such as logos, voice clips, or updated tables). Wire files in or click **⬆ Upload** for each slot, then click **Confirm delivery** on the top strip to continue.
- **Artifact node**: Collects finished key deliverables (image thumbnails, text summaries) in one spot, with one-click buttons to open the file (**⇢**) or reveal its folder (**📁**).

## Human approvals & revisions

At an approval checkpoint, the task pauses and shows an approval card:

- Review the Output node, then click **Approve** to advance;
- Or type clear revision feedback and click **Reject** so the previous stage re-runs with your notes.
- **Drafts stay safe**: Unsubmitted rejection notes stay right in the box across background refreshes and clear only when you submit or switch canvases.

## Edit the task chain in plain language

Need to add a review gate or tweak routing mid-project? Open the task-chain editor and tell the assistant what to change in plain words — it updates the stage graph in place while keeping your completed outputs intact.

## Retries, skipping & history

- Failed steps can retry automatically; you can also re-run a single stage, skip past a blocker, or review past runs in the run history panel.
