# Batch, split, merge

![Batch](img/batch.svg)

## Enable batch

Input node **Batch**: text uses ＋ / import / paste YAML (`title: body`); images accept multi-select or a drop of several files.

## Process mode

Process header **Batch / Aggregate**:

- **Batch**: one run per item, many outputs.
- **Aggregate**: all items in one run, one output.

## Split / Merge

- **Split**: extract items into read-only nodes.
- **Merge**: several inputs become one batch for downstream.

Save nodes on a batch chain name files `{filename}_{input title}`. See [Input / process / save](#io-proc).
