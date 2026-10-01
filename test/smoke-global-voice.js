"use strict";
/* 全局语音输入（状态栏最左那枚话筒）—— renderer/app-voice.js 的真实执行冒烟
 *   node test/smoke-global-voice.js
 *
 * 为什么要有这一份：本轮把「会话里的语音输入」改成了**全局文字输入** —— 按钮从两个输入框
 * 挪到状态栏最左、点一下在三态（关闭 / 持续转录 / 按住 F1 按键转录）之间循环、识别结果要实时
 * 写进**当前 focus 的输入框**。这一整条都在渲染层一个自包含模块里（renderer/app-voice.js），
 * 没有任何类型检查兜底：拼错一个类名、把插入写成 setValue、焦点一走还硬插，界面上都只是
 * 「说了没反应」，排查起来极痛。所以这里用 vm 沙箱**真的把模块跑起来**，喂假麦克风的 PCM、
 * 喂假转写结果，钉住四件事：
 *
 *   [1] 纯函数：WAV 编码头（16 kHz 单声道 PCM16）、重采样、RMS、阈值、文本合并去重；
 *   [2] 三态循环：off → live → ptt → off；按钮文案 / 类名跟着状态走；
 *   [3] 落点纪律：有焦点才插、走 execCommand("insertText")、失焦暂停、回到同一个框继续写；
 *   [4] 静音门与在途转写：门先到、字后到也不丢（尾巴照样插进去）；
 *   [5] 按键转录态与 [6] 配置（断句停顿 / 语言的夹取与落盘位置；切片长度已退役）；
 *   [7]–[9] 准备态：**停顿才整段提交**（中途不切、句长不再封顶、只在后端硬顶切、尾部静音裁剪）、
 *           模型没就绪时不画假录音点、就绪后自愈开录；
 *   [10][11] 下载 / 准备失败的可见性与重试入口：按钮不再停在「↓ 百分比」、原因与下载源
 *           （含 HTTP 码）在 tooltip / 右键菜单 / 设置里都写得出来、那两枚重试入口点得通并
 *           真的重发 prepare —— **state 回包与运行时推送（onSpeechState）两条入口都钉住**。
 *
 * 不测（要真麦克风与人声，无法自动化）：真实录音、真实转写精度、真实麦克风权限弹窗。
 * 那部分的口径写在 guides/manual/dsh.md 与本轮交付说明里，由用户手动实测。
 */
const fs = require("fs"), path = require("path"), vm = require("vm"), os = require("os"), childProcess = require("child_process");
const SHARED = { fs, path, vm, os, spawn: childProcess.spawn };
const TEST_DIR = __dirname;
let MERGED_FAILED = false;

const ROOT = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
let failed = 0;
const ok = (cond, label) => {
  if (cond) {
    console.log("  ✓ " + label);
    return true;
  }
  console.log("  ✗ " + label);
  failed++;
  return false;
};
const eqNum = (a, b, label) => ok(a === b, label + "（实测 " + a + " · 期望 " + b + "）");
const eqStr = (a, b, label) => ok(a === b, label + "（实测 " + JSON.stringify(a) + "）");

const SRC = read("renderer/app-voice.js");
/** speech 回包：一家服务商 + 指定准备相位（state / prepare 都用它） */
const prepRes = (phase) => ({
  ok: true,
  providers: [{ id: "sensevoice-local", name: "SenseVoiceSmall", preparation: { phase } }],
  selection: { providerId: "sensevoice-local", language: "auto" },
});

/* ============ [1] 纯函数：先把模块放进一个空沙箱跑起来，取它的 _test.pure ============ */
console.log("[1] 纯函数（沙箱里跑真实现，不复制一份算法）");
function bootPure() {
  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    btoa: (s) => Buffer.from(s, "binary").toString("base64"),
    document: undefined,
    window: {},
  };
  sandbox.window = { api: {}, addEventListener() {} };
  const ctx = vm.createContext(sandbox);
  vm.runInContext(SRC, ctx, { filename: "renderer/app-voice.js" });
  return ctx;
}
const P = bootPure();
ok(!!P.window.VoiceInput, "模块装上 window.VoiceInput（其余模块按调用期取它）");
ok(typeof P.window.VoiceInput.canvasTick === "function", "导出 canvasTick（app.js 的 applyTransform 调用它）");
ok(typeof P.window.VoiceInput.settingsSection === "function", "导出 settingsSection（设置面板调用它）");
eqStr(P.window.VoiceInput._test.pttKey, "F1", "按键转录的键是 F1（无字符，不会被录进输入框）");
const pure = P.window.VoiceInput._test.pure;

/* WAV 头：官方 speech-to-text 只吃 16 kHz 单声道 PCM16（格式不对原生侧直接拒） */
{
  const pcm = new Float32Array([0, 0.5, -0.5, 1, -1]);
  const wav = pure.encodeWav16kMono(pcm);
  const dv = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  const tag = (o) => String.fromCharCode(wav[o], wav[o + 1], wav[o + 2], wav[o + 3]);
  eqStr(tag(0), "RIFF", "WAV 头 RIFF");
  eqStr(tag(8), "WAVE", "WAV 头 WAVE");
  eqStr(tag(12), "fmt ", "WAV 头 fmt ");
  eqNum(dv.getUint16(20, true), 1, "PCM 格式");
  eqNum(dv.getUint16(22, true), 1, "单声道");
  eqNum(dv.getUint32(24, true), 16000, "采样率 16 kHz");
  eqNum(dv.getUint16(34, true), 16, "位深 16 bit");
  eqNum(wav.byteLength, 44 + pcm.length * 2, "字节数 = 44 + 样本数 × 2");
  eqNum(dv.getInt16(44 + 2 * 3, true), 32767, "样本 1.0 饱和到 32767");
  eqNum(dv.getInt16(44 + 2 * 4, true), -32768, "样本 -1.0 饱和到 -32768");
}
{
  const src = new Float32Array(4800).fill(0.25);
  eqNum(pure.resampleTo16k(src, 16000).length, 4800, "原生 16 kHz：不重采样");
  eqNum(pure.resampleTo16k(src, 48000).length, 1600, "48 kHz 3 秒 → 16 kHz 1 秒");
  eqNum(pure.rmsOf(new Float32Array([0.5, -0.5])), 0.5, "RMS = 0.5");
  eqNum(pure.rmsOf(new Float32Array(0)), 0, "空帧 RMS = 0");
  ok(pure.thresholdFor(0.0004) >= 0.01, "噪声底极低时阈值有下限（不会一直被环境噪声触发）");
  ok(pure.thresholdFor(0.05) > 0.05, "噪声底高时阈值自动抬高（嘈杂环境也能等静音）");
}
/* 文本合并：切片重叠导致的重复字要切掉，中英混排不黏字 */
eqStr(pure.mergeTranscript("", "你好世界"), "你好世界", "空正文直接接");
eqStr(pure.mergeTranscript("你好世界", "换个话题"), "你好世界换个话题", "没有重叠 → 直接接");
eqStr(pure.mergeTranscript("今天我们来聊聊全局语音输入", "全局语音输入的实现"), "今天我们来聊聊全局语音输入的实现", "重叠 6 字被切掉（不重复）");
eqStr(pure.mergeTranscript("hello", "world"), "hello world", "英文之间补空格");
eqStr(pure.mergeTranscript("你好", "world"), "你好world", "中文接英文不补空格");
eqStr(pure.mergeTranscript("已有正文", ""), "已有正文", "空增量不改动");
eqStr(pure.mergeTranscript("今天天气不错", "不错啊"), "今天天气不错不错啊", "重叠 2 字（低于去重下限）→ 原样接上，不吞字");

/* ============ 沙箱 2：带假 DOM，跑完整交互链路 ============ */
console.log("\n[2] 三态循环与按钮绘制");
function makeSandbox(opts) {
  const o = opts || {};
  const store = { html: "" };
  const inserted = [];
  const toasted = []; /* toast 文案：自愈 / 「还在下载」这类提示要能被断言 */
  /* 文档级监听：模块用 document.addEventListener("keydown"/"keyup", …, true) 装按键转录，
     这里真的收下来，「按 F1 会怎样」就能整条链跑出来（不再是只看源码字面） */
  const docListeners = {};

  const mkClassList = (el) => {
    const set = new Set();
    return {
      add: (c) => set.add(String(c)),
      remove: (c) => set.delete(String(c)),
      contains: (c) => set.has(String(c)),
      toggle: (c, on) => {
        const k = String(c);
        const want = on === undefined ? !set.has(k) : !!on;
        if (want) set.add(k);
        else set.delete(k);
        return want;
      },
      _set: set,
    };
  };

  const mkEl = (tag, id) => {
    const el = {
      tagName: String(tag || "div").toUpperCase(),
      nodeType: 1,
      id: id || "",
      children: [],
      parentNode: null,
      hidden: false,
      textContent: "",
      title: "",
      value: "",
      type: "",
      isContentEditable: false,
      style: {},
      dataset: {},
      attributes: {},
      selectionStart: 0,
      selectionEnd: 0,
      isConnected: true,
      appendChild(c) {
        this.children.push(c);
        c.parentNode = this;
        return c;
      },
      insertBefore(c, ref) {
        const i = this.children.indexOf(ref);
        if (i < 0) this.children.push(c);
        else this.children.splice(i, 0, c);
        c.parentNode = this;
        return c;
      },
      removeChild(c) {
        this.children = this.children.filter((x) => x !== c);
        c.parentNode = null;
        return c;
      },
      setAttribute(k, v) {
        this.attributes[k] = String(v);
      },
      getAttribute(k) {
        return this.attributes[k] === undefined ? null : this.attributes[k];
      },
      addEventListener() {},
      removeEventListener() {},
      dispatchEvent() {
        return true;
      },
      contains() {
        return false;
      },
      closest() {
        return null;
      },
      focus() {
        sandbox.document.activeElement = this;
      },
      blur() {},
      getBoundingClientRect() {
        return { left: 40, top: 700, right: 200, bottom: 722, width: 160, height: 22 };
      },
      setSelectionRange(s, e) {
        this.selectionStart = s;
        this.selectionEnd = e;
      },
      querySelectorAll() {
        return [];
      },
      offsetWidth: 300,
      offsetHeight: 60,
    };
    el.classList = mkClassList(el);
    return el;
  };

  const foot = mkEl("footer", "foot");
  const shot = mkEl("button", "btnCanvasShot");
  foot.appendChild(shot);
  const input = mkEl("textarea", "agentInput");
  input.value = "";
  const other = mkEl("input", "someNodeField");
  other.type = "text";

  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    btoa: (s) => Buffer.from(s, "binary").toString("base64"),
    Event: class Event {
      constructor(type, o) {
        this.type = type;
        this.bubbles = !!(o && o.bubbles);
      }
    },
    S: { config: {}, wf: { id: "wf-a", workspace: "E:\\dev\\tmp-smoke" } },
    toast: (m) => { toasted.push(String(m)); },
  };
  /* 运行时主动推来的准备态（window.api.onSpeechState）：默认没有这条通道（老 preload）；
     传 o.pushSpeech:true 才挂上，用例可以自己把一帧「下载失败」推进来 */
  const pushed = []; /* 模块注册的回调（装了通道才有） */
  const apiObj = o.api === null ? {} : (o.api || { dshSpeech: async () => ({ ok: true, text: "" }) });
  if (o.pushSpeech) apiObj.onSpeechState = (fn) => { pushed.push(fn); };
  sandbox.window = {
    api: apiObj,
    addEventListener() {},
    getSelection: () => null,
    innerWidth: 1280,
    innerHeight: 800,
    AudioContext: undefined,
  };
  /* 假麦克风（只给按键转录段用）：AudioContext + getUserMedia 的最小可用替身，
     让 startPtt 那条 await startMic() 真的走完，按 F1 → 起录 → 松手 → 停录能被观测 */
  if (o.mic) {
    class StubAudioContext {
      constructor() {
        this.sampleRate = 16000;
      }
      async resume() {}
      createMediaStreamSource() {
        return { connect() {} };
      }
      createAnalyser() {
        return {
          fftSize: 2048,
          smoothingTimeConstant: 0.2,
          getFloatTimeDomainData(buf) {
            buf.fill(0); /* 全程静音：静音门不会自己判句尾（判定权留在用例手里） */
          },
          connect() {},
        };
      }
      async close() {}
    }
    sandbox.window.AudioContext = StubAudioContext;
    sandbox.navigator = {
      mediaDevices: {
        async getUserMedia() {
          return { getTracks: () => [{ stop() {} }] };
        },
      },
    };
  }
  sandbox.document = {
    readyState: "complete",
    activeElement: null,
    body: mkEl("body"),
    documentElement: mkEl("html"),
    createElement: (t) => mkEl(t),
    createRange: () => ({ setStart() {}, collapse() {}, selectNodeContents() {} }),
    createTreeWalker: () => ({ nextNode: () => null }),
    querySelector: (sel) => (sel === "footer.statusbar" ? foot : null),
    getElementById: (id) => (id === "btnCanvasShot" ? shot : id === "btnVoiceGlobal" ? null : null),
    addEventListener(type, fn) {
      const k = String(type);
      (docListeners[k] || (docListeners[k] = [])).push(fn);
    },
    removeEventListener() {},
    execCommand(cmd, _ui, text) {
      if (cmd !== "insertText") return false;
      const cur = sandbox.document.activeElement;
      if (!cur || cur !== input) return false;
      const s = Number(cur.selectionStart) || 0;
      const e = Number(cur.selectionEnd) || s;
      cur.value = cur.value.slice(0, s) + text + cur.value.slice(e);
      cur.selectionStart = cur.selectionEnd = s + String(text).length;
      inserted.push(String(text));
      return true;
    },
  };
  sandbox.window.document = sandbox.document;
  const ctx = vm.createContext(sandbox);
  vm.runInContext(SRC, ctx, { filename: "renderer/app-voice.js" });
  return { ctx, sandbox, foot, shot, input, other, inserted, toasted, store, docListeners, pushed };
}

{
  const box = makeSandbox();
  const V = box.ctx.window.VoiceInput;
  // mount 已随模块加载执行（readyState=complete）：按钮应挂在 #btnCanvasShot 之前
  const btn = box.foot.children.find((c) => c.id === "btnVoiceGlobal");
  ok(!!btn, "按钮被挂进 footer.statusbar（缺静态节点时模块自己补）");
  ok(!!btn && box.foot.children.indexOf(btn) === box.foot.children.indexOf(box.shot) - 1, "按钮就在 #btnCanvasShot 左边");

  eqStr(V.mode(), "off", "默认关闭");
  ok(!!btn && btn.classList.contains("on") === false, "关闭态没有 .on");
  ok(!!btn && /语音输入（关闭）/.test(btn.title), "关闭态 tooltip 说明三态循环");

  eqStr(V.cycle(), "live", "第一次点击 → 持续转录");
  ok(!!btn && btn.classList.contains("is-live"), "持续转录态带 .is-live");
  ok(!!btn && /持续转录中/.test(btn.title), "持续转录态 tooltip");

  eqStr(V.cycle(), "ptt", "第二次点击 → 按键转录");
  ok(!!btn && btn.classList.contains("is-ptt"), "按键转录态带 .is-ptt");
  ok(!!btn && /按住 F1 说话/.test(btn.title), "按键转录态 tooltip 讲清按键（F1：无字符，不会被录进输入框）");

  eqStr(V.cycle(), "off", "第三次点击 → 关闭（三态循环回到起点）");
  ok(!!btn && !btn.classList.contains("on"), "回到关闭态 .on 已摘掉");
}

/* ============ [3] 落点纪律：有焦点才插、走原生插入、失焦暂停 ============ */
console.log("\n[3] 落点纪律（当前 focus 的文本窗）");
const VOICE_SUITE = (async () => {
  const box = makeSandbox();
  const V = box.ctx.window.VoiceInput;
  const st = V._test.state();

  /* 注入假转写（只替掉「送出去转写」这一步，切片 / 合并 / 插入仍是真实现） */
  V._test.inject({
    speech: async () => ({ ok: true, text: box.pendingText || "" }),
  });

  box.input.value = "你好，";
  box.input.selectionStart = box.input.selectionEnd = box.input.value.length;
  box.ctx.document.activeElement = box.input; /* 焦点在这个框上 */
  V.setMode("live");
  eqStr(V.mode(), "live", "注入态下 setMode('live') 生效（下载门被绕过）");

  /* 第一片 */
  box.pendingText = "我们来测一下全局语音输入";
  V._test.feed(new Float32Array(16000));
  await new Promise((r) => setTimeout(r, 60));
  eqStr(box.input.value, "你好，我们来测一下全局语音输入", "识别结果写进当时 focus 的输入框（光标处）");
  eqNum(box.inserted.length, 1, "插入走 document.execCommand(\"insertText\") 一次");
  eqStr(box.inserted[0], "我们来测一下全局语音输入", "插入的正是增量文本（不重复整句）");
  ok(!!st.note && st.note.hidden === false, "浮窗显示中（便笺式临时字）");

  /* 第二片：与前一片重叠 → 去重后再插 */
  box.pendingText = "全局语音输入应该实时写进来";
  V._test.feed(new Float32Array(16000));
  await new Promise((r) => setTimeout(r, 60));
  eqStr(box.input.value, "你好，我们来测一下全局语音输入应该实时写进来", "重叠字被切掉后接上（不重复「全局语音输入」）");

  /* 失焦：不插，但音频照样转写、识别结果留住（点数状态栏那枚话筒就靠这条不丢话） */
  box.pendingText = "这一段失焦时不该插进去";
  box.ctx.document.activeElement = box.other; /* 焦点跑掉了 */
  const before = box.input.value;
  V._test.feed(new Float32Array(16000));
  await new Promise((r) => setTimeout(r, 120));
  eqStr(box.input.value, before, "焦点不在这个框：一个字都不插（未 focus 则无视）");
  eqStr(st.pendingInsert, "这一段失焦时不该插进去", "失焦期间的识别结果留住了（不丢音频，等焦点回来再落）");
  eqNum(st.queue.length, 0, "队列不积压（该转写的照转）");

  /* 焦点回到同一个框：留住的字先落，再接着写 */
  box.pendingText = "回来后继续写";
  box.ctx.document.activeElement = box.input;
  box.input.selectionStart = box.input.selectionEnd = box.input.value.length;
  for (const fn of box.docListeners.focusin || []) fn({ target: box.input });
  await new Promise((r) => setTimeout(r, 60));
  eqStr(box.input.value, "你好，我们来测一下全局语音输入应该实时写进来这一段失焦时不该插进去", "焦点回到同一个框：留住的字补上");
  V._test.feed(new Float32Array(16000));
  await new Promise((r) => setTimeout(r, 60));
  eqStr(box.input.value, "你好，我们来测一下全局语音输入应该实时写进来这一段失焦时不该插进去回来后继续写", "接着写不重排、不覆盖");

  /* 静音门：定稿后浮窗收起、当前句清零 */
  V._test.gate();
  eqStr(V._test.state().bufText, "", "静音门定稿：当前句清零");
  ok(V._test.state().note.hidden === true, "静音门定稿：浮窗收起");
  ok(V._test.state().seg.length === 0, "静音门定稿：切片缓冲清空");

  /* 切画布：丢弃未定稿的临时字 */
  box.pendingText = "切画布前的临时字";
  V._test.feed(new Float32Array(16000));
  await new Promise((r) => setTimeout(r, 60));
  ok(V._test.state().bufText.length > 0, "切画布前当前句里有未定稿的临时字");
  /* 真机顺序：loadWorkflow 先把 S.wf 换成新那张，再渲染 → applyTransform 才调 canvasTick */
  box.sandbox.S.wf.id = "wf-b";
  V.canvasTick("wf-b");
  eqStr(V._test.state().bufText, "", "切画布：未定稿的临时字被丢弃");
  eqStr(V._test.state().interim, "", "切画布：浮窗文本一并清空");
  {
    const a = V._test.state().anchor;
    ok(
      a === null || a.wfId === "wf-b",
      "切画布：插入锚点只认新画布（要么清空、要么重锚在当前 focus 的框上）"
    );
  }
  eqStr(V.mode(), "live", "切画布不改用户的模式选择（按钮仍是持续转录）");
  ok(V._test.state().queue.length === 0, "切画布：转写队列清空（旧画布的在途结果不会插进新画布）");

  /* 关闭：浮窗收起、锚点清空、状态归零 */
  V.setMode("off");
  await new Promise((r) => setTimeout(r, 20));
  eqStr(V.mode(), "off", "setMode('off') 回到关闭");
  ok(V._test.state().note.hidden === true, "关闭后浮窗收起");

  /* ============ [4] 静音门排在在途转写之前：尾巴不能丢 ============ */
  console.log("\n[4] 静音门与在途转写（本地推有几百毫秒延迟，字不能丢）");
  {
    const box3 = makeSandbox();
    const V3 = box3.ctx.window.VoiceInput;
    /* 手动放行的转写：让「静音门先到、转写后到」这个真实时序可复现 */
    let release = null;
    const pending = [];
    V3._test.inject({
      speech: (pcm) => {
        void pcm;
        const p = new Promise((res) => pending.push(res));
        return p;
      },
    });
    box3.input.value = "";
    box3.ctx.document.activeElement = box3.input;
    V3.setMode("live");

    V3._test.feed(new Float32Array(16000));
    await new Promise((r) => setTimeout(r, 30));
    ok(pending.length === 1, "第一片已提交（在途）");

    V3._test.gate(); /* 静音门先到：此时尾巴还在途 */
    ok(!!V3._test.state().pendingFinalize, "静音门只打「待收口」标记，不提前清空当前句");
    eqStr(V3._test.state().bufText, "", "在途结果还没回来，当前句仍为空（没提前丢字）");

    release = pending.shift();
    release({ ok: true, text: "尾巴这一句不能丢" });
    await new Promise((r) => setTimeout(r, 60));
    eqStr(box3.input.value, "尾巴这一句不能丢", "在途尾巴回来后照样写进输入框（一个字都不丢）");

    V3._test.feed(new Float32Array(16000));
    await new Promise((r) => setTimeout(r, 30));
    V3._test.gate();
    release = pending.shift();
    release({ ok: true, text: "第二段也算数" });
    await new Promise((r) => setTimeout(r, 60));
    eqStr(box3.input.value, "尾巴这一句不能丢第二段也算数", "下一句接在后面（不重叠、不覆盖）");
    await new Promise((r) => setTimeout(r, 60));
    eqStr(V3._test.state().bufText, "", "队列排空后才收口：当前句清零");
    ok(V3._test.state().note.hidden === true, "队列排空后才收口：浮窗收起");
    V3.setMode("off");
  }

  /* ============ [5] 按键转录（PTT）：F1 的吞键与起停纪律 ============ */
  console.log("\n[5] 按键转录（PTT）：按住 F1 说话 · F1 既不落进输入框也不重复起停");
  /* 这一段给沙箱配了假麦克风（o.mic）：按 F1 能真的走完 startPtt → 起录，松开 → stopPtt */
  const box2 = makeSandbox({ mic: true });
  const V2 = box2.ctx.window.VoiceInput;
  V2._test.inject({ speech: async () => ({ ok: true, text: "" }) });
  V2.setMode("ptt");
  eqStr(V2.mode(), "ptt", "按键转录态可设");
  const st2 = V2._test.state();
  ok(!!st2.btn && st2.btn.classList.contains("is-ptt"), "按键态按钮带 .is-ptt");
  eqStr(st2.bufText, "", "按键态未按时不采集内容");
  /* 模块挂载时会自己跑一轮「探测语音服务」的就绪重试（4×400ms 退避，期间按钮在载入态，
     失败则进错误态）。等这两个瞬时态自己收干净再按键，断言才是对「按键那一刻」的。 */
  await (async () => {
    for (let i = 0; i < 40 && (V2._test.state().loading || V2._test.state().provErr); i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
  })();
  ok(!V2._test.state().loading && !V2._test.state().provErr, "挂载期的就绪重试已收干净（起录断言的基线）");

  /* 文档级 keydown / keyup 监听（模块 installKeys 装的，捕获阶段） */
  const docFires = (type, ev) => {
    for (const fn of box2.docListeners[type] || []) fn(ev);
  };
  const keyEv = (code, extra) => {
    const o = extra || {};
    return {
      code,
      key: o.key === undefined ? code : o.key,
      ctrlKey: !!o.ctrlKey,
      altKey: !!o.altKey,
      metaKey: !!o.metaKey,
      repeat: !!o.repeat,
      prevented: 0,
      stopped: 0,
      preventDefault() {
        this.prevented++;
      },
      stopPropagation() {
        this.stopped++;
      },
    };
  };
  const seen = { keydown: 0, keyup: 0 };
  box2.sandbox.document.addEventListener("keydown", () => { seen.keydown++; });
  box2.sandbox.document.addEventListener("keyup", () => { seen.keyup++; });
  box2.input.value = "";
  box2.input.selectionStart = box2.input.selectionEnd = 0;
  box2.sandbox.document.activeElement = box2.input; /* 焦点就在消息框上：F1 若漏键就会录进来 */
  ok((box2.docListeners.keydown || []).length > 0 && (box2.docListeners.keyup || []).length > 0,
    "模块在 document 上装好了 keydown / keyup（捕获阶段）");

  /* 按住 F1：起录 + 吞键 */
  const evF1 = keyEv("F1");
  docFires("keydown", evF1);
  eqNum(evF1.prevented, 1, "F1 keydown 被 preventDefault（浏览器默认行为被掐掉）");
  eqNum(evF1.stopped, 1, "F1 keydown 被 stopPropagation（不再漏给上层控件）");
  await new Promise((r) => setTimeout(r, 40));
  ok(V2._test.state().pttOn === true, "按住 F1 → 真的起录（pttOn）");
  ok(st2.btn.classList.contains("is-mic"), "起录时按钮进按键呼吸态（.is-mic）");
  eqStr(st2.btn.textContent, "●", "起录时按钮字面是录音点（不是 F1，也不是 …）");
  eqStr(box2.input.value, "", "起录一个字都没往输入框里插（F1 无字符，天然不进正文）");
  eqNum(box2.inserted.length, 0, "起录走的不是插入路径（execCommand(\"insertText\") 一次都没调用）");

  /* 长按的系统重复：不重复起停 */
  const pttSeq1 = V2._test.state().segSeq;
  const evRep = keyEv("F1", { repeat: true });
  docFires("keydown", evRep);
  eqNum(evRep.prevented, 1, "长按的系统重复帧也被吞掉（不落进输入框）");
  ok(V2._test.state().pttOn === true, "重复帧不重启录制（仍是同一次起录）");
  eqNum(V2._test.state().segSeq, pttSeq1, "重复帧没有重开一路采集（片序不变）");

  /* Ctrl+F1：系统组合键原样放行 */
  const evCtrl = keyEv("F1", { ctrlKey: true });
  docFires("keydown", evCtrl);
  eqNum(evCtrl.prevented, 0, "Ctrl+F1 放行：不 preventDefault（不抢系统快捷键）");
  eqNum(evCtrl.stopped, 0, "Ctrl+F1 放行：不 stopPropagation");
  ok(V2._test.state().pttOn === true, "Ctrl+F1 不改录制状态");

  /* 松开 F1：停录 */
  const evUp = keyEv("F1");
  docFires("keyup", evUp);
  eqNum(evUp.prevented, 1, "F1 keyup 被吞（与 keydown 成对，不留半截状态）");
  ok(V2._test.state().pttOn === false, "松开 F1 → 停录（pttOn 归否）");
  /* 松手后按钮必须「回到常态显示」：键面 F1；若那一刻恰好还在就绪重试窗口里就是载入弧
     （字面空 + .is-loading 成对出现，不会两者都不是）。 */
  if (st2.btn.classList.contains("is-loading")) {
    eqStr(st2.btn.textContent, "", "停录后落在就绪重试窗口：载入态（字面空 + .is-loading 成对）");
  } else {
    eqStr(st2.btn.textContent, "F1", "停录后按钮字面回到键面 F1");
  }
  ok(st2.btn.classList.contains("is-mic"), "松开后仍是按键转录开启态（.is-mic 呼吸不因松手而闪断）");
  await new Promise((r) => setTimeout(r, 240)); /* 等 stopPtt 的收口 setTimeout */
  eqStr(box2.input.value, "", "松开 F1 之后正文仍是空的（全段无字漏进输入框）");
  eqNum(seen.keydown, 3, "三次 keydown 都真的派发到了监听（不是空跑）");
  eqNum(seen.keyup, 1, "一次 keyup 也真的派发到了监听");
  V2.setMode("off"); /* 收尾：停采集（frameTimer）并回关闭态 */

  /* ============ [6] 按钮绘制恒定 + 载入态是旋转图标 ============ */
  console.log("\n[6] 按钮绘制：同态不切 class · 载入态画弧不写字");
  {
    const bx = makeSandbox();
    const Vv = bx.ctx.window.VoiceInput;
    const b = Vv._test.state().btn;
    const classesOf = (el) => Array.from(el.classList._set).sort().join(" ");
    const identityOf = (el) => el.classList;
    ok(!!b, "按钮已挂上（[6] 的绘制断言有对象）");

    Vv.setMode("live");
    const cls0 = classesOf(b);
    const idset0 = identityOf(b);
    for (let i = 0; i < 6; i++) Vv.refresh(); /* 状态推送 / 手动刷新都会带一次重绘 */
    eqStr(classesOf(b), cls0, "同一个模式连续重绘 6 次：class 集合一个都不变（不逐帧摘挂）");
    ok(identityOf(b) === idset0, "连续重绘期间 classList 是同一个对象（没有重建 class 容器 → 动画不会被重置）");
    ok(b.classList.contains("is-mic"), "开启态恒定带 .is-mic（呼吸动画有稳定宿主；不再看每帧都变的 stream / pttOn）");

    /* 载入态（is-loading）：首帧通道 / 服务商还没挂上时的就绪重试窗口。
       把宿主桥换成「每次都慢 25ms 且答不出服务商」的探针 —— 第一发直发（不进载入态），
       退回 400ms 退避时按钮进 is-loading；此时字面清空，弧交给 CSS ::before 画。
       退避窗口内再调一次 refresh（状态推送常见），模块自己识别「已在载入」不重开，正好取快照。 */
    const slowEmpty = () => new Promise((r) => setTimeout(() => r({ ok: true, providers: [], active: "" }), 25));
    bx.sandbox.window.api.dshSpeech = () => slowEmpty();
    Vv.refresh();
    await new Promise((r) => setTimeout(r, 100)); /* 第一发已答话（名单空）→ 进入 400ms 退避 */
    Vv.refresh();
    ok(b.classList.contains("is-loading"), "通道未就绪的就绪重试窗口 → 按钮进 .is-loading");
    eqStr(b.textContent, "", "载入态不写字面（原来的 '…' 已去掉，弧交给 CSS ::before）");
    ok(!/…/.test(b.textContent), "载入态字面里没有省略号");
    await new Promise((r) => setTimeout(r, 1500)); /* 让这一轮退避重试走完 */
    bx.sandbox.window.api.dshSpeech = async () => ({ ok: true, text: "" });
    Vv.setMode("live"); /* 期间麦克风失败会把模式打回关闭：重新置 live 再断言收尾 */
    Vv.refresh(); /* 这次通道答话了：立刻摘掉 is-loading */
    ok(!b.classList.contains("is-loading"), "载入结束（通道答话）才摘掉 .is-loading");
  }
  const VCSS = read("renderer/css/voice.css");
  ok(/\.sb-voice\.is-loading::before/.test(VCSS) && /@keyframes gv-spin/.test(VCSS),
    "载入弧是纯 CSS（.sb-voice.is-loading::before + @keyframes gv-spin）");

  /* ============ [7] 设置 / 配置 ============ */
  console.log("\n[7] 配置（设置小节与右键菜单共用的那一份）");
  const c0 = V2.cfg();
  eqNum(c0.silenceMs, 300, "默认断句停顿 300 ms（本轮把 900 改短：句子截止用更短的停顿检测）");
  eqStr(c0.language, "auto", "默认语言 auto");
  ok(c0.chunkMs === undefined, "切片长度（chunkMs）已随「停顿才提交」口径退役（配置里不再有它）");
  V2.setCfg({ chunkMs: 99999, silenceMs: 1, language: "xx" });
  const c1 = V2.cfg();
  eqNum(c1.silenceMs, 100, "断句停顿被夹在下限内（100 ms）");
  V2.setCfg({ silenceMs: 99999 });
  eqNum(V2.cfg().silenceMs, 2000, "断句停顿被夹在上限内（2000 ms）");
  ok(c1.chunkMs === undefined, "即使旧配置里还留着 chunkMs，也不再回吐给界面（向后兼容不炸）");
  eqStr(c1.language, "auto", "非法语言被夹回 auto（不落到官方 provider 上被拒）");
  V2.setCfg({ language: "auto", silenceMs: 900 });
  eqStr(V2.cfg().language, "auto", "配置写回生效");

  /* 界面口径：两处设置里都不再有「切片长度」这一行（行为变了，名字不能留着骗人）。
     沙箱的伪 DOM 不实现 textContent（选项文字读不回来），所以这里直接查**源码**：
     去掉注释后，菜单与设置小节两处都不该再提「切片长度」；新口径（停顿整段提交 / 句长不封顶 /
     只在后端硬顶切 / 浮窗报「正在听」）必须在源码里写明。 */
  {
    const src = read("renderer/app-voice.js");
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^[ \t]*\/\/.*$/gm, "");
    ok(code.indexOf("切片长度") < 0, "app-voice.js 代码里不再有「切片长度」这一行（菜单 / 设置输入框都已摘掉）");
    ok(code.indexOf("addOpt(chunkRow") < 0, "「切片长度」的快捷选项整块移除");
    ok(code.indexOf("row(T(\"切片长度（毫秒）\")") < 0, "设置小节里的切片长度输入框移除");
    ok(!/MAX_NOTE_MS/.test(src), "15 秒句长封顶整块撤掉（MAX_NOTE_MS 不再存在）");
    ok(/HARD_CAP_FALLBACK_MS = 128000/.test(src), "只剩后端硬顶兜底（≈128 秒，SP_HARD_SEC 口径）");
    ok(/function hardCapMs\(\)/.test(src) && /hardCapSamples\(\)/.test(src), "硬顶从 app-speech.js 的 spHardCapMs() 现读（一处真源，不各写一份）");
    ok(/spQuietCutMs/.test(src), "撞硬顶时在最接近的低能量点切一刀（不是齐头切）");
    ok(/正在听…/.test(src) && /noteBars/.test(src), "浮窗在说话过程中报「正在听…」+ 音量条（不显示假文字）");
    ok(/trimTailSilence/.test(src), "提交前裁掉尾巴上多余的静音（只留约 300ms）");
    ok(/smoothLevel/.test(src), "断句判据走滑窗稳定性（最近若干帧的中位数）而不是单帧瞬时值");
    const vcss = read("renderer/css/voice.css");
    ok(/\.gv-note\.is-rec/.test(vcss) && /\.gv-note-vol/.test(vcss), "录音中浮窗与音量条的样式齐备");
  }

  const cfgObj = box2.sandbox.S.config.voice;
  ok(!!cfgObj && typeof cfgObj === "object", "配置落在 S.config.voice（随设置一起落盘）");

  /* ============ [8] 一帧 PCM 驱动：停顿才整段提交 / 句长不封顶（只在后端硬顶切）/ 静音门 ============ */
  console.log("\n[8] 分段与静音门（真 onFrame，不是直喂队列）");
  {
    /* 旧口径按 chunkMs 定时切片（每 1.2 秒一片、每片单独送识别 ⇒ 句子被拦腰截断）。
       新口径：整句攒着，**只在停顿（连续安静够久）时交一次**；一直不停顿也一直攒，
       只在撞到后端硬顶（≈128 秒）时交一次。 */
    const bx = makeSandbox({ mic: true });
    const Vx = bx.ctx.window.VoiceInput;
    const stx = Vx._test.state();
    const FRAME = Vx._test.frameSamples; /* 960 = 60ms @16k */
    const feed = (level, n) => {
      const f = new Float32Array(FRAME);
      f.fill(level);
      for (let i = 0; i < n; i++) Vx._test.onFrame(f);
    };
    eqNum(FRAME, 960, "一帧 = 60ms @16k = 960 样本（帧步长与样本数配套）");
    ok(Vx._test.hardCapMs >= 120000, "句长只剩后端硬顶（≈128 秒），不再有 15 秒封顶 · " + Vx._test.hardCapMs + " ms");
    ok(Vx._test.levelWin >= 4, "起音判据仍是滑窗（多帧）稳定性，不是单帧瞬时值 · 窗口 " + Vx._test.levelWin + " 帧");

    const got = [];
    Vx._test.inject({ speech: async (pcm) => { got.push(pcm.length); return { ok: true, text: "" }; } });
    bx.input.value = "";
    bx.input.selectionStart = bx.input.selectionEnd = 0;
    bx.ctx.document.activeElement = bx.input;
    Vx.setMode("live");
    /* 起麦克风是异步的（startMic 里 await getUserMedia + 建 AudioContext），它落地时会**复位**
       分段状态 —— 必须等它落定再喂帧，否则喂进去的帧会被这一次复位清掉（那是真机时序，
       不是被测逻辑的错）。留足 1 秒：setMode 与挂载那一路可能各起一次，两次都落定才干净。
       真机上人说完第一句时采集早就起来了。 */
    await new Promise((r) => setTimeout(r, 1000));
    ok(!!stx.stream && !stx.micStarting, "麦克风已起来（喂帧前先等采集落地）");
    /* 真机那条 analyser 帧定时器（60ms 一拍）会与这里「直喂帧」交替进来，样本数就不确定了：
       停掉定时器，之后仍用 onFrame(pcm) 走**同一条状态机**（真机与冒烟同一份实现）。 */
    Vx._test.stopFrameTimer();
    eqStr(stx.frameTimer, null, "冒烟里停掉真实帧定时器（样本数可控，状态机仍是真实现）");
    ok(Vx._test.noStall(true) === true, "同时关掉「采集停摆自愈」（手动喂帧的间隔不代表真机停摆）");
    feed(0.0004, 8); /* 先立噪声底（滑窗 + 20% 分位） */
    eqNum(got.length, 0, "还没说话：一段都没提交");
    feed(0.05, 40); /* 2.4s 说话 */
    await new Promise((r) => setTimeout(r, 250));
    eqNum(got.length, 0, "2.4s 连续说话**一段都不提交**（旧口径这里已经切了 2~3 片、每片单独识别）");
    ok(stx.segSamples > 40 * FRAME * 0.9, "整句攒在缓冲里（攒到 2.4 秒的量）");

    /* 静音门：说完 300ms 静音（默认阈值）必须**整段**提交 —— 一段包含整句。
       喂 20 帧（1.2s）：句末判据是「连续安静帧」，300ms = 5 帧就到点（阈值写多少就是多少，
       不再等中位数窗口从中位语声降下来）。 */
    feed(0.0004, 20);
    eqNum(got.length, 1, "停顿那一刻整句交出去：只有 1 段（不是按时间切的一串碎片）");
    /* 提交长度 = 起音前 350ms 预卷 + 2.4s 说话 + 300ms 句尾静音（多出来的静音被裁掉） */
    ok(
      got[0] >= Math.round(16000 * 2.6) && got[0] <= Math.round(16000 * 3.3),
      "这一段的量级 ≈ 3 秒（预卷 0.35s + 说话 2.4s + 保留的 0.3s 句尾）· 实测 " + got[0] + " 样本",
    );
    /* 尾部静音被裁：真实说了 2.4s + 1.2s 静音，若一点都不裁会是 ≈3.95s，实测必须明显更短 */
    ok(got[0] < Math.round(16000 * 3.6), "尾巴上多余的静音被裁掉（只留约 300ms）· 实测 " + got[0] + " 样本");
    ok(stx.pendingFinalize === true, "静音门走通（这句说完，不再是一直录）");
    await new Promise((r) => setTimeout(r, 250));
    eqNum(stx.pendingFinalize, false, "尾巴转写回来后收口（等队列排空才清）");
    eqStr(stx.bufText, "", "定稿后当前句清零");
    /* 浮窗：这一句已经定稿且没有可显示的文字 —— 只剩「那一句没就绪」的错误行
       （这个沙箱的假 state 故意答「没有服务商」，正好覆盖错误可见性）。这里钉住
       **这一句不再被当成「正在录」**：预卷清了、静音门也不再武装。 */
    ok(!stx.gateArm && stx.segSamples < 5600, "定稿后不再被当成「正在录」（句前预卷也清了）");

    /* 句长不再封顶：一直说、长时间不停顿 → 一直攒着，只在后端硬顶（≈128 秒）才交一次 */
    const before = got.length;
    feed(0.05, 300); /* 18s 连续说话、一次不停顿 */
    await new Promise((r) => setTimeout(r, 250));
    eqNum(got.length, before, "18 秒连续不停顿：一段都不交（15 秒封顶已取消）");
    feed(0.05, 1900); /* 再 114s → 累计 132s，撞上后端硬顶 */
    await new Promise((r) => setTimeout(r, 250));
    ok(got.length > before, "撞到后端硬顶（≈128 秒）才交一段（字不会一直不落）· 实测 " + JSON.stringify(got.slice(before)));
    const capped = got[got.length - 1];
    ok(
      capped >= Math.round(16000 * 120) && capped <= Math.round(16000 * 132),
      "硬顶那一段是 ≈128 秒的量级（起音前的预卷也算在里面）· 实测 " + capped + " 样本",
    );
    ok(stx.segOn === true, "硬顶之后仍在继续收（不是把麦克风停了）");

    /* 关闭时把还在攒的尾巴也交出去（用户刚说完就点关闭，那几个字不烂在缓冲里） */
    const before2 = got.length;
    Vx.setMode("off");
    await new Promise((r) => setTimeout(r, 250));
    eqNum(stx.segSamples, 0, "关闭时尾巴被交出去（不残留在缓冲里）");
    eqNum(stx.queue.length, 0, "关闭后转写队列也排空了");
    ok(got.length >= before2, "关闭那一刻的尾巴也走了转写通道（不是静默丢弃）");
  }

  /* ============ [9] 模型没就绪时不画假录音点，就绪后自动开录 ============ */
  console.log("\n[9] 模型还在下载时切持续转录：按钮不画录音点，就绪后自愈开录");
  {
    let phase = "downloading";
    const bp = makeSandbox({
      mic: true,
      api: { dshSpeech: async (p) => (p && p.action === "prepare" ? prepRes(phase) : prepRes(phase)) },
    });
    const Vp = bp.ctx.window.VoiceInput;
    const stp = Vp._test.state();
    await new Promise((r) => setTimeout(r, 150));
    bp.input.value = "";
    bp.ctx.document.activeElement = bp.input;
    Vp.setMode("live");
    await new Promise((r) => setTimeout(r, 150));
    ok(stp.stream === null, "下载中：麦克风不起（转写必然失败，别硬发）");
    const btnP = bp.foot.children.find((c) => c.id === "btnVoiceGlobal");
    ok(!!btnP && btnP.textContent !== "●", "按钮不画录音点（旧稿画 ● 看着在录、其实没录）", JSON.stringify(btnP && btnP.textContent));
    ok(bp.toasted.some((t) => /还没下载完/.test(t)), "给出了「还在下载」的说明（不是点了没反应）");
    phase = "standby"; /* 下载完成 */
    for (let i = 0; i < 30 && !stp.stream; i++) await new Promise((r) => setTimeout(r, 300));
    ok(!!stp.stream, "就绪后自动开录（不用手动关一次再开：退避探测到 ready/standby 就补起采集）");
    Vp.setMode("off");
  }

  /* ============ [10] 失败可见性与重试入口（模型下载 / 准备失败） ============
     病症：模型下载失败时界面**停在「↓ 百分比」**上，既不说从哪下的、也不说为什么，
     右键菜单与设置里的两枚「下载 / 检查语音模型」「重新检查语音服务」点了像没反应。
     这里用假 speech 通道把「下载失败 → 看得见 → 点得通 → 真的重发」整条链跑出来。 */
  console.log("\n[10] 失败可见性与重试入口（下载失败不再停在百分比上）");
  {
    const failPrep = {
      phase: "failed",
      resource: "model.int8.onnx",
      download: { resource: "model.int8.onnx", source: "https://huggingface.co", reason: "network", status: 0 },
    };
    let prepState = failPrep;
    let prepareCalls = 0;
    let lastPrepReq = null; /* 记下最后一次 prepare 的完整参数（要断言「换源重试」真的带上了源） */
    /* 两个动作分开答：`state` 答的是「此刻的真实准备态」（失败就答失败），
       `prepare` 答的是「这一发请求之后的新态」——真机上重发 prepare 就会把下载重新推起来。 */
    let stateMode = "fail";
    const dims = { phase: "downloading", totalBytes: 239233841, completedBytes: 12000000 };
    const apiStub = async (p) => {
      const action = String((p && p.action) || "state");
      if (action === "prepare") {
        prepareCalls++;
        lastPrepReq = p;
        stateMode = "downloading"; /* 重发 prepare = 下载重新跑起来（真机语义） */
      }
      return {
        ok: true,
        providers: [
          {
            id: "sensevoice-local",
            name: "SenseVoiceSmall",
            downloadSources: ["https://huggingface.co", "https://hf-mirror.com"],
            preparation: stateMode === "downloading" ? Object.assign({}, dims) : Object.assign({}, prepState),
          },
        ],
        selection: { providerId: "sensevoice-local", language: "auto" },
      };
    };
    const bx = makeSandbox({ mic: true, api: { dshSpeech: apiStub } });
    const Vx = bx.ctx.window.VoiceInput;
    const stx = Vx._test.state();
    const btn = bx.foot.children.find((c) => c.id === "btnVoiceGlobal");
    ok(!!btn, "按钮已挂上（[10] 的断言有对象）");

    /* ① 失败态要看得见：红色错误态 + ⬇（不再写字面百分比）+ tooltip 里有原因与源 */
    await Vx.refresh();
    await new Promise((r) => setTimeout(r, 40));
    eqStr(stx.prep && stx.prep.phase, "failed", "准备态收在 failed 上（假通道直给）");
    ok(btn.classList.contains("is-err"), "失败后按钮进错误态（.is-err）");
    ok(btn.classList.contains("is-dlerr"), "失败后按钮带下载错误标（.is-dlerr）");
    ok(!/\d+%/.test(btn.textContent), "失败后按钮**不再显示百分比**（旧稿停在 ↓ 百分比上）", JSON.stringify(btn.textContent));
    ok(/网络连不上下载源/.test(btn.title), "tooltip 给出原因（「网络连不上下载源」）");
    ok(/huggingface\.co/.test(btn.title), "tooltip 给出下载源（huggingface.co）");
    ok(/重新检查语音服务|下载 \/ 检查语音模型/.test(btn.title), "tooltip 给出重试入口");
    ok(bx.toasted.some((t) => /下载源|下载失败|网络连不上/.test(t)), "失败也弹了一条能照做的提示", JSON.stringify(bx.toasted));
    /* 「不排自动重试」这条要对干净的时刻断言：挂载期那一轮就绪重试可能已经排过一次（那是通道
       没挂上的自动重试，与下载失败无关），先把它清掉，再看这次失败会不会自己排。 */
    if (stx.provRetryTimer) {
      clearTimeout(stx.provRetryTimer);
      stx.provRetryTimer = null;
    }
    stateMode = "fail";
    await Vx.refresh();
    await new Promise((r) => setTimeout(r, 40));
    ok(!stx.provRetryTimer, "这条失败**不排自动重试**（避免把失败糊成一直转圈）");

    /* ② 右键菜单：失败行 + 两枚重试入口都在，且「检查」真的重发了一发 prepare */
    const menu = Vx._test.menu();
    ok(!!menu, "右键快捷菜单被打开");
    const flat = (el) => {
      const out = [el];
      for (const c of el.children || []) out.push(...flat(c));
      return out;
    };
    const all = menu ? flat(menu) : [];
    const labels = all.map((x) => String(x.textContent || ""));
    ok(labels.some((t) => t === "下载 / 检查语音模型"), "菜单里有「下载 / 检查语音模型」", JSON.stringify(labels));
    ok(labels.some((t) => t === "重新检查语音服务"), "菜单里有「重新检查语音服务」", JSON.stringify(labels));
    const stRow = all.find((x) => /(^|\s)gv-menu-status(\s|$)/.test(String(x.className || "")));
    ok(!!stRow && /上次失败/.test(String(stRow.textContent)), "菜单里有一行「上次失败：…」", stRow ? String(stRow.textContent) : "缺");
    ok(!!stRow && /huggingface\.co/.test(String(stRow.textContent)), "那一行写出了下载源", stRow ? String(stRow.textContent) : "缺");
    ok(!!stRow && /网络连不上下载源/.test(String(stRow.textContent)), "那一行写出了原因");
    const recheckBtn = all.find((x) => String(x.textContent || "") === "重新检查语音服务");
    prepareCalls = 0;
    ok(!!recheckBtn, "菜单里的「重新检查语音服务」是可点的按钮");
    if (recheckBtn && typeof recheckBtn.onclick === "function") recheckBtn.onclick();
    /* ③ 点得通：Refresh('manual') 重读服务商，ensurePrepared(fresh) 重发 model prepare */
    const dlBtn = all.find((x) => String(x.textContent || "") === "下载 / 检查语音模型");
    if (dlBtn && typeof dlBtn.onclick === "function") dlBtn.onclick();
    await new Promise((r) => setTimeout(r, 120));
    ok(prepareCalls >= 1, "点了菜单里的重试真的重发了 prepare（实测 " + prepareCalls + " 次）");
    ok(bx.toasted.some((t) => /正在检查语音模型|正在检查语音服务/.test(t)), "点了重试立刻有回执（toast：正在检查…）", JSON.stringify(bx.toasted));
    eqStr((stx.prep || {}).phase, "downloading", "重试后回到下载中（新的准备任务真的起来了）");
    ok(!btn.classList.contains("is-err"), "重试后错误态摘掉（不把旧失败挂在按钮上）");

    /* ④ 设置 · 语音输入（全局）里的同名入口：失败行 + 换源重试 */
    const sec = Vx.settingsSection();
    ok(!!sec, "设置小节建得出来");
    const secAll = flat(sec);
    const secBtnLabels = secAll.map((x) => String(x.textContent || ""));
    ok(secBtnLabels.indexOf("下载 / 检查语音模型") >= 0, "设置里也有「下载 / 检查语音模型」");
    ok(secBtnLabels.indexOf("重新检查语音服务") >= 0, "设置里也有「重新检查语音服务」");
    const secLine = secAll.find((x) => /(^|\s)gv-dl-line(\s|$)/.test(String(x.className || "")));
    ok(!!secLine, "设置里有「模型状态」那一行");
    ok(!!secLine && /正在下载语音模型/.test(String(secLine.textContent)), "下载中这一行给进度", secLine ? String(secLine.textContent) : "缺");

    /* 再回到失败态：这一行必须给「原因 + 源」并放出可换的源 */
    stateMode = "fail";
    await Vx.refresh();
    await new Promise((r) => setTimeout(r, 40));
    ok(!!secLine && /上次下载失败/.test(String(secLine.textContent)), "失败时这一行写「上次下载失败：…」", secLine ? String(secLine.textContent) : "缺");
    ok(!!secLine && /网络连不上下载源/.test(String(secLine.textContent)), "失败行里有原因");
    ok(!!secLine && /huggingface\.co/.test(String(secLine.textContent)), "失败行里有下载源");
    const srcRow = secAll.find((x) => /(^|\s)gv-dl-src(\s|$)/.test(String(x.className || "")));
    ok(!!srcRow && srcRow.hidden === false, "失败时放出「换一个下载源」那一行");
    const srcSel = srcRow ? (srcRow.children || []).find((x) => x.tagName === "SELECT") : null;
    const srcOpts = srcSel ? (srcSel.children || []).map((o) => String(o.value || "")) : [];
    ok(srcOpts.some((v) => /hf-mirror\.com/.test(v)), "备用源来自官方广告的 downloadSources（hf-mirror.com）", JSON.stringify(srcOpts));
    const retrySrc = srcRow ? (srcRow.children || []).find((x) => String(x.textContent || "") === "用这个源重试") : null;
    ok(!!retrySrc, "有「用这个源重试」按钮");
    if (retrySrc && typeof retrySrc.onclick === "function" && srcSel) {
      srcSel.value = "https://hf-mirror.com";
      prepareCalls = 0;
      retrySrc.onclick();
      await new Promise((r) => setTimeout(r, 120));
      eqStr(Vx.cfg().downloadSource, "https://hf-mirror.com", "选中的源落到配置里（随设置一起落盘）");
      ok(prepareCalls >= 1, "「用这个源重试」真的重发了 prepare");
      eqStr(lastPrepReq && lastPrepReq.downloadSource, "https://hf-mirror.com", "重发的 prepare 带上了这个源");
    } else {
      ok(false, "「用这个源重试」按钮没能取到（断言链断了）");
    }

    /* ⑤ 设置里那两枚也要点得通（本轮根因③：以前点完只 toast 一句、失败后既看不到原因也换不了源）：
       再推回失败态，点「重新检查语音服务」——与右键菜单里同名的那一枚是同一个动作，必须真的重发。 */
    stateMode = "fail";
    await Vx.refresh();
    await new Promise((r) => setTimeout(r, 40));
    const secRecheck = secAll.find((x) => String(x.textContent || "") === "重新检查语音服务");
    ok(!!secRecheck && typeof secRecheck.onclick === "function", "设置里的「重新检查语音服务」是可点的按钮");
    prepareCalls = 0;
    if (secRecheck && typeof secRecheck.onclick === "function") secRecheck.onclick();
    await new Promise((r) => setTimeout(r, 120));
    ok(prepareCalls >= 1, "设置里那一枚点下去真的重发了 prepare（实测 " + prepareCalls + " 次）");
    eqStr((stx.prep || {}).phase, "downloading", "设置里重试后同样回到下载中");

    /* ⑥ 失败可见性只靠既有词条：原因一律过 DL_REASON 词表，原始英文 reason 不进用户视野 */
    const VCSS10 = read("renderer/css/voice.css");
    ok(/\.sb-voice\.is-dlerr/.test(VCSS10), "下载失败的按钮态有专属样式（.sb-voice.is-dlerr）");
    ok(/\.gv-menu-status/.test(VCSS10) && /\.gv-dl-status/.test(VCSS10), "失败行与设置状态行的样式都在 css 里");
    const SRC10 = read("renderer/app-voice.js");
    ok(/const DL_REASON = \{[\s\S]*?integrity:[\s\S]*?storage:/.test(SRC10),
      "七种官方下载失败原因都有中文词条（DL_REASON 词表）");
    ok(/downloadFailText\(/.test(SRC10) && /T\(DL_REASON\[reason\]/.test(SRC10),
      "给用户的那句话一律走 downloadFailText + DL_REASON（不直接摆官方英文 reason）");
  }

  /* ============ [11] 运行时推来的 failed：没有 download 结构体时也要「看见」 ============
     病症（本轮根因的漏网分支）：下载失败最主要的入口是**运行时主动推来的那一帧**
     （`api.onSpeechState({state})`，进度与失败同源）。官方 SpeechPreparationState 并不保证
     失败帧都带 `download` 结构体（`slimState()` 只在 s.download 是对象时才透传），
     于是这一帧以前只落了 `provErr` 一句通用说明：按钮没有 `.is-dlerr`、tooltip 与右键菜单 /
     设置里都没有「原因 + 下载源」那一行，重试入口看着不像能用 —— 正好是本轮要修的病。
     这里推一帧「failed + 只有 message 里的结构化片段」进来，断言整条链照样长出来。 */
  console.log("\n[11] 运行时推来的 failed（无 download 结构体）也要看得见、点得通");
  {
    /* 只有一个 provider，preparation 随推送帧走；prepare 一答就把 phase 拉回 downloading */
    let prepPhase = Object.assign({}, {
      phase: "downloading",
      resource: "model.int8.onnx",
      completedBytes: 4000000,
      totalBytes: 239233841,
    });
    let prepareCalls11 = 0;
    const apiStub11 = async (p) => {
      if (String((p && p.action) || "state") === "prepare") {
        prepareCalls11++;
        prepPhase = Object.assign({}, prepPhase, { phase: "downloading", download: undefined });
      }
      return {
        ok: true,
        providers: [
          {
            id: "sensevoice-local",
            name: "SenseVoiceSmall",
            downloadSources: ["https://huggingface.co", "https://hf-mirror.com"],
            preparation: Object.assign({}, prepPhase),
          },
        ],
        selection: { providerId: "sensevoice-local", language: "auto" },
      };
    };
    const b11 = makeSandbox({ mic: true, pushSpeech: true, api: { dshSpeech: apiStub11 } });
    const V11 = b11.ctx.window.VoiceInput;
    const btn11 = b11.foot.children.find((c) => c.id === "btnVoiceGlobal");
    ok(!!btn11, "按钮已挂上（[11] 的断言有对象）");
    ok(b11.pushed.length === 1, "运行时推送通道已挂上（onSpeechState 被注册）");

    await V11.refresh();
    await new Promise((r) => setTimeout(r, 40));
    ok(!btn11.classList.contains("is-dlerr"), "先确认基线：这一帧还是「下载中」（没有假红）");

    /* 推一帧失败：**没有 download 结构体**，源与原因只写在官方那句 message 里 */
    b11.pushed[0]({
      state: {
        providers: [
          {
            id: "sensevoice-local",
            name: "SenseVoiceSmall",
            downloadSources: ["https://huggingface.co", "https://hf-mirror.com"],
            preparation: {
              phase: "failed",
              resource: "model.int8.onnx",
              message: "Unable to prepare model.int8.onnx from https://huggingface.co: network (HTTP 503)",
            },
          },
        ],
        selection: { providerId: "sensevoice-local", language: "auto" },
      },
    });
    await new Promise((r) => setTimeout(r, 40));
    const st11 = V11._test.state();
    eqStr(st11.prep && st11.prep.phase, "failed", "推送帧收在 failed 上");
    ok(btn11.classList.contains("is-err"), "失败后按钮进错误态（.is-err）");
    ok(btn11.classList.contains("is-dlerr"), "失败是「下载那件事」→ 带 .is-dlerr（旧稿没有，看着像没事）");
    ok(!/\d+%/.test(btn11.textContent), "按钮不再停在百分比上", JSON.stringify(btn11.textContent));
    ok(/网络连不上下载源/.test(btn11.title), "tooltip 从 message 里认出了原因（网络连不上下载源）");
    ok(/huggingface\.co/.test(btn11.title), "tooltip 认出了下载源");
    ok(/HTTP 503/.test(btn11.title), "tooltip 带上了 HTTP 码");
    ok(/重新检查语音服务|下载 \/ 检查语音模型/.test(btn11.title), "tooltip 给出重试入口");
    ok(!/Unable to prepare/.test(btn11.title), "官方英文原文不进用户视野", JSON.stringify(btn11.title));
    ok(b11.toasted.some((t) => /网络连不上下载源/.test(t)), "失败也弹了一条能照做的提示", JSON.stringify(b11.toasted));

    /* 右键菜单与设置里那两行同样要长出「原因 + 源」（它们读的都是同一个失败态） */
    const menu11 = V11._test.menu();
    const flat11 = (el) => {
      const out = [el];
      for (const c of el.children || []) out.push(...flat11(c));
      return out;
    };
    const all11 = menu11 ? flat11(menu11) : [];
    const row11 = all11.find((x) => /(^|\s)gv-menu-status(\s|$)/.test(String(x.className || "")));
    ok(!!row11 && /上次失败/.test(String(row11.textContent)), "右键菜单长出「上次失败」行（旧稿只有一句通用说明）", row11 ? String(row11.textContent) : "缺");
    ok(!!row11 && /网络连不上下载源/.test(String(row11.textContent)) && /huggingface\.co/.test(String(row11.textContent)),
      "菜单那一行写出了原因与下载源");
    const sec11 = V11.settingsSection();
    const secAll11 = sec11 ? flat11(sec11) : [];
    const secLine11 = secAll11.find((x) => /(^|\s)gv-dl-line(\s|$)/.test(String(x.className || "")));
    ok(!!secLine11 && /上次下载失败/.test(String(secLine11.textContent)), "设置里那一行也写「上次下载失败：…」", secLine11 ? String(secLine11.textContent) : "缺");
    ok(!!secLine11 && /网络连不上下载源/.test(String(secLine11.textContent)), "设置那一行里有原因");
    const srcRow11 = secAll11.find((x) => /(^|\s)gv-dl-src(\s|$)/.test(String(x.className || "")));
    ok(!!srcRow11 && srcRow11.hidden === false, "失败时放出「换一个下载源」那一行");

    /* 点得通：菜单里那枚「重新检查语音服务」照样重发 prepare 并回到下载中 */
    const recheck11 = all11.find((x) => String(x.textContent || "") === "重新检查语音服务");
    prepareCalls11 = 0;
    if (recheck11 && typeof recheck11.onclick === "function") recheck11.onclick();
    await new Promise((r) => setTimeout(r, 120));
    ok(prepareCalls11 >= 1, "推送帧造成的失败一样点得通（重发 prepare 实测 " + prepareCalls11 + " 次）");
    eqStr((V11._test.state().prep || {}).phase, "downloading", "重试后回到下载中");
    ok(!btn11.classList.contains("is-dlerr"), "重试后下载错误标摘掉（不把旧失败挂在按钮上）");
  }

  console.log(
    failed
      ? "\n冒烟失败（见上面 ✗ 行）"
      : "\n全部通过：全局语音输入的三态、F1 按键纪律（吞键 / 不落字 / 不重复起停）、按钮恒态与载入弧、落点纪律、静音门与配置口径、停顿才整段提交（句长不封顶 / 只在后端硬顶切 / 尾部裁剪 / 浮窗报「正在听」）、模型未就绪时的自愈、下载失败时的「看得见 + 点得通」（原因 / 下载源 / 两枚重试入口 · state 回包与运行时推送两条入口都算）都钉住了（真实录音与识别精度需手动实测）",
  );
})();

/* ==================== 已并入：test/smoke-voice-mcp.js ==================== */
(function () {
  const __dirname = TEST_DIR;
  const __filename = TEST_DIR + "/" + "smoke-voice-mcp.js";
  const { fs, path, vm, os, spawn } = SHARED;
  const section = (name) => console.log("\n" + name);
  let fails = 0, checks = 0;
  const ok = (cond, msg) => { checks++; if (cond) console.log("  ok  " + msg); else { fails++; MERGED_FAILED = true; console.log("FAIL  " + msg); } };
  try {

  const fs = require("fs");
  const path = require("path");

  const ROOT = path.join(__dirname, "..");
  const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
  const ok = (cond, label) => {
    if (cond) {
      console.log("  ✓ " + label);
      return true;
    }
    console.log("  ✗ " + label);
    return false;
  };

  const CORDIS = read("dsh/gateway/cordis.yml");
  const GW = read("dsh/gateway/gateway.mjs");
  const SPEECH = read("dsh/gateway/speech-plugin.mjs");
  const MCPRES = read("dsh/gateway/mcp-resources.mjs");
  const MAIND = read("dsh/main-dsh.js");
  const MAIN = read("main.js");
  const PRELOAD = read("preload.js");
  const VOICE = read("renderer/app-voice.js");
  const VCSS = read("renderer/css/voice.css");
  const SETTINGS = read("renderer/app-settings.js");
  const MAINJS = read("renderer/app.js");
  const PLUGINS = read("renderer/app-plugins.js");
  const INDEX = read("renderer/index.html");
  const CSS = read("renderer/css/dsh.css");
  const I18N = read("renderer/i18n.js");

  console.log("[1] 网关组合：语音五行的接线");
  ok(/name: '@deepseek-ai\/dsh-experimental-speech-to-text'/.test(CORDIS), "四行之一：speech-to-text 行");
  ok(/name: '@deepseek-ai\/dsh-experimental-speech-to-text-sensevoice'/.test(CORDIS), "四行之一：sensevoice 提供者行");
  ok(/defaultProvider: sensevoice-local/.test(CORDIS), "speech-to-text 指定默认提供者 sensevoice-local");
  ok(/dataRoot: !!js dshHomePath\('speech-to-text', 'sensevoice'\)/.test(CORDIS), "权重落 DSH_HOME（不落应用目录）");
  ok(/name: '@deepseek-ai\/dsh-experimental-api-speech-to-text'/.test(CORDIS), "四行之一：api-speech-to-text 行");
  ok(/name: '@deepseek-ai\/dsh-experimental-client-ui-voice-input'/.test(CORDIS), "四行之一：上游 UI 行（照官方组合原样挂）");
  ok(/id: mtnode-speech[\s\S]{0,120}name: '\.\/speech-plugin\.mjs'/.test(CORDIS), "MTNode 自己的 mtnode-speech 行");
  {
    const iSpeech = CORDIS.indexOf("id: mtnode-speech");
    const iUser = CORDIS.indexOf("本行以下 = 用户插件段");
    ok(iSpeech > 0 && iUser > 0 && iSpeech < iUser, "shipped 行排在用户插件段之前（否则会被当用户行搬走）");
  }
  ok(/MTNODE_CHAT_ISOLATE === '1'/.test(CORDIS.slice(CORDIS.indexOf("语音输入（dsh 0.2 官方四行"))), "BongoChat 隔离态不挂语音行");

  console.log("[2] 网关：本地协议方法 + 握手顺序");
  ok(/case 'speech': \{/.test(GW), "本地协议方法 speech 分发存在");
  ok(/async function handleSpeech\(/.test(GW), "handleSpeech 实现存在");
  ok(/MTNODE_SPEECH_PORT/.test(GW) && /MTNODE_SPEECH_TOKEN/.test(GW), "端口与令牌随 spawn 注入");
  ok(/speech-hello/.test(GW) && /token-match/.test(GW), "网关按首帧 speech-hello 认这条 socket");
  ok(/registerSpeechSocket\(key, s\)/.test(GW) && /unregisterSpeechSocket\(key, s\)/.test(GW), "登记与回收成对");
  ok(/type: 'speech-state'/.test(GW), "准备状态以事件 speech-state 回流宿主");
  {
    const iHello = SPEECH.indexOf("s.write(JSON.stringify({ t: 'speech-hello'");
    const iFollow = SPEECH.indexOf("startFollow()", iHello);
    ok(iHello > 0 && iFollow > iHello, "插件先发 hello 再开 follow（顺序反了通道永远未就绪）");
  }
  ok(/ctx\.speechToText\.resolve\(/.test(SPEECH) && /ctx\.speechToText\.transcribe\(/.test(SPEECH), "转写走官方 resolve + transcribe");
  ok(/validateWave|16 kHz|16kHz/.test(SPEECH) || /16 kHz/.test(SPEECH), "音频契约写明 16 kHz 单声道 PCM16");

  console.log("[3] 主进程与 preload：语音通道贯通");
  ok(/speech\(params\) \{/.test(MAIND) && /request\('speech'/.test(MAIND), "main-dsh 的 speech()");
  ok(/ipcMain\.handle\("dsh:speech"/.test(MAIN), "main.js 的 dsh:speech");
  ok(/dshSpeech: \(params\) => ipcRenderer\.invoke\('dsh:speech'/.test(PRELOAD), "preload 的 dshSpeech");
  ok(/onSpeechState: \(cb\)/.test(PRELOAD) && /'speech-state'/.test(PRELOAD), "preload 的 onSpeechState");

  console.log("[4] 麦克风权限：只放行 media，且两个 handler 都装");
  ok(/setPermissionRequestHandler/.test(MAIN), "setPermissionRequestHandler 存在");
  ok(/setPermissionCheckHandler/.test(MAIN), "setPermissionCheckHandler 存在");
  ok(/MEDIA_PERMISSIONS = new Set\(\["media"/.test(MAIN), "白名单以 media 起头");
  ok(/isLocalPage/.test(MAIN) && /https\?/i.test(MAIN), "只认本机页面（http(s) 不放行）");
  ok(!/setPermissionRequestHandler\(\([^)]*\)\s*=>\s*\{?\s*callback\(true\)/.test(MAIN), "没有无条件 callback(true) 式的整放开");

  console.log("[5] 渲染层：录音键与产物");
  ok(fs.existsSync(path.join(ROOT, "renderer/app-voice.js")), "renderer/app-voice.js 存在");
  ok(/<script src="app-voice\.js"><\/script>/.test(INDEX), "index.html 载入 app-voice.js");
  ok(/createAnalyser/.test(VOICE) && /getFloatTimeDomainData/.test(VOICE), "实时抽 PCM 帧走 AudioContext + AnalyserNode");
  ok(/encodeWav16kMono/.test(VOICE) && /resampleTo16k/.test(VOICE), "重采样成 16 kHz 单声道 PCM16 WAV");
  ok(/execCommand\("insertText"/.test(VOICE), "定稿走 execCommand(\"insertText\")（保留撤销栈语义）");
  ok(/"btnVoiceGlobal"/.test(VOICE) && /id="btnVoiceGlobal"/.test(INDEX), "按钮 id 在模块与 index.html 之间对齐");
  ok(!/"agentVoice"|"assistVoice"/.test(VOICE), "两枚旧输入框话筒 id 已移除");
  ok(/getUserMedia/.test(VOICE), "采集走 navigator.mediaDevices.getUserMedia");
  ok(!/MediaRecorder/.test(VOICE), "不再用 MediaRecorder（AudioContext 直取 PCM 帧，少一层容器转码）");
  /* 按键转录键：F1 无字符，天然不会被录进输入框；源码里不再留反引号吞键表 */
  ok(/const PTT_KEY = "F1"/.test(VOICE), '按键转录键钉成 F1（const PTT_KEY = "F1"）');
  ok(!/PTT_KEY\s*=\s*`/.test(VOICE), "PTT_KEY 不再指向反引号那类字符键");
  ok(VOICE.indexOf("按住 `") < 0, "源码里不再有「按住 ` …」这类反引号按键文案");
  /* 按钮绘制：载入态走 CSS 旋转弧（gv-spin），呼吸类不因逐帧摘挂而抖 */
  ok(/@keyframes gv-spin/.test(VCSS), "载入弧的 keyframes gv-spin 在 css/voice.css 里");
  ok(/\.sb-voice\.is-loading::before/.test(VCSS) && /animation:\s*gv-spin/.test(VCSS), "is-loading 用 ::before 画旋转弧（纯 CSS，不写文字）");
  ok(/\.sb-voice\.is-mic\s*\{[^}]*animation:\s*gv-mic-pulse/s.test(VCSS), ".is-mic 呼吸动画有稳定宿主（恒定态不逐帧摘挂）");
  {
    const iMic = VOICE.indexOf('classList.toggle("is-mic"');
    const stmt = iMic < 0 ? "" : VOICE.slice(iMic, iMic + 400);
    ok(iMic > 0 && /classList\.toggle\("is-mic",\s*on\)/.test(stmt), "is-mic 判据取 paint 里的常量 on（每帧同值）");
    ok(/const on = state\.mode !== MODE_OFF/.test(VOICE), "on 只看模式（不含每帧都变的 stream / pttOn → 不会造成 class 抖动）");
    ok(!/classList\.toggle\("is-mic",[^)]*(stream|pttOn)/.test(VOICE), "is-mic 判据里没有 stream / pttOn 这类逐帧量");
    const iTxt = VOICE.indexOf("b.textContent = downloading");
    ok(iTxt > 0 && VOICE.slice(iTxt, VOICE.indexOf("b.title =", iTxt)).indexOf("…") < 0, "载入态不再用省略号字面（弧由 CSS 画）");
  }
  ok(/callReady\("transcribe"/.test(VOICE), "转写走 callReady(\"transcribe\")（就绪重试的唯一出口）");
  ok(/ensurePrepared/.test(VOICE) && /callReady\("prepare"/.test(VOICE), "首次使用自动发起 prepare（下载权重，同样过 callReady）");
  ok(/onSpeechState/.test(VOICE), "订阅准备进度 speech-state");
  ok(/canvasTick/.test(VOICE) && /VoiceInput\.canvasTick/.test(MAINJS), "切画布清理钩子：模块导出 + app.js 的 applyTransform 调用");
  ok(/\.sb-voice/.test(VCSS) && /order:\s*-2/.test(VCSS), "状态栏按钮钉在最左（order:-2）");
  ok(/\.gv-note\b/.test(VCSS) && /pointer-events:\s*none/.test(VCSS), "转写浮窗样式齐备且不吃鼠标（不抢焦点）");
  ok(/\.gv-note\.is-err/.test(VCSS) && /gv-mic-pulse/.test(VCSS), "错误态与采集呼吸动画齐备");
  ok(/@import url\("\.\/css\/voice\.css"\)/.test(read("renderer/style.css")), "style.css 串入 css/voice.css");
  ok(/"语音输入（关闭）：点一下开启持续转录，再点按键转录，再点关闭"/.test(I18N), "i18n 有三态按钮词条");
  ok(/settings-sec-title/.test(VOICE) && /VoiceInput\.settingsSection\(\)/.test(SETTINGS), "设置面板挂上「语音输入」小节（.settings-sec-title + 模块提供的整块）");

  console.log("[6] 与既有本地 ASR 的分工（节点级转写仍归 renderer/app-asr.js）");
  ok(fs.existsSync(path.join(ROOT, "renderer/app-asr.js")), "renderer/app-asr.js 仍在（节点级批量转写）");
  ok(fs.existsSync(path.join(ROOT, "test/smoke-asr.js")), "test/smoke-asr.js 仍在");
  /* 旧的 asr/ 主进程后端（Qwen3-ASR 那套）已按新链路整块删除，见 test/smoke-asr.js
     的「asr/ 主进程模块已删除」；这里跟着改成同口径，不再要求那个目录还在。 */
  ok(!fs.existsSync(path.join(ROOT, "asr")), "asr/ 旧后端目录已删除（识别统一走 dsh 运行时的 SenseVoice）");
  ok(!/app-asr/.test(VOICE), "语音输入模块不碰 ASR 节点实现");
  ok(!/asr-pack/.test(CORDIS), "cordis 组合不动 ASR 后端");

  console.log("[7] MCP 资源面：只读、惰性、可回收");
  ok(/handleMcpResources/.test(MCPRES) && /export async function handleMcpResources/.test(MCPRES), "mcp-resources.mjs 导出处理函数");
  ok(/resources\/list/.test(MCPRES) && /listResources\(\)/.test(MCPRES), "只发 resources/list");
  ok(/client\.readResource\(/.test(MCPRES), "读取只走 readResource");
  ok(!/callTool|tools\/call/.test(MCPRES), "绝不调用服务器工具");
  ok(/IDLE_MS = 60_000/.test(MCPRES), "连接 60 秒空闲回收");
  ok(/export function closeMcpResources/.test(MCPRES), "有显式回收入口");
  ok(/closeMcpResources\(\)/.test(GW), "网关 shutdown 时收掉连接");
  ok(/case 'mcpResources': \{/.test(GW), "本地协议方法 mcpResources");
  ok(/import \{ handleMcpResources, closeMcpResources \} from '\.\/mcp-resources\.mjs'/.test(GW), "网关 import 该模块（不是复制一份实现）");
  ok(/mcpResources\(params\) \{/.test(MAIND) && /request\('mcpResources'/.test(MAIND), "main-dsh 的 mcpResources()");
  ok(/ipcMain\.handle\("dsh:mcpResources"/.test(MAIN), "main.js 的 dsh:mcpResources");
  ok(/dshMcpResources: \(params\) => ipcRenderer\.invoke\('dsh:mcpResources'/.test(PRELOAD), "preload 的 dshMcpResources");
  ok(/function extMcpResourcesPanel/.test(PLUGINS), "MCP 详情里的资源面板存在");
  ok(/extMcpResourcesPanel\(info, s\)/.test(PLUGINS), "面板挂在 renderExtMcpInfo 上");
  ok(/读取资源清单/.test(PLUGINS), "惰性触发：点「读取资源清单」才连服务器");
  ok(/\.dsh-mcp-res\b/.test(CSS) && /\.dsh-mcp-res-body/.test(CSS), "资源面板样式齐备");
  ok(/"读取资源清单"/.test(I18N), "i18n 有 MCP 资源词条");

  console.log("[8] 打包白名单（根目录主进程模块）");
  {
    const B = read("build.json");
    ok(/"dsh\/main-dsh\.js"/.test(B), "build.json 里有 dsh/main-dsh.js");
    ok(/"preload\.js"/.test(B) || /preload/.test(B), "build.json 覆盖 preload.js");
    ok(/"renderer\/\*\*"/.test(B), "renderer/** 通配（app-voice.js 自动随包）");
  }

  console.log(
    fails
      ? "\n冒烟失败（见上面 FAIL 行）"
      : "\n全部通过：语音输入与 MCP 资源面的接线口径完整（真实录音与真实 MCP 服务器需手动实测）",
  );

  } catch (e) {
    MERGED_FAILED = true;
    console.log("FAIL  [合并块异常] smoke-voice-mcp.js：" + (e && e.stack ? e.stack : e));
  }
  if (fails) console.log("  ── 已并入块 smoke-voice-mcp.js：" + fails + " / " + checks + " 项失败");
})();

/* 收尾：正文与并入块任一失败都算这只红；退出码只在**全部跑完**之后才定。
   ⚠ 历史坑（本轮修）：正文那一段是 async 的（真喂帧 / 真等转写回包），早先这里
   直接 process.exit 会把「[4] 之后的整段正文」当场掐掉 —— 表现是这只测试看起来
   只跑到 [3] 就结束、后面的断言一条都没跑（静默半跑，最难发现的那种）。
   所以必须先 await 正文那一只，再定退出码。 */
VOICE_SUITE.then(
  () => {
    const bad = MERGED_FAILED || failed > 0;
    if (bad) console.log("\n✗ 本文件有失败项（含已并入块）：" + failed + " 项正文 / " + (MERGED_FAILED ? "并入块有红" : "并入块全绿") + "\n");
    process.exit(bad ? 1 : 0);
  },
  (e) => {
    console.log("FAIL  [正文块异常] smoke-global-voice.js：" + (e && e.stack ? e.stack : e));
    process.exit(1);
  },
);
