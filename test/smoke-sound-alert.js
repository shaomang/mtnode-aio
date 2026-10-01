#!/usr/bin/env node
/* test/smoke-sound-alert.js — 「任务完成提示音：后台也要响」回归
 * ============================================================================
 * 口径（本次需求）：MTNode 被别的软件盖住 / 最小化时，任务跑完也要立刻响 ——
 * 上一版发声完全在渲染层（renderer/app-db.js 的 WebAudio），那一拍会被推迟到
 * 用户切回 MTNode 才落地。现在发声改走主进程：
 *   ① sound-alert.js 合成与渲染层**同一把尺**的 WAV，交给系统播放器（PowerShell）出声；
 *   ② main.js 关掉三个后台节流开关 + 主窗 backgroundThrottling:false（判定那一拍不被降频）；
 *   ③ preload.js 暴露 window.api.soundAlert，renderer/app-db.js 的响铃函数先派给主进程，
 *      桥不在或派发失败才回落到原来的 WebAudio。
 *
 * 本脚本零依赖 / 不启动 Electron / 不碰真实 %APPDATA%；PowerShell 子进程用假体替换，
 * 只断言「会去播哪个文件、用什么音量」，不真的出声。
 */
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const Module = require("module");

const ROOT = path.resolve(__dirname, "..");
const SRC = fs.readFileSync(path.join(ROOT, "sound-alert.js"), "utf8");
const MAIN = fs.readFileSync(path.join(ROOT, "main.js"), "utf8");
const PRELOAD = fs.readFileSync(path.join(ROOT, "preload.js"), "utf8");
const APP_DB = fs.readFileSync(path.join(ROOT, "renderer", "app-db.js"), "utf8");
const BUILD = fs.readFileSync(path.join(ROOT, "build.json"), "utf8");

let fails = 0;
function ok(cond, msg) {
  console.log((cond ? "  ✓ " : "  ✗ ") + msg);
  if (!cond) fails++;
}

/* ---------------- 假 PowerShell：记录每次 spawn 的脚本正文 ---------------- */
const spawns = [];
const realSpawn = require("child_process").spawn;
function fakeSpawn(file, args, opts) {
  spawns.push({ file, args: args || [], opts: opts || {} });
  const { EventEmitter } = require("events");
  const p = new EventEmitter();
  p.kill = () => {};
  p.stderr = new EventEmitter();
  p.stdout = new EventEmitter();
  setTimeout(() => p.emit("close", 0), 0);
  return p;
}
const origLoad = Module._load;
Module._load = function (req, parent, isMain) {
  if (req === "child_process") return { spawn: fakeSpawn };
  return origLoad.call(this, req, parent, isMain);
};

const sa = require(path.join(ROOT, "sound-alert.js"));
Module._load = origLoad;

function psScriptOf(i) {
  return spawns[i] && spawns[i].args ? String(spawns[i].args[spawns[i].args.length - 1] || "") : "";
}
/* PowerShell 脚本里的 base64 载荷（路径不拼进脚本正文，防引号 / 防注入） */
function b64Payloads(script) {
  const out = [];
  const re = /FromBase64String\('([^']*)'\)/g;
  let m;
  while ((m = re.exec(script))) {
    try {
      out.push(Buffer.from(m[1], "base64").toString("utf8"));
    } catch (_) {}
  }
  return out;
}
function resolveRef(script) {
  return b64Payloads(script)[0] || "";
}

console.log("\n[1] 内置音 WAV：与渲染层同一把尺的音色表 / 头字段 / 时长");
{
  ok(typeof sa.playAlert === "function", "sound-alert.js 导出 playAlert");
  ok(
    ["ding", "dingdong", "ask"].every((k) => sa.TONES[k] && Array.isArray(sa.TONES[k].notes)),
    "三档音色都在表里：ding（任务完成短促音）/ dingdong（全部结束的全局提示音）/ ask（提问提示）",
  );
  const dd = sa.TONES.ding.notes.map((x) => x[0]);
  const dg = sa.TONES.dingdong.notes.map((x) => x[0]);
  ok(
    dd.join(",") === "659.25,880",
    "任务级短促音 = 以前的短促音（E5→A5），本次需求要求它保持原样",
  );
  ok(
    dg.join(",") === "1046.5,1318.51,1567.98" && dg.length === 3,
    "全局提示音 = 三音上行 C6→E6→G6（与短促音不再是同一个声音，本次需求的核心）",
  );
  ok(
    Number(sa.TONES.dingdong.tail) > Number(sa.TONES.ding.tail) && Number(sa.TONES.dingdong.tail) >= 0.3,
    "全局音末音带 0.3 秒以上的衰减余韵（更清脆明显的那一档）",
  );
  ok(
    Array.isArray(sa.TONES.dingdong.decays) &&
      sa.TONES.dingdong.decays[2] < sa.TONES.dingdong.decays[0],
    "末音衰减率比其他音小（尾巴留得住，不是硬切）",
  );
  const want = { ding: 0.42, dingdong: 0.86, ask: 0.32 };
  for (const mode of ["ding", "dingdong", "ask"]) {
    const b = sa.chimeWav(mode, 0.119);
    const rate = b.readUInt32LE(24);
    const dur = b.readUInt32LE(40) / 2 / rate;
    ok(
      b.toString("ascii", 0, 4) === "RIFF" &&
        b.toString("ascii", 8, 12) === "WAVE" &&
        b.readUInt16LE(20) === 1 &&
        b.readUInt16LE(22) === 1 &&
        b.readUInt16LE(34) === 16 &&
        rate === 44100 &&
        b.readUInt32LE(4) === b.length - 8 &&
        b.readUInt32LE(40) === b.length - 44,
      mode + "：16bit 单声道 44.1k WAV 头自洽（" + (b.length / 1024).toFixed(1) + " KB）",
    );
    ok(
      Math.abs(dur - want[mode]) < 0.25,
      mode + " 时长 ≈ " + want[mode] + "s（与渲染层同档音色的时长口径一致）实际 " + dur.toFixed(2) + "s",
    );
  }
  /* 峰值幅度 = 音量尺：35% ≈ 0.119，拉满 = 0.34（与 app-db.js doneSoundGain 同源） */
  const peakOf = (buf) => {
    let mx = 0;
    for (let i = 44; i + 1 < buf.length; i += 2) mx = Math.max(mx, Math.abs(buf.readInt16LE(i)));
    return mx / 32767;
  };
  const p35 = peakOf(sa.chimeWav("ding", (35 / 100) * 0.34));
  const p100 = peakOf(sa.chimeWav("ding", 0.34));
  ok(
    Math.abs(p35 - 0.119) < 0.02 && Math.abs(p100 - 0.34) < 0.02 && p100 > p35 * 2.5,
    "音量滑杆同一把尺：35% ≈ " + p35.toFixed(3) + "（渲染层 0.119）、100% ≈ " + p100.toFixed(3) + "（渲染层 0.34）",
  );
  ok(sa.chimeWav("ding", 0).length === 44, "音量 0 = 空样本（只留 44 字节头，不发声）");
  ok(sa.toneOf("DING-DONG") === "dingdong" && sa.toneOf("") === "ding" && sa.toneOf("bogus") === "ding", "档位名大小写 / 未知值一律落回任务级短音");
}

console.log("\n[2] 派发：内置音走 SoundPlayer、非 wav 走 MediaPlayer、音量按样本缩放");
{
  (async () => {
    spawns.length = 0;
    let r = await sa.playAlert({ mode: "dingdong", amp: 0.119 });
    ok(r.ok === true && r.via === "builtin", '内置音派发成功（ok/via="builtin"）');
    const s0 = psScriptOf(0);
    ok(/System\.Media\.SoundPlayer/.test(s0), "内置音走 .NET SoundPlayer（.NET Framework 自带，不需要额外安装）");
    ok(/PlaySync/.test(s0), "用 PlaySync 播完即退（不留挂着的子进程）");
    ok(/-WindowStyle/.test(spawns[0].args.join(" ")) && spawns[0].opts.windowsHide === true, "PowerShell 子进程隐藏窗口启动（用户看不到黑框）");
    const wavPath = resolveRef(s0);
    ok(
      /^builtin-r\d+-dingdong-/.test(path.basename(wavPath)) && fs.existsSync(wavPath) && path.dirname(wavPath) === sa.tmpDir(),
      "播的是临时文件里的内置音 WAV（文件名带音色版本号，旧进程的旧音色缓存不会被复用）：" + wavPath,
    );
    const bytes = fs.readFileSync(wavPath);
    ok(bytes.length > 1000 && bytes.toString("ascii", 0, 4) === "RIFF", "临时文件就是真 WAV（" + bytes.length + " 字节）");
    ok(sa.tmpDir().startsWith(os.tmpdir()) && /mtnode-sound-alert$/.test(sa.tmpDir()), "临时目录只落在系统 temp 下（不碰应用目录 / 数据目录）");

    /* 同一档位第二次：复用同一个临时文件，不重复写盘 */
    spawns.length = 0;
    await sa.playAlert({ mode: "dingdong", amp: 0.119 });
    ok(resolveRef(psScriptOf(0)) === wavPath, "同档同音量复用同一份临时 WAV（不反复写盘）");

    /* 非 wav 自定义文件：MediaPlayer + settings.volume */
    spawns.length = 0;
    const mp3 = path.join(sa.tmpDir(), "smoke-user-tone.mp3");
    fs.writeFileSync(mp3, Buffer.concat([Buffer.from("ID3"), Buffer.alloc(64)]));
    r = await sa.playAlert({ mode: "ding", file: mp3, volume: 42 });
    ok(r.ok === true && r.via === "media", "mp3 等非 wav 走 MediaPlayer 通道（via=media）");
    const s1 = psScriptOf(0);
    ok(/WMPlayer\.OCX/.test(s1) && /settings\.volume=42/.test(s1), "MediaPlayer 上按传入音量 settings.volume=42");
    ok(resolveRef(s1) === mp3, "播的就是用户选的那个文件（不复制不改写）");
    ok(/controls\.stop\(\)/.test(s1) && /\$w\.close\(\)/.test(s1), "播完 stop + close，不留 COM 实例挂后台");

    /* 自定义 wav：按音量缩放样本后再播（SoundPlayer 没有音量属性） */
    spawns.length = 0;
    const userWav = path.join(sa.tmpDir(), "smoke-user.wav");
    const full = sa.chimeWav("ding", 0.34);
    fs.writeFileSync(userWav, full);
    const origRead = fs.readFileSync;
    fs.readFileSync = function (p, ...rest) {
      if (String(p) === userWav) return full;
      return origRead.call(fs, p, ...rest);
    };
    try {
      r = await sa.playAlert({ mode: "ding", file: userWav, volume: 50 });
    } finally {
      fs.readFileSync = origRead;
    }
    const played = resolveRef(psScriptOf(0));
    ok(r.ok === true && r.via === "wav", "自定义 wav 走 SoundPlayer（via=wav）");
    ok(
      played !== userWav && /^user-/.test(path.basename(played)) && fs.existsSync(played),
      "播的是按音量缩放后的临时副本（原文件一个字节都不动）：" + path.basename(played),
    );
    const scaledPeak = (() => {
      const b = fs.readFileSync(played);
      let mx = 0;
      for (let i = 44; i + 1 < b.length; i += 2) mx = Math.max(mx, Math.abs(b.readInt16LE(i)));
      return mx / 32767;
    })();
    ok(
      Math.abs(scaledPeak - 0.17) < 0.02,
      "50% 音量 ≈ 半幅 0.17（与渲染层 <audio>.volume=0.5 同口径）实际 " + scaledPeak.toFixed(3),
    );
    ok(fs.readFileSync(userWav).equals(full), "用户原文件保持原样（只读不写）");

    /* 立体声 16bit PCM 也按同一把尺缩放：内置音效资源 renderer/sounds/all-done.wav 就是
       22050Hz 立体声（「全部结束」那一档改用真实 WAV 后，滑杆必须还管得到它） */
    const stereo = Buffer.from(full);
    stereo.writeUInt16LE(2, 22); /* 头改成“立体声”（样本仍按单声道排，只验缩放闸与系数） */
    const stereoScaled = sa.scaleWavVolume(stereo, 0.17);
    ok(
      stereoScaled &&
        stereoScaled.length === stereo.length &&
        Math.abs(
          (() => {
            let mx = 0;
            for (let i = 44; i + 1 < stereoScaled.length; i += 2) mx = Math.max(mx, Math.abs(stereoScaled.readInt16LE(i)));
            return mx / 32767;
          })() - 0.17,
        ) < 0.02,
      "16bit 立体声 wav 同样按音量缩放（0.5 → 半幅 0.17，与渲染层同口径）",
    );
    /* 其余（非 PCM / 非 16bit）一律不缩放、按原样播（宁可响错，不可改坏） */
    const odd = Buffer.from(full);
    odd.writeUInt16LE(8, 34); /* 8bit */
    ok(sa.scaleWavVolume(odd, 0.17) === null, "非 16bit 的 wav 不做样本缩放（交给系统按原音量播）");
    ok(sa.scaleWavVolume(Buffer.from("not a wav at all"), 0.17) === null, "不是 RIFF/WAVE 的字节直接拒绝");

    /* 文件没了 → 落回内置音（与渲染层 playDoneSoundFile 返回 false 后走内置音一致） */
    spawns.length = 0;
    r = await sa.playAlert({ mode: "dingdong", amp: 0.119, file: path.join(sa.tmpDir(), "does-not-exist.wav") });
    ok(r.ok === true && r.via === "builtin", "自定义文件不存在 → 落回内置音（不静默失败）");

    /* 音量 0 → 什么都不播 */
    spawns.length = 0;
    r = await sa.playAlert({ mode: "ding", amp: 0 });
    ok(r.ok === false && r.via === "muted" && spawns.length === 0, "音量 0 → 一个子进程都不起（真静音）");

    /* PowerShell 起不来：回 ok:false，绝不抛（响不响不该把任务收尾弄挂） */
    Module._load = function (req, parent, isMain) {
      if (req === "child_process")
        return {
          spawn: () => {
            const { EventEmitter } = require("events");
            const p = new EventEmitter();
            p.kill = () => {};
            p.stderr = new EventEmitter();
            p.stdout = new EventEmitter();
            setTimeout(() => p.emit("error", new Error("ENOENT")), 0);
            return p;
          },
        };
      return origLoad.call(this, req, parent, isMain);
    };
    delete require.cache[require.resolve(path.join(ROOT, "sound-alert.js"))];
    const sa2 = require(path.join(ROOT, "sound-alert.js"));
    Module._load = origLoad;
    let threw = false;
    let r2 = null;
    try {
      r2 = await sa2.playAlert({ mode: "ding", amp: 0.119 });
    } catch (_) {
      threw = true;
    }
    ok(!threw && r2 && r2.ok === false && /ENOENT/.test(String(r2.error || "")), "系统播放器起不来 → {ok:false,error}（不抛异常）");
    delete require.cache[require.resolve(path.join(ROOT, "sound-alert.js"))];

    finish();
  })().catch((e) => {
    console.log("  ✗ [2] 抛异常：" + ((e && e.stack) || e));
    fails++;
    finish();
  });
}

function finish() {
  console.log("\n[3] 接线：后台节流闸 + 主窗不被当后台 + 桥 + 渲染层派发顺序");
  {
    ok(
      /app\.commandLine\.appendSwitch\("disable-renderer-backgrounding"\)/.test(MAIN) &&
        /app\.commandLine\.appendSwitch\("disable-background-timer-throttling"\)/.test(MAIN) &&
        /app\.commandLine\.appendSwitch\("disable-backgrounding-occluded-windows"\)/.test(MAIN),
      "main.js 在 app ready 之前关掉三个后台节流开关（渲染进程降级 / 定时器降频 / 被盖住算后台）",
    );
    const switchesAt = MAIN.indexOf("disable-renderer-backgrounding");
    ok(
      switchesAt > 0 && switchesAt < MAIN.indexOf("app.whenReady()"),
      "三个开关写在 app.whenReady 之前（ready 之后再改命令行参数不生效）",
    );
    ok(
      /new BrowserWindow\(\{[\s\S]{0,900}?backgroundThrottling: false,[\s\S]{0,200}?\}\);/.test(
        MAIN.slice(MAIN.indexOf("mainWin = new BrowserWindow")),
      ),
      "主窗 webPreferences 里 backgroundThrottling:false（窗口不在前台也不降频 / 不静音）",
    );
    ok(
      /ipcMain\.handle\("sound:alert"/.test(MAIN) && /soundAlert\.playAlert\(opts \|\| \{\}\)/.test(MAIN),
      "main.js 注册 sound:alert 通道，转发给 sound-alert.js 的 playAlert",
    );
    ok(
      /catch \(e\) \{\s*\n\s*return \{ ok: false, via: "error"/.test(MAIN),
      "通道里兜住异常（返回 ok:false，不让一次任务收尾因为响铃挂掉）",
    );
    ok(
      /require\("\.\/sound-alert\.js"\)/.test(MAIN) && /"sound-alert\.js",/.test(BUILD),
      "新主进程模块已进 build.json 白名单（否则打包后 Cannot find module）",
    );
    ok(
      /soundAlert: \(opts\) => ipcRenderer\.invoke\('sound:alert', opts \|\| \{\}\)/.test(PRELOAD),
      "preload.js 暴露 window.api.soundAlert",
    );

    /* 渲染层：先派给主进程，桥不在 / 派发失败才回落 WebAudio */
    ok(
      /function alertViaHost\(mode, amp, file\)/.test(APP_DB) &&
        /typeof api\.soundAlert !== "function"\) return false/.test(APP_DB),
      "renderer/app-db.js 新增 alertViaHost（无桥即返回 false，迷你 DOM 回归不受影响）",
    );
    const fnBody = (name) => {
      const i = APP_DB.indexOf("function " + name + "(");
      if (i < 0) return "";
      const j = APP_DB.indexOf("\n}\n", i);
      return APP_DB.slice(i, j < 0 ? i + 2000 : j);
    };
    for (const [name, mode] of [["builtinDoneDing", "ding"], ["builtinDingDong", "dingdong"], ["builtinIxBeep", "ask"]]) {
      const b = fnBody(name);
      const at = b.indexOf("alertViaHost(");
      const webAudio = b.indexOf("new AC()");
      ok(
        at >= 0 && /if \(alertViaHost\(/.test(b) && (webAudio < 0 || at < webAudio),
        name + "：先派主进程（" + mode + " 档），WebAudio 只作兜底",
      );
    }
    ok(
      /if \(alertViaHost\("", Number\.isFinite\(a0\) && a0 > 0 \? a0 : 0\.17, file\)\) return true;/.test(
        fnBody("playDoneSoundFile"),
      ),
      "playDoneSoundFile：自定义文件也先派主进程（缺省音量 0.17 ≈ 旧 a.volume=0.5）",
    );
    /* 精确到函数体本身：整段源码切片会把后面的 previewDoneSound 也框进来，假阴性 */
    const fnBodyOf = (name) => {
      const at = APP_DB.indexOf("function " + name + "(");
      if (at < 0) return "";
      let i = APP_DB.indexOf("{", at);
      let depth = 0;
      for (; i < APP_DB.length; i++) {
        const c = APP_DB[i];
        if (c === "{") depth++;
        else if (c === "}") {
          depth--;
          if (depth === 0) break;
        }
      }
      return APP_DB.slice(at, i + 1);
    };
    ok(
      /if \(!playDoneSoundFile\(file\)\) builtinDoneDing\(\);/.test(fnBodyOf("playTaskDoneSound")) &&
        /builtinDingDong\(\);/.test(fnBodyOf("playAllDoneSound")) &&
        !/playDoneSoundFile/.test(fnBodyOf("playAllDoneSound")),
      "playTaskDoneSound 用自定义文件优先（否则内置短促音）；playAllDoneSound 固定用内置三音上行（自定义文件只管短促音那一档）",
    );
    ok(
      /if \(!\(amp > 0\)\) return; \/\* 滑杆拉到 0 = 静音/.test(fnBody("builtinDoneDing")) &&
        /if \(!\(amp > 0\)\) return; \/\* 滑杆拉到 0 = 静音/.test(fnBody("builtinDingDong")),
      "静音判定仍在派发之前（滑杆 0 时连主进程都不叫）",
    );
  }
  console.log("\n结果：" + (fails ? fails + " 项失败" : "全部通过"));
  process.exit(fails ? 1 : 0);
}
