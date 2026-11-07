# Save image (merged)

![diagram](img/save_image.svg)

Merged into the unified **Save** node: creating one now builds a `save` node, and an old `save_image` upgrades on load — images always use `.png`.

## Ports
- **In**: image.
- **Out**: 1 port = the file written last (same as the **Save** node).

## Settings
- Use the **Save** node's set: **⚙ Settings** in the node header holds **Save path**, **Auto-save on input change** and the image-only **Image output** settings.

## Notes
- This kind can no longer be created; see **Save** for the details.
