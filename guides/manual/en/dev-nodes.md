# Dev nodes

> One-sentence goal: split a software project into feature blocks on the canvas, then use four buttons to turn the design block by block into real code.

![开发节点：四个按钮与层级](img/mtnode-app-01-ui.svg)

*Figure: a dev node splits a project into feature blocks, and the four buttons on a block are Suggest / Develop / Refine / Open*

## Dev node overview

A dev node = splitting a “software project” into feature blocks (super nodes) on the canvas, one block per module / file / class.

A dev node shows that module's design notes; click the buttons on the card to have the Agent investigate, develop or refine it.

- **Develop** = actually start working on the option you picked: create directories, write files, run verification.
- **Refine** = split this block further down (module → file → class / interface / enum).
- **Open** = file nodes only; open or run that file directly.

### How to use it

1. A block's notes come in two sections: 「功能」(Function) is the short, readable description of what it does, 「实现」(Implementation) is the more precise implementation approach.
2. Build the whole architecture from the top down, then generate dev nodes block by block.
3. Developing on the right node can save tokens and the AI's time searching the project.

### Project directory

In the canvas's left sidebar you can switch to 文件 (Files); once switched you can reach the contents of the canvas directory or the project directory and view and edit them.

## Node description

### What it is

A dev node is a super node carrying the Develop mark: it looks like an ordinary super node, and inside it says “what this module does, how it is implemented, which files it involves”.

### Why use it

- As an anchor between you and the AI: when discussing or changing project code you do not have to describe the target feature block in words.
- One block, one session: each block's investigation / development runs in its own bound session, so contexts never pollute each other.
- Build from the drawing: fill in the model, preset and thinking effort on the block, hit Develop and it starts work from that drawing.

### When it fits

Building a new project's architecture from zero, reverse-engineering an old project, splitting one large requirement into modules that can be developed in parallel.

### When it does not fit

A script of a dozen lines, or a pure copywriting job — opening one session is faster, with no block needed.

## The four buttons and the workflow

### Develop

Actually start on the option you confirmed: create directories, write files, run verification, with the output landing in this block's project root directory.

### Refine

Split the current block one level further down. The drill-down depth is adjustable.

### Open

File nodes only: view / edit this block's file in the in-app Markdown reader.

### Recommended route

1. Develop block by block along the confirmed architecture.
2. After each block, Refine to expose its files and classes.
3. Finish by writing back the core files list and updating AGENTS.md.

## The consensus file

### AGENTS.md

A consensus file is generated in the project root. AGENTS.md holds the directory conventions, the “do not modify” list and every constraint the AI must obey throughout, and every session in the project reads it before starting work. The first-level dev node usually generates an agent.md entry file node that you can read / edit / save right in the app.

### Write-back discipline

Every feature block must end by filling in the real files this module produced in 核心文件 (core files) — at most 10, relative to the project root.

### When things are unclear or the goal is vague

Questions such as module trade-offs and technology choices are put to you by the AI before development starts. For a complex development task it also lists a detailed development checklist first.

## Configuration quick reference

- **项目根目录 (Project root directory)**: the absolute path of the project root. The outermost block fills it in once and child blocks inherit the nearest one; the project root is the agent's workspace root.
- **所属上层 (Parent)**: which layer this block hangs on, decided by the super node it sits in.
- **元素类型 (Element type)**: module / file / class / interface / enum — this decides the nature of the block.
- **模型 + 路由 (Model + route)**: which model this block's sessions use (Suggest / Develop / Refine all use it).
- **预设档 (Preset)**: 极简模式 (Minimal) / 标准模式 (Standard) / 思维精简 (Lean Thinking) / PTC 模式 (PTC) / 创造模式 (Creative) — this decides the persona and the tool surface.
- **思考强度 (Thinking effort)**: 轻 (Light) / 标准 (Standard) / 强 (Strong) / 最强 (Max) — what the UI echoes is what is actually sent.
- **外框颜色 (Frame color)**: taken from the function color card: core runtime / canvas & interaction / AI & agents / data & storage / media & local backends / plugins & ecosystem / build & diagnostics / tests & quality.
- **状态 (Status)**: pending / in progress / done — marks the block's progress.
- **核心文件 (Core files)**: this block's list of core files (≤10 entries, relative to the project root; the outermost project block leaves it empty).
- **关系线 (Relationship wire)**: calls / dependencies between blocks are expressed with relationship wires, which carry no data and take no part in execution.

## Where to start

### Starting a brand-new project

1. Right-click on the canvas and tell the right-hand assistant your goal: “use language X to build something that does Y — set up the dev-node architecture for me”; it asks you about anything uncertain first.
2. The assistant looks over the goal / existing directories and first gives an architecture skeleton covering the whole project (a top-level project block plus module blocks) and the project root's AGENTS.md.
3. You click Suggest on each block to see options and Develop to start; when a block is done, click Refine to drill one level down.
4. As each block finishes, check two things: whether the core files list is written, and whether AGENTS.md is updated.

### Starting from an existing project

Right-click the canvas, choose 构建工作流 (Build a workflow) and use the 开发节点架构师 (Dev-node architect) with the project directory; the AI scans the directory and generates feature blocks along the real directory structure (module → file → class), labelling each block's responsibility and core files.
