# Split

![diagram](img/split.svg)

Picks one item out of a whole batch and hands it downstream as a single item (downstream no longer runs per batch).

## Ports
- **In**: 1 batch; a second wire replaces the old one (a Split node takes only 1 input).
- **Out**: 1 = the selected item (text or image).

## Settings
- No settings: the node header has no **⚙ settings** window. “选择拆出的项” is a dropdown in the node body, which also shows “输入批次共 N 项” and a preview of that item.

## Notes
- Before you pick, the dropdown reads “（请选择）” and the output is empty.
- Content follows the input live: if the source item changes or disappears, this follows, and the output is empty when the chosen title is gone.
