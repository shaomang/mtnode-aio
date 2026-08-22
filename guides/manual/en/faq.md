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

**Docs assistant says it does not know?**  
It only reads this manual. Use node **Node guide** for one kind, or ask using a sidebar section name.

**Chinese / English?**  
Globe button, top-right. Manual and node guides follow the UI language (Chinese fallback if English is missing).
