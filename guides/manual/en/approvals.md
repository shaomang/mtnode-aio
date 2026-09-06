# Approvals & permissions

Top-right **Approvals** covers:

1. **Permission presets** (sandbox + prompts)  
   - Unattended (default: workspace read/write, no prompts)  
   - Workspace write · approve each  
   - Read-only · approve each  
   - Full access (no directory limit, no prompts)
2. **Tool permissions**: canvas / control / drawing / layout, app actions, files / shell / web / sub-agents, vision. Save custom presets.

**Approve each** shows a card: **Allow once / Deny**. Canvas edits, risky app actions, and vision are hard gates.

The model may also **ask the user** mid-task: a question dialog (“🐋 模型等待你的回应”) appears at the bottom of the screen with all of that round's questions at once — each with its options (**the small line under an option is the model's reason**, the recommended one listed first and marked “（推荐）”), plus a free-text “其他 / Other” box. Answer to let the turn continue; **稍后 / Later** skips it and stops that turn, **中断任务 / Abort** declines the question outright (the tool fails instead of tricking the model with an empty answer). The requirement-grilling skill `mtnode-grill-me` asks through this dialog.
