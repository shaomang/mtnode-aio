"use strict";
/* 音频波形预览器回归（纯 Node，无 Electron / 无真实 DOM）
 *   node test/smoke-audio-wave.js
 * 钉住的口径：
 *  [1] wavePeaksOf 的峰值归并（多声道取 max、按桶等分、钳到 0..1、空音频不炸）
 *  [2] waveFmtTime 的秒 → m:ss.s
 *  [3] 音频节点不再用原生 <audio controls>（圆角胶囊），一律走方角波形预览器：
 *      源文件里 .n-wave 外观、点/拖定位、外部 el.src 赋值桥接都在
 *  [4] 主进程 / 桥：file:readAudio 存在，且 preload 暴露 fileReadAudio
 *  [5] play() 的 Promise 有接住（换源 / 节点重绘不再抛未处理拒绝）
 *  [6] 外壳是 <div>，但调用方仍照 <audio> 的用法给它 el.src / dataset.path /
 *      removeAttribute("src")：必须真把音源挂到内部 <audio>（否则节点读不到音频）
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
const ROOT = path.join(__dirname, "..");
const read = (rel) =>
  fs.readFileSync(path.join(ROOT, rel.split("/").join(path.sep)), "utf8");

/* ═══════════ 沙箱：只加载 app-audioview.js（渲染 / 主进程全部打桩） ═══════════ */
function load() {
  const sandbox = {};
  sandbox.window = sandbox;
  sandbox.console = console;
  sandbox.I18n = { t: (s) => String(s) };
  sandbox.HTMLMediaElement = undefined; // 无 DOM：src 桥接段自动跳过
  sandbox.document = {
    createElement: () => ({ style: {}, dataset: {}, className: "", appendChild() {} }),
  };
  sandbox.window.api = {
    toFileUrl: (p) => "file:///" + String(p).replace(/\\/g, "/"),
    fileReadAudio: async () => ({ ok: false, error: "stub" }),
    fileStat: async () => ({ ok: false }),
  };
  vm.createContext(sandbox);
  vm.runInContext(read("renderer/app-audioview.js"), sandbox, {
    filename: "app-audioview.js",
  });
  return sandbox;
}

/* 假 AudioBuffer：只实现 wavePeaksOf 用到的那几个成员 */
function fakeBuf(channels, length) {
  return {
    numberOfChannels: channels.length,
    length,
    duration: length / 1000,
    getChannelData: (c) => channels[c],
  };
}

console.log("[1] wavePeaksOf：多声道取 max / 分桶 / 钳位");
{
  const s = load();
  const n = 4000;
  const left = new Float32Array(n).fill(0.5);
  const right = new Float32Array(n).fill(-0.25);
  /* 中段一路冲高到 0.9（应当出现在中间那几桶），并给一个越界值验证钳位 */
  for (let i = 1990; i < 2010; i++) right[i] = 0.9;
  right[10] = 2; // 越界：必须钳到 1
  const p = vm.runInContext("wavePeaksOf", s)(fakeBuf([left, right], n), 32);
  /* 沙箱里造的 Float32Array 与测试进程不同 realm：按构造名 + 长度判，不写 instanceof */
  ok(
    p && p.constructor && p.constructor.name === "Float32Array" && p.length === 32,
    "桶数 = 32",
  );
  ok(p[0] === 1, "越界采样被钳到 1（不是 2）");
  ok(
    p.every((v) => v >= 0 && v <= 1),
    "所有桶都在 0..1",
  );
  const mid = Math.floor(32 / 2);
  ok(
    p[mid] >= 0.89 && p[mid] <= 0.91,
    "中段 0.9 的尖峰被取到（多声道取 max，不被 -0.25 那路盖掉）",
  );
  ok(p[4] === 0.5, "常态段取的是两声道里更大的 0.5");

  const empty = vm.runInContext("wavePeaksOf", s)(fakeBuf([new Float32Array(0)], 0), 32);
  ok(empty.length === 32 && empty.every((v) => v === 0), "空音频返回全 0 桶，不抛错");
}

console.log("\n[2] waveFmtTime：秒 → m:ss.s");
{
  const s = load();
  const fmt = vm.runInContext("waveFmtTime", s);
  ok(fmt(0) === "0:00.0", "0 → 0:00.0");
  ok(fmt(9.44) === "0:09.4", "9.44 → 0:09.4");
  ok(fmt(65) === "1:05.0", "65 → 1:05.0");
  ok(fmt(-3) === "0:00.0", "负数按 0 处理");
}

console.log("\n[3] 音频节点一律走方角波形预览器，不再用原生 <audio controls>");
{
  const av = read("renderer/app-audioview.js");
  ok(av.indexOf("wavePreviewCreate") > 0, "暴露 wavePreviewCreate（建播放器）");
  ok(av.indexOf("wavePreviewSetSource") > 0, "暴露 wavePreviewSetSource（换源）");
  ok(av.indexOf("wavePreviewRedraw") > 0, "暴露 wavePreviewRedraw（重画）");
  ok(av.indexOf("decodeAudioData") > 0, "波形 = decodeAudioData 解码后取峰值");
  ok(av.indexOf("pointerdown") > 0, "点 / 拖波形定位试听");
  ok(av.indexOf('classList.add("n-wave"') < 0 && av.indexOf('className = "n-wave"') > 0, "外壳类是 .n-wave");
  ok(av.indexOf("HTMLMediaElement.prototype") > 0, "接住外部 el.src = file:/// 赋值");

  const canvas = read("renderer/app-canvas.js");
  const nativeAudio = canvas.match(/createElement\(media === "audio" \? "audio"/g) || [];
  ok(nativeAudio.length === 0, "app-canvas.js 不再建原生 audio 预览");
  ok(
    (canvas.match(/wavePreviewCreate\(/g) || []).length >= 4,
    "音频输入 / 保存音频 / 音乐生成 / 语音合成 / 设置窗都改走它",
  );
  ok(
    canvas.indexOf("document.createElement(isVid ? \"video\" : \"audio\")") < 0,
    "音视频输入节点的音频那支已换成波形预览器",
  );
  ok(
    canvas.indexOf("ensureNodeSettingsWave") > 0,
    "设置跳窗里也补一只波形预览器",
  );

  const css = read("renderer/css/components.css");
  ok(css.indexOf(".n-wave {") > 0, "css/components.css 有 .n-wave 段");
  ok(/\.n-wave\s*\{[^}]*border-radius:\s*0/s.test(css), "预览器是方角（border-radius: 0）");
  ok(css.indexOf(".n-wave-btn") > 0 && css.indexOf(".n-wave-cv") > 0, "方形播放按钮 + canvas 波形");
  ok(
    css.indexOf(".n-wave-capsule") < 0 && css.indexOf("border-radius: 999") < 0,
    "没有胶囊圆角",
  );

  const html = read("renderer/index.html");
  const tagOf = (f) => html.indexOf('<script src="' + f + '">');
  ok(tagOf("app-audioview.js") > 0, "index.html 已接入 app-audioview.js");
  ok(
    tagOf("app-audioview.js") < tagOf("app-canvas.js"),
    "脚本顺序：波形预览器排在 app-canvas.js 之前",
  );
}

console.log("\n[4] 主进程 / 桥：file:readAudio");
{
  const main = read("main.js");
  ok(main.indexOf('ipcMain.handle("file:readAudio"') > 0, "main.js 注册 file:readAudio");
  ok(main.indexOf("tooBig") > 0, "超过体积上限只回体积、不读字节");
  const pre = read("preload.js");
  const bridgeLine = pre
    .split(/\r?\n/)
    .find(
      (l) =>
        l.indexOf("fileReadAudio:") >= 0 &&
        (l.indexOf("'file:readAudio'") >= 0 || l.indexOf('"file:readAudio"') >= 0),
    );
  ok(!!bridgeLine, "preload.js 暴露 fileReadAudio（白名单桥）");
}

/* ═══════════ 迷你 DOM：只够跑 wavePreviewCreate / wavePreviewSetSource ═══════════ */
function installMiniDom(sandbox) {
  const observers = [];
  const notify = (target, name) => {
    for (const o of observers) {
      if (o.target !== target) continue;
      if (o.filter && o.filter.indexOf(name) < 0) continue;
      o.cb([{ type: "attributes", attributeName: name, target }]);
    }
  };
  const matches = (el, sel) =>
    sel.charAt(0) === "." ? el.classSet.has(sel.slice(1)) : el.tagName === sel.toUpperCase();
  const make = (tag) => {
    const el = {
      tagName: String(tag).toUpperCase(),
      children: [],
      attrs: {},
      classSet: new Set(),
      style: {},
      listeners: {},
      textContent: "",
      innerHTML: "",
      title: "",
      id: "",
      isConnected: true,
      parentElement: null,
      clientWidth: 200,
      clientHeight: 44,
      appendChild(c) {
        c.parentElement = el;
        el.children.push(c);
        return c;
      },
      setAttribute(k, v) {
        el.attrs[k] = String(v);
        if (k === "class") el.className = String(v);
      },
      getAttribute(k) {
        return k in el.attrs ? el.attrs[k] : null;
      },
      removeAttribute(k) {
        delete el.attrs[k];
        if (k === "data-path") notify(el, "data-path");
      },
      addEventListener(t, fn) {
        (el.listeners[t] = el.listeners[t] || []).push(fn);
      },
      querySelector(sel) {
        for (const c of el.children) {
          if (matches(c, sel)) return c;
          const hit = c.querySelector(sel);
          if (hit) return hit;
        }
        return null;
      },
      getContext() {
        return { fillStyle: "", setTransform() {}, clearRect() {}, fillRect() {} };
      },
      load() {},
      pause() {},
    };
    Object.defineProperty(el, "className", {
      configurable: true,
      get() {
        return Array.from(el.classSet).join(" ");
      },
      set(v) {
        el.classSet = new Set(String(v).split(/\s+/).filter(Boolean));
      },
    });
    el.classList = {
      add: (...cs) => cs.forEach((c) => el.classSet.add(c)),
      remove: (...cs) => cs.forEach((c) => el.classSet.delete(c)),
      contains: (c) => el.classSet.has(c),
      toggle: (c, on) => {
        const want = on === undefined ? !el.classSet.has(c) : !!on;
        if (want) el.classSet.add(c);
        else el.classSet.delete(c);
        return want;
      },
    };
    /* 真 DOM 里 src / dataset 会反映到属性并触发 MutationObserver —— 迷你 DOM 照做 */
    Object.defineProperty(el, "src", {
      configurable: true,
      get() {
        return "src" in el.attrs ? el.attrs.src : "";
      },
      set(v) {
        el.attrs.src = String(v);
      },
    });
    el.dataset = new Proxy(
      {},
      {
        set(o, k, v) {
          o[k] = String(v);
          notify(el, "data-" + String(k));
          return true;
        },
        deleteProperty(o, k) {
          delete o[k];
          notify(el, "data-" + String(k));
          return true;
        },
        get(o, k) {
          return o[k];
        },
        has(o, k) {
          return k in o;
        },
      },
    );
    return el;
  };
  sandbox.document = { createElement: make };
  sandbox.getComputedStyle = () => ({ getPropertyValue: () => "" });
  sandbox.devicePixelRatio = 1;
  sandbox.MutationObserver = function (cb) {
    this.cb = cb;
  };
  sandbox.MutationObserver.prototype.observe = function (target, opts) {
    observers.push({ target, cb: this.cb, filter: (opts && opts.attributeFilter) || null });
  };
  return { notify };
}

/* 只装 app-audioview.js + 迷你 DOM（无 HTMLMediaElement → 不做原型桥接，走 facade 这条路） */
function loadWithDom() {
  const sandbox = { console, I18n: { t: (s) => String(s) } };
  sandbox.window = sandbox;
  sandbox.HTMLMediaElement = undefined;
  vm.createContext(sandbox);
  vm.runInContext(read("renderer/app-audioview.js"), sandbox, {
    filename: "app-audioview.js",
  });
  installMiniDom(sandbox);
  sandbox.window.api = {
    toFileUrl: (p) => "file:///" + String(p).replace(/\\/g, "/"),
    fileStat: async () => ({ ok: true, size: 1024, mtime: 1 }),
    /* 给点字节但本机不建 AudioContext：走「解不开」降级分支，不影响音源断言 */
    fileReadAudio: async () => ({ ok: true, bytes: new Uint8Array(8), size: 8 }),
  };
  return sandbox;
}

console.log("\n[5] play() 被中断（换源 / 节点被摘出文档）不再抛未处理拒绝");
{
  const av = read("renderer/app-audioview.js");
  ok(av.indexOf("function wavePlay(") > 0, "统一走 wavePlay（play() 的 Promise 有接住）");
  ok(
    av.indexOf("if (aud.paused) aud.play();") < 0 &&
      av.indexOf("      aud.play();") < 0,
    "不存在裸 aud.play()（原先 try/catch 接不住异步拒绝）",
  );
  ok(av.indexOf("p.then(null,") > 0, "play() 的拒绝有兜底处理");
  ok(av.indexOf("function waveStopPlayback(") > 0, "有统一停播收尾 waveStopPlayback");
  ok(
    /wavePreviewSetSource[\s\S]*?waveStopPlayback\(el\)[\s\S]*?aud\.src/.test(av),
    "换源前先停住（不打断未完成的 play()）",
  );
  ok(
    av.indexOf('aud.removeAttribute("src")') > 0,
    "清空时摘掉 src（不再赋空串 = 文档地址）",
  );
  ok(
    /if \(!el\.isConnected\) \{[\s\S]*?waveStopPlayback\(el\)/.test(av),
    "节点重绘摘出文档后自动停播",
  );
  ok(
    /set\(v\) \{[\s\S]*?waveStopPlayback\(host0\)[\s\S]*?desc\.set\.call/.test(av),
    "外部直赋 .src 时也先停播再换源",
  );
}

(async () => {
  const s = load();
  let unhandled = 0;
  const onUnhandled = () => {
    unhandled++;
  };
  process.on("unhandledRejection", onUnhandled);
  const aud = {
    paused: true,
    play() {
      return Promise.reject(new Error("The play() request was interrupted"));
    },
    pause() {},
  };
  const el = {
    isConnected: true,
    querySelector: (sel) => (sel === "audio" ? aud : null),
  };
  const st = { playing: true, ver: 1, peaks: null, hint: "", dur: 0, path: "" };
  vm.runInContext("wavePreviewState", s).set(el, st);
  vm.runInContext("wavePlay", s)(el);
  await new Promise((r) => setTimeout(r, 30));
  process.removeListener("unhandledRejection", onUnhandled);
  ok(unhandled === 0, "play() 被拒时没有未处理拒绝");
  ok(st.playing === false, "被拦下后播放态收回（按钮不假亮）");

  console.log("\n[6] 外壳 <div> 也认 el.src / dataset.path（音频真挂到内部 <audio>）");
  const avSrc = read("renderer/app-audioview.js");
  ok(avSrc.indexOf("MutationObserver") > 0, "模块自己盯 data-path 变化");
  ok(
    /removeAttribute\s*=\s*\(name\)/.test(avSrc) && avSrc.indexOf('=== "src"') > 0,
    "模块自己接住 removeAttribute('src')",
  );
  ok(avSrc.indexOf("function waveSourceFromUrl(") > 0, "file:/// URL → 路径 + 时间戳有独立解析");
  const canvasSrc = read("renderer/app-canvas.js");
  ok(
    canvasSrc.indexOf('media.className = "n-av-el"') < 0,
    "不再整块覆盖 className（会丢 .n-wave）",
  );
  ok(canvasSrc.indexOf('media.classList.add("n-av-el")') > 0, "改用 classList.add 追加 .n-av-el");
  ok(
    canvasSrc.indexOf("wavePreviewSetSource(media, p, p)") > 0,
    "音频输入节点的音源走 wavePreviewSetSource",
  );

  const dom = loadWithDom();
  const create = vm.runInContext("wavePreviewCreate", dom);
  const w1 = create("svaud-n1");
  ok(w1.className.indexOf("n-wave") >= 0, "外壳自身带 .n-wave（外加 n-av-el 也不丢）");
  const a1 = w1.querySelector("audio");
  ok(!!a1, "外壳内确有隐藏 <audio> 播放引擎");
  w1.src = "file:///C:/dir/a%20b.wav?t=123";
  await new Promise((r) => setTimeout(r, 20));
  ok(
    a1.src === "file:///C:/dir/a b.wav?t=123",
    "el.src = file:///…?t= 直达内部 audio（含时间戳）",
  );
  ok(w1.dataset.path === "C:/dir/a b.wav", "路径回写到 dataset.path");
  ok(
    vm.runInContext("wavePreviewState", dom).get(w1).path === "C:/dir/a b.wav",
    "状态里存的是真实路径（波形才读得到文件）",
  );
  ok(
    String(w1.src).indexOf("file:///C:/dir/a b.wav") === 0,
    "读回 src 是 file:/// URL（不带时间戳）",
  );
  w1.removeAttribute("src");
  ok(!a1.src, "removeAttribute('src') 真能清空音源");
  const w2 = create("svaud-n2");
  w2.dataset.path = "D:/m/take.mp3";
  await new Promise((r) => setTimeout(r, 20));
  ok(
    String(w2.querySelector("audio").src).indexOf("D:/m/take.mp3") >= 0,
    "只写 dataset.path（保存节点构造分支）也会挂上音源",
  );

  console.log(
    "\n" + (fails ? "FAIL" : "PASS") + " — " + checks + " 项，失败 " + fails + " 项",
  );
  process.exit(fails ? 1 : 0);
})();
