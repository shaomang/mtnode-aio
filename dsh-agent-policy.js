/* dsh-agent-policy.js — 「子代理（delegation）」策略落到 dsh 组合里的唯一写入点
 * ============================================================================
 * 需求（对标 OpenCode 的 subagent_depth / task 权限）：
 *   让用户能定住子代理的**嵌套深度**、能否**后台并行委派**、能否用 **fork 型**子代理，
 *   以及**整套关掉委派**；默认收紧到「只允许一层嵌套」（OpenCode 的 subagent_depth 默认 1）。
 *
 * 为什么是「改写 cordis.yml」而不是加一个网关接口：
 *   · dsh 的 `@deepseek-ai/dsh-tool-subagent` 行本来就有 `maxDepth`（dsh 默认 3，0 = 禁止委派）
 *     与 `enableRunInBackground` 两个配置键；`subagent*` 这 8 行又都是**平台条件行**
 *     （`disabled: !!js process.env.MTNODE_CHAT_ISOLATE === '1' || ...`），网关的设置界面按
 *     「平台条件行不允许手动挂载/卸载」处理（gateway.mjs describePlugin 的 dynamic→toggleable=false），
 *     所以开关只能由宿主按用户设置改写这两处。
 *   · 同仓已有同源先例：网关的 `applyCordisPreset` 每次运行前把权限预设写进 cordis.yml，
 *     「新运行时（新会话）首个回合即用所选值，正在跑的会话沿用原值」。本模块保持这一口径，
 *     由宿主（main.js）在**启动时**与**每次保存配置后**改写。
 *   · 不新增 dsh 契约：网关的三层契约（main.js ↔ main-dsh.js ↔ gateway.mjs ↔ 运行时）
 *     一字未动，只改组合文件里的**配置值**与那 8 行的 `disabled:` 取值。
 *
 * 语义（写成纯函数，便于 test/smoke-subagent-policy.js 直接钉住）：
 *   policy = { enabled, fork, background, depth }
 *     enabled=false      → 8 行全部 `disabled: true`（模型侧连委派工具都看不到）
 *     fork=false         → 另外把 fork 提供方与 fork 工具两行关掉
 *     background=false   → tool-subagent 行写 `enableRunInBackground: false`（禁后台并行委派）
 *     depth ∈ {0,1,2}    → 两个委派工具行写 `maxDepth: <n>`（0 = 禁止委派，默认 1）
 *   policy 归一：非法 / 缺省一律回落到「开、允许 fork、允许后台、深度 1」= 除深度外与接入前一致。
 *
 * 幂等：重复应用同一 policy 不产生字节变化（`changed` 为 false 时调用方一次磁盘都不碰）。
 * ============================================================================
 */
"use strict";

/* dsh 组合里参与「子代理」的行。tool/spawn/fork 三个开关决定它们怎么被关掉：
   - tool: 真正的委派工具行（带 maxDepth / enableRunInBackground 配置）
   - spawn/fork: 两种提供方行 + 它们的工具行，fork=false 时一起关
   - 其余（服务行 / 控制工具 / 列子代理）只跟随「总开关」
   dsh 0.2 起 tool-subagent-report 整包下线（npm 不再发布该包），故不再列入。 */
const SUBAGENT_ROWS = {
  subagent: { tool: false, fork: false },
  "subagent-spawn-in-process": { tool: false, fork: false },
  "subagent-fork-in-process": { tool: false, fork: true },
  "tool-subagent-control": { tool: false, fork: false },
  "tool-subagent-list-agents": { tool: false, fork: false },
  "tool-subagent": { tool: true, spawn: true, fork: false },
  "tool-subagent-fork": { tool: true, spawn: false, fork: true },
};

const SUBAGENT_IDS = Object.keys(SUBAGENT_ROWS);

/* 平台条件行的原始取值（本仓 cordis.yml 里 8 行逐字如此）：
   关掉再打开时必须还原成这一行，否则「隔离模式 / 纯模式」的平台闸会被我们的策略抹掉。 */
const PLATFORM_DISABLED =
  "!!js process.env.MTNODE_CHAT_ISOLATE === '1' || process.env.MTNODE_PURE === '1'";

const DEPTHS = [0, 1, 2];
const DEFAULT_DEPTH = 1;

const DEFAULT_POLICY = Object.freeze({
  enabled: true,
  fork: true,
  background: true,
  depth: DEFAULT_DEPTH,
});

/** 把任意外来值归一成一份合法 policy（非法值一律回落默认，绝不抛）。 */
function normalizePolicy(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  const depth = Number(r.depth);
  return {
    enabled: r.enabled !== false,
    fork: r.fork !== false,
    background: r.background !== false,
    depth: DEPTHS.indexOf(depth) >= 0 ? depth : DEFAULT_DEPTH,
  };
}

/** 从 MTNode 的整份 config 对象里取子代理策略。
 *  真源是 `config.dsh.subagent`（与默认模型 / Agent 预设 / 权限预设同一节，设置界面写的
 *  就是它）；`config.subagent` 作为兼容读取，方便脚本或将来搬到顶层时不必改调用方。 */
function policyFromConfig(cfg) {
  const c = cfg && typeof cfg === "object" ? cfg : {};
  const raw = (c.dsh && c.dsh.subagent) || c.subagent;
  return normalizePolicy(raw);
}

/** 这段文本用的是哪种换行：CRLF 的文件别插出裸 LF。
 *  混行之后「关掉再打开」就回不到逐字相同的出货文本（每次保存都判 changed、写一次盘，
 *  而且安装目录那份与出货版永久不再一致）。所有按行改写都走这里取换行符。 */
function eolOf(text) {
  return /\r\n/.test(String(text == null ? "" : text)) ? "\r\n" : "\n";
}

/** 改写一行的 `disabled:`（有就替换整行，没有就补在 name 行之后）。 */
function setDisabled(block, off) {
  const want = "  disabled: " + (off ? "true" : PLATFORM_DISABLED);
  /* 行内容一律用 [^\r\n]* 匹配：`.` 会把行尾的 \r 一起吃进来，替换 / 插行后行尾
     就变成裸 LF（CRLF 文件上不再幂等）。 */
  if (/^\s*disabled:[^\r\n]*/m.test(block))
    return block.replace(/^\s*disabled:[^\r\n]*/m, want);
  return block.replace(/^(\s*name:[^\r\n]*)$/m, (m0) => m0 + eolOf(block) + want);
}

/** 改写 / 补写 config 块里的一个标量（有就替换整行，没有就插在已知锚点行之后）。 */
function setConfigValue(block, key, value) {
  const line = "    " + key + ": " + value;
  const re = new RegExp("^\\s*" + key + ":[^\\r\\n]*", "m");
  if (re.test(block)) return block.replace(re, line);
  /* 插在 config 块内最后一个已知键之后；都不在就插在 `config:` 之后。
     锚点按「越靠后越优先」试，保证新键留在 config 块内部（不会被下一行的 - id 截走）。
     插进去的那一行用本块自己的换行（eolOf）—— 插裸 LF 会让 CRLF 文件从此不再幂等。 */
  const eol = eolOf(block);
  const anchors = ["backgroundMode", "toolName", "provider"];
  for (let i = 0; i < anchors.length; i++) {
    const ar = new RegExp("^([ \\t]*)" + anchors[i] + ":[^\\r\\n]*", "m");
    if (ar.test(block)) return block.replace(ar, (m0) => m0 + eol + line);
  }
  return block.replace(/^(\s*config:[^\r\n]*)$/m, (m0) => m0 + eol + line);
}

/** 删掉 config 块里的一个标量行（连同换行），没有就原样返回 —— 用来把「默认值」还原成
 *  「出货文件里本来没有这一行」的状态，保证关掉再打开能逐字回到原文件。 */
function delConfigValue(block, key) {
  const re = new RegExp("^[ \\t]*" + key + ":[^\\r\\n]*(\\r?\\n)?", "m");
  return re.test(block) ? block.replace(re, "") : block;
}

/**
 * 把策略写进一份 cordis.yml 文本。
 * @param {string} text 现 cordis.yml 全文
 * @param {object} rawPolicy 任意形状的策略（内部归一）
 * @returns {{text: string, changed: boolean}} 新全文与「是否真的改了字节」
 */
function applySubagentPolicy(text, rawPolicy) {
  const src = String(text == null ? "" : text);
  const policy = normalizePolicy(rawPolicy);
  /* 0.2 的 cordis.yml 是 profile 补丁层：顶层 `- id:` 是 id 覆盖行，插入段里的行缩进
     4 空格。两者都要认，否则插入段里的委派工具行永远改不到。 */
  const first = src.search(/^[ \t]*- id: /m);
  if (first < 0) return { text: src, changed: false };
  const head = src.slice(0, first);
  const blocks = src.slice(first).split(/^(?=[ \t]*- id: )/m);
  let changed = false;
  const next = blocks.map((block) => {
    const idm = block.match(/^\s*- id:\s*(\S+)/);
    if (!idm) return block;
    const row = SUBAGENT_ROWS[idm[1]];
    if (!row) return block;
    let b = block;
    const off = !policy.enabled || (row.fork && !policy.fork);
    b = setDisabled(b, off);
    if (row.tool) {
      b = setConfigValue(b, "maxDepth", policy.depth);
      if (row.spawn) {
        /* 后台并行：dsh 的默认就是 true，所以「允许」= 不写这一行（出货文件里没有它），
           「不允许」才物化成 enableRunInBackground: false —— 关掉再打开能逐字还原。 */
        b = policy.background
          ? delConfigValue(b, "enableRunInBackground")
          : setConfigValue(b, "enableRunInBackground", "false");
      }
    }
    if (b !== block) changed = true;
    return b;
  });
  return { text: head + next.join(""), changed };
}

/** 供设置界面 / 排障用：当前 cordis.yml 里参与策略的那些行是不是都被关着。 */
function subagentDisabledInCordis(text) {
  const src = String(text == null ? "" : text);
  const first = src.search(/^[ \t]*- id: /m);
  if (first < 0) return {};
  const out = {};
  for (const block of src.slice(first).split(/^(?=[ \t]*- id: )/m)) {
    const idm = block.match(/^\s*- id:\s*(\S+)/);
    if (!idm || !SUBAGENT_ROWS[idm[1]]) continue;
    out[idm[1]] = /^\s*disabled:\s*true\s*$/m.test(block);
  }
  return out;
}

module.exports = {
  SUBAGENT_IDS,
  SUBAGENT_ROWS,
  PLATFORM_DISABLED,
  DEPTHS,
  DEFAULT_POLICY,
  normalizePolicy,
  policyFromConfig,
  applySubagentPolicy,
  subagentDisabledInCordis,
};