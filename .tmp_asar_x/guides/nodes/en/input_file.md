# File node (batch import)

Used inside a **database super node**: import arbitrary files (csv / txt / json / md / pdf …) into the database subfolder for the **Table** node to build tables.

## How to use
- Only available inside a database super node (its inner right-click menu offers just “File node” and “Table”).
- Drop files or pick several; files are **copied** into the database subfolder (default `db/`), the originals stay untouched.
- Then build a table with a Table node, or click the database node’s header **⚙ Compile** to index them.

## Ports
- **Input**: usually none
- **Output**: file info (list / content) for the Table node or agent nodes

See the manual: [Database nodes](#database-nodes).
