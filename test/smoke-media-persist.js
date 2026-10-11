"use strict";
/* 媒体播放持久化回归（纯 Node，无 Electron / 无真实浏览器）
 *   node test/smoke-media-persist.js
 *
 * 本轮需求（两个问题）：
 *   ① 音频预览在「点别处 / 切窗口 / 最小化」时不再被中断 —— 要不在 focus 也继续放；
 *   ② 视频播放器能进全屏。
 *
 * 钉住的共识（见本模块开发任务书 + 拷问共识）：
 *  [1] 音频播放引擎是**全局一只**（挂在 body 上），不在每只波形播放器里 —— 所以节点
 *      DOM 每次重绘被整体拆掉重建也拆不掉它；全应用只剩波形播放器这一种音频形态
 *  [2] 互斥：另一只播放器起播即顶掉上一只（后者回「未播放」），同一音源重复设置不乱停
 *  [3] 重绘不清空播放进度：外壳被摘出文档时**不**在重绘路径上停播，真删掉才由收尾回收
 *  [4] 视频：同一「路径 + 宿主槽位」重绘复用同一只 <video>（进度与播放态随元素走）
 *  [5] 全屏托底：<video> 挂在带 transform 的 .fn-stage 下时，requestFullscreen 前先抬到
 *      body 占位容器，退出全屏自动归位；占位容器不能有 overflow（规范禁止）
 *  [6] 接线：index.html 挂 app-mediaview.js、app-canvas.js 的预览站点都走池化入口、
 *      全应用不再新建原生 <audio controls>
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
  let sa;
  let sb;
  try {
    sa = JSON.stringify(a);
  } catch (_) {
    sa = String(a);
  }
  try {
    sb = JSON.stringify(b);
  } catch (_) {
    sb = String(b);
  }
  ok(a === b, msg + "（期望 " + sb + "，实得 " + sa + "）");
}
const ROOT = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel.split("/").join(path.sep)), "utf8");
/* 让出微任务队列（兜底那条路要等第一次 rejection 落定） */
const sleep0 = () => new Promise((r) => setTimeout(r, 0));

/* 极简选择器：认 .class / #id，以及由空格分隔的后代组合（如 ".wf-node #x"） */
function matchesSimple(el, sel) {
  if (!el) return false;
  if (sel.charAt(0) === ".") return el.classList.contains(sel.slice(1));
  if (sel.charAt(0) === "#") return el.id === sel.slice(1);
  return String(el.tagName || "").toLowerCase() === String(sel || "").toLowerCase();
}

function matchesSel(el, sel) {
  const parts = String(sel || "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return false;
  let node = el;
  for (let i = parts.length - 1; i >= 0; i--) {
    while (node && !matchesSimple(node, parts[i])) node = node.parentElement;
    if (!node) return false;
    if (i > 0) node = node.parentElement;
  }
  return true;
}

function descendantsOf(root) {
  const out = [];
  const walk = (n) => {
    for (const c of n.children || []) {
      out.push(c);
      walk(c);
    }
  };
  walk(root);
  return out;
}

/* ═══════════ 极简 DOM（只给被测模块用到的那点能力；事件是真派发的） ═══════════ */
function mkEl(tag) {
  const classes = new Set();
  const el = {
    tagName: String(tag || "div").toUpperCase(),
    children: [],
    parentElement: null,
    style: { cssText: "" },
    dataset: {},
    attrs: {},
    listeners: {},
    isConnected: false,
    textContent: "",
    innerHTML: "",
    id: "",
    src: "",
    currentTime: 0,
    duration: 120,
    paused: true,
    ended: false,
    readyState: 2,
    controls: false,
    preload: "",
    volume: 1,
    addEventListener(type, fn) {
      (el.listeners[type] = el.listeners[type] || []).push(fn);
    },
    removeEventListener(type, fn) {
      const L = el.listeners[type] || [];
      el.listeners[type] = L.filter((f) => f !== fn);
    },
    fire(type, ev) {
      for (const fn of [...(el.listeners[type] || [])]) fn(Object.assign({ type, target: el }, ev || {}));
    },
    setAttribute(name, v) {
      el.attrs[name] = String(v);
      if (name === "src") el.src = String(v);
    },
    /* 选择器桥（音量 UI 的元素引用存在状态里，真实 DOM 才配 hasAttribute；
       这里给个最小实现，验证用的选择器断言就落在这上面） */
    hasAttribute(name) {
      return Object.prototype.hasOwnProperty.call(el.attrs, name);
    },
    matches(sel) {
      if (String(sel).charAt(0) === ".") return el.classList.contains(String(sel).slice(1));
      if (String(sel).charAt(0) === "#") return el.id === String(sel).slice(1);
      return String(el.tagName || "").toLowerCase() === String(sel || "").toLowerCase();
    },
    contains(node) {
      let p = node;
      while (p) {
        if (p === el) return true;
        p = p.parentElement;
      }
      return false;
    },
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(el.attrs, name) ? el.attrs[name] : null;
    },
    removeAttribute(name) {
      delete el.attrs[name];
      if (name === "src") el.src = "";
    },
    appendChild(child) {
      if (child.parentElement && child.parentElement !== el) child.parentElement.removeChild(child);
      el.children.push(child);
      child.parentElement = el;
      child.isConnected = true;
      return child;
    },
    removeChild(child) {
      const i = el.children.indexOf(child);
      if (i >= 0) el.children.splice(i, 1);
      child.parentElement = null;
      child.isConnected = false;
      return child;
    },
    remove() {
      if (el.parentElement) el.parentElement.removeChild(el);
      else el.isConnected = false;
    },
    getBoundingClientRect() {
      return { left: 0, top: 0, width: 200, height: 44 };
    },
    querySelector(sel) {
      return descendantsOf(el).find((n) => matchesSel(n, sel)) || null;
    },
    querySelectorAll(sel) {
      return descendantsOf(el).filter((n) => matchesSel(n, sel));
    },
    play() {
      el.paused = false;
      el.fire("play");
      return Promise.resolve();
    },
    pause() {
      if (el.paused) return;
      el.paused = true;
      el.fire("pause");
    },
    load() {},
    closest(sel) {
      let p = el;
      while (p) {
        if (sel === ".n-wave" && p.classList.contains("n-wave")) return p;
        p = p.parentElement;
      }
      return null;
    },
    getContext() {
      return { setTransform() {}, clearRect() {}, fillRect() {}, fillStyle: "" };
    },
  };
  el.classList = {
    add(...cs) {
      cs.forEach((c) => classes.add(c));
    },
    remove(...cs) {
      cs.forEach((c) => classes.delete(c));
    },
    contains(c) {
      return classes.has(c);
    },
    toggle(c, on) {
      if (on === undefined) classes.has(c) ? classes.delete(c) : classes.add(c);
      else if (on) classes.add(c);
      else classes.delete(c);
    },
  };
  Object.defineProperty(el, "className", {
    get() {
      return [...classes].join(" ");
    },
    set(v) {
      classes.clear();
      String(v || "")
        .split(/\s+/)
        .filter(Boolean)
        .forEach((c) => classes.add(c));
    },
  });
  return el;
}

function makeSandbox(opts) {
  opts = opts || {};
  const body = mkEl("body");
  body.isConnected = true;
  const doc = {
    body,
    fullscreenElement: null,
    listeners: {},
    createElement: (tag) => mkEl(tag),
    querySelector: (sel) => descendantsOf(body).find((n) => matchesSel(n, sel)) || null,
    querySelectorAll: (sel) => descendantsOf(body).filter((n) => matchesSel(n, sel)),
    addEventListener(type, fn) {
      (doc.listeners[type] = doc.listeners[type] || []).push(fn);
    },
    fire(type, ev) {
      for (const fn of [...(doc.listeners[type] || [])]) fn(Object.assign({ type }, ev || {}));
    },
  };
  const sandbox = {};
  sandbox.window = sandbox;
  sandbox.console = console;
  sandbox.document = doc;
  sandbox.MutationObserver = function () {
    return { observe() {}, disconnect() {} };
  };
  sandbox.ResizeObserver = function () {
    return { observe() {}, disconnect() {} };
  };
  sandbox.queueMicrotask = (fn) => Promise.resolve().then(fn);
  sandbox.requestAnimationFrame = (fn) => setTimeout(() => fn(0), 0);
  sandbox.setTimeout = setTimeout;
  sandbox.clearTimeout = clearTimeout;
  sandbox.I18n = { t: (s) => String(s) };
  sandbox.CSS = { escape: (s) => String(s) };
  const computedStyle = () => ({ getPropertyValue: () => "" });
  sandbox.getComputedStyle = computedStyle;
  sandbox.api = {
    toFileUrl: (p) => "file:///" + String(p || "").replace(/\\/g, "/"),
    fileStat: async () => ({ bytes: 10, mtimeMs: 1 }),
    fileReadAudio: async () => ({ ok: false, error: "no-decode-in-test" }),
  };
  /* 浏览器媒体元素：原型上的全屏入口由被测模块覆写，raw 用这里的实现 */
  function Media() {}
  /* 音量落在媒体元素上（波形播放器的全局引擎就是一只 <audio>） */
  Media.prototype.volume = 1;
  Media.prototype.muted = false;
  Media.prototype.play = function () {
    this.paused = false;
    this.fire("play");
    return Promise.resolve();
  };
  Media.prototype.pause = function () {
    if (this.paused) return;
    this.paused = true;
    this.fire("pause");
  };
  Media.prototype.load = function () {};
  function AudioEl() {}
  AudioEl.prototype = Object.create(Media.prototype);
  function VideoEl() {}
  VideoEl.prototype = Object.create(Media.prototype);
  VideoEl.prototype.requestFullscreen = function () {
    this.__rawRequests = (this.__rawRequests || 0) + 1;
    /* 默认成（真机实测：带 transform 祖先的就地请求就是成的）。
       用例可以用 __dropFs 钉住被拒那条路：
         · "always"    —— 怎么都拒（谁也别想全屏）
         · "offscreen" —— **只有待在 0×0 离屏容器里才拒**：真机把保存节点视频搬进
           left:-99999px / width:0 的占位容器后，Chromium 回的就是
           "TypeError: Permissions check failed"。
       注意「就地那次」得真被拒，兜底才会被触发：真机里就地必成，想验兜底就显式把
       __dropFs 设成 "always"，再靠第二跳里的 __mvHold 机制放行（见 __dropFs 的用法）。 */
    const drop = this.__dropFs || "none";
    const inOffscreenHold = (() => {
      let p = this.parentElement;
      while (p) {
        const css = String((p.style && p.style.cssText) || "");
        if (p.classList && p.classList.contains("mv-hold") && /-99999px|width:0/.test(css)) return true;
        p = p.parentElement;
      }
      return false;
    })();
    if (drop === "always" || (drop === "offscreen" && inOffscreenHold) || (drop === "alwaysUntilHold" && !this.__mvHold))
      return Promise.reject(new TypeError("Permissions check failed"));
    doc.fullscreenElement = this;
    return Promise.resolve();
  };
  sandbox.HTMLMediaElement = Media;
  sandbox.HTMLAudioElement = AudioEl;
  sandbox.HTMLVideoElement = VideoEl;

  /* createElement 出来的媒体元素要继承对应原型（否则覆写挂不到实际元素上） */
  const rawCreate = doc.createElement;
  doc.createElement = (tag) => {
    const el = rawCreate(tag);
    const lower = String(tag).toLowerCase();
    if (lower === "audio") Object.setPrototypeOf(el, AudioEl.prototype);
    else if (lower === "video") Object.setPrototypeOf(el, VideoEl.prototype);
    return el;
  };

  vm.createContext(sandbox);
  vm.runInContext(read("renderer/app-audioview.js"), sandbox, { filename: "app-audioview.js" });
  if (opts.withMedia !== false)
    vm.runInContext(read("renderer/app-mediaview.js"), sandbox, { filename: "app-mediaview.js" });
  /* 沙箱内的小工具（跨 VM 边界按值传引用即可：函数在 VM 里执行，能看见模块顶层函数） */
  vm.runInContext(
    "function tSetSrc(el, url) { el.src = url; return el; }\n" +
      "function tWaveState(el) { return wavePreviewState.get(el); }\n" +
      "function tPlaying(el) { return !!tWaveState(el).playing; }\n" +
      "function tOwn(el) { return tWaveState(el).own === el; }\n" +
      "function tPath(el) { return tWaveState(el).path; }\n" +
      "function tEngSrc() { return waveEngineEl ? waveEngineEl.getAttribute('src') : ''; }\n" +
      "function tToggle(el) { waveToggle(el); return el; }\n" +
      "function tSeek(el, x) { waveSeek(el, { clientX: x }); return el; }\n" +
      "function tStopAll(force) { wavePreviewStopAll(force); return true; }\n" +
      "function tMk(el, opts) { return mediaViewCreate(el, opts); }\n" +
      "function tAtt(el, box, p) { return mediaViewAttach(el, box, p); }\n" +
      "function tClear(el) { return mediaViewClear(el); }\n" +
      "function tPrune() { mediaViewPrune(); return true; }\n" +
      "function tSetVideoSrc(el, url, p) { return mediaSetVideoSrc(el, url, p); }\n" +
      "function tEngVol() { return waveEngineEl ? waveEngineEl.volume : null; }\n" +
      "function tVol() { return waveVolume; }\n" +
      "function tSetVol(v) { waveSetVolume(v); return waveVolume; }\n" +
      "function tVolOpen(el) { return !!tWaveState(el).volOpen; }\n" +
      "function tClickVol(el) { const st = tWaveState(el); if (st.volBtn && st.volBtn.onclick) st.volBtn.onclick({ stopPropagation() {} }); return tVolOpen(el); }\n" +
      "function tDblVol(el) { const st = tWaveState(el); if (st.volBtn && st.volBtn.ondblclick) st.volBtn.ondblclick({ stopPropagation() {} }); return tVol(); }\n" +
      "function tDragVol(el, v) { const st = tWaveState(el); st.volRange.value = String(v); const fns = (st.volRange.listeners && st.volRange.listeners.input) || []; for (const f of fns) f({ stopPropagation() {} }); return tVol(); }\n" +
      "function tOutside(el) { waveVolumePopCloseAll(null); return el ? tVolOpen(el) : false; }\n" +
      "function tHolderCss() { return mediaFullscreenPlaceholder().style.cssText; }\n" +
      "function tHolderIn(el) { const boss = el.parentElement; return !!(boss && boss.classList && boss.classList.contains('mv-hold')); }\n",
    sandbox,
    { filename: "test-helpers" },
  );
  sandbox.__doc = doc;
  sandbox.__body = body;
  return sandbox;
}

const run = (s, code) => vm.runInContext(code, s);
const fn = (s, name) => run(s, name);

console.log("[1] 音频引擎：全局一只，节点重绘拆不掉");
{
  const s = makeSandbox();
  const eng = run(s, "waveEngineEnsure()");
  ok(!!eng, "waveEngineEnsure() 建出播放引擎");
  eq(eng.dataset.mtnodeRole, "audio-engine", "引擎挂 body 且带角色标记");
  eq(s.__body.children.filter((c) => c.tagName === "AUDIO").length, 1, "body 下只有一只引擎");
  eq(run(s, "waveEngineEnsure()") === eng, true, "重复取用拿到同一只（幂等）");

  const w1 = run(s, 'wavePreviewCreate("svaud-a")');
  eq(w1.children.filter((c) => c.tagName === "AUDIO").length, 0, "波形播放器外壳内部不再挂 <audio>");
  eq(eng.parentElement === s.__body, true, "建播放器不动引擎的归属");
  s.__body.appendChild(w1);

  fn(s, "tSetSrc")(w1, "file:///E:/tmp/a.wav");
  fn(s, "tToggle")(w1);
  eq(fn(s, "tEngSrc")(), "file:///E:/tmp/a.wav", "起播时引擎读的是这只播放器的音源");
  eq(fn(s, "tPlaying")(w1), true, "起播后这只处于播放态");
  eq(eng.paused, false, "引擎真的在放");

  /* 模拟画布重绘：外壳被摘出文档，再建一只新的同源播放器回到文档 */
  w1.remove();
  eq(eng.isConnected, true, "外壳被摘掉时引擎仍在文档里（这就是不断播的原因）");
  eq(eng.paused, false, "引擎没有因为外壳被摘掉而暂停");
  const w1b = run(s, 'wavePreviewCreate("svaud-a")');
  s.__body.appendChild(w1b);
  fn(s, "tSetSrc")(w1b, "file:///E:/tmp/a.wav");
  eq(fn(s, "tEngSrc")(), "file:///E:/tmp/a.wav", "重绘后重新挂回同一音源：引擎仍是它，不重新加载");
  eq(eng.paused, false, "重绘后仍在播（进度不回零）");
  run(s, "tStopAll(true)");
  eq(eng.paused, true, "全局停播只对「宿主真没了」的生效，force 时一定停");
}

console.log("\n[2] 互斥：后者起播即顶掉前者");
{
  const s = makeSandbox();
  const w1 = run(s, 'wavePreviewCreate("svaud-1")');
  const w2 = run(s, 'wavePreviewCreate("svaud-2")');
  s.__body.appendChild(w1);
  s.__body.appendChild(w2);
  fn(s, "tSetSrc")(w1, "file:///E:/tmp/1.wav");
  fn(s, "tSetSrc")(w2, "file:///E:/tmp/2.wav");
  fn(s, "tToggle")(w1);
  eq(fn(s, "tPlaying")(w1), true, "第一只起播");
  fn(s, "tToggle")(w2);
  eq(fn(s, "tPlaying")(w2), true, "第二只起播");
  eq(fn(s, "tPlaying")(w1), false, "第一只被顶掉，回到「未播放」态（不叠音）");
  eq(fn(s, "tEngSrc")(), "file:///E:/tmp/2.wav", "引擎现在放的是第二只的音源");
  eq(fn(s, "tOwn")(w2), true, "互斥后只有第二只持有引擎 UI");
  /* 同一音源重复设置（重绘时常见）不能把正在播的打断 */
  fn(s, "tSetSrc")(w2, "file:///E:/tmp/2.wav");
  eq(fn(s, "tEngSrc")(), "file:///E:/tmp/2.wav", "同一音源重复设置仍是同一音源");
  fn(s, "tToggle")(w2);
  eq(fn(s, "tPlaying")(w2), false, "再点一下 = 暂停（按钮切换语义不变）");
}

console.log("\n[3] 波形点选：拖另一只的波形 = 切到那只，不误改别人的进度");
{
  const s = makeSandbox();
  const w1 = run(s, 'wavePreviewCreate("svaud-1")');
  const w2 = run(s, 'wavePreviewCreate("svaud-2")');
  s.__body.appendChild(w1);
  s.__body.appendChild(w2);
  fn(s, "tSetSrc")(w1, "file:///E:/tmp/1.wav");
  fn(s, "tSetSrc")(w2, "file:///E:/tmp/2.wav");
  fn(s, "tToggle")(w1);
  fn(s, "tSeek")(w2, 100);
  eq(fn(s, "tOwn")(w2), true, "点第二只波形后引擎归它");
  eq(fn(s, "tEngSrc")(), "file:///E:/tmp/2.wav", "引擎音源也跟着切过去了");
  eq(fn(s, "tPlaying")(w1), false, "第一只不再是播放态");
}

console.log("\n[4] 视频池：重绘复用同一只 <video>，进度与播放态随元素走");
{
  const s = makeSandbox();
  const mk = fn(s, "tMk");
  const att = fn(s, "tAtt");
  const box1 = run(s, 'document.createElement("div")');
  s.__body.appendChild(box1);
  const v1 = mk(run(s, 'document.createElement("video")'), {
    id: "mgvid-n1",
    path: "E:/tmp/x.mp4",
  });
  eq(v1.dataset.mvPool, "1", "池化视频带 mvPool 标记");
  eq(v1.getAttribute("playsinline") !== null, true, "补了 playsinline（内嵌播放口径）");
  att(v1, box1, "E:/tmp/x.mp4");
  eq(v1.parentElement === box1, true, "播放器放进容器");
  v1.currentTime = 12.5;
  v1.paused = false;
  v1.fire("play");
  eq(v1.dataset.mvPlay, "1", "播放态记在元素上");

  /* 画布重绘：容器换新、调用方照旧新建一只 <video> 交给入口 —— 池必须把它换成
     上一轮那只（同一个文件 + 同一个槽位），这样正在放的那只元素根本没被摘掉。 */
  const box2 = run(s, 'document.createElement("div")');
  s.__body.appendChild(box2);
  const v2 = mk(run(s, 'document.createElement("video")'), {
    id: "mgvid-n1",
    path: "E:/tmp/x.mp4",
  });
  eq(v2 === v1, true, "同一路径 + 同一槽位重绘拿到的是上一轮那只 <video>（不断播、不闪）");
  eq(v2.currentTime, 12.5, "进度跟着元素带过来（不被重绘归零）");
  eq(v2.dataset.mvPlay, "1", "播放态跟着元素带过来（重绘后自动续播）");
  att(v2, box2, "E:/tmp/x.mp4");
  eq(v2.parentElement === box2, true, "重绘后挂进新容器");
  const v2b = mk(run(s, 'document.createElement("video")'), {
    id: "mgvid-n1",
    path: "E:/tmp/x.mp4",
  });
  eq(v2b === v1, true, "再建一次仍命中同一只（池按路径 + 槽位稳定复用）");

  /* 换文件 = 另一把键，旧元素该被回收（不留两个播放器一起响） */
  const box3 = run(s, 'document.createElement("div")');
  s.__body.appendChild(box3);
  const v3 = mk(run(s, 'document.createElement("video")'), {
    id: "mgvid-n1",
    path: "E:/tmp/y.mp4",
  });
  eq(v3 === v1, false, "换文件不复用旧元素");
  eq(v1.getAttribute("src") === null, true, "旧元素音源已清空（不会两个一起响）");
  eq(s.__body.children.indexOf(v1) >= 0, false, "旧元素已从文档里摘掉");
  att(v3, box3, "E:/tmp/y.mp4");
  eq(v3.parentElement === box3, true, "换文件后的播放器挂在新容器里");
}

console.log("\n[5] 全屏：原地请求为主，只有被拒才退到铺满视口的占位容器");
/* 兜底那一条要等 rejected Promise 落定，所以整段放在 async 里，最后由 main() 收口 */
async function block5() {
  const s = makeSandbox();
  const mk = fn(s, "tMk");
  const att = fn(s, "tAtt");
  const stage = run(s, 'document.createElement("div")');
  stage.classList.add("fn-stage");
  const wrap = run(s, 'document.createElement("div")');
  const prev = run(s, 'document.createElement("div")');
  s.__body.appendChild(stage);
  stage.appendChild(wrap);
  wrap.appendChild(prev);
  const v = mk(run(s, 'document.createElement("video")'), { id: "svvid-n9", path: "E:/tmp/x.mp4" });
  att(v, prev, "E:/tmp/x.mp4");
  eq(fn(s, "mediaInsideStage")(v), true, "识别出播放器挂在 .fn-stage（带 transform）下");
  ok(
    String(fn(s, "tHolderCss")()).indexOf("-99999px") < 0 &&
      String(fn(s, "tHolderCss")()).indexOf("100vw") >= 0,
    "兜底占位容器铺满视口（不是 0×0 离屏 —— 那种容器里请求全屏 Chromium 必拒）",
  );
  ok(
    String(fn(s, "tHolderCss")()).indexOf("overflow") < 0,
    "占位容器不设 overflow（规范禁止被全屏元素有 overflow 祖先）",
  );

  /* ① 就地请求（真机实测就成）：元素不搬家、没有占位壳、原生只调一次 */
  const p = v.requestFullscreen();
  ok(p && typeof p.then === "function", "requestFullscreen 返回可等待的 Promise");
  eq(v.__rawRequests, 1, "原生 requestFullscreen 被调用一次");
  eq(!!v.__mvHold, false, "就地请求：元素没有被搬走");
  eq(v.parentElement === prev, true, "就地请求：元素仍待在节点预览框里");
  eq(s.__body.children.some((c) => c.classList.contains("mv-hold")), false, "就地请求：没有生成占位壳");

  /* ② 就地被拒（更外层祖先另有问题）→ 退到铺满视口的占位容器再请求一次。
     这一段用**自己的沙箱**：池是「路径 + 槽位」复用的，同沙箱里再要一只干净元素反而绕。 */
  {
    const s2 = makeSandbox();
    const mk2 = fn(s2, "tMk");
    const att2 = fn(s2, "tAtt");
    const stage2 = run(s2, 'document.createElement("div")');
    stage2.classList.add("fn-stage");
    const prevRej = run(s2, 'document.createElement("div")');
    s2.__body.appendChild(stage2);
    stage2.appendChild(prevRej);
    const vRej = mk2(run(s2, 'document.createElement("video")'), { id: "svvid-rej", path: "E:/tmp/r.mp4" });
    att2(vRej, prevRej, "E:/tmp/r.mp4");
    eq(vRej.parentElement === prevRej, true, "兜底用例：元素先挂在节点预览框里");
    /* 就地那次必拒（模拟「祖先链另有问题」），第二跳（已进占位容器）放行 ——
       于是断言的就是「被拒 → 抬进铺满视口的占位容器 → 再请求一次 → 成功」。 */
    vRej.__dropFs = "alwaysUntilHold";
    const p2 = vRej.requestFullscreen();
    ok(p2 && typeof p2.then === "function", "被拒那条也回可等待的 Promise");
    await sleep0(); /* 等第一次 rejection 落定（兜底是异步跳的） */
    eq(!!vRej.__mvHold, true, "就地被拒 → 抬进占位容器");
    eq(vRej.parentElement.classList.contains("mv-hold"), true, "占位容器就是父节点");
    eq(fn(s2, "mediaInsideStage")(vRej), false, "占位容器挂在 body 下（脱离 transform 祖先）");
    eq(vRej.__rawRequests, 2, "兜底再请求一次原生全屏");
    eq(s2.__doc.fullscreenElement, vRej, "兜底那次成功进了全屏");

    /* ③ 全屏中重绘：复用同一只元素 + 记下退出后该回哪只新容器 */
    const prev2 = run(s2, 'document.createElement("div")');
    stage2.appendChild(prev2);
    prevRej.remove();
    const v2 = mk2(run(s2, 'document.createElement("video")'), { id: "svvid-rej", path: "E:/tmp/r.mp4" });
    eq(v2, vRej, "全屏期间重绘仍复用同一只元素（保持在全屏里）");
    eq(v2.parentElement.classList.contains("mv-hold"), true, "全屏期间元素仍在占位容器里（不闪、不中断）");
    att2(v2, prev2, "E:/tmp/r.mp4");
    fn(
      s2,
      "function tWhere(el, target) { const rec = mediaPoolRecordOf(el); return { wanted: !!(rec && rec.wanted === target), succ: !!(rec && rec.succ && !rec.succ.isConnected), hold: !!el.__mvHold }; }",
    );
    eq(fn(s2, "tWhere")(vRej, prev2).wanted, true, "全屏中重绘：记下「退出后回哪只新容器」");
    /* 退出全屏（Esc）：元素归位到新容器，占位壳撤掉 */
    s2.__doc.fullscreenElement = null;
    s2.__doc.fire("fullscreenchange");
    eq(vRej.parentElement === prev2, true, "退出全屏后归位到节点的新容器");
    eq(s2.__body.children.some((c) => c.classList.contains("mv-hold")), false, "占位壳已撤掉");
    eq(!!vRej.__mvHold, false, "元素不再持有占位标记");
    eq(vRej.parentElement.children.indexOf(vRej) >= 0, true, "归位后播放器确实在新容器里（可继续看 / 继续播）");
    eq(v.parentElement, prev, "另一只（就地请求那只）全程没被动过");
  }
}

console.log("\n[5b] 波形播放器音量：全局值 + 跨外壳同步 + 浮层开合");
{
  const s = makeSandbox();
  const w1 = run(s, 'wavePreviewCreate("svaud-v1")');
  const w2 = run(s, 'wavePreviewCreate("svaud-v2")');
  s.__body.appendChild(w1);
  s.__body.appendChild(w2);
  const st1 = fn(s, "tWaveState")(w1);
  ok(!!st1.volBtn, "外壳里建出音量按钮");
  ok(!!st1.volRange, "外壳里建出音量滑杆");
  ok(!!st1.volPop, "外壳里建出音量浮层");
  ok(
    String(st1.volRange.min) === "0" && String(st1.volRange.max) === "1",
    "滑杆范围 0..1",
  );
  eq(fn(s, "tVol")(), 1, "默认音量 = 1（100%）");
  run(s, "waveEngineEnsure()"); /* 播放引擎是懒建的：先拉起来再看音量有没有兑现在它身上 */
  eq(fn(s, "tEngVol")(), 1, "引擎建出来就把音量兑现在引擎上");

  /* 拖滑杆：全局值 + 引擎 + 两只外壳的 UI 一起走 */
  eq(fn(s, "tDragVol")(w1, "0.35"), 0.35, "拖滑杆 → 全局音量变 0.35");
  eq(fn(s, "tEngVol")(), 0.35, "引擎 volume 立刻变 0.35（拖动时就能听见）");
  eq(String(fn(s, "tWaveState")(w1).volRange.value), "0.35", "这只的滑杆位置 = 0.35");
  eq(String(fn(s, "tWaveState")(w2).volRange.value), "0.35", "另一只的滑杆同步到 0.35（跨外壳一致）");
  eq(fn(s, "tWaveState")(w2).volPct.textContent, "35%", "另一只的百分比读数也同步");

  /* 越界钳位 */
  eq(fn(s, "tSetVol")(2), 1, "音量超过 1 被钳到 1");
  eq(fn(s, "tSetVol")(-3), 0, "音量小于 0 被钳到 0");
  ok(
    String(fn(s, "tWaveState")(w1).volBtn.innerHTML).indexOf("stroke") >= 0,
    "静音档图标带叉线（音量 0 的图标确实换了）",
  );
  eq(fn(s, "tWaveState")(w1).volBtn.classList.contains("off"), true, "音量 0 时按钮呈静音态");

  /* 浮层开合：点按钮开、再点收、Esc / 点外部收 */
  eq(fn(s, "tClickVol")(w1), true, "点音量按钮 → 浮层打开");
  ok(fn(s, "tWaveState")(w1).volPop.classList.contains("on"), "浮层带 .on（可见）");
  eq(fn(s, "tClickVol")(w1), false, "再点一次 → 收起");
  eq(fn(s, "tClickVol")(w1), true, "再点一次又打开");
  eq(fn(s, "tClickVol")(w2), true, "点另一只的音量按钮 → 这只打开");
  eq(fn(s, "tWaveState")(w1).volOpen, false, "同时只开一只（互斥：第一只自动收起）");
  fn(s, "tOutside")(w2);
  eq(fn(s, "tWaveState")(w2).volOpen, false, "Esc / 点外部 → 浮层收起");

  /* 音量不影响播放态与音源 */
  fn(s, "tSetSrc")(w1, "file:///E:/tmp/a.wav");
  fn(s, "tToggle")(w1);
  eq(fn(s, "tPlaying")(w1), true, "设过音量后仍能正常起播");
  eq(fn(s, "tEngSrc")(), "file:///E:/tmp/a.wav", "音量操作没有动音源");
}

console.log("\n[6] 接线与口径：模块挂载、预览站点走池化、原生音频控件下线");
{
  const html = read("renderer/index.html");
  ok(/<script src="app-mediaview\.js"><\/script>/.test(html), "index.html 挂载 renderer/app-mediaview.js");
  ok(html.indexOf('src="app-audioview.js"') >= 0, "波形播放器模块仍在（音频唯一形态）");
  const idxAudio = html.indexOf('src="app-audioview.js"');
  const idxMedia = html.indexOf('src="app-mediaview.js"');
  const idxCanvas = html.indexOf('src="app-canvas.js"');
  ok(idxAudio < idxCanvas && idxMedia < idxCanvas, "两个模块都排在 app-canvas.js 之前");

  const canvas = read("renderer/app-canvas.js");
  eq(
    (canvas.match(/document\.createElement\("audio"\)/g) || []).length,
    0,
    "app-canvas.js 不再新建原生 <audio>",
  );
  const vidNew = (canvas.match(/document\.createElement\("video"\)/g) || []).length;
  const vidPool = (canvas.match(/mediaViewCreate\(document\.createElement\("video"\)/g) || []).length;
  eq(vidNew, vidPool, "所有节点视频预览都走 mediaViewCreate（差集为 0）");
  ok(/mediaSetVideoSrc\(/.test(canvas), "预览同步用 mediaSetVideoSrc（同源不重设，不打断播放）");
  ok(/wavePreviewStopAll\(false\)/.test(canvas), "重绘收尾调用 wavePreviewStopAll(false)（只回收真没了的）");
  ok(/mediaViewPrune\(\)/.test(canvas), "重绘收尾回收失效的池化视频");

  const view = read("renderer/app-mediaview.js");
  ok(!/querySelector\("audio"\)/.test(view), "媒体模块不碰音频引擎");
  ok(/fullscreenchange/.test(view), "进退全屏都挂上了事件（退出自动归位）");
  ok(/__mtnodeFullscreenFix/.test(view), "全屏托底可重复安装（幂等标记）");

  const audio = read("renderer/app-audioview.js");
  ok(!/el\.querySelector\("audio"\)|host\.querySelector\("audio"\)/.test(audio), "波形播放器不再从节点里找 <audio>");
  ok(/dataset\.mtnodeRole = "audio-engine"/.test(audio), "引擎带角色标记（本回归 [1] 的判据真跑过）");
  ok(/wavePreviewStopAll/.test(audio), "对外给了全局停播入口");
}

/* [5] 与 [5b] 里要 await（兜底那条要等 rejected Promise 落定），
   所有同步块跑完后统一收口再打总结。 */
(async function main() {
  await block5();

  console.log("\n媒体播放持久化回归：" + (checks - fails) + "/" + checks + " 通过");
  if (fails) {
    console.log("失败 " + fails + " 项");
    process.exit(1);
  }
})();
