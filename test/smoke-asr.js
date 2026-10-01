/* 本地语音转写（官方本地 SenseVoice）—— 链路级冒烟测试（纯 Node）
 *
 * 覆盖（识别统一到 dsh 运行时之后的新链路）：
 *   speech-store.js            主进程小内核：按音频签名缓存文本 / 人工修订优先 / 清理 / 音频读盘上限
 *   renderer/app-speech.js     任意音频 → 解码 / 重采样 16k 单声道 / **按短停顿逐句切** →
 *                              WAV → base64 → dsh 语音通道（每句一次识别、文本每句一行）
 *                              （真跑 encodeWav16kMono / spResampleTo16k / spSentenceSpans /
 *                                spLineText / spJoinInline / spTranscribeFile）
 *   renderer/app-asr.js        转写归音频 / 视频节点：转录按钮与文本区、文件指纹新鲜度、
 *                              文字节点运行前闸门、下游取文、旧字段清理
 *   renderer/app.js            钩子接线（allTextItems / resolveRefs.addText）+ 旧字段清理入口
 *   renderer/app-nodes.js      运行前闸门（失败即中止本轮）+ 会话模式补转写段
 *   renderer/app-canvas.js     音频 / 视频节点 body 的「转录」按钮与转录块
 *   preload.js / preload-app.js 桥的白名单：dshSpeech / dshSpeechState / speechCache* 与应用侧 asr*
 *   apps-store.js              应用窗口的语音通道（选音频 / 转写 / 状态 / 首次下载）+ 路径纪律
 *   语音现况读取必须带 workspace  真网关的 `speech` 方法按 workspace 挑（必要时现拉起）那台运行时，
 *                              不带就一律回「缺少 workspace」；而相位会把这个错误回包当成
 *                              「引擎还在冷起」→ 节点转写永远停在「正在启动」（本轮修的真机 bug）。
 *                              桩必须照实校验 workspace，否则这条链路在冒烟里看不见。
 *   renderer/app-plugins.js / app-repair.js  不再有 asr-local 卡片与它的安装 / 控制台分支
 *   asr/ asr-pack/ skills/asr-local-install/ 已删除，build.json 与插件目录不再引用
 *
 * 不测（要真机与真音频）：真实录音、识别精度、真实 dsh 运行时下载权重。
 */
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const os = require("os");

const ROOT = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const exists = (p) => fs.existsSync(path.join(ROOT, p));

let pass = 0;
let fail = 0;
const fails = [];
function ok(cond, msg) {
  if (cond) {
    pass++;
    console.log("  ✓ " + msg);
  } else {
    fail++;
    fails.push(msg);
    console.log("  ✗ " + msg);
  }
}
function eqStr(a, b, msg) {
  ok(String(a) === String(b), msg + (String(a) === String(b) ? "" : `（得到 ${JSON.stringify(a)}）`));
}

console.log("smoke-asr：本地语音转写（官方本地 SenseVoice）链路\n");

/* app-speech.js 的沙箱：假语音通道（认 16k 单声道 PCM16 WAV 契约）+ 假 WebAudio 解码 */
function makeSpeechBox(o) {
  o = o || {};
  const calls = [];
  const cacheGetCalls = [];
  const cacheSetCalls = [];
  const cache = o.cache || {};
  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    btoa: (s) => Buffer.from(s, "binary").toString("base64"),
    atob: (s) => Buffer.from(s, "base64").toString("binary"),
    I18n: { t: (s) => s },
    S: { wf: { id: "wf-a", workspace: "E:\\dev\\tmp-smoke" } },
    window: {
      api: {
        dshSpeech: async (params) => {
          calls.push(params);
          if (params.action === "prepare") return { ok: true, providers: [] };
          if (params.action !== "transcribe") return { ok: true, providers: [] };
          if (!params.workspace) return { ok: false, error: "缺少 workspace：语音输入要绑定一台工作区运行时" };
          if (o.badAudio) return { ok: false, error: "unsupported wav" };
          const buf = Buffer.from(String(params.audio || ""), "base64");
          return { ok: true, text: "[frame " + buf.length + "]", audioSeconds: Math.round((buf.length - 44) / 32000) };
        },
        /* 与真网关同口径：`speech` 方法按 workspace 挑（必要时现拉起）那台语音运行时，
           **不带 workspace 就一律回「缺少 workspace」**。这个校验必须在桩里照实做 ——
           之前的桩把参数整个忽略，于是真机上「状态读取漏带 workspace」这个 bug（节点转写
           的引擎闸门把错误回包当成「引擎还在冷起」，永远停在「正在启动」）在冒烟里一路绿灯。 */
        dshSpeechState: async (params) => {
          calls.push(Object.assign({ action: "state" }, params || {}));
          if (!params || !String(params.workspace || "").trim())
            return { ok: false, error: "缺少 workspace：语音输入要绑定一台工作区运行时" };
          return {
            providers: [
              {
                id: "sv",
                name: "SenseVoice",
                preparation: { phase: o.phase || "ready", completedBytes: 0, totalBytes: 0 },
              },
            ],
            selection: { providerId: "sv", language: "" },
          };
        },
        fileReadAudioBytes: async () => {
          if (o.readFail) return { ok: false, error: "missing" };
          if (o.tooBig) return { ok: true, tooBig: true, sizeHuman: "2.0 GB" };
          const p = o.audioPath || path.join(os.tmpdir(), "nope");
          return { ok: true, bytes: fs.readFileSync(p), size: fs.statSync(p).size };
        },
        speechCacheGet: async (p) => {
          cacheGetCalls.push(p);
          return cache[String(p.path)] ? Object.assign({ ok: true }, cache[String(p.path)]) : { ok: false, error: "miss" };
        },
        speechCacheSet: async (p) => {
          cacheSetCalls.push(p);
          cache[String(p.path)] = { text: p.text, edited: !!p.edited };
          return { ok: true };
        },
        speechCacheClear: async () => {
          for (const k of Object.keys(cache)) delete cache[k];
          return { ok: true };
        },
      },
      /* 假 WebAudio：解码结果由这里给出（真解码在渲染层）。默认 = 0.5 秒 44.1k 单声道正弦；
         o.pattern（[[幅值, 毫秒], …]）可以造出「说话 → 停顿 → 说话」的现场，用来验证逐句切分。 */
      AudioContext: class {
        constructor() {
          this.sampleRate = 44100;
        }
        async decodeAudioData() {
          const pat = Array.isArray(o.pattern) && o.pattern.length ? o.pattern : [[0.5, 500]];
          let n = 0;
          for (const step of pat) n += Math.round(((Number(step[1]) || 0) / 1000) * 44100);
          const ch = new Float32Array(n);
          let off = 0;
          for (const step of pat) {
            const amp = Number(step[0]) || 0;
            const c = Math.round(((Number(step[1]) || 0) / 1000) * 44100);
            for (let i = 0; i < c; i++) ch[off + i] = Math.sin((i / 44100) * 2 * Math.PI * 440) * amp;
            off += c;
          }
          return { sampleRate: 44100, length: n, numberOfChannels: 1, duration: n / 44100, getChannelData: () => ch };
        }
        close() {}
      },
    },
  };
  sandbox.window.window = sandbox.window;
  sandbox.self = sandbox.window;
  const ctx = vm.createContext(sandbox);
  vm.runInContext(read("renderer/app-speech.js"), ctx, { filename: "renderer/app-speech.js" });
  return { ctx, sandbox, calls, cache, cacheGetCalls, cacheSetCalls };
}

(async () => {
  /* ════════════════ [1] speech-store.js：缓存与音频读盘 ════════════════ */
  console.log("[1] speech-store.js 真跑（缓存键 / 人工修订优先 / 清理 / 读盘上限）");
  {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mtnode-speech-"));
    /* speech-store.js 顶部 require("electron")：纯 Node 里补一个 ipcMain 桩，
       再 registerSpeechIpc 把数据目录指到临时目录 —— **绝不写应用目录**（见 AGENTS.md）。 */
    const Module = require("module");
    const origLoad = Module._load;
    Module._load = function (req, parent, isMain) {
      if (req === "electron") return { ipcMain: { handle() {} } };
      return origLoad.call(this, req, parent, isMain);
    };
    let speech = null;
    const speechPath = path.join(ROOT, "speech-store.js");
    delete require.cache[require.resolve(speechPath)];
    try {
      speech = require(speechPath);
    } finally {
      Module._load = origLoad;
    }
    speech.registerSpeechIpc({ getDataDir: () => tmp });
    const audio = path.join(tmp, "rec1.wav");
    fs.writeFileSync(audio, Buffer.alloc(64, 7));

    const miss = await speech.cacheGet({ path: audio });
    ok(miss && miss.ok === false && miss.error === "miss", "没有缓存时回 miss（不编造文本）");

    await speech.cacheSet({ path: audio, text: "第一版", segments: 2, duration_sec: 12 });
    const hit = await speech.cacheGet({ path: audio });
    ok(hit.ok && hit.text === "第一版", "写入后命中：文本原样回来");
    eqStr(hit.segments, 2, "段数也存下来（界面显示用）");

    /* 切分口径进缓存键：换「断句停顿」阈值 = 换口径 → 旧文本不再命中（本轮口径切换靠它作废） */
    ok(/^sentence-pause-/.test(String(speech.SEG_TAG)), "切分口径指纹 SEG_TAG 在（缓存键的一部分）· " + speech.SEG_TAG);
    await speech.cacheSet({ path: audio, text: "按 300ms 切的", pauseMs: 300 });
    const hit300 = await speech.cacheGet({ path: audio, pauseMs: 300 });
    ok(hit300.ok && hit300.text === "按 300ms 切的", "同一阈值下命中");
    const hit500 = await speech.cacheGet({ path: audio, pauseMs: 500 });
    ok(hit500.ok === false, "阈值改成 500ms → 不再命中旧文本（改设置即换口径）");

    await speech.cacheSet({ path: audio, text: "我改过的", edited: true });
    await speech.cacheSet({ path: audio, text: "自动重跑的结果" });
    const keep = await speech.cacheGet({ path: audio });
    ok(keep.text === "我改过的", "人工修订优先：自动转写不再覆盖 edited 文本");

    fs.writeFileSync(audio, Buffer.alloc(128, 9));
    const stale = await speech.cacheGet({ path: audio });
    ok(stale.ok === false, "音频文件变了（签名变）→ 不沿用旧转写");

    await speech.cacheSet({ path: audio, text: "新一版" });
    const cleared = await speech.cacheClear({ path: audio });
    ok(cleared.ok && cleared.cleared >= 1, "按路径清理：同一音频的旧版一并清掉");
    ok((await speech.cacheGet({ path: audio })).ok === false, "清理后回到 miss");

    const r1 = speech.readAudioBytes(audio, 1 << 20);
    ok(r1.ok && r1.bytes && r1.bytes.length === 128, "readAudioBytes 读回原始字节（只读，不写盘）");
    const r2 = speech.readAudioBytes(path.join(tmp, "nope.wav"), 1 << 20);
    ok(r2.ok === false && r2.error === "missing", "文件不存在 → missing（不抛异常）");
    const r3 = speech.readAudioBytes(audio, 1024);
    ok(r3.ok === true && !r3.tooBig, "小于 1MB 的文件给再小的上限也不截断（上限有 1MB 地板）");
    const r4 = speech.readAudioBytes(audio, 1 << 10 << 10);
    ok(r4.ok === true && r4.tooBig !== true, "正好 1MB 的文件能整份读回（长录音也走得通）");

    const list = speech.cacheList();
    ok(list.ok && Array.isArray(list.entries), "cacheList 只读概况（设置 / 诊断可用）");

    fs.rmSync(tmp, { recursive: true, force: true });
  }

  /* ════════════════ [2] app-speech.js：整形与真跑 ════════════════ */
  console.log("\n[2] app-speech.js 真跑（WAV 头 / 重采样 / 分段 / 真解真发 / 缓存 / 失败路径）");
  {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mtnode-speech2-"));
    const audioPath = path.join(tmp, "voice.wav");
    fs.writeFileSync(audioPath, Buffer.alloc(2048, 3));
    const box = makeSpeechBox({ audioPath });
    const run = (code) => vm.runInContext(code, box.ctx);

    /* WAV 头：44 字节标准头 + 样本原样 */
    const wav = run("encodeWav16kMono")(new Int16Array([0, 16383, -16384]));
    eqStr(wav.length, 44 + 3 * 2, "WAV 长度 = 44 + 样本数×2");
    eqStr(String.fromCharCode(wav[0], wav[1], wav[2], wav[3]), "RIFF", "RIFF 魔数");
    eqStr(String.fromCharCode(wav[8], wav[9], wav[10], wav[11]), "WAVE", "WAVE 标识");
    {
      const dv = new DataView(wav.buffer);
      eqStr(dv.getUint16(20, true), 1, "PCM 编码");
      eqStr(dv.getUint16(22, true), 1, "单声道（SenseVoice 只收单声道）");
      eqStr(dv.getUint32(24, true), 16000, "采样率 16 kHz（SenseVoice 的唯一口径）");
      eqStr(dv.getUint16(34, true), 16, "位深 16");
      eqStr(dv.getInt16(44, true), 0, "首样本没被头吃掉");
      eqStr(dv.getInt16(46, true), 16383, "第二样本原样");
    }

    /* 重采样与切片 */
    const f = new Float32Array(44100);
    for (let i = 0; i < f.length; i++) f[i] = i % 2 ? 0.5 : -0.5;
    const pcm = run("spResampleTo16k")(f, 44100);
    eqStr(pcm.length, 16000, "44.1k → 16k：样本数按比例");
    ok(Math.abs(pcm[0]) === 16384 || Math.abs(pcm[0]) === 16383, "重采样后幅值仍在 0.5 档（±0.5→±16384）");
    const same = run("spResampleTo16k")(new Float32Array(16000).fill(0.25), 16000);
    eqStr(same.length, 16000, "已经是 16k 时不做二次重采样");
    const clip = run("spFloatToPcm16")(new Float32Array([2, -2]));
    eqStr(clip[0], 32767, "越界样本夹住（不回绕）");
    eqStr(clip[1], -32768, "负向越界同样夹住");
    /* 逐句切分（本轮口径）：不再有 spSegments 那种定长切片 */
    ok(read("renderer/app-speech.js").indexOf("function spSegments") < 0, "定长切片 spSegments 已撤（不再按 60 秒切）");
    const mkPcm = (steps) => {
      const sr = 16000;
      let n = 0;
      for (const s of steps) n += Math.round((s[1] / 1000) * sr);
      const p = new Int16Array(n);
      let off = 0;
      for (const s of steps) {
        const c = Math.round((s[1] / 1000) * sr);
        for (let i = 0; i < c; i++) {
          p[off + i] = Math.round((s[0] ? 0.4 : 0.005) * 32767 * Math.sin(i * 0.3));
        }
        off += c;
      }
      return p;
    };
    /* 说话 600ms → 静音 400ms（>300ms 停顿）→ 说话 500ms → 静音 800ms：切出两句 */
    const spans = run("spSentenceSpans")(mkPcm([[1, 600], [0, 400], [1, 500], [0, 800]]), { pauseMs: 300 });
    eqStr(spans.length, 2, "按 300ms 短停顿逐句切：两句话 → 2 片");
    ok(spans[0].cont === false && spans[1].cont === false, "两句都是独立的句子（不是硬顶切出来的续片）");
    ok(
      spans[0].end > Math.round(16000 * 0.6) &&
        spans[0].end < Math.round(16000 * 1.0) &&
        spans[1].start > spans[0].end &&
        spans[1].start < Math.round(16000 * 1.0),
      "切点落在那一处停顿里（第一句在静音中收尾，第二句带前卷从静音里起）· " +
        JSON.stringify(spans.map((s) => [s.start, s.end])),
    );
    /* 停顿阈值：把阈值调到比这处停顿还长（900ms）→ 不再断句，整段就是一句 */
    const spans1 = run("spSentenceSpans")(mkPcm([[1, 600], [0, 400], [1, 500], [0, 800]]), { pauseMs: 900 });
    eqStr(spans1.length, 1, "阈值改成 900ms 后同一段音频不再断句（阈值真的生效）");
    /* 平均句长 100ms、停顿 100ms（不足停顿）→ 同一句；插一个 400ms 停顿 → 断成两句 */
    const spans2 = run("spSentenceSpans")(mkPcm([[1, 100], [0, 100], [1, 100], [0, 100], [1, 100], [0, 400], [1, 300], [0, 600]]), { pauseMs: 300 });
    eqStr(spans2.length, 2, "句内短停顿（100ms）不断句，只有够长的停顿才断（2 句）");
    /* 硬顶：一句 5 秒不停顿（句内只有 100ms 的小凹陷），hardSec=2 → 切成多片、续片 cont=true */
    const longSteps = [];
    for (let i = 0; i < 10; i++) longSteps.push([1, 400], [0, 100]);
    const hardSpans = run("spSentenceSpans")(mkPcm(longSteps), { pauseMs: 300, hardSec: 2 });
    ok(hardSpans.length >= 2, "撞硬顶会被切开（不再限制长度，但后端 ≈131 秒的硬顶绕不过去）· " + hardSpans.length + " 片");
    ok(
      hardSpans.slice(1).every((s) => s.cont === true),
      "硬顶切出来的续片 cont=true（文本要与前半句并成同一行，不是另起一句）",
    );
    ok(
      hardSpans.every((s) => (s.end - s.start) / 16000 <= 2.05),
      "每一片都在硬顶之内（没有超过 hardSec 的片）",
    );
    ok(run("spHardCapMs")() >= 120000, "默认硬顶 ≥120 秒（后端 4 MiB ÷ 32KB/s ≈ 131s）");
    eqStr(run("spPauseMs")(), 300, "没配过时「断句停顿」默认 300ms");
    {
      const boxCfg = makeSpeechBox({ audioPath });
      boxCfg.sandbox.S.config = { voice: { silenceMs: 500 } };
      eqStr(vm.runInContext("spPauseMs", boxCfg.ctx)(), 500, "阈值读的是全局设置里的那一份（S.config.voice.silenceMs）");
      boxCfg.sandbox.S.config = { voice: { silenceMs: 5 } };
      eqStr(vm.runInContext("spPauseMs", boxCfg.ctx)(), 100, "低于下限夹到 100ms");
      boxCfg.sandbox.S.config = { voice: { silenceMs: 99999 } };
      eqStr(vm.runInContext("spPauseMs", boxCfg.ctx)(), 2000, "高于上限夹到 2000ms");
    }
    /* 行末标点与续片拼接 */
    eqStr(run("spLineText")("你好"), "你好。", "行末没有标点 → 补句号");
    eqStr(run("spLineText")("你好，"), "你好。", "行末是逗号（没说完）→ 换成句号");
    eqStr(run("spLineText")("你好。"), "你好。", "已经是句末标点 → 不动");
    eqStr(run("spLineText")("hello!"), "hello!", "英文句末标点同样不动");
    eqStr(run("spJoinInline")("hello", "world"), "hello world", "续片拼接：英文补一个空格");
    eqStr(run("spJoinInline")("你好", "世界"), "你好世界", "续片拼接：中文直接接（不塞空格）");

    /* 真跑：读盘 → 解码 → 切片 → 编码 → base64 → 假通道 */
    const out = await run("spTranscribeFile")(audioPath, { language: "zh" });
    ok(out.ok === true, "spTranscribeFile 走通（真读盘 → 真解码 → 真发帧）");
    const trCalls = box.calls.filter((c) => c.action === "transcribe");
    eqStr(trCalls.length, 1, "0.5 秒整段就是一句 → 只发一次转写请求");
    eqStr(out.segments, 1, "segments 现在 = 句数（1 句）");
    eqStr(trCalls[0].workspace, "E:\\dev\\tmp-smoke", "带上工作区（语音运行时按 workspace 记账）");
    eqStr(trCalls[0].language, "zh", "语言随调用下发");
    ok(/^[A-Za-z0-9+/=]+$/.test(trCalls[0].audio), "音频是纯 base64（不带 data: 前缀）");
    {
      const buf = Buffer.from(trCalls[0].audio, "base64");
      eqStr(buf.readUInt32LE(24), 16000, "真发出去的 WAV 是 16 kHz（重采样确实生效）");
      eqStr(buf.readUInt16LE(22), 1, "真发出去的 WAV 是单声道");
    }
    ok(!!out.text, "回了文本");
    ok(/。$/.test(out.text), "行末补了句末标点（识别不给标点时也像个句子）· " + JSON.stringify(out.text));

    /* 逐句一片 / 每句一行：造「说话 600ms → 停顿 400ms → 说话 500ms → 静音」的真现场 */
    {
      const box2 = makeSpeechBox({ audioPath, pattern: [[0.5, 600], [0.002, 400], [0.5, 500], [0.002, 800]] });
      const run2 = (code) => vm.runInContext(code, box2.ctx);
      const out2 = await run2("spTranscribeFile")(audioPath, { language: "zh" });
      const calls2 = box2.calls.filter((c) => c.action === "transcribe");
      eqStr(out2.ok, true, "两句话的音频照常走通");
      eqStr(calls2.length, 2, "两句话 → 两次识别调用（一句一片，不再按 60 秒切）");
      eqStr(out2.segments, 2, "segments = 2 句");
      const lines = String(out2.text).split("\n");
      eqStr(lines.length, 2, "转写文本每句一行（换行拼接）· " + JSON.stringify(out2.text));
      ok(
        lines.every((l) => /。$/.test(l)),
        "每一行行末都有句末标点 · " + JSON.stringify(lines),
      );
      const sizes = calls2.map((c) => Buffer.from(c.audio, "base64").length);
      ok(
        sizes.every((b) => b > 44 && b < 32000 * 2),
        "每次发的都是「一句」那一小段（不是整段 60 秒）· " + JSON.stringify(sizes),
      );
    }

    /* 缓存：第二次不再发帧（force 才重发） */
    const before = box.calls.filter((c) => c.action === "transcribe").length;
    const again = await run("spTranscribeFile")(audioPath, { language: "zh" });
    ok(again.ok === true && again.cached === true, "第二次命中缓存（cached=true）");
    eqStr(box.calls.filter((c) => c.action === "transcribe").length, before, "命中缓存不再调用识别");
    /* 读与写必须带同一个口径键（阈值）：只给读带、不给写带的话，
       人工修订写进去的「无阈值」那条以后再也读不回来（本处回归钉住）。 */
    ok(
      box.cacheGetCalls.length > 0 && box.cacheGetCalls.every((c) => c.pauseMs === 300),
      "缓存读带上了当前「断句停顿」阈值（默认 300ms）· " + JSON.stringify(box.cacheGetCalls.map((c) => c.pauseMs)),
    );
    ok(
      box.cacheSetCalls.length > 0 && box.cacheSetCalls.every((c) => c.pauseMs === 300),
      "缓存写同样带阈值（写在同一个键上）· " + JSON.stringify(box.cacheSetCalls.map((c) => c.pauseMs)),
    );
    const forced = await run("spTranscribeFile")(audioPath, { language: "zh", force: true });
    ok(forced.ok === true && forced.cached === false, "force=true 时绕过缓存重新识别");
    ok(box.calls.filter((c) => c.action === "transcribe").length > before, "force 时真的又发了帧");

    /* 人工修订：写回缓存并标 edited */
    await run("spRememberEdited")(audioPath, "我改过的错字", "zh");
    const edited = await run("spTranscribeFile")(audioPath, { language: "zh" });
    eqStr(edited.text, "我改过的错字", "人工修订写回缓存（自动转写不再覆盖）");
    ok(edited.edited === true, "修订标记 edited 一起回来");

    /* 清缓存 + 失败路径 */
    await run("spCacheClear")(audioPath);
    ok((await run("spTranscribeFile")(audioPath, { language: "zh" })).ok === true, "清缓存后仍能重转（走真通道）");

    const bad = makeSpeechBox({ audioPath, badAudio: true });
    const rBad = await vm.runInContext("spTranscribeFile", bad.ctx)(audioPath, {});
    ok(rBad.ok === false, "识别通道报错时回 ok:false（不假装成功）");
    ok(!!rBad.message, "失败带一句人话（不是原始英文错误）");

    const big = makeSpeechBox({ audioPath, tooBig: true });
    const rBig = await vm.runInContext("spTranscribeFile", big.ctx)(audioPath, {});
    ok(rBig.ok === false && rBig.error === "too_large", "超过体积上限 → too_large（明确报错，不静默截断）");

    const noRead = makeSpeechBox({ audioPath, readFail: true });
    const rNoRead = await vm.runInContext("spTranscribeFile", noRead.ctx)(audioPath, {});
    ok(rNoRead.ok === false, "音频读不到 → 明确失败（不抛异常、不假装成功）");

    const noWs = makeSpeechBox({ audioPath });
    noWs.sandbox.S.wf.workspace = "";
    noWs.sandbox.window.api.paths = async () => ({ dataDir: "" });
    const rNoWs = await vm.runInContext("spTranscribeFile", noWs.ctx)(audioPath, {});
    ok(rNoWs.ok === false, "没有工作目录时明确失败（不静默把音频丢掉）");

    /* 相位文案：下载 / 就绪 / 冷起 / 不可用 */
    const dl = makeSpeechBox({ audioPath, phase: "downloading" });
    const stDl = await vm.runInContext("spStatus", dl.ctx)(true);
    const txtDl = vm.runInContext("spPhaseText", dl.ctx)(stDl);
    ok(/下载/.test(txtDl), "下载中文案说清在下载：" + txtDl);
    const ready = makeSpeechBox({ audioPath, phase: "ready" });
    const stR = await vm.runInContext("spStatus", ready.ctx)(true);
    ok(/就绪/.test(vm.runInContext("spPhaseText", ready.ctx)(stR)), "就绪态文案");
    /* 状态读取必须带 workspace：网关按 workspace 挑（必要时现拉起）那台语音运行时，
       漏带就一律回「缺少 workspace」，而相位会把它当成「引擎还在冷起」—— 节点转写就
       永远停在「正在启动」（真机实测就是这条：音频节点的 asrState 卡在 starting）。 */
    const stCalls = ready.calls.filter((c) => c.action === "state");
    ok(stCalls.length > 0, "spStatus 真的向语音通道读了现况");
    ok(
      stCalls.every((c) => !!String(c.workspace || "").trim()),
      "spStatus 每次都带 workspace（得到 " + JSON.stringify(stCalls.map((c) => c.workspace)) + "）",
    );
    const phR = vm.runInContext("spPhaseOf", ready.ctx)(stR);
    ok(
      phR.available === true && phR.starting === false && !phR.error,
      "带 workspace 的现况 → 可用（不是「启动中」）",
    );
    ok(
      vm.runInContext("spPhaseOf", ready.ctx)({ ok: false, error: "缺少 workspace：语音输入要绑定一台工作区运行时" })
        .starting === false,
      "回包是错误 → 不判「引擎正在启动」（与「名单还空着」分开）",
    );
    ok(
      /工作目录/.test(
        vm.runInContext("spPhaseText", ready.ctx)({
          ok: false,
          error: "缺少 workspace：语音输入要绑定一台工作区运行时",
        }),
      ),
      "错误态文案指向「先打开一张画布 / 选好工作目录」（不糊一句「正在启动」）",
    );
    ok(vm.runInContext("spPhaseOf", ready.ctx)({ providers: [] }).starting === true, "名单为空 → 判「引擎正在启动」（不再误报不可用）");
    ok(vm.runInContext("spPhaseOf", ready.ctx)(null).available === false, "拿不到现况 → 判不可用（与「启动中」分开）");

    /* 错误码 → 人话 */
    const pe = vm.runInContext("spErrText", ready.ctx);
    ok(/工作目录/.test(pe({ error: "缺少 workspace" })), "workspace 缺失 → 指向「先打开一张画布」");
    ok(/下载/.test(pe({ error: "unprepared" })), "模型未准备 → 指向先下载模型");
    ok(/网络|连不上/.test(pe({ error: "ECONNREFUSED" })), "网络类错误 → 指向网络 / 本地服务");

    fs.rmSync(tmp, { recursive: true, force: true });
  }

  /* ════════════════ [3] 音频 / 视频节点的转录（app-asr.js）════════════════ */
  console.log("\n[3] renderer/app-asr.js：转写归音频节点（转录按钮 / 指纹 / 运行前闸门）");
  {
    const asrSrc = read("renderer/app-asr.js");
    ok(asrSrc.indexOf("asr-local") < 0, "app-asr.js 不再提 asr-local（旧插件已摘除）");
    ok(asrSrc.indexOf("window.api.asrTranscribe") < 0, "不再走旧的 asr:transcribe 通道");
    ok(asrSrc.indexOf("spTranscribeFile") > 0, "转写走 app-speech.js 的 spTranscribeFile");
    ok(asrSrc.indexOf("spEnsureReady") > 0, "模型没就绪时把下载跑起来（spEnsureReady）");
    ok(asrSrc.indexOf("spRememberEdited") > 0, "改错字写回缓存（spRememberEdited → edited=true）");
    ok(asrSrc.indexOf("spPhaseText") > 0, "相位文案统一从 app-speech.js 取");
    ok(/本地语音转写（SenseVoice）/.test(asrSrc), "转录块标题写明引擎（用户知道跑的是哪个）");
    ok(asrSrc.indexOf("asrHotwords") < 0, "热词表整块移除（SenseVoice 的官方调用只收 audio + language）");
    ok(
      !/\bffmpeg\b/.test(asrSrc.replace(/^\s*\*.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "")),
      "代码里不再有便携 ffmpeg 那一套（音频整形在渲染层用 WebAudio 做）",
    );
    ok(asrSrc.indexOf("window.api.asr") < 0, "不再碰任何 window.api.asr* 接口（旧后端整块摘除）");
    ok(
      !/^function asrPrepareForRun/m.test(asrSrc) && !/^function asrTaskAppendText/m.test(asrSrc),
      "旧口径的两个出口（文字节点自己转写 / 任务描述追加）已从模块里移除",
    );
    ok(/function asrOpsButton/.test(asrSrc) && /function asrAppendNodeBody/.test(asrSrc), "音频节点侧有「转录」按钮与转录块");
    ok(/function asrEnsureForRun/.test(asrSrc), "有运行前闸门（文字节点点 ▶ 时替音频节点转）");
    ok(/function asrPurgeLegacyTranscripts/.test(asrSrc), "有旧字段清理（文字节点上的 asrTranscripts）");

    /* ── 造一份「音频节点 + 文字节点」的现场：真 app-speech.js，只有通道是假的 ── */
    const toasts = [];
    const redraws = [];
    const tmpA = fs.mkdtempSync(path.join(os.tmpdir(), "mtnode-asr-node-"));
    const audioPath = path.join(tmpA, "voice.wav");
    fs.writeFileSync(audioPath, Buffer.alloc(64, 5));
    const audioNode = {
      id: "a1",
      kind: "input_audio",
      title: "音频",
      sourceName: "录音 1",
      mediaAsset: audioPath,
    };
    const textNode = { id: "p1", kind: "proc_text", title: "文本节点 1" };
    const cache = {};
    let phase = "unprepared";
    /* 现况桩：与真网关同口径 —— `speech` 方法按 workspace 挑（必要时现拉起）那台运行时，
       **不带 workspace 一律回「缺少 workspace」**。忽略参数的桩会让「状态读取漏带 workspace」
       这个真机 bug（节点转写永远停在「正在启动」）在冒烟里看不见，所以这里照实校验。 */
    const stateParams = [];
    const stateStub = (reply) => async (params) => {
      stateParams.push(params || {});
      if (!params || !String(params.workspace || "").trim())
        return { ok: false, error: "缺少 workspace：语音输入要绑定一台工作区运行时" };
      return typeof reply === "function" ? reply(params) : reply;
    };
    const sandbox = {
      console,
      setTimeout,
      clearTimeout,
      btoa: (s) => Buffer.from(s, "binary").toString("base64"),
      atob: (s) => Buffer.from(s, "base64").toString("binary"),
      I18n: { t: (s) => s },
      S: { wf: { id: "wf-a", workspace: "E:\\dev\\tmp-smoke" } },
      window: {
        api: {
          dshSpeech: async (params) => ({ ok: true, text: params.action === "transcribe" ? "转写结果。" : "" }),
          dshSpeechState: stateStub(() => ({
            providers: [{ id: "sv", preparation: { phase: phase } }],
            selection: { providerId: "sv" },
          })),
          /* 真读盘：转写这一路走 app-speech.js 的真实现，只有通道是假的 */
          fileReadAudioBytes: async () => ({ ok: true, bytes: fs.readFileSync(audioPath), size: 64 }),
          fileStat: async (p) => {
            const st = fs.statSync(p);
            return { bytes: st.size, mtimeMs: Math.floor(st.mtimeMs) };
          },
          speechCacheGet: async (p) =>
            cache[String(p.path)] ? Object.assign({ ok: true }, cache[String(p.path)]) : { ok: false, error: "miss" },
          speechCacheSet: async (p) => {
            cache[String(p.path)] = { text: p.text, edited: !!p.edited };
            return { ok: true };
          },
          speechCacheClear: async (p) => {
            delete cache[String(p.path)];
            return { ok: true };
          },
        },
        AudioContext: class {
          constructor() {
            this.sampleRate = 16000;
          }
          async decodeAudioData() {
            const n = 8000;
            const ch = new Float32Array(n).fill(0.1);
            return {
              sampleRate: 16000,
              length: n,
              numberOfChannels: 1,
              duration: 0.5,
              getChannelData: () => ch,
            };
          }
          close() {}
        },
      },
      toast: (m) => toasts.push(String(m)),
      renderCanvas() {
        redraws.push(1);
      },
      scheduleSave() {},
      nodeById: (id) => (id === "a1" ? audioNode : id === "p1" ? textNode : null),
      wiresTo: (id) => (id === "p1" ? [{ from: "a1", fromIndex: 0 }] : []),
      refLeafSourcesForWire: () => [],
      spPhaseText: () => "语音模型尚未下载（首次识别会自动下载）",
      spEnsureReady: () => Promise.resolve(null),
      openOverlay() {},
      closeOverlay() {},
      document: {
        getElementById: () => null,
        querySelector: () => null,
        createElement: () => ({
          style: {},
          dataset: {},
          classList: { add() {}, remove() {}, toggle() {} },
          appendChild() {},
          addEventListener() {},
        }),
      },
    };
    sandbox.window.window = sandbox.window;
    sandbox.window.document = sandbox.document;
    const ctx = vm.createContext(sandbox);
    /* 先 app-speech.js（提供 spStatus / spPhaseOf / spTranscribeFile…），再 app-asr.js ——
       与 index.html 的加载顺序一致 */
    vm.runInContext(read("renderer/app-speech.js"), ctx, { filename: "renderer/app-speech.js" });
    vm.runInContext(asrSrc, ctx, { filename: "renderer/app-asr.js" });
    const purge = vm.runInContext("asrPurgeLegacyTranscripts", ctx);
    const ensure = vm.runInContext("asrEnsureForRun", ctx);
    const transcribe = vm.runInContext("asrTranscribeNode", ctx);
    const items = vm.runInContext("asrTextItemsOf", ctx);
    const oneBlock = vm.runInContext("asrTranscriptBlockFor", ctx);
    const blocksFor = vm.runInContext("asrTextBlocksFor", ctx);
    const fresh = vm.runInContext("asrIsFresh", ctx);
    const appendBody = vm.runInContext("asrAppendNodeBody", ctx);
    const invalidate = vm.runInContext("asrInvalidateStatus", ctx);

    /* ① 模型没就绪：拦下本轮，并把下载跑起来（节点上写明原因） */
    let sR = await ensure(textNode);
    ok(sR.ok === false && sR.error === "unprepared", "模型没就绪：文字节点这一轮被明确拦下（不是静默跳过）");
    eqStr(audioNode.asrState, "downloading", "音频节点上标出「模型未就绪」这一态");
    ok(toasts.length > 0, "给用户一句可操作的话");

    /* ② 模型就绪：运行前闸门替音频节点转一次，文字写在**音频节点**上（带指纹） */
    phase = "ready";
    invalidate();
    sR = await ensure(textNode);
    ok(sR.ok === true, "模型就绪：闸门放行");
    ok(
      Array.isArray(audioNode.asrTranscripts) && audioNode.asrTranscripts.length === 1,
      "转写结果写在音频节点自己的 asrTranscripts 上",
    );
    eqStr(audioNode.asrTranscripts[0].text, "转写结果。", "文本就是识别回来的那一份");
    ok(!audioNode.asrTranscripts[0].edited, "自动转写不算人工修订");
    ok(
      audioNode.asrTranscripts[0].stamp && audioNode.asrTranscripts[0].stamp.size === 64,
      "同时记下文件指纹（路径 + 大小 + 修改时间）",
    );
    eqStr(audioNode.asrState, "ok", "音频节点状态回到 ok");
    ok(textNode.asrTranscripts === undefined, "文字节点上不再存任何转写文本（新口径）");

    /* ③ 已有转写 + 文件没变：不重转（转一次多处复用） */
    ok((await fresh(audioNode)) === true, "指纹一致 → 判定「已备好」");
    await vm.runInContext("spCacheClear", ctx)(audioPath); /* 清掉缓存，确保「不重转」不是因为命中缓存 */
    const before = audioNode.asrTranscripts[0].at;
    sR = await ensure(textNode);
    ok(sR.ok === true && audioNode.asrTranscripts[0].at === before, "已有新鲜转写：文字节点运行不再重转一遍");

    /* ④ 音频文件变了 → 指纹不一致 → 重转 */
    fs.writeFileSync(audioPath, Buffer.alloc(128, 9));
    ok((await fresh(audioNode)) === false, "文件变了（大小 / 时间不一致）→ 判为不新鲜");
    sR = await ensure(textNode);
    ok(sR.ok === true, "文件变了：闸门自动重转后放行");
    ok(audioNode.asrTranscripts[0].stamp.size === 128, "重转后指纹跟着更新");

    /* ⑤ 用户手改过的文本：文件再变也不覆盖，只提醒 */
    audioNode.asrTranscripts[0].edited = true;
    audioNode.asrTranscripts[0].text = "我改过的错字。";
    fs.writeFileSync(audioPath, Buffer.alloc(200, 3));
    toasts.length = 0;
    sR = await ensure(textNode);
    eqStr(audioNode.asrTranscripts[0].text, "我改过的错字。", "人工修订的文本不被机器结果覆盖");
    ok(sR.ok === true && toasts.some((x) => /手改/.test(x)), "只给一句提醒，不拦本轮");

    /* ⑥ 取文：音频节点的转写当背景块给下游文字节点 */
    const got = items(audioNode, textNode, 0);
    ok(
      Array.isArray(got) && got.length === 1 && /音频转写/.test(got[0].title),
      "背景块：用「音频转写 · 录音 1」代替原始 file:/// URL",
    );
    eqStr(got[0].text, "我改过的错字。", "块正文就是音频节点上那份文本");
    ok(
      oneBlock(textNode, audioNode) && oneBlock(textNode, audioNode).title.indexOf("录音 1") > 0,
      "单个块接口同样带上音频节点名",
    );
    ok(blocksFor(textNode).length === 1, "会话模式补段：取到接线上音频节点的转写块");
    /* 视频节点同样算数（音轨转写当文本用） */
    const vidNode = { id: "v1", kind: "input_video", title: "视频", mediaAsset: audioPath };
    vidNode.asrTranscripts = [{ path: audioPath, title: "视频", text: "视频里的说话。" }];
    ok(
      items(vidNode, textNode, 0) && items(vidNode, textNode, 0)[0].text === "视频里的说话。",
      "视频节点的转录也当文本给文字节点",
    );
    /* 没转录的音频节点不接管（照旧走 file:/// URL 那套），别的来源也不受影响 */
    ok(
      items({ id: "a9", kind: "input_audio", mediaAsset: audioPath }, textNode, 0) === null,
      "没有转录 → 不接管（返回 null 走原口径）",
    );
    ok(items({ id: "t9", kind: "input_text", text: "x" }, textNode, 0) === null, "非音频 / 视频来源不掺和");

    /* ⑦ 音频节点自己的转录块与按钮 */
    const node = { id: "a2", kind: "input_audio", title: "音频", mediaAsset: audioPath, asrOpen: true };
    const box = { kids: [], appendChild(el) { this.kids.push(el); } };
    const mkEl = (tag) => ({
      tag,
      kids: [],
      dataset: {},
      style: {},
      classList: { add() {}, remove() {}, toggle() {} },
      appendChild(c) { this.kids.push(c); },
      addEventListener() {},
    });
    sandbox.document.createElement = mkEl;
    appendBody(node, box);
    ok(box.kids.length === 1, "asrAppendNodeBody 往节点 body 追加转录块");
    const flat = (e) => {
      const out = [];
      for (const k of e.kids || []) {
        out.push(k);
        out.push(...flat(k));
      }
      return out;
    };
    const all = flat(box.kids[0]);
    ok(all.some((x) => x.className === "n-text n-asr-text"), "转录块里有可编辑文本区");
    ok(all.some((x) => x.textContent === "转录"), "转录块里有「转录 / 重新转录」按钮");
    /* 没选文件的音频节点：按钮禁用（不假装能转） */
    const emptyBtn = vm.runInContext("asrOpsButton", ctx)({ id: "a0", kind: "input_audio", title: "音频" });
    ok(emptyBtn.disabled === true, "没选文件时「转录」按钮是禁用的");

    /* ⑧ 旧字段清理：文字节点上的 asrTranscripts / asrState 一律删掉 */
    const wf = {
      nodes: [
        { id: "p1", kind: "proc_text", asrTranscripts: [{ path: "x", text: "旧文本" }], asrState: "ok" },
        { id: "p2", kind: "agent_task", asrState: "error" },
        { id: "a1", kind: "input_audio", asrTranscripts: [{ path: "x", text: "音频节点的" }] },
      ],
    };
    ok(purge(wf) === true, "扫到旧字段 → 报「有改动」（调用方据此落盘）");
    ok(wf.nodes[0].asrTranscripts === undefined && wf.nodes[0].asrState === undefined, "文字节点上的旧转写字段被删掉");
    ok(wf.nodes[1].asrState === undefined, "智能节点的旧状态字段同样删掉");
    ok(Array.isArray(wf.nodes[2].asrTranscripts), "音频节点自己的转写字段原样保留");
    ok(purge(wf) === false, "幂等：再扫一遍没有改动");

    /* ⑨ 冷起：名单空 = 引擎还在启动，**不是**不可用（用户实测过这条假警报）。
       先把「语音引擎现况」那份 TTL 缓存也现读一次，模拟真实的「这一轮问出来的就是空名单」。 */
    let stateCalls = 0;
    sandbox.window.api.dshSpeechState = stateStub(() => {
      stateCalls++;
      if (stateCalls <= 2) return { ok: true, providers: [], selection: {} };
      return { providers: [{ id: "sv", preparation: { phase: "ready" } }], selection: { providerId: "sv" } };
    });
    await vm.runInContext("spStatus", ctx)(true);
    const coldAudio = { id: "a3", kind: "input_audio", title: "音频", mediaAsset: audioPath };
    const coldText = { id: "p3", kind: "proc_text", title: "文本节点 3" };
    sandbox.nodeById = (id) => (id === "a3" ? coldAudio : id === "p3" ? coldText : null);
    sandbox.wiresTo = (id) => (id === "p3" ? [{ from: "a3", fromIndex: 0 }] : []);
    invalidate();
    const t0 = Date.now();
    const rc = await ensure(coldText);
    ok(rc.ok === true, "名单空（冷起窗口）→ 闸门退避重试后正常转写，不再当场报不可用");
    ok(stateCalls >= 3, "期间真的重问了引擎现况（实测 " + stateCalls + " 次）");
    ok(Date.now() - t0 >= 300, "重试之间真的等了（实测 " + (Date.now() - t0) + "ms）");
    eqStr(coldAudio.asrState, "ok", "冷起重试后音频节点状态回到 ok");

    /* 重试完仍是空名单：才判「还在启动中」，并给一句可照做的（不是服务坏掉） */
    sandbox.window.api.dshSpeechState = stateStub({ ok: true, providers: [], selection: {} });
    await vm.runInContext("spStatus", ctx)(true);
    invalidate();
    const cold2Text = { id: "p4", kind: "proc_text", title: "文本节点 4" };
    const cold2Audio = { id: "a4", kind: "input_audio", title: "音频", mediaAsset: audioPath };
    sandbox.nodeById = (id) => (id === "a4" ? cold2Audio : id === "p4" ? cold2Text : null);
    sandbox.wiresTo = (id) => (id === "p4" ? [{ from: "a4", fromIndex: 0 }] : []);
    const rc2 = await ensure(cold2Text);
    ok(rc2.ok === false && rc2.error === "starting", "重试完仍空名单 → 判「引擎还在启动」（error=starting）");
    ok(/转录还没完成：/.test(String(rc2.message || "")), "拦下时给一句「转录还没完成 + 原因」");
    ok(/启动/.test(String(rc2.message || "")), "文案说清「稍等一下再试」：" + rc2.message);
    eqStr(cold2Audio.asrState, "starting", "音频节点上标「语音服务启动中」这一态");

    /* ⑨-b 名单已经出来、但相位还在 checking（实测冷起：+1.9s 名单出现且 checking、+2.4s ready）：
       这也是冷起窗口的一部分 —— 判成「模型未就绪」会弹下载窗，把一次正常的首次转写吓回去。 */
    let checkCalls = 0;
    sandbox.window.api.dshSpeechState = stateStub(() => {
      checkCalls++;
      return {
        providers: [{ id: "sv", preparation: { phase: checkCalls <= 2 ? "checking" : "ready" } }],
        selection: { providerId: "sv" },
      };
    });
    invalidate();
    const chkText = { id: "p5", kind: "proc_text", title: "文本节点 5" };
    const chkAudio = { id: "a6", kind: "input_audio", title: "音频", mediaAsset: audioPath };
    sandbox.nodeById = (id) => (id === "a6" ? chkAudio : id === "p5" ? chkText : null);
    sandbox.wiresTo = (id) => (id === "p5" ? [{ from: "a6", fromIndex: 0 }] : []);
    const rc3 = await ensure(chkText);
    ok(rc3.ok === true, "checking → ready 的冷起窗口：等过去就放行（首次点「转录」即转）");
    eqStr(chkAudio.asrState, "ok", "checking 期间不再把节点判成「模型未就绪」");
    ok(checkCalls >= 3, "checking 期间真的又问了引擎现况（实测 " + checkCalls + " 次）");

    /* ⑩ 手动入口：asrTranscribeNode 直接替音频节点转（音频节点上的按钮 / 重转走它） */
    const manual = { id: "a5", kind: "input_audio", title: "音频", mediaAsset: audioPath };
    sandbox.window.api.dshSpeechState = stateStub({
      providers: [{ id: "sv", preparation: { phase: "ready" } }],
      selection: { providerId: "sv" },
    });
    invalidate();
    const mr = await transcribe(manual, { force: true });
    ok(mr.ok === true && manual.asrState === "ok", "asrTranscribeNode：手动转写成功并写回节点");
    ok(redraws.length > 0, "转写过程中会重绘节点（进度看得见）");
    /* 节点这条链路读现况时也必须带 workspace：漏带的话闸门会把「缺少 workspace」
       当成「引擎还在冷起」，每一次点「转录」都停在「正在启动」（真机 bug 原样复现）。 */
    ok(
      stateParams.length > 0 && stateParams.every((p) => !!String(p.workspace || "").trim()),
      "节点侧读现况每次都带 workspace（共 " + stateParams.length + " 次）",
    );

    const asrSrc2 = read("renderer/app-asr.js");
    ok(
      /ASR_READY_TRIES/.test(asrSrc2) && /ASR_READY_RETRY_MS/.test(asrSrc2),
      "退避重试的口径写死在常量里（与话筒同族）",
    );
    ok(
      /starting/.test(asrSrc2) && /语音服务启动中/.test(asrSrc2),
      "节点状态行认得「启动中」这一态（不再一律画成不可用）",
    );
    fs.rmSync(tmpA, { recursive: true, force: true });
  }

  /* ════════════════ [4] 桥：主窗口与应用窗口 ════════════════ */
  console.log("\n[4] 桥：preload.js / preload-app.js / apps-store.js");
  {
    const pre = read("preload.js");
    ok(pre.indexOf("dshSpeech:") > 0 && pre.indexOf("dshSpeechState:") > 0, "preload 暴露 dshSpeech / dshSpeechState");
    ok(
      pre.indexOf("speechCacheGet:") > 0 && pre.indexOf("speechCacheSet:") > 0 && pre.indexOf("speechCacheClear:") > 0,
      "preload 暴露转写缓存三件",
    );
    ok(pre.indexOf("fileReadAudioBytes:") > 0, "preload 暴露 fileReadAudioBytes（转写读盘）");
    ok(pre.indexOf("asrTranscribe") < 0 && pre.indexOf("asrGetStatus") < 0, "preload 不再有 asr* 方法（旧通道整块摘除）");
    ok(pre.indexOf("asr:transcribe") < 0 && pre.indexOf("asr:progress") < 0, "preload 不再有 asr:* 通道");

    const app = read("preload-app.js");
    ok(
      app.indexOf("asrStatus") > 0 && app.indexOf("transcribeWav") > 0 && app.indexOf("pickAudio") > 0,
      "应用桥暴露 asrStatus / transcribeWav / pickAudio（应用窗口听写）",
    );
    const main = read("main.js");
    ok(main.indexOf("speech-store.js") > 0, "main.js 注册 speech-store（缓存 + 音频读盘）");
  }

  /* ════════════════ [5] 旧后端与卡片彻底摘除 ════════════════ */
  console.log("\n[5] Qwen3-ASR 摘除：源码 / 打包清单 / 插件目录 / 修复表");
  {
    const build = read("build.json");
    ok(build.indexOf('"asr/**"') < 0 && build.indexOf("asr-pack") < 0, "build.json 不再含 asr/** 与 asr-pack");
    ok(exists("asr/main-asr.js") === false, "asr/ 主进程模块已删除");
    ok(exists("asr-pack/manifest.json") === false, "asr-pack/ 脚手架已删除");
    ok(exists("skills/asr-local-install/SKILL.md") === false, "asr-local-install 技能已删除");
    ok(exists("docs/asr-local-backend.md") === false, "旧后端设计文档已删除");

    const cat = read("plugins/catalog.default.json");
    ok(cat.indexOf('"asr-local"') < 0, "插件目录不再有 asr-local 卡片");
    const catKinds = read("plugins/catalog.default.json");
    ok(catKinds.indexOf("asr") < 0, "插件目录整份不再出现 asr 卡片 / kind");
    const repair = read("renderer/app-repair.js");
    const repairCode = repair.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    ok(
      repairCode.indexOf("asrStart") < 0 && repairCode.indexOf('"asr"') < 0,
      "自动修复表不再有 asr 重启入口（注释里留历史说明不算）",
    );
  }

  /* ════════════════ [6] 应用侧听写 UI（模板与脚手架） ════════════════ */
  console.log("\n[6] 应用窗口的 footer 听写：默认模板 + 脚手架");
  {
    const ui = read("renderer/app-speech-ui.js");
    ok(ui.indexOf("transcribeWav") > 0 && ui.indexOf("pickAudio") > 0, "听写 UI 走应用桥的 transcribeWav / pickAudio");
    ok(ui.indexOf("mtnode-dictate") > 0, "听写条有稳定 id（宿主注入与落点复核都认它）");
    const tpl = read("templates/app-default/index.html");
    ok(tpl.indexOf("dict-btn") > 0 && tpl.indexOf("asrStatus") > 0, "默认应用模板接入了听写按钮（dict-btn + asrStatus 桥）");
    ok(exists("templates/app-scaffold/speech.js"), "应用脚手架带 speech.js");
  }

  /* ════════════════ [7] 文档与词条 ════════════════ */
  console.log("\n[7] 文档 / i18n / 指南同步");
  {
    const i18n = read("renderer/i18n.js");
    ok(i18n.indexOf("本地语音转写（SenseVoice）") > 0, "i18n 有转录块标题词条");
    ok(i18n.indexOf("正在下载语音模型（首次使用，约 239MB）") > 0, "i18n 有下载进度词条");
    ok(i18n.indexOf("Qwen3-ASR") < 0, "i18n 不再提 Qwen3-ASR");
    ok(i18n.indexOf('"补装 ffmpeg"') < 0 && i18n.indexOf('"交给 AI 安装 / 自我修复"') < 0, "i18n 不再有安装 / 补装解码器那批词条");
    ok(i18n.indexOf('"音频转写"') > 0, "i18n 保留「音频转写」块标题词条");
    ok(i18n.indexOf('"转录"') > 0 && i18n.indexOf('"清空转录"') > 0, "i18n 有音频节点转录按钮与清空词条");
    ok(i18n.indexOf('"状态与设置"') > 0, "插件卡片仍用的「状态与设置」词条保留");

    ok(read("guides/manual/dsh.md").indexOf("Qwen3-ASR") < 0, "手册不再把节点级转写指向 Qwen3-ASR");
    ok(
      /节点级转写也统一到官方 SenseVoice/.test(read("docs/dsh-0.2-capability-map.md")),
      "能力映射文档已同步（节点级转写也走 SenseVoice）",
    );
    ok(read("mtnode-agent-skills/plugins/plugin-dev/SKILL.md").indexOf("asr-local") < 0, "插件开发技能的后端对照表不再列 asr-local");
    ok(read("docs/plugin-auto-repair.md").indexOf("asr-local-install") < 0, "插件自动修复文档不再列 asr-local-install 技能");
    ok(read("renderer/style.css").indexOf("SenseVoice") > 0, "样式入口注释已同步");
  }

  /* ════════════════ [8] 应用窗口 footer 语音条（宿主注入） ════════════════ */
  console.log("\n[8] 应用窗口 footer 语音条：宿主注入 + 桥 / 状态口径");
  {
    const ui = read("renderer/app-speech-ui.js");
    const preApp = read("preload-app.js");

    ok(preApp.indexOf('"renderer", "app-speech-ui.js"') > 0, "preload-app 注入 renderer/app-speech-ui.js");
    ok(/pathToFileURL\(file\)\.href/.test(preApp) && /createElement\("script"\)/.test(preApp), "注入方式 = file:// 的 <script src>");
    ok(/readyState === "loading"[\s\S]{0,140}DOMContentLoaded/.test(preApp), "等 DOM 就绪再注入（footer 那时才在）");
    ok(ui.indexOf("window.appHost") > 0 && ui.indexOf('"mtnode-apphost"') > 0, "注入脚本自己取桥 + 事件兜底");
    ok(/FOOT_SELS = \["footer", "\.app-foot", "\.foot", "#appFoot"\]/.test(ui), "落点优先应用自己的 <footer>（找不到才自建底栏）");
    ok(ui.indexOf("mtnode-dictate-bar") > 0, "应用没有 footer 时宿主自建一条底栏");
    ok(/autoMount/.test(ui), "注入脚本自挂载（不依赖应用改代码）");
  }

  console.log("\n" + (fail ? "✗ " : "✓ ") + "共 " + (pass + fail) + " 项：" + pass + " 通过 / " + fail + " 失败");
  if (fail) {
    console.log("失败项：\n- " + fails.join("\n- "));
    process.exitCode = 1;
  }
})().catch((err) => {
  console.error("smoke-asr 崩了：" + ((err && err.stack) || err));
  process.exitCode = 1;
});
