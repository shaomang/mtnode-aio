/* session-tools.js — 「会话桥」工具族（mtnode_session_*）的参数表与参数校验
 *
 * ── 为什么单独一个文件 ───────────────────────────────────────────────────
 * mcp-server.js 的工具契约来自 mcp-tools.json（生成物，真源 = dsh/gateway/*-plugin.mjs
 * 的 defineTool 参数表）。会话这一族**不在网关插件里**（网关只管模型轮，不认识「左栏会话」），
 * 所以它不能进那份生成契约，也就**不进 tools/list**（共识：只给 Paseo 桥内部用，走 POST /ctl）。
 * 参数表因此手写在这里，校验器直接读它 —— 与 mcp-tool-schemas.js 同一形状（required + 类型）。
 *
 * 契约（与 renderer/mcp-bridge.js 的 session* 分派、paseo/ 的桥一一对应）：
 *   mtnode_session_list      列会话（文件层索引，窗口不在也能读）
 *   mtnode_session_read      读一条会话的消息与元数据（文件层，按需读回）
 *   mtnode_session_watch     开始 / 停止观察一条会话的实时事件（SSE 的心跳口）
 *   mtnode_session_send      发消息（续跑一条会话；sessionId 留空 = 新建一条）
 *   mtnode_session_create    新建一条会话（可指定 provider / model / effort）
 *   mtnode_session_steer     往正在跑的那一轮插话
 *   mtnode_session_stop      终止这一条会话正在跑的轮次
 *   mtnode_session_approval  回执一张「停下来等人」的卡（工具审批 / 画布确认 / 模型提问）
 *   mtnode_session_model     换一条**已有**会话的模型（与界面上那两格同一落点）
 *   mtnode_session_models    供应商与模型清单（手机新建会话时选）
 *   mtnode_session_state     桥自身的运行态（观察者数 / 最近事件类型）
 */
"use strict";

/** 手机答一张卡的三种出口（与渲染层既有的按钮一一对应） */
const SESSION_ASK_OUTCOMES = Object.freeze([
  "allowed-once",
  "rejected",
  "allowed-session",
  "answered",
]);

const SESSION_TOOLS = Object.freeze([
  {
    name: "mtnode_session_list",
    family: "session",
    op: "sessionList",
    write: false,
    local: true,
    description:
      "列出 MTNode 的左栏智能体会话（id / 标题 / 是否正在跑 / 排队条数 / 归属画布 / 最近更新时间）。" +
      "只读，走主进程文件层（窗口不在也能读）。会话 id 形如 as…，就是 ACP 侧的 sessionId。",
    inputSchema: {
      type: "object",
      properties: {
        includeArchived: { type: "boolean", description: "连归档会话一起回（默认 false）" },
        limit: { type: "number", description: "最多回几条（默认 60，上限 200）" },
      },
    },
  },
  {
    name: "mtnode_session_read",
    family: "session",
    op: "sessionRead",
    write: false,
    local: true,
    description:
      "读一条会话的元数据与消息（最近 N 条，含正文 / 工具调用 / 分段）。只读，走主进程文件层。" +
      "会话不存在时明确报 SESSION_GONE（已被删除），不返回空会话。",
    inputSchema: {
      type: "object",
      required: ["sessionId"],
      properties: {
        sessionId: { type: "string", description: "会话 id（as…）" },
        limit: { type: "number", description: "最多回多少条消息（默认 60，上限 400）" },
        from: { type: "number", description: "从第几条开始（默认 = 取最后 limit 条）" },
        bodyLimit: { type: "number", description: "单条正文截断上限（默认 4000 字）" },
      },
    },
  },
  {
    name: "mtnode_session_watch",
    family: "session",
    op: "sessionWatch",
    write: true,
    local: true,
    description:
      "开始 / 停止观察一条会话的实时事件。开始观察会让渲染层把**已经在跑的那一轮**的事件复制一份上来" +
      "（只读旁路，掉线不影响会话）。SSE 长连接在 GET /session/stream 上。",
    inputSchema: {
      type: "object",
      required: ["sessionId"],
      properties: {
        sessionId: { type: "string", description: "会话 id（as…）" },
        on: { type: "boolean", description: "true = 开始观察（默认），false = 停止" },
        withReplay: { type: "boolean", description: "开始观察时补发最后一屏（默认 true）" },
      },
    },
  },
  {
    name: "mtnode_session_send",
    family: "session",
    op: "sessionSend",
    write: true,
    local: true,
    description:
      "给一条会话发一条用户消息（= 手机上按发送）。会话正在跑时消息进该会话的发送队列（串行），" +
      "不会打断正在跑的那一轮。sessionId 留空 = 新建一条会话再发。",
    inputSchema: {
      type: "object",
      required: ["text"],
      properties: {
        sessionId: { type: "string", description: "目标会话 id（as…）；留空 = 新建" },
        text: { type: "string", description: "消息正文" },
        provider: { type: "string", description: "新建时用：供应商（route 或名称）" },
        model: { type: "string", description: "新建时用：模型 id" },
        effort: { type: "string", description: "新建时用：思考档（low/medium/high/xhigh/max）" },
        title: { type: "string", description: "新建时用：会话标题（留空 = 首轮自动命名）" },
      },
    },
  },
  {
    name: "mtnode_session_create",
    family: "session",
    op: "sessionCreate",
    write: true,
    local: true,
    description:
      "新建一条 MTNode 会话留给手机端用。默认：绑当前画布、workspace 继承当前、preset 默认、" +
      "effort=high（与电脑上点「新会话」一致）。不发送任何消息。",
    inputSchema: {
      type: "object",
      properties: {
        provider: { type: "string", description: "供应商（route 或名称）" },
        model: { type: "string", description: "模型 id" },
        effort: { type: "string", description: "思考档" },
        title: { type: "string", description: "会话标题" },
      },
    },
  },
  {
    name: "mtnode_session_steer",
    family: "session",
    op: "sessionSteer",
    write: true,
    local: true,
    description:
      "往一条会话**正在跑的那一轮**插话（不新起一轮）。没有在跑的轮次时明确报错（改用 send）。",
    inputSchema: {
      type: "object",
      required: ["sessionId", "text"],
      properties: {
        sessionId: { type: "string", description: "会话 id（as…）" },
        text: { type: "string", description: "插入的话" },
      },
    },
  },
  {
    name: "mtnode_session_stop",
    family: "session",
    op: "sessionStop",
    write: true,
    local: true,
    description: "终止一条会话正在跑的轮次（含它在排队的消息）。幂等：没在跑也回 ok。",
    inputSchema: {
      type: "object",
      required: ["sessionId"],
      properties: {
        sessionId: { type: "string", description: "会话 id（as…）" },
        clearQueue: { type: "boolean", description: "连排队消息一起清掉（默认 true）" },
      },
    },
  },
  {
    name: "mtnode_session_approval",
    family: "session",
    op: "sessionApproval",
    write: true,
    local: true,
    description:
      "回执一张「停下来等人」的卡：工具审批（allowed-once / rejected / allowed-session）、" +
      "画布修改确认（allowed-once / rejected）、模型提问（outcome=answered + answerText）。" +
      "卡已失效（发起轮结束 / 已答过）时明确报 stale，不假装成功。",
    inputSchema: {
      type: "object",
      required: ["id", "outcome"],
      properties: {
        id: { type: "string", description: "卡片 id（来自 approval / question / canvas 事件）" },
        sessionId: { type: "string", description: "归属会话 id（用于台账与报错归属）" },
        kind: {
          type: "string",
          description: "卡片类型：approval（默认）/ question / canvas",
          enum: ["approval", "question", "canvas"],
        },
        outcome: {
          type: "string",
          description: "答案：allowed-once / rejected / allowed-session / answered",
          enum: SESSION_ASK_OUTCOMES.slice(),
        },
        answerText: { type: "string", description: "kind=question 时的回答正文" },
        answers: {
          type: "array",
          description:
            "kind=question 时的逐题答案（Paseo 桥把手机上的作答按题 id 对齐后给的那份，原样转给网关）：" +
            "[{id: 题 id, selected: [答案文本…]}]",
          items: {
            type: "object",
            properties: {
              id: { type: "string", description: "题 id（与 questions[] 的 id 对齐）" },
              selected: { type: "array", items: { type: "string" }, description: "该题选中的选项 label 或用户输入的文本" },
            },
          },
        },
        selected: {
          type: "array",
          description: "kind=question 且是选择题时的选项下标",
          items: { type: "number" },
        },
      },
    },
  },
  {
    name: "mtnode_session_model",
    family: "session",
    op: "sessionModel",
    write: true,
    local: true,
    description:
      "换一条**已有**会话用的模型（provider / model 两个字段，与电脑上界面的「模型提供商 / 模型」两格" +
      "同一落点）。下一条消息就用新模型，历史与正在跑的那一轮都不动（那一轮的服务商与模型在开轮时已定）。" +
      "服务商不在 MTNode 的服务商配置里、或该家没有这个模型时如实报错，不静默回退到别家。",
    inputSchema: {
      type: "object",
      required: ["sessionId"],
      properties: {
        sessionId: { type: "string", description: "会话 id（as…）" },
        provider: { type: "string", description: "服务商 route（省略 = 只换模型，服务商不动）" },
        model: { type: "string", description: "模型 id" },
      },
    },
  },
  {
    name: "mtnode_session_models",
    family: "session",
    op: "sessionModels",
    write: false,
    local: true,
    description:
      "供应商与模型清单 + 新建会话的默认值（手机端新建会话时选）。只读，取自 MTNode 自己的服务商配置。",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "mtnode_session_state",
    family: "session",
    op: "sessionState",
    write: false,
    local: true,
    description: "会话桥自身的运行态：正在被观察的会话 / 观察者数 / 最近事件类型统计。只读，排障用。",
    inputSchema: { type: "object", properties: {} },
  },
]);

/** 名字 → 规格（mcp-server.js 与渲染层分派共用同一份） */
const SESSION_TOOL_BY_NAME = Object.freeze(
  SESSION_TOOLS.reduce((m, t) => {
    m[t.name] = t;
    return m;
  }, {}),
);

module.exports = { SESSION_TOOLS, SESSION_TOOL_BY_NAME, SESSION_ASK_OUTCOMES };
