# Codex 仓库结构 + 文档地图（盘点笔记）

> 本笔记由并行任务「获取并盘点 Codex 源码与官方文档」产出，供后续深读（安全/批准体系、MCP、TUI 等）共用。
> 快照时间：以抓取时刻 main 分支为准。浅克隆（--depth 1）失败（github.com 443 超时），改从 codeload.github.com 下载 main tarball 解压。源码在 `%TEMP%\codex-review`（无 .git）。

## 1. 顶层结构总览

```
codex/  （仓库根）
├── codex-rs/        Rust workspace（主实现，106 个 crate 目录，workspace members 178 项）★
├── codex-cli/       npm 发布包装 @openai/codex（bin/codex.js + package.json + scripts/）
├── sdk/python/      Python SDK（pyproject/uv/examples/docs）
├── docs/            仓库内文档（15 篇 md，多为官方文档站薄壳，见 §4）
├── tools/           开发工具：buildifier、argument-comment-lint
├── scripts/         打包/安装/检查脚本（codex_package、install、mcp_conformance、format.py…）
├── bazel/           Bazel 扩展/modules/platforms/rules/toolchains
├── patches/         Windows/llvm/v8 等第三方依赖补丁
├── third_party/     powershell、v8、voice、wezterm、wine 等第三方源码
├── .codex/          内置 environments/ 与 skills/
├── .devcontainer/ .github/ .vscode/
└── 根文件：README.md、AGENTS.md、CHANGELOG.md、LICENSE(Apache-2.0)、BUILD.bazel、MODULE.bazel、
    flake.nix、justfile、package.json(pnpm workspace)、pnpm-lock.yaml、ruff.toml 等
```

- 官方入口 README 极简：定位为 OpenAI「本地运行的编码 agent」，IDE 版/桌面版/云端版分流；安装走 chatgpt.com/codex/install.sh(.ps1)、npm `@openai/codex`、brew cask；登录推荐 ChatGPT 计划账号，API key 属附加配置。许可证 Apache-2.0。
- 构建：Bazel（MODULE.bazel）+ Cargo 双轨；codex-rs 根另有 rust-toolchain.toml、Cargo.lock、deny.toml、config.md、default.nix、justfile 帮助脚本。

## 2. codex-rs —— Rust workspace crate 地图

codex-rs 顶层目录**即各 crate**（无 crates/ 子目录），几乎全部 Cargo.toml 无 description，按命名归类：

### 2.1 核心引擎（core 家族）★深读重点
- `core/` 核心 agent 循环（src 下有 agent/、guardian/（含 approval_request.rs）、context/、context_manager/、exec_policy/、sandboxing/、session/、state/、tasks/、tools/、unified_exec/、plugins/ 等模块）
- `core-api/`、`core-plugins/`、`cli/`（主 CLI crate，见 §3）、`codex-api/`、`codex-client/`、`backend-client/`、`chatgpt/`（ChatGPT 后端客户端）、`responses-api-proxy/`
- `protocol/`（含 approvals.rs、mcp_approval_meta.rs —— 跨层批准协议）
- `rollout/`、`rollout-trace/`、`history/`、`message-history/`、`thread-store/`、`agent-graph-store/`、`state/`

### 2.2 执行 / 沙箱 / 安全（safety 主题落点）★深读重点
- `exec/`（exec 实现与批准策略测试 suite）、`exec-server/` + `exec-server-protocol/`（独立执行服务）
- `execpolicy/`（唯一有 description 的 crate：prefix-based Starlark rules for command decisions）
- 沙箱族：`sandboxing/`、`bwrap/`、`linux-sandbox/`、`windows-sandbox-rs/`、`windows-sandbox-service/`、`mxc-sandbox/`
- 加固族：`process-hardening/`、`shell-escalation/`、`shell-command/`
- 工具族：`apply-patch/`、`file-system/`、`file-search/`、`file-watcher/`、`worktree/`、`git-utils/`、`hooks/`、`secrets/`、`keyring-store/`

### 2.3 认证 / 后端 / 网络
- `login/`、`aws-auth/`、`workload-identity/`、`model-provider/`、`model-provider-info/`、`models-manager/`
- `lmstudio/`、`ollama/`、`cloud-config/`、`cloud-tasks/`(+client/mock-client)、`connectors/`、`network-proxy/`、`http-client/`、`websocket-client/`、`realtime-webrtc/`、`stdio-to-uds/`、`uds/`、`otel/`、`otel-trace-websocket/`

### 2.4 MCP / 插件 / 技能  ★深读重点（MCP 主题）
- `codex-mcp/`（MCP 接口定义 crate）、`mcp-server/`（MCP server 实现，src 含 exec_approval.rs、patch_approval.rs）、`rmcp-client/`
- `plugin/`、`ext/`（extension-api 含 contributors/approval_review.rs、guardian-v2 含 async_scorer/approval.rs）、`skills/`、`prompts/`
- `code-mode/`(+host/protocol/runtime)、`collaboration-mode-templates/`、`external-agent-migration/`

### 2.5 TUI / 应用 / 桌面  ★深读重点（TUI 主题）
- `tui/`（终端 UI 主 crate，见 §3 模块摘录）、`app-server/`(+client/daemon/protocol/transport/test-client/noop-macros)
- `desktop_app`（在 cli/src 下）、`terminal-detection/`、`ansi-escape/`、`v8-poc/`、`voice-host/`

### 2.6 基础设施 / 杂项
- `utils/`（含 cli/src/approval_mode_cli_arg.rs —— 批准模式 CLI 参数）、`async-utils/`、`analytics/`、`diagnostics/`、`features/`、`feedback/`、`agent-identity/`、`agent-roles/`、`attachment-store/`、`codex-home/`、`config/`+`config-schema/`、`install-context/`、`build-info/`、`arg0/`、`test-binary-support/`、`thread-manager-sample/`、`guardian-context/`、`response-debug-context/`、`context-fragments/`、`memory 相关 memories/`
- `vendor/`：bubblewrap（Linux 沙箱二进制）

## 3. cli crate（codex 主程序）与 tui

- `codex-rs/cli/Cargo.toml`：package name `codex-cli`；`[[bin]] codex → src/main.rs`（另有 logs_client）。
- cli/src 顶层：app_cmd.rs、mcp_cmd.rs、plugin_cmd.rs、queue_cmd.rs、remote_control_cmd.rs、marketplace_cmd.rs、login.rs、sandbox_setup.rs、exec_server_auth.rs（含 tests）、debug_sandbox.rs、doctor.rs、migrate_rollouts.rs、wsl_paths.rs、state_db_recovery.rs、exit_status.rs + bin/、desktop_app/、snapshots/ 子目录。
- tui crate（`codex-rs/tui/`）模块摘录（与批准/安全直接相关者加粗）：
  - app/、chatwidget/、bottom_pane/（**approval_overlay.rs**、pending_thread_approvals.rs）、history_cell/（**approvals.rs**）、exec_cell/、custom_terminal/、keymap/、markdown_render/、render/、streaming/、status/、pager_overlay/、inline_visualization/、pets/、onboarding/、session 相关一组
  - **approval_events.rs**、**app_server_approval_conversions.rs**、**app/file_change_approvals.rs**、auto_review_denials.rs、permission_discovery.rs、windows_sandbox.rs、cli.rs、app.rs、slash_command.rs、vim_search.rs、updates.rs、collaboration_modes.rs、multi_agents.rs 等

## 4. 文档地图

### 4.1 官方文档（权威、最新，仓库 md 多为它的跳板）
主站 **https://developers.openai.com/codex**，子页含：cli、auth(登录/API key)、config-basic / config-advanced、config-sample、noninteractive(exec)、exec-policy、security(sandboxing & approvals)、skills、slash-commands、guides/agents-md、codex/ide。仓库 README/docs 中 md 与子页一一对应。

### 4.2 仓库 docs/（15 篇）
| 文件 | 性质 |
|---|---|
| config.md | 薄壳 → developers.openai.com/codex/config-basic + config-advanced |
| example-config.md | 薄壳 → config-sample |
| authentication.md | 薄壳 → codex/auth |
| getting-started.md | 薄壳 → cli/features |
| exec.md | 薄壳 → noninteractive |
| execpolicy.md | 薄壳 → exec-policy |
| sandbox.md | 薄壳 → security（沙箱与批准） |
| skills.md | 薄壳 → codex/skills |
| slash_commands.md | 薄壳 → cli/slash-commands |
| agents_md.md | 薄壳 → guides/agents-md |
| contributing.md | 实际内容：社区贡献指引（bug 报告/根因分析/feature 请求） |
| install.md | 实际内容：系统要求 + 从源码构建步骤（Rust 工具链、nextest、justfile helpers、Bazel） |
| CLA.md | 个人贡献者许可协议（Apache 基金会模板） |
| license.md | Apache-2.0 说明 |
| open-source-fund.md | 开源资助计划（$1M API credits） |

### 4.3 代码内/专项文档（主题型深读时优先）
- `codex-rs/docs/`：bazel.md、**codex_mcp_interface.md**（MCP 接口）、**protocol_v1.md**（内部协议 v1）
- `codex-rs/config.md`（workspace 级配置说明）、根 AGENTS.md（仓库协作共识，README 用）、docs/agents_md.md 对应 AGENTS.md 机制
- `.codex/`：内置 environments/ 与 skills/（技能落地）
- 沙箱说明散布于各沙箱 crate（bwrap/linux-sandbox/windows-sandbox-rs/mxc-sandbox）与 core/src/sandboxing、cli/src/sandbox_setup.rs、debug_sandbox.rs

### 4.4 主题 → 落点速查（供两路深读）
- **approvals（批准）**：core/src/tools/approvals.rs(+tests)、core/src/tools/network_approval.rs、core/src/guardian/approval_request.rs、core/src/tools/handlers/permission_preapproval*.rs、core/src/context/approved_command_prefix_saved.rs、core/src/unified_exec/stdin_approval.rs、protocol/src/approvals.rs + mcp_approval_meta.rs、tui（approval_overlay / approval_events / file_change_approvals）、utils/cli/src/approval_mode_cli_arg.rs、ext/extension-api + guardian-v2（approval_review）、exec/tests/suite/approval_policy.rs、core/tests/suite/approvals.rs
- **safety/sandbox/exec-policy**：sandboxing、bwrap、linux-sandbox、windows-sandbox-rs(+service)、mxc-sandbox、process-hardening、shell-escalation、execpolicy、exec(+server)、core/src/exec_policy.rs、docs/execpolicy.md
- **MCP**：codex-mcp、mcp-server、rmcp-client、cli/src/mcp_cmd.rs、config/src/mcp_types.rs+mcp_edit.rs+mcp_requirements.rs、codex-rs/docs/codex_mcp_interface.md、tui/src/dynamic_tools_mcp.rs
- **TUI**：tui crate（cli.rs/app.rs/session_*/approval_overlay 等）、codex-rs/tui/src/cli.rs
- **config**：config crate（config_toml/permissions_toml/profile_toml/requirements_layers/overrides/schema…）、docs/config.md
- **skills/slash**：skills crate、.codex/skills、core 内 skills 相关、tui/skills_helpers.rs、docs/skills.md、docs/slash_commands.md

## 5. 备注
- 仓库无顶层 cli/ 目录：主 CLI 在 codex-rs/cli；codex-cli/ 仅是 npm 包装（bin/codex.js → 下载/调用平台二进制）。
- 大多数 crate 无 description，crate 边界需按目录名 + 内部 src 模块推断（如上归类）。
- 官方文档站 developers.openai.com 与仓库 main 可能不同步；以仓库代码为准、文档站补背景。
