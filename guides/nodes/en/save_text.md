# Save text (merged)

![diagram](img/save_text.svg)

Merged into the unified **Save** node: creating one now builds a `save` node, and an old `save_text` upgrades on load — text still lands through the `.yaml` batch route.

## Ports
- **In**: text.
- **Out**: 1 port = the content saved this run (same as the **Save** node).

## Settings
- Use the **Save** node's set: **⚙ Settings** in the node header holds **Save path** and **Auto-save on input change**.

## Notes
- This kind can no longer be created; see **Save** for the details.
