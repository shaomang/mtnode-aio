# Agent nodes & canvas ownership

MTNode gives you three ways to work with an AI agent: the full-screen **Session** view, **Agent nodes** right inside a workflow, and the **Global assistant (✦)** sidebar. Knowing what each owns keeps multiple tasks from stepping on each other.

## Picking the right tool

| What you want to do | Best choice |
| --- | --- |
| A single predictable transform (rewrite, translate, draw) | Regular **Text / Image node** on the canvas |
| An autonomous multi-step stage inside a larger workflow | **Agent task node** (or Text node with Agent mode on) |
| Create or rearrange nodes and wires on a canvas | **Global assistant (✦)** on the right edge |
| Build software, do deep research, or iterate across turns | Full-screen **Session** view (or **Develop** on a Dev node) |

## Which canvas does a session belong to?

A session adopts its canvas **the moment it is created** — whichever canvas is open then, or for sessions launched from a Dev node, the canvas holding that block.

- **Switch canvases freely**: Once a session is running, you can move to another canvas and keep working. That session's graph reads/writes, workspace, and database grounding always stay on **the canvas the session belongs to** — never on the one now on your screen, so it will never overwrite or delete what you're editing elsewhere.
- **Check ownership at a glance**: In the left session list, the `▣` badge beneath each title shows which canvas that session owns.
- **Working across canvases**: A regular session can view and edit **the canvas the session belongs to**, and does not reach across other canvases. When you need to reference or switch across multiple canvases, use the **Global assistant (✦)** and switch its scope to **Global**.

## Tips for Agent nodes on the canvas

- **No Save node required**: Agent nodes write output files directly inside your project folder and pass back paths or summaries.
- **Per-node settings**: Each Agent node can pick its own model, preset, thinking effort, and tool permissions independently.
- **Test in a clean folder first**: When trying a new file-writing Agent node, test it on an empty scratch folder before pointing it at your main project.
