"use strict";
/* 提醒音（主进程侧）——「后台也要响」的根治实现（sound-alert.js）
 * ============================================================================
 * 为什么放在主进程：上一版完成音完全由渲染层的 WebAudio 发声（renderer/app-db.js 的
 * builtinDoneDing / builtinDingDong）。用户实测：MTNode 被别的软件盖住 / 最小化时任务
 * 跑完一声都没有，**切回 MTNode 那一刻才响** —— 典型的「这一拍被推迟到窗口回到前台才
 * 落地」。渲染层的音频链路会随窗口可见性 / 聚焦状态被 Chromium 与系统音频会话改写
 * （挂起、静音、暂停），主进程不受这套管辖：这里直接合成 WAV、交给系统播放器出声，
 * 窗口在不在前台、可不可见都无关。
 *
 * 音色与渲染层内置音**同一把尺**（改音色时两边一起改，见 renderer/app-db.js 的同名注释）：
 *   · builtin "ding"     = 任务完成短促音：659.25 → 880（E5 → A5），两音各 0.18s，约 0.42s
 *     —— **合成音**，本次不动（用户要的「任何任务完成的短促音」= 现在这一声）
 *   · builtin "dingdong" = 全部结束的全局提示音：**改用真实 WAV 资源**
 *     renderer/sounds/all-done.wav（系统音色 Windows Proximity Notification，1.63s、22050Hz
 *     立体声 16bit PCM）—— 比短促音更长、更清脆明显，用户一耳朵能分辨「所有任务都结束了、
 *     队列空了 5 分钟」（本次需求的核心）。TONES.dingdong 的合成三音上行**保留为兜底**：
 *     读不到 / 解析不了那个 WAV 时照旧合成它，不静默失败（见 allDoneWavBytes + dbg 日志）。
 *     载入路径：开发态 __dirname/renderer/sounds/all-done.wav；打包态先试 app.getAppPath()/
 *     renderer/sounds/（asar 内 Node 可读），再试 exe 同级 resources/app…；**一律先读出字节
 *     写进临时文件再交给 SoundPlayer** —— SoundPlayer 读不了 asar 里的路径（那是虚拟 FS）。
 *   · "ask"              = 提问 / 审批提示：440 → 660 两音短促双音
 *   音量滑杆（0~100，缺省 35）在渲染层换算成 amplitude（0~0.34）传进来，这里按同一
 *   amplitude 缩放 PCM —— 与渲染层做的是同一件事（SoundPlayer 没有音量属性，只能改样本）。
 *   峰值口径：合成完按**整段实际峰值**归一化到 amp（见 normalizePeak），否则「主音 + 低
 *   八度分音」同相叠加会把峰值顶到 amp 的 1.22 倍，滑块 35% 就不等于渲染层的 0.119。
 *
 * 播放通道（都**不经过渲染层**；PowerShell 子进程带 windowsHide，用户看不到窗口）：
 *   · .wav（含内置音临时文件）→ System.Media.SoundPlayer.PlaySync()（.NET Framework 自带）
 *   · 其它（mp3 / m4a / ogg…）→ WMPlayer.OCX（Windows Media Player COM，settings.volume 可调）
 *   两条路都在临时目录放文件，播完删；同一个文件的临时副本复用（同一次运行内不重复写盘）。
 *
 * 纯 Node 模块（不 require electron）：便于 test/smoke-sound-alert.js 直接加载断言，
 * 也便于在别的宿主里复用。本模块**绝不写用户数据目录之外的地方**：只写
 * os.tmpdir()/mtnode-sound-alert/ 这一处缓存目录，失败只回 { ok:false }，不抛。
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");

/* ---------------- 音色表（与 renderer/app-db.js 内置音同源） ---------------- */
/* 两档完成音的时基**不同高**，这是需求的核心：
 *   · 任务级「叮咚」= 短促双音 E5 → A5（两音各 0.18s，合计 ≈ 0.36s）—— 任何一件任务跑完
 *     都响这一声，就是用户说的「以前的短促音」；
 *   · 全局级 = 三音上行 C6 → E6 → G6（各 0.16s），末音留 0.3~0.4s 衰减余韵，合计 ≈ 0.9s，
 *     音区比任务级高五度以上、无低八度分音 —— 「全部任务结束且队列空了 5 分钟」才响，
 *     一耳朵就能与短促音分开（旧版两档共用同一个短音，用户听不出区别，本次需求即是修它）。 */
const SHORT_NOTES = [
  [659.25, 0, 0.18],
  [880, 0.18, 0.18],
];
const ALL_DONE_NOTES = [
  [1046.5, 0, 0.16], /* C6 */
  [1318.51, 0.16, 0.16], /* E6 */
  [1567.98, 0.32, 0.16], /* G6（末音带余韵，见下） */
];
/* 每音衰减率（越大衰减越快）：末音 4.2 ≈ 0.38s 的可闻余韵，前两音保持「清脆短点」 */
const TONES = {
  /* 任务级完成音：短促双音（E5 → A5） */
  ding: {
    notes: SHORT_NOTES,
    decays: [9, 9],
    sub: 0,
    subLevel: 0,
    subDecay: 0,
    tail: 0.06,
  },
  /* 全局级（全部跑完 + 空闲满 5 分钟）：**兜底音色**（真身是 renderer/sounds/all-done.wav，
     读不到文件时才用这一档合成音）+ 末音余韵（tail = 余韵时长） */
  dingdong: {
    notes: ALL_DONE_NOTES,
    decays: [9, 9, 4.2],
    sub: 0,
    subLevel: 0,
    subDecay: 0,
    tail: 0.38,
  },
  /* 提问 / 审批提示音：440 → 660 两音短促双音（与两档完成音都区分开） */
  ask: {
    notes: [
      [440, 0, 0.12],
      [660, 0.14, 0.12],
    ],
    decays: [9, 9],
    sub: 0,
    subLevel: 0,
    subDecay: 0,
    tail: 0.06,
  },
};
const SAMPLE_RATE = 44100;
/* 渲染层内置音的幅度尺：滑杆 100% = 0.34，35% ≈ 0.119（见 app-db.js doneSoundGain） */
const MAX_AMP = 0.34;
/* 音色版本号：参与内置音的缓存键与临时文件名（改 TONES / synthSamples 就加一，
   否则主进程还活着时会复用旧音色的临时 WAV，用户改完音色听到的还是老声音）。
   r3：dingdong 档从「合成三音上行」改为真实 WAV 资源 renderer/sounds/all-done.wav
   （旧进程留下的 builtin-r2-dingdong-*.wav 是合成音，绝不能被复用）。 */
const TONE_REV = "r3";

/* 内置音效资源（随包）：只有「全部结束」这一档用真实 WAV */
const BUILTIN_ALL_DONE_REL = path.join("renderer", "sounds", "all-done.wav");

/* 调试日志：只在环境变量打开时打印（失败回退原因要留痕，但别往用户控制台刷噪音） */
function dbg(...args) {
  if (!process.env.MTNODE_SOUND_DEBUG) return;
  try {
    console.log("[sound-alert]", ...args);
  } catch (_) {}
}

function toneOf(mode) {
  const k = String(mode || "").trim().toLowerCase();
  /* "ding-dong" / "ding dong" 之类的写法也算钟声档（历史上档位名出现过连字符写法） */
  if (k === "dingdong" || k === "dong" || k.replace(/[^a-z]/g, "") === "dingdong") return "dingdong";
  if (k === "ask" || k === "beep") return "ask";
  return "ding";
}

/* 峰值归一化：把整段样本按实际峰值缩放到 amp。
   为什么需要：主音与低八度分音在起点同相叠加（峰值 ≈ amp × 1.22），直接交给系统播
   会让「滑杆 35%」比渲染层那一路响一截 —— 音量滑杆两档必须同一把尺。amp<=0 时返回
   原样（调用方按长度判空，静音就是静音）。 */
function normalizePeak(samples, amp) {
  const a = Number(amp) || 0;
  let mx = 0;
  for (let i = 0; i < samples.length; i++) mx = Math.max(mx, Math.abs(samples[i]));
  if (!(mx > 0) || !(a > 0)) return samples;
  const k = a / mx;
  for (let i = 0; i < samples.length; i++) samples[i] *= k;
  return samples;
}

/* 内置音 → Float32 单声道样本（24bit 级别的浮点合成，量化在 wavBytes 里一次做完）。
   amp = 峰值幅度（0~0.34）。amp<=0 返回空数组 = 静音（调用方据此不播）。 */
function synthSamples(mode, amp) {
  const a = Math.max(0, Math.min(1, Number(amp) || 0));
  if (!(a > 0)) return new Float32Array(0);
  const t = TONES[toneOf(mode)];
  let total = 0;
  for (const [, off, dur] of t.notes) total = Math.max(total, off + dur);
  /* 余韵时长是音色表的显式字段（与 renderer/app-db.js 的同名音色表同源，两边一起改）；
     表里没写就退回以前的 60ms 防爆音淡出 */
  const tail = Number(t.tail) > 0 ? Number(t.tail) : 0.06;
  const decays = Array.isArray(t.decays) ? t.decays : [];
  const n = Math.ceil((total + tail) * SAMPLE_RATE);
  const out = new Float32Array(n);
  t.notes.forEach(([f, off, dur], ix) => {
    const s0 = Math.floor(off * SAMPLE_RATE);
    const parts = [[1, 1, (decays[ix] > 0 ? decays[ix] : 9)]];
    if (t.sub > 0 && t.subLevel > 0) parts.push([t.sub, t.subLevel, t.subDecay]);
    for (const [mult, level, decay] of parts) {
      const peak = a * level;
      const s1 = Math.min(n, Math.floor((off + (mult === 1 ? dur : dur + 0.25)) * SAMPLE_RATE));
      for (let i = s0; i < s1; i++) {
        const tt = (i - s0) / SAMPLE_RATE;
        out[i] += peak * Math.exp(-tt * decay) * Math.sin(2 * Math.PI * f * mult * tt);
      }
    }
  });
  /* 收尾 60ms 线性淡出：指数衰减已经把尾巴压得很低，这一步防的是极端参数下的爆音 */
  const fade = Math.min(n, Math.floor(0.06 * SAMPLE_RATE));
  for (let i = 0; i < fade; i++) out[n - 1 - i] *= i / fade;
  return normalizePeak(out, a);
}

/* Float32 样本 → 16bit PCM 单声道 WAV 文件字节（44 字节标准头 + 小端样本） */
function wavBytes(samples, rate) {
  const sr = Number(rate) > 0 ? Math.floor(Number(rate)) : SAMPLE_RATE;
  const n = samples && samples.length ? samples.length : 0;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write("WAVE", 8, "ascii");
  buf.write("fmt ", 12, "ascii");
  buf.writeUInt32LE(16, 16); /* fmt 块长度 */
  buf.writeUInt16LE(1, 20); /* PCM */
  buf.writeUInt16LE(1, 22); /* 单声道 */
  buf.writeUInt32LE(sr, 24);
  buf.writeUInt32LE(sr * 2, 28); /* 字节率 */
  buf.writeUInt16LE(2, 32); /* 块对齐 */
  buf.writeUInt16LE(16, 34); /* 位深 */
  buf.write("data", 36, "ascii");
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    buf.writeInt16LE(Math.round(v * 32767), 44 + i * 2);
  }
  return buf;
}

/* 内置音的 WAV 字节（测试直接断言它；播放路径用它写临时文件） */
function chimeWav(mode, amp) {
  return wavBytes(synthSamples(mode, amp), SAMPLE_RATE);
}

/* ---------------- 内置音效资源：「全部结束」用的真实 WAV ---------------- */
/* 候选路径按优先级排：开发态（源码目录）→ 打包态（asar 内 / 解包 resources 下）。
   app.getAppPath() 打包后是 …\resources\app.asar，Node 的 fs 能读 asar 内文件，
   但交给 SoundPlayer 的**路径**它读不了（那是虚拟 FS），所以读出的字节一律先落临时文件。
   本模块是纯 Node 模块（不 require electron），这里只在拿得到 electron 时顺手用一下。 */
function allDoneWavCandidates() {
  const out = [path.join(__dirname, BUILTIN_ALL_DONE_REL)];
  const push = (base) => {
    const b = String(base || "").trim();
    if (b && out.indexOf(b) < 0) out.push(b);
  };
  try {
    const app = require("electron").app;
    if (app && typeof app.getAppPath === "function") {
      const p = String(app.getAppPath() || "").trim();
      if (p) {
        push(path.join(p, BUILTIN_ALL_DONE_REL));
        /* 解包安装目录（app.asar 同级 / 上一级）也试一把：extraResources 类布局容错 */
        const d = path.dirname(p);
        push(path.join(d, "app", BUILTIN_ALL_DONE_REL));
        push(path.join(path.dirname(d), "app", BUILTIN_ALL_DONE_REL));
      }
    }
  } catch (_) {}
  return out;
}
/* 返回内置音效资源路径（第一个存在的），读不到回 "" */
function allDoneWavPath() {
  for (const p of allDoneWavCandidates()) {
    try {
      if (fs.statSync(p).isFile()) return p;
    } catch (_) {}
  }
  return "";
}
/* 读内置音效资源的字节（先读进内存再交给临时文件，避开 asar 路径坑）；读不到回 null */
function allDoneWavBytes() {
  const p = allDoneWavPath();
  if (!p) {
    dbg("内置音效资源不存在，候选：", allDoneWavCandidates().join(" | "));
    return null;
  }
  try {
    const buf = fs.readFileSync(p);
    if (buf.length > 44 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WAVE") {
      dbg("内置音效资源就绪：", p, buf.length + " 字节");
      return buf;
    }
    dbg("内置音效资源不是 RIFF/WAVE，回退合成音：", p, buf.length + " 字节");
  } catch (e) {
    dbg("内置音效资源读取失败，回退合成音：", p, String((e && e.message) || e));
  }
  return null;
}

/* 用户自定义音效（wav）按音量缩放：SoundPlayer 没有音量属性，只能改样本。
   16bit PCM 的**单声道 / 立体声**都按同一系数缩放（立体声按 4 字节一帧、左右各乘 k，
   帧边界不能跨 —— 内置的 renderer/sounds/all-done.wav 就是 22050Hz 立体声 16bit PCM）。
   其余（非 PCM / 非 16bit / 声道数>2）一律不动字节，交给系统按原音量播（宁可响错，不可改坏）。 */
function scaleWavVolume(buf, amp) {
  if (!Buffer.isBuffer(buf) || buf.length < 44) return null;
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") return null;
  const channels = buf.readUInt16LE(22);
  const bits = buf.readUInt16LE(34);
  const format = buf.readUInt16LE(20);
  if (format !== 1 || bits !== 16 || (channels !== 1 && channels !== 2)) return null;
  const scaled = Buffer.from(buf);
  /* 音量滑杆只调内置音是渲染层的口径；自定义文件按它自己的响度播（0.5 → 这里 50%），
     所以缩放系数 = 传入 amplitude / 满幅 0.34 */
  const k = Math.max(0, Math.min(MAX_AMP, Number(amp) || 0)) / MAX_AMP;
  for (let i = 44; i + 1 < scaled.length; i += 2) {
    const v = scaled.readInt16LE(i);
    scaled.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(v * k))), i);
  }
  return scaled;
}

/* ---------------- 临时目录（只写这一处） ---------------- */
function tmpDir() {
  return path.join(os.tmpdir(), "mtnode-sound-alert");
}
function ensureTmp() {
  const d = tmpDir();
  try {
    fs.mkdirSync(d, { recursive: true });
  } catch (_) {}
  return d;
}
function writeTmp(name, buf) {
  const d = ensureTmp();
  const p = path.join(d, name);
  try {
    fs.writeFileSync(p, buf);
    return p;
  } catch (_) {
    return "";
  }
}

/* ---------------- 系统播放器 ---------------- */
function psExe() {
  const root = process.env.SystemRoot || process.env.windir || "C:\\Windows";
  return path.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}
/* 文件路径 / 文案不拼进脚本正文（防引号、防注入），走 base64 传给 PowerShell 解码 */
function b64(s) {
  return Buffer.from(String(s == null ? "" : s), "utf8").toString("base64");
}
function psPrelude() {
  return "$ErrorActionPreference='Stop'; try {";
}
function runPS(script, timeoutMs) {
  return new Promise((resolve) => {
    let p;
    try {
      p = spawn(psExe(), ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", script], {
        windowsHide: true,
        stdio: "ignore",
      });
    } catch (e) {
      resolve({ ok: false, error: String((e && e.message) || e) });
      return;
    }
    let done = false;
    const kill = () => {
      if (done) return;
      done = true;
      try {
        p.kill();
      } catch (_) {}
      resolve({ ok: false, error: "timeout" });
    };
    const timer = setTimeout(kill, Math.max(5000, Number(timeoutMs) || 15000));
    p.on("error", (e) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ ok: false, error: String((e && e.message) || e) });
    });
    p.on("close", (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (code === 0) resolve({ ok: true });
      else resolve({ ok: false, error: "ps exit " + code });
    });
  });
}
/* wav：.NET Framework 自带 SoundPlayer（不需要 Add-Type，Win7+ 一律可用）。
   PlaySync 会阻塞这个子进程直到播完 —— 主进程不受影响，播完子进程自己退出。 */
function psPlayWav(file, ms) {
  const script =
    psPrelude() +
    " $f=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('" + b64(file) + "'));" +
    " $p=New-Object System.Media.SoundPlayer; $p.SoundLocation=$f; $p.PlaySync();" +
    " } catch { exit 1 }";
  return runPS(script, ms);
}
/* 非 wav（mp3 / m4a / ogg…）：Windows Media Player COM，settings.volume 可调 0~100。
   播完（或到点）立刻 controls.stop() + close()，不留后台进程。 */
function psPlayMedia(file, volumePct, ms) {
  const vol = Math.max(0, Math.min(100, Math.round(Number(volumePct) || 0)));
  const wait = Math.max(1, Math.min(150, Math.ceil((Number(ms) || 15000) / 1000)));
  const script =
    psPrelude() +
    " $f=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('" + b64(file) + "'));" +
    " $w=New-Object -ComObject WMPlayer.OCX; $w.settings.volume=" + vol + "; $w.URL=$f;" +
    " $w.controls.play();" +
    " $t0=Get-Date; while(((Get-Date)-$t0).TotalMilliseconds -lt " + (Number(ms) || 15000) + "){" +
    " Start-Sleep -Milliseconds 120; if($w.playState -eq 1 -and ((Get-Date)-$t0).TotalMilliseconds -gt 400){break} }" +
    " $w.controls.stop(); $w.close();" +
    " } catch { exit 1 }";
  return runPS(script, wait * 1000 + 6000);
}

/* ---------------- 对外入口 ---------------- */
const _cache = new Map(); /* fileKey → 临时文件路径（同一次运行内同一份文件只写一次盘） */

/* 播一声。opts:
     mode   "ding" | "dingdong" | "ask"     内置音档位（完成音两档都是短促双音，见 TONES）
     amp    0~0.34 内置音幅度（渲染层音量滑杆换算好的，同一把尺）
     file   自定义音频文件绝对路径（给了就用它，档位不再参与）
     volume 0~100 自定义文件音量（默认 50，与渲染层 playDoneSoundFile 的 0.5 对齐）
   返回 Promise<{ok, via, error?}>；任何时候都不抛。 */
async function playAlert(opts) {
  const o = opts || {};
  const mode = toneOf(o.mode);
  const file = String(o.file || "").trim();
  const amp = Math.max(0, Math.min(MAX_AMP, Number(o.amp) || 0));
  const volIn = Number(o.volume);
  const volume = Math.max(0, Math.min(100, Number.isFinite(volIn) ? volIn : 50));

  /* 自定义文件优先（与渲染层「自定义文件优先，否则内置音」同一口径） */
  if (file) {
    let exists = false;
    try {
      exists = fs.statSync(file).isFile();
    } catch (_) {
      exists = false;
    }
    if (exists) {
      const ext = path.extname(file).toLowerCase();
      if (ext === ".wav") {
        let target = file;
        let bytes = "";
        try {
          bytes = fs.readFileSync(file);
        } catch (_) {}
        const scaled = bytes ? scaleWavVolume(bytes, (volume / 100) * MAX_AMP) : null;
        if (scaled) {
          const key = "u:" + file + ":" + Math.round(volume);
          const cached = _cache.get(key);
          if (cached && fs.existsSync(cached)) target = cached;
          else {
            const p = writeTmp("user-" + crypto.createHash("sha1").update(key).digest("hex").slice(0, 12) + ".wav", scaled);
            if (p) {
              _cache.set(key, p);
              target = p;
            }
          }
        }
        const r = await psPlayWav(target, 20000);
        if (r.ok) return { ok: true, via: "wav" };
        return { ok: false, via: "wav", error: r.error };
      }
      const r = await psPlayMedia(file, volume, 30000);
      if (r.ok) return { ok: true, via: "media" };
      return { ok: false, via: "media", error: r.error };
    }
    /* 文件没了 → 落回内置音（与渲染层 playDoneSoundFile 返回 false 后走内置音一致） */
  }

  if (!(amp > 0)) return { ok: false, via: "muted", error: "amplitude 0" };

  /* 「全部结束」这一档改用真实 WAV 资源（renderer/sounds/all-done.wav）：
     读字节 → 按音量滑杆缩放（scaleWavVolume，覆盖立体声 16bit）→ 落临时文件 → SoundPlayer。
     读不到 / 缩放不了就落回下面的合成音（TONES.dingdong），并留日志，绝不静默失败。 */
  if (mode === "dingdong") {
    const raw = allDoneWavBytes();
    if (raw) {
      const scaled = scaleWavVolume(raw, amp);
      if (!scaled) dbg("内置音效资源不是 16bit PCM 单/立体声，按原音量播：", raw.length + " 字节");
      const body = scaled || raw;
      /* 缓存键带 TONE_REV + 幅度 + 文件字节指纹（同一份资源换新版本时不会复用旧副本） */
      const fp = crypto.createHash("sha1").update(body).digest("hex").slice(0, 8);
      const wkey = "w:" + TONE_REV + ":dingdong:" + amp.toFixed(4) + ":" + raw.length + ":" + fp;
      let wpath = _cache.get(wkey) || "";
      if (!wpath || !fs.existsSync(wpath)) {
        wpath = writeTmp(
          "builtin-" + TONE_REV + "-dingdong-" + Math.round(amp * 1000) + "-" + fp + ".wav",
          body,
        );
        if (wpath) _cache.set(wkey, wpath);
      }
      if (wpath) {
        const r = await psPlayWav(wpath, 20000);
        if (r.ok) return { ok: true, via: "builtin" };
        return { ok: false, via: "builtin", error: r.error };
      }
      dbg("内置音效资源临时文件写入失败，回退合成音");
    }
  }

  const key = "b:" + TONE_REV + ":" + mode + ":" + amp.toFixed(4);
  let target = _cache.get(key) || "";
  if (!target || !fs.existsSync(target)) {
    target = writeTmp(
      "builtin-" + TONE_REV + "-" + mode + "-" + Math.round(amp * 1000) + ".wav",
      chimeWav(mode, amp),
    );
    if (target) _cache.set(key, target);
  }
  if (!target) return { ok: false, via: "builtin", error: "tmp write failed" };
  const r = await psPlayWav(target, 20000);
  if (r.ok) return { ok: true, via: "builtin" };
  return { ok: false, via: "builtin", error: r.error };
}

module.exports = {
  playAlert,
  chimeWav,
  synthSamples,
  normalizePeak,
  wavBytes,
  scaleWavVolume,
  toneOf,
  TONES,
  SAMPLE_RATE,
  MAX_AMP,
  tmpDir,
};
