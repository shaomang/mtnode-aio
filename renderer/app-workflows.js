"use strict";

/* ── 工作流库（一颗「节点层」的封装）──────────────────────────────────────
 * 「工作流」= 一颗节点层（kind "super"）连同它的整棵子树：内部节点、内部连线、
 * 外侧端子（由桥接 / 汇流线现算，不另存一份）、封面。它与节点层是**同一个东西** ——
 * 没有新的节点类型，也没有新的执行语义；封装起来的壳插到画布上就能展开、能跑。
 *
 * 本机库：<数据目录>/workflows/<id>.json（见主进程 workflow-store.js）
 *   · 保存入口：节点层头部右键「保存到工作流库」/ 顶栏「工作流库」里从当前画布保存
 *   · 插入：克隆整棵子树（新 id / 标题唯一化 / 连线重建），放在当前视图中心并选中
 *   · 分享：剥掉本机依赖后包成 .mtnodes 交创意工坊（真正上传在 app-store.js 的上传页）
 *
 * 分享硬校验（不是建议）：外侧至少 1 进 1 出 —— 没有端子的壳进了别人的画布只能靠
 * 「改内部图」接线，那就不叫封装好的工作流。本机保存不拦（自己用可以随便）。
 * ─────────────────────────────────────────────────────────────────── */

function workflowApiOk() {
  const a = window.api || {};
  return (
    typeof a.workflowsList === "function" &&
    typeof a.workflowsSave === "function" &&
    typeof a.workflowsGet === "function"
  );
}

/* 端子名：直接问节点自身的端子口径（editPortNameOf 是纯函数，只看节点与序号），
   所以保存下来的端子清单和画布上看到的一字不差；查不到就退回「输入 N」。 */
function workflowPortName(node, dir, idx) {
  try {
    if (typeof editPortNameOf === "function") {
      const nm = String(editPortNameOf(node, dir, idx) || "").trim();
      if (nm) return nm;
    }
  } catch (_) {}
  return (dir === "in" ? I18n.t("输入 ") : I18n.t("输出 ")) + (idx + 1);
}

function workflowPortKind(node, dir, idx) {
  try {
    if (typeof editPortKindOf === "function") {
      const k = String(editPortKindOf(node, dir, idx) || "");
      if (k) return k;
    }
  } catch (_) {}
  return "any";
}

function workflowPortCtrl(node, dir, idx) {
  try {
    if (dir === "in" && typeof inPortIsControl === "function")
      return !!inPortIsControl(node, idx);
  } catch (_) {}
  return false;
}

/* 外侧端子清单：只从**边界桥接 / 汇流线**推出来（与画布 inputCount/outputCount 同一份真源：
   根 shell → 内部节点的线，fromIndex = 外侧输入序号；内部节点 → 根 shell 的线，
   toIndex = 外侧输出序号）。端子名取内部那颗节点对应端子的名字，用户一眼知道它要什么。 */
function workflowPortsFromGraph(graph) {
  const g = graph && typeof graph === "object" ? graph : {};
  const nodes = Array.isArray(g.nodes) ? g.nodes : [];
  const wires = Array.isArray(g.wires) ? g.wires : [];
  const rootId =
    String(g.rootId || "") ||
    (nodes[0] && String(nodes[0].id || "") ? String(nodes[0].id) : "");
  const byId = new Map();
  for (const n of nodes) if (n && n.id) byId.set(String(n.id), n);
  const insMap = new Map();
  const outsMap = new Map();
  for (const w of wires) {
    if (!w) continue;
    const from = String(w.from || "");
    const to = String(w.to || "");
    if (from === rootId && to !== rootId) {
      const child = byId.get(to);
      if (!child) continue;
      const idx = Number(w.fromIndex) || 0;
      const ci = Number(w.toIndex) || 0;
      insMap.set(idx, {
        index: idx,
        name: workflowPortName(child, "in", ci),
        kind: workflowPortKind(child, "in", ci),
        ctrl: workflowPortCtrl(child, "in", ci),
        inner: String(child.title || ""),
      });
    } else if (to === rootId && from !== rootId) {
      const child = byId.get(from);
      if (!child) continue;
      const idx = Number(w.toIndex) || 0;
      const ci = Number(w.fromIndex) || 0;
      outsMap.set(idx, {
        index: idx,
        name: workflowPortName(child, "out", ci),
        kind: workflowPortKind(child, "out", ci),
        ctrl: false,
        inner: String(child.title || ""),
      });
    }
  }
  const sortIdx = (a, b) => a.index - b.index;
  return {
    ins: [...insMap.values()].sort(sortIdx),
    outs: [...outsMap.values()].sort(sortIdx),
    nodeCount: nodes.length,
    wireCount: wires.length,
  };
}

/* ── 中间产物（需要 Agent 跑才产出的中间文件）────────────────────────────
 * 共识口径（见 workflow-store.js 顶部注释）：
 *   · 随工作流包一起走：保存到库里时收集，分享时进 .mtnodes 尾部文件段；
 *   · 插入 / 导入后落到 assets/<画布 id>/artifacts/…，节点字段里记绝对路径；
 *   · 运行时「描述指纹一致 → 直接复用，不重调 LLM；不一致 → 自动带旧文件重生成」。
 * 本段只放渲染层这一侧的口径函数（主进程的收集 / 打包 / 落盘在 workflow-store.js）。 */

/* 描述指纹：FNV-1a 32 位，必须与 workflow-store.js 的 descHashOfText 逐位一致 */
function wfArtifactDescHash(text) {
  const s = String(text == null ? "" : text).replace(/\s+/g, " ").trim();
  if (!s) return "";
  let bytes;
  try {
    bytes = new TextEncoder().encode(s);
  } catch (_) {
    bytes = [];
    for (let i = 0; i < s.length; i++) bytes.push(s.charCodeAt(i) & 0xff);
  }
  let h = 0x811c9dc5;
  for (const b of bytes) {
    h ^= b;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/* 节点「描述文本」：各 kind 取自己那个字段（与主进程 nodeDescText 同一口径） */
function nodeDescriptionText(node) {
  if (!node || typeof node !== "object") return "";
  const cand = [node.text, node.task, node.prompt, node.goal, node.description];
  for (const c of cand) {
    const s = String(c == null ? "" : c).trim();
    if (s) return s;
  }
  return "";
}

/* 节点声明的中间产物（可能是空数组 / 老画布没有这个字段） */
function wfArtifactsOf(node) {
  const list = node && Array.isArray(node.artifacts) ? node.artifacts : [];
  return list.filter((a) => a && typeof a === "object" && a.name);
}

/* 某个角色的产物（remotion 用 role "tsx"；其余节点用 "artifact"） */
function wfArtifactOf(node, role) {
  const want = String(role || "artifact");
  return wfArtifactsOf(node).find((a) => String(a.role || "artifact") === want) || null;
}

/* 命中的产物是否还配得上当前描述：只比描述指纹（用户口径：只看描述文本）。
   descText 显式给了就用它算指纹 —— remotion 的指纹跟着**构建描述**走
   （节点的「功能说明」改几个字不该让包内工程失效）。 */
function wfArtifactMatches(node, art, descText) {
  if (!art) return false;
  const cur = wfArtifactDescHash(
    descText == null ? nodeDescriptionText(node) : String(descText),
  );
  return !!cur && String(art.descHash || "") === cur;
}

/* 读产物正文（文本类；读不到返回 ""） */
async function wfArtifactReadText(art) {
  const p = String((art && art.path) || "").trim();
  if (!p || typeof window.api.fileReadText !== "function") return "";
  try {
    const txt = await window.api.fileReadText(p);
    return typeof txt === "string" ? txt : "";
  } catch (_) {
    return "";
  }
}

/* 重生成后把新文件写进当前画布的产物目录（不覆盖工作流库条目里那份） */
async function wfArtifactWrite(node, name, content) {
  const api = window.api || {};
  const canvasId = String((S.wf && S.wf.id) || "");
  if (!api.workflowsArtifactWrite || !canvasId || !node) return null;
  try {
    const r = await api.workflowsArtifactWrite({
      canvasId,
      nodeId: String(node.id || ""),
      name: String(name || "artifact.txt"),
      content: String(content == null ? "" : content),
    });
    return r && r.ok ? r : null;
  } catch (_) {
    return null;
  }
}

/* 把一次写盘结果记成节点的产物声明（重生成后调用） */
function wfArtifactRemember(node, written, role) {
  if (!node || !written || !written.path) return;
  const list = wfArtifactsOf(node).slice();
  const name = String(written.name || "artifact.txt");
  const next = {
    name,
    role: String(role || "artifact"),
    path: String(written.path),
    bytes: Number(written.bytes) || 0,
    sha1: String(written.sha1 || ""),
    descHash: wfArtifactDescHash(nodeDescriptionText(node)),
    source: "regenerated",
    at: Date.now(),
  };
  const idx = list.findIndex((a) => a.name === name && String(a.role || "artifact") === next.role);
  if (idx >= 0) list[idx] = next;
  else list.push(next);
  node.artifacts = list;
}

/* 从工坊拿到的包带有代码产物时，首次运行前告知一次（用户口径：必须弹窗确认）。
   只问一次：把产物指纹记在节点上，之后同一份产物不再打断。 */
async function wfArtifactAckIfNeeded(node) {
  const list = wfArtifactsOf(node);
  if (!list.length) return true;
  const fromWorkshop = list.some((a) => String(a.origin || "") === "workshop" || String(a.source || "") === "workshop");
  if (!fromWorkshop) return true;
  const sig = list.map((a) => a.name + ":" + (a.sha1 || "")).join("|");
  if (String(node.artifactsAck || "") === sig) return true;
  const ok = await confirmDialog(
    I18n.t(
      "这颗节点带了从工坊下载的中间产物（{names}）。运行时会把它当作合成代码直接使用 —— 只在你信任这份工作流来源时继续。",
      { names: list.map((a) => a.name).join("、").slice(0, 200) },
    ),
    {
      title: I18n.t("包含从工坊带来的代码产物"),
      okText: I18n.t("继续运行"),
      cancelText: I18n.t("取消"),
    },
  );
  if (!ok) return false;
  node.artifactsAck = sig;
  if (typeof scheduleSave === "function") scheduleSave();
  return true;
}

/* 智能节点运行前：把包内产物铺回节点工作目录（不覆盖已有文件，冲突就另存），
   返回写进任务提示的那段说明（没有产物 / 没有目录时回空串）。 */
async function wfArtifactsSeedWorkspace(node) {
  const list = wfArtifactsOf(node);
  if (!list.length) return "";
  let ws = "";
  try {
    ws = String(
      (typeof dshWsOf === "function" ? dshWsOf(node) : "") ||
        (node && (node.workspace || node.agentWorkspace)) ||
        "",
    ).trim();
  } catch (_) {
    ws = "";
  }
  if (!ws) return "";
  try {
    const isDir = typeof window.api.fileIsDir === "function" ? await window.api.fileIsDir(ws) : false;
    if (!isDir) return "";
  } catch (_) {
    return "";
  }
  const landed = [];
  for (const a of list) {
    const src = String(a.path || "").trim();
    if (!src) continue;
    const base = String(a.name || "artifact")
      .split(/[\\/]+/)
      .pop();
    if (!base) continue;
    const dest = String(ws).replace(/[\\/]+$/, "") + "/" + base;
    try {
      const exists = await window.api.fileExists(dest);
      /* 工作目录里已经有同名文件：不覆盖（那是用户 / 上一轮的产出），直接把它列进
         提示里让 agent 复用 —— 不另造 .artifact 副本，免得一轮一轮堆文件。 */
      if (exists) {
        landed.push(dest);
        continue;
      }
      const r = await window.api.fileCopy(src, dest);
      if (r && r.ok === false) continue;
      landed.push(dest);
    } catch (_) {}
  }
  if (!landed.length) return "";
  return (
    I18n.t("【已有的中间产物】下面这些文件是这颗工作流随包带来的中间产物（上一次的产出），优先复用它们，不要在没必要时重写：") +
    "\n" +
    landed.map((p) => "- " + p).join("\n")
  );
}

/* 一次运行是否值得走「铺回工作目录」这条路（避免每轮都白跑文件系统） */
function wfArtifactsNeedSeed(node) {
  return !!(node && wfArtifactsOf(node).length);
}

/* ── 节点设置面板里的「中间产物」区块 ───────────────────────────────────
 * 列出随工作流带过来的中间文件（文件名 / 大小 / 来源）+ 两个动作：
 *   · 重新生成：清掉描述指纹 → 下次运行按「描述不一致」自动带旧文件重生成；
 *   · 剔除：不再复用这份产物（画布上的副本文件不删）。 */
function nsArtifactFields(ctx, node) {
  if (!ctx || !node) return;
  const list = wfArtifactsOf(node);
  ctx.section(I18n.t("中间产物"), {
    tip: I18n.t(
      "保存到工作流库时会按「中间产物规则」从它的工作目录收集（remotion 的合成代码直接从节点字段带走）。\n\n描述指纹一致时运行直接复用这份产物、不再调用模型；描述改过则自动带着它重生成，新文件写进当前画布的产物目录。",
    ),
  });
  if (!list.length) {
    ctx.hint(I18n.t("这颗节点还没有随包带来的中间产物。"));
    return;
  }
  for (const a of list) {
    const row = document.createElement("label");
    row.className = "n-field nsf-span";
    const cap = document.createElement("span");
    cap.textContent = String(a.name || "artifact");
    const box = document.createElement("span");
    box.className = "nsf-ctl";
    box.style.cssText = "display:flex;gap:6px;align-items:center;flex-wrap:wrap";
    const meta = document.createElement("span");
    meta.style.cssText = "font-size:11px;color:var(--muted)";
    const kb = Number(a.bytes) > 0 ? Math.max(1, Math.round(Number(a.bytes) / 1024)) + " KB" : "";
    const role = String(a.role || "artifact");
    meta.textContent =
      kb +
      (role === "tsx" ? " · " + I18n.t("合成代码") : "") +
      (wfArtifactMatches(node, a) ? " · " + I18n.t("与当前描述一致") : " · " + I18n.t("与当前描述不一致"));
    const regen = document.createElement("button");
    regen.type = "button";
    regen.className = "mini";
    regen.textContent = I18n.t("重新生成");
    regen.title = I18n.t("下次运行按新描述以这份文件为参考重新生成（不覆盖工作流库里那份）");
    regen.onclick = () => {
      const at = wfArtifactsOf(node).findIndex((x) => x.name === a.name && x.role === a.role);
      if (at >= 0) {
        const cp = Object.assign({}, node.artifacts[at]);
        cp.descHash = "";
        node.artifacts[at] = cp;
      }
      if (typeof scheduleSave === "function") scheduleSave();
      ctx.commit();
      toast(I18n.t("下次运行会按新描述重新生成这份产物"), "ok");
    };
    const drop = document.createElement("button");
    drop.type = "button";
    drop.className = "mini";
    drop.textContent = I18n.t("剔除");
    drop.title = I18n.t("不再复用这份产物（画布上的副本文件保留）");
    drop.onclick = () => {
      node.artifacts = wfArtifactsOf(node).filter(
        (x) => !(x.name === a.name && String(x.role || "artifact") === role),
      );
      if (typeof scheduleSave === "function") scheduleSave();
      ctx.commit();
    };
    box.append(meta);
    /* 「重新生成」只对合成代码（role=tsx）有意义：智能节点本来就是每轮跑 agent，
       产物由它自己按需重写，没有「重新生成这份文件」这回事。 */
    if (role === "tsx") box.append(regen);
    box.append(drop);
    row.append(cap, box);
    ctx.root.appendChild(row);
  }
}

/* 节点 → 工作流快照（只收这颗壳与它的后代，连线两端都在集合里） */
function workflowGraphFromNode(node) {
  if (!node || node.kind !== "super") return null;
  if (typeof collectWithDescendants !== "function") return null;
  const srcs = collectWithDescendants([node]);
  if (!srcs.length) return null;
  const ids = new Set(srcs.map((n) => n.id));
  const wires = (S.wf.wires || []).filter(
    (w) => ids.has(w.from) && ids.has(w.to),
  );
  return {
    rootId: String(node.id),
    nodes: srcs.map((n) => JSON.parse(JSON.stringify(n))),
    wires: wires.map((w) => JSON.parse(JSON.stringify(w))),
  };
}

/* 端口清单里「端子说明」用的一行文字 */
function workflowPortLine(p, dir) {
  const kindTxt =
    p.kind === "image"
      ? I18n.t("图像")
      : p.ctrl
        ? I18n.t("控制")
        : p.kind === "text"
          ? I18n.t("文本")
          : "";
  return (
    (dir === "in" ? I18n.t("入 ") : I18n.t("出 ")) +
    (p.index + 1) +
    " " +
    String(p.name || "") +
    (kindTxt ? "（" + kindTxt + "）" : "")
  );
}

/* ── 保存：节点层 → 本机工作流库 ─────────────────────────────────────────
 * 默认名 = 壳标题；同名条目先问「覆盖」，只留最新一份（不做版本历史）。 */
async function saveWorkflowFromNode(node, opts) {
  opts = opts || {};
  const api = window.api || {};
  if (!workflowApiOk()) {
    toast(I18n.t("工作流库不可用（本机存储接口未就绪）"), "err");
    return null;
  }
  if (!node || node.kind !== "super") {
    toast(I18n.t("只有节点层可以保存为工作流"), "warn");
    return null;
  }
  const graph = workflowGraphFromNode(node);
  if (!graph) {
    toast(I18n.t("这颗节点层还没有内部节点，无法保存为工作流"), "warn");
    return null;
  }
  const name = String(
    await promptDialog(
      I18n.t("工作流名（在本机库里用它辨认这颗节点层）："),
      String(node.title || "").trim() || I18n.t("工作流"),
      { title: I18n.t("保存到工作流库"), okText: I18n.t("保存") },
    ) || "",
  ).trim();
  if (!name) return null;

  /* 同名 → 覆盖确认 */
  let existId = "";
  try {
    const r = await api.workflowsList();
    const list = (r && r.ok && r.lists) || (r && r.ok && r.workflows) || [];
    const hit = list.find((w) => String(w.name || "") === name);
    if (hit) existId = String(hit.id || "");
  } catch (_) {}
  if (existId) {
    const sure = await confirmDialog(
      I18n.t("工作流库里已有同名条目「{name}」。\n\n覆盖它会用当前画布这颗节点层的快照替换它（只留最新一份，没有历史版本）。继续？", {
        name: name,
      }),
      { title: I18n.t("覆盖工作流"), okText: I18n.t("覆盖"), cancelText: I18n.t("取消") },
    );
    if (!sure) return null;
  }

  const ports = workflowPortsFromGraph(graph);
  const res = await api.workflowsSave({
    id: existId || "",
    name: name,
    description: String(node.note || "").trim(),
    version: String(opts.version || "1.0"),
    cover: typeof node.bgImage === "string" ? node.bgImage : "",
    /* 当前画布 id：主进程会把中间产物同时铺一份到画布产物目录，
       下面据此把绝对路径回写到节点上（画布这份与包内那份内容一致）。 */
    canvasId: String((S.wf && S.wf.id) || ""),
    graph: graph,
  });
  if (!res || !res.ok) {
    toast(I18n.t("保存失败：") + ((res && res.error) || ""), "err");
    return null;
  }
  /* 中间产物：把包内那份的落点写回节点（同一颗节点层里的节点 id 与快照一致） */
  const canvasArts = Array.isArray(res.canvasArtifacts) ? res.canvasArtifacts : [];
  if (canvasArts.length) {
    const byNode = new Map();
    for (const a of canvasArts) {
      if (!a || !a.nodeId) continue;
      if (!byNode.has(a.nodeId)) byNode.set(a.nodeId, []);
      byNode.get(a.nodeId).push({
        name: String(a.name || ""),
        role: String(a.role || "artifact"),
        path: String(a.path || ""),
        bytes: Number(a.bytes) || 0,
        sha1: String(a.sha1 || ""),
        descHash: String(a.descHash || ""),
        source: "workflow",
      });
    }
    const srcs =
      typeof collectWithDescendants === "function" ? collectWithDescendants([node]) : [];
    for (const n of srcs) {
      const list = byNode.get(String(n.id));
      if (list && list.length) n.artifacts = list;
    }
    if (typeof scheduleSave === "function") scheduleSave();
  }
  const stored = Array.isArray(res.artifacts) ? res.artifacts : [];
  const warns = Array.isArray(res.warnings) ? res.warnings : [];
  const warn =
    ports.ins.length && ports.outs.length
      ? ""
      : I18n.t("（提示：这颗壳没有完整的外侧端子，别人插入后得先接内部图）");
  const artTxt = stored.length
    ? I18n.t("（含 ") + stored.length + I18n.t(" 个中间产物）")
    : "";
  toast(I18n.t("已保存到工作流库：") + name + artTxt + warn, "ok");
  if (warns.length)
    toast(
      I18n.t("有 ") +
        warns.length +
        I18n.t(" 个文件因超出体积上限没有收进包内（可在「中间产物规则」里放宽）"),
      "warn",
    );
  return { id: res.id, name: name, ports: ports, artifacts: stored };
}

/* ── 插入：本机库条目 → 当前画布 ───────────────────────────────────────
 * 与「工具库插入」同一套克隆口径：新 id、标题唯一化、父子归属与连线重建；壳默认折叠。 */
function workflowViewCenterWf() {
  const cv = document.getElementById("canvas");
  const vw = cv ? cv.clientWidth : window.innerWidth;
  const vh = cv ? cv.clientHeight : window.innerHeight;
  const z = S.cam && S.cam.z > 0 ? S.cam.z : 1;
  return {
    x: (vw / 2 - (S.cam ? S.cam.x : 0)) / z,
    y: (vh / 2 - (S.cam ? S.cam.y : 0)) / z,
  };
}
async function insertWorkflowToCanvas(entry) {
  if (!S.wf || !Array.isArray(S.wf.nodes)) {
    toast(I18n.t("请先打开一个画布"), "warn");
    return false;
  }
  let pkg = entry;
  const api = window.api || {};
  if (pkg && pkg.id && !pkg.graph) {
    try {
      const r = await api.workflowsGet(pkg.id);
      if (r && r.ok && r.workflow) pkg = r.workflow;
    } catch (_) {}
  }
  const g = (pkg && pkg.graph) || {};
  const nodes = Array.isArray(g.nodes) ? g.nodes : [];
  if (!nodes.length) {
    toast(I18n.t("工作流内容为空，无法插入"), "err");
    return false;
  }
  pushHistory();
  const { cps, idMap } = cloneNodesDeep(nodes, {
    keepOrphanParent: false,
    uniqueTitle: true,
  });
  if (!cps.length) {
    toast(I18n.t("工作流内容为空，无法插入"), "err");
    return false;
  }
  const wireCps = cloneWiresForSet(Array.isArray(g.wires) ? g.wires : [], idMap);
  const innerSids = copiedSuperIdsOf(cps);

  /* 中间产物：把库条目里那份铺到当前画布的产物目录，并写回克隆出来的节点
     （相对路径一律改写成新画布下的绝对路径；清单里的原节点 id 经 idMap 换键） */
  const wfId = String((pkg && pkg.id) || "");
  const canvasId = String((S.wf && S.wf.id) || "");
  if (wfId && canvasId && typeof api.workflowsArtifactsMaterialize === "function") {
    try {
      const r = await api.workflowsArtifactsMaterialize({ workflowId: wfId, canvasId: canvasId });
      if (r && r.ok && r.byNode) {
        const byNew = new Map(cps.map((n) => [String(n.id), n]));
        for (const [oldId, list] of Object.entries(r.byNode)) {
          const nid = idMap.get(oldId) || "";
          const target = byNew.get(String(nid));
          if (target && Array.isArray(list) && list.length) target.artifacts = list;
        }
      }
    } catch (_) {}
  }

  /* 落点：当前视图中心（与粘贴落点同一套相机换算），并按网格对齐 */
  const c = workflowViewCenterWf();
  const gs = typeof grid === "function" ? grid() : 16;
  const rootId0 = String(g.rootId || "");
  const ri0 = nodes.findIndex((n) => n && String(n.id || "") === rootId0);
  const base = cps[ri0 >= 0 ? ri0 : 0] || cps[0];
  const bx = base && isFinite(Number(base.x)) ? Number(base.x) : 0;
  const by = base && isFinite(Number(base.y)) ? Number(base.y) : 0;
  const dx = c && isFinite(c.x) ? c.x - bx : gs * 4;
  const dy = c && isFinite(c.y) ? c.y - by : gs * 4;
  for (const cp of cps) {
    /* 壳内部节点用内部坐标系：只挪顶层（父级不在本批里的那几颗） */
    if (cp.parentSuperId && innerSids.has(cp.parentSuperId)) continue;
    cp.x = snap((Number(cp.x) || 0) + dx);
    cp.y = snap((Number(cp.y) || 0) + dy);
  }
  const taskFocus = currentTaskFocus();
  const superFocus = currentSuperFocus();
  const rootCp = cps[ri0 >= 0 ? ri0 : 0] || cps[0];
  rootCp.parentTaskId = taskFocus || "";
  rootCp.parentSuperId = superFocus || "";

  S.wf.nodes.push(...cps);
  if (wireCps.length) S.wf.wires.push(...wireCps);
  for (const cp of cps) {
    if (cp.kind === "super") cp.superOpen = false;
    if (cp.kind === "task" && typeof ensureTaskScaffold === "function") {
      try {
        ensureTaskScaffold(cp);
      } catch (_) {}
    }
  }
  S.selSet = new Set(cps.map((x) => x.id));
  S.sel = rootCp.id;
  S.selGroup = null;
  S.selWire = null;
  S.selMark = null;
  if (S.selMarkSet) S.selMarkSet.clear();
  renderCanvas();
  scheduleSave(true);
  renderStatus();
  toast(
    I18n.t("已插入工作流：") + (pkg.name || rootCp.title || ""),
    "ok",
  );
  return true;
}

/* ── 分享前的剥离（硬规则 · 一条都不能省）──────────────────────────────
 * 别人的画布上没有你的本机环境，所以：
 *   ① 本机绝对路径与工作目录 → 清空（含 devPath / 素材绑定 / 数据库本机目录）
 *   ② 跨画布依赖 → 外部输入只能走外侧端子：清掉画布级 @引用 与全局广播
 *   ③ 输出保存路径 → 改成相对 output/<文件名>
 *   ④ 密钥 / 本机模型与后端路径 → 清空
 *   ⑤ 打断点、运行态残留（running / error / 缓存结果）→ 清掉
 * 只改传出去的副本，本机库里的条目原样不动。 */
function workflowLooksAbsolutePath(v) {
  const s = String(v || "").trim();
  if (!s) return false;
  if (/^[A-Za-z]:[\\/]/.test(s)) return true;
  if (/^\\\\/.test(s)) return true;
  if (/^file:\/\//i.test(s)) return true;
  if (/^\/(home|root|Users|mnt|opt|content|data|srv)\//.test(s)) return true;
  return false;
}

function workflowRelOutPath(v) {
  const s = String(v || "").trim();
  if (!s) return "";
  const parts = s.split(/[\\/]+/).filter(Boolean);
  const base = parts.length ? parts[parts.length - 1] : "";
  return base ? "output/" + base : "";
}

/* 一条 @标题 引用里，把指向「不在包内」的标题去掉（跨画布依赖就是这么漏进来的） */
function workflowStripExternalRefs(text, titles) {
  let s = String(text || "");
  if (!s || !titles || !titles.size) return s;
  return s.replace(/@([^\s@，。、；：,.;:!?()（）\[\]【】"'「」]+)/g, (m, name) => {
    const t = String(name);
    if (titles.has(t)) return m;
    /* 也可能引的是标签名：标签在包内的保留 */
    if (titles.has("#" + t)) return m;
    return "";
  });
}

const WORKFLOW_SHARE_DROP_FIELDS = [
  "workspace",
  "agentWorkspace",
  "devPath",
  "toolLibId",
  "assetId",
  "assetRoot",
  "dbPath",
  "dbDir",
  "dbSrcPath",
  "dbNodeId",
  "localDir",
  "modelPath",
  "backendUrl",
  "backend",
  "apiKey",
  "apiBase",
  "baseUrl",
  "h3WorkflowId",
  "workflowId",
  "_cache",
  "_agentCallArgs",
  "_runState",
];

function workflowStripForShare(graph) {
  const src = graph || {};
  const nodes = Array.isArray(src.nodes) ? src.nodes : [];
  const titles = new Set();
  for (const n of nodes) {
    const t = String((n && n.title) || "").trim();
    if (t) titles.add(t);
    const tg = Array.isArray(n && n.tags) ? n.tags : [];
    for (const x of tg) if (x) titles.add("#" + String(x));
  }
  const nodesOut = nodes.map((n) => {
    const cp = JSON.parse(JSON.stringify(n || {}));
    for (const k of WORKFLOW_SHARE_DROP_FIELDS) delete cp[k];
    /* 画布级引用 / 全局广播：跨画布就失效，一律关掉 */
    cp.globalRefs = false;
    cp.running = false;
    cp.error = "";
    cp.resultText = "";
    cp.taskRunState = "";
    /* 保存 / 媒体输出：改相对路径，落到对方自己的输出目录 */
    if (cp.kind === "save" || cp.kind === "save_text" || cp.kind === "save_image" || cp.kind === "save_pdf") {
      cp.savePath = workflowRelOutPath(cp.savePath);
    }
    if (cp.outputPath) cp.outputPath = workflowRelOutPath(cp.outputPath);
    /* 其余字符串字段里混着的本机绝对路径：清空（不猜、不改成看似能用的假路径） */
    for (const [k, v] of Object.entries(cp)) {
      if (typeof v !== "string") continue;
      if (k === "bgImage") continue;
      if (workflowLooksAbsolutePath(v)) cp[k] = "";
    }
    /* @引用：只保留包内标题（跨画布依赖的第 2 条入口） */
    for (const k of ["prompt", "task", "goal", "text", "note", "description", "instruction", "style", "lyrics", "abc", "systemPrompt"]) {
      if (typeof cp[k] === "string" && cp[k].indexOf("@") >= 0)
        cp[k] = workflowStripExternalRefs(cp[k], titles);
    }
    if (cp.toolConfig && typeof cp.toolConfig === "object") {
      cp.toolConfig = JSON.parse(JSON.stringify(cp.toolConfig));
      for (const k of ["presets", "testInputs"]) delete cp.toolConfig[k];
    }
    if (Array.isArray(cp.marks)) delete cp.marks;
    /* 中间产物：包里带的是文件本体（见主进程 packWorkflow 的文件段），节点上只留
       清单（名字 / 角色 / 指纹），本机绝对路径一律不带出去（别人插入时按包重映射）。 */
    if (Array.isArray(cp.artifacts)) {
      cp.artifacts = cp.artifacts
        .filter((a) => a && typeof a === "object" && a.name)
        .map((a) => ({
          name: String(a.name || ""),
          role: String(a.role || "artifact"),
          bytes: Number(a.bytes) || 0,
          sha1: String(a.sha1 || ""),
          descHash: String(a.descHash || ""),
          origin: String(a.origin || ""),
        }));
      if (!cp.artifacts.length) delete cp.artifacts;
    }
    delete cp.artifactsAck;
    return cp;
  });
  const wires = (Array.isArray(src.wires) ? src.wires : []).map((w) => {
    const cp = JSON.parse(JSON.stringify(w || {}));
    delete cp.running;
    delete cp.error;
    delete cp._cache;
    return cp;
  });
  return { rootId: String(src.rootId || ""), nodes: nodesOut, wires: wires };
}

/* ── 分享：本机库条目 / 画布上的节点层 → 工坊上传页 ───────────────────── */
async function shareWorkflowToWorkshop(target) {
  const api = window.api || {};
  if (!workflowApiOk() || typeof api.workflowsExportBase64 !== "function") {
    toast(I18n.t("工作流库不可用（本机存储接口未就绪）"), "err");
    return false;
  }
  let id = "";
  if (target && typeof target === "object" && target.kind === "super") {
    const saved = await saveWorkflowFromNode(target, { version: "1.0" });
    if (!saved) return false;
    id = saved.id;
  } else if (typeof target === "string") {
    id = target;
  } else if (target && target.id) {
    id = String(target.id);
  }
  if (!id) {
    toast(I18n.t("请先选择一条工作流"), "warn");
    return false;
  }
  const r = await api.workflowsGet(id);
  if (!r || !r.ok || !r.workflow) {
    toast(I18n.t("读取工作流失败：") + ((r && r.error) || ""), "err");
    return false;
  }
  const entry = r.workflow;
  const ports = workflowPortsFromGraph(entry.graph);
  /* 分享硬校验：外侧至少 1 进 1 出（没有端子的壳换个人就得改内部图） */
  if (!ports.ins.length || !ports.outs.length) {
    toast(
      I18n.t("无法分享：这颗节点层至少要有 1 个外侧输入和 1 个外侧输出（内部节点用桥接线 / 汇流线接到壳上）"), "err",
    );
    return false;
  }
  const stripped = workflowStripForShare(entry.graph);
  let pack;
  try {
    pack = await api.workflowsExportBase64(id, stripped);
  } catch (e) {
    pack = null;
  }
  if (!pack || !pack.ok || !pack.base64) {
    toast(I18n.t("打包失败：") + ((pack && pack.error) || ""), "err");
    return false;
  }
  const payload = {
    sourceId: id,
    title: String(entry.name || ""),
    description: String(entry.description || ""),
    version: String(entry.version || "1.0"),
    fileBase64: pack.base64,
    ports: {
      ins: ports.ins.map((p) => ({ index: p.index, name: p.name, kind: p.kind, ctrl: !!p.ctrl })),
      outs: ports.outs.map((p) => ({ index: p.index, name: p.name, kind: p.kind, ctrl: false })),
      nodeCount: ports.nodeCount,
    },
  };
  if (typeof openWorkflowUpload === "function") return openWorkflowUpload(payload);
  toast(I18n.t("创意工坊的上传页还没就绪（renderer/app-store.js 未加载）"), "err");
  return false;
}

/* ── 中间产物规则（全局一份：扩展名白名单 + 体积上限）────────────────────
 * 保存工作流时按这份规则从节点工作目录里收集中间文件；分享时按同一份清洗 /
 * 限流（主进程 workflow-store.js 的 readArtifactRules）。 */
async function openWorkflowArtifactRules() {
  const api = window.api || {};
  if (typeof api.workflowsArtifactRules !== "function") {
    toast(I18n.t("工作流库不可用（本机存储接口未就绪）"), "err");
    return;
  }
  let rules = {};
  try {
    const r = await api.workflowsArtifactRules();
    rules = (r && r.rules) || {};
  } catch (_) {}
  openOverlay(I18n.t("中间产物规则"));
  overlayPersistent = true;
  const body = document.getElementById("ovBody");
  if (!body) return;
  body.innerHTML = "";
  const wrap = document.createElement("div");
  wrap.style.cssText = "display:flex;flex-direction:column;gap:12px;line-height:1.7";

  const hint = document.createElement("div");
  hint.style.cssText = "color:var(--muted);font-size:12px";
  hint.textContent = I18n.t(
    "需要 Agent 跑才能产出的中间文件（如 remotion 的 Composition.tsx）会按这里的白名单随工作流一起打包。扩展名用逗号分隔，可写 .tsx 或 tsx。",
  );

  const extLbl = document.createElement("div");
  extLbl.textContent = I18n.t("收集的扩展名：");
  const extInput = document.createElement("textarea");
  extInput.style.cssText =
    "width:100%;min-height:88px;resize:vertical;font-family:var(--mono,monospace);font-size:12px";
  extInput.value = (Array.isArray(rules.ext) ? rules.ext : []).join(", ");

  const sizeRow = document.createElement("div");
  sizeRow.style.cssText = "display:flex;gap:12px;flex-wrap:wrap;align-items:center";
  const mkSize = (label, val) => {
    const box = document.createElement("label");
    box.style.cssText = "display:flex;gap:6px;align-items:center";
    const sp = document.createElement("span");
    sp.textContent = label;
    const inp = document.createElement("input");
    inp.type = "number";
    inp.min = "1";
    inp.style.cssText = "width:88px";
    inp.value = String(Math.max(1, Math.round((Number(val) || 0) / 1024 / 1024)));
    box.append(sp, inp);
    const unit = document.createElement("span");
    unit.textContent = "MB";
    box.appendChild(unit);
    return { box, inp };
  };
  const totalBox = mkSize(I18n.t("总量上限"), rules.maxTotalBytes);
  const fileBox = mkSize(I18n.t("单文件上限"), rules.maxFileBytes);
  sizeRow.append(totalBox.box, fileBox.box);

  const btnRow = document.createElement("div");
  btnRow.style.cssText = "display:flex;gap:8px;justify-content:flex-end";
  const resetBtn = document.createElement("button");
  resetBtn.type = "button";
  resetBtn.className = "mini";
  resetBtn.textContent = I18n.t("恢复默认");
  resetBtn.onclick = () => {
    const def = (rules.defaults && rules.defaults.ext) || [];
    extInput.value = def.join(", ");
    totalBox.inp.value = "64";
    fileBox.inp.value = "8";
  };
  const saveBtn = document.createElement("button");
  saveBtn.type = "button";
  saveBtn.className = "mini primary";
  saveBtn.textContent = I18n.t("保存规则");
  saveBtn.onclick = async () => {
    const ext = String(extInput.value || "")
      .split(/[,，\s]+/)
      .map((s) => s.trim().replace(/^\./, "").toLowerCase())
      .filter(Boolean);
    if (!ext.length) {
      toast(I18n.t("扩展名不能全空（否则收集不到任何中间产物）"), "warn");
      return;
    }
    const r = await api.workflowsArtifactRules({
      ext: ext,
      maxTotalBytes: Math.max(1, Number(totalBox.inp.value) || 64) * 1024 * 1024,
      maxFileBytes: Math.max(1, Number(fileBox.inp.value) || 8) * 1024 * 1024,
    });
    if (r && r.ok) {
      toast(I18n.t("中间产物规则已保存"), "ok");
      closeOverlay();
    } else toast(I18n.t("保存失败：") + ((r && r.error) || ""), "err");
  };
  btnRow.append(resetBtn, saveBtn);

  wrap.append(hint, extLbl, extInput, sizeRow, btnRow);
  body.appendChild(wrap);
}

/* 顶栏「工作流库」对话框：本机清单 + 从当前画布保存 ─────────────────── */
function openWorkflowLibrary() {
  if (!workflowApiOk()) {
    toast(I18n.t("工作流库不可用（本机存储接口未就绪）"), "err");
    return;
  }
  openOverlay(I18n.t("工作流库"));
  const box = document.querySelector("#overlay .overlay-box");
  if (box) box.classList.add("wide");
  overlayPersistent = true;
  const body = document.getElementById("ovBody");
  body.innerHTML = "";
  const wrap = document.createElement("div");
  wrap.style.cssText = "display:flex;flex-direction:column;gap:10px;min-height:0";

  /* 顶部：从当前画布保存（下拉里只列节点层） */
  const saveRow = document.createElement("div");
  saveRow.style.cssText =
    "display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding-bottom:10px;border-bottom:1px solid var(--bd)";
  const saveLbl = document.createElement("span");
  saveLbl.textContent = I18n.t("从当前画布保存：");
  saveLbl.title = I18n.t("工作流 = 一颗节点层及其内部全部节点 —— 选中它就能存成可复用的封装");
  const sel = document.createElement("select");
  sel.id = "wfLibCanvasSel";
  sel.style.cssText = "max-width:320px;flex:1;min-width:180px";
  const saveBtn = document.createElement("button");
  saveBtn.type = "button";
  saveBtn.className = "mini primary";
  saveBtn.textContent = I18n.t("保存到工作流库");
  const rulesBtn = document.createElement("button");
  rulesBtn.type = "button";
  rulesBtn.className = "mini";
  rulesBtn.textContent = I18n.t("中间产物规则…");
  rulesBtn.title = I18n.t(
    "配置哪些扩展名的中间文件随工作流一起打包（全局一份：扩展名白名单 + 体积上限）",
  );
  rulesBtn.onclick = () => openWorkflowArtifactRules();
  saveRow.append(saveLbl, sel, saveBtn, rulesBtn);

  const listHost = document.createElement("div");
  listHost.id = "wfLibList";
  listHost.style.cssText =
    "display:flex;flex-direction:column;gap:8px;overflow:auto;min-height:0;flex:1";

  wrap.append(saveRow, listHost);
  body.appendChild(wrap);

  const supers = (S.wf && S.wf.nodes ? S.wf.nodes : []).filter(
    (n) => n && n.kind === "super" && !isSuperIoNode(n),
  );
  const fillSel = () => {
    sel.innerHTML = "";
    if (!supers.length) {
      const o = document.createElement("option");
      o.value = "";
      o.textContent = I18n.t("当前画布没有节点层");
      sel.appendChild(o);
      sel.disabled = true;
      saveBtn.disabled = true;
      return;
    }
    sel.disabled = false;
    saveBtn.disabled = false;
    for (const n of supers) {
      const o = document.createElement("option");
      o.value = n.id;
      const kids = superChildrenOf(n.id).filter((c) => !isSuperIoNode(c)).length;
      o.textContent =
        (n.title || I18n.t("（未命名节点层）")) + " · " + kids + I18n.t(" 个内部节点");
      sel.appendChild(o);
    }
    if (S.sel && supers.some((n) => n.id === S.sel)) sel.value = S.sel;
  };
  fillSel();
  saveBtn.onclick = async () => {
    const n = nodeById(sel.value);
    if (!n) {
      toast(I18n.t("没找到这颗节点层（可能已被删除）"), "warn");
      return;
    }
    const saved = await saveWorkflowFromNode(n);
    if (saved) renderWorkflowLibList(listHost);
  };

  renderWorkflowLibList(listHost);
}

/* 库里那一行的封面小图：清单条目只报 hasCover（不回 dataURL），要单独 get 一次。
 * 一条 512KB 的封面 × 几十行 = 一开窗就几十次 IPC，所以先进视口再取。 */
let _wfThumbIO = null;
const _wfThumbWatched = new Set();
/* 元素 → 工作流 id：观察回调只拿得到 target，id 必须登记在它身上（WeakMap，元素拆了自动回收）。
   不能只靠 dataset —— 之前就是把 id 写在**行**上、回调却从**小图**上读，取到空串，
   于是「有封面的工作流在库里永远是一块空底」。 */
const _wfThumbIds = new WeakMap();

function workflowLoadThumb(el, id) {
  if (!el || !id) return;
  window.api
    .workflowsGet(id)
    .then((r) => {
      const img = r && r.ok && r.workflow && r.workflow.cover;
      /* 元素可能已经被重绘换掉：只在它还挂着时写地址（旧行上写等于图跑到别处） */
      if (img && /^data:image\//.test(img) && el.isConnected) {
        el.style.backgroundImage = 'url("' + img + '")';
      }
    })
    .catch(() => {});
}

function workflowThumbWatch(el, id) {
  if (!el || !id) return;
  _wfThumbIds.set(el, String(id));
  if (typeof el.dataset === "object" && el.dataset)
    el.dataset.workflowId = String(id);
  if (typeof IntersectionObserver !== "function") {
    workflowLoadThumb(el, id);
    return;
  }
  if (!_wfThumbIO) {
    _wfThumbIO = new IntersectionObserver(
      (ents) => {
        for (const e of ents) {
          if (!e.isIntersecting) continue;
          _wfThumbIO.unobserve(e.target);
          _wfThumbWatched.delete(e.target);
          const wid =
            _wfThumbIds.get(e.target) ||
            (e.target && e.target.dataset ? e.target.dataset.workflowId : "");
          if (wid) workflowLoadThumb(e.target, wid);
        }
      },
      { rootMargin: "120px" },
    );
  }
  _wfThumbWatched.add(el);
  _wfThumbIO.observe(el);
}

/* 重绘前把上一批观察作废（行要拆了，留着只会往拆掉的元素上写） */
function workflowThumbFlush() {
  if (_wfThumbIO) for (const el of _wfThumbWatched) _wfThumbIO.unobserve(el);
  _wfThumbWatched.clear();
}

async function renderWorkflowLibList(host) {
  if (!host) return;
  workflowThumbFlush();
  host.innerHTML = "";
  let list = [];
  try {
    const r = await window.api.workflowsList();
    if (r && r.ok) list = r.workflows || r.list || [];
  } catch (_) {}
  if (!list.length) {
    const empty = document.createElement("div");
    empty.style.cssText =
      "text-align:center;color:var(--muted);padding:26px 10px;font-size:12px;line-height:1.9";
    empty.textContent = I18n.t(
      "工作流库为空：把画布里的节点层保存到这里（上方下拉选择），就能在任意画布插入同一套封装，或分享到创意工坊。",
    );
    host.appendChild(empty);
    return;
  }
  for (const w of list) host.appendChild(workflowLibRow(w, host));
}

function workflowLibRow(w, host) {
  const row = document.createElement("div");
  row.dataset.workflowId = String(w.id || "");
  row.style.cssText =
    "display:flex;align-items:center;gap:10px;border:1px solid var(--bd);border-radius:6px;padding:8px 10px;background:var(--code)";

  /* 左：封面小图（没设封面就一个淡色块，不占位太多） */
  const thumb = document.createElement("div");
  thumb.style.cssText =
    "flex:none;width:54px;height:38px;border-radius:4px;border:1px solid var(--bd2);background:#10151c center/cover no-repeat;overflow:hidden";
  if (w.hasCover) thumb.title = I18n.t("该工作流带封面");

  const info = document.createElement("div");
  info.style.cssText = "flex:1;min-width:0;line-height:1.6";
  const nm = document.createElement("div");
  nm.style.cssText =
    "display:flex;align-items:center;gap:6px;font-weight:700;color:var(--cyan2);font-size:13px";
  const badge = document.createElement("span");
  badge.textContent = I18n.t("工作流");
  badge.style.cssText =
    "flex:none;font-size:10px;font-weight:700;line-height:1;padding:3px 5px;border-radius:3px;border:1px solid var(--cyan2);color:var(--cyan2)";
  const nmTxt = document.createElement("span");
  nmTxt.textContent = w.name || I18n.t("（未命名工作流）");
  nmTxt.style.cssText =
    "min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap";
  nm.append(badge, nmTxt);
  nm.title = w.name || "";
  const sub = document.createElement("div");
  sub.style.cssText = "font-size:11px;color:var(--muted)";
  const stat =
    I18n.t("版本 ") +
    (w.version || "1.0") +
    " · " +
    I18n.t("内部 ") +
    (w.nodeCount || 0) +
    I18n.t(" 节点 / ") +
    (w.wireCount || 0) +
    I18n.t(" 连线") +
    (w.artifactCount
      ? " · " +
        w.artifactCount +
        I18n.t(" 个中间产物（") +
        (Number(w.artifactBytes) > 0
          ? Math.max(1, Math.round(Number(w.artifactBytes) / 1024)) + " KB"
          : "0 KB") +
        "）"
      : "") +
    (w.origin && w.origin.kind === "workshop"
      ? " · " + I18n.t("来自工坊") + (w.origin.title ? "：" + w.origin.title : "")
      : "");
  sub.textContent = String(w.description || "") || stat;
  sub.title = stat + (w.description ? "　" + w.description : "");
  info.append(nm, sub);

  const btnInsert = document.createElement("button");
  btnInsert.type = "button";
  btnInsert.className = "mini primary";
  btnInsert.textContent = I18n.t("插入");
  btnInsert.title = I18n.t("把这颗节点层插入当前画布（可重复插入；插进去就是一颗可展开的壳）");
  btnInsert.onclick = async () => {
    const r = await window.api.workflowsGet(w.id);
    if (!r || !r.ok || !r.workflow) {
      toast(I18n.t("读取工作流失败：") + ((r && r.error) || ""), "err");
      return;
    }
    if (await insertWorkflowToCanvas(r.workflow)) closeOverlay();
  };

  const btnRename = document.createElement("button");
  btnRename.type = "button";
  btnRename.className = "mini";
  btnRename.textContent = I18n.t("改名");
  btnRename.onclick = async () => {
    const name = String(
      await promptDialog(I18n.t("新名字："), w.name || "", {
        title: I18n.t("工作流改名"),
        okText: I18n.t("保存"),
      }) || "",
    ).trim();
    if (!name || name === w.name) return;
    const r = await window.api.workflowsPatch(w.id, { name: name });
    if (r && r.ok) {
      toast(I18n.t("已改名：") + name, "ok");
      renderWorkflowLibList(host);
    } else toast(I18n.t("改名失败：") + ((r && r.error) || ""), "err");
  };

  const btnShare = document.createElement("button");
  btnShare.type = "button";
  btnShare.className = "mini";
  btnShare.textContent = I18n.t("分享到工坊");
  btnShare.title = I18n.t("剥掉本机路径与依赖后上传到创意工坊（要求外侧至少 1 进 1 出）");
  btnShare.onclick = () => shareWorkflowToWorkshop(w.id);

  const btnDel = document.createElement("button");
  btnDel.type = "button";
  btnDel.className = "mini";
  btnDel.textContent = I18n.t("删除");
  btnDel.onclick = async () => {
    const sure = await confirmDialog(
      I18n.t("从本机工作流库删除「{name}」？\n\n画布上已经插入的副本不受影响。", {
        name: w.name || "",
      }),
      { title: I18n.t("删除工作流"), okText: I18n.t("删除"), cancelText: I18n.t("取消") },
    );
    if (!sure) return;
    const r = await window.api.workflowsDelete(w.id);
    if (r && r.ok) {
      toast(I18n.t("已删除：") + (w.name || ""), "ok");
      renderWorkflowLibList(host);
    } else toast(I18n.t("删除失败：") + ((r && r.error) || ""), "err");
  };

  row.append(thumb, info, btnInsert, btnRename, btnShare, btnDel);
  /* 封面小图进视口再取（清单不回 dataURL） */
  if (w.hasCover) workflowThumbWatch(thumb, w.id);
  return row;
}
