# Table node (read files · agent builds table)

Used inside a **database node layer**: read the File node wired in, let the agent extract metadata → you confirm the schema form → build the table, one file = one row.

## Ports
- **In**: File node (or file data), several allowed; every file becomes a row.
- **Out**: 1, and it does not pass table data downstream; the built table joins the replica via ⚙ Compile and is queried with `mtnode_db`.

## Settings
- No settings: this node has no **⚙ settings** window. Building runs from the **📋 建表** (build table) button in the node body; afterwards the body shows the column / row preview plus **重新建表** (rebuild) and **打开数据文件** (open the data file).

## Usage
- Open the database node layer, add a File node there and import files; wire that File node into this node.
- Hit **📋 建表**: the agent proposes fields / types → adjust them in “确认表单（建表元数据）” (confirm form — table metadata) → **确认并建表** (confirm and build).
- On the database node layer header click **⚙ Compile (incremental)** so the table enters the replica.

## Notes
- A table belongs to the database layer you placed this node inside; the schema and data are written to that database's sub-folder as `表_<title>.schema.yml` and `.table.csv`.
- If the database layer has no workspace + sub-folder, those two files are not written (the build still produces a result, but nothing reaches the replica).
- Image files first ask “图像「…」需要内容说明，是否进行识图处理？” (does this image need a description — run recognition?); the result fills the description column, otherwise it stays “(未识别)” (not recognised).
