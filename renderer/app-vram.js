"use strict";
/* ═══════════════════════════════════════════════════════════════════════════
   本地模型显存释放（renderer/app-vram.js）—— 顶栏入口 + 画布节点运行前后钩子。

   为什么需要它：h3 / music3 / yue / sensenova / llama 各有自己的后端进程，都独占
   同一张卡。历史坑：上一个后端没把显存还回去，下一个后端加载时卡死或 OOM
   （minimax H3 连续运行偶发卡死就是这一类 —— 上一单的模型与残留还挂在卡上）。

   分层（本文件只做「渲染层的那一半」，执行与日志真源在主进程 local-model-vram.js）：
     · 顶栏「性能」按钮 → openPerfPanel()（renderer/app-perf.js）里的「显存与本地模型」
       区块就是下面这个 vramRenderPanel()（它把内容写进 .vram-slot）；
       openVramRelease() 是同一只窗的老入口（单独打开本模块时用），两条路渲染完全一致：
       现况（谁在跑 / 谁占着 / nvidia-smi 读数）+ 一键释放 + 最近释放日志；
     · 画布节点运行前后钩子：vramPreRunNode（先释放**别人**的）/ vramPostRunNode（再释放自己）；
     · 释放失败绝不判本次生成失败：只在按钮处 / 节点状态行给一句提示。
   ═══════════════════════════════════════════════════════════════════════════ */

/* 画布节点 kind → 本地后端 id（哪些节点算「本地模型节点」只看这张表：纯云端节点不参与） */
const VRAM_NODE_BACKEND = {
  video_gen: "h3",
  video_upscale: "h3",
  video_interp: "h3",
  music_gen: "music3",
  yue_gen: "yue",
  sensenova_gen: "sensenova",
};
/* llama（本地大模型）没有画布生成节点：它由会话 / 插件卡片自己用，只在顶栏按钮里释放 */

function vramApi() {
  return (window.api && window.api.vramRelease) || null;
}

/** 本地模型节点 → 它要用哪个本地后端（不在表里 = 不是本地模型节点，返回 ""） */
function vramBackendOfNode(node) {
  if (!node) return "";
  const k = String(node.kind || "");
  if (VRAM_NODE_BACKEND[k]) return VRAM_NODE_BACKEND[k];
  /* 超分 / 补帧节点：kind 由 isVideoPostKind 判定（app-nodes.js 的同一份口径） */
  try {
    if (typeof isVideoPostKind === "function" && isVideoPostKind(node)) return "h3";
  } catch {}
  return "";
}

function vramStepText(step) {
  if (!step) return "";
  const label = String(step.label || step.id || "");
  const act = String(step.action || "");
  if (act === "none") return I18n.t("未在运行") + " · " + label;
  if (act === "busy") return label + "：" + I18n.t("正在跑别的任务，未释放");
  const what =
    act === "soft" ? I18n.t("卸载模型 / 停空闲服务") : I18n.t("结束后端进程");
  const freed =
    step.freedMb == null
      ? I18n.t("显存读数：量不到")
      : (step.freedMb >= 0 ? I18n.t("腾出 ") : I18n.t("增加 ")) + Math.abs(step.freedMb) + "MB";
  return label + "：" + what + " · " + freed + (step.ok ? "" : " · " + I18n.t("有问题"));
}

/** 把释放回执压成一句人话（按钮 toast / 节点状态行共用） */
function vramReceiptText(receipt) {
  const steps = (receipt && receipt.steps) || [];
  if (!steps.length) return I18n.t("没有需要释放的本地模型后端");
  const done = steps.filter((s) => s.action === "soft" || s.action === "hard");
  const busy = steps.filter((s) => s.action === "busy");
  const freed = steps.reduce((n, s) => n + (Number(s.freedMb) > 0 ? Number(s.freedMb) : 0), 0);
  const parts = [];
  if (done.length) {
    parts.push(
      I18n.t("已释放 ") +
        done
          .map((s) => String(s.label || s.id) + "（" + (s.action === "soft" ? I18n.t("卸载") : I18n.t("停进程")) + "）")
          .join("、"),
    );
  }
  if (busy.length) {
    parts.push(
      I18n.t("被占用（正在跑别的任务，等它跑完再释放）：") +
        busy.map((s) => String(s.label || s.id)).join("、"),
    );
  }
  if (!done.length && !busy.length) parts.push(I18n.t("没有在跑的本地模型后端，无需释放"));
  if (freed > 0) parts.push(I18n.t("共腾出约 ") + freed + "MB");
  return parts.join(" · ");
}

/**
 * 顶栏一键释放：释放全部**空闲**的本地模型后端（不打断任何在跑的活）。
 * 忙的后端只回一句「正在跑别的任务」——绝不杀进程，也绝不等（顶栏是用户主动点的即时动作）。
 */
async function vramReleaseIdleFromTopbar() {
  const api = vramApi();
  if (!api) {
    toast(I18n.t("本地模型显存释放不可用（宿主桥未就绪）"), "warn");
    return null;
  }
  const snap = await vramSnapshotSafe();
  const ids = ((snap && snap.backends) || [])
    .filter((b) => b.idleReleasable)
    .map((b) => b.id);
  if (!ids.length) {
    toast(I18n.t("没有空闲的本地模型后端需要释放"), "warn");
    return null;
  }
  toast(I18n.t("正在释放本地模型显存…"), "ok");
  try {
    const r = await api({ ids, phase: "manual", triggeredBy: "topbar" });
    toast(vramReceiptText(r), r && r.ok ? "ok" : "warn");
    return r;
  } catch (e) {
    toast(I18n.t("释放失败：") + ((e && e.message) || e), "err");
    return null;
  }
}

async function vramSnapshotSafe() {
  const fn = window.api && window.api.vramSnapshot;
  if (!fn) return null;
  try {
    return await fn();
  } catch {
    return null;
  }
}

/**
 * 运行前钩子：先释放**其他**本地模型后端（除了本次要用的这个），
 * 让本次要用的后端拿到干净的卡。已有的全局任务锁被别人占着时，主进程会如实回
 * 「被占用」而不动手 —— 这里只提示，绝不因此拦住本次运行。
 */
async function vramPreRunNode(node) {
  const api = vramApi();
  const backend = vramBackendOfNode(node);
  if (!api || !backend) return null;
  try {
    const r = await api({
      except: backend,
      phase: "pre_run",
      jobNodeId: String((node && node.id) || ""),
      triggeredBy: "node_run",
    });
    const busy = ((r && r.steps) || []).filter((s) => s.action === "busy");
    if (busy.length) {
      toast(
        I18n.t("有本地模型正在跑别的任务，本次先不释放它（显存可能不足，建议等它跑完再跑）"),
        "warn",
      );
    }
    return r;
  } catch {
    /* 释放失败一律不判本次运行失败：只写控制台，用户可在顶栏按钮看现况 */
    try {
      console.warn("[vram] pre-run release failed");
    } catch {}
    return null;
  }
}

/** 收尾钩子：释放本次自己用过的后端（上一轮的模型与残留不带进下一轮） */
async function vramPostRunNode(node) {
  const api = vramApi();
  const backend = vramBackendOfNode(node);
  if (!api || !backend) return null;
  try {
    return await api({
      ids: [backend],
      phase: "post_run",
      jobNodeId: String((node && node.id) || ""),
      triggeredBy: "node_run",
    });
  } catch {
    return null;
  }
}

/** 节点状态行后缀：只在真的释放了东西时给一句（正常运行时那一行本来就够长了） */
function vramRunNote(receipt) {
  const steps = (receipt && receipt.steps) || [];
  const hit = steps.filter((s) => s.action === "soft" || s.action === "hard");
  if (!hit.length) return "";
  const freed = steps.reduce((n, s) => n + (Number(s.freedMb) > 0 ? Number(s.freedMb) : 0), 0);
  return I18n.t(" · 已释放显存") + (freed > 0 ? "（" + freed + "MB）" : "");
}

/* ── 顶栏面板：现况 + 一键释放 + 最近日志 ──────────────────────────────── */
let vramReleasedOff = null;

function vramStatusLine(b) {
  if (!b) return "";
  if (!b.running) return I18n.t("未运行");
  return b.busy ? I18n.t("在跑任务中") : I18n.t("已就绪（空闲，可安全释放）");
}

async function vramRenderPanel() {
  const body = document.getElementById("ovBody");
  if (!body) return;
  /* 渲染落点：顶栏装了「性能」面板（renderer/app-perf.js）时写进它留的 .vram-slot；
     没有这个槽（老路径 / 单独打开本窗）就照旧写整只 #ovBody。渲染内容完全一致。 */
  const slot = body.querySelector(".vram-slot") || body;
  const snap = await vramSnapshotSafe();
  if (!snap) {
    slot.innerHTML =
      '<div class="vram-empty">' + I18n.t("本地模型显存释放不可用（宿主桥未就绪）") + "</div>";
    return;
  }
  const gpu = snap.gpu;
  const rows = ((snap.backends || []) || [])
    .map((b) => {
      const cls = !b.running ? "off" : b.busy ? "busy" : "idle";
      return (
        '<div class="vram-row ' +
        cls +
        '">' +
        '<span class="vram-dot"></span>' +
        '<span class="vram-name">' +
        escapeHtml(b.label || b.id) +
        "</span>" +
        '<span class="vram-state">' +
        escapeHtml(vramStatusLine(b)) +
        "</span>" +
        '<span class="vram-port">' +
        (b.port ? ":" + b.port : "") +
        "</span>" +
        "</div>"
      );
    })
    .join("");
  const log = (snap.log || []).slice(-8);
  slot.innerHTML =
    '<div class="vram-panel">' +
    '<div class="vram-gpu">' +
    (gpu
      ? I18n.t("显卡：") +
        escapeHtml(gpu.name || "") +
        " · " +
        I18n.t("已用 ") +
        gpu.usedMb +
        "MB / " +
        gpu.totalMb +
        "MB" +
        "（" + Math.round((gpu.usedMb / Math.max(1, gpu.totalMb)) * 100) + "%）"
      : I18n.t("显卡读数：量不到（nvidia-smi 不可用）—— 释放仍会保守执行")) +
    "</div>" +
    '<div class="vram-list">' +
    (rows || '<div class="vram-empty">' + I18n.t("还没有本地模型后端登记释放能力") + "</div>") +
    "</div>" +
    '<div class="vram-actions">' +
    '<button type="button" class="btn primary" id="vramReleaseAll">' +
    I18n.t("释放全部空闲的本地模型显存") +
    "</button>" +
    '<button type="button" class="btn" id="vramRefresh">' +
    I18n.t("刷新") +
    "</button>" +
    "</div>" +
    '<div class="vram-note">' +
    I18n.t(
      "正在跑任务的后端不会被释放（不打断别人的活）；画布本地模型节点在运行前会自动释放其他后端，收尾再释放自己。",
    ) +
    "</div>" +
    '<div class="vram-log"><b>' +
    I18n.t("最近释放记录") +
    "</b>" +
    (log.length
      ? log
          .map((l) => "<div>" + escapeHtml(String(l).replace(/^\[[^\]]*\]\s*/, "")) + "</div>")
          .join("")
      : "<div>" + I18n.t("暂无记录") + "</div>") +
    "</div>" +
    "</div>";
  const btn = document.getElementById("vramReleaseAll");
  if (btn) {
    btn.onclick = async () => {
      btn.disabled = true;
      await vramReleaseIdleFromTopbar();
      await vramRenderPanel();
      btn.disabled = false;
    };
  }
  const rf = document.getElementById("vramRefresh");
  if (rf) rf.onclick = () => vramRenderPanel();
}

function escapeHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[c]);
}

/**
 * 订阅释放回执（画布节点运行前后也会推）：面板开着就地刷新那一块，关着什么也不做。
 * 幂等 —— 老入口 openVramRelease() 与「性能」面板（renderer/app-perf.js）谁先开都行。
 */
function vramSubscribeReleased() {
  if (vramReleasedOff || !window.api || !window.api.onVramReleased) return;
  vramReleasedOff = window.api.onVramReleased(() => {
    const host = document.getElementById("ovBody");
    if (host && host.querySelector(".vram-panel")) vramRenderPanel();
  });
}

/** 顶栏入口：打开「本地模型显存」面板（持久浮层，不做点外部即关） */
function openVramRelease() {
  if (typeof openOverlay !== "function") return;
  openOverlay(I18n.t("本地模型显存"), { persistent: true });
  const foot = document.getElementById("ovFoot");
  if (foot) {
    foot.innerHTML = "";
    const close = document.createElement("button");
    close.type = "button";
    close.className = "btn";
    close.textContent = I18n.t("关闭");
    close.onclick = () => {
      if (typeof closeOverlay === "function") closeOverlay();
    };
    foot.appendChild(close);
  }
  vramRenderPanel();
  vramSubscribeReleased();
}
