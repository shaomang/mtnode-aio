# File node (batch import)

Used inside a **database node layer**: import arbitrary files in bulk into the database subfolder for the **Table** node to build tables.

## Ports
- **In**: 1 data port + one control port at the end (content comes from the imported files; usually left unwired)
- **Out**: 1 = file info (list / content) for the Table node or agent nodes

## Settings
- No ⚙ settings window: adding and clearing live on the node body; compiling is the **⚙** button in the database node's header.

## Usage
- Expand the database node layer and right-click inside it → **File node** (the inner menu only offers "File node" and "Table").
- Click **+ Add file** for a multi-select, or drop files onto the node; files are **copied** into the database subfolder (default `db/`) and the originals stay untouched.
- Build a table with a Table node, or click the database node's header **⚙ Compile** to index them.

## Notes
- With no working directory / subfolder set on the layer, importing reports a failure.
- **Clear all** only empties the node's list; files already copied into the subfolder are not deleted.
