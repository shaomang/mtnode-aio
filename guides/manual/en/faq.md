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

**Agent task wrote the wrong files?**  
Check the workspace; switch Approvals to “approve each” or disable extra tools.

**Docs assistant says it does not know?**  
It only reads this manual. Use node **Node guide** for one kind, or ask using a sidebar section name.

**Chinese / English?**  
Globe button, top-right. Manual and node guides follow the UI language (Chinese fallback if English is missing).
