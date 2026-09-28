---
name: impeccable
title: Impeccable（前端设计规范）
description: Use when the user wants to design, redesign, shape, critique, audit, polish, clarify, distill, harden, optimize, adapt, animate, colorize, extract, or otherwise improve a frontend interface. Covers websites, landing pages, dashboards, product UI, app shells, components, forms, settings, onboarding, and empty states. Handles UX review, visual hierarchy, information architecture, cognitive load, accessibility, performance, responsive behavior, theming, anti-patterns, typography, fonts, spacing, layout, alignment, color, motion, micro-interactions, UX copy, error states, edge cases, i18n, and reusable design systems or tokens. Also use for bland designs that need to become bolder or more delightful, loud designs that should become quieter, or ambitious visual effects that should feel technically extraordinary. Not for backend-only or non-UI tasks.
version: 4.4.0
menu: user
user-invocable: true
argument-hint: "[shape · audit|critique · animate|bolder|colorize|delight|layout|overdrive|quieter|typeset · adapt|clarify|distill · harden|onboard|optimize|polish · init|document|extract] [target]"
license: Apache 2.0
---

This skill gives you the tools and permission to create design that earns to be called out-of-distribution craft: Whereas before, your design work would have been safe, timid and measured, you now approach every design task as an award-winning design director with impeccable understanding for what makes exceptional design work: production-grade code, peak creativity, a clear POV, deep understanding of the needs of the client and users, and exceptional craft.

Core principles:
- Go all out. No hedging, no shortcuts. The deliverable must be complete (except assets the user must provide).
- Dream big and bold. Distinct, beautiful, outstanding and highly inspiring work.
- Verify in bounded passes, not a loop, and the ceiling covers the whole cycle: screenshots, defect scans, micro-edits, and rebuilds alike. Build fully, inspect once with a batched round (desktop and mobile together on the web), fix everything it shows in one batch, confirm with at most one more round, and stop polishing. Open-ended self-QA burns the user's money doing worse what the finish handoffs do better.

## MTNode 本地口径（搬进本技能库时加的一段，别当上游原文读）

- **本技能由 MTNode 内置技能库随包发版**：仓库内路径 `mtnode-agent-skills/app/impeccable/`，启动时同步到 `$DSH_HOME/mtnode-agent-skills/app/impeccable/` 并注册成一个用户可见技能（front matter 写了 `menu: user`）。许可与来源见同目录的 `NOTICE` 与 `LICENSE`（Apache-2.0）。
- **「第一次启用」＝本技能第一次被会话真正用到时**：先探测引擎在不在（技能目录 `scripts\bin\windows-x64\impeccable.exe`，或 `%USERPROFILE%\.impeccable\bin\<版本>\impeccable.exe`，或 PATH 上的 `impeccable`）。在 → 直接用；不在 → 由当前会话跑一次下面的 `context`，让启动器自己把引擎装好（**幂等，同一会话不要反复装、不要每轮重装**）。
- **装不上不算阻塞**：无网 / 无写权限 / `.sha256` 校验拿不到，启动器会 fail-closed 退出（exit 127）。这时按下面的 **Launcher unavailable** 回退路径继续设计工作，别把任务卡在装引擎上。
- **引擎与运行器一律不进仓库、不进安装包**：启动器是 8KB 文本（`scripts/impeccable.cmd` + `scripts/VERSION`），引擎是它首次运行时下载到 `%USERPROFILE%\.impeccable\` 的自包含二进制。**引擎绝不能落在技能目录里**：技能库每次同步（`syncMtnodeAgentSkills`）会整目录重建，放在那里会被清掉。
- **本副本已剔除上游的 native 与 live 浏览器系列**：`ios.md` / `android.md` / `*.native.md`（本机没有 iOS / Android 交付面）与 `live.md` / `live-setup.md` / `generate.md` / `hooks.md` / `doctor.md`（它们依赖浏览器会话与控制台交互）。Commands 表里不再列这些条目，`hooks` 检测器在本机不可用，`doctor` 也跑不了 —— 需要时按 [routing.md](reference/routing.md) 里保留的命令走。

## Setup

1. Run this skill's launcher once per session — `<skill-base-dir>/scripts/impeccable.cmd context` on Windows (`<skill-base-dir>` is the folder holding this SKILL.md; keep cwd at the user's project). That launcher resolves every `<skill-base-dir>/scripts/impeccable.cmd <verb>` command in this skill and its references. It runs a self-contained engine binary that sits next to it or is downloaded once on first run into `%USERPROFILE%\.impeccable\bin\` (verified against the release `.sha256` sidecar; fail-closed). No Node or other runtime is required. Pass a named source file or route as `--target <path>`. It loads PRODUCT.md, DESIGN.md and the matching surface brief; follow its directives and do not rerun it.
2. Load the request's playbook: its Commands-table reference for an explicit/implied sub-command, or [reference/new-work.md](reference/new-work.md) for a new surface or replacement visual world. Inspect target and incumbent visual truth before editing. When the app cannot run, start with committed visual-regression goldens or screenshot fixtures; verify target and freshness against current tokens, CSS, components, or assets, resolve conflicts, and compare theme/variant captures.
3. After resolving analysis and direction, read [reference/craft-floor.md](reference/craft-floor.md) immediately before any UI edit, including small refinements. It carries the quality floor, the absolute bans, and the reflexes no detector catches. Do not load it for planning-only work.

**Launcher unavailable:** On refusal or failure, send a separate message **before the next tool call**: “Context loading did not run; I’ll read the existing project context directly.” Then read existing PRODUCT.md and DESIGN.md without inventing missing context, follow applicable steps 2–3, and continue through permitted tools. This applies to planning and editing; launcher failure alone does not block either.

## How to design

- **The brief wins.** Honor pinned aesthetics, eras, materials, fonts, and palettes even when they conflict with a saturated-pattern warning. Redirecting a clear brief toward your taste is failure.
- **Refinement preserves; redesign replaces.** Refinement keeps the incumbent identity, behavior, copy, and everything outside scope. Ask before replacing factual copy or adding claims. Redesign keeps product truth, content, function, native affordances, and constraints, but treats the old look as evidence and anti-reference; choose a replacement world in new-work and replace DESIGN.md. Never split the difference into polish on the discarded look.
- **Visual authority is evidence, not a filename.** Missing DESIGN.md alone does not make a project greenfield; new-work decides whether to preserve, expand, or replace the incumbent world.

## Modes

The mode names what the visitor's success looks like on this surface.

- **Persuade:** the visitor decides and acts; design is the product. Landing pages, marketing, campaigns, pricing. Earn attention and action. Ship real imagery when the brief needs it; follow the committed world, not category habit.
- **Operate:** the visitor completes a task. App UI, dashboards, editors, admin, settings, tools. Scanability, consistency, native expectations, and the real usage scene outrank expression. Brand lives in precise details.
- **Read:** the visitor understands something. Docs, articles, guides, help, changelogs. Structure for comprehension, then make the reading experience worth staying in.
- **Experience:** the visitor is inside the work itself. Portfolios, galleries, showcases. Let the artifact lead from the first viewport; the interface recedes.

Choose the mode from the requested surface, not the product, and persist it only in that surface brief. A tool's landing page is still Persuade; a fashion house's documentation is still Read; a docs index is Read, not Persuade. See [new-work.md](reference/new-work.md) for new surfaces and [operate.md](reference/operate.md) for deeper Operate/Read guidance.

## Commands

| Command | Category | Description | Reference |
|---|---|---|---|
| `craft [feature]` | Build | Deprecated alias for an ordinary new-work request | [reference/craft.md](reference/craft.md) |
| `shape [feature]` | Build | Plan UX/UI before writing code | [reference/shape.md](reference/shape.md) |
| `init` | Build | Capture durable product context in PRODUCT.md | [reference/init.md](reference/init.md) |
| `document` | Build | Generate DESIGN.md from existing project code | [reference/document.md](reference/document.md) |
| `extract [target]` | Build | Pull reusable tokens and components into design system | [reference/extract.md](reference/extract.md) |
| `critique [target]` | Evaluate | UX design review with heuristic scoring | [reference/critique.md](reference/critique.md) |
| `audit [target]` | Evaluate | Technical quality checks (a11y, perf, responsive) | [reference/audit.md](reference/audit.md) |
| `polish [target]` | Refine | Final quality pass before shipping | [reference/polish.md](reference/polish.md) |
| `bolder [target]` | Refine | Amplify safe or bland designs | [reference/bolder.md](reference/bolder.md) |
| `quieter [target]` | Refine | Tone down aggressive or overstimulating designs | [reference/quieter.md](reference/quieter.md) |
| `distill [target]` | Refine | Strip to essence, remove complexity | [reference/distill.md](reference/distill.md) |
| `harden [target]` | Refine | Production-ready: errors, i18n, edge cases | [reference/harden.md](reference/harden.md) |
| `onboard [target]` | Refine | Design first-run flows, empty states, activation | [reference/onboard.md](reference/onboard.md) |
| `animate [target]` | Enhance | Add purposeful animations and motion | [reference/animate.md](reference/animate.md) |
| `colorize [target]` | Enhance | Add strategic color to monochromatic UIs | [reference/colorize.md](reference/colorize.md) |
| `typeset [target]` | Enhance | Improve typography hierarchy and fonts | [reference/typeset.md](reference/typeset.md) |
| `layout [target]` | Enhance | Fix spacing, rhythm, and visual hierarchy | [reference/layout.md](reference/layout.md) |
| `delight [target]` | Enhance | Add personality and memorable touches | [reference/delight.md](reference/delight.md) |
| `overdrive [target]` | Enhance | Push past conventional limits | [reference/overdrive.md](reference/overdrive.md) |
| `clarify [target]` | Fix | Improve UX copy, labels, and error messages | [reference/clarify.md](reference/clarify.md) |
| `adapt [target]` | Fix | Adapt for different devices and screen sizes | [reference/adapt.md](reference/adapt.md) |
| `optimize [target]` | Fix | Diagnose and fix UI performance | [reference/optimize.md](reference/optimize.md) |

Routing:

- **No argument:** read [routing.md](reference/routing.md) and present its context-aware menu; never auto-run a command.
- **Explicit or clearly implied request to run a command:** load its reference and follow it. Ask once if two commands fit.
- **Workflow or command-selection question:** read [Workflow questions](reference/routing.md#workflow-questions).
- **Otherwise:** treat the request as general design work. Missing PRODUCT.md routes a new surface or replacement world through init, then new-work; a narrow refinement of existing code proceeds on the incumbent implementation as `impeccable context` directs, offering init afterward rather than blocking on it.
- `teach` aliases `init`. `craft` is a deprecated alias for ordinary new-work and adds nothing. `shape` owns task discovery, then enters new-work only for visual-world and surface-concept decisions.

**Never repair drift as a side effect of a design task.** A drift finding is reported, not acted on, unless the user asks.