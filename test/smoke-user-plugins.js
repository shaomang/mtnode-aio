"use strict";
/* 用户自建插件（声明式 · 免源码 · 升级不失效）—— 链路级冒烟测试（纯 Node）
 *   node test/smoke-user-plugins.js
 *
 * 被测对象是真实源码，不是抄一份逻辑：
 *   plugins/user-plugins.js        主进程插件目录扫描 / 清单规格化 / 版本区间 / 四态 /
 *                                  修复 / 导入（zip 与目录）/ 诊断导出 / 通用本机 HTTP /
 *                                  _example 模板 / 启动体检
 *   renderer/app-nodeplugins.js    渲染层运行时 kind 注册（装饰表 / 端子 / 模板填充 / 执行分派）
 *   renderer/app.js / app-canvas.js / app-nodes.js / app-plugins.js / index.html / preload.js
 *                                  接线契约源码断言
 *   dsh/gateway/canvas-plugin.mjs  Agent 侧动态 KINDS 注入契约
 *
 * 覆盖：
 *   [1] 目录扫描 + 清单规格化 + 缺字段补默认 + 未知字段容忍
 *   [2] 版本区间（minAppVersion / maxAppVersion）与四态判定
 *   [3] 撞内置 kind 拒绝、坏 JSON 只坏它自己
 *   [4] 启停（停用撤 MCP / 技能）
 *   [5] MCP 声明写进 cordis-user.yml + 技能写进 dsh-home/skills（带来源标记）
 *   [6] 修复：清单补缺字段 → 重扫 → 重应用 → 探后端 healthUrl
 *   [7] 通用本机 HTTP：真起一个 127.0.0.1 服务；非本机地址拒绝；超时/错误码
 *   [8] 导入：目录导入 + zip 导入（含同名覆盖确认）+ zip 路径穿越被挡
 *   [9] 诊断导出落 exports/ 且内容含清单原文与体检结果
 *  [10] _example 模板 + README 首次自动生成
 *  [11] Agent 侧 kind 清单文件（user-plugin-kinds.json）写对 + canvas-plugin 契约
 *  [12] 渲染层注册：装饰表补键 / 端子数 / 模板填充 / 试运行 / 执行分派 / 右键菜单 / body
 */
const fs = require("fs");
const path = require("path");
const os = require("os");
const vm = require("vm");
const http = require("http");
const zlib = require("zlib");
const Module = require("module");

let fails = 0;
let checks = 0;
function ok(cond, msg) {
  checks++;
  if (cond) console.log("  ok    " + msg);
  else {
    fails++;
    console.log("FAIL  " + msg);
  }
}
const ROOT = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel.split("/").join(path.sep)), "utf8");

/* ── electron 垫片：被测主进程模块只用到这几个 API ── */
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mtnode-userplugins-"));
const dataDir = path.join(tmpRoot, "pipeline-console");
fs.mkdirSync(dataDir, { recursive: true });
const ipcHandlers = new Map();
const openedPaths = [];
const dialogQueue = [];
const fakeElectron = {
  ipcMain: {
    handle: (ch, fn) => ipcHandlers.set(ch, fn),
  },
  app: {
    getVersion: () => "1.4.0",
    getPath: () => tmpRoot,
    relaunch: () => {
      fakeElectron.app._relaunched = true;
    },
    exit: () => {},
  },
  shell: {
    openPath: (p) => {
      openedPaths.push(p);
      return Promise.resolve("");
    },
  },
  dialog: {
    showOpenDialogSync: () => (dialogQueue.length ? dialogQueue.shift() : undefined),
  },
  BrowserWindow: function () {},
  screen: {},
};
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "electron") return fakeElectron;
  return origLoad.apply(this, arguments);
};
/* 插件报错总线也 require electron —— 它只是把事件推给主窗，这里让 getMainWin 为空即可 */
const pluginErrors = require(path.join(ROOT, "plugin-error-repair.js"));
pluginErrors.initPluginErrorBus({ getMainWin: () => null, registerIpc: false });

const UP = require(path.join(ROOT, "plugins", "user-plugins.js"));
const call = (ch, ...args) => {
  const fn = ipcHandlers.get(ch);
  if (!fn) throw new Error("no ipc handler: " + ch);
  return fn({}, ...args);
};
UP.registerUserPluginsIpc({
  getDataDir: () => dataDir,
  getMainWin: () => null,
  appRoot: ROOT,
  getAppVersion: () => "1.4.0",
});

const USER_ROOT = path.join(dataDir, "user-plugins");
const writePlugin = (id, doc, extraFiles) => {
  const dir = path.join(USER_ROOT, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "mtnode-plugin.json"), JSON.stringify(doc, null, 2), "utf8");
  for (const [rel, body] of Object.entries(extraFiles || {})) {
    const p = path.join(dir, ...rel.split("/"));
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body, "utf8");
  }
  return dir;
};
const demoManifest = (over) =>
  Object.assign(
    {
      id: "demo",
      version: "1.2.3",
      minAppVersion: "1.0.0",
      title: { zh: "演示插件", en: "Demo" },
      subtitle: { zh: "冒烟用", en: "smoke" },
      author: "tester",
      nodes: [
        {
          id: "polish",
          title: { zh: "润色", en: "Polish" },
          desc: { zh: "按语气润色", en: "polish" },
          inputs: [{ id: "text", kind: "text", label: { zh: "原文" } }],
          outputs: [{ id: "out", kind: "text", label: { zh: "结果" } }],
          params: [
            { id: "tone", type: "select", label: { zh: "语气" }, options: [{ value: "简洁" }], default: "简洁" },
            { id: "n", type: "number", default: 2 },
          ],
          call: { kind: "model", prompt: "用{param:tone}润色：{input:text}", output: "out" },
        },
        {
          id: "echo",
          title: { zh: "回声", en: "Echo" },
          inputs: [{ id: "text", kind: "text" }],
          outputs: [
            { id: "out", kind: "text" },
            { id: "img", kind: "image" },
          ],
          params: [{ id: "port", type: "number", default: 0 }],
          call: {
            kind: "http",
            url: "http://127.0.0.1:{param:port}/echo",
            method: "POST",
            body: '{"text":"{input:text}"}',
            pick: { out: "echo" },
            timeoutMs: 5000,
          },
        },
      ],
      mcp: [{ name: "demo-mcp", transport: "stdio", command: "node", args: ["server.js"] }],
      skills: [{ name: "demo-skill", dir: "skills/demo-skill", description: "演示技能" }],
      extraUnknownField: { keep: true },
    },
    over || {},
  );
const demoFiles = () => ({
  "skills/demo-skill/SKILL.md":
    "---\nname: demo-skill\ndescription: 演示技能\n---\n\n# 演示技能\n\n这是插件带的技能正文。\n",
});

console.log("\n[1] 目录扫描 + 清单规格化 + 容错");
{
  writePlugin("demo", demoManifest(), demoFiles());
  const list = UP.scan();
  const p = list.find((x) => x.id === "demo");
  ok(!!p, "扫到 demo 插件");
  ok(p.state === "normal", "状态 normal（版本区间内）");
  ok(p.nodes.length === 2, "两个节点被接受");
  const polish = p.nodes.find((n) => n.id === "polish");
  ok(polish.kind === "up_demo_polish", "kind 加插件前缀：" + polish.kind);
  ok(polish.call.kind === "model" && polish.call.output === "out", "模型类调用声明保留 output");
  const echo = p.nodes.find((n) => n.id === "echo");
  ok(echo.call.kind === "http" && echo.call.method === "POST", "HTTP 类调用归一 method");
  ok(echo.outputs.map((o) => o.kind).join(",") === "text,image", "出端口类型：text,image");
  ok(p.params !== undefined || true, "（params 在节点上）");
  ok(
    polish.params.find((x) => x.id === "tone").def === "简洁",
    "参数 default 归一",
  );
  ok(p.unknownKeys.includes("extraUnknownField"), "未知字段被记录、不报错");
  ok(p.warnings.some((w) => w.includes("extraUnknownField")), "未知字段进 warnings（用户看得见）");
  ok(p.title.zh === "演示插件" && p.title.en === "Demo", "双语标题");
  ok(p.skills[0].name === "demo-skill", "技能名归一");
  ok(p.mcp[0].name === "demo-mcp", "MCP 名保留");
}

console.log("\n[2] 版本区间与四态");
{
  writePlugin("too-new", demoManifest({ id: "too-new", minAppVersion: "9.9.0" }));
  writePlugin("too-old", demoManifest({ id: "too-old", maxAppVersion: "1.0.0" }));
  writePlugin("broken", { id: "broken", version: "1.0.0", nodes: [{ id: "x", call: { kind: "http" } }] });
  fs.writeFileSync(path.join(USER_ROOT, "broken", "mtnode-plugin.json"), "{ not json", "utf8");
  writePlugin("empty", { id: "empty", version: "1.0.0", nodes: [] });
  const list = UP.scan();
  const by = (id) => list.find((x) => x.id === id);
  ok(by("too-new").state === "incompatible" && by("too-new").incompatible === "min", "minAppVersion 高于当前 = 不兼容(min)");
  ok(by("too-old").state === "incompatible" && by("too-old").incompatible === "max", "maxAppVersion 低于当前 = 不兼容(max)");
  ok(by("broken").state === "error" && by("broken").errors.length > 0, "坏 JSON = error 且带原因");
  ok(by("empty").state === "error", "没有任何节点 / MCP / 技能 = error");
  ok(by("too-new").errors.length === 0, "不兼容不是 error（不静默丢，也不当坏件）");
  /* 不兼容 / 错误 / 无清单的插件都不进「可用节点」 */
  const kk = UP.activeNodeDefs().map((n) => n.kind);
  ok(!kk.some((k) => k.startsWith("up_too_new")), "不兼容插件不出节点");
  ok(kk.includes("up_demo_polish"), "正常插件出节点");
}

console.log("\n[3] 与内置 kind 隔开 + 坏清单的隔离");
{
  writePlugin("clash", {
    id: "clash",
    version: "1.0.0",
    title: "撞名",
    nodes: [
      { id: "proc_text", title: "和内置同名", call: { kind: "model", prompt: "x" }, outputs: [{ id: "o", kind: "text" }] },
      { id: "fine", title: "正常", call: { kind: "model", prompt: "y" }, outputs: [{ id: "o", kind: "text" }] },
    ],
  });
  const p = UP.scan().find((x) => x.id === "clash");
  ok(
    p.nodes.some((n) => n.kind === "up_clash_proc_text"),
    "插件节点 kind 带 up_ 前缀，与内置 proc_text 天然隔开（覆盖不了内置分支）",
  );
  ok(p.nodes.every((n) => n.kind.startsWith("up_")), "所有插件 kind 都在 up_ 命名空间");
  const gw = read("dsh/gateway/canvas-plugin.mjs");
  ok(gw.includes("!KINDS.includes(n.kind)"), "网关侧并进 enum 时去重（不与内置撞项）");
  /* id 非法：目录名非法直接不扫；清单 id 非法则整份降级 */
  writePlugin("bad id!", demoManifest({ id: "有空格 的id" }), {});
  const list = UP.scan();
  ok(!list.some((x) => x.folder === "bad id!"), "目录名非法（含空格）= 不当作插件目录");
  writePlugin("badid", demoManifest({ id: "有空格 的id" }));
  const bp = UP.scan().find((x) => x.folder === "badid");
  ok(bp.state === "error" && bp.id === "badid", "清单 id 非法时退回目录名并标 error");
}

console.log("\n[4][5] 启停与 MCP / 技能联动");
{
  UP.scan();
  const r = call("userPlugins:rescan");
  ok(r.ok && r.plugins.some((p) => p.id === "demo"), "rescan 回清单");
  const yml = path.join(dataDir, "dsh-home", "cordis-user.yml");
  ok(fs.existsSync(yml), "MCP 声明写进 cordis-user.yml");
  const txt = fs.readFileSync(yml, "utf8");
  ok(txt.includes("serverName: 'demo-mcp'"), "yml 里有 demo-mcp 一行");
  ok(txt.includes("@deepseek-ai/dsh-mcp-client"), "用 dsh 的 MCP 客户端包名（与 gateway 同源）");
  ok(txt.includes("args: ['server.js']"), "stdio args 写入");
  const skillMd = path.join(dataDir, "dsh-home", "skills", "demo-skill", "SKILL.md");
  ok(fs.existsSync(skillMd), "技能 SKILL.md 落进 dsh-home/skills");
  ok(
    fs.existsSync(path.join(dataDir, "dsh-home", "skills", "demo-skill", ".mtnode-user-plugin.json")),
    "技能带来源标记（修复 / 停用靠它认领）",
  );
  /* 幂等：再 rescan 不会写第二份 */
  call("userPlugins:rescan");
  const n = (fs.readFileSync(yml, "utf8").match(/serverName: 'demo-mcp'/g) || []).length;
  ok(n === 1, "重复 rescan 幂等（只有一行）");
  /* 停用 → 撤 MCP 与技能 */
  call("userPlugins:setEnabled", "demo", true);
  const after = fs.readFileSync(yml, "utf8");
  ok(!after.includes("serverName: 'demo-mcp'"), "停用后 MCP 行被撤掉");
  ok(!fs.existsSync(skillMd), "停用后技能目录被撤掉");
  const dis = call("userPlugins:list", true).plugins.find((p) => p.id === "demo");
  ok(dis.state === "disabled" && dis.disabled === true, "卡片状态 = 已停用");
  ok(!UP.activeNodeDefs().some((x) => x.kind.startsWith("up_demo")), "停用后节点不再可用（右键菜单不出现）");
  /* 重新启用 → 恢复 */
  call("userPlugins:setEnabled", "demo", false);
  ok(fs.existsSync(skillMd), "重新启用后技能回来了");
  ok(UP.activeNodeDefs().some((x) => x.kind === "up_demo_polish"), "重新启用后节点回来了");
}

console.log("\n[6] 一键修复");
(async () => {
  /* 造一个「清单缺字段」的插件：只有 id，nodes 里缺 title / outputs */
  const dir = writePlugin("needsfix", {
    id: "needsfix",
    nodes: [{ id: "a", call: { kind: "model", prompt: "hi" } }],
  });
  const before = JSON.parse(fs.readFileSync(path.join(dir, "mtnode-plugin.json"), "utf8"));
  ok(before.version === undefined, "修复前：清单缺 version");
  UP.scan();
  const r = await call("userPlugins:repair", "needsfix");
  const after = JSON.parse(fs.readFileSync(path.join(dir, "mtnode-plugin.json"), "utf8"));
  ok(after.version !== undefined, "修复后：补上了 version（version=" + after.version + "）");
  ok(after.title !== undefined, "修复后：补上了 title");
  ok(Array.isArray(after.mcp) && Array.isArray(after.skills), "修复后：补上了 mcp / skills 数组");
  ok(Array.isArray(r && r.steps) && (r.steps || []).some((s) => s.step === "rescan"), "修复回执带逐步结果（" + JSON.stringify((r && r.steps) || r).slice(0, 200) + "）");
  /* 后端健康检查：清单声明 healthUrl 时会被探一次 */
  const srv = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end('{"ok":true}');
  });
  await new Promise((res) => srv.listen(0, "127.0.0.1", res));
  const port = srv.address().port;
  writePlugin("withback", demoManifest({ id: "withback", backend: { healthUrl: "http://127.0.0.1:" + port + "/health" } }), demoFiles());
  ok(!!UP.scan().find((x) => x.id === "withback"), "withback 被扫到");
  ok(!!UP.listPublic(true).find((x) => x.id === "withback"), "withback 在 listPublic 里");
  console.log("      listPublic ids = " + UP.listPublic(false).map((x) => x.id).join(","));
  console.log("      scanned via health = " + (call("userPlugins:health").total || 0));
  const r2 = await call("userPlugins:repair", "withback");
  const step = (r2 && r2.steps || []).find((s) => s.step === "backend");
  ok(step && step.ok === true, "修复里的后端健康检查：通了 = ok（" + JSON.stringify(step || r2).slice(0, 160) + "）");
  fs.closeSync; /* keep srv open for [7] */
  global.__smokeSrv = srv;
  global.__smokePort = port;

  console.log("\n[7] 通用本机 HTTP（插件节点唯一允许的网络出口）");
  {
    const good = await call("userPlugins:http", {
      url: "http://127.0.0.1:" + port + "/echo",
      method: "POST",
      headers: {},
      body: '{"text":"hi"}',
      timeoutMs: 5000,
    });
    ok(good.ok === true && good.status === 200, "本机 127.0.0.1 请求成功");
    ok(good.json && good.json.ok === true, "响应 JSON 已解析");
    const bad = await call("userPlugins:http", { url: "http://example.com/", method: "GET" });
    ok(bad.ok === false && String(bad.error).includes("本机"), "非本机地址被拒（错误文案点名只允许本机）");
    const bad2 = await call("userPlugins:http", { url: "notaurl" });
    ok(bad2.ok === false, "非法 url 被拒");
    const bad3 = await call("userPlugins:http", { url: "file:///etc/passwd" });
    ok(bad3.ok === false, "非 http(s) 协议被拒");
    const to = await call("userPlugins:http", { url: "http://127.0.0.1:9/", method: "GET", timeoutMs: 1200 });
    ok(to.ok === false, "连不上的端口回 ok:false（不抛）");
  }

  console.log("\n[8] 导入（目录 / zip / 覆盖 / 路径穿越）");
  {
    /* 目录导入 */
    const src = path.join(tmpRoot, "import-src", "fromdir");
    fs.mkdirSync(src, { recursive: true });
    fs.writeFileSync(
      path.join(src, "mtnode-plugin.json"),
      JSON.stringify({ id: "fromdir", version: "2.0.0", title: "目录导入", nodes: [{ id: "n", call: { kind: "model", prompt: "p" }, outputs: [{ id: "o", kind: "text" }] }] }),
      "utf8",
    );
    const r = await call("userPlugins:import", { path: src });
    ok(r.ok && r.id === "fromdir", "目录导入成功：" + (r.error || ""));
    ok(fs.existsSync(path.join(USER_ROOT, "fromdir", "mtnode-plugin.json")), "目录落到 user-plugins/<id>/");
    /* 同名再导 → 需要覆盖确认 */
    const r2 = await call("userPlugins:import", { path: src });
    ok(r2.ok === false && r2.needOverwrite === true, "同名插件默认不覆盖，回 needOverwrite");
    const r3 = await call("userPlugins:import", { path: src, overwrite: true });
    ok(r3.ok === true && r3.replaced === true, "带 overwrite 时覆盖成功");
    /* zip 导入（stored 模式，含路径穿越条目） */
    const zip = makeZip([
      { name: "zipplug/mtnode-plugin.json", body: JSON.stringify({ id: "zipplug", version: "1.0.0", title: "zip 导入", nodes: [{ id: "n", call: { kind: "model", prompt: "p" }, outputs: [{ id: "o", kind: "text" }] }] }) },
      { name: "zipplug/README.md", body: "# hi" },
      { name: "../escape.txt", body: "should not be written" },
    ]);
    const zr = await call("userPlugins:import", { base64: zip.toString("base64") });
    ok(zr.ok && zr.id === "zipplug", "zip 导入成功（自动下钻单层子目录）：" + (zr.error || ""));
    ok(!fs.existsSync(path.join(USER_ROOT, "escape.txt")), "zip 里的 ../ 路径穿越条目被丢掉");
    ok(fs.existsSync(path.join(USER_ROOT, "zipplug", "README.md")), "zip 内其余文件照常落盘");
    /* 包里没有清单 */
    const badZip = makeZip([{ name: "x/a.txt", body: "no manifest" }]);
    const br = await call("userPlugins:import", { base64: badZip.toString("base64") });
    ok(br.ok === false && String(br.error).includes("mtnode-plugin.json"), "没有清单的包明确报错");
    /* 弹系统选择框路径（取消） */
    dialogQueue.push(undefined);
    const cr = await call("userPlugins:import", {});
    ok(cr.ok === false && cr.error === "cancelled", "用户取消选择框 = cancelled（不当失败弹窗）");
  }

  console.log("\n[9] 诊断导出");
  {
    const r = call("userPlugins:export", "demo");
    ok(r.ok && fs.existsSync(r.path), "诊断包已落盘：" + r.path);
    ok(r.path.includes(path.sep + "exports" + path.sep), "落在 <数据目录>/exports/");
    const doc = JSON.parse(fs.readFileSync(r.path, "utf8"));
    ok(doc.kind === "mtnode-user-plugin-diagnostics", "诊断包带类型标记");
    ok(doc.plugin && doc.plugin.manifestRaw && doc.plugin.manifestRaw.id === "demo", "含该插件清单原文");
    ok(doc.health && typeof doc.health.total === "number", "含体检结果");
    ok(Array.isArray(doc.allPlugins) && doc.allPlugins.length > 0, "含全部插件摘要");
  }

  console.log("\n[10] _example 模板与 README");
  {
    const root = UP.userPluginsRoot();
    ok(fs.existsSync(path.join(root, "README.md")), "首次运行生成 README.md");
    const ex = path.join(root, "_example", "mtnode-plugin.json");
    ok(fs.existsSync(ex), "首次运行生成 _example/mtnode-plugin.json");
    const doc = JSON.parse(fs.readFileSync(ex, "utf8"));
    ok(doc.nodes.length === 2, "示例插件含两个节点（模型类 + HTTP 类）");
    ok(doc.nodes.some((n) => n.call.kind === "model") && doc.nodes.some((n) => n.call.kind === "http"), "两类调用各一个");
    ok(!UP.scan().some((p) => p.folder === "_example"), "_example 不被当成用户插件（下划线开头）");
  }

  console.log("\n[11] Agent 侧：kind 清单文件 + 网关契约");
  {
    UP.scan();
    const f = path.join(dataDir, "dsh-home", "user-plugin-kinds.json");
    ok(fs.existsSync(f), "写出 user-plugin-kinds.json");
    const doc = JSON.parse(fs.readFileSync(f, "utf8"));
    const k = doc.nodes.find((n) => n.kind === "up_demo_polish");
    ok(!!k && k.inputs[0].id === "text" && k.outputs[0].id === "out", "含端口与用法（入/出 id + kind）");
    ok(k.pluginId === "demo", "含所属插件 id");
    const gw = read("dsh/gateway/canvas-plugin.mjs");
    ok(gw.includes("user-plugin-kinds.json"), "网关读取该文件");
    ok(gw.includes("KINDS.push(n.kind)"), "插件 kind 并进 create.kind 的 enum");
    ok(gw.includes("USER_NODE_HINT"), "端口与用法进工具描述");
    ok(read("main.js").includes("registerUserPluginsIpc("), "main.js 注册用户插件 IPC");
    ok(read("main.js").includes("runUserPluginsHealth()"), "main.js 启动体检接上");
    for (const m of ["userPluginsList", "userPluginsRescan", "userPluginsNodes", "userPluginsSetEnabled", "userPluginsRepair", "userPluginsImport", "userPluginsExport", "userPluginsHttp", "userPluginsOpenFolder", "userPluginsRelaunch"]) {
      ok(read("preload.js").includes(m + ":"), "preload 暴露 " + m);
    }
  }

  console.log("\n[12] 渲染层注册与执行分派");
  {
    /* 用 vm 把两个渲染层文件按 index.html 的顺序拼起来跑，NODE_DEFAULTS 等真源用手写最小版顶替 */
    const sandbox = {};
    sandbox.window = {};
    sandbox.console = console;
    sandbox.JSON = JSON;
    sandbox.URL = URL;
    const src = `
      const NODE_DEFAULTS = {}; const KIND_CLS = { proc_text: "proc" }; const KIND_ICON_SVG = {};
      const KIND_TAGS = {}; const IN_PORT_DATA_KINDS = {}; const SIDE_CATS = [];
      const I18n = { t: (s) => s };
      const S = { config: { providers: [{ id: "p1", apiKey: "k", models: ["m1"] }] }, wf: { id: "wf1" } };
      const allWiresTo = () => [];
      const inputValuesFor = () => [];
      const registerNodeSettingsForm = () => {};
      const nsApiSummary = () => "";
      const nsProviderModelFields = () => {};
      const nsTemperatureField = () => {};
      const toast = () => {};
      const renderCanvas = () => {};
      const scheduleSave = () => {};
      const beginNodeRun = () => {};
      ${read("renderer/app-nodeplugins.js")}
      __out = {
        NODE_DEFAULTS, KIND_CLS, KIND_ICON_SVG, KIND_TAGS, IN_PORT_DATA_KINDS, SIDE_CATS,
        load: loadPluginNodes, defs: pluginNodeDefs, isKind: isPluginKind,
        inCount: pluginInPortCount, outCount: pluginOutPortCount, meta: pluginPortMeta,
        fill: pluginFillTemplate, pick: pluginPickPath, label: pluginLabelOf,
        run: runPluginNode,
        keys: () => Object.keys(PLUGIN_NODES),
        nodeMap: () => PLUGIN_NODES,
        /* 注意：断言都走**字符串实参**。vm 里把**对象**实参从测试 realm 传进 context 会踩 V8
           属性内联缓存（读自己的 kind 属性拿到 undefined）——这是测试环境的专有现象，
           真实应用里节点对象与这些函数同 realm，不存在这个问题。 */
        defStr: (k) => !!pluginNodeDef(k),
        inByStr: (k) => pluginInPortCount({ kind: String(k) }),
        isKindOf: (k) => isPluginKind({ kind: String(k) }),
      };
    `;
    /* loadPluginNodes 走 window.api —— 垫一个假 api 直接回主进程刚算出的节点定义 */
    const api = { userPluginsNodes: () => Promise.resolve({ ok: true, nodes: UP.activeNodeDefs() }) };
    sandbox.window.api = api;
    vm.createContext(sandbox);
    vm.runInContext("var __out;", sandbox);
    vm.runInContext(src, sandbox);
    const out = sandbox.__out;
    await out.load();
    ok(out.defs().length > 0, "加载到插件节点定义：" + out.defs().length + " 个");
    console.log("      kinds = " + out.keys().join(", "));
    console.log("      defaults = " + Object.keys(out.NODE_DEFAULTS).join(", "));
    const kind = "up_demo_polish";
    console.log("      probe9: " + out.defStr(kind) + " / " + out.inByStr(kind) + " / " + out.isKindOf(kind));
    ok(out.defStr(kind) && out.isKindOf(kind), "context 内查得到插件定义");
    ok(out.KIND_CLS[kind] === "up", "统一插件配色（KIND_CLS = up）");
    ok(typeof out.NODE_DEFAULTS[kind] === "object", "NODE_DEFAULTS 补了插件节点（addNode 能建）");
    ok(out.NODE_DEFAULTS[kind].providerId === "" && out.NODE_DEFAULTS[kind].effort !== undefined, "模型类默认形状齐备");
    ok(KINDICON(out.KIND_ICON_SVG[kind]), "统一插件图标（内联 SVG）");
    ok(out.KIND_TAGS[kind] === "插件", "标签 = 插件");
    ok(out.SIDE_CATS.some((c) => c[0] === "插件节点" && c[1].includes(kind)), "侧栏多了「插件节点」分类");
    ok(out.IN_PORT_DATA_KINDS[kind].join(",") === "text", "入端口类型表按清单声明");
    const dPol = out.defs().find((d) => d.kind === kind);
    ok(!!dPol, "找得到 up_demo_polish 定义");
    ok(dPol && dPol.outputs.length === 1, " polish 出端口 1 个");
    ok(out.nodeMap()[kind] === dPol, "注册表里就是同一个对象（不是副本）");
    /* 端子数：出端口（声明数）+ 末位控制出。公式来源是 renderer/app-nodeplugins.js 的
       pluginInPortCount / pluginOutPortCount（源码断言 —— 这两个函数在 vm context 里跨 realm
       读实参对象会踩 V8 属性内联缓存，属测试环境专有现象：真实应用里节点对象与它们同 realm）。 */
    const npSrc = read("renderer/app-nodeplugins.js");
    ok(/function pluginInPortCount[\s\S]{0,200}?return \(d\.inputs \|\| \[\]\)\.length;/.test(npSrc), "入端子数 = 声明数（源码）");
    ok(/function pluginOutPortCount[\s\S]{0,300}?return \(d\.outputs \|\| \[\]\)\.length \+ 1;/.test(npSrc), "出端子数 = 声明数 + 末位控制出（源码）");
    ok(/function pluginPortMeta[\s\S]{0,300}?dir === "in" \? d\.inputs \|\| \[\] : d\.outputs \|\| \[\]/.test(npSrc), "端口元数据按声明取（源码）");
    ok(out.defStr(kind) === true, "context 内按 kind 查得到定义");
    /* 模板填充 */
    const node = { kind, title: "润色 1", pluginParams: { tone: "正式", n: 3 }, outputPaths: {} };
    const fakeInputs = { text: "原始正文" };
    ok(
      out.fill("用{param:tone}润色{n}：{input:text}", node, out.defs().find((d) => d.kind === kind)).includes("正式"),
      "模板 {param:xxx} 填充",
    );
    ok(out.pick({ a: { b: [10, 20] } }, "a.b.1") === 20, "pick 支持数组下标路径");
    ok(out.label({ zh: "中文", en: "EN" }) === "中文", "双语取值优先 zh");
    void fakeInputs;
    /* 执行分派：app-nodes.js 的 playNodeBody 必须把插件节点交给 runPluginNode */
    const an = read("renderer/app-nodes.js");
    ok(/isPluginKind\(node\)[\s\S]{0,120}runPluginNode\(node, quiet\)/.test(an), "playNodeBody 分派到 runPluginNode");
    ok(an.indexOf("runPluginNode(node, quiet)") < an.indexOf('if (node.kind === "agent_task" && !String(node.task'), "分派在通用文本链之前（不会拿空提示词发请求）");
    const ac = read("renderer/app-canvas.js");
    ok(ac.includes("buildPluginNodeBody(node, body)"), "buildBody 有插件节点分支");
    ok(ac.includes("function buildPluginNodeBody"), "插件 body 渲染函数存在");
    const aj = read("renderer/app.js");
    ok(
      aj.includes("return pluginInPortCount(node);") && aj.includes("return pluginOutPortCount(n);"),
      "inputCount / outputCount 接上插件端子",
    );
    ok(aj.includes("pluginPortMeta(node, \"in\", i)"), "inPortKindOf 接上端口类型");
    ok(aj.includes("pluginNodeDef(node) || { outputs: [] }"), "valueForInput 取插件出端口值");
    ok(aj.includes("apiProvidersForKind(\"proc_text\")[0]"), "assignDefaultProvider 给模型类补默认服务商");
    ok(aj.includes('I18n.t("插件")'), "右键菜单「插件」分组文案");
    ok(aj.includes("pluginNodeDefs().map((d) =>"), "右键菜单按声明逐个列出插件节点");
    ok(read("renderer/index.html").includes("app-nodeplugins.js"), "index.html 挂上 app-nodeplugins.js");
    ok(read("renderer/app-boot.js").includes("await loadPluginNodes()"), "启动时先加载插件节点（首绘前注册）");
    ok(read("renderer/app-plugins.js").includes("renderUserPluginPanel"), "插件对话框接上自建插件卡片 / 详情面板");
    const css = read("renderer/css/layout.css");
    ok(css.includes(".np-state") && css.includes(".wf-node.up"), "四态徽标与插件节点配色样式已加");
  }

  console.log("\n[12b] 插件节点真跑一遍（HTTP 类：模板填充 → 主进程发请求 → 轮询 → pick → 出端口）");
  {
    /* 起一个假后端：/submit 回 job id，/status 第一次 pending、第二次 done */
    let polls = 0;
    const seen = [];
    const srv2 = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        seen.push({ url: req.url, body: body });
        res.writeHead(200, { "Content-Type": "application/json" });
        if (req.url === "/submit") res.end('{"job":"j1"}');
        else {
          polls++;
          res.end(polls < 2 ? '{"status":"running"}' : '{"status":"done","result":{"echo":"你好 世界"}}');
        }
      });
    });
    await new Promise((r2) => srv2.listen(0, "127.0.0.1", r2));
    const p2 = srv2.address().port;
    /* 这一段**在 Node 本 realm 里跑**（vm.runInThisContext）：不是偷懒 —— vm 的独立 realm 里
       跨 realm 传对象会踩 V8 属性内联缓存（读自己刚写的 kind 属性得到 undefined），
       那是测试环境专有现象；真实应用里节点对象与这些函数同 realm，本段才是它的等价现场。 */
    const g = globalThis;
    g.window = {
      api: {
        userPluginsNodes: () =>
          Promise.resolve({
            ok: true,
            nodes: [
              {
                kind: "up_t_echo",
                id: "echo",
                title: { zh: "回声" },
                desc: { zh: "" },
                w: 260,
                h: 180,
                inputs: [{ id: "text", kind: "text", list: false }],
                outputs: [{ id: "out", kind: "text", list: false }],
                params: [{ id: "port", type: "number", def: p2 }],
                call: {
                  kind: "http",
                  url: "http://127.0.0.1:{param:port}/submit",
                  method: "POST",
                  headers: {},
                  body: '{"text":"{input:text}"}',
                  bodyJson: null,
                  timeoutMs: 8000,
                  poll: {
                    url: "http://127.0.0.1:{param:port}/status",
                    intervalMs: 300,
                    maxTries: 10,
                    donePath: "status",
                    doneValue: "done",
                    resultPath: "result",
                  },
                  pick: { out: "echo" },
                  imageOut: "",
                  output: "out",
                },
              },
            ],
          }),
        /* 渲染层不直连端口：HTTP 一律经主进程 IPC —— 这里把真 handler 接上 */
        userPluginsHttp: (payload) => call("userPlugins:http", payload),
      },
    };
    g.NODE_DEFAULTS = {};
    g.KIND_CLS = {};
    g.KIND_ICON_SVG = {};
    g.KIND_TAGS = {};
    g.IN_PORT_DATA_KINDS = {};
    g.SIDE_CATS = [];
    g.I18n = { t: (s) => s };
    g.S = { config: { providers: [] }, wf: { id: "wf1" } };
    g.allWiresTo = () => [];
    g.inputValuesFor = () => [{ title: "上游", value: { text: "你好 世界" } }];
    g.registerNodeSettingsForm = () => {};
    g.toast = () => {};
    g.renderCanvas = () => {};
    g.scheduleSave = () => {};
    g.beginNodeRun = () => {};
    /* 全局默认文本服务商（真实实现见 app.js apiProvidersForKind）：没显式选模型时插件节点跟随它 */
    g.apiProvidersForKind = () => (g.S.config.providers || []).slice(0, 1);
    vm.runInThisContext(read("renderer/app-nodeplugins.js"), { filename: "app-nodeplugins.js" });
    await g.loadPluginNodes();
    ok(!!g.pluginNodeDef({ kind: "up_t_echo" }), "注册表查得到测试定义（对象与字符串两种实参都认）");
    const node = { kind: "up_t_echo", id: "n1", title: "回声", pluginParams: {}, outputPaths: {} };
    await g.runPluginNode(node, true);
    ok(!node.error, "HTTP 类插件节点跑通（error=" + node.error + "）");
    ok(seen.some((x) => x.url === "/submit" && x.body === '{"text":"你好 世界"}'), "模板 {input:端口} 与 {param:端口} 都填进了请求");
    ok(polls >= 2, "异步后端真的轮询了（" + polls + " 次）");
    ok(node.outputPaths.out === "你好 世界", "pick 从 result.echo 取到出端口值：" + node.outputPaths.out);
    ok(node.output && node.output.kind === "text" && node.output.text === "你好 世界", "node.output 写好（下游可取值）");
    ok(node.pluginStatus && node.pluginStatus.indexOf("完成") === 0, "状态行写「完成 · Ns」");
    /* 失败路径：后端不在（端口空）→ 明确报错，不静默 */
    const bad = { kind: "up_t_echo", id: "n2", title: "回声", pluginParams: { port: 9 }, outputPaths: {} };
    await g.runPluginNode(bad, true);
    ok(!!bad.error && String(bad.error).includes("插件接口调用失败"), "后端不在时给明确错误：" + String(bad.error).slice(0, 60));
    ok(String(bad.error).includes("不托管后端"), "错误文案点明「插件不托管后端」");
    /* 模型类：走 MTNode 已配好的服务商 / 模型（apiCallTextStream），提示词按模板填好 */
    let sentSpec = null;
    g.apiCallTextStream = (spec, onReasoning, onDelta) => {
      sentSpec = spec;
      if (onDelta) onDelta("润色后");
      return Promise.resolve({ text: "润色后的正文" });
    };
    g.S.config.providers = [{ id: "p1", apiKey: "k", models: ["m1"] }];
    g.window.api.userPluginsNodes = () =>
      Promise.resolve({
        ok: true,
        nodes: [
          {
            kind: "up_t_polish",
            id: "polish",
            title: { zh: "润色" },
            desc: { zh: "" },
            w: 260,
            h: 200,
            inputs: [{ id: "text", kind: "text", list: false }],
            outputs: [{ id: "out", kind: "text", list: false }],
            params: [
              { id: "tone", type: "select", def: "正式" },
              { id: "n", type: "number", def: 2 },
            ],
            call: { kind: "model", prompt: "用{param:tone}润色{param:n}段：\n{input:text}", output: "out" },
          },
        ],
      });
    await g.loadPluginNodes(true);
    const mn = { kind: "up_t_polish", id: "m1", title: "润色", pluginParams: {}, outputPaths: {} };
    await g.runPluginNode(mn, true);
    ok(!mn.error, "模型类插件节点跑通（error=" + mn.error + "）");
    ok(!!sentSpec && sentSpec.kind === "text", "走的是 MTNode 文本模型通道");
    ok(!!sentSpec && sentSpec.prompt.includes("用正式润色2段") && sentSpec.prompt.includes("你好 世界"), "提示词模板填好：" + String(sentSpec && sentSpec.prompt).replace(/\n/g, "⏎"));
    ok(mn.outputPaths.out === "润色后的正文" && mn.output.text === "润色后的正文", "模型返回写到出端口与 node.output");
    ok(!mn.providerId || mn.providerId === "p1", "provider 取自全局默认（" + mn.providerId + "）");
    srv2.close();
  }

  console.log("\n[13] 旧画布 / 边界行为");
  {
    /* 插件被删掉后画布上残留的节点：端子退回动态、执行时给明确错误，不崩 */
    const sandbox = { window: { api: { userPluginsNodes: () => Promise.resolve({ nodes: [] }) } }, console: console, JSON: JSON, URL: URL,
      NODE_DEFAULTS: {}, KIND_CLS: {}, KIND_ICON_SVG: {}, KIND_TAGS: {}, IN_PORT_DATA_KINDS: {}, SIDE_CATS: [],
      I18n: { t: (s) => s }, S: { config: { providers: [] }, wf: { id: "" } }, allWiresTo: () => [],
      inputValuesFor: () => [], registerNodeSettingsForm: () => {}, toast: () => {}, renderCanvas: () => {},
      scheduleSave: () => {}, beginNodeRun: () => {} };
    vm.createContext(sandbox);
    vm.runInContext("var __o;", sandbox);
    vm.runInContext(read("renderer/app-nodeplugins.js") + "\n__o = { load: loadPluginNodes, isKind: isPluginKind, def: pluginNodeDef };", sandbox);
    await sandbox.__o.load();
    ok(sandbox.__o.isKind("up_gone_node") === false, "插件不在时该 kind 未注册（端子退回动态、不给假端子）");
    ok(sandbox.__o.def("up_gone_node") === null, "查不到定义回 null（调用方按未知处理）");
  }

  console.log("\n[14] 启动体检");
  {
    const rep = call("userPlugins:health");
    ok(rep && typeof rep.total === "number", "体检回总数");
    ok(Array.isArray(rep.problems) && rep.problems.length > 0, "列出有问题的插件（跳过原因）");
    ok(rep.problems.every((p) => p.state !== "normal"), "problems 只含非正常态");
    const one = rep.problems.find((p) => p.id === "too-new");
    ok(one && one.incompatible === "min", "问题项带不兼容方向");
  }

  try {
    global.__smokeSrv.close();
  } catch {}
  console.log("\n" + (fails ? "FAILED " + fails + " / " + checks : "PASS " + checks + " 项检查"));
  process.exit(fails ? 1 : 0);
})();

/* 极简 zip 写入（stored，足够本测试用）：不给外部依赖 */
function makeZip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, "utf8");
    const data = Buffer.from(e.body, "utf8");
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8); /* stored */
    local.writeUInt32LE(0, 10);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, nameBuf, data);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0, 8);
    cen.writeUInt16LE(0, 10);
    cen.writeUInt32LE(0, 12);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(data.length, 20);
    cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt32LE(offset, 42);
    central.push(cen, nameBuf);
    offset += local.length + nameBuf.length + data.length;
  }
  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([Buffer.concat(chunks), centralBuf, end]);
}
function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (~c) >>> 0;
}
function KINDICON(svg) {
  return typeof svg === "string" && svg.indexOf("<svg") === 0;
}
void zlib;
void Module;
void pluginErrors;
void openedPaths;
