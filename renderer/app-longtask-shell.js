/* renderer/app-longtask-shell.js —— 长周期任务「超级节点壳 + 生成工作流预置」（自包含新模块，挂 window.LTSHELL）
 *
 * 需求（本轮）：执行长任务时，每个环节的产出应当建立在**对应画布的一颗超级节点里**
 * （没有则建立），这颗超级节点与长任务绑定；涉及内容生成（图像 / 视频 / 音乐 / TTS）时，
 * 在该环节的超级节点内**建好生成工作流**，并要求**用户自己来执行生成**（生成可能产生高额费用）。
 *
 * 结构（一环节一颗子壳，父壳一颗 / 一条长任务）：
 *   父壳  kind "super" · ltShellTask = 任务 uid ── 主画布层，壳名 = 「长任务 · <任务名>」
 *     └ 环节子壳 kind "super" · parentSuperId = 父壳 id · ltShellPath = 环节路径
 *        ├ 控制节点（control · ctrlRole "start" · 靠上）—— 用户在这里点 ▶ 触发生成
 *        ├ 生成节点（proc_image / video_gen / music_gen / tts_gen · 靠下 · 按 cfg.genTypes 平行摆）
 *        ├ 产出节点 ltout（引擎回写正文，见 app-longtask.js 的 ltOutputCreateNode）
 *        └ 产物节点 ltart（本环节跑出来的文件，见 app-longtask-artifacts.js）
 *
 * 三条纪律：
 *   ① **一律不运行生成**：本模块只建图（节点 + 提示词 + 参数），一个生成节点都不会被自动跑；
 *      用户进壳里自己点 ▶（壳里的控制节点也是「用户点才跑」）。
 *   ② **删了不偷偷重长**：壳 / 子壳被用户删掉后只在任务日志里记一条 + 一次非阻塞提示
 *      （带「重建」按钮），引擎不会静默重建（判据：run.shellGone 墓碑）。
 *   ③ **缺料静默降级**：取不到画布 / makeNode / 工作目录时一律不建、也不抛，
 *      产出回流照旧走主画布层（绝不因为本模块缺席而断链）。
 *
 * 本轮新增（「创建即显示」）：**创建期预建**（见 ⑤ ltsEnsureForTask）——任务一经创建就把
 * 父壳 / 环节子壳 / 生成工作流 / 控制 ▶ 一次摆好（只建不跑），不再等跑到那一环才懒建。
 * 懒建（ltsEnsure）仍是运行期的兜底与「壳被删」的墓碑口径，两条路共用同一套建壳原语。
 *
 * 加载顺序：必须在 app-longtask.js 与 app-longtask-artifacts.js 之后
 * （用到 LT 的登记层 / ltNodeAt / ltLog 与画布的 makeNode / addNode / superChildrenOf），
 * app-longtask.js 与 app-longtask-artifacts.js 都按全局判空调用它。
 */
const LT_SHELL_STEP_W = 960; /* 环节子壳展开态缺省宽（真实宽度按内容由 ltsShellFit 长大） */
const LT_SHELL_STEP_H = 560; /* 环节子壳展开态缺省高 */
const LT_SHELL_PAD = 40; /* 子壳内首列 / 首行的留白 */
/* 壳内网格按「最大节点尺寸 + 间距」定距，别按视觉紧凑排：video_gen 高 340、proc_image 宽 400，
   行 / 列距小于它们两两相压（叠在一起比留白更伤）。 */
const LT_SHELL_COL_W = 420; /* 生成节点的列距（> video_gen 宽 400） */
const LT_SHELL_ROW_H_IN = 420; /* 生成节点的行距（> video_gen 高 340） */
const LT_SHELL_GEN_Y = 190; /* 生成节点的首行 y（控制节点占 y 40..180，形成「上控制 / 下生成」） */

/* ── 与引擎同源的兜底取值（外部全局缺了也不抛）────────────────────── */
function ltsArr(v) {
  return typeof ltArr === "function" ? ltArr(v) : Array.isArray(v) ? v : [];
}
function ltsObj(v) {
  return v && typeof v === "object" ? v : {};
}
function ltsStr(v, max) {
  const s = String(v == null ? "" : v);
  return max && s.length > max ? s.slice(0, max) : s;
}
function ltsT(s, vars) {
  return typeof ltT === "function" ? ltT(s, vars) : String(s == null ? "" : s);
}
function ltsNow() {
  return typeof ltNow === "function" ? ltNow() : Date.now();
}
/* ── 本轮 run 的「所属画布」绑定（本轮需求：长任务不许把壳建到错误的画布）──────
   app-longtask.js 的 ltShell* 包装层在进入前调 bindWf(ltRunCanvas(run))、退出时还原 null。
   绑定期间：
     · 一切「哪张画布」的判断只读这个对象（绝不读 S.wf）——用户切去别的画布干活时，
       父壳 / 环节子壳 / 生成节点不许长到他那张图上；
     · 它不在前台时，重绘与前台保存一律换成「按对象自己的 id 落盘」（不打扰用户的屏幕）。
   没绑定时（界面入口：用户在条带上点「重建」等）口径不变，就是当前画布。 */
let ltsCtxWf = null;
function ltsBindWf(wf) {
  const prev = ltsCtxWf;
  ltsCtxWf = wf || null;
  return prev;
}
function ltsWf() {
  if (ltsCtxWf) return ltsCtxWf;
  return typeof S !== "undefined" && S && S.wf ? S.wf : null;
}
/* 绑定的画布此刻是不是"后台那张"（用户看着别处）：是 → 只落盘、不重绘 */
function ltsBg() {
  if (!ltsCtxWf) return false;
  const vis = typeof currentVisibleWf === "function" ? currentVisibleWf() : null;
  return vis ? vis !== ltsCtxWf : false;
}
function ltsNodes() {
  const wf = ltsWf();
  return wf ? ltsArr(wf.nodes) : [];
}
function ltsNotify(msg, kind) {
  try {
    if (typeof toast === "function") toast(msg, kind);
  } catch (_) {}
}
function ltsRender() {
  /* 后台那张不重绘：renderCanvas 画的是 S.wf，用户在别的图上时重绘 = 把他的屏幕刷成别人的画布 */
  if (ltsBg()) return;
  try {
    if (typeof renderCanvas === "function") renderCanvas();
  } catch (_) {}
}
function ltsSave() {
  if (ltsBg()) {
    /* 按对象自己的 id 落盘（persistWf 写谁就是谁），绝不走前台保存通道 */
    try {
      if (ltsCtxWf && typeof persistWf === "function") persistWf(ltsCtxWf);
    } catch (_) {}
    return;
  }
  try {
    if (typeof scheduleSave === "function") scheduleSave(true);
  } catch (_) {}
}
function ltsMakeNode(kind, x, y) {
  if (typeof makeNode !== "function") return null;
  try {
    return makeNode(kind, x, y);
  } catch (_) {
    return null;
  }
}
/* 系统建：不进撤销栈（与产出 / 产物 / 交付节点同一口径） */
function ltsPushNode(node) {
  const wf = ltsWf();
  if (!wf || !node) return null;
  node.__ltSystem = true;
  ltsArr(wf.nodes).push(node);
  return node;
}

/* ── 归属身份（唯一真源：壳上的三个字段）──────────────────────────────
 *   ltShellTask = 任务 uid（「这颗壳属于哪条长任务」）
 *   ltShellPath = 环节路径（空 = 父壳）
 *   ltShellName = 建壳时的任务名（任务重命名后不追改，只用于兜底显示） */
function ltsIsShell(n) {
  return !!n && n.kind === "super";
}
/* 父壳：本任务那颗，且自己没有父壳（子壳永远挂在父壳里） */
function ltsRootShellOf(taskUid) {
  const tid = String(taskUid || "");
  if (!tid) return null;
  return (
    ltsNodes().find(
      (n) =>
        ltsIsShell(n) &&
        String(n.ltShellTask || "") === tid &&
        !String(n.ltShellPath || "").trim() &&
        !String(n.parentSuperId || "").trim(),
    ) || null
  );
}
/* 按定义路径认人（实例号 @i 脱掉见 ltsShellDefPath）：传进来的就算是运行期的实例路径
   （`shots@1/s_shot`）也照样命中同一颗环节子壳 —— 认人这一处收口，调用方不必各自再脱一次。 */
function ltsStepShellOf(taskUid, path) {
  const tid = String(taskUid || "");
  const p = ltsShellDefPath(path);
  if (!tid || !p) return null;
  return (
    ltsNodes().find(
      (n) => ltsIsShell(n) && String(n.ltShellTask || "") === tid && String(n.ltShellPath || "") === p,
    ) || null
  );
}
/* ── 壳「建过没建过」按**环节路径**记（run.shellPaths）────────────────────
 * 旧口径只有一个 run.shellMade（= 建过父壳），拿它当「壳都被删了」的判据，
 * 于是**第二个环节第一次发布产出**时（子壳本来就还没建过）：
 *   !step && run.shellMade && !run.shellGone  → 被误判成「用户把壳删了」→ 记墓碑并拒绝建壳。
 * 真机现场：script 环节拿到了子壳，pilot 环节从此再也拿不到 → 产出 / 产物只能落在
 * **主画布最外层**（7 件产物堆在最外层、产出节点错挂在 script 壳里），视频环节更是连
 * 生成工作流的壳与 video_gen 节点都建不出来。
 * 现在的判据：这一条路径**确实建过**壳、此刻却找不到，才算「用户删了」（墓碑照旧生效）；
 * 从没建过的路径照常补建。 */
function ltsShellPaths(run) {
  if (!run) return {};
  if (!run.shellPaths || typeof run.shellPaths !== "object") run.shellPaths = {};
  return run.shellPaths;
}
function ltsMarkPathMade(run, path) {
  const m = ltsShellPaths(run);
  const p = String(path || "");
  if (p || p === "") m[p] = 1;
  return m;
}
function ltsPathEverMade(run, path) {
  return Object.prototype.hasOwnProperty.call(ltsShellPaths(run), String(path || ""));
}
/* ── 壳归属口径：一律按**定义路径**（本轮 bug：长任务偶尔生成大量空的超级节点）──────
 * 病根：逐项（map）环节的内部节点跑起来时路径带实例号（`shots@1/s_shot`，见 app-longtask.js
 * 的 ltPathKey / ltChildPrefix），而壳是「一条路径一颗」按 ltsShellPath 认人的 —— 于是一份
 * 12 项的清单就在画布上建出 12 颗彼此独立、且永远只有一颗有内容的环节子壳；清单 100 项就是
 * 100 颗空壳（真机现场：run.shellPaths 里 `shots@0..11/s_shot` 各一条，定义路径 `shots/s_shot`
 * 只有一条）。
 * 口径：**壳按定义路径认人**（实例号 @i 一律脱掉；`shots@1/s_shot` → `shots/s_shot`）：
 *   · 同一份子图不管你跑多少项，都落进同一颗环节子壳 —— 子壳数与图里的环节数一一对应，
 *     与实例数无关；产出 / 产物 / 生成工作流也照样各归各位。
 *   · 定义路径里本来就不会有 `@`（图节点 id 由 ltNormGraph 归一，路径段是「节点 id」），
 *     而 ltNodeAt / ltDefNodeAt / ltLocate 都只认 `@` 前的 id，所以脱掉实例号后照样解得开
 *     图节点（标题、生成类型、子图都取得到）。
 *   · run.shellPaths（墓碑账本）也随同一条键记，删没删的判据与壳一一对应，不会错位。
 * 脱法按段（整段 = `id@i`）：只切第一个 `@` 之后的实例串，与 app-longtask.js 的
 * ltLocate / ltNodeAt / ltSegBase 同一口径（路径段是「节点 id」或「节点 id@实例号」）。 */
function ltsPathBaseId(seg) {
  const raw = String(seg == null ? "" : seg);
  const at = raw.indexOf("@");
  return at < 0 ? raw : raw.slice(0, at);
}
function ltsShellDefPath(path) {
  const segs = String(path == null ? "" : path).split("/").filter(Boolean);
  if (!segs.length) return "";
  return segs.map(ltsPathBaseId).join("/");
}
function ltsTaskName(run, root) {
  /* 任务名的来源按可靠性排：壳上记的那份 → run 自己那份（ltRunNew 存了 name）→ 图上现名 */
  const named =
    String((root && root.ltShellName) || "").trim() || String((run && run.name) || "").trim();
  if (named) return named;
  const wf = ltsWf();
  const task = wf && typeof ltTaskOf === "function" ? ltTaskOf(wf, String((run && run.taskId) || "")) : null;
  return String((task && task.name) || ltsT("长任务"));
}
/* 环节标题：按 ltPath 从图里取（取不到时退回路径尾巴，绝不空标题） */
function ltsStepTitle(run, path) {
  let n = null;
  try {
    if (typeof ltNodeAt === "function") n = ltNodeAt(run, path);
  } catch (_) {}
  const t = String((n && n.title) || "").trim();
  if (t) return t;
  const seg = String(path || "").split("/").filter(Boolean).pop() || "";
  return seg.split("@")[0] || ltsT("环节");
}
/* 生成类型 → 建哪种节点（类型清单是本模块与 cfg.genTypes 的共同词汇表） */
const LT_SHELL_GEN_KINDS = {
  image: "proc_image",
  video: "video_gen",
  music: "music_gen",
  tts: "tts_gen",
};
const LT_SHELL_GEN_TYPES = ["image", "video", "music", "tts"];
function ltsGenLabel(t) {
  if (t === "image") return ltsT("图像生成");
  if (t === "video") return ltsT("视频生成");
  if (t === "music") return ltsT("音乐生成");
  if (t === "tts") return ltsT("语音合成");
  return String(t || "");
}

/* ── 环节配置（cfg.needsGen / cfg.genTypes 的唯一读取口径）────────────
 * 缺省口径（与「新任务默认勾上 / 默认只勾图像」一致）：
 *   needsGen 未设（undefined / 空串）= 勾上；显式 false = 用户关掉了。
 *   genTypes 半开（非数组 / 空数组）= 默认 ["image"]。 */
function ltsNeedsGen(cfg) {
  const c = ltsObj(cfg);
  if (c.needsGen === false || c.needsGen === "false") return false;
  return true;
}
function ltsGenTypesOf(cfg) {
  const c = ltsObj(cfg);
  const raw = Array.isArray(c.genTypes) ? c.genTypes : null;
  if (!raw) return ["image"];
  const out = [];
  for (const t of raw) {
    const k = String(t || "").trim();
    if (LT_SHELL_GEN_TYPES.indexOf(k) >= 0 && out.indexOf(k) < 0) out.push(k);
  }
  return out.length ? out : ["image"];
}
/* 这一环节该不该建生成工作流（人工交付环节同样适用：交付清单里常写着要交图） */
function ltsStageWantsGen(node) {
  if (!node) return false;
  const k = node.kind;
  if (k !== "agent" && k !== "human" && k !== "sub" && k !== "map") return false;
  return ltsNeedsGen(node.cfg);
}
/* 「用户自己说过要哪种生成」：genTypes 是图里那一份（归一给所有环节补了缺省 ["image"]，
   所以只看「是不是恰好等于缺省」这一条判据 —— 缺省 = 没说过话）。 */
function ltsUserSaidGenTypes(cfg) {
  const raw = ltsObj(cfg).genTypes;
  if (!Array.isArray(raw) || raw.length !== 1) return true;
  return String(raw[0] || "").trim() !== "image";
}
/* 创建期预建口径（本轮需求）：比运行时窄一档 ——
   kind human + mode "deliver"（交付环节）**没有用户自己说过的生成类型就不预建生成工作流**：
   交付环节的主职是「等人交东西」，它不跑生成；而归一给每个环节补了缺省 ["image"]，
   照运行时判据会替流程里的交付环节凭空建一圈图像生成节点 + 一个看见就想改的交付目录。
   运行时（ltsPresetGen）口径一个字不改：那一环真的跑到、真的产出东西时才按原判据摆工作流。 */
function ltsStageWantsGenCreate(node) {
  if (!ltsStageWantsGen(node)) return false;
  const cfg = ltsObj(node.cfg);
  if (node.kind === "human" && String(cfg.mode || "") === "deliver") return ltsUserSaidGenTypes(cfg);
  return true;
}

/* ── ① 父壳 / 子壳的建立与认人 ───────────────────────────────────────── */
function ltsRootCreate(run, taskName) {
  const wf = ltsWf();
  if (!wf) return null;
  const tid = String((run && run.taskId) || "");
  if (!tid) return null;
  /* 位置：主画布左侧留白处，按已有壳的数量往下错开（不压用户既有的节点） */
  const seen = ltsNodes().filter((n) => ltsIsShell(n) && String(n.ltShellTask || "")).length;
  const node = ltsMakeNode("super", 40, 60 + seen * 60);
  if (!node) return null;
  node.ltShellTask = tid;
  node.ltShellPath = "";
  node.ltShellName = ltsStr(taskName || "", 120);
  node.title =
    typeof uniqueNodeTitle === "function"
      ? uniqueNodeTitle(ltsT("长任务") + " · " + (node.ltShellName || ltsT("未命名任务")))
      : ltsT("长任务") + " · " + (node.ltShellName || ltsT("未命名任务"));
  node.note = ltsT("长周期任务的产出壳：每个环节一颗子壳，壳内产出 / 产物由任务自动落位；生成工作流由你自己点 ▶ 执行。");
  node.expandW = 1160;
  node.expandH = 900;
  ltsPushNode(node);
  ltsMarkPathMade(run, "");
  if (typeof ltLog === "function") ltLog(run, ltsT("已在画布上建立本任务的超级节点：") + node.title, "");
  return node;
}
function ltsStepCreate(run, path) {
  const root = ltsRootShellOf(String((run && run.taskId) || ""));
  if (!root) return null;
  const wf = ltsWf();
  if (!wf) return null;
  const sibs = ltsArr(wf.nodes).filter(
    (n) => ltsIsShell(n) && String(n.parentSuperId || "") === String(root.id) && String(n.ltShellPath || ""),
  );
  const node = ltsMakeNode("super", LT_SHELL_PAD, LT_SHELL_PAD + sibs.length * (LT_SHELL_STEP_H + 40));
  if (!node) return null;
  node.parentSuperId = String(root.id);
  node.parentTaskId = String(root.parentTaskId || "");
  node.ltShellTask = String((run && run.taskId) || "");
  node.ltShellPath = String(path || "");
  node.ltShellName = ltsStr(root.ltShellName || "", 120);
  const want = ltsStepTitle(run, path);
  node.ltShellTitle = want;
  node.title = typeof uniqueNodeTitle === "function" ? uniqueNodeTitle(want) : want;
  node.note = "";
  node.expandW = LT_SHELL_STEP_W;
  node.expandH = LT_SHELL_STEP_H;
  ltsPushNode(node);
  ltsMarkPathMade(run, path);
  /* 父壳跟着长高（只放大不缩小，缩壳交给用户手动 resize） */
  ltsRootFit(root);
  return node;
}
/* 父壳展开态至少装得下全部子壳（fitSuperShellToContent 只管「不裁掉」，这里保证壳可见） */
function ltsRootFit(root) {
  if (!root) return;
  const kids = ltsArr(ltsNodes()).filter((n) => ltsIsShell(n) && String(n.parentSuperId || "") === String(root.id));
  if (!kids.length) return;
  let maxY = 0;
  let maxX = 0;
  for (const k of kids) {
    maxY = Math.max(maxY, (Number(k.y) || 0) + (Number(k.expandH) || LT_SHELL_STEP_H));
    maxX = Math.max(maxX, (Number(k.x) || 0) + (Number(k.expandW) || LT_SHELL_STEP_W));
  }
  const needW = maxX + LT_SHELL_PAD + 60;
  const needH = maxY + LT_SHELL_PAD + 60;
  if (needW > (Number(root.expandW) || 0)) root.expandW = needW;
  if (needH > (Number(root.expandH) || 0)) root.expandH = needH;
}
/* 环节标题改了（用户在条带里重命名）：子壳标题跟着改（只改标题不搬位置） */
function ltsSyncStepTitles(run) {
  const wf = ltsWf();
  if (!wf || !run) return 0;
  let n = 0;
  for (const sh of ltsArr(wf.nodes)) {
    if (!ltsIsShell(sh) || !String(sh.ltShellPath || "")) continue;
    if (String(sh.ltShellTask || "") !== String(run.taskId || "")) continue;
    const want = ltsStepTitle(run, sh.ltShellPath);
    if (!want || want === sh.ltShellTitle) continue;
    sh.ltShellTitle = want;
    /* 重名交给 uniqueNodeTitle（改标题而不是改别人） */
    if (String(sh.title || "") !== want) {
      const dup = ltsArr(wf.nodes).some((x) => x !== sh && String(x.title || "") === want);
      sh.title = dup && typeof uniqueNodeTitle === "function" ? uniqueNodeTitle(want, sh.id) : want;
    }
    n++;
  }
  return n;
}

/* ── ② 生成工作流预置（建图，不运行）──────────────────────────────────
 * 引擎在这一环节**跑到时**调一次（懒建）；幂等：同类型节点在子壳里已有就不重建。
 * 生成本身一律不跑：这里是「把工作流摆好」，跑不跑是用户按 ▶ 的事。 */
function ltsGenPromptOf(run, path) {
  const gn =
    (() => {
      try {
        return typeof ltNodeAt === "function" ? ltNodeAt(run, path) : null;
      } catch (_) {
        return null;
      }
    })() || {};
  const title = String(gn.title || ltsStepTitle(run, path));
  const goal = ltsStr(gn.cfg && gn.cfg.goal, 600);
  const head = ltsT("【本环节】") + title;
  const tail = ltsT("（提示词由长任务按环节自动生成，你可以直接改；改完点本节点的 ▶ 开始生成 —— 生成会消耗额度 / 产生费用）");
  return goal ? head + "\n" + goal + "\n" + tail : head + "\n" + tail;
}
function ltsGenNodesOf(shell) {
  if (!shell) return [];
  return ltsArr(ltsNodes()).filter((n) => String(n.parentSuperId || "") === String(shell.id) && n.ltGenType);
}
/* 建一个生成节点（只填参数与提示词，不跑） */
function ltsGenCreate(shell, type, pos, prompt) {
  const kind = LT_SHELL_GEN_KINDS[type];
  if (!kind) return null;
  const node = ltsMakeNode(kind, pos.x, pos.y);
  if (!node) return null;
  node.parentSuperId = String(shell.id);
  node.parentTaskId = String(shell.parentTaskId || "");
  node.ltGenType = String(type);
  node.ltShellTask = String(shell.ltShellTask || "");
  node.ltShellPath = String(shell.ltShellPath || "");
  const want = ltsGenLabel(type) + " · " + ltsT("待你执行");
  node.title = typeof uniqueNodeTitle === "function" ? uniqueNodeTitle(want) : want;
  node.prompt = prompt;
  /* 图像节点：尺寸按默认（2048x1360）——不替用户挑画幅，进节点设置自己改 */
  if (type === "image") node.size = node.size || "2048x1360";
  /* 比例锁定交给用户自己决定：什么都不锁 */
  ltsPushNode(node);
  return node;
}
/* 建控制节点：壳里唯一「用户按 ▶ 才跑」的入口（只建，不跑） */
function ltsShellControl(shell, pos) {
  const node = ltsMakeNode("control", pos.x, pos.y);
  if (!node) return null;
  node.parentSuperId = String(shell.id);
  node.parentTaskId = String(shell.parentTaskId || "");
  node.ltShellTask = String(shell.ltShellTask || "");
  node.ltShellPath = String(shell.ltShellPath || "");
  node.ctrlAction = "run";
  node.ctrlRole = "start";
  const want = ltsT("▶ 由我执行生成") + " · " + ltsT("触发");
  node.title = typeof uniqueNodeTitle === "function" ? uniqueNodeTitle(want) : want;
  ltsPushNode(node);
  return node;
}
/* 子壳内布局：控制靠上（小 y），生成节点靠下（大 y）—— 与画布既有排版口径一致 */
function ltsGenSlot(n) {
  const col = n % 2;
  const row = Math.floor(n / 2);
  return {
    x: LT_SHELL_PAD + col * LT_SHELL_COL_W,
    y: LT_SHELL_GEN_Y + row * LT_SHELL_ROW_H_IN,
  };
}
function ltsShellFit(shell) {
  if (!shell) return;
  const kids = ltsArr(ltsNodes()).filter((n) => String(n.parentSuperId || "") === String(shell.id));
  let maxX = 0;
  let maxY = 0;
  for (const k of kids) {
    maxX = Math.max(maxX, (Number(k.x) || 0) + (Number(k.w) || 300));
    maxY = Math.max(maxY, (Number(k.y) || 0) + (Number(k.h) || 200));
  }
  if (maxX + LT_SHELL_PAD + 40 > (Number(shell.expandW) || 0)) shell.expandW = maxX + LT_SHELL_PAD + 40;
  if (maxY + LT_SHELL_PAD + 40 > (Number(shell.expandH) || 0)) shell.expandH = maxY + LT_SHELL_PAD + 40;
}
/* 预置本环节的生成工作流（幂等）：
 *   ① 生成节点：按 cfg.genTypes 平行摆（同类型已有就不重建）；
 *   ② 控制节点：壳里没有就建一枚（用户在这里点 ▶）。
 * 口径：**只增不删** —— 用户把「生成类型」改成别的之后，旧类型的节点留在壳里由用户自己
 * 处置（可能是他改过的、要留着手工跑的），引擎绝不替他删节点。
 * 返回 { created, skipped }。 */
function ltsPresetGen(run, path) {
  const out = { created: 0, skipped: 0 };
  const wf = ltsWf();
  if (!wf || !run || !path) return out;
  const loc = (() => {
    try {
      return typeof ltLocate === "function" ? ltLocate(run, path) : null;
    } catch (_) {
      return null;
    }
  })();
  const gNode = loc && loc.node ? loc.node : null;
  const shell = ltsStepShellOf(String(run.taskId || ""), path);
  if (!gNode || !shell || !ltsStageWantsGen(gNode)) return out;
  const want = ltsGenTypesOf(gNode.cfg);
  const have = ltsGenNodesOf(shell);
  const prompt = ltsGenPromptOf(run, path);
  let slot = have.length;
  for (const t of want) {
    if (have.some((n) => String(n.ltGenType || "") === t)) {
      out.skipped++;
      continue;
    }
    if (ltsGenCreate(shell, t, ltsGenSlot(slot), prompt)) {
      out.created++;
      slot++;
    }
  }
  const hasCtrl = ltsArr(ltsNodes()).some(
    (n) => n.kind === "control" && String(n.parentSuperId || "") === String(shell.id),
  );
  if (!hasCtrl) ltsShellControl(shell, { x: LT_SHELL_PAD, y: LT_SHELL_PAD });
  const wired = ltsWireControl(shell);
  ltsShellFit(shell);
  ltsRootFit(ltsRootShellOf(String(run.taskId || "")));
  if (wired) ltsSave();
  return out;
}
/* 控制 ▶ 必须**直连**「该由用户点跑」的节点：控制流不走数据线（见 app-nodes.js 的
 * controlTargets —— 目标只从线上取），壳里那枚 ▶ 没有线时点下去只会提示「未连接任何节点」，
 * 等于工作流没有入口。这里在建生成节点之后把线补上（已连的不重复接）。 */
function ltsWireControl(shell) {
  const wf = ltsWf();
  if (!wf || !shell || typeof addWire !== "function") return 0;
  const ctrl = ltsArr(wf.nodes).find(
    (n) => n.kind === "control" && String(n.parentSuperId || "") === String(shell.id),
  );
  if (!ctrl) return 0;
  if (!Array.isArray(wf.wires)) wf.wires = [];
  let n = 0;
  for (const g of ltsGenNodesOf(shell)) {
    if (wf.wires.some((w) => w && w.from === ctrl.id && w.to === g.id)) continue;
    try {
      addWire(ctrl.id, g.id);
      n++;
    } catch (_) {}
  }
  return n;
}

/* ── ③ 缺少则建立（带墓碑：删了不偷偷重长）────────────────────────────
 * 唯一入口，引擎在两处调：
 *   · 产出正文要落画布（app-longtask.js 的 ltOutputPublish）
 *   · 产物要落画布（app-longtask-artifacts.js 的 ltArtPublish）
 * 返回 { ok, root, step, created, gone }：
 *   ok=false + gone=true = 壳被用户删过，本轮只提示不建（绝不静默重长）。 */
function ltsEnsure(run, path) {
  const out = { ok: false, root: null, step: null, created: 0, gone: false };
  const wf = ltsWf();
  if (!wf || !run || !path) return out;
  const tid = String(run.taskId || "");
  if (!tid) return out;
  /* 本条路径的**定义路径**：壳一律按它认人 / 建壳 / 记账（实例号 @i 脱掉）——
     逐项（map）清单有多少项都只共用同一颗环节子壳，不再一项一颗空壳。见 ltsShellDefPath。 */
  const defPath = ltsShellDefPath(path);
  /* 画布上现存的壳先登记进 run.shellPaths（老 checkpoint 没有这份记录；本轮起按定义路径记，
     旧档里那些带实例号的记录一并归到同一个键上）：
     有记录才有「按路径判删没删」的准头 —— 否则第一个环节拿到壳之后，
     后面每个环节的第一次建壳都会被误判成「用户删了壳」（见 ltsShellPaths）。 */
  for (const n of ltsNodes()) {
    if (!ltsIsShell(n) || String(n.ltShellTask || "") !== tid) continue;
    ltsMarkPathMade(run, ltsShellDefPath(String(n.ltShellPath || "")));
  }
  let root = ltsRootShellOf(tid);
  if (!root && run.shellMade && !run.shellGone && ltsPathEverMade(run, "")) {
    /* 建过壳、此刻却找不到 = 被用户删了 → 记墓碑，从此走「只提示不重建」。
       用户点「重建」（ltsRebuild）会 clear 它并当场把父壳建回来，所以重建那一轮
       走到这里时 shellGone 已是 false（子壳照常补建）。 */
    ltsMarkGone(run);
    out.gone = true;
    ltsWarnGone(run);
    return out;
  }
  if (!root) {
    const name = ltsTaskName(run, null);
    run._ltShellBuilding = true;
    try {
      root = ltsRootCreate(run, name);
    } finally {
      run._ltShellBuilding = false;
    }
    if (!root) return out;
    out.created++;
  }
  /* 壳找回来了（用户点过「重建」）：墓碑与「已提示」一并清掉 —— 否则这一轮还会
     按墓碑口径挡子壳，用户看到的是「重建了却没生效」。 */
  if (run.shellGone) {
    run.shellGone = false;
    run.shellGoneAt = 0;
    run.shellWarned = false;
  }
  /* 父壳已就绪、墓碑也过了：把老现场按实例路径堆出来的重复环节子壳一次收口
     （只搬不删节点，见 ltsConsolidateStepShells）—— 在这之前动壳会被墓碑判据误判成
     「用户删了壳」。放在子壳解析之前：本轮要用的那颗壳就在收口之后的那一份里。 */
  try {
    ltsConsolidateStepShells(tid);
  } catch (_) {}
  /* 到这里父壳已就绪：把「正在建壳」的标记一直举到本环节子壳建好为止。
     预置生成 / 建控制节点会递归调回本函数（同一个 run），没有这个标记就会被误判成
     「用户把壳删了」→ 记墓碑 → 静默不建。 */
  run._ltShellBuilding = true;
  try {
    let step = ltsStepShellOf(tid, defPath);
    if (!step && run.shellMade && !run.shellGone && ltsPathEverMade(run, defPath)) {
      /* 这条路径**建过**子壳、此刻却不在：同一口径（删了不偷偷重长）。
         从没建过的路径不走这里 —— 那是「第一次建」，不是「被删了」。 */
      ltsMarkGone(run);
      out.gone = true;
      ltsWarnGone(run);
      return out;
    }
    if (!step) {
      step = ltsStepCreate(run, defPath);
      if (!step) return out;
      out.created++;
    }
    if (!run.shellMade) run.shellMade = 1;
    out.ok = true;
    out.root = root;
    out.step = step;
  } finally {
    run._ltShellBuilding = false;
  }
  /* 这一环节真的跑到（产出 / 产物落到子壳）时，把生成工作流**建好但不运行**摆进去。
     幂等（同类型已有就不重建）；本环节关掉「需要生成内容」时不建。 */
  try {
    const gen = ltsPresetGen(run, defPath);
    out.created += gen.created;
  } catch (_) {}
  return out;
}
/* 墓碑：壳被用户删过 → 只提示一次、不重建。
 * 判据 = 这条路径（run.shellPaths，父壳记 ""）确实建过壳，此刻壳却找不到了。
 * 用户点「重建」（ltsRebuild）才清墓碑，此后照常建 —— 不是静默重长，是用户点的。 */
function ltsMarkGone(run) {
  if (!run) return;
  run.shellGone = true;
  run.shellGoneAt = ltsNow();
}
/* 提示口径：一次非阻塞 toast + 任务日志一条。不阻断、不重建。 */
function ltsWarnGone(run) {
  try {
    if (typeof ltLog === "function")
      ltLog(run, ltsT("超级节点壳已被删除：不再自动重建（点提示里的「重建」可恢复）"), "warn");
  } catch (_) {}
  if (run && run.shellWarned) return;
  if (run) run.shellWarned = true;
  ltsNotify(ltsT("长任务的超级节点壳已被删除：产出暂留在主画布层。需要壳的话在条带里点「重建壳」"), "warn");
}
/* 用户点了「重建」：清墓碑 → 下一次产出照常建壳（不是静默重长，是用户点的） */
function ltsRebuild(run) {
  if (!run) return false;
  run.shellGone = false;
  run.shellGoneAt = 0;
  run.shellWarned = false;
  run.shellMade = 0;
  run.shellPaths = {}; /* 逐路径记录一并清掉：这一轮是用户点名「重建」，此后按新记录判删没删 */
  run._ltShellBuilding = false;
  const r = ltsRootCreate(run, ltsTaskName(run, null));
  if (!r) return false;
  ltsRender();
  ltsSave();
  ltsNotify(ltsT("已重建超级节点壳：后续产出会落进对应环节子壳"), "ok");
  return true;
}

/* ── ④ 产出 / 产物的落点改写（供 app-longtask.js 的登记层与 artifacts 模块调）──
 * 只改「放哪儿」：节点身份（ltTaskUid / ltPath / 认人复用）一律不动。 */

/* 子壳内落位：产出 / 产物排在生成网格**右边一整列**（不与生成列共 x，也就不可能压住它们）。
 * 坐标一律是**子壳内部坐标系**（与 makeNode 落在壳内时的口径一致）。 */
const LT_SHELL_OUT_COL = LT_SHELL_PAD + 2 * LT_SHELL_COL_W + 60; /* 生成占 0/1 两列，产出从第三列起 */
const LT_SHELL_ART_COL = LT_SHELL_OUT_COL + 400; /* 产物网格再往右让开产出节点（ltout 宽 360） */
const LT_SHELL_ART_COL_W = 300; /* 产物网格列距（> ltart 宽 260） */
const LT_SHELL_ART_ROW_H = 260; /* 产物网格行距（> ltart 高 210） */
function ltsSlotOf(shellId, kind, node) {
  const sid = String(shellId || "");
  const list = ltsArr(ltsNodes()).filter(
    (x) =>
      String(x.parentSuperId || "") === sid &&
      x.kind === kind &&
      (!node || String(x.id) !== String(node.id)),
  );
  if (kind === "ltout") {
    /* 一个环节只有一颗产出节点（认人复用），所以它就在这列的起点上 */
    return { x: LT_SHELL_OUT_COL, y: LT_SHELL_PAD };
  }
  const i = list.length;
  const col = i % 3;
  const row = Math.floor(i / 3);
  return {
    x: LT_SHELL_ART_COL + col * LT_SHELL_ART_COL_W,
    y: LT_SHELL_PAD + row * LT_SHELL_ART_ROW_H,
  };
}
/* 产出节点（kind ltout）：优先落进本环节子壳；壳不可用时回空串 = 交由调用方回落主画布层。
 * 返回 { parent, shell:true|false, gone }。 */
function ltsOutputFinalize(run, path, node) {
  const out = { parent: "", shell: false, gone: false };
  if (!node) return out;
  node.ltTaskUid = String((run && run.taskId) || "");
  node.ltRunId = String((run && run.runId) || "");
  node.ltPath = String(path || "");
  const r = ltsEnsure(run, path);
  out.gone = !!r.gone;
  if (!r.ok || !r.step) return out;
  out.shell = true;
  out.parent = String(r.step.id);
  node.parentSuperId = out.parent;
  node.parentTaskId = String(r.step.parentTaskId || "");
  node.ltShellTask = String((run && run.taskId) || "");
  node.ltShellPath = String(path || "");
  const pos = ltsSlotOf(out.parent, "ltout", node);
  node.x = pos.x;
  node.y = pos.y;
  ltsShellFit(r.step);
  return out;
}
/* 产物节点（kind ltart）：同样落本环节子壳（一件一格）。
 * 返回 { parent, shell, gone }；parent 为空 = 调用方回落主画布层（app-longtask-artifacts.js）。 */
function ltsArtifactsParentOf(run, path, node) {
  const out = { parent: "", shell: false, gone: false };
  const r = ltsEnsure(run, path);
  out.gone = !!r.gone;
  if (!r.ok || !r.step) return out;
  out.shell = true;
  out.parent = String(r.step.id);
  if (node) {
    node.parentSuperId = out.parent;
    node.parentTaskId = String(r.step.parentTaskId || "");
    node.ltShellTask = String((run && run.taskId) || "");
    node.ltShellPath = String(path || "");
    const pos = ltsSlotOf(out.parent, "ltart", node);
    node.x = pos.x;
    node.y = pos.y;
    node.ltGenType = "";
  }
  ltsShellFit(r.step);
  return out;
}
/* 旧档迁移（一次性 · 幂等）：主画布层上的产出 / 产物搬进它该在的环节子壳。
 * 只在「继续跑 / 重跑这一环 / 打开画布」（ltResume / ltRetryNode / ltRestore）时调。
 * 本轮补两件（真机现场：pilot 环节起，产出与 7 件产物全堆在主画布**最外层**）：
 *   ① **子壳不在就先补建**（走 ltsEnsure：建壳同时把该环节的生成工作流摆好）；
 *      旧现场里第二个环节起全都没壳，光搬是搬不进去的；
 *   ② **产物节点也搬**，但只搬「压根没归属过壳」的那些（ltShellPath 为空 = 当时壳没建出来）；
 *      已经落在某个子壳里的（含用户自己拖过位置的）一律不动 —— 老口径「不搬产物」的本意
 *      是别动用户的手工摆放，这里只收自己当初没放对的那批。 */
async function ltsMigrateOutputs(wf) {
  const out = { moved: 0, shells: 0 };
  if (!wf || !ltsWf() || ltsWf() !== wf) return out;
  const list = ltsArr(wf.nodes).filter((n) => {
    if (!n) return false;
    if (n.kind !== "ltout" && n.kind !== "ltart") return false;
    if (!String(n.ltTaskUid || "") || !String(n.ltPath || "")) return false;
    /* 产物：只在「当年就没进过壳」时才搬（ltShellPath 有值 = 已经归过位） */
    if (n.kind === "ltart" && String(n.ltShellPath || "").trim()) return false;
    return true;
  });
  if (!list.length) return out;
  let touched = false;
  for (const n of list) {
    const taskUid = String(n.ltTaskUid || "");
    const path = String(n.ltPath || "");
    const run = (() => {
      try {
        return typeof ltRun === "function" ? ltRun(wf.id, String(n.ltRunId || "")) : null;
      } catch (_) {
        return null;
      }
    })();
    let step = ltsStepShellOf(taskUid, path);
    if (!step && run) {
      /* 补建：本环节当年没拿到壳（旧判据把「第一次建」误判成「被删了」）→ 现在补上，
         顺带把生成工作流（生成节点 + ▶ 控制节点 + 控制线）摆好。幂等。 */
      const r = ltsEnsure(run, path);
      if (r && r.step) {
        step = r.step;
        out.shells++;
      }
    }
    if (!step) continue;
    if (String(n.parentSuperId || "") === String(step.id)) continue;
    n.parentSuperId = String(step.id);
    n.parentTaskId = String(step.parentTaskId || "");
    n.ltShellTask = taskUid;
    n.ltShellPath = path;
    const pos = ltsSlotOf(String(step.id), n.kind, n);
    n.x = pos.x;
    n.y = pos.y;
    ltsShellFit(step);
    out.moved++;
    touched = true;
    if (run && typeof ltLog === "function")
      ltLog(
        run,
        n.kind === "ltart"
          ? ltsT("已把主画布层上的产物收进对应环节的超级节点")
          : ltsT("已把产出节点收进对应环节的超级节点"),
        "",
      );
  }
  if (touched) {
    ltsRootFit(ltsRootShellOf(String((list[0] && list[0].ltTaskUid) || "")));
    ltsRender();
    ltsSave();
  }
  return out;
}

/* ── ⑤ 创建期预建（本轮需求：创建即显示，落点一次建好、只建不跑）──────────
 * 旧口径：壳 / 生成工作流 / 交付节点都是**跑到那一环才懒建**（ltEnsure 从产出 / 产物发布处调）。
 * 用户看到的现场是「图建好了，画布上什么都没有」；本轮改为**任务一经创建就把落点摆好**。
 * 三条纪律照旧：
 *   ① 一律不运行：只 makeNode + push，绝不调 runNode、绝不置 running；
 *   ② 没有 run 就不写墓碑、不碰 run.shell* 字段（那些字段只属运行中的 run）——
 *      预建用的是一份「无 run 上下文」的临时对象，用完即弃；
 *   ③ 归属画布：整段绑在任务的所属画布上建，后台那张只落盘不重绘（见 ltsBg / ltsSave）。
 * 幂等按身份认人（父壳 = ltShellTask，子壳 = ltShellTask + ltShellPath）：已存在即跳过 ——
 * 调用点会在任务创建收尾处重复叫它，第二次必须是空动作。
 * map 的实例路径（<id>@i）只在运行时展开，这里**不漏建**（清单只给图定义路径）。 */
/* 图定义里的路径清单（递归各层 cfg.graph）。给「同一份清单」的两个调用方用：
 * 壳预建（本模块）与交付节点预建（app-longtask.js 的 ltDeliverLandingCreate）。 */
function ltsGraphPaths(graph) {
  const out = [];
  const seen = new Set();
  const walk = (g, prefix) => {
    for (const n of ltsArr(g && g.nodes)) {
      if (!n || !n.id) continue;
      const path = prefix ? prefix + "/" + n.id : String(n.id);
      if (seen.has(path)) continue;
      seen.add(path);
      out.push(path);
      if (n.cfg && n.cfg.graph) walk(n.cfg.graph, path);
    }
  };
  walk(graph, "");
  return out.filter(Boolean);
}
/* 无 run 上下文（创建期 / 界面入口）：只为让 ltNodeAt / ltLocate 解得开路径。
 *   ltNodeAt 只读 run.graph；ltLocate 只读 run.inst（前缀 → 图）。
 * 按「定义路径」遍历建 inst，所以 map 的实例路径（@i）天然不在这份清单里。 */
function ltsCtxForTask(task) {
  const tid = String((task && task.uid) || "");
  if (!tid) return null;
  const ctx = {
    taskId: tid,
    name: String((task && task.name) || ""),
    graph: (task && task.graph) || null,
    nodes: {},
    inst: {},
    shellPaths: {},
  };
  const reg = (g, prefix) => {
    ctx.inst[prefix] = g;
    for (const n of ltsArr(g && g.nodes)) {
      if (n && n.cfg && n.cfg.graph) reg(n.cfg.graph, prefix ? prefix + "/" + n.id : String(n.id));
    }
  };
  if (ctx.graph) reg(ctx.graph, "");
  return ctx;
}
/* 建图路径 → 定义里那个节点（走同一份 inst 口径，与 ltLocate 一致）；
 * 只给「生成工作流预置」读 cfg.needsGen / cfg.genTypes 用。 */
function ltsDefNodeOf(ctx, path) {
  try {
    if (typeof ltLocate === "function") {
      const loc = ltLocate(ctx, path);
      if (loc && loc.node) return loc.node;
    }
  } catch (_) {}
  return null;
}
/* 老现场收口（本轮 bug 的另一半）：已经按实例路径堆在画布上的**重复环节子壳**合并回同一颗。
 * 病根见 ltsShellDefPath —— 一份逐项清单的每个实例当年各自建了一颗子壳，画布上于是留下
 * 一串同名空壳（真机现场：`shots@0/s_shot` … `shots@11/s_shot` 十二颗）。
 * 现在壳按定义路径认人，这些旧壳再也认不回来（会永远空着占地方），所以这里按定义路径归组：
 *   · 同一组里留**最早建的那一颗**（子壳里当年跑出来的内容多半在它里面）；
 *   · 重复壳里的节点与绘制整体改挂到留下那颗（只改 parentSuperId / parentTaskId，节点一个不删）；
 *   · 再删掉重复壳本身（它们与壳之间的无意义连线一并清掉）；
 *   · 这一组只有一颗（正常现场）时是零动作 —— 幂等。
 * 三条纪律：① 只认「带环节路径的壳」（父壳不参与，绝不动父壳）；② 只动**本任务**的壳
 * （ltShellTask 不匹配的一律不碰）；③ 壳内节点与产出 / 产物是用户的资产，只搬不删。
 * 调用点：创建期预建收尾（ltsEnsureForTask）与运行时建壳入口（ltsEnsure，父壳就绪之后）。
 * 返回 { merged, removed, moved }。 */
function ltsConsolidateStepShells(tid) {
  const out = { merged: 0, removed: 0, moved: 0 };
  const wf = ltsWf();
  const taskId = String(tid || "");
  if (!wf || !taskId) return out;
  const nodes = ltsNodes();
  const shells = nodes.filter((n) => ltsIsShell(n) && String(n.ltShellTask || "") === taskId);
  if (shells.length < 2) return out;
  /* 按定义路径归组（只有带环节路径的壳参与；父壳的路径是空串，天然不进来） */
  const groups = new Map();
  for (const s of shells) {
    const raw = String(s.ltShellPath || "").trim();
    if (!raw) continue;
    const key = ltsShellDefPath(raw);
    if (!key) continue;
    const g = groups.get(key);
    if (g) g.list.push(s);
    else groups.set(key, { key, list: [s] });
  }
  const drop = new Set();
  const keepOf = new Map(); /* 重复壳 id → 留下的那颗（搬孩子用） */
  for (const g of groups.values()) {
    if (g.list.length < 2) continue;
    const keep = g.list[0]; /* 最早建的那一颗：真正跑到的那一项的内容都在它里面 */
    let merged = 0;
    for (const s of g.list) {
      if (String(s.id) === String(keep.id)) continue;
      if (s.running === true) continue; /* 正在跑的壳先放过，下一轮再说 */
      drop.add(String(s.id));
      keepOf.set(String(s.id), String(keep.id));
      merged++;
    }
    if (merged) out.merged++;
  }
  if (!drop.size) return out;
  /* 先搬孩子与挂在重复壳上的绘制（只改归属字段；节点一个都不删） */
  const keeperOf = (id) => {
    const to = keepOf.get(String(id || ""));
    return to ? (ltsArr(wf.nodes).find((n) => n && String(n.id) === to) || null) : null;
  };
  for (const n of ltsArr(wf.nodes)) {
    if (!n) continue;
    const keeper = keeperOf(n.parentSuperId);
    if (!keeper) continue;
    n.parentSuperId = String(keeper.id);
    n.parentTaskId = String(keeper.parentTaskId || "");
    out.moved++;
  }
  for (const m of ltsArr(wf.marks)) {
    if (!m) continue;
    const keeper = keeperOf(m.parentSuperId);
    if (!keeper) continue;
    m.parentSuperId = String(keeper.id);
    if ("parentTaskId" in m) m.parentTaskId = String(keeper.parentTaskId || "");
  }
  /* 再删重复壳本身（壳内节点已改挂到留下那颗；它们之间的无意义连线一并不留） */
  wf.nodes = ltsArr(wf.nodes).filter((n) => !(n && drop.has(String(n.id))));
  if (Array.isArray(wf.wires)) {
    wf.wires = wf.wires.filter((w) => !(w && (drop.has(String(w.from)) || drop.has(String(w.to)))));
  }
  out.removed = drop.size;
  return out;
}
/* 创建期预建：父壳 + 各环节子壳 + 控制 ▶（直连生成节点）+ 生成工作流节点，**一个都不跑**。
 * 返回 { ok, skipped, created, shells, gens }；ok=false = 缺料（无画布 / 无图 / makeNode 缺席）
 * 或这份图压根没有落点可建。 */
function ltsEnsureForTask(wf, task) {
  const out = { ok: false, skipped: true, created: 0, shells: 0, gens: 0 };
  if (!wf || !task || !task.uid) return out;
  const paths = ltsGraphPaths(task.graph);
  if (!paths.length) return out;
  const ctx = ltsCtxForTask(task);
  if (!ctx) return out;
  const tid = String(task.uid);
  let built = false;
  const prevBind = ltsBindWf(wf);
  try {
    ltSyncCanvas(wf, () => {
      let root = ltsRootShellOf(tid);
      if (!root) {
        root = ltsRootCreate(ctx, String(task.name || ""));
        if (!root) return;
        out.shells++;
        out.created++;
        built = true;
      }
      ltsRootFit(root);
      for (const path of paths) {
        const node = ltsDefNodeOf(ctx, path);
        if (!node) continue;
        /* 「这条路径该不该建壳」用**创建期口径**（ltsStageWantsGenCreate = 运行时判据再窄一档：
           交付环节没有用户自己说过的生成类型就不预建生成工作流）。与运行期的区别只有一处：
           运行时是材质来了才建，这里是创建期先摆好。
           交付环节的落点由 app-longtask.js 的 ltDeliverLandingCreate 负责（交付节点 + 目录），
           本函数不管交付。 */
        if (!ltsStageWantsGenCreate(node)) continue;
        let step = ltsStepShellOf(tid, path);
        if (!step) {
          step = ltsStepCreate(ctx, path);
          if (!step) continue;
          out.shells++;
          out.created++;
          built = true;
        }
        /* 生成工作流预置（生成节点 + ▶ 控制节点 + 控制线）：一律只建不跑 ——
           生成本身仍由用户进壳点 ▶。幂等（同类型已有就不重建）。 */
        const g = ltsPresetGen(ctx, path);
        out.gens += g.created;
        out.created += g.created;
        if (g.created) built = true;
      }
      /* 老现场收口：这份画布上若有按实例路径堆出来的重复环节子壳（本 bug 的现场），
         在这里一次合并掉（只搬不删节点）—— 建完新壳顺手做，用户点开就只剩该有的那几颗。 */
      try {
        const cc = ltsConsolidateStepShells(tid);
        if (cc.removed) built = true;
      } catch (_) {}
      ltsRootFit(ltsRootShellOf(tid));
    });
  } catch (_) {
    /* 缺料静默降级：壳缺席不影响创建本身（产出回流照旧回落主画布层） */
  } finally {
    ltsBindWf(prevBind);
  }
  out.ok = out.shells > 0;
  out.skipped = !built;
  if (built) {
    ltsRender(); /* 后台那张不重绘（见 ltsRender / ltsBg） */
    ltsSave();
  }
  return out;
}

/* ── ⑥ 壳被删的降级口径 ──────────────────────────────────────────────
 * 壳被删后本 run 的产出不再进壳，但**画布上仍要有地方看结果**：落点委派返回空父级，
 * 引擎按旧行为摆回主画布层（见 app-longtask.js 的 ltOutputCreateNode 与
 * app-longtask-artifacts.js 的 ltArtPlace）—— 有地方看结果，绝不因为壳没了而断链。 */

window.LTSHELL = {
  /* 画布绑定（本轮需求）：引擎包装层进入前 bindWf(run 的所属画布)，退出还原 —— 
     壳的一切"哪张画布"判断按它算，用户切画布时不会建到别人的图上（见 ltsWf / ltsBg） */
  bindWf: ltsBindWf,
  boundWf: ltsWf,
  STEP_W: LT_SHELL_STEP_W,
  STEP_H: LT_SHELL_STEP_H,
  GEN_TYPES: LT_SHELL_GEN_TYPES,
  GEN_KINDS: LT_SHELL_GEN_KINDS,
  genTypesOf: ltsGenTypesOf,
  needsGen: ltsNeedsGen,
  isShell: ltsIsShell,
  rootShellOf: ltsRootShellOf,
  stepShellOf: ltsStepShellOf,
  /* 壳归属口径：壳按**定义路径**认人（实例号 @i 脱掉）—— 逐项（map）清单跑多少项都只共用
     同一颗环节子壳。导出给回归测试与外部诊断用（本轮 bug：一份清单建出一串空壳）。 */
  defPathOf: ltsShellDefPath,
  ensure: ltsEnsure,
  /* 创建期预建（本轮需求：创建即显示）：父壳 / 子壳 / 生成工作流 / 控制 ▶ 一次建齐、只建不跑，
     幂等。同一份图路径清单（graphPaths）也给交付节点预建用（ltDeliverLandingCreate）。 */
  ensureForTask: ltsEnsureForTask,
  graphPaths: ltsGraphPaths,
  presetGen: ltsPresetGen,
  outputFinalize: ltsOutputFinalize,
  artifactsParentOf: ltsArtifactsParentOf,
  migrateOutputs: ltsMigrateOutputs,
  syncStepTitles: ltsSyncStepTitles,
  rebuild: ltsRebuild,
};
