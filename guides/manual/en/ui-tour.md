# Where things are

> One-sentence goal: recognize all five regions on screen and know where to switch views, create a canvas, find a node and call the assistant.

![Interface regions](img/mtnode-start-01-ui.svg)
*Figure 1: top bar · central canvas · left sidebar (☰) · right-hand global assistant (✦) · overview map and run queue in the bottom-left corner*

## Goal

After reading this you can locate at a glance: the **top bar (顶栏)** holds view switching and global toggles, the **center** is the canvas, the **left ☰** is the node tree and super-node tree, the **right ✦** is the global assistant, and the **bottom-left corner** is the canvas overview map and the run queue.

## Before you start

- MTNode is installed and running. The first launch **restores your last session**; if the app exited abnormally, you come back to the last autosave or automatic backup.
- You need no provider configured to open the interface, add nodes, wire them and arrange them — only actually clicking ▶ to run needs an API key.

## Steps

1. **Switch views**: the far left of the top bar switches between **Canvas (画布) / Agent session (智能会话) / Expert team (专家团)**. Canvas is node orchestration; Agent session is a persistent agent-task chat; Expert team manages experts per canvas.
2. **Learn the action buttons in the middle of the top bar**: Undo (撤销) / Redo (重做) / Fit (居中) / Box (框选) / Group (组) / Super (超节点) / Auto layout (自动排版) / Hide wires (隐藏线) — **Hide wires** is a purely visual toggle that fades wires to 95% transparency; it does not change canvas data and does not enter the undo stack, while a wire you are currently dragging and wires connected to the selected node still light up.
3. **Manage canvases from the right of the top bar**: New (新建) / Rename (改名) / Import (导入) / Export (导出) / Delete (删除), plus **Plugins (插件) / Asset library (素材库) / Creative Workshop (创意工坊) / Settings (设置)**.
4. **Learn the row in the top-right corner**: Puzzle Games (益智), Docs (文档, this manual), Forum (讨论区), Approvals (审批), Account (账户), Update (更新 — it highlights only when a new version is detected), Language (语言 — 中 / EN, which also decides the language the agent converses in).
5. **Open the left ☰ sidebar**: the upper half is the **current canvas**'s node / tag / drawing list (click a row to center on it), the lower half is the **super-node tree** (click a row to enter its inner canvas and fit its children). The filter box narrows both sides by title and subfolder.
6. **Open the right ✦ assistant bar**: the global assistant can see the canvas state; it asks for confirmation before changing the canvas. Its working scope can be switched to **Global (全局)** to work across canvases.
7. **Look at the bottom-left corner**: the **canvas overview map (画布总览图)** (drag its frame to pan quickly) and the **run queue (运行队列)** (nodes and sessions currently running).
8. **Read the status bar at the bottom**: canvas name, node and wire counts, number of providers, grid, zoom level and save state.

### Every dialog is persistent

The settings window, the asset library, extension management, the YAML / Markdown editor windows, and the small parameter panels on node headers (matte / transparent-background parameters, aspect-ratio pad settings, and the dev node's agent settings and color panel) are all **persistent**: clicking outside the window or on empty canvas **does not** close them, so parameters you have half-edited are never lost. There are only a few explicit ways to close them — the window's own **Cancel (取消) / Done and close (完成并关闭) / OK (确定)** buttons, the ✕ in the panel's top-right corner, `Esc`, or clicking the same button that opened it again. The **only exceptions** are the two kinds of transient menu with no unsaved input: the right-click menu, the `@` reference and `/` command candidates, and the image preview lightbox.

> 💡 Tip: while a panel is open you can still edit the canvas as usual; when you pan or zoom the canvas the panel follows its own button, and it only collapses once the node is deleted.

> 💡 Tip: the image preview lightbox shows the **original file** — the wheel zooms around the cursor, clicking the image steps up the magnification, and you drag to pan; the footer has **Fit window (适应窗口) / 1:1 (1:1)**, and magnifying stays sharp.

## Result

You can say, without looking at the manual, "where do I create a canvas, where do I switch views, where do I find a certain node, where do I call the assistant" — and you know what to press to close any overlay.

## Common mistakes

| Symptom | Cause | Fix |
| --- | --- | --- |
| You click empty canvas and the settings window does not close | Dialogs are **deliberately persistent** so parameters are not lost | Close it with the in-window button, ✕, or `Esc` |
| A node cannot be found | It is filtered out by the ☰ sidebar's filter box | Clear the sidebar filter box |
| There is no **Update** button on screen | It only appears as a highlighted button when a new version is detected | Normal — nothing to do |
| After switching language the agent still speaks the old one | The language "flavor" is sent on each run | Start another run after switching the language |
| A top-bar button is greyed out and will not click | Something is running / you are dragging a wire, or the action needs a selection first | Stop the current action and select the target node |
| You entered a layer and cannot get out | You are inside a super node or a task's inner canvas | Use the **breadcrumb** on the toolbar to go back up |

## Next

- [Providers & API](#providers)
- [Your first flow](#first-run)
- [Find, overview, sidebar](#canvas-tools)
