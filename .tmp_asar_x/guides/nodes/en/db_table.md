# Table node (read files · agent builds table)

Used inside a **database super node**: read files imported by the **File node**, let the agent extract metadata → **you confirm the schema form** → build the table (SQLite / FTS5).

## How to use
1. First import files with a File node.
2. Add a Table node and pick the file(s) to build from.
3. The agent proposes fields / types / primary key and opens a **confirmation form**; adjust and confirm.
4. The table enters the replica after **⚙ Compile** on the database super node, then agent nodes can query it with `mtnode_db`.

## Ports
- **Input**: file node (or file data)
- **Output**: table data (query results)

See the manual: [Database nodes](#database-nodes).
