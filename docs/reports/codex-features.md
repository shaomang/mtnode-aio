# Codex 功能清单（用户功能面 · 对比源 B 用底稿）

> 并行任务产出：《Codex 功能清单》并标注价值取向（可靠执行 vs 自主程度）。
> 证据来源：openai/codex **main 分支快照**（2026-09-05 抓取，解压于 `%TEMP%\codex-review`，无 .git，版本号 0.0.0-dev，见 `codex-repo-map.md`）+ 官方文档站 developers.openai.com/codex 与 GitHub ISSUES（见文末引用）。
> 若本清单与「模板命令表」（login/exec/run/resend/install/AppModels…）不一致，**以本快照的真实命令面为准**，差异在 §0/§1 显式标注，供主任务合并时对齐。

## 0. 怎么读这张清单

- 每条功能标注价值取向：**⚙可靠执行**（护栏、审计、确定性、可追溯）／**🤖自主程度**（放权、免打扰、扩展性）／**混合**。
- 模板术语 ≠ Codex 实况的条目已标「⚠映射」，不要照抄进对比结论。
- 源 B 数据不在本子任务侧，§9 只留对照骨架，由主任务合并两路产出。

## 1. CLI 命令面（`codex [OPTIONS] <COMMAND>`，源自 cli/src/main.rs `Subcommand` 枚举）

顶层子命令（快照真实清单）：

| 命令 | 用途 | 价值取向 |
|---|---|---|
| `codex`（无子命令=交互 TUI） | 交互式会话入口；提示词可作位置参数 | 混合 |
| `agents` | 浏览 app-server 守护进程上的全部 agent 会话（多 agent 面） | 🤖 |
| `exec`（别名 `e`） | **非交互执行**（详见 §2）；子命令 `exec resume / exec fork / exec review` | ⚙ |
| `review` | 非交互代码评审（--uncommitted / --base BRANCH / --commit SHA / 自定义指令） | ⚙ |
| `login` | 登录（ChatGPT 账号 OAuth / device-auth / `--with-api-key` / `--with-access-token`）；`login status` 看状态 | ⚙ |
| `logout` | 清除本地凭据 | ⚙ |
| `mcp` | 管理外部 MCP 服务器（list/add/remove，见 §7） | 🤖 |
| `plugin` | 管理插件（含 --json） | 🤖 |
| `mcp-server` | **把 Codex 本身作为 MCP 服务器（stdio）暴露**给其它宿主 | 🤖 |
| `app-server` / `remote-control` | [experimental] 应用服务器守护进程/远程控制 | 🤖 |
| `app` | 启动桌面 App（macOS/Windows，缺失则引导安装） | 🤖 |
| `completion` | 生成 shell 补全脚本 | ⚙ |
| `update` | 自更新到最新版 | ⚙ |
| `doctor` | 诊断安装/config/auth/运行健康（`--summary` 精简） | ⚙ |
| `sandbox` | 在主机沙箱内运行任意命令（macOS Seatbelt / Linux Landlock / Windows） | ⚙ |
| `debug` | 调试工具（models / app-server / prompt-input / trace-reduce…） | ⚙ |
| `apply`（别名 `a`） | 把 agent 产出的最新 diff 以 `git apply` 应用到工作树 | ⚙ |
| `resume` / `fork` | 恢复/分叉历史会话（默认选择器；`--last` 直达最近会话；`--all`/`--include-non-interactive`） | ⚙ |
| `queue` | 向既有会话投递一条消息（异步队列面） | 🤖 |
| `archive` / `unarchive` / `delete` | 会话归档/恢复/永久删除（delete 需 UUID+`--force` 免确认） | ⚙ |
| `migrate-rollouts` | 把旧本地会话迁移到分页线程历史 | ⚙ |
| `cloud`（别名 cloud-tasks，[EXPERIMENTAL]） | 浏览 Codex Cloud 任务并在本地应用改动 | 🤖 |
| `exec-server`（[EXPERIMENTAL]）/ `features` | 独立执行服务 / 特性开关检视 | 混合 |
| `execpolicy` / `responses-api-proxy` / `stdio-to-uds`（隐藏） | 内部/调试 | ⚙ |

共享全局选项（utils/cli `SharedCliOptions` + 覆盖）：`-c/--config <key=value>` 配置覆盖、`-p/--profile` 配置档、`-m/--model`、`-i/--image`（可多个）、`-C/--cd`、`-s/--sandbox <read-only|workspace-write|danger-full-access>`、`--approve-for-me`（别名 `--not-so-yolo`）、`--dangerously-bypass-approvals-and-sandbox`（别名 `--yolo`）、`--dangerously-bypass-hook-trust`、`--worktree`、`--add-dir`、`--oss`/`--local-provider <lmstudio|ollama>`、`--strict-config`（未知配置键即报错）。

⚠模板命令映射（给合并方）：
- `login` ✅ = `codex login`（另有 `logout`、`login status`）。
- `exec` ✅ = `codex exec`（非交互）。
- `run` ⚠ 无 `codex run`：新任务=`exec`，续跑=`exec resume` / `resume --last`。
- `resend` ⚠ 无此命令：Codex 不提供「重发上一条消息」；最近似的是 `resume/fork` 续会话重放、`exec` 事件流重跑、批准拒绝后的 `/approve` 重试。
- `install` ⚠ 无子命令：安装走 `install.sh` / `install.ps1` / npm `@openai/codex` / brew cask / chatgpt.com/codex（npm 包装仅 `codex` 一个 bin，见 codex-cli/package.json）。
- `codex 内命令` = TUI 斜杠命令，见 §6。

## 2. 非交互 exec 模式与输出格式

入口 `codex exec [OPTIONS] [PROMPT]`（exec/src/cli.rs）：
- 输入：位置参数提示词；用 `-` 或省略时读 stdin；stdin 被管道且又给了提示词时，stdin 以 `<stdin>` 块追加。
- 模式选项：`--skip-git-repo-check`（非 git 目录放行）、`--ephemeral`（不落盘会话）、`--ignore-user-config`、`--ignore-rules`（不加载用户/项目 `.rules`）、`--thread-source`、`--strict-config`。
- 输出格式（⚠模板「json/compact」对应）：
  - 默认=人类可读流式事件文本。
  - `--json`（别名 `--experimental-json`）= **stdout 输出 JSONL 事件流**，机器可解析；事件类型含 thread/turn/item 生命周期（started/completed/failed）、agent_message、reasoning、command_execution、file_change、mcp_tool_call、web_search、todo_list、error 等（exec/src/exec_events.rs）。
  - `-o/--output-last-message FILE`：把 agent 最后一条消息写入文件（拿最终答复的标准姿势）。
  - `--output-schema FILE`：JSON Schema 文件，约束模型最终答复结构。
  - **当前快照无独立 `--compact` 输出档**：若模板来自某文档旧版，最接近的「compact」语义是默认人类输出 vs `--json`，以及配置 `model_verbosity` 与上下文自动压缩（`model_auto_compact_token_limit` / `/compact`）。
- 退出码有专门 exit_status.rs（0/1/2 级语义，非交互 CI 友好）。
- CI/自动化推荐组合：`exec --sandbox workspace-write` + config `approval_policy="never"`（或 `-c` 覆盖）；全放权则 `--yolo`（文档明示仅用于外部已沙箱环境）。
- 价值取向：默认路径=⚙（批准+沙箱护栏仍在，可追溯）；`--json`/`-o`/`--output-schema`=⚙面向机器契约；`--yolo`/`--ephemeral`=🤖。

## 3. config 体系

分层（由弱到强）：程序默认值 → `$CODEX_HOME/config.toml`（用户）→ `-p/--profile` 配置档（`$CODEX_HOME/<name>.config.toml`，config 内亦可嵌 `[profiles]`）→ `-c/--config key=value` CLI 覆盖（utils/cli config_override：`short='c'`）。
环境变量：`CODEX_HOME`（默认 `~/.codex`）、`OPENAI_API_KEY`、`CODEX_ACCESS_TOKEN`（配合 `login --with-access-token`）；凭据另走 keyring-store crate。
config.toml 主要键（config/src/config_toml.rs 稳定面）：`model`、`review_model`、`model_provider`、`model_providers`（多服务商表，每项含 base_url/env_key/wire_api 等）、`approval_policy`(on-request/never)、`approvals_reviewer`(auto_review/never)、`sandbox_mode`、`sandbox_workspace_write`、`permissions`/`default_permissions`、`hooks`、`mcp_servers`、`instructions`/`developer_instructions`/`include_*_instructions`、`model_context_window`/`model_auto_compact_token_limit`、`model_reasoning_effort`/`model_reasoning_summary`/`model_verbosity`、`notify`、`tui`、`web_search`、`log_dir`、`profile`/`profiles`、`features`、`strict_config`、`analytics`/`feedback` 等。
⚠模板「AppModels」：**Codex 配置与代码中无该键名**（全仓 grep 无命中）。最近似物 = `model_providers.<id>` 表的模型清单 + `model`/`model_provider`/`review_model` + profiles；若模板来自 IDE/桌面侧术语，属 Codex 桌面/App 层而非 CLI config，请合并方注意甄别。
快照注：main 分支 config 已含大量实验键（agents/goals/memories/marketplaces/plugins/realtime/audio/computer_use/browser_use/apps/desktop/otel/windows…），以官方 stable 文档 developers.openai.com/codex/config-* 为对外口径。
价值取向：默认保守（权限/沙箱/批准逐项可配）；一条 `-c`/profile/`yolo` 即可整体放权 —— 可靠与自主在同一套分层上伸缩。

## 4. 审计与日志文件（~/.codex 下）

- 会话转录（可审计核心）：`sessions/<YYYY>/<MM>/<DD>/<thread_id>.jsonl`，每个会话全量 JSONL（测试与代码多处证实该路径结构），`/rollout` 可打印当前 rollout 文件路径；`exec` 默认同样落盘（`--ephemeral` 关闭）。
- 线程历史：线程索引/分页历史走 sqlite（`history`/thread-store），`resume/fork/queue/archive` 均基于它；`migrate-rollouts` 负责旧格式迁移。
- 日志：`log_dir`（默认 `~/.codex/log`）下 TUI/exec 运行日志（另附 logs_client 独立二进制可查询，`--compact` 精简行）；config `log_dir` 可改址。
- 遥测与反馈：`analytics` 默认关、显式开启；`/feedback` 可把日志发给维护方。
- 价值取向：默认全量落盘+可回放=⚙强审计；`--ephemeral`/analytics 开关=🤖隐私/轻量选项。

## 5. 沙箱与批准（含 Docker 沙箱之辨）

- 沙箱三档（CLI `-s` 与 config `sandbox_mode` 同源）：`read-only` / `workspace-write` / `danger-full-access`（SandboxMode 仅此三档，无第四值）。实现为 OS 原生：Linux bwrap + Landlock（landlock 命令/`linux-sandbox`）、macOS Seatbelt、Windows 沙箱（openai.com 有专文），另有 mxc-sandbox / process-hardening / shell-escalation / execpolicy（Starlark 前缀规则）加固族。
- 批准体系：`approval_policy`（on-request=模型自行判断何时问、never=不问直接回失败给模型）；`approvals_reviewer=auto_review`（`--approve-for-me`/`--not-so-yolo` 自动评审 + workspace-write）；granular 默认权限/拒绝规则、网络访问批准、`/permissions`、`/setup-default-sandbox`、`/sandbox-add-read-dir`；`--yolo` 全关护栏。批准协议跨层（protocol/approvals、mcp_approval_meta、TUI approval_overlay）。
- ⚠Docker：**本快照核心无「docker」沙箱档**（docker 字样仅出现在测试/远程执行环境相关代码）。官方/社区做法 = 把 codex 跑在容器内 + `--dangerously-bypass-approvals-and-sandbox`（容器本身即外部沙箱），或经 [experimental] exec-server 注册远程执行环境。若源 B 有原生 Docker 沙箱，这是显著差异点。
- 价值取向：批准+沙箱+execpolicy=⚙可靠执行的护城河；yolo/approve-for-me=🤖自主端；跨层批准协议（MCP/插件也能走批准）=两者兼得。

## 6. codex 内命令（TUI 斜杠命令，快照枚举全量）

- 会话与模型：`/model`(模型+推理档) `/new` `/resume` `/fork` `/rename` `/archive` `/delete` `/clear` `/compact`(上下文压缩) `/recap` `/plan`(Plan 模式) `/goal`(长任务目标) `/agents`(切换活动 agent) `/side` `/btw`(侧聊 fork) `/import`(从 Claude Code 迁移) `/app`(转到桌面 App)。
- 权限与沙箱：`/permissions` `/setup-default-sandbox` `/sandbox-add-read-dir` `/approve`(批准一次自动评审拒绝的重试) `/experimental`。
- 代码工作流：`/review` `/init`(生成 AGENTS.md) `/diff` `/mention` `/ide`(拉入 IDE 选中/打开文件) `/cd` `/pwd` `/skills` `/hooks` `/memories`。
- 状态与查看：`/status` `/usage` `/debug-config` `/rollout` `/ps`(后台终端) `/stop` `/title` `/statusline` `/theme` `/pets` `/mcp`(列 MCP 工具) `/apps` `/plugins` `/keymap` `/vim` `/copy` `/export`(导出 md) `/raw` `/personality` `/logout` `/quit` `/exit` `/feedback` `/subagents`(本会话子代理) + 隐藏调试 `/debug-m-drop` `/debug-m-update`。
- 价值取向：/permissions·批准·沙箱·hooks=⚙；/skills·/mcp·/plugins·/subagents·/side 多开与扩展=🤖；/compact·/goal·/recap 长任务自管理=混合。

## 7. MCP 与扩展面

- 消费外部 MCP：`codex mcp add <name> -- <command> [args]`（含 env/type/沙箱化选项、OAuth 客户端注册 arg）、`codex mcp list`（--json）、`codex mcp remove`；config `mcp_servers` 表；TUI `/mcp`。
- 反向外露：`codex mcp-server`（stdio）把 Codex 作为 MCP 服务器暴露 —— 其它宿主（IDE/别的 agent）可把 Codex 当工具调用；跨层批准元数据（mcp_approval_meta）随之暴露。
- 其它扩展面：插件 + 市场（`codex plugin`、`marketplace_cmd`、`/plugins`、config `plugins`/`marketplaces`）；skills（内置 `.codex/skills` + AGENTS.md 项目指令机制，`/skills`）；SDK（sdk/python；codex-mcp crate 定义 MCP 接口）。
- 价值取向：MCP 双向=🤖生态组合性；同时把批准协议带进扩展调用=⚙不失守。

## 8. 已知边界与路线信号（docs/ISSUES）

已知边界（本快照可证）：
- 无「重发/run」类会话命令（见 §1 ⚠映射）；非交互 exec 是一进程一轮次，长任务能力靠后台终端(`/ps`/`/stop`)、多 agent、`/goal` 等新机制演进中。
- 无官方 Docker 沙箱档（§5）；默认要求 git 仓库（需 `--skip-git-repo-check` 破例）。
- exec 在 CI 需显式 `approval_policy=never` 或 yolo，否则可能停在批准请求。
- 大量面标 [EXPERIMENTAL]（app-server/remote-control/exec-server/cloud/realtime/audio…），`features` 开关控制；`--strict-config` 会对未来键报错——说明配置仍在演进、稳定面以官方文档为准。
- TUI 终端渲染：复杂编辑走 external_editor；IDE 上下文依赖 `/ide` 与官方 IDE 扩展。
- 平台：Linux/macOS/Windows 均有原生沙箱，但 Windows 沙箱能力建设仍在推进（见下）。
路线信号（非承诺，仅为方向证据）：
- 官方发布节奏与变更：releases 页 + CHANGELOG（仓库 CHANGELOG.md 指向 releases）。
- GitHub ISSUES：子代理支持从需求（#2604）到落地仍在演进，子代理生命周期/后台任务出现新问题（#19197）→ 多 agent 与长任务是活跃方向。
- Windows 沙箱：openai.com 专文《Building a safe and effective sandbox for Codex on Windows》、仓库提交 #6872 更新 windows sandbox 文档 → 平台护栏在补齐。
- 官方文档站 developers.openai.com/codex 子页（cli/features、auth、config-basic/config-advanced、noninteractive、exec-policy、security、skills、slash-commands、guides/agents-md、codex/ide）与仓库 docs/ 一一映射（详见 codex-repo-map.md §4）。

## 9. 与源 B 对比的对照骨架（待主任务合并填源 B 列）

| 功能维度 | Codex（本清单） | 源 B | 差异与取舍启示 |
|---|---|---|---|
| 命令面覆盖（交互/非交互/会话管理） | §1：exec/review/resume/fork/queue/archive/delete/agents… | 待填 | |
| 非交互输出契约 | §2：默认文本 / --json JSONL / -o / --output-schema | 待填 | |
| 配置分层 | §3：默认<config.toml<profile<-c<env | 待填 | |
| 审计落盘 | §4：sessions JSONL + 线程 sqlite + log_dir | 待填 | |
| 安全护栏 | §5：三档沙箱+批准+execpolicy+跨层批准协议 | 待填 | |
| 扩展协议 | §7：MCP 双向 / plugins / skills / SDK | 待填 | |
| 已知边界与路线 | §8 | 待填 | |
| 总体价值取向 | 默认「可靠执行」做厚（沙箱/批准/审计/分层配置），以显式开关支持「自主程度」伸缩（yolo/approve-for-me/approval_policy=never/--ephemeral） | 待填 | |

## 附：引用

- 本地快照证据：`%TEMP%\codex-review\codex-rs\cli\src\main.rs`（Subcommand 枚举 ~L147-244）、`exec\src\cli.rs`（exec 全量 flags/子命令）、`exec\src\exec_events.rs`（JSONL 事件类型）、`utils\cli\src\shared_options.rs`、`utils\cli\src\sandbox_mode_cli_arg.rs`（三档沙箱）、`utils\cli\src\approval_mode_cli_arg.rs`、`utils\cli\src\config_override.rs`（-c）、`config\src\config_toml.rs`（config 键）、`tui\src\slash_command.rs`（斜杠命令全量）、`codex-home`/app-server 测试（sessions/<YYYY>/<MM>/<DD>/<id>.jsonl 路径）、`cli\Cargo.toml`（bin：codex + logs_client）、`codex-cli\package.json`（npm 包装）。
- 官方文档站：https://developers.openai.com/codex （cli、auth、config-basic/config-advanced、noninteractive、exec-policy、security、skills、slash-commands、guides/agents-md、codex/ide）
- 沙箱与 Windows 专文：https://learn.chatgpt.com/docs/sandboxing.md · https://openai.com/index/building-codex-windows-sandbox/
- GitHub ISSUES/仓库：https://github.com/openai/codex/issues/2604 （子代理支持历程）· https://github.com/openai/codex/issues/19197 （子代理生命周期/后台任务问题）· https://github.com/openai/codex/commit/7508e4fd2d0161a3c7558391f7c0ce5fe92224f5 （Windows 沙箱文档更新）· https://github.com/openai/codex/releases
