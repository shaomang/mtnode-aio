/* moss-tts/main-moss-tts.js 的离线联调（开发期手动跑，不是发版链的一部分）
 *
 * 没有 Electron 窗口也能验证主进程那一半：
 *   ① 用假 electron（app / ipcMain / dialog / shell）把模块 require 进来
 *   ② 数据目录指向 %TEMP%\mtnode-moss-e2e（里头的 app / venv / models 用 junction
 *      指向 scripts/smoke-moss-tts.ps1 已经装好的那一份，不重复下载 380MB）
 *   ③ 依次调 getState → enable → speak → cancel → disable，断言：
 *      installed/running 状态、内置音色解析、chunk 事件转发、关掉后进程释放
 *
 * 前提：先跑过一次 scripts/smoke-moss-tts.ps1（它把 venv 与权重装好）。
 * 用法：node scripts/e2e-moss-tts-host.js
 */
"use strict";
const path = require("path");
const fs = require("fs");
const os = require("os");
const { execFileSync } = require("child_process");

const repo = path.join(__dirname, "..");
const smoke = path.join(os.tmpdir(), "moss-tts-smoke");
const data = path.join(os.tmpdir(), "mtnode-moss-e2e");

if (!fs.existsSync(path.join(smoke, "models"))) {
  console.error("先跑 scripts/smoke-moss-tts.ps1（缺 " + smoke + "\\models）");
  process.exit(2);
}

/* ── 假 electron ─────────────────────────────────────────────────────── */
const handlers = new Map();
const sent = [];
const fakeElectron = {
  app: { isPackaged: false, getPath: () => data, on: () => {} },
  ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
  shell: { openPath: async () => "" },
};
const Module = require("module");
const origLoad = Module._load;
Module._load = function (req, parent, isMain) {
  if (req === "electron") return fakeElectron;
  return origLoad.call(this, req, parent, isMain);
};

/* ── 数据目录（venv / models / app 用 junction 复用冒烟那份）─────────────── */
function junction(target, link) {
  fs.rmSync(link, { recursive: true, force: true });
  try {
    execFileSync("cmd", ["/c", "mklink", "/J", link, target], { stdio: "ignore" });
  } catch {
    fs.cpSync(target, link, { recursive: true });
  }
}
const root = path.join(data, "moss-tts");
fs.mkdirSync(root, { recursive: true });
for (const sub of ["app", "venv", "models"]) junction(path.join(smoke, sub), path.join(root, sub));
fs.mkdirSync(path.join(root, "out"), { recursive: true });
fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ enabled: true, voice: { kind: "builtin" } }));

/* Breeze 预设影子（有真机数据就照抄一份最小的：索引 + 第一条音色音频），
   用来验证「引用 Breeze 角色」这条指针解析，没装 Breeze 就跳过那段断言 */
const breezeSrc = path.join(process.env.APPDATA || "", "pipeline-console", "pipeline-console", "breeze-tts", "presets");
const breezeDst = path.join(data, "breeze-tts", "presets");
let breezeReady = false;
try {
  const idx = JSON.parse(fs.readFileSync(path.join(breezeSrc, "index.json"), "utf8"));
  const first = (idx.presets || []).find((x) => (x.groups || []).some((g) => g.audioFile));
  if (first) {
    fs.mkdirSync(path.join(breezeDst, "audio"), { recursive: true });
    const g = first.groups.find((x) => x.audioFile);
    fs.copyFileSync(path.join(breezeSrc, "audio", g.audioFile), path.join(breezeDst, "audio", g.audioFile));
    fs.writeFileSync(
      path.join(breezeDst, "index.json"),
      JSON.stringify({ presets: [{ id: first.id, name: first.name, groups: [{ id: g.id, name: g.name, kind: g.kind, audioFile: g.audioFile }] }] })
    );
    breezeReady = true;
  }
} catch (_) {}

const host = require(path.join(repo, "moss-tts", "main-moss-tts.js"));
host.registerMossTtsIpc({
  getDataDir: () => data,
  getMainWin: () => ({
    isDestroyed: () => false,
    webContents: { send: (ch, payload) => sent.push({ ch, payload }) },
  }),
  appRoot: repo,
});

const call = (name, arg) => handlers.get(name)({}, arg);

(async () => {
  const st = await call("mosstts:getState");
  console.log("state:", JSON.stringify({
    enabled: st.enabled, installed: st.installed, running: st.running,
    voice: st.voice && st.voice.name, breeze: (st.breeze || []).length,
  }));
  if (!st.installed) throw new Error("installed 应为 true");
  if (st.voice.kind !== "builtin") throw new Error("默认音色应解析成内置 builtin");

  if (breezeReady) {
    if (!(st.breeze || []).length) throw new Error("Breeze 预设没被读到");
    const sw = await call("mosstts:setVoice", { kind: "breeze", presetId: st.breeze[0].id, groupId: st.breeze[0].groups[0].id });
    console.log("breeze ->", sw.state.voice.kind, sw.state.voice.name, sw.state.voice.fallback ? "(回落)" : "");
    if (sw.state.voice.kind !== "breeze") throw new Error("Breeze 指针没生效");
    await call("mosstts:setVoice", { kind: "builtin" });
  }

  const en = await call("mosstts:enable");
  console.log("enable:", en.ok, "voice=", en.state.voice && en.state.voice.name);
  if (!en.ok) throw new Error("enable 失败：" + en.error);

  const t0 = Date.now();
  const sp = await call("mosstts:speak", { id: "e2e1", text: "联调测试：这句是内置语音念出来的。第二句验证分句。" });
  console.log("speak:", sp.ok, sp.error || "", "voice=", sp.voice);
  if (!sp.ok) throw new Error("speak 失败：" + sp.error);

  /* 等第一个 chunk（含首次加载模型，约 10 秒） */
  const chunk = await new Promise((resolve) => {
    const timer = setInterval(() => {
      const ev = sent.find((x) => x.ch === "mosstts:event" && x.payload.type === "chunk");
      if (ev) {
        clearInterval(timer);
        resolve(ev.payload);
      } else if (Date.now() - t0 > 90000) {
        clearInterval(timer);
        resolve(null);
      }
    }, 200);
  });
  if (!chunk) throw new Error("90 秒内没有 chunk 事件");
  const bytes = fs.existsSync(chunk.path) ? fs.statSync(chunk.path).size : 0;
  console.log("chunk:", chunk.index, chunk.ms + "ms", chunk.path, bytes + "B");
  if (bytes < 20000) throw new Error("wav 太小，可能没出声");

  /* 打断：再发一句，应当 cancel 掉上一句 */
  await call("mosstts:cancel", "e2e1");
  const sp2 = await call("mosstts:speak", { id: "e2e2", text: "第二段播报。" });
  console.log("speak2:", sp2.ok);

  const dis = await call("mosstts:disable");
  console.log("disable:", dis.ok, "enabled=", dis.state.enabled, "running=", dis.state.running);
  if (dis.state.enabled) throw new Error("disable 后 enabled 仍为 true");
  await new Promise((r) => setTimeout(r, 800));
  const st2 = await call("mosstts:getState");
  if (st2.running) throw new Error("disable 后 worker 仍在跑");
  console.log("OK：主进程这一半（状态 / 启用 / 合成 / 打断 / 释放）都通过");
  process.exit(0);
})().catch((e) => {
  console.error("FAIL:", e && e.message);
  process.exit(1);
});
