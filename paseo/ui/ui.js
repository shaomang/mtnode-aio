/* Paseo 手机接管 · 控制台窗脚本（无框架）
 *
 * 这一窗只做四件事：把后端现状摊开给人看、出一张配对二维码、把 provider 注册进 Paseo、
 * 管住「远程连接」这个总开关。所有重活都在主进程宿主（paseo/main-paseo.js），
 * 这里只调 window.paseoApi（preload-paseo.js 的白名单桥）并渲染回执。
 *
 * 二维码：内容 = 官方 `paseo daemon pair --json` 回的 url（=https://app.paseo.sh/#offer=…）。
 * 官方返回的 qr 字段是带 ANSI 的终端字符画，塞进界面会变形 —— 这里用 paseo/qr.js（自研零依赖）
 * 自己画成 SVG。拿不到编码器时退回一个极简的矩阵画法（同文件末尾 qrSvgOf 的兜底分支）。
 */
"use strict";

const $ = (sel) => document.querySelector(sel);

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

let toastTimer = 0;
function toast(msg, kind) {
  const el = $("#toast");
  el.textContent = String(msg || "");
  el.className = "toast " + (kind || "");
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.hidden = true;
  }, 3600);
}

/** 最近一次状态快照 + 本次会话里生成过的配对结果（不落盘：窗口关了就得重新生成） */
let S = null;
let PAIR = null;
let busyBtn = "";
/** 最近一次「桥自检」里数出来的两个数（模型条数 / 可接管会话条数）。
 *  为什么要在界面上摊开：手机上「没模型可选」「看不到会话」这两类现场，用户只能靠猜 ——
 *  这两个数字一出，是桥没给还是手机端没刷就一目了然（解析自桥的 --check 正文）。 */
let BRIDGE_FACTS = null;

function bridgeFactsOf(text) {
  const t = String(text || "");
  const m = /models:\s*(\d+)/.exec(t);
  const s = /sessions:\s*(\d+)\s*条可接管/.exec(t);
  if (!m && !s) return null;
  return { models: m ? Number(m[1]) : null, sessions: s ? Number(s[1]) : null, at: Date.now() };
}

function bridgeFactsLine() {
  if (!BRIDGE_FACTS) return '<span class="tip">还没跑过自检 —— 点一下「桥自检」，这里会显示手机端能选到几个模型、几条已有会话。</span>';
  const m = BRIDGE_FACTS.models;
  const s = BRIDGE_FACTS.sessions;
  const models =
    m === null
      ? pill("模型数未知", "warn")
      : m > 0
        ? pill("模型 " + m + " 个", "ok")
        : pill("模型 0 个", "err") + ' <span class="tip">桥没给出模型清单 → 手机上会显示「未检测到 Model」</span>';
  const sessions =
    s === null
      ? pill("会话数未知", "warn")
      : s > 0
        ? pill("可接管会话 " + s + " 条", "ok")
        : pill("可接管会话 0 条", "warn") + ' <span class="tip">MTNode 左栏还没有会话，手机端自然是空的</span>';
  return models + " · " + sessions;
}

/* ------------------------------------------------------------------ */
/* 二维码                                                              */
/* ------------------------------------------------------------------ */
/** 优先用 paseo/qr.js；拿不到就自己把矩阵画成 SVG（同一份图标，只是少一层封装） */
function qrSvgOf(text) {
  const Q = window.MTNodeQR || window.MTNodeQr || null;
  try {
    if (Q && typeof Q.qrSvg === "function") return Q.qrSvg(text, { scale: 6, margin: 3 });
    if (Q && typeof Q.qrMatrix === "function") return matrixSvg(Q.qrMatrix(text, { ecl: "M" }), 6, 3);
  } catch (e) {
    return '<div class="tip err">二维码生成失败：' + esc((e && e.message) || e) + "</div>";
  }
  return '<div class="tip err">二维码编码器没加载上（paseo/qr.js 缺失）—— 用下面的配对链接也一样能配对。</div>';
}
function matrixSvg(m, scale, margin) {
  if (!m || !m.modules) return "";
  const n = m.modules.length;
  const size = (n + margin * 2) * scale;
  let path = "";
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if (!m.modules[y][x]) continue;
      path += "M" + (x + margin) * scale + " " + (y + margin) * scale + "h" + scale + "v" + scale + "h-" + scale + "z";
    }
  }
  return (
    '<svg xmlns="http://www.w3.org/2000/svg" width="' + size + '" height="' + size + '" viewBox="0 0 ' + size + " " + size + '">' +
    '<rect width="' + size + '" height="' + size + '" fill="#fff"/>' +
    '<path d="' + path + '" fill="#000"/></svg>'
  );
}

/* ------------------------------------------------------------------ */
/* 动作                                                                */
/* ------------------------------------------------------------------ */
async function run(name, fn) {
  if (busyBtn) return null;
  busyBtn = name;
  render();
  let r = null;
  try {
    r = await fn();
  } catch (e) {
    r = { ok: false, error: (e && e.message) || String(e) };
  }
  busyBtn = "";
  render();
  return r;
}

async function load() {
  try {
    S = await window.paseoApi.getStatus();
  } catch (e) {
    S = { ok: false, error: (e && e.message) || String(e) };
  }
  render();
}

const ERR_TEXT = {
  cli_missing: "没找到 Paseo 的命令行（CLI）：装官方 Paseo 桌面端，或点「打开安装窗」装一份自建后端。",
  relay_disabled: "这个 Paseo 还没开 relay —— 先点下面的「开启 relay」再出码（relay 走 end-to-end 加密的中继，不需要开端口）。",
  pair_failed: "取配对信息失败，看日志里的 CLI 输出。",
  npm_missing: "本机没有可用的 npm：安装窗会先准备一份真 Node（≥22.19）再用它的 npm。",
  install_failed: "npm 安装失败，看日志与下面的原因。",
  node_too_old:
    "本机 Node 版本太低（要 ≥22.19）：低版本会让 npm 只给 EBADENGINE 警告就放行，装出来的 CLI 跑不起来。装 Node 22+ 后重试，或在安装窗里让插件把托管 Node 装进数据目录。",
  node_install_failed:
    "自动安装 Node 失败（多半是下载不通）：检查网络 / 代理后重试，或自己装 Node 22+（nodejs.org），或改用本机已装的 Paseo。",
  real_node_missing:
    "本机没有可用的真 Node（≥22.19）：桥必须由真 Node 拉起，Electron 自带的那个 Paseo 不认。装上 Node 后重试。",
  no_reuse_cli: "这台机器上没找到别的 Paseo（桌面端 / PATH 都没有）—— 所以只能走「打开安装窗」装自建后端这条路。",
  snippet_missing: "provider 片段算不出来（paseo/bridge-info.js 缺失？）。",
  need_confirm: "需要先确认。",
  app_dir: "不能装在 MTNode 自己的目录里（升级 / 卸载会带走）—— 换一个普通目录。",
  not_writable: "这个目录不可写，换一个。",
  empty_dir: "先选一个安装目录。",
};
function errText(r) {
  const code = String((r && r.error) || "");
  if (code === "install_failed" && r && r.message) return String(r.message) + (r.detail ? "（" + String(r.detail).slice(0, 160) + "）" : "");
  return ERR_TEXT[code] || code || "未知错误";
}
/** 「安装自检没过」的原因（与宿主 installBackend 的 INSTALL_REASON_TEXT 同一套 code） */
const INSTALL_REASON_TEXT = {
  dep_missing: "依赖没落盘：npm 报错或被中途打断。",
  cli_bin_missing: "依赖目录在，但 .bin\\paseo.cmd 没生成（安装不完整）。",
  cli_not_runnable: "CLI 在位但跑不起来（paseo --version 没回版本号）。",
  node_too_old: "这份 CLI 是用旧 Node 装出来 / 正在被旧 Node 跑的（要 ≥22.19）：到安装窗点「重装」，它会先清掉依赖再用真 Node 装回去。",
};

/* ------------------------------------------------------------------ */
/* 渲染                                                                */
/* ------------------------------------------------------------------ */
function render() {
  if (!S) return;
  renderBackend();
  renderPair();
  renderProvider();
  renderRemote();
  renderServer();
}

function row(k, v) {
  return '<div class="row"><span class="k">' + esc(k) + '</span><span class="v">' + v + "</span></div>";
}
function pill(text, kind) {
  return '<span class="pill ' + (kind || "") + '">' + esc(text) + "</span>";
}

/* 「后端」区（本轮共识：**安装控件整块搬进安装窗**，这里只留只读状态 + 两个出口）。
   为什么改：安装 / 重装 / 清干净重装 / 换目录重装 / 装等真 Node / 改用本机已装的 Paseo
   原来全散在这只窗里，与其它 7 个本地后端的「安装窗装、控制台配」两套入口对不上 ——
   现在这一区只做三件事：把后端现状摊开（只读）、开安装窗、启停自建 daemon。 */
function renderBackend() {
  const b = S.backend || {};
  const own = b.mode === "own";
  const out = [];
  out.push(
    row(
      "模式",
      own
        ? pill("插件自带后端", "warn") + ' <span class="tip">（不复用你机器上已装的 Paseo）</span>'
        : pill("复用本机已装的 Paseo", "ok"),
    ),
  );
  if (b.cli) {
    const unrun = !b.version;
    out.push(row("CLI", '<span class="path">' + esc(b.cli) + "</span>"));
    out.push(
      row(
        "来源 / 版本",
        esc(b.cliSource === "desktop" ? "Paseo 桌面端自带" : b.cliSource === "path" ? "PATH" : "插件自装") +
          (b.version ? " · v" + esc(b.version) : "") +
          (unrun ? " " + pill("跑不起来（--version 没回版本号）", "err") : ""),
      ),
    );
  } else {
    out.push(row("CLI", pill("未找到", "err") + ' <span class="tip">点下面的「打开安装窗」装一份自建后端，或先装官方 Paseo 桌面端</span>'));
  }
  out.push(
    row(
      "daemon",
      b.daemon && b.daemon.running
        ? pill("运行中", "ok") +
          " " +
          esc(b.daemon.listen || "") +
          (b.daemon.desktopManaged ? " · 由桌面端托管" : "") +
          /* 本轮口径：自建那份默认由**宿主静默托管**（后台跑、不留终端窗口）。
             不是托管的那份 = 旧方式（自己 detached，Windows 上带一只可见终端窗口）——
             宿主会在开机 / 下次启动时把它静默换掉，这里如实标出来，免得用户以为漏改了。 */
          (own
            ? b.daemon.hosted
              ? " · " + pill("宿主静默托管", "ok")
              : " · " + pill("旧方式（带窗口）", "warn")
            : "") +
          (b.daemon.serverId ? ' · <span class="path">' + esc(b.daemon.serverId) + "</span>" : "")
        : pill("没在跑", own ? "warn" : ""),
    ),
  );
  if (own && b.daemon && b.daemon.running && !b.daemon.hosted) {
    out.push(
      '<p class="tip warn">这份后端是旧方式起的（自己 detached 一个 supervisor，Windows 上会多出一只终端窗口）：' +
        "宿主会在下次启动 / 你点一次「停用后端」再「启用后端」时把它换成<b>宿主静默托管</b>（后台跑、不再留窗口）。" +
        "配对密钥与配置都不动，手机至多瞬断一次。</p>",
    );
  }
  /* 本轮共识：**默认不启用** —— 启用标记是「下次开机会不会自己起这份后端」的唯一依据，
     单独摊一行出来，免得用户看到「没在跑」以为是坏了（没启用本来就不该跑）。 */
  if (own) {
    out.push(
      row(
        "启用标记",
        S.enabled
          ? pill("已启用", "ok") + ' <span class="tip">下次启动 MTNode 会按它自动恢复这份后端</span>'
          : pill("未启用", "warn") + ' <span class="tip">默认不启用：点「启用后端」才会起后端</span>',
      ),
    );
  }
  out.push(row("数据目录", '<span class="path">' + esc(b.home || "") + "</span>"));
  out.push(
    row(
      "relay",
      b.relay ? pill("已开", "ok") : pill("未开", "warn") + ' <span class="tip">未开时出不了配对码</span>',
    ),
  );
  out.push(
    row(
      "桥用 Node",
      '<span class="path">' + esc(b.nodeBin || "") + "</span>" +
        (b.nodeElectronFallback
          ? ' ' + pill("是 Electron 自带 Node（桥要真 Node）", "err")
          : " · " + esc(b.nodeVersion || "")),
    ),
  );
  if (b.nodeElectronFallback) {
    out.push(
      '<p class="tip warn">桥必须由<b>真 Node</b>（≥22.19）拉起：现在只有 Electron 自带的那个，注册上去手机也建不起会话。' +
        "「打开安装窗」跑一次安装就会把托管 Node 装进数据目录（安装步骤里有这一步）。</p>",
    );
  }

  /* 跑 npm / 自建 CLI 用的那份 Node：不达标只如实展示（装它那一步在安装窗里） */
  const nr = b.nodeRuntime || null;
  if (nr && !nr.ready) {
    out.push(
      row(
        "安装用 Node",
        pill("不达标（要 ≥" + esc(nr.min || "22.19.0") + "）", "err") +
          ' <span class="tip">' +
          esc(nr.reason === "too_old" ? "本机这份是 " + (nr.version || "旧版本") : "本机没找到") +
          " · 安装窗会自动装一份托管 Node" +
          "</span>",
      ),
    );
  } else if (nr && nr.ready && own) {
    out.push(row("安装用 Node", '<span class="path">' + esc(nr.bin) + "</span> · " + esc(nr.version || "") + " · " + esc(nr.source || "")));
  }

  /* 自建模式的「装好了没」按**自检**结论显示（CLI 真能跑才算装好），失败原因照实摊开 */
  if (own && b.installCheck) {
    const c = b.installCheck;
    out.push(
      row(
        "安装自检",
        c.reason
          ? pill("未通过", "err") +
            ' <span class="tip">' +
            esc(INSTALL_REASON_TEXT[c.reason] || c.reason) +
            (c.detail ? " · " + esc(String(c.detail).slice(0, 120)) : "") +
            "</span>"
          : pill("通过", "ok") + (c.version ? ' <span class="tip">paseo --version → v' + esc(c.version) + "</span>" : ""),
      ),
    );
    out.push(
      row(
        "依赖目录",
        '<span class="path">' + esc(c.dep || "") + "</span>" + (c.depExists ? "" : ' ' + pill("不在", "err")),
      ),
    );
    if (c.reason === "cli_not_runnable" || c.reason === "node_too_old") {
      out.push(
        '<p class="tip warn">这份依赖跑不起来（多半是旧 Node 装出来的）：点「打开安装窗」→「重装」会先清掉 ' +
          '<span class="path">node_modules</span> 再用真 Node 装回去。</p>',
      );
    }
  }

  /* 唯一入口：安装窗（安装 / 重装 / 清干净重装 / 装等真 Node / 改用本机已装的 Paseo 都在里面） */
  out.push(
    '<div class="row"><button class="mini primary" data-act="open-install">打开安装窗（安装 / 重装 / 卸载）</button></div>',
  );
  out.push(
    '<p class="tip">安装相关的动作都在那只窗里：装自建后端、重装依赖、清干净重装、准备真 Node、' +
      "以及「本机其实装着 Paseo 时改用它」（探测步骤会自己认，想强制自建可在窗里勾选）。</p>",
  );
  if (own && b.installDir) {
    out.push(row("安装目录", '<span class="path">' + esc(b.installDir) + "</span>"));
  }

  /* 启停 = 启用 / 停用（与插件卡片那颗按钮完全等价，本轮共识）：
     启用 = 宿主静默托管起后端（`paseo daemon run`，不留终端窗口）+ 打开远程连接；
     停用 = 优雅停（5 秒）→ 超时按进程树强杀 + 关远程连接 + 清启用标记
     （清掉之后 MTNode 下次启动不会再自己拉起它）。MTNode 退出时自建那份会一起停。 */
  if (own) {
    out.push(
      '<div class="row">' +
        '<button class="mini" data-act="start" ' + (busyBtn ? "disabled" : "") + ">启用后端</button>" +
        '<button class="mini" data-act="stop" ' + (busyBtn ? "disabled" : "") + ">停用后端</button>" +
        "</div>",
    );
    out.push(
      '<p class="tip">默认<b>不启用</b>：只有点这里或插件卡片上的「启用」才会起后端，开机不会自己跑。' +
        "启用 = 后台静默托管（<b>不会再冒出终端窗口</b>）+ 打开远程连接；MTNode 退出时自建后端会一起停" +
        "（要手机随时连着就先别关 MTNode）。意外退出宿主会自动重启，最多 3 次。</p>",
    );
  } else {
    out.push('<p class="tip">复用模式：后端由 Paseo Desktop 自己管，这里没有启停。</p>');
  }
  $("#backend-body").innerHTML = out.join("");
}

function renderPair() {
  const b = S.backend || {};
  const out = [];
  if (!b.cli) {
    out.push('<p class="tip warn">先解决上面的后端（没 CLI 就出不了配对码）。</p>');
    $("#pair-body").innerHTML = out.join("");
    return;
  }
  if (!b.relay) {
    out.push('<p class="tip warn">这个 Paseo 的 relay 是关着的 —— 关着时官方命令会直接报 RELAY_DISABLED，出不了码。</p>');
    out.push(
      '<div class="row"><button class="mini primary" data-act="relay" ' +
        (busyBtn ? "disabled" : "") +
        ">开启 relay（relay.paseo.sh · 端到端加密）</button></div>",
    );
    $("#pair-body").innerHTML = out.join("");
    return;
  }
  if (!PAIR || !PAIR.url) {
    out.push('<p class="tip">生成后会出现一张与 Paseo「配对设备」等价的二维码：手机 Paseo App 里扫它即可。</p>');
    out.push(
      '<div class="row"><button class="mini primary" data-act="pair" ' +
        (busyBtn ? "disabled" : "") +
        ">生成配对二维码</button></div>",
    );
    $("#pair-body").innerHTML = out.join("");
    return;
  }
  out.push('<div class="qrbox">' + qrSvgOf(PAIR.url) + "</div>");
  out.push(
    '<div class="linkline"><input id="pair-url" readonly value="' +
      esc(PAIR.url) +
      '" /><button class="mini" data-act="copy">复制链接</button></div>',
  );
  out.push(
    '<div class="row"><button class="mini" data-act="pair" ' +
      (busyBtn ? "disabled" : "") +
      ">重新生成</button></div>",
  );
  out.push(
    '<p class="tip warn">这张码等同于密码：谁拿到它就能配对到这台机器。官方没给「过期 / 撤销」这回事 —— ' +
      "要作废已经发出去的码，只能用下面的「重置配对凭据」（会作废所有已配对设备，需要重新扫码）。</p>",
  );
  $("#pair-body").innerHTML = out.join("");
}

function renderProvider() {
  const p = S.provider || {};
  const out = [];
  out.push(
    row(
      "状态",
      p.registered
        ? pill("已注册到 Paseo", "ok") + ' <span class="tip">paseo 里新建会话时选「MTNode 会话」</span>'
        : pill("未注册", "warn") + ' <span class="tip">不注册的话，Paseo 里看不到 MTNode 的会话</span>',
    ),
  );
  const btns = [];
  if (p.registered) {
    btns.push('<button class="mini" data-act="provider-apply" ' + (busyBtn ? "disabled" : "") + ">重建注册</button>");
    btns.push('<button class="mini danger" data-act="provider-remove" ' + (busyBtn ? "disabled" : "") + ">从 Paseo 移除</button>");
  } else {
    btns.push('<button class="mini primary" data-act="provider-apply" ' + (busyBtn ? "disabled" : "") + ">注册到 Paseo</button>");
  }
  btns.push('<button class="mini" data-act="bridge-check" ' + (busyBtn ? "disabled" : "") + ">桥自检</button>");
  btns.push(
    '<button class="mini" data-act="bridge-probe-question" ' + (busyBtn ? "disabled" : "") +
      ' title="跑一次「MTNode 发询问卡 → 桥发一条可读消息 → 手机文本作答 → 回执送回 MTNode」，六拍逐个报（手机上询问框不弹 / 答了回不到 MTNode 时用它定位）">提问通道自检</button>',
  );
  out.push('<div class="row">' + btns.join("") + "</div>");
  out.push(row("手机端能选到", bridgeFactsLine()));
  out.push(
    '<p class="tip">手机上的<b>模型</b>与<b>可接管的会话</b>都由桥交出去（模型来自本机的服务商配置，' +
      "会话来自 MTNode 左栏）。这两项在 Paseo 里是「新建会话」时选的；换完 provider 配置后手机端要下拉刷新一次。</p>",
  );
  out.push(
    '<p class="tip"><b>提问通道自检</b>：MTNode 的询问卡走<b>普通聊天消息</b>（' +
      '<span class="path">session/update · agent_message_chunk</span>：题面 / 选项 / 作答方式都是一段可读正文，' +
      "一个 JSON 都不露给手机），用户在手机输入框里回一条消息就是答案（桥把这条回复翻成 " +
      '<span class="path">answers[] + answerText</span> 送回去）——' +
      "自检会把这条链逐拍验一遍（消息发没发对、题面全不全、文本作答有没有回到 MTNode）。" +
      "审批 / 画布确认仍走 <span class=\"path\">session/request_permission</span>（允许 / 拒绝按钮）。" +
      "它<b>不依赖</b>任何客户端能力位：老版本 Paseo（不声明表单问答）拿到的同样是这条可读消息。</p>",
  );
  out.push(
    '<p class="tip">注册 = 往 <span class="path">agents.providers.mtnode</span> 写一条 ACP provider（走官方 CLI，' +
      "官方负责合并并自动 reload）。写入时如果 Paseo 里正有会话在跑，会先问你一次。</p>",
  );
  out.push(
    row(
      "桥脚本",
      '<span class="path">' + esc(p.bridgeScript || "") + "</span>" + (p.bridgeExists ? "" : ' ' + pill("文件不存在", "err")),
    ),
  );
  out.push(row("协议 / 最低版本", "ACP v" + esc(p.protocolVersion || 1) + " · Paseo ≥ " + esc(p.paseoMinVersion || "?")));
  $("#provider-body").innerHTML = out.join("");
}

function renderRemote() {
  const r = S.remote || {};
  const out = [];
  out.push(
    '<div class="switch"><input type="checkbox" id="remote-on" ' +
      (r.enabled ? "checked" : "") +
      (busyBtn ? " disabled" : "") +
      ' /><label for="remote-on">允许远程接管会话（关着时手机发出的任何会话请求都会被拒绝）</label></div>',
  );
  out.push(row("正在接管", r.watchers ? pill(r.watchers + " 条会话", "ok") : pill("无", "")));
  const btns = [];
  btns.push('<button class="mini danger" data-act="disconnect" ' + (busyBtn ? "disabled" : "") + ">断开所有远程设备</button>");
  btns.push('<button class="mini danger" data-act="reset" ' + (busyBtn ? "disabled" : "") + ">重置配对凭据…</button>");
  out.push('<div class="row">' + btns.join("") + "</div>");
  out.push(
    '<p class="tip">「断开」只断 MTNode 这一侧的接管（关总开关 + 收掉所有实时流），手机里的配对凭据还在，重连即可再来。' +
      "「重置配对凭据」重新生成 daemon 密钥 —— <b>所有已配对设备都会失效</b>，要重新扫码；它不动 relay 开关，不影响你在 Paseo 里的其它用途。</p>",
  );
  $("#remote-body").innerHTML = out.join("");
}

function renderServer() {
  const s = S.server || {};
  const out = [];
  out.push(
    row(
      "本机服务端",
      s.enabled
        ? pill("已开启", "ok") + (s.port ? " · 127.0.0.1:" + esc(s.port) : "")
        : pill("未开启", "err") + ' <span class="tip">会话族（读会话 / 发消息 / 接管审批）走它，关着时远程接管用不了</span>',
    ),
  );
  if (!s.enabled) {
    out.push(
      '<div class="row"><button class="mini primary" data-act="server-on" ' +
        (busyBtn ? "disabled" : "") +
        ">一键开启本机服务端</button></div>",
    );
    out.push('<p class="tip">这是 MTNode 自己的设置开关（设置 → 扩展能力管理 → 服务端），这里只替你按一下，不静默改。</p>');
  }
  $("#server-body").innerHTML = out.join("");
}

/* ------------------------------------------------------------------ */
/* 事件                                                                */
/* ------------------------------------------------------------------ */
document.addEventListener("click", async (ev) => {
  const btn = ev.target && ev.target.closest ? ev.target.closest("[data-act]") : null;
  if (!btn) return;
  const act = btn.getAttribute("data-act");
  if (act === "copy") {
    const el = $("#pair-url");
    try {
      await navigator.clipboard.writeText(el ? el.value : "");
      toast("配对链接已复制", "ok");
    } catch {
      if (el) el.select();
      toast("复制失败：请手动选中复制", "err");
    }
    return;
  }
  if (act === "pair") {
    const r = await run("pair", () => window.paseoApi.pair());
    if (r && r.ok) {
      PAIR = { url: r.url, connectionUri: r.connectionUri || "", at: Date.now() };
      toast("二维码已生成", "ok");
    } else {
      PAIR = null;
      toast(errText(r), "err");
    }
    render();
    return;
  }
  if (act === "relay") {
    const r = await run("relay", () => window.paseoApi.enableRelay());
    toast(r && r.ok ? "relay 已开启" : errText(r), r && r.ok ? "ok" : "err");
    await load();
    return;
  }
  if (act === "provider-apply") {
    let r = await run("provider-apply", () => window.paseoApi.providerApply({}));
    if (r && r.error === "need_confirm") {
      const names = (r.names || []).filter(Boolean).join(" / ");
      const ok = window.confirm(
        "Paseo 里现在有 " + r.runningSessions + " 个会话在跑" + (names ? "（" + names + "…）" : "") +
          "。\n写入 provider 会让 Paseo 重新加载配置，可能打断它们。\n\n继续写入吗？",
      );
      if (!ok) return;
      r = await run("provider-apply", () => window.paseoApi.providerApply({ confirm: true }));
    }
    toast(r && r.ok ? "已注册到 Paseo" : errText(r), r && r.ok ? "ok" : "err");
    await load();
    return;
  }
  if (act === "provider-remove") {
    if (!window.confirm("从 Paseo 的配置里移除 MTNode 会话 provider？\n（手机端会看不到 MTNode 会话；已配对的设备不受影响）")) return;
    const r = await run("provider-remove", () => window.paseoApi.providerRemove());
    toast(r && r.ok ? "已移除" : errText(r), r && r.ok ? "ok" : "err");
    await load();
    return;
  }
  if (act === "bridge-check") {
    const r = await run("bridge-check", () => window.paseoApi.bridgeCheck());
    toast(r && r.ok ? "桥自检通过" : "桥自检失败：看日志", r && r.ok ? "ok" : "err");
    /* 自检的输出要看得见：先刷宿主日志（tail 会覆盖文本），再把自检正文接在后面 ——
       只弹一句 toast 等于把排障线索丢掉（这一步的输出正是「接不上 MTNode」时的现场）。 */
    await refreshLog();
    if (r && r.text) appendLocal("[桥自检] " + String(r.text).trim());
    /* 顺手把「模型 N 个 / 可接管会话 M 条」摆到面板上：这两个数就是手机端有没有东西可选的答案 */
    const facts = bridgeFactsOf(r && r.text);
    if (facts) {
      BRIDGE_FACTS = facts;
      renderProvider();
    }
    return;
  }
  if (act === "bridge-probe-question") {
    /* 提问通道自检：跑完六拍才回话（最长两分钟），期间逐行输出已经进了日志窗 */
    const r = await run("probe-question", () => window.paseoApi.bridgeProbeQuestion());
    toast(
      r && r.ok ? "提问通道自检通过" : "提问通道自检没通过：看日志窗最后几行",
      r && r.ok ? "ok" : "err",
    );
    await refreshLog();
    if (r && r.text) appendLocal("[提问通道自检] " + String(r.text).trim());
    return;
  }
  if (act === "disconnect") {
    if (!window.confirm("断开所有远程设备？\n会关掉「远程连接」总开关并收掉所有实时流（配对凭据保留）。")) return;
    const r = await run("disconnect", () => window.paseoApi.disconnectAll());
    toast(r && r.ok ? "已断开（收掉 " + (r.closed || 0) + " 条实时流）" : "断开失败", r && r.ok ? "ok" : "err");
    await load();
    return;
  }
  if (act === "reset") {
    const ok = window.confirm(
      "重置配对凭据？\n\n" +
        "· 会重新生成 daemon 密钥，**所有已配对设备（不只是 MTNode）都会失效**，必须重新扫码；\n" +
        "· 会重启 Paseo daemon；\n" +
        "· 不改 relay 开关。\n\n继续吗？",
    );
    if (!ok) return;
    const r = await run("reset", () => window.paseoApi.resetPairing());
    if (r && r.ok) {
      PAIR = null;
      toast(r.hint || "已重置", "ok");
    } else {
      toast("重置失败：" + errText(r), "err");
    }
    await load();
    return;
  }
  if (act === "server-on") {
    const r = await run("server-on", () => window.paseoApi.serverEnable());
    toast(r && r.ok ? "本机服务端已开启" : "开启失败：" + errText(r), r && r.ok ? "ok" : "err");
    await load();
    return;
  }
  /* 安装窗（安装 / 重装 / 卸载的唯一入口）：宿主那只窗由主进程开，这里只是按一下 */
  if (act === "open-install") {
    const r = await window.paseoApi.openInstall();
    if (!r || !r.ok) toast("打开安装窗失败：" + errText(r), "err");
    return;
  }
  if (act === "start") {
    const r = await run("start", () => window.paseoApi.startDaemon());
    toast(r && r.ok ? "后端已启用" : "启用失败", r && r.ok ? "ok" : "err");
    await load();
    return;
  }
  if (act === "stop") {
    if (!window.confirm("停用 Paseo 后端？\n手机将立刻连不上；远程连接总开关会一起关掉，" +
      "下次启动 MTNode 也不会再自动恢复（要用得再点「启用」）。")) return;
    const r = await run("stop", () => window.paseoApi.stopDaemon());
    toast(r && r.ok ? "已停用" : "停用失败", r && r.ok ? "ok" : "err");
    await load();
    return;
  }
});

document.addEventListener("change", async (ev) => {
  const el = ev.target;
  if (!el || el.id !== "remote-on") return;
  const r = await run("remote", () => window.paseoApi.remoteSet(!!el.checked));
  if (r && r.ok) toast(r.remoteEnabled ? "远程接管已打开" : "远程接管已关闭", "ok");
  await load();
});

$("#btn-refresh").addEventListener("click", () => load());
/* 窗内出口：原生标题栏 X 之外给一颗明确的按钮（后端照常运行，关的只是这只窗） */
$("#btn-close").addEventListener("click", () => {
  try {
    window.paseoApi.close();
  } catch {}
});
$("#btn-clearlog").addEventListener("click", async () => {
  await window.paseoApi.consoleClear();
  $("#log").textContent = "";
});

/* ------------------------------------------------------------------ */
/* 日志                                                                */
/* ------------------------------------------------------------------ */
async function refreshLog() {
  const r = await window.paseoApi.consoleTail(64 * 1024);
  $("#log").textContent = (r && r.text) || "";
  $("#log").scrollTop = $("#log").scrollHeight;
}
window.paseoApi.onConsole((d) => {
  const el = $("#log");
  el.textContent += (d && d.line ? d.line : "") + "\n";
  el.scrollTop = el.scrollHeight;
});
window.paseoApi.onConsoleCleared(() => {
  $("#log").textContent = "";
});
window.paseoApi.onProgress((d) => {
  if (d && d.message) appendLocal("[进度] " + d.message);
});
function appendLocal(line) {
  const el = $("#log");
  el.textContent += line + "\n";
  el.scrollTop = el.scrollHeight;
}

load();
refreshLog();
