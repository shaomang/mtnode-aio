# Common questions

**▶ does nothing / always fails?**  
Read the error on the node. Usual causes: missing API Key, no input wired, image job on a non-vision provider. Use ◈ to preview the request.

**Cannot drag a wire?**  
Press on the port circle, not the title. If an input is taken, disconnect it or use a new port.

**Batch only ran the first item?**  
The process node may be in **Aggregate**. Switch the header to **Batch**.

**Timer ▶ runs downstream immediately?**  
Timer ▶ **arms the alarm**. Pulses fire at the interval. To run now, use a process node or the Run control node.

**Gate never opens?**  
AND waits for **configured** input count; unwired ports still block. Lower the count or wire every port.

**Expanded super shows no children / ports?**  
Use the header expand icon for the shell, or **↪ Enter** for full canvas. Inner ports sit on the shell’s left/right edges (or canvas edges after Enter). See [Super nodes](#super-nodes).

**Saves inside a super land in the canvas root?**  
Set the super’s **subfolder**; relative paths get that prefix. Use absolute paths for other locations. See [Workspace & archives](#workspace).

**Duplicate files while the agent builds the graph?**  
During global-assistant / agent-session canvas edits, save nodes do not write. They flush once when the run finishes (paths already include super subfolders). Leftover older files usually mean a manual ▶ save mid-run.

**Agent task wrote the wrong files?**  
Check the workspace; switch Approvals to “approve each” or disable extra tools.

**Cannot tell thinking from the actual reply while a run is going?**  
Output now renders in chronological segments: **“◉ Thinking · N chars”** collapses the model's private reasoning (N counts reasoning only), what the model says mid-run appears as **normal body text** in its own paragraphs, and **🔧 tool** calls sit inline where they happened. Agent task nodes (chat mode included), agent sessions and the global assistant all render the same way; the node's Thinking overlay keeps reasoning on top, output (tool trace) below. Sessions archived before this change still display the old way. See [What agent mode is](#dsh).

**Docs assistant says it does not know?**  
It only reads this manual. Use node **Node guide** for one kind, or ask using a sidebar section name.

**Does dev-node “Suggest” need the model / network?**  
Yes. The AI does a **read-only** review (project code + module progress) and returns 4 options; results are cached — “view last suggestion” does not re-run, “another batch” does.

**Agent node cannot answer database questions?**  
Make sure the database is attached: wire the **Database replica** into the input, or write `!@数据库标题` in the prompt. If attached but nothing matches, the discipline says to answer “数据库中没有该信息” — never guess.

**Do music / speech / video nodes need a save node after them?**  
No. Minimax Music 3, SoVITS speech and Minimax H3 all carry their own output path (`.wav` / `.mp3` / `.mp4`); adding a save node writes irrelevant content. Only Remotion needs a downstream save node to land its file.

**Network node receives nothing?**  
Check three things: protocol (TCP / UDP), channel id, host/port (defaults in Settings · Network). Confirm the receive node is listening.

**How do I run an execute node?**  
Double-click the node, or click the play button twice; it launches the bound `.exe` / `.bat` or any file via the OS default handler.

**Chinese / English?**  
Globe button, top-right. Manual and node guides follow the UI language (Chinese fallback if English is missing).
