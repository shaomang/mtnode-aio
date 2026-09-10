# Database nodes

> One-sentence goal: gather scattered facts into a database super node, compile it into a replica for agent nodes, and let the AI answer only “with something to cite”.

![数据库节点](img/mtnode-agent-11-flow.svg)
*Figure 1: file / table nodes hold the facts → ⚙ compile → a database replica is produced → wire it into an agent node for querying*

## Goal

After this page you can create a database super node, import files such as csv / txt / json / md / pdf and build them into SQLite tables from a form, click ⚙ compile to produce a **database replica**, and wire that replica into an agent node; and you understand that once a replica is connected, the AI has exactly one way to answer questions of fact — query the database, cite the record, and say so when the answer is not there.

## Before you start

- Turn on 测试版本（Beta）(Beta test version) in Settings — the database super node is a Beta feature, and it only appears in the right-click menu once the switch is on.
- Have the files you want to load ready (csv / txt / json / md / pdf …), or an info node you have already built.
- Have a working agent node or agent session (see [Agent task & session](#agent-nodes)) to consume this data.
- Know [Super nodes](#super-nodes): a database node is a kind of super node (`db:true`) that exposes only boundary ports.

## Steps

1. **Turn on Beta**: go to Settings and enable 测试版本（Beta）(Beta test version).
2. **Create the database**: right-click empty canvas → add a **数据库 (Database)** node (default subfolder `db/`).
3. **Import files**: right-click **inside** the database node → **文件节点 (File node)**: drag files in or pick them, and they are **copied** into the database subfolder; the inner right-click offers only these two kinds of node.
4. **Build a table**: inner right-click → **表节点 (Table node)** (reads files · agent builds the table): pick a file → the agent extracts fields / types / primary key and other metadata → **you confirm the form** → the table is built (SQLite / FTS5).
5. **Put facts in**: info nodes can also serve directly as “fact” input inside the database; they go into the index on compile.
6. **⚙ Compile**: click **⚙ 编译 (Compile)** in the node header (**manually triggered only**, incremental): it indexes the subfolder files plus the inner info nodes and creates / refreshes the **database replica** child node (`db_replica`, mirroring the source database and carrying `dbNodeId` / `dbName` / compile time).
7. **Wire it into an agent node**: either of the two ways will do —
   - **Wire**: connect the 数据库副本 (Database replica) to an agent node's input port, and the run prompt automatically injects “database access · mandatory fact constraints”.
   - **`!@` reference**: write `!@数据库标题` in a prompt / task, with no wire needed.
8. **Switch form to debug**: the node header **▤ / ▦** switches between the two forms — **超级节点形态 (super-node form)** ↔ **数据库形态 (database form)** (an embedded console for query / calc / check-for-updates and other debugging).

### The two forms (canvas / console)

- **画布式（超级节点形态）(Canvas form — super-node form)**: arrange file nodes / table nodes / info nodes inside just as in an ordinary super node, and wire them so you can see where the data comes from.
- **控制台（数据库形态）(Console — database form)**: an embedded query box, `calc` computation and a check-for-updates button, for manually verifying one assertion or checking one record without wiring the database into an agent node for a whole run.

### Query discipline (mandatory, engine-injected)

- Every fact comes from the **`mtnode_db`** tool (list / query / get / calc); **filling in from memory is forbidden**.
- A key assertion must carry the provenance `[记录id · 标题] ([record id · title])`; every number and every conclusion in the output must point back to a record.
- **Use `calc` for numeric computation** — no mental arithmetic, and no letting the model do the arithmetic in its head instead.
- Nothing found → answer explicitly “**数据库中没有该信息 (the database does not contain that information)**”; when inference is needed → mark it “此为推断，数据库未记载 (this is an inference, not recorded in the database)”.

> A plain-text (non-agent) node referencing a database only gets the “【数据库：标题】” pointer placeholder — it does not inject content and does not call tools. To have the AI really query the database, you must use an agent node / agent session.

### Compile and maintenance

- The replica header shows the **compile time and record count**, so you can see at a glance whether this replica is current.
- Compiling is **incremental**: only new / changed content is indexed, so repeated compiles are cheap.
- Deleting the source database invalidates the replica (which you can then delete).
- Compiling **never happens automatically** — after changing files, remember to click ⚙ once more.

## Result

- The canvas has one more database super node, with file nodes and tables built from the form inside it.
- The replica child node's header shows the compile time and record count; once you connect it to an agent node, the prompt automatically carries “database access · mandatory fact constraints”.
- Every fact in the agent node's answer carries the `[记录id · 标题] ([record id · title])` provenance; for a question the database cannot answer, it says outright “数据库中没有该信息 (the database does not contain that information)”.
- Switching to the database form lets you verify a piece of data manually with query / calc.

## Common mistakes

| Symptom | Cause | Fix |
| --- | --- | --- |
| There is no 数据库 (Database) in the right-click menu | 测试版本（Beta）(Beta test version) is not on in Settings | Go to Settings and turn the Beta switch on |
| After building a table you cannot find what you just put in | You only imported the files and did not click ⚙ compile | Click ⚙ 编译 (Compile) in the node header to create / refresh the replica |
| The record count on the replica does not update | Compiling is manually triggered | Recompile after every change to files / info nodes |
| The agent node starts answering from impressions | No replica is connected, or only a plain text node is wired | Connect the replica to an **agent** node's input, or write `!@数据库标题` |
| Answers carry no provenance | The prompt does not stress the discipline | Confirm the node is an agent node and the replica really is connected; the engine injects the mandatory constraints automatically |
| After deleting the source database the replica errors | The replica depends on its source database | Delete the invalid replica too, or create the database node again and recompile |
| A number came out wrong | `calc` was not used | Ask it to compute with `calc` and give the result; do not accept mental arithmetic |

## Next

- [Fact library](#fact-library)
- [Super nodes](#super-nodes)
- [Agent task & session](#agent-nodes)
- [Plugins, skills, MCP](#plugins-skills)
