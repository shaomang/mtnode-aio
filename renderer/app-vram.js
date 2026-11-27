"use strict";
/* ═══════════════════════════════════════════════════════════════════════════
   本地模型显存释放（renderer/app-vram.js）—— 顶栏入口 + 画布节点运行前后钩子。

   为什么需要它：h3 / music3 / yue / llama / breeze 各有自己的后端进程，都独占
   同一张卡。历史坑：上一个后端没把显存还回去，下一个后端加载时卡死或 OOM
   （minimax H3 连续运行偶发卡死就是这一类 —— 上一单的模型与残留还挂在卡上）。

   分层（本文件只做「渲染层的那一半」，执行与日志真源在主进程 local-model-vram.js）：
     · 顶栏「性能」按钮 → openPerfPanel()（renderer/app-perf.js）里的「显存与本地模型」
       区块就是下面这个 vramRenderPanel()（它把内容写进 .vram-slot）；
       openVramRelease() 是同一只窗的老入口（单独打开本模块时用），两条路渲染完全一致：
       现况（谁在跑 / 谁占着 / nvidia-smi 读数）+ 一键释放 + 最近释放日志；
     · 画布节点运行前后钩子：vramPreRunNode（先释放**别人**的）/ vramPostRunNode（再释放自己；
       登记了 keepWarmMs 的后端（Breeze 语音、MiniMax H3）收尾改成延迟释放窗口 —— 连续生成直接
       复用已加载的引擎 / 权重，窗口到期或别的后端要显存时才真释放，不再来回卸载 / 载入）；
     · 释放失败绝不判本次生成失败：只在按钮处 / 节点状态行给一句提示。
   ═══════════════════════════════════════════════════════════════════════════ */

/* 画布节点 kind → 本地后端 id（哪些节点算「本地模型节点」只看这张表：纯云端节点不参与） */
const VRAM_NODE_BACKEND = {
  video_gen: "h3",
  video_upscale: "h3",
  video_interp: "h3",
  music_gen: "music3",
  yue_gen: "yue",
  breeze_gen: "breeze",
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
  /* 保持常驻（连续生成不来回卸载 / 载入）—— 没动手释放，如实说清楚 */
  if (act === "warm") return label + "：" + I18n.t("引擎保持常驻，连续生成不重载");
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

/* ── 常驻高占用部件：谁正开着占显存 + 一键关掉 ──────────────────────────────
   与上面的「一键释放空闲显存」互补：那边只放**空闲**的后端（不打断别人的活，忙的一律跳过），
   这边回答的是另一个问题 ——「我明明什么都没跑，显存怎么没了」。答案通常是某个常驻部件：
   MOSS-TTS 语音（随应用内置的 ONNX 后端，不进 vram 注册表，状态与开关各走自己的桥）、
   或 llama 这类「开着就一直占着卡」的本地大模型。
   探测只读，不动任何进程；关掉的动作一律由用户自己点（不替用户杀他正在用的东西）。 */

/** MOSS-TTS 语音在清单里用的合成 id（与 vram 注册表的后端 id 不同名，不会撞） */
const VRAM_MOSS_RESIDENT = "moss-tts";

/**
 * 正在跑且占着显存的常驻部件清单：[{ id, name, running, idleReleasable }]
 *  · MOSS-TTS 走 window.api.mossTtsState().running（它不登记 vram 释放钩子）；
 *  · 其它本地后端走 vramSnapshot() 的 backends（running 且非 busy —— 忙的那些正在跑任务，
 *    不列进来，也就不会被这里关掉）。
 */
async function vramHeavyResidents() {
  const out = [];
  const mossState = window.api && window.api.mossTtsState;
  if (mossState) {
    try {
      const st = await mossState();
      if (st && st.running) {
        out.push({
          id: VRAM_MOSS_RESIDENT,
          name: I18n.t("MOSS-TTS 语音"),
          running: true,
          idleReleasable: true,
        });
      }
    } catch {
      /* 桥读不到就当它没在跑：宁可不列，也不误报一个用户关不掉的东西 */
    }
  }
  const snap = await vramSnapshotSafe();
  ((snap && snap.backends) || []).forEach((b) => {
    if (!b || !b.running || b.busy) return;
    out.push({
      id: String(b.id || ""),
      name: String(b.label || b.id || ""),
      running: true,
      idleReleasable: !!b.idleReleasable,
    });
  });
  return out;
}

/** 把常驻清单压成一句人话：「MOSS-TTS 语音、llama.cpp（本地大模型）正开着，占着显存」 */
async function vramOomHint(residents) {
  const list = Array.isArray(residents) ? residents : await vramHeavyResidents();
  if (!list.length) return "";
  const names = I18n.listJoin(list.map((r) => String((r && (r.name || r.id)) || "")));
  return I18n.t("{names}正开着，占着显存", { names });
}

/**
 * 同一句提醒（显存预检被拦 / 运行期 OOM 共用这一份，别在两处各写一套）：
 * 谁常驻占着显存 + 去哪关。返回 { list, text } —— list 给「关掉它们」用；
 * text 为空 = 没有已知的常驻部件，没什么可提醒的（别凭空编一个「可能有人占着」）。
 * 纯只读探测：这里绝不杀任何正在跑的任务。
 */
async function vramResidentsNotice() {
  const list = await vramHeavyResidents();
  const hint = await vramOomHint(list);
  if (!hint) return { list, text: "" };
  return {
    list,
    text:
      hint +
      "。" +
      I18n.t("先关掉这些再跑：顶栏「性能」面板可以一键关掉它们（正在跑的任务不会被关掉）"),
  };
}

/**
 * 一键关掉常驻部件：moss-tts 走 mossTtsDisable()（关开关 + 停 worker），
 * 其余走 vramRelease({ ids, phase:'manual' })。回逐条结果 [{ id, name, ok, text }]，
 * 单条失败不影响其余几条（用户能看到哪一条没关掉、为什么）。
 * known = 已经拿到的常驻清单（浮层里现成的，省一次探测）。
 */
async function vramReleaseResidents(ids, known) {
  const want = (Array.isArray(ids) ? ids : [ids]).map((x) => String(x || "")).filter(Boolean);
  if (!want.length) return [];
  const list = Array.isArray(known) && known.length ? known : await vramHeavyResidents();
  const nameOf = (id) => {
    const hit = list.find((x) => x && x.id === id);
    return String((hit && hit.name) || id);
  };
  const results = [];

  /* ① MOSS-TTS 语音：没有 soft / hard 钩子，关开关即停 worker（模型随之退出显存） */
  if (want.indexOf(VRAM_MOSS_RESIDENT) >= 0) {
    const off = window.api && window.api.mossTtsDisable;
    let ok = false;
    let why = "";
    if (!off) {
      why = I18n.t("本地模型显存释放不可用（宿主桥未就绪）");
    } else {
      try {
        const r = await off();
        ok = !!(r && r.ok);
        why = String((r && r.error) || "");
      } catch (e) {
        why = String((e && e.message) || e);
      }
    }
    results.push({
      id: VRAM_MOSS_RESIDENT,
      name: nameOf(VRAM_MOSS_RESIDENT),
      ok,
      text: ok ? I18n.t("已关掉") : I18n.t("没关掉：") + why,
    });
  }

  /* ② 其余本地后端：一次下发，回执按 id 摊回逐条 */
  const backendIds = want.filter((id) => id !== VRAM_MOSS_RESIDENT);
  if (backendIds.length) {
    const api = vramApi();
    let steps = [];
    let why = "";
    if (!api) {
      why = I18n.t("本地模型显存释放不可用（宿主桥未就绪）");
    } else {
      try {
        const r = await api({ ids: backendIds, phase: "manual", triggeredBy: "residents" });
        steps = (r && r.steps) || [];
      } catch (e) {
        why = String((e && e.message) || e);
      }
    }
    backendIds.forEach((id) => {
      const st = steps.find((s) => s && String(s.id) === id);
      const done = !!st && (st.action === "soft" || st.action === "hard");
      const freed = st && Number(st.freedMb) > 0 ? "（" + st.freedMb + "MB）" : "";
      results.push({
        id,
        name: nameOf(id),
        ok: done,
        text: done
          ? I18n.t("已释放") + freed
          : st
            ? vramStepText(st)
            : why || I18n.t("没有需要释放的本地模型后端"),
      });
    });
  }
  return results;
}

/** 浮层正文：一句人话 + 逐条「关闭」+ 全部关闭（关掉后就地刷新，不关窗） */
async function vramRenderResidents() {
  const body = document.getElementById("ovBody");
  if (!body) return;
  const list = await vramHeavyResidents();
  const hint = await vramOomHint(list);
  const rows = list
    .map(
      (r) =>
        '<div class="vram-row idle">' +
        '<span class="vram-dot"></span>' +
        '<span class="vram-name">' +
        escapeHtml(r.name || r.id) +
        "</span>" +
        '<span class="vram-state">' +
        escapeHtml(I18n.t("已就绪（空闲，可安全释放）")) +
        "</span>" +
        '<button type="button" class="btn" data-vram-off="' +
        escapeHtml(r.id) +
        '">' +
        I18n.t("关闭") +
        "</button>" +
        "</div>",
    )
    .join("");
  body.innerHTML =
    '<div class="vram-panel">' +
    '<div class="vram-gpu">' +
    (hint || I18n.t("没有常驻占显存的部件")) +
    "</div>" +
    '<div class="vram-list">' +
    rows +
    "</div>" +
    '<div class="vram-actions">' +
    '<button type="button" class="btn primary" id="vramResidentsAll"' +
    (list.length ? "" : " disabled") +
    ">" +
    I18n.t("全部关闭") +
    "</button>" +
    '<button type="button" class="btn" id="vramResidentsRefresh">' +
    I18n.t("刷新") +
    "</button>" +
    "</div>" +
    '<div class="vram-note">' +
    I18n.t("关掉它们，显存立刻还回来（正在跑任务的后端不在这里，不会被关掉；下次用到会重新加载）") +
    "</div>" +
    '<div class="vram-log" id="vramResidentsResult"></div>' +
    "</div>";

  const resultBox = document.getElementById("vramResidentsResult");
  const runRelease = async (ids) => {
    if (!ids.length) return;
    if (resultBox) resultBox.innerHTML = "<div>" + escapeHtml(I18n.t("正在关闭…")) + "</div>";
    const results = await vramReleaseResidents(ids, list);
    const bad = results.filter((r) => !r.ok);
    if (typeof toast === "function") {
      toast(
        bad.length
          ? I18n.t("没关掉：") + bad.map((r) => r.name).join("、")
          : I18n.t("已关掉") + I18n.listJoin(results.map((r) => r.name)),
        bad.length ? "warn" : "ok",
      );
    }
    /* 关掉的从清单里消失，这一轮的逐条结果写在下面那行 */
    await vramRenderResidents();
    const again = document.getElementById("vramResidentsResult");
    if (again) {
      again.innerHTML = results
        .map((r) => "<div>" + escapeHtml(r.name + "：" + r.text) + "</div>")
        .join("");
    }
  };

  const all = document.getElementById("vramResidentsAll");
  if (all) all.onclick = () => runRelease(list.map((r) => r.id));
  const rf = document.getElementById("vramResidentsRefresh");
  if (rf) rf.onclick = () => vramRenderResidents();
  body.querySelectorAll("[data-vram-off]").forEach((btn) => {
    btn.onclick = () => runRelease([String(btn.getAttribute("data-vram-off") || "")]);
  });
}

/** 入口：打开「谁占着显存」浮层（持久浮层 —— 只走窗内按钮 / ✕ / Esc，点外部不关） */
function openVramResidents() {
  if (typeof openOverlay !== "function") return;
  openOverlay(I18n.t("常驻占显存的部件"), { persistent: true });
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
  vramRenderResidents();
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

/** 节点状态行后缀：只在真的释放了东西 / 引擎被保持常驻时给一句（正常运行时那一行本来就够长了） */
function vramRunNote(receipt) {
  const steps = (receipt && receipt.steps) || [];
  const hit = steps.filter((s) => s.action === "soft" || s.action === "hard");
  if (!hit.length) {
    return steps.some((s) => s.action === "warm") ? I18n.t(" · 引擎保持常驻，连续生成不重载") : "";
  }
  const freed = steps.reduce((n, s) => n + (Number(s.freedMb) > 0 ? Number(s.freedMb) : 0), 0);
  return I18n.t(" · 已释放显存") + (freed > 0 ? "（" + freed + "MB）" : "");
}

/* ── 顶栏面板：现况 + 一键释放 + 最近日志 ──────────────────────────────── */
let vramReleasedOff = null;

function vramStatusLine(b) {
  if (!b) return "";
  if (!b.running) return I18n.t("未运行");
  if (b.busy) return I18n.t("在跑任务中");
  /* 常驻窗口内：连续生成直接复用已加载的权重（不来回卸载 / 载入） */
  if (b.keepWarm) return I18n.t("已就绪（常驻中，连续生成不重载）");
  return I18n.t("已就绪（空闲，可安全释放）");
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
