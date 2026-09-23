# Glossary

> One-sentence goal: match common words such as node, port, batch item and thinking effort to what they mean here, in one pass.

## Glossary

- **Node**: the main building block of the canvas (input / process / save / control…).
- **Super node**: packs a set of nodes into a "folder", and inner nodes can be connected through boundary ports.
- **Agent node**: a session-style node that reads and writes files itself and works through several steps.
- **Dev node**: a super node carrying a dev marker, usually standing for one feature module of a software project.
- **Port**: a node's interface.
- **Batch item**: batch input where one run handles exactly one item; "Aggregate mode" means all content goes into one run.
- **Wait for file**: releases downstream only once a certain file exists.
- **Thinking effort**: the length ladder for the model's reasoning chain (None / Light / Standard / Strong / Max); higher costs more and runs slower, but may work better.
- **Preset**: decides the reasoning style through the large model's system prompt.
