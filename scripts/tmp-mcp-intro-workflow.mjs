/**
 * 一次性驱动脚本（不随包发版）：用 MTNode 自带的 MCP 服务端，在**全新环境**里建出
 * 「MTNode 自我介绍视频工作流」这张展示用画布。
 *
 * 做法（与 guides/mcp-server.md §2.2 的 HTTP 形态一致）：
 *   1. 以独立数据目录拉起一份干净 MTNode（--mcp-intro-profile，不影响用户在跑的实例）；
 *   2. 等 <数据目录>/mcp-server.json 落盘拿到 port + token（服务端随应用启动即监听）；
 *   3. 按 MCP 协议 POST /mcp：initialize → notifications/initialized → tools/list
 *      → tools/call mtnode_canvas_get（拿 contentHash）→ tools/call mtnode_canvas_edit（一笔建完）
 *      → tools/call mtnode_canvas_get（自证节点数 / 连线数）；
 *   4. 报告落 JSON，最后关闭这份干净实例。
 *
 * 只读现场：不改仓库源码、不碰用户默认数据目录；所有写操作都发生在独立数据目录里。
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

function argOf(name, dflt) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}

const PROFILE = path.resolve(argOf("--profile", path.join(ROOT, ".mcp-intro-profile")));
const DATA_DIR = path.join(PROFILE, "pipeline-console");
const REPORT = path.resolve(argOf("--report", path.join(PROFILE, "report.json")));
const ELECTRON = path.resolve(argOf("--electron", path.join(ROOT, "node_modules", "electron", "dist", "electron.exe")));
const WAIT_MS = Number(argOf("--wait", "120000"));
const KEEP_RUNNING = process.argv.includes("--keep");
/** 这张展示画布的名字：预置空画布时用，MCP 侧也原样带上（解析目标画布） */
const CANVAS_NAME = "MTNode 自我介绍视频工作流";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (s) => process.stdout.write(s + "\n");
const t0 = Date.now();

const report = { at: new Date().toISOString(), profile: PROFILE, dataDir: DATA_DIR, steps: [], ok: false };
function step(name, ok, detail) {
  report.steps.push({ name, ok: !!ok, detail: detail == null ? "" : String(detail).slice(0, 4000) });
  log((ok ? "PASS " : "FAIL ") + name + (detail ? "  ‹ " + String(detail).replace(/\s+/g, " ").slice(0, 400) + " ›" : ""));
}

/* ── MCP over HTTP（JSON 响应形态） ─────────────────────────────────────── */
let port = 0;
let token = "";
let sessionId = "";
let rpcId = 0;

async function mcp(method, params) {
  const headers = { "content-type": "application/json", accept: "application/json" };
  headers.authorization = "Bearer " + token;
  if (sessionId) headers["mcp-session-id"] = sessionId;
  const res = await fetch("http://127.0.0.1:" + port + "/mcp", {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params: params || {} }),
  });
  const sid = res.headers.get("mcp-session-id");
  if (sid) sessionId = sid;
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {}
  if (res.status !== 200 && res.status !== 202) throw new Error("HTTP " + res.status + " " + text.slice(0, 300));
  return json;
}

/** tools/call → { ok, text, structured } */
async function callTool(name, args) {
  const msg = await mcp("tools/call", { name, arguments: args || {} });
  if (msg && msg.error) return { ok: false, text: "协议错误：" + JSON.stringify(msg.error) };
  const r = (msg && msg.result) || {};
  const text = (r.content || []).map((c) => c.text || "").join("\n");
  return { ok: !r.isError, text, structured: r.structuredContent || null };
}

/* ── 干净实例 ───────────────────────────────────────────────────────────── */
function launchApp(tag) {
  fs.mkdirSync(PROFILE, { recursive: true });
  const logPath = path.join(PROFILE, "app.out.log");
  const fd = fs.openSync(logPath, "a");
  report.appLog = logPath;
  const child = spawn(
    ELECTRON,
    ["--user-data-dir=" + path.join(PROFILE, "userdata"), ROOT, "--mcp-intro-profile"],
    {
      cwd: ROOT,
      env: { ...process.env, MTNODE_DATA_DIR: PROFILE, ELECTRON_DISABLE_SECURITY_WARNINGS: "1" },
      /* 不用管道：本机沙箱下 piped stdio 的 spawn 会被拒（EPERM）；文件 fd 不建管道，
         既能留住应用的 stdout/stderr（排障），又不触发那条约束。 */
      stdio: ["ignore", fd, fd],
      detached: false,
    },
  );
  fs.writeFileSync(logPath, "\n===== " + tag + " @ " + new Date().toISOString() + " =====\n", { flag: "a" });
  child.on("exit", (code, sig) => {
    report.lastExit = { code, sig, ms: Date.now() - t0, tag };
    log("·· 应用进程退出 code=" + code + " sig=" + sig + "（" + (Date.now() - t0) + "ms · " + tag + "）");
  });
  return child;
}

function killApp(child) {
  try {
    spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  } catch {}
}

/** 预置一张空画布：save/<id>.json + config 的 activeWorkflowId / visitedWorkflows。
    必须在应用关着的时候写（配置以启动时读到的为准）。 */
function seedEmptyCanvas(name) {
  const id = "wf_" + Date.now().toString(36);
  const saveDir = path.join(DATA_DIR, "save");
  fs.mkdirSync(saveDir, { recursive: true });
  const wf = {
    id,
    name,
    nodes: [],
    wires: [],
    groups: [],
    marks: [],
    workspace: "",
    tagCatalog: [],
    longtask: {},
    inlineAssets: [],
  };
  fs.writeFileSync(path.join(saveDir, id + ".json"), JSON.stringify(wf, null, 2), "utf8");
  const cfgPath = path.join(DATA_DIR, "config.json");
  const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
  const visited = Array.isArray(cfg.visitedWorkflows) ? cfg.visitedWorkflows : [];
  cfg.visitedWorkflows = [{ id, name }].concat(visited.filter((v) => v && v.id !== id)).slice(0, 20);
  cfg.activeWorkflowId = id;
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), "utf8");
  return { id, name, file: path.join(saveDir, id + ".json") };
}

/** 带重试的 MCP 调用：渲染层要等窗口加载完才接得住，早期几次可能 fetch failed / 超时。 */
async function mcpRetry(method, params, tries = 3) {
  let last = null;
  for (let i = 0; i < tries; i++) {
    try {
      return await mcp(method, params);
    } catch (e) {
      last = e;
      log("   · " + method + " 第 " + (i + 1) + " 次失败：" + ((e && e.message) || e));
      await sleep(2500);
    }
  }
  throw last;
}

async function callToolRetry(name, args, tries = 3) {
  const msg = await mcpRetry("tools/call", { name, arguments: args || {} }, tries);
  if (msg && msg.error) return { ok: false, text: "协议错误：" + JSON.stringify(msg.error) };
  const r = (msg && msg.result) || {};
  const text = (r.content || []).map((c) => c.text || "").join("\n");
  return { ok: !r.isError, text, structured: r.structuredContent || null };
}

async function waitForServer(mtimeBefore) {
  const fp = path.join(DATA_DIR, "mcp-server.json");
  const deadline = Date.now() + WAIT_MS;
  let last = "还没生成";
  while (Date.now() < deadline) {
    try {
      const st = fs.statSync(fp);
      const j = JSON.parse(fs.readFileSync(fp, "utf8"));
      /* 必须等**本次启动**新写的状态文件（端口由服务端每次启动刷新）：
         上一趟留下的文件里字段一样齐全，直接读会拿到已关闭的旧端口。 */
      if (!mtimeBefore || st.mtimeMs > mtimeBefore + 500) {
        if (j && Number(j.port) > 0 && j.token) return { port: Number(j.port), token: String(j.token), state: j, file: fp, mtimeMs: st.mtimeMs };
      }
      last = "port=" + (j && j.port) + " enabled=" + (j && j.enabled) + " mtime=" + st.mtimeMs;
    } catch (e) {
      last = (e && e.message) || String(e);
    }
    await sleep(1000);
  }
  throw new Error("等待 mcp-server.json 超时（" + fp + "，最后一次：" + last + "）");
}

/** 当前 mcp-server.json 的 mtime（没有则 0）：下一次启动要等它被刷新 */
function serverStateMtime() {
  try {
    return fs.statSync(path.join(DATA_DIR, "mcp-server.json")).mtimeMs;
  } catch {
    return 0;
  }
}

/* ── 建图数据（蓝图） ───────────────────────────────────────────────────── */
const BRIEF = [
  "【视频主题】用一支 90 秒短视频介绍 MTNode（本机 AI 工作流编排器）是什么、能做什么。",
  "【目标受众】第一次接触 AI 工作流工具的创作者与技术爱好者。",
  "【语气】第一人称、平实、不用营销腔。",
  "【时长】旁白控制在 300 字以内（约 90 秒）。",
  "【必须讲到的点】① 画布上摆节点、连线即可搭出自动化流程；② 节点覆盖文本 / 图像 / 语音 / 音乐 / 视频五类能力；③ 智能体会话能读改画布；④ 素材库 / 创意工坊 / 讨论区；⑤ 数据全部留在本机。",
  "【不要写】任何本项目里不存在的功能、价格或承诺。",
].join("\n");

const VO_PROMPT = [
  "根据 @主题与受众 的要求，写一份 90 秒短视频的旁白脚本（旁白正文，不要标题、不要时间码）：",
  "",
  "1. 开场 15 秒：一句话说清 MTNode 是什么，以及它替用户省掉了什么。",
  "2. 三个使用步骤，每步 10–12 秒：配置服务商与 API Key；在画布上摆节点、连线、写提示词；点运行看结果。",
  "3. 能力探索 20 秒：文本处理与图像生成、语音合成、音乐与视频生成、智能体会话、素材库与创意工坊。",
  "4. 收尾 10 秒：本机运行、数据留在自己的数据目录、可保存与导出工作流。",
  "",
  "要求：全中文口播腔，短句，每句不超过 25 字；总字数 260–300 字；不含画面指示与音乐提示。",
].join("\n");

const SB_PROMPT = [
  "把 @旁白脚本 拆成一张镜头表，Markdown 表格，列为：镜号 | 时间码 | 画面（含动效） | 字幕（取自旁白原句）。",
  "",
  "约束：",
  "- 共 6 个镜头（S1–S6），时间码连续、合计 90 秒；",
  "- 画面描述是「屏幕录制 + 动效」的写法，不要真人出境、不要真实照片；",
  "- 每条画面必须写明动效（如：节点依次淡入 / 连线自左向右生长 / 列表逐条滑入）；",
  "- 只使用 @旁白脚本 里出现过的信息，不新增功能描述。",
].join("\n");

const RENDER_PROMPT = [
  "为《MTNode 自我介绍》合成一支 1920x1080 · 30fps · 90 秒的横版短视频（mp4，含字幕）。",
  "",
  "依据：",
  "- 旁白与文案：@旁白脚本",
  "- 镜头与动效：@分镜脚本",
  "",
  "视觉要求：深色底 + 单一强调色；字幕居中底部、逐句淡入淡出；镜头之间用 0.3 秒位移过渡；节点与连线用线框示意，不出现任何真实品牌 Logo 或照片。",
  "",
  "产出：整片 mp4，交给下游保存节点落盘。",
].join("\n");

function buildEdit(baseHash) {
  return {
    baseHash,
    canvas: CANVAS_NAME,
    setWorkflowName: CANVAS_NAME,
    /* 端子口径（读 renderer/app.js：outputCount 4200 / IN_PORT_DATA_KINDS 6430）：
       · input_text / proc_text 只有 1 个输出端子（端口 0）——没有「端口 1 控制出」，
         本图是纯数据流，不接控制线；
       · proc_text 的输入端子随连线长出来：端口 0 = 提示词、端口 1+ = 数据槽；
       · remotion 固定端子：端口 0 = 控制输入 · 端口 1 = 描述文本（只此一个数据口），
         所以「旁白 + 分镜」先汇进一颗文本节点，再接端口 1。 */
    create: [
      { alias: "brief", kind: "input_text", title: "主题与受众", text: BRIEF },
      { alias: "vo", kind: "proc_text", title: "旁白脚本", prompt: VO_PROMPT },
      { alias: "sb", kind: "proc_text", title: "分镜脚本", prompt: SB_PROMPT },
      {
        alias: "pack",
        kind: "proc_text",
        title: "成片素材整备",
        prompt: [
          "把上游内容整备成 Remotion 能直接照着做的「成片素材包」，四段，全部 Markdown：",
          "",
          "## 一、旁白定稿",
          "整理 @旁白脚本 的正文：按 90 秒节奏分好句、标出每句大约的起止秒数（15s / 25s / 35s …），",
          "不改写内容、不新增功能描述。",
          "",
          "## 二、镜头表",
          "原样带上 @分镜脚本 的镜头表（镜号 | 时间码 | 画面含动效 | 字幕）。",
          "",
          "## 三、字幕清单",
          "从镜头表里把字幕逐句抽出来，一行一句，标上对应镜号。",
          "",
          "## 四、视觉规范",
          "把旁白与镜头表里出现过的视觉要求归拢成一份清单：画幅 1920x1080、帧率 30fps、总时长 90 秒、",
          "深色底 + 单一强调色、字幕居中底部逐句淡入淡出、镜头之间 0.3 秒位移过渡、只出现线框示意。",
          "",
          "只使用上游出现过的信息；缺什么就写「上游未给出」，不要自行编造。",
        ].join("\n"),
      },
      {
        alias: "render",
        kind: "remotion",
        title: "视频合成（Remotion）",
        prompt: RENDER_PROMPT,
        remotionSize: "1920x1080",
        fps: 30,
        duration: 90,
      },
      { alias: "out", kind: "save", title: "成片落盘", savePath: "MTNode-自我介绍.mp4", auto: false },
    ],
    connect: [
      { from: "brief", to: "vo", toIndex: 0 },
      { from: "brief", to: "sb", toIndex: 0 },
      { from: "vo", to: "sb", toIndex: 0 },
      { from: "vo", to: "pack", toIndex: 1 },
      { from: "sb", to: "pack", toIndex: 2 },
      { from: "pack", to: "render", toIndex: 1 },
      { from: "render", to: "out" },
    ],
    group: { title: "MTNode 自我介绍视频工作流", nodes: ["brief", "vo", "sb", "pack", "render", "out"] },
    createMarks: [
      {
        kind: "text",
        text: "MTNode 自我介绍视频工作流 · 只做展示，不运行：全新环境未配服务商与 Remotion 插件，节点 ▶ 会红字提示「未安装 / 未配置模型」属预期。",
        color: "#8ab4f8",
        fontSize: 16,
      },
      { kind: "box", label: "① 输入 · 主题与受众", around: ["brief"], color: "#7aa2f7" },
      { kind: "box", label: "② 处理 · 脚本 / 分镜 / 素材整备", around: ["vo", "sb", "pack"], color: "#9ece6a" },
      { kind: "box", label: "③ 合成与落盘", around: ["render", "out"], color: "#c792ea" },
    ],
  };
}

/* ── 主流程 ─────────────────────────────────────────────────────────────── */
async function main() {
  log("MTNode MCP · 全新环境建图（自我介绍视频工作流）");
  log("  仓库     " + ROOT);
  log("  独立档位 " + PROFILE);
  log("  数据目录 " + DATA_DIR);

  fs.mkdirSync(PROFILE, { recursive: true });

  /* ── 第 1 趟：让全新环境自己把数据目录 / config.json 建出来 ───────────── */
  const app1 = launchApp("boot-1");
  report.appPid = app1.pid;
  step("拉起全新环境 MTNode（独立数据目录 + 独立 user-data-dir）", !!app1.pid, "pid=" + app1.pid);
  const srv1 = await waitForServer(serverStateMtime());
  port = srv1.port;
  token = srv1.token;
  step(
    "MCP 服务端随启动即监听（端口 + 令牌落盘）",
    true,
    "port=" + port + " token=" + token.slice(0, 8) + "… enabled=" + srv1.state.enabled,
  );

  /* ── 预置一张空画布：MCP 只能改「已存在的画布」（mcp-bridge 按 id / 名称解析）── */
  killApp(app1);
  await sleep(5000);
  const seeded = seedEmptyCanvas(CANVAS_NAME);
  report.canvas = seeded;
  step("预置空画布（save/<id>.json + config.activeWorkflowId）", fs.existsSync(seeded.file), seeded.id + " · " + seeded.file);

  /* ── 第 2 趟：干净实例重新打开这张空画布，再经 MCP 建图 ───────────────── */
  const staleMtime = serverStateMtime();
  const app2 = launchApp("boot-2");
  report.appPid2 = app2.pid;
  const srv = await waitForServer(staleMtime);
  port = srv.port;
  token = srv.token;
  sessionId = "";
  step("重启后 MCP 服务端再次就绪", true, "pid=" + app2.pid + " port=" + port + " token=" + token.slice(0, 8) + "…");

  const init = await mcpRetry("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "mtnode-intro-workflow-driver", version: "1.0.0" },
  });
  step(
    "initialize 握手",
    !!(init.result && init.result.serverInfo),
    JSON.stringify((init.result && init.result.serverInfo) || init.error),
  );
  await mcpRetry("notifications/initialized", {});

  const tl = await mcpRetry("tools/list", {});
  const tools = ((tl.result && tl.result.tools) || []).map((t) => t.name);
  step("tools/list 出 8 个工具", tools.length === 8, tools.join(", "));

  /* 先读一次图：拿到 contentHash，并确认服务端认识这张空画布 */
  const before = await callToolRetry("mtnode_canvas_get", { detail: "minimal", sections: ["nodes", "wires"] }, 5);
  report.before = before.structured || before.text;
  const beforeObj = before.structured && typeof before.structured === "object" ? before.structured : null;
  const hash = beforeObj && typeof beforeObj.contentHash === "string" ? beforeObj.contentHash : "";
  const beforeNodes = (beforeObj && beforeObj.nodes) || [];
  step(
    "读取空画布（拿到 contentHash）",
    before.ok && !!hash && beforeNodes.length === 0,
    "ok=" + before.ok + " hash=" + hash + " 节点数=" + beforeNodes.length + " 画布=" + JSON.stringify((beforeObj && beforeObj.workflow) || null),
  );

  /* 一笔建完 */
  const edit = await callToolRetry("mtnode_canvas_edit", buildEdit(hash));
  report.edit = edit.structured || edit.text;
  step("建图（6 节点 / 7 数据线 / 1 分组 / 3 分区框）", edit.ok, edit.text.slice(0, 2000));
  const editWarns = (edit.structured && edit.structured.warnings) || [];
  step("建图回执无 warnings", editWarns.length === 0, JSON.stringify(editWarns).slice(0, 800));

  /* 自证 */
  const after = await callToolRetry("mtnode_canvas_get", { detail: "minimal", sections: ["nodes", "wires", "groups", "marks"] });
  report.after = after.structured || after.text;
  const afterObj = after.structured && typeof after.structured === "object" ? after.structured : null;
  const nodes = (afterObj && afterObj.nodes) || [];
  const wires = (afterObj && afterObj.wires) || [];
  const groups = (afterObj && afterObj.groups) || [];
  const marks = (afterObj && afterObj.marks) || [];
  step("自证：节点数 = 6", nodes.length === 6, "实际 " + nodes.length + "：" + nodes.map((n) => n.title || n.id).join(" / "));
  step("自证：连线数 = 7（全部数据线）", wires.length === 7, "实际 " + wires.length);
  step("自证：分组 = 1", groups.length === 1, "实际 " + groups.length);
  step("自证：绘制 = 4（1 条说明 + 3 个分区框）", marks.length === 4, "实际 " + marks.length);

  report.port = port;
  report.tokenPrefix = token.slice(0, 8);
  report.ok = report.steps.every((s) => s.ok);
  fs.writeFileSync(REPORT, JSON.stringify(report, null, 2), "utf8");
  log("报告：" + REPORT);

  if (!KEEP_RUNNING) {
    step("关闭这份干净实例（未运行任何节点）", true, "taskkill pid=" + app2.pid);
    killApp(app2);
  }
  log(report.ok ? "RESULT: OK" : "RESULT: FAIL");
  process.exit(report.ok ? 0 : 1);
}

main().catch((e) => {
  report.error = (e && e.stack) || String(e);
  try {
    fs.writeFileSync(REPORT, JSON.stringify(report, null, 2), "utf8");
  } catch {}
  log("RESULT: FAIL — " + ((e && e.message) || e));
  process.exit(1);
});
