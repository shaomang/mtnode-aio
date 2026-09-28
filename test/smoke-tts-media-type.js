"use strict";
/* SoVITS 语音合成「400 http 错误」回归 —— 冒烟测试（纯 Node · 真源码真跑）
 *   node test/smoke-tts-media-type.js
 *
 * 立规（本次 bug）：画布 SoVITS 语音节点（tts_gen）选「输出格式 = mp3」后必报
 * HTTP 400，而且节点上只显示一句干巴巴的 `HTTP Error 400: Bad Request`。两个根因：
 *   [1] 推理引擎 api_v2 的 /tts 对 media_type 做**白名单**校验，只认
 *       wav / raw / ogg / aac —— 插件把节点的 mp3（以及 OpenAI 接口的 flac / opus）
 *       原样转发，引擎直接 `400 media_type: mp3 is not supported`。
 *   [2] 插件把这个 400 的响应体丢掉（`except Exception as e: str(e)`），
 *       {"message":…,"Exception":…} 里的真原因到不了节点；管理服务再把它包成 500。
 * 本测试钉住修好后的口径：
 *   tts-pack/app/tts.py    media_type 白名单收敛 + mp3/flac 用 ffmpeg 转码 + 读引擎错误体
 *   renderer/app-nodes.js  ttsErrorText 认这些「引擎真原因」并译成中文（认不出才对得上）
 *   renderer/i18n.js       新增中文串逐条有英文词条（英文界面不漏中文）
 */
const fs = require("fs");
const path = require("path");

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
const read = (rel) =>
  fs.readFileSync(path.join(__dirname, "..", rel.split("/").join(path.sep)), "utf8");
const HAS = (src, needle, msg) => ok(src.indexOf(needle) >= 0, msg);
const HASNT = (src, needle, msg) => ok(src.indexOf(needle) < 0, msg);
/* JS：函数体从 `function xxx(` 到下一个「列 0 的 }」（本仓缩进风格稳定；
   body 里含字符串字面量 "{"，所以不能靠大括号计数）。 */
function fnBody(src, name) {
  const m = new RegExp("function\\s+" + name + "\\s*\\(").exec(src);
  if (!m) return "";
  const end = src.indexOf("\n}", m.index);
  return end < 0 ? "" : src.slice(m.index, end + 2);
}
/* Python：def 到「空行之后第一个列 0 行」为止（两段空行分隔的顶层 def）。 */
function pyDef(src, name) {
  const m = new RegExp("^def " + name + "\\(", "m").exec(src);
  if (!m) return "";
  const lines = src.slice(m.index).split("\n");
  const out = [lines[0]];
  for (let k = 1; k < lines.length; k++) {
    if (lines[k].trim() === "") {
      let j = k + 1;
      while (j < lines.length && lines[j].trim() === "") j++;
      if (j < lines.length && /^\S/.test(lines[j])) break;
    }
    out.push(lines[k]);
  }
  return out.join("\n");
}

const PY = read("tts-pack/app/tts.py");
const SERVER = read("tts-pack/app/server.py");
const NODES = read("renderer/app-nodes.js");
const I18n = require("../renderer/i18n.js");

/* ═════════ [1] 插件：引擎 media_type 白名单收敛（400 的直接原因） ═════════ */
console.log("\n[1] tts-pack/app/tts.py：只向引擎发它白名单里的 media_type");
{
  HAS(PY, 'ENGINE_MEDIA_TYPES = ("wav", "raw", "ogg", "aac")', "声明引擎白名单 wav/raw/ogg/aac");
  HAS(PY, '_TRANSCODE_MEDIA_TYPES = ("mp3", "flac")', "mp3 / flac 走本地转码（不在白名单里）");
  const fn = pyDef(PY, "engine_media_type");
  ok(!!fn, "有 engine_media_type()：请求容器 → 引擎容器");
  HAS(fn, 'mt if mt in ENGINE_MEDIA_TYPES else "wav"', "白名单外的容器一律回落 wav，绝不原样转发");
  const norm = pyDef(PY, "normalize_media_type");
  ok(!!norm, "有 normalize_media_type()：别名归一（mpeg/mp4/mpga→mp3 · opus→ogg · 空→wav）");
  for (const alias of ['"mpeg": "mp3"', '"mpga": "mp3"', '"opus": "ogg"']) HAS(PY, alias, "别名表 _MEDIA_ALIAS 含 " + alias);
  const syn = pyDef(PY, "synthesize");
  ok(!!syn, "取到 synthesize() 函数体");
  HAS(syn, '"media_type": engine_mt', "payload 发的是归一后的 engine_mt");
  HASNT(syn, '"media_type": str(media_type or "wav")', "旧的「原样转发调用方 media_type」已删（就是它让 mp3 必 400）");
  HAS(syn, "engine_mt = engine_media_type(want_mt)", "synthesize 里先算 engine_mt");
  HAS(syn, "need_transcode = want_mt in _TRANSCODE_MEDIA_TYPES", "只有 mp3 / flac 才转码");
  HAS(syn, "unsupported_media_type", "白名单与转码表都不认的容器 → 调引擎之前就拒（不白等模型加载）");
  HAS(syn, "_transcode_audio(audio, want_mt)", "引擎出的 wav 交给 _transcode_audio 转 mp3/flac");
  /* 转码：stdin→stdout，不落临时文件；缺 ffmpeg 明确报错，不静默改名 */
  const tc = pyDef(PY, "_transcode_audio");
  ok(!!tc, "有 _transcode_audio()");
  HAS(tc, '"libmp3lame"', "mp3 用 libmp3lame 编码");
  HAS(tc, '"flac"', "flac 走 flac 编码");
  HAS(tc, "missing_ffmpeg", "没有 ffmpeg 时回 missing_ffmpeg（不静默把 wav 当 mp3 写盘）");
  HAS(tc, 'subprocess.run(cmd, input=data', "stdin 喂字节、stdout 取结果");
  const ff = pyDef(PY, "_ffmpeg_exe");
  ok(!!ff, "有 _ffmpeg_exe()");
  HAS(ff, 'shutil.which("ffmpeg")', "先查 PATH");
  HAS(ff, 'ENGINE_DIR / "ffmpeg.exe"', "再查引擎目录（GPT-SoVITS 的 install 脚本把它下在这）");
  HAS(PY, "import shutil", "tts.py 已 import shutil");
}

/* ═════════ [2] 插件：引擎 400/500 的响应体必须读出来（别只剩 HTTP Error 400） ═════════ */
console.log("\n[2] tts-pack/app/tts.py：引擎错误体读出来再转发");
{
  const syn = pyDef(PY, "synthesize");
  HAS(syn, "except urllib.error.HTTPError as he:", "请求引擎处单独捕 HTTPError（不再被 str(e) 吃掉）");
  HAS(syn, "return _engine_http_error(he, engine_mt)", "转交 _engine_http_error() 解析");
  const eh = pyDef(PY, "_engine_http_error");
  ok(!!eh, "有 _engine_http_error()");
  HAS(eh, 'e.read().decode("utf-8", "replace")', "真的把响应体读出来");
  HAS(eh, 'j.get("Exception") or j.get("message")', "api_v2 的 message / Exception 两处都认");
  HAS(eh, '"errorCode": "engine_http_%s" % e.code', "带 engine_http_<code> 便于上游分流");
  /* 管理服务：调用方错误必须原样回 400，不能包成 500（否则客户端当服务端故障反复重试） */
  HAS(SERVER, 'if code in ("missing_ffmpeg", "transcode_failed", "unsupported_media_type"):', "缺 ffmpeg / 转码失败 = 400 而不是 500");
  HAS(SERVER, 'if int(r.get("engineStatus") or 0) in (400, 413, 415, 422):', "引擎 4xx 原样透传成 400");
}

/* ═════════ [3] 渲染层：ttsErrorText 认「引擎真原因」，认不出才回显原文 ═════════ */
console.log("\n[3] renderer/app-nodes.js：ttsErrorText 把引擎真原因译成能照着做的中文");
const ttsErrorText = new Function("I18n", fnBody(NODES, "ttsErrorText") + "\nreturn ttsErrorText;")(
  I18n,
);
{
  ok(typeof ttsErrorText === "function", "真源码里取到 ttsErrorText()");
  const eq = (raw, want, msg) => ok(ttsErrorText(raw) === want, msg + " → " + ttsErrorText(raw));
  /* 回归：老词条不许走样（FastAPI 的 {"detail":…} 与裸码两种形态都要认） */
  eq("voice_not_found", "音色不存在（请重新选择音色）", "voice_not_found");
  eq('{"detail":"no_voice"}', "后端没有可用音色（请先在插件里添加参考音频音色）", "JSON detail 体");
  eq("lang_denied", "语种被后端策略拒绝（请在插件里调整语种策略或换文本）", "lang_denied");
  /* 本次 bug：引擎 400 的真原因 */
  const mt = ttsErrorText('{"detail":"media_type: mp3 is not supported"}');
  ok(mt.indexOf("后端不支持该输出格式") === 0, "引擎 media_type 400 → 说清是输出格式：" + mt);
  ok(/mp3 is not supported/.test(mt), "  └ 保留引擎原文尾巴便于定位");
  ok(
    ttsErrorText('{"detail":"missing_ffmpeg: 本机没有找到 ffmpeg"}').indexOf("缺少 ffmpeg") >= 0,
    "缺 ffmpeg → 告诉用户改用 wav / 重装后端",
  );
  ok(
    ttsErrorText('{"detail":"transcode_failed: ffmpeg rc=1"}').indexOf("音频转码失败") >= 0,
    "转码失败 → 同样给出可执行建议",
  );
  ok(
    ttsErrorText('{"detail":"ref_audio_path is required"}').indexOf("参考音频") >= 0,
    "ref_audio_path 缺失 → 指向音色参考音频",
  );
  /* 老后端把响应体吃掉时只剩裸 HTTP 码：至少说清是「后端返回 HTTP 错误」 */
  const bare = ttsErrorText("HTTP Error 400: Bad Request");
  ok(bare.indexOf("后端返回 HTTP 错误：400") === 0, "裸 HTTP 400 → 不再原样回显：" + bare);
  /* 网络类故障的口径不受影响 */
  ok(
    ttsErrorText("connect ECONNREFUSED 127.0.0.1:8770").indexOf("无法连接 GPT-SoVITS 后端") === 0,
    "ECONNREFUSED 仍归网络类提示",
  );
}

/* ═════════ [4] i18n：ttsErrorText 用到的中文串逐条有英文词条 ═════════ */
console.log("\n[4] i18n：新词条中英成对（英文界面不漏中文）");
{
  const body = fnBody(NODES, "ttsErrorText");
  const keys = [...body.matchAll(/T\("((?:[^"\\]|\\.)*)"\)/g)].map((m) => m[1]);
  ok(keys.length >= 10, "抽到 ttsErrorText 用到的中文串（" + keys.length + " 条）");
  ok(I18n.t("输出格式") === "输出格式", "默认中文口径原样返回（词条结构未破坏）");
  for (const k of keys) ok(I18n.t(k) === k, "中文口径原样：" + k.slice(0, 18) + "…");
  I18n.setLocale("en");
  const miss = keys.filter((k) => I18n.t(k) === k);
  ok(miss.length === 0, "英文口径逐条命中译文（缺 " + miss.length + " 条）" + (miss.length ? "：" + miss.join(" / ") : ""));
  I18n.setLocale("zh");
}

/* ═════════ [5] 插件主进程：新代码要真的换上去（否则用户升级后照旧带旧 bug） ═════════ */
console.log("\n[5] tts/main-tts.js：pack 代码指纹 + 空闲时自动重启后端");
{
  const MAIN = read("tts/main-tts.js");
  HAS(MAIN, 'const crypto = require("crypto")', "主进程 require crypto 算指纹");
  HAS(MAIN, "function packFingerprint()", "有 packFingerprint()：app/** + manifest.json 算 sha1");
  HAS(MAIN, 'walk(join(pack, "app"), "app")', "指纹覆盖 app/**（修 400 改的就是 app/tts.py）");
  const sb = fnBody(MAIN, "startBackend");
  ok(!!sb, "取到 startBackend() 函数体");
  HAS(sb, "const packFp = packFingerprint();", "启动前先算指纹");
  HAS(sb, "syncPackToInstall(installDir);", "仍然把新 pack 同步进安装目录");
  HAS(sb, "if (trainingBusyFromStatus(st0))", "有训练任务在跑时绝不重启（训练按小时算）");
  HAS(sb, "await stopBackend();", "空闲且代码变了 → 停掉旧服务");
  HAS(sb, "saveDeployedCode(packFp)", "重启成功后落盘指纹（下次不再白重启）");
  const tb = fnBody(MAIN, "trainingBusyFromStatus");
  HAS(tb, "p.running", "训练中判定看 /api/status 的 projects[].running");
}

console.log("\n" + (fails ? "FAILED  " : "ALL GREEN  ") + checks + " 项检查 · 失败 " + fails);
process.exit(fails ? 1 : 0);
