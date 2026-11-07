# Merge

![diagram](img/merge.svg)

Joins several nodes' results into one batch: each input becomes one item of that batch, for downstream batch processing.

## Ports
- **In**: several wires (text / image content).
- **Out**: 1 = the merged batch (downstream takes one item by its index).

## Settings
- No settings: the node header has no **⚙ settings** window; the body only shows “✓ 已合并 N 项 → 输出为批次” and a read-only item list.

## Notes
- Only text and images are merged; audio / video / files never enter the batch.
- Before anything is wired the body reads “○ 等待输入（每个输入 = 批次中的一项）” and the output is empty.
- As soon as any upstream feeds it, downstream runs per batch — a Merge node's output is always a batch.
