"use strict";
/* DSH 插件中文描述 / 用途。id 与 cordis.yml 行 id 对齐；无匹配时 UI 再按包名回退。 */
(function (root) {
  var COPY = {
    "sdk-jsonrpc-server": {
      title: "JSON-RPC 服务",
      description: "向进程外的 SDK 客户端提供 stdio JSON-RPC 服务，是 MTNode 与 DeepSeek Harness 之间的通信入口。",
      purpose: "让宿主应用用本地协议驱动引擎：发任务、收事件、管理运行时，而不直接嵌入 dsh 内部 API。",
    },
    timer: {
      title: "定时器",
      description: "Cordis 定时服务，为插件提供延时与周期调度。",
      purpose: "给会话标题、重试、超时等需要「过一会儿再做」的插件提供统一时钟。",
    },
    llm: {
      title: "LLM 服务",
      description: "与具体厂商无关的大模型调用接口，是 Harness 里所有对话请求的统一入口。",
      purpose: "把「找哪个模型、怎么发请求」收口到一处，供 Agent、标题、压缩等插件复用。",
    },
    session: {
      title: "会话存储",
      description: "事件溯源的会话仓库，保存一轮任务里的消息、工具结果与状态。",
      purpose: "让多步 Agent 跑完后仍能回放、查询和续跑同一条会话。",
    },
    typert: {
      title: "类型注册表",
      description: "运行时登记生成包的反射信息与 Zod 校验模式。",
      purpose: "给工具参数、配置项做结构化校验，避免模型乱填字段把运行时打崩。",
    },
    "typert-loader": {
      title: "类型加载器",
      description: "把生成好的 Typert 包贡献加载进运行时注册表。",
      purpose: "在启动时接好各插件声明的类型，后续工具调用才能按 schema 解析。",
    },
    "typert-gateway": {
      title: "类型网关",
      description: "Typert 远程主机调度与客户端 API 端点。",
      purpose: "把类型查询/分发暴露给需要反射信息的客户端或内部插件。",
    },
    "session-title": {
      title: "会话标题",
      description: "基于日志的会话标题服务，并登记可用的标题生成器。",
      purpose: "给每条任务起一个可读短标题，方便在会话列表里辨认。",
    },
    "session-title-llm": {
      title: "LLM 会话标题",
      description: "用模型根据首条用户消息生成会话标题。",
      purpose: "在任务开始后自动起名，避免列表里全是「未命名会话」。",
    },
    "user-questions": {
      title: "用户提问通道",
      description: "抽象的「向人类提问」缝合点（ctx.userQuestions），供运行中的 Agent 中途发问。",
      purpose: "任务缺信息时暂停等待你回答，而不是猜完继续错下去。",
    },
    "tool-ask-user": {
      title: "提问工具",
      description: "模型可调用的 ask_user_question 工具，走用户提问通道。",
      purpose: "让模型在任务中途弹出选择题/填空，等你在宿主里答完再继续。",
    },
    "mtnode-bridge": {
      title: "MTNode 交互桥",
      description: "把提问与审批接到本机 TCP，转发给 MTNode 宿主（端口由 MTNODE_BRIDGE_PORT 注入）。",
      purpose: "引擎在独立 Node 进程里跑时，仍能弹宿主窗口问你问题或请你批准危险操作。",
    },
    "mtnode-canvas": {
      title: "MTNode 画布工具",
      description: "向模型暴露当前画布：创建/改标题/连线/@引用/自动排版节点。",
      purpose: "让助手直接搭或改你正在看的画布，而不是只在对话里描述流程。",
    },
    agent: {
      title: "Agent 核心",
      description: "Agent 接口、注册表、发起范围与事件词汇，是 Harness 智能体的主干。",
      purpose: "定义「一次 Agent 任务」如何启动、如何发事件、如何被其他插件挂接。",
    },
    "agent-default-model": {
      title: "默认模型",
      description: "各 Agent 入口共用的默认模型选择。",
      purpose: "没指定模型时用这一档，避免每个入口各写一套默认值。",
    },
    jobs: {
      title: "后台任务登记",
      description: "进程内的后台作业注册表，跟踪耗时命令与作业状态。",
      purpose: "让 bash/pwsh 等后台任务能被列出、查看输出或杀掉。",
    },
    "llm-retry": {
      title: "LLM 重试",
      description: "按服务商路由的大模型请求重试策略。",
      purpose: "网络抖动或限流时自动再试，减少一次失败就整轮任务中断。",
    },
    settings: {
      title: "设置文件",
      description: "以 settings.yaml 为后端的设置提供者。",
      purpose: "把 Harness 运行参数落到 DSH_HOME，重启后仍生效。",
    },
    credentials: {
      title: "凭据文件",
      description: "以 DSH_HOME/.env（注入到进程环境）为后端的凭据提供者。",
      purpose: "集中存放 API Key 等密钥，供 LLM 适配器读取，而不写进代码。",
    },
    attachments: {
      title: "附件存储",
      description: "DSH_HOME 下按内容寻址的私有附件仓库。",
      purpose: "保存会话里的大段内容或文件块，避免把整份附件塞进事件日志。",
    },
    "llm-pi-ai": {
      title: "pi-ai 适配器",
      description: "用 pi-ai 对接 DeepSeek 的 LLM 适配器（与官方 deepseek 适配器对照验证）。",
      purpose: "在需要 pi-ai 目录/多服务商路由时走这套适配，而不是官方 chat-completions。",
    },
    "session-persistence-jsonl": {
      title: "JSONL 会话持久化",
      description: "把会话以 JSONL 落盘，保证任务中断后还能读回来。",
      purpose: "长任务崩溃或重启引擎后，仍能从磁盘恢复同一条会话。",
    },
    "session-query-sqlite": {
      title: "会话检索",
      description: "用 SQLite FTS5 实现会话全文检索。",
      purpose: "按关键词找出历史会话或消息，而不是只靠标题扫列表。",
    },
    "session-projection": {
      title: "会话投影",
      description: "可扩展的会话投影类型表、提供者契约与 ctx.sessionProjection。",
      purpose: "把事件流折成 UI/统计需要的视图（标题、用量、待办等），避免每次全量回放。",
    },
    subprocess: {
      title: "子进程",
      description: "Harness 子进程缝合点的本地实现，负责拉起外部命令。",
      purpose: "让 bash、工具脚本等在受控子进程里执行，而不是堵在引擎主线程。",
    },
    sandbox: {
      title: "沙箱后端",
      description: "本地进程沙箱：bwrap、随 npm 分发的 landlock-run 等后端。",
      purpose: "给命令执行套上系统级隔离，降低误跑危险命令的伤害面。",
    },
    "sandbox-policy": {
      title: "沙箱策略",
      description: "按调用解析沙箱策略，并结合部署默认值、会话模式与工作区。",
      purpose: "决定这一次命令是只读、可写工作区，还是更严/更松，与设置里的权限预设对齐。",
    },
    "bash-sandbox": {
      title: "Bash 沙箱执行",
      description: "走沙箱的 bash 执行器：每条命令经 ctx.sandbox 约束后再跑。",
      purpose: "模型调用 bash 时默认关在沙箱里，减少直接操作整机的风险。",
    },
    "pwsh-sandbox": {
      title: "PowerShell 沙箱执行",
      description: "走沙箱的 PowerShell 执行器，约束与 bash 侧一致。",
      purpose: "在 Windows 上让模型跑 pwsh 时同样受到沙箱与权限策略限制。",
    },
    approval: {
      title: "审批通道",
      description: "用户审批缝合点（ctx.approval）：一次性权限决定交给组合好的回答器。",
      purpose: "越权操作先问你允不允许，而不是默认放行。",
    },
    permission: {
      title: "权限预设",
      description: "面向用户的权限预设（ctx.permissionPresets），对应产品里的「权限」档位。",
      purpose: "用一档预设同时控制沙箱松紧和要不要弹审批，不必逐项改策略。",
    },
    "shell-env": {
      title: "Shell 环境",
      description: "与具体工具无关的 DSH_* 环境变量登记表。",
      purpose: "给命令执行注入统一的 Harness 环境（家目录、工作区等）。",
    },
    "tool-bash": {
      title: "Bash 工具",
      description: "模型可调用的 bash 工具，可选后台作业与沙箱升级。",
      purpose: "让 Agent 在工作目录里跑 shell 命令：列文件、执行脚本、查看输出。",
    },
    "tool-pwsh": {
      title: "PowerShell 工具",
      description: "模型可调用的 pwsh 工具，底层走 bash 执行缝合点。",
      purpose: "在 Windows 上用 PowerShell 完成与 bash 同类的本地操作。",
    },
    "tool-jobs": {
      title: "作业控制工具",
      description: "模型可调用的后台作业工具：查看输出、列出、结束（job_output / job_list / job_kill）。",
      purpose: "管理正在跑的耗时命令，不必干等，也可以中途杀掉。",
    },
    "fs-observation-policy": {
      title: "文件观察策略",
      description: "文件上下文策略：观察状态、先读后改、带版本的写入/编辑。",
      purpose: "避免模型没读文件就改、或改过期内容，降低误覆盖。",
    },
    "tool-fs": {
      title: "文件系统工具",
      description: "模型可调用的读/写/编辑文件工具，走 ctx.fs。",
      purpose: "让 Agent 直接处理工作目录里的文本文件：读内容、改一处、整文件覆盖。",
    },
    "tool-fs-search": {
      title: "文件搜索工具",
      description: "模型可调用的 glob / grep，底层用打包的 ripgrep。",
      purpose: "在项目里按文件名或内容快速定位，而不必把整棵目录读进上下文。",
    },
    "agent-instructions": {
      title: "工作区指令",
      description: "加载工作区里的 AGENTS.md / CLAUDE.md 等指令文件。",
      purpose: "让 Agent 遵守项目自己的约定（目录结构、禁止事项、风格），而不只靠系统提示。",
    },
    skill: {
      title: "技能注册表",
      description: "Agent 技能提供者注册表。",
      purpose: "汇总各来源的 Skills，供加载工具按名称启用。",
    },
    "skill-filesystem": {
      title: "本地技能",
      description: "从本地文件系统读取技能包。",
      purpose: "把 DSH_HOME/skills 里你创建或安装的技能交给模型按需加载。",
    },
    "tool-skill": {
      title: "技能加载工具",
      description: "模型可调用的技能加载工具。",
      purpose: "任务需要某项专项流程时，由模型把对应 SKILL.md 装进当前回合。",
    },
    commands: {
      title: "斜杠命令",
      description: "给 UI 用的人类命令注册表（/compact、/plan 等）。",
      purpose: "在会话输入框用斜杠触发引擎能力，而不必写成一段自然语言。",
    },
    "command-feedback": {
      title: "反馈命令",
      description: "只写日志的会话反馈，以及对应的人类斜杠命令。",
      purpose: "记录「这次好/不好」之类反馈，供后续改进，不改变当前任务结果。",
    },
    goal: {
      title: "目标状态",
      description: "同一会话内、事件溯源的目标状态与生命周期。",
      purpose: "把「当前要达成什么」显式存下来，方便多轮围绕同一目标推进。",
    },
    "goal-round-driver": {
      title: "目标回合驱动",
      description: "带竞态防护的同会话目标回合驱动器。",
      purpose: "按目标一轮轮往下跑，避免并发回合把状态写乱。",
    },
    "command-goal": {
      title: "目标命令",
      description: "面向用户的目标斜杠命令，读写持久化的同会话目标。",
      purpose: "用 /goal 查看或改当前目标，而不靠改提示词硬塞。",
    },
    "plan-mode": {
      title: "规划模式",
      description: "按 Agent 记录的规划模式：部署指引、斜杠命令、需用户确认后才退出。",
      purpose: "先列出步骤再动手；你点确认后才真正改文件或跑命令。",
    },
    "token-meter": {
      title: "Token 计量",
      description: "可回放的 token 计量服务（ctx.tokenMeter）。",
      purpose: "统计上下文用量，给压缩策略和界面用量条提供同一数据源。",
    },
    "compaction-basic": {
      title: "上下文压缩",
      description: "按 token 计量触发的压缩策略，并用模型做摘要。",
      purpose: "上下文快满时把旧对话收成摘要，腾出位置继续任务。",
    },
    "command-compact": {
      title: "压缩命令",
      description: "面向用户的显式压缩斜杠命令。",
      purpose: "你主动 /compact 时立刻压缩，而不等自动策略。",
    },
    subagent: {
      title: "子代理通道",
      description: "抽象子代理缝合点（ctx.subagents）：按名称登记、把任务委派给子 Agent。",
      purpose: "把大任务拆给子代理并行或分角色处理，主代理只汇总。",
    },
    "subagent-spawn-in-process": {
      title: "进程内派生子代理",
      description: "在本进程里新开一个子 Agent（spawn）。",
      purpose: "派生互不共享历史的子任务，适合「另起一行去做一件事」。",
    },
    "subagent-fork-in-process": {
      title: "进程内分叉子代理",
      description: "在本进程里分叉子 Agent，并带上父会话日志前缀。",
      purpose: "让子代理继承到目前为止的上下文，适合「在已知前提下分支探索」。",
    },
    "tool-subagent-control": {
      title: "子代理控制工具",
      description: "全局工具：给子代理发消息、打断、列出（send_message / interrupt_agent / list_agents）。",
      purpose: "主代理在子任务跑起来之后还能对话、叫停或查看还有谁在跑。",
    },
    "tool-subagent-list-agents": {
      title: "列出子代理",
      description: "列出当前子代理（list_agents），与控制工具同一套续体。",
      purpose: "让模型先看清有哪些子任务，再决定委派或回收。",
    },
    "tool-subagent": {
      title: "委派子代理",
      description: "模型可调用的子代理委派工具（spawn 路径）。",
      purpose: "把一块独立工作交给新子代理，主代理继续编排。",
    },
    "tool-subagent-fork": {
      title: "分叉子代理",
      description: "模型可调用的子代理委派工具（fork 路径，带父日志前缀）。",
      purpose: "在已有对话背景下分头去试，而不丢失前文。",
    },
    "tool-subagent-report": {
      title: "子代理汇报",
      description: "子代理侧的汇报工具，把结果写回父续体。",
      purpose: "子任务做完后把结论交回主代理，而不是默默结束。",
    },
    "timeout-policy": {
      title: "工具超时",
      description: "给工具执行套截止时间，超时返回 TOOL_TIMEOUT。",
      purpose: "避免某条命令或网络请求挂死整轮任务。",
    },
    "spill-local": {
      title: "溢出存储",
      description: "把过大内容存到会话私有本地文件（spill）。",
      purpose: "工具结果太长时不整段落进上下文，只留预览和指针。",
    },
    "spill-policy": {
      title: "溢出策略",
      description: "超大纯文本工具结果替换为保留预览的 spill 引用。",
      purpose: "控制上下文膨胀，同时仍能按需再打开全文。",
    },
    "session-checkpoint-policy": {
      title: "会话检查点",
      description: "在模型请求和有副作用的工具调用前做语义检查点。",
      purpose: "出错或中断后能回到最近稳妥点，而不是整段会话作废。",
    },
    "tool-result-pruner": {
      title: "工具结果裁剪",
      description: "对工具结果做可回放、不调用模型的头/中/尾裁剪。",
      purpose: "过长的命令输出只保留两端和中间摘要，省 token。",
    },
    "tool-todo": {
      title: "待办工具",
      description: "模型可调用的 todo_write，写入事件溯源的会话日志。",
      purpose: "让 Agent 列出并勾选步骤，长任务进度对你可见。",
    },
    "tool-goal": {
      title: "目标工具",
      description: "模型可调用的同会话目标工具，执行时做权限检查。",
      purpose: "由模型读写当前目标，并受执行期授权约束。",
    },
    "tool-str-replace-editor": {
      title: "精确编辑工具",
      description: "模型可查看、创建、字面替换和按行插入文件，走文件系统服务。",
      purpose: "改文件时只动匹配的那几行，比整文件覆写更安全、更好回放。",
    },
    "repeat-tool-reminder": {
      title: "重复调用提醒",
      description: "Agent 对同一工具用相同参数连打时给出劝告。",
      purpose: "打破「读同一文件/跑同一命令」死循环，促使换策略。",
    },
    web: {
      title: "联网通道",
      description: "抽象的网页访问能力（ctx.web）：搜索/抓取提供者注册表。",
      purpose: "给后续 web 工具一个统一入口，可换搜索后端而不改工具名。",
    },
    "web-search-deepseek": {
      title: "DeepSeek 搜索",
      description: "DeepSeek 原生 web_search（Anthropic 兼容 API）搜索提供者。",
      purpose: "让联网搜索走 DeepSeek 官方能力，结果回到 Agent 上下文。",
    },
    "tool-web": {
      title: "联网工具",
      description: "模型可调用的 web_search / web_fetch。",
      purpose: "查资料或打开网页正文，补全本地文件里没有的信息。",
    },
    tools: {
      title: "工具注册与执行",
      description: "工具注册表与执行管道，是所有 model-facing 工具的调度中枢。",
      purpose: "按名称找到工具、校验参数、执行并回流结果，是 Agent「会动手」的前提。",
    },
    "system-prompt": {
      title: "系统提示",
      description: "系统提示拼装注册表，把人格、工具说明和宿主附加说明合成一轮提示。",
      purpose: "决定模型「你是谁、能用哪些工具、要注意什么」，MTNode 的画布人格也从这里注入。",
    },
    "agent-loop": {
      title: "Agent 循环",
      description: "具体的 Agent 主循环：思考 → 调工具 → 再思考，直到结束。",
      purpose: "把一次用户任务真正跑起来，直到给出最终回复或出错。",
    },
    "fs-sandbox": {
      title: "文件沙箱",
      description: "带沙箱的文件系统实现：按每次调用的沙箱模式限制写/改。",
      purpose: "只读档位下禁止改文件；可写档位也限制在工作区，降低误删系统文件的风险。",
    },
    "llm-deepseek": {
      title: "DeepSeek 适配器",
      description: "DeepSeek chat-completions 适配器，读取环境里的 Key 与 Base URL。",
      purpose: "让引擎用你在设置里配的 DeepSeek（或兼容）接口真正发出对话请求。",
    },
    "dsh-router-standard": {
      title: "标准路由（实验）",
      description:
        "任务感知路由（Standard）：一句人格 + shell/编辑器表面，先思考再行动；首轮工具调用之后打开完整 Standard 工具集。MTNode 下会保留画布人格与 mtnode_* 工具。",
      purpose: "按任务类型收紧首轮工具面、引导「想清楚再动手」，同时不冲掉本应用的画布能力。",
    },
  };

  root.DSH_PLUGIN_COPY = COPY;
})(typeof globalThis !== "undefined" ? globalThis : this);
