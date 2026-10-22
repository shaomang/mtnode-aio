"use strict";
/* Blender 本地插件 · 控制台逻辑
   只做三件事：把宿主 statusForUi 摊成可读的逐项状态 / 转发几颗按钮 / 追日志。
   启停与卸载的口径全在 blender/main-blender.js（这里不重复判断，只显示宿主给的结论）。 */
const api = window.blenderApi || {};
const $ = (id) => document.getElementById(id);

let lastStatus = null;
let busy = "";

function t(s) {
  return String(s == null ? "" : s);
}
function esc(s) {
  return t(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}
function pill(text, cls) {
  return '<span class="pill ' + (cls || "") + '">' + esc(text) + "</span>";
}
function row(k, v) {
  return '<div class="row"><span class="k">' + esc(k) + '</span><span class="v">' + v + "</span></div>";
}
function toast(msg, cls) {
  const el = $("toast");
  el.textContent = t(msg);
  el.className = "toast " + (cls || "");
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => {
    el.hidden = true;
  }, 4200);
}

function render(st) {
  lastStatus = st || {};
  const s = lastStatus;
  const installed = !!s.installed;
  const running = !!s.running;

  /* 状态 */
  const bits = [];
  bits.push(installed ? pill("已安装", "ok") : pill("未安装", "warn"));
  if (running) bits.push(pill("Blender 运行中（插件拉起）", "ok"));
  if (s.userBlenderRunning && !running) bits.push(pill("检测到你手开的 Blender（不会去动它）", "warn"));
  if (s.installing) bits.push(pill("安装中", "warn"));
  if (s.mcpRegistered) bits.push(pill("MCP 已注册", "ok"));
  else bits.push(pill("MCP 未注册", "warn"));
  let html = row("现况", bits.join(" "));
  html += row("Blender 版本", s.blenderVersion ? esc(s.blenderVersion) + ' <span class="path">' + esc(s.blenderExe) + "</span>" : '<span class="tip">未安装</span>');
  if (s.latestSeen) {
    const src = s.latestSource === "builtin" ? "（内置清单 · 非实时最新）" : "（官方目录）";
    html += row("官方最新", esc(s.latestSeen) + ' <span class="tip">' + esc(src) + "</span>");
  }
  html += row("安装目录", s.installDir ? '<span class="path">' + esc(s.installDir) + "</span>" : '<span class="tip">还没设置</span>');
  html += row("MCP", s.mcpRegistered ? "serverName=blender · port=" + esc(s.mcpPort || "?") : '<span class="tip">未写进 cordis-user.yml</span>');
  if (s.lastError) html += row("上次失败", '<span class="tip err">' + esc(s.lastError) + "</span>");
  $("state-body").innerHTML = html;

  /* 依赖逐项 */
  $("deps-body").innerHTML =
    row("Blender", installed ? pill("OK", "ok") + ' <span class="path">' + esc(s.blenderExe) + "</span>" : pill("缺", "err")) +
    row("addon", s.addonInstalled ? pill("OK", "ok") + ' <span class="path">' + esc(s.addonPath) + "</span>" : pill("缺", "err") + ' <span class="tip">mcp-for-blender addon 没落盘</span>') +
    row("uv / uvx", s.uvPath ? pill("OK", "ok") + ' <span class="path">' + esc(s.uvxPath || s.uvPath) + "</span>" : pill("缺", "warn") + ' <span class="tip">装 MCP 服务端时会装</span>') +
    row("端口", esc(s.port || "?"));

  /* 按钮态 */
  const bt = $("btn-toggle");
  bt.textContent = running ? "关闭 Blender" : "启动 Blender";
  bt.disabled = !installed || !!busy || !!s.installing;
  $("btn-smoke").disabled = !installed || !!busy;
  $("btn-update").disabled = !!busy;
  $("btn-install").disabled = !!busy || !!s.installing;
  $("btn-reveal").disabled = !installed;
  $("btn-uninstall").disabled = !!busy;
}

async function refresh() {
  if (!api.getStatus) return;
  try {
    render(await api.getStatus());
  } catch (e) {
    toast("读状态失败：" + ((e && e.message) || e), "err");
  }
}

function withBusy(btn, fn) {
  return async () => {
    if (busy) return;
    busy = btn;
    refresh();
    try {
      await fn();
    } finally {
      busy = "";
      refresh();
    }
  };
}

function appendLog(line) {
  const pre = $("log");
  if (!pre) return;
  const nearBottom = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 40;
  pre.textContent += (pre.textContent ? "\n" : "") + line;
  const lines = pre.textContent.split("\n");
  if (lines.length > 800) pre.textContent = lines.slice(-600).join("\n");
  if (nearBottom) pre.scrollTop = pre.scrollHeight;
}

$("btn-close").onclick = () => (api.close ? api.close() : window.close());
$("btn-refresh").onclick = () => refresh();
$("btn-reveal").onclick = async () => {
  const r = await api.revealInstallDir();
  if (!r || !r.ok) toast("打不开安装目录：" + ((r && (r.message || r.error)) || "未知"), "err");
};
$("btn-toggle").onclick = withBusy("toggle", async () => {
  const running = lastStatus && lastStatus.running;
  const r = running ? await api.stop() : await api.start();
  if (!r || !r.ok) toast((running ? "关闭失败：" : "启动失败：") + ((r && (r.message || r.error)) || "未知"), "err");
  else if (r.stopped === false) toast(r.note || "插件没有拉起 Blender", "");
  else toast(running ? "已关闭插件拉起的 Blender" : "已启动 Blender", "ok");
});
$("btn-smoke").onclick = withBusy("smoke", async () => {
  toast("测试连接：会短暂拉起 Blender，跑到 MCP 握手（可能要 1–3 分钟）…");
  const r = await api.smoke();
  if (r && r.ok) toast("连接正常：MCP 工具 " + r.tools + " 个", "ok");
  else toast("测试连接失败：" + ((r && (r.message || r.error)) || "未知"), "err");
});
$("btn-update").onclick = withBusy("update", async () => {
  const r = await api.checkUpdate();
  if (!r || !r.ok) return toast("查不到官方版本：" + ((r && (r.message || r.error)) || "未知"), "err");
  if (r.newer) toast("官方有新版 " + r.latest + "（你现在 " + (r.current || "未知") + "）。本插件不自动升级。", "warn");
  else toast("已经是最新：" + r.latest, "ok");
  refresh();
});
$("btn-install").onclick = () => api.openInstall && api.openInstall();
$("btn-clearlog").onclick = async () => {
  await api.consoleClear();
  $("log").textContent = "";
};
$("btn-uninstall").onclick = async () => {
  const p = await api.uninstallPreview();
  if (!p || !p.ok) return toast("取卸载预览失败", "err");
  const will = (p.willDelete || []).filter(Boolean).join("\n  ");
  const keep = (p.willKeep || []).filter(Boolean).join("\n  ");
  const size = p.bytes ? "（约 " + Math.round(p.bytes / 1024 / 1024) + " MB）" : "";
  const ok = window.confirm(
    "卸载会删掉这些：\n  " + will + size + "\n\n会保留：\n  " + keep + "\n\n确定卸载？",
  );
  if (!ok) return;
  busy = "uninstall";
  refresh();
  const r = await api.uninstall();
  busy = "";
  if (r && r.ok) {
    toast("已卸载。MTNode 下次启动不再有 blender 工具。", "ok");
    setTimeout(() => (api.close ? api.close() : window.close()), 1200);
  } else {
    toast("卸载有失败项：" + (((r && r.errors) || []).join("；") || "未知"), "err");
    refresh();
  }
};

(async function boot() {
  /* 先取历史再放开实时流：两边都开会在首屏把这段时间的日志各显示一遍 */
  let logReady = false;
  if (api.onConsole) api.onConsole((d) => logReady && d && d.line && appendLog(d.line));
  const tail = await api.consoleTail(200);
  if (tail && tail.lines && tail.lines.length) $("log").textContent = tail.lines.join("\n");
  logReady = true;
  await refresh();
  /* 装了但没注册 MCP（或状态刚变）时，给一句明确的下一步 */
  if (lastStatus && lastStatus.installed && !lastStatus.mcpRegistered) {
    toast("已装 Blender，但 MCP 还没写进配置：点「安装 / 重装」补齐。", "warn");
  }
  setInterval(() => {
    if (!busy) refresh();
  }, 4000);
})();
