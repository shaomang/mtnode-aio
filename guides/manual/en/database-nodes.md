# Database nodes (facts → replica → query)

Collect “facts” into a **database super node**, compile a **database replica**, and let agent nodes query with the **`mtnode_db`** tool — grounded, citable answers.

## Create

After enabling “**Beta (test version)**” in Settings, right-click empty canvas to add a “Database” node (default subfolder `db/`).

## Inner structure

Inside a database super node the right-click menu offers only two kinds:

1. **File node** (batch import): drop or pick files, **copied** into the database subfolder (csv / txt / json / md / pdf …).
2. **Table node** (read files · agent builds table): pick a file → the agent proposes fields / types / primary key → **you confirm the form** → build the table (SQLite / FTS5).

## Compile and replica

- Header **⚙ Compile** (manual only, incremental): indexes subfolder files + inner info nodes and creates / refreshes the **database replica** child node.
- Info nodes inside the database also count as facts; they are indexed on compile.

## Agent node access

Either way:

- **Wire**: connect the “Database replica” into an agent node’s input; the run prompt auto-injects the “database grounding” fact discipline.
- **`!@` reference**: write `!@数据库标题` (database title) in the prompt / task, no wiring needed.

## Query discipline (mandatory, engine-injected)

- All facts come from **`mtnode_db`** (list / query / get / calc); never fill from memory.
- Key assertions carry provenance `[record id · title]`; number math goes through `calc`.
- Nothing found → answer exactly “**数据库中没有该信息**”; inference needed → mark “此为推断，数据库未记载”.

> A plain-text (non-agent) node referencing a database only gets the “【数据库：标题】” pointer placeholder — no content injection, no tool calls.

## Debug & maintenance

- Header **▤ / ▦** switches between the super-node form and the **database console form** (embedded query / calc / dirty-check debug tools).
- The replica header shows compile time and record count; deleting the source database makes the replica invalid (can be deleted).
