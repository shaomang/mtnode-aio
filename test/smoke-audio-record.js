"use strict";
/* 音频节点「现场录制」回归（纯 Node，无 Electron / 无真实 DOM）
 *   node test/smoke-audio-record.js
 *
 * 钉住的共识（见本模块开发任务书 + 拷问共识）：
 *  [1] 命名与口径：record_{yyyymmddhhmmss}.mp3（时间 = 按下录制那一刻）、同秒重名 _2/_3、
 *      落点 = 画布工作目录下 recordings/、计时文本、应用目录守卫
 *  [2] 真 mp3：随包 lamejs（renderer/vendor/lame.min.js）**真编码**出一份 mp3
 *      （帧头同步字 + 体积对得上 128 kbps），编码器缺失时明确返回 null（不静默出半成品）
 *  [3] 采样链：多声道 → 单声道、48k → 44.1k、Float32 → Int16 的钳位
 *  [4] 落盘与绑定：写入 fileWriteBytes（主进程会自建 recordings/ 目录）、只写 .mp3、
 *      绑定节点时就地换文件并**清掉旧转录**、磁盘原名不删
 *  [5] 面板口径：居中模态（#overlay）+ persistent + min:false（不给通用 ✕）、
 *      「停止并保存」/「取消（二次确认）」两个显式出口、Esc = 取消
 *  [6] 接线：index.html 先挂 vendor/lame.min.js 再挂 app-recaudio.js、style.css 引入样式、
 *      app-canvas.js 只给**音频**节点挂「录制」按钮与录制中徽标、i18n 中英词条齐备
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

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
function eq(a, b, msg) {
  ok(a === b, msg + "（期望 " + JSON.stringify(b) + "，实得 " + JSON.stringify(a) + "）");
}
const ROOT = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel.split("/").join(path.sep)), "utf8");
const exists = (rel) => fs.existsSync(path.join(ROOT, rel.split("/").join(path.sep)));

/* ═══════════ 沙箱：lame.min.js（真编码器）+ app-recaudio.js（被测模块） ═══════════ */
function load(opts) {
  opts = opts || {};
  const sandbox = {};
  sandbox.window = sandbox;
  sandbox.console = console;
  sandbox.I18n = { t: (s) => String(s) };
  sandbox.document = {
    createElement: () => ({ style: {}, dataset: {}, className: "", appendChild() {} }),
    getElementById: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
    removeEventListener() {},
  };
  sandbox.requestAnimationFrame = () => 0;
  sandbox.cancelAnimationFrame = () => {};
  sandbox.setInterval = () => 0;
  sandbox.clearInterval = () => {};
  sandbox.window.api = {
    fileExists: async () => ({ ok: false }),
    fileWriteBytes: async () => ({ ok: true }),
    appDirs: async () => ({ ok: true, dirs: [] }),
  };
  vm.createContext(sandbox);
  if (opts.lame !== false)
    vm.runInContext(read("renderer/vendor/lame.min.js"), sandbox, { filename: "lame.min.js" });
  vm.runInContext(read("renderer/app-recaudio.js"), sandbox, { filename: "app-recaudio.js" });
  return sandbox;
}

/* 1 秒 44.1k 单声道正弦（与真机探针同一素材口径） */
function sine(seconds, freq, amp, rate) {
  const n = Math.round(seconds * rate);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.sin((2 * Math.PI * freq * i) / rate) * amp;
  return out;
}

/* 顶层 await 在 CJS 里不允许：整段跑在 async 里（第 [5] 节要 await 落盘取名） */
async function main() {
console.log("[1] 命名 / 落点 / 计时 / 应用目录守卫");
{
  const s = load();
  const stamp = vm.runInContext("recStamp", s);
  const name = vm.runInContext("recFileName", s);
  const dirOf = vm.runInContext("recRecordingsDir", s);
  const clock = vm.runInContext("recFmtClock", s);
  const insideApp = vm.runInContext("recDirInsideApp", s);
  /* 本地时区：2026-01-02 03:04:05 → yyyymmddhhmmss */
  const d = new Date(2026, 0, 2, 3, 4, 5);
  eq(stamp(d), "20260102030405", "recStamp 是 yyyymmddhhmmss（本地时区，逐位补零）");
  eq(name(d, 1), "record_20260102030405.mp3", "文件名 = record_{time}.mp3");
  eq(name(d, 2), "record_20260102030405_2.mp3", "同秒重名追加 _2");
  eq(name(d, 99), "record_20260102030405_99.mp3", "后缀一路可用到 _99");
  eq(name(d, 0), "record_20260102030405.mp3", "非法序号回落成第一份（不生成 _0）");
  const d2 = new Date(2026, 11, 31, 23, 59, 59);
  eq(stamp(d2), "20261231235959", "跨年跨月都按本地时间取（12 月 31 日 → 1231）");

  eq(dirOf("E:/proj"), "E:/proj/recordings", "落点 = 工作目录下的 recordings/");
  eq(dirOf("E:/proj/"), "E:/proj/recordings", "工作目录尾上的斜杠不会拼成双斜杠");
  eq(dirOf(""), "", "工作目录未设置 → 空串（调用方给「先设置工作目录」的提示）");
  s.joinPath = (...p) => p.join("/");
  eq(dirOf("E:/proj"), "E:/proj/recordings", "有 joinPath 时走既有路径拼接（与 save 节点同源）");

  eq(clock(0), "00:00", "计时 0 → 00:00");
  eq(clock(12000), "00:12", "计时 12 秒 → 00:12");
  eq(clock(3723000), "1:02:03", "超过 1 小时 → 1:02:03");
  eq(clock(-5), "00:00", "负数不出现负计时");

  ok(insideApp("E:/app/renderer", ["E:/app"]) === true, "工作目录落在应用目录里 → 判为不允许");
  ok(insideApp("E:/APP/recordings", ["e:/app"]) === true, "同口径大小写不敏感");
  ok(insideApp("E:/app2", ["E:/app"]) === false, "同前缀但不是子目录 → 不误判");
  ok(insideApp("E:/proj", []) === false, "取不到应用目录时不拦（不误伤正常项目）");
}

console.log("\n[2] 真 mp3 编码（随包 lamejs）");
{
  const s = load();
  ok(
    exists("renderer/vendor/lame.min.js") && exists("renderer/vendor/lamejs.LICENSE"),
    "renderer/vendor/ 里 lame.min.js 与随附 LICENSE 都在（LGPL 要求随附许可）",
  );
  eq(vm.runInContext("typeof lamejs", s), "function", "lame.min.js 是经典 script：全局 lamejs 直接可用");
  const enc = vm.runInContext("recEncodeMp3", s);
  const bytes = enc(sine(1, 440, 0.5, 44100), 44100, 128);
  ok(bytes && bytes.length > 0, "1 秒 44.1k 单声道 → 编出字节（编码器真跑起来了）");
  ok(bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0, "首帧同步字是 MPEG 帧头（FF Ex/Fx）");
  /* 128 kbps = 16000 B/s：1 秒应当落在 0.8~1.3 秒的量级里 */
  const estSec = (bytes.length * 8) / 128000;
  ok(estSec > 0.8 && estSec < 1.3, "体积与 128 kbps 对得上（估得 " + estSec.toFixed(2) + " 秒）");
  ok(bytes.length > 4000 && bytes.length < 40000, "体积量级合理（不是半成品也不是空文件）");
  ok(enc(new Float32Array(0), 44100, 128) === null, "空样本 → null（不出 0 字节文件）");

  const noLame = load({ lame: false });
  eq(vm.runInContext("typeof lamejs", noLame), "undefined", "对照沙箱：没挂 lame.min.js");
  eq(vm.runInContext("recEncoder", noLame)(), null, "编码器缺失 → recEncoder() 给 null");
  eq(
    vm.runInContext("recEncodeMp3", noLame)(sine(0.2, 440, 0.5, 44100), 44100, 128),
    null,
    "编码器缺失时明确返回 null（调用方按「未保存」提示，不静默改名）",
  );
}

console.log("\n[3] 采样链：单声道 / 44.1k / Int16 钳位");
{
  const s = load();
  const down = vm.runInContext("recDownmix", s);
  const rs = vm.runInContext("recResampleMono", s);
  const toInt16 = vm.runInContext("recFloatToInt16", s);
  const left = new Float32Array([1, 0, -1, 0.5]);
  const right = new Float32Array([0, 0, -1, -0.5]);
  const mono = down({
    numberOfChannels: 2,
    length: 4,
    getChannelData: (c) => (c === 0 ? left : right),
  });
  eq(mono.length, 4, "多声道 → 单声道：样本数不变");
  ok(Math.abs(mono[0] - 0.5) < 1e-6 && Math.abs(mono[3]) < 1e-6, "逐样本取平均（不是丢掉一路）");
  const src = sine(1, 220, 0.5, 48000);
  const out = rs(src, 48000, 44100);
  eq(out.length, 44100, "48k → 44.1k 重采样：长度按比例（1 秒 → 44100 样本）");
  ok(rs(src, 44100, 44100).length === src.length, "采样率已经对了就原样返回（不做无谓重采样）");
  const pcm = toInt16(new Float32Array([1, -1, 2, -3, NaN]));
  eq(pcm[0], 32767, "满幅正样本 → 32767");
  eq(pcm[1], -32768, "满幅负样本 → -32768");
  eq(pcm[2], 32767, "越界样本被钳位（不是绕回成负峰）");
  eq(pcm[3], -32768, "负向越界同样钳位");
  eq(pcm[4], 0, "NaN → 0");
}

console.log("\n[4] 落盘与绑定：只写 mp3、就地换文件、清掉旧转录");
{
  const s = load();
  const node = {
    id: "a1",
    kind: "input_audio",
    mediaAsset: "E:/旧/old.wav",
    sourceName: "old",
    asrTranscripts: [{ path: "E:/旧/old.wav", text: "上一份录音的文字" }],
    asrState: "ok",
  };
  const cleared = [];
  s.spCacheClear = (p) => cleared.push(p);
  const setMedia = [];
  s.setNodeMedia = (n, p) => {
    setMedia.push(p);
    n.mediaAsset = p;
    n.sourceName = "record_20260102030405";
    return true;
  };
  const dest = "E:/proj/recordings/record_20260102030405.mp3";
  vm.runInContext("recBindNode", s)(node, dest, "E:/旧/old.wav");
  eq(node.mediaAsset, dest, "节点就地指向新录的文件（原文件只是不再被引用，磁盘上不删）");
  eq((node.asrTranscripts || []).length, 0, "旧转录被清掉（不拿上一份录音的文字冒充这一份）");
  eq(node.asrState, "", "转录状态复位（下次点「转录」照常重转）");
  ok(
    cleared.indexOf("E:/旧/old.wav") >= 0,
    "旧文件路径的转写缓存也清了（spCacheClear，与「清空转录」同口径）",
  );
  eq(setMedia[0], dest, "绑定走既有 setNodeMedia（清下游 + 落盘计划与选文件同一条路）");

  /* setNodeMedia 不在（老 renderer）时的兜底：自己写字段并清下游 */
  const s2 = load();
  let downstream = "";
  s2.clearDownstream = (id) => (downstream = id);
  s2.imageStem = (p) => "record_stem";
  const node2 = { id: "a2", kind: "input_audio", mediaAsset: "E:/旧/old2.wav", asrTranscripts: [] };
  vm.runInContext("recBindNode", s2)(node2, dest, "E:/旧/old2.wav");
  eq(node2.mediaAsset, dest, "没有 setNodeMedia 时也照样把节点指向新文件");
  eq(downstream, "a2", "兜底路径同样清下游（下游不会拿旧音频的结果继续用）");
}

console.log("\n[5] 同秒重名：磁盘与本次会话一起看");
{
  const s = load();
  const pick = vm.runInContext("recPickFreePath", s);
  const d = new Date(2026, 0, 2, 3, 4, 5);
  const dir = "E:/proj/recordings";
  s.window.api.fileExists = async () => ({ ok: false });
  eq(await pick(dir, d, new Set()), dir + "/record_20260102030405.mp3", "没占用 → 第一份");
  s.window.api.fileExists = async (p) => ({ ok: /record_20260102030405\.mp3$/.test(p) });
  eq(
    await pick(dir, d, new Set()),
    dir + "/record_20260102030405_2.mp3",
    "磁盘上已有同名 → 自动退到 _2（不覆盖用户已有的录音）",
  );
  s.window.api.fileExists = async () => ({ ok: false });
  eq(
    await pick(dir, d, new Set([dir + "/record_20260102030405.mp3"])),
    dir + "/record_20260102030405_2.mp3",
    "同一秒里连录两段：会话内已写过的路径也算占用",
  );
}

console.log("\n[6] 面板与出口（源码口径）");
{
  const src = read("renderer/app-recaudio.js");
  ok(
    src.indexOf('openOverlay(I18n.t("录制音频"), { persistent: true, min: false })') > 0,
    "面板是 #overlay 居中模态 + persistent + min:false（不给通用 ✕，出口只在窗内）",
  );
  ok(
    src.indexOf('addEventListener("keydown", live.keyHandler, true)') > 0 &&
      src.indexOf('ev.key !== "Escape"') > 0 &&
      src.indexOf("ev.stopPropagation()") > 0,
    "Esc 走本模块的捕获监听（等同取消），不让它穿到画布快捷键",
  );
  ok(
    src.indexOf('live.stopBtn.textContent = I18n.t("停止并保存")') > 0 &&
      src.indexOf('live.cancelBtn.textContent = I18n.t("取消")') > 0,
    "出口只有「停止并保存 / 取消」两颗按钮",
  );
  ok(
    src.indexOf("mtDialogForm({") > 0 &&
      src.indexOf('I18n.t("取消这次录制？")') > 0 &&
      src.indexOf('label: I18n.t("丢弃并取消")') > 0,
    "取消要再确认一次（已录内容不静默丢掉）",
  );
  ok(
    !/ev\.target\s*===\s*host/.test(src) &&
      src.indexOf('$("#overlay").addEventListener("click"') < 0 &&
      src.indexOf("closeOverlay();\n  };") < 0,
    "没有「点外部 / 点蒙层关闭」的实现（AGENTS.md 的 persistent 铁律）",
  );
  ok(
    src.indexOf('new MediaRecorder(stream, { mimeType: mime, audioBitsPerSecond: 128000 })') > 0,
    "采集走 MediaRecorder（webm/opus；本机实测 mp3 容器浏览器给不了）",
  );
  ok(
    src.indexOf("decodeAudioData") > 0 && src.indexOf("REC_SR = 44100") > 0 && src.indexOf("REC_KBPS = 128") > 0,
    "采集 → 解码 → 44.1 kHz 单声道 → 128 kbps（共识音质档）",
  );
  ok(
    (src.match(/fileWriteBytes\(/g) || []).length === 1 && src.indexOf("recFileName") > 0,
    "全模块只有一处写盘，写的路径一律来自 recFileName（.mp3）",
  );
  ok(
    src.indexOf("live.chunks.push(ev.data)") > 0 && src.indexOf('blob.arrayBuffer()') > 0,
    "录制中只在内存里攒块，停止后才落盘（取消 = 一个字节都不写）",
  );
  ok(
    src.indexOf("appDirs") > 0 && src.indexOf("recDirInsideApp") > 0,
    "数据不落应用目录：工作目录被设成应用目录时明确拒绝",
  );
  ok(
    src.indexOf("void recStartForNode(node)") > 0 && src.indexOf("recAppendNodeBadge") > 0,
    "对外入口齐备（recOpsButton / recAppendNodeBadge / recStartForNode）",
  );
  /* 真机探针抓到的坑：开工前取工作目录必须**无参**调用（传 "" 会被 recRecordingsDir 当成
     「工作目录未设置」→ 直接提示先设置，录制根本起不来） */
  ok(
    src.indexOf("const dir = recRecordingsDir();") > 0,
    "取工作目录走无参调用（不把空串当成「工作目录未设置」）",
  );
}

console.log("\n[7] 接线：脚本顺序 / 样式 / 节点挂点 / i18n / 桥");
{
  const html = read("renderer/index.html");
  const iVendor = html.indexOf('<script src="vendor/lame.min.js"></script>');
  const iRec = html.indexOf('<script src="app-recaudio.js"></script>');
  const iCanvas = html.indexOf('<script src="app-canvas.js"></script>');
  const iAudioView = html.indexOf('<script src="app-audioview.js"></script>');
  ok(iVendor > 0 && iRec > iVendor, "index.html：先挂 vendor/lame.min.js，再挂 app-recaudio.js");
  ok(iAudioView > 0 && iRec > iAudioView, "app-recaudio.js 排在 app-audioview.js 之后");
  ok(iCanvas > iRec, "app-recaudio.js 排在 app-canvas.js 之前（节点 body 挂点就在它里面）");
  ok(read("renderer/style.css").indexOf('@import url("./css/recaudio.css")') > 0, "style.css 引入了 recaudio.css");
  const css = read("renderer/css/recaudio.css");
  ok(
    /\.rec-wave\s*\{/.test(css) && /\.rec-dot\s*\{/.test(css) && /\.n-rec-badge\s*\{/.test(css),
    "样式面：面板实时声波 / 录制红点 / 节点徽标都在",
  );
  ok(css.indexOf("body.theme-light") > 0, "亮色主题有覆盖（跟其它模块同一写法）");

  const canvas = read("renderer/app-canvas.js");
  ok(
    canvas.indexOf("if (!isVid && typeof recOpsButton === \"function\")") > 0,
    "「录制」按钮只给音频节点（视频节点本轮不做）",
  );
  ok(
    canvas.indexOf("ops.appendChild(recOpsButton(node))") > 0 &&
      canvas.indexOf("if (!isVid && typeof recAppendNodeBadge === \"function\")") > 0,
    "操作行挂按钮、body 尾部挂录制态徽标，两者都按 typeof 取（模块不在也不炸）",
  );

  const i18n = read("renderer/i18n.js");
  for (const pair of [
    '"录制": "Record"',
    '"录制中": "Recording"',
    '"录制音频": "Record audio"',
    '"停止并保存": "Stop and save"',
    '"取消这次录制？": "Cancel this recording?"',
    '"丢弃并取消": "Discard and cancel"',
    '"正在生成 mp3…": "Generating mp3…"',
    '"已录成音频并绑定到该节点：": "Recorded and bound to this node: "',
  ]) {
    ok(i18n.indexOf(pair) > 0, "i18n 有词条：" + pair);
  }
  ok(
    i18n.indexOf('"录制前请先在顶栏设置工作目录：录好的文件会落在那里的 recordings/ 目录"') > 0,
    "i18n 有「先设置工作目录」那一条（工作目录未设置时不静默换地方）",
  );

  ok(
    read("preload.js").indexOf("fileWriteBytes:") > 0,
    "preload 暴露 fileWriteBytes（落盘通道是既有的）",
  );
  const main = read("main.js");
  ok(
    main.indexOf('ipcMain.handle("file:writeBytes"') > 0 && main.indexOf("mk(path.dirname(dest))") > 0,
    "主进程 file:writeBytes 会自动建父目录（recordings/ 不存在也能写）",
  );

  const guide = read("guides/nodes/input_audio.md");
  ok(guide.indexOf("录制") > 0 && guide.indexOf("recordings/") > 0, "节点指南写明了现场录制与落点");
}

} /* main */

main()
  .catch((err) => {
    fails++;
    console.log("FAIL  冒烟自身抛错：" + ((err && err.stack) || err));
  })
  .then(() => {
    console.log("\n" + (fails ? "FAILED " + fails + " / " + checks : "ALL OK (" + checks + ")"));
    process.exit(fails ? 1 : 0);
  });
