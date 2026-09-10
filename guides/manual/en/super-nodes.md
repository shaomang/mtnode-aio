# Super nodes

> One-sentence goal: pack a batch of related nodes into one subgraph, leave only a shell on the main canvas, keep editing inside as usual, and tunnel data through the edge ports.

![Super node boundary ports](img/mtnode-canvas-04-state.svg)
*Figure 1: outer ports ↔ inner bridges / sinks — both data and control tunnel through the edge ports, so no inner proxy nodes are needed any more*

## Goal

After reading this you can pack a clump of nodes into a super node, expand the shell or ↪ enter its interior to edit, connect inside and outside data with edge ports, and constrain inner relative paths with a subfolder.

## Before you start

- You have a set of nodes you want to store away. A super node differs from a **task**: a task emphasizes control flow (start → end), while a super node emphasizes **structural storage and data channels**.
- Creating / packing often needs the **canvas_super** approval; when an agent session or the assistant edits the canvas for you it also asks first.

## Steps

1. **Create or merge**: right-click empty canvas → **Super node (超级节点)**; or box-select several nodes and click top-bar **Super (超节点)** (which creates an expanded super node matching the selection's bounding box and packs the selected nodes into it).
2. **Expand the shell**: click the expand icon on the right of the title bar to open the shell's inner stage on the main canvas and edit child nodes directly; click again to collapse. On expand the content is aligned to the stage's top-left corner as far as possible.
3. **Enter the inner canvas**: click **↪ Enter (↪ 进入)** and the screen shows only that super node's interior; use the **breadcrumb** on the toolbar to go back up. Inside the shell you can left-drag empty space to pan, use the wheel to zoom the outer camera, and right-click to add nodes; drag nodes in / out to move them into or out of the shell.
4. **Connect the edge ports**: both data and control tunnel through **edge ports** — outer inputs (wired in from outside while collapsed), inner inputs (on the left side of the expanded shell, or the left edge of the canvas after ↪), inner outputs (inner nodes wired to the shell's right side / the full-screen right edge), and outer outputs (wired out to the outside). Right-clicking a port removes that port's inner wires.
5. **Let control wires pass through the shell**: when an outer port is fed by a control node (a gold command wire), the inner bridge wire with the same number also becomes a control wire (even if it was a data wire before); task pulses and **Run / Clear (执行 / 清空)** batch control tunnel through the port to the other side instead of stopping on the shell.
6. **Set a subfolder**: the right of the title bar lets you set a **subfolder** (relative to the toolbar's working directory). The **relative paths** of inner save / music / video / wait-file nodes then resolve automatically under `working directory / subfolder / …`; when supers are nested, all subfolders along the ancestor chain are used. Packing into a super node or changing the subfolder prefixes existing relative paths — **absolute paths are not rewritten**.
7. **Nesting and layout**: super nodes can nest; when you click top-bar **Layout (排版)** to tidy the main canvas, if super nodes exist that are expanded or contain content, it asks whether to **lay out the inside as well**.
8. **Find them with the sidebar**: the ☰ sidebar has two parts — the upper half lists the current canvas's nodes / tags / drawings (click to center), the lower half is the **super node tree** (listed by nesting level; clicking one enters that super node's canvas and fits its inner nodes). The filter box narrows node, drawing and super node titles / subfolders at the same time.

### Two special modes

| Mode | Entry | Purpose | See |
| --- | --- | --- | --- |
| **Dev node** | Right-click → Dev node (project architecture · feature block) | Software project architecture: module → file → class / interface / enum, bound to a project root directory; header buttons **Suggest / Develop / Refine (建议 / 开发 / 细化)**; relationship wires express dependencies between elements | [Dev nodes](#dev-nodes) |
| **Database node** | Enable **Beta (测试版本)** in Settings, then add from the right-click menu | Fact storage: inner **File node / Table (文件节点 / 表)** → ⚙ Compile → database replica; agent nodes query it with `mtnode_db` | [Database nodes](#database-nodes) |

> 💡 Tip: pack a whole "input → process → save" chain into a super node and expose only one data inlet and one outlet, and the main canvas immediately becomes cleaner; the fewer ports you expose, the easier it is to maintain.

> ⚠️ Danger: when you change a super node's subfolder, **existing relative paths inside are prefixed** — if those files are already on disk, confirm the new path is where you want them before saving.

## Result

Only one shell is left on the main canvas and double-clicking expands it to edit the interior; data flows between inside and outside through the edge ports as expected; and the relative paths of inner nodes automatically carry the subfolder prefix.

## Common mistakes

| Symptom | Cause | Fix |
| --- | --- | --- |
| Inner nodes get no data from outside | The outside wire was not connected to an outer input port, or the inner bridge was not wired to the inner nodes | Both sides must be connected — a super node does no implicit pass-through |
| A data wire became a control wire when it entered the shell | That port is fed by a control node on the outside | This is by design; use another port if you need pure data |
| Inner relative paths landed in a different directory | The subfolder setting is not what you expected | Check the subfolders along the ancestor chain; use an absolute path when you need a fixed location |
| I entered the interior and cannot get out | You are lost | Use the toolbar breadcrumb to go back up |
| The canvas is messier after packing | The shell is expanded | Collapse the shell, or click **Auto layout** to rearrange |
| It asks for the canvas_super approval | The permission preset is strict | Allow it in the approvals panel, or switch to a wider preset |

## Next

- [Box, groups, layout](#marks-groups)
- [Workspace & archives](#workspace)
- [Dev nodes](#dev-nodes)
