/* canvas-doc-core —— 画布「读侧」纯计算内核（同一份代码，两处入口）
 *
 * 一句话：把 canvas_get 那一整套只读计算（快照各档位 / 端子推导 / scope 判定 / 内容哈希 /
 * 静态表）从 renderer/app-nodes.js 抽出来，做成一个**不碰 DOM、不读 S、不带文案**的纯函数
 * 模块，好让非 UI 进程（主进程 / MCP / CLI）复用同一份实现 —— 复制一份必然漂移，必须同源。
 *
 * 两处入口：
 *   · 浏览器：renderer/index.html 在 app.js 之前以 <script> 引入，挂到 globalThis.MTCanvasDoc；
 *     渲染层的同名函数（renderer/app-nodes.js）只剩一层包装，负责用画布现场（S / I18n /
 *     各节点原语）拼出宿主对象 H 再转发进来。
 *   · Node（主进程 / 脚本）：require("canvas-doc/canvas-doc-core.js") 拿同一份 api。
 *
 * 宿主契约（H）：所有需要「画布现场」的函数都以 H 作第一参数，H 由调用方提供 ——
 *   H.state            { wf, view, cam, superFocus }（原来的 S 里读侧用到的四项，只读）
 *   H.i18n             { t(key, vars) }（文案由调用方给：内核不持有任何词条）
 *   H.imageSizes / H.defaultImageSize / H.nodeDefaults   静态表（见 kindsOf）
 *   H.<原语>           读侧要用的节点原语，逐个在函数顶部解构声明，看得到就是全部依赖
 * 这样做的好处：内核里没有任何隐式全局，函数体与搬家前逐行一致（可对照审阅）。
 *
 * 纪律（本文件是硬约束，不是风格建议）：
 *   · 不碰 DOM、不读 S、不调 I18n 单例、不写任何状态 —— 永远是「入参 → 返回值」。
 *   · 返回结构 / 字段顺序 / 排序口径与搬家前逐字节一致；这里是**同一份计算**，不是重写。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.MTCanvasDoc = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  /* ── 静态参考表（按需闸才发给 Agent 的那三张）──────────────────────────────
     imageSizes / defaultImageSize 的**唯一真源**就在这儿：renderer/app.js 里那两个同名常量
     现在只是取一次引用（const IMAGE_SIZES = MTCanvasDoc.IMAGE_SIZES），画布选档、节点默认值、
     Agent 快照读到的都是同一份数组 —— 曾经两处各写一份，改一处、另一处漂移过。
     kinds 是由节点默认表（NODE_DEFAULTS）投影出来的：{kind,title,w,h}，顺序 = 默认表的键序。 */
  /* gpt-image-2-vip 支持的尺寸（含 auto） */
  const IMAGE_SIZES = [
    "auto",
    "1280x1280",
    "848x1280",
    "1280x848",
    "960x1280",
    "1280x960",
    "1024x1280",
    "1280x1024",
    "720x1280",
    "1280x720",
    "1280x544",
    "2048x2048",
    "1360x2048",
    "2048x1360",
    "1536x2048",
    "2048x1536",
    "1632x2048",
    "2048x1632",
    "1152x2048",
    "2048x1152",
    "2048x864",
    "2880x2880",
    "2336x3520",
    "3520x2336",
    "2480x3312",
    "3312x2480",
    "2560x3216",
    "3216x2560",
    "2160x3840",
    "3840x2160",
    "3840x1632",
  ];
  const DEFAULT_IMAGE_SIZE = "2048x1360";
  /* 节点默认表 → 建图用的 kinds 表（顺序与默认表键序一致） */
  function kindsOf(nodeDefaults) {
    const src = nodeDefaults && typeof nodeDefaults === "object" ? nodeDefaults : {};
    return Object.keys(src).map((k) => ({
      kind: k,
      title: src[k].title,
      w: src[k].w,
      h: src[k].h,
    }));
  }

  /* canvas_get 颗粒度：
     detail   = 节点字段档位：minimal（缺省。每节点仅 标题/描述(note)/类别(kind)，且重型块只留
                nodes）| standard（+全部配置字段与正文长度，不含正文，+ 建图参考表）| full（全部）
     ids      = 只返回这些节点（按 id 或唯一标题匹配），wires 随之收窄
     scope    = 只读某一颗节点层 / 开发节点内部（id / 唯一标题；"global" = 整图；缺省 = 跟着用户当前所在的壳）
     scopeDepth = direct（只给直接子节点 · 默认）| all（给整棵子树）
     bodies   = 是否返回正文全文（text/prompt/task/goal）；缺省：full 时为 true，其余为 false
     bodyLimit= 正文按 N 字符截断（0=不限）；*Len 始终为真实长度
     sections = 重型块白名单（nodes/marks/wires/groups/taskTree/superTree/tagCatalog/workflows/selection）
                ＋一个静态参考表令牌 "refs"（别名 "staticRefs"）。minimal 档缺省只留 nodes，点名
                哪块才带哪块；standard / full 档缺省全给、这份名单做收窄。静态参考表
                （imageSizes / defaultImageSize / kinds）任何档位缺省都不带，只有点名 "refs" 才补回。
                恒保留的只有极小信封：workflow / scopeInfo / assistScope · scopeNote。 */
  /* minimal = 最小信息量：每节点只给 标题(title) / 描述(note) / 类别(kind)。
     id、坐标、尺寸、运行态、层级归属、tags 一律不带 —— 节点按标题 / ids 定位，
     要看结构（位置 / 连线 / 层级）显式用 standard / full。 */
  const NODE_MINIMAL_KEYS = ["title", "note", "kind"];
  /* jscode（函数节点函数体）与 prompt / task 同属正文：bodies:false 时只留 *Len，bodyLimit 生效 */
  const NODE_BODY_KEYS = ["text", "prompt", "task", "goal", "jscode"];
  const SNAPSHOT_HEAVY_SECTIONS = [
    "nodes", "marks", "wires", "groups", "taskTree", "superTree",
    "tagCatalog", "workflows", "selection",
  ];
  /* ── minimal 档 = 纯粹的「节点索引」───────────────────────────────────────────
     模型缺省读图（网关 DEFAULT_GET_DETAIL="minimal"）只该拿到「这张图上有哪些节点」，
     而不是一份整图配置。所以除了每节点裁到 标题/描述/类别，重型块也只留 nodes ——
     marks / wires / groups / taskTree / superTree / tagCatalog / workflows / selection
     一律不带（要哪块就 sections 显式点名，例如只查连线 sections:["nodes","wires"]）。 */
  const MINIMAL_SNAPSHOT_SECTIONS = ["nodes"];
  /* 这些「恒带小上下文」在 minimal 档同样要摘：视角信息（cam / view / 焦点）与色卡
     （markColors / devFuncColors）都是「要动手建图 / 看配置」时才用得上，节点索引里没有
     任何一条引用它们，却每份都跟着重发。要它们显式 detail:"standard"。
     静态参考表（imageSizes / defaultImageSize / kinds）已从所有档位移除，不在这份名单里 ——
     见 attachSnapshotStaticRefs：只有 sections 点名 "refs" 才补回。 */
  const MINIMAL_SNAPSHOT_DROP = [
    "view", "cam",
    "taskFocus", "superFocus", "markColors", "devFuncColors",
  ];

  function clipStr(s, n) {
    s = String(s == null ? "" : s);
    return s.length > n ? s.slice(0, n) + "…" : s;
  }

  /* canvas_get：节点正文一律全文，不做字数或 token 截断（正文是模型显式 detail:"full"
     要来的）。助手每轮快照不同：它只给节点计数与选中 / 焦点，连节点索引都不带
     （见 app-assist.js assistAppSnapshot），列表 / 结构 / 正文一律由模型按需现拉。 */
  function snapTextField(raw) {
    const s = String(raw == null ? "" : raw);
    return { text: s, textLen: s.length };
  }

  function normalizeSnapshotOpts(opts) {
    opts = opts || {};
    const detail =
      opts.detail === "minimal" || opts.detail === "standard"
        ? opts.detail
        : "full";
    const wantBodies =
      opts.bodies === undefined ? detail === "full" : !!opts.bodies;
    const bodyLimit = Math.max(0, Math.round(Number(opts.bodyLimit) || 0));
    const ids =
      Array.isArray(opts.ids) && opts.ids.length
        ? opts.ids.map((x) => (x == null ? "" : String(x))).filter(Boolean)
        : null;
    const scope = opts.scope == null ? "" : String(opts.scope).trim();
    const scopeDepth = opts.scopeDepth === "all" ? "all" : "direct";
    return { detail, wantBodies, bodyLimit, onlyIds: ids, scope, scopeDepth };
  }

  /* ==================== 局部画布（scope）：只读 / 只改一颗壳内部 ====================
     需求：查看与编辑工具要能「只钻进某一颗节点层 / 开发节点」（而不是每次灌整张图），
     省时间与 token。两条入口：
       · 显式 —— scope:"标题或 id" + scopeDepth:"direct"|"all"；
       · 屏幕 —— 缺省跟着用户当前停留的那一层（用户点进壳里时可见集本就是那一层，快照不再
         把整图灌进去；scopeInfo 会点名这颗壳，Agent 可照抄标题显式传 scope）。
     显式 scope 一旦给了，它就是这次调用要看的「那一层」，不再被 S.superFocus 二次砍小。
     本段是只读侧（canvasSnapshot），写入侧的越界防护在 applyCanvasEdit 的 scope 闸。 */

  /* scope 令牌 → 那颗壳；"global" / "" 解析为 null（= 整图），非 super 的令牌返回
     { bad:true, token } 由调用方警告。首尾一层引号顺手剥掉：模型偶尔把 id 写成 "\"abc\""。 */
  function resolveScopeHost(H, token) {
    const { nodeById } = H;
    let raw = String(token == null ? "" : token).trim();
    if (/^".*"$/.test(raw) || /^'.*'$/.test(raw)) raw = raw.slice(1, -1).trim();
    if (!raw || raw === "global" || raw === "all" || raw === "*") return null;
    const n = typeof nodeById === "function" ? nodeById(raw) : null;
    if (!n) return { bad: true, token: raw };
    if (n.kind !== "super") return { bad: true, token: raw, notSuper: true };
    return n;
  }

  /* 从 startId 沿 parentSuperId 向上收集祖先（不含自己），带环保护 */
  function superAncestorIdsOf(H, startId) {
    const S = H.state;
    const out = [];
    const seen = new Set();
    const all = (S.wf && S.wf.nodes) || [];
    let sid = startId;
    while (sid && !seen.has(sid)) {
      seen.add(sid);
      const host = all.filter((x) => x.id === sid)[0];
      if (!host || host.kind !== "super") break;
      const up = String(host.parentSuperId || "");
      if (!up) break;
      out.push(up);
      sid = up;
    }
    return out;
  }

  /* host 的子树节点（不含 host 自己；含 super_io 端口节点 —— 局部视图里端子要看得见） */
  function superSubtreeIds(H, host) {
    const S = H.state;
    const all = (S.wf && S.wf.nodes) || [];
    const out = new Set();
    if (!host) return out;
    const queue = [host.id];
    const seen = new Set([host.id]);
    while (queue.length) {
      const cur = queue.shift();
      for (const n of all) {
        if (!n || seen.has(n.id)) continue;
        if (String(n.parentSuperId || "") !== cur) continue;
        seen.add(n.id);
        out.add(n.id);
        queue.push(n.id);
      }
    }
    return out;
  }

  /* scope 命中判定（= applyCanvasEdit 写入闸与快照只读闸共用的真源）：
     allowed = "both"（壳里 + 嵌套子块）| "self"（只那颗壳自己）。
     · 壳里任何一颗（直接子节点）都算 allowed；
     · 嵌套更深的子块，其祖先链上每一颗都必须 allowed —— 库里还有别的壳把节点围住时，
       围住它的那颗壳本身不在范围内，就不算命中（scope 是硬边界，不是"沾亲就放行"）。 */
  function nodeInSuperScope(H, n, host, allowed) {
    if (!n || !host || !allowed) return false;
    if (n.id === host.id) return true;
    const chain = superAncestorIdsOf(H, n.id);
    if (!chain.length) return false;
    for (const id of chain) {
      if (!allowed.has(id)) return false;
    }
    return true;
  }

  /* 显式 x/y 是否落在这颗壳的范围内（shell 展开态按绘制尺寸，收起态按存储尺寸）：
     只有「给了坐标、又没点名归属」的新节点才拿它做界外判定；壳内坐标可以是嵌套子块
     的世界坐标（画布内是相对的，展开壳里子块的坐标落在壳的绘制框内），故留 2 倍余量。 */
  function pointInScopeHost(H, host, x, y) {
    const { superDisplaySize } = H;
    if (!host) return false;
    const size =
      typeof superDisplaySize === "function"
        ? superDisplaySize(host)
        : { w: host.w || 280, h: host.h || 200 };
    const pad = 160;
    return (
      Number(x) >= host.x - pad &&
      Number(x) <= host.x + size.w + pad &&
      Number(y) >= host.y - pad &&
      Number(y) <= host.y + size.h + pad
    );
  }

  /* 局部只读的允许集：host 自己 + 直接子节点（+ 递归子块，scopeDepth="all" 时） */
  function scopedNodeIdSet(H, host, depth) {
    const S = H.state;
    const out = new Set();
    if (!host) return out;
    out.add(host.id);
    const all = (S.wf && S.wf.nodes) || [];
    for (const n of all) {
      if (n && String(n.parentSuperId || "") === host.id) out.add(n.id);
    }
    if (depth === "all") {
      for (const id of superSubtreeIds(H, host)) out.add(id);
    }
    return out;
  }

  /* 局部视图的可见判据（与「用户点进壳里」的所见同一语义，但按本次 scope 的层级算）：
     壳里 = 壳自己 + 它的直接子节点（+ scopeDepth="all" 时叠上整棵子树）。
     刻意不看 S.superFocus / 展开态：scope 一旦被显式指定，它就是这次调用要看的「那一层」，
     用户此刻停在哪颗壳里不该再把返回集砍小（否则 scope:"开发壳" 只回得回一个 file 块）。 */
  function nodeInSnapshotScope(H, n, host, depth) {
    if (!n || !host) return false;
    if (n.id === host.id) return true;
    if (String(n.parentSuperId || "") === host.id) return true;
    return depth === "all" && superSubtreeIds(H, host).has(n.id);
  }

  /* 快照 / 视图层口径：算出本次要收窄到哪颗壳。
     opts.scope 显式给了就认它（"global" = 整图）；没给就跟着用户当前停留的壳。 */
  function snapshotScopeOf(H, opts) {
    const S = H.state;
    const { nodeById, currentSuperFocus } = H;
    opts = opts || {};
    const raw = opts.scope == null ? "" : String(opts.scope).trim();
    if (raw) {
      if (raw === "global" || raw === "all" || raw === "*")
        return { host: null, origin: "global", bad: null };
      const resolved = resolveScopeHost(H, raw);
      if (resolved && resolved.bad)
        return { host: null, origin: "global", bad: resolved };
      return {
        host: resolved,
        origin: "explicit",
        depth: opts.scopeDepth === "all" ? "all" : "direct",
        bad: null,
      };
    }
    const focus =
      typeof currentSuperFocus === "function" ? currentSuperFocus() : S.superFocus || "";
    if (focus) {
      const host = typeof nodeById === "function" ? nodeById(focus) : null;
      if (host && host.kind === "super")
        return { host, origin: "screen", depth: "direct", bad: null };
    }
    return { host: null, origin: "global", bad: null };
  }

  function scopeInfoBlock(H, sc, hostsAll) {
    const I18n = H.i18n;
    const { nodeById, currentSuperFocus } = H;
    if (!sc) return undefined;
    const host = sc.host;
    const focusHost =
      !host && typeof currentSuperFocus === "function" && currentSuperFocus()
        ? nodeById(currentSuperFocus())
        : null;
    const info = {
      mode: host ? "subtree" : "global",
      origin: sc.origin,
      depth: host ? sc.depth : undefined,
      hostId: host ? host.id : undefined,
      hostTitle: host ? host.title : undefined,
      hostKind: host ? (host.dev ? "dev" : host.db ? "db" : "super") : undefined,
    };
    if (!host) {
      /* 用户此刻停在某颗壳里：不自动收窄（别的消费者还要整图），只提醒可以显式传 scope */
      if (focusHost && focusHost.kind === "super") {
        info.hint = I18n.t(
          "用户当前正停在这颗壳里：{title}（id {id}）。只看 / 只改它内部请传 scope 用这颗壳的标题或 id，配 scopeDepth 决定一层还是整棵 —— 避免整图灌进来浪费 token。",
          { title: focusHost.title, id: focusHost.id },
        );
      }
      return info;
    }
    if (sc.origin === "screen") {
      info.note = I18n.t("当前可见 = 用户正停在的这颗壳内部。");
    } else {
      info.note = I18n.t("范围 = 这一颗壳内部：界外节点未返回。");
      const above = superAncestorIdsOf(H, host.id)
        .map((id) => (hostsAll || []).filter((x) => x.id === id)[0])
        .filter(Boolean)
        .map((x) => ({ id: x.id, title: x.title }));
      if (above.length) info.above = above;
    }
    return info;
  }

  function nodeInFilter(n, o) {
    if (!o.onlyIds) return true;
    return o.onlyIds.some((t) => n.id === t || n.title === t);
  }

  function pruneNodeSnap(node, o) {
    if (!node) return node;
    if (o.detail === "minimal") {
      const out = {};
      for (const k of NODE_MINIMAL_KEYS) {
        if (node[k] !== undefined) out[k] = node[k];
      }
      return out;
    }
    if (!o.wantBodies) {
      const out = {};
      for (const k of Object.keys(node)) {
        if (!NODE_BODY_KEYS.includes(k)) out[k] = node[k];
      }
      return out;
    }
    if (o.bodyLimit > 0) {
      for (const k of NODE_BODY_KEYS) {
        const v = node[k];
        if (typeof v === "string" && v.length > o.bodyLimit) {
          node[k] = v.slice(0, o.bodyLimit);
        }
      }
    }
    return node;
  }

  function applySnapshotSectionFilter(snap, sections) {
    if (!snap || !Array.isArray(sections) || !sections.length) return snap;
    const keep = new Set(sections.map((s) => String(s)));
    for (const k of SNAPSHOT_HEAVY_SECTIONS) {
      if (!keep.has(k)) delete snap[k];
    }
    return snap;
  }

  /* minimal 档裁剪：重型块只留 MINIMAL_SNAPSHOT_SECTIONS（nodes），恒带小上下文里再摘掉
     视角与色卡（MINIMAL_SNAPSHOT_DROP）。sections 是「白名单」语义 —— 显式点名哪块就
     放行哪块（sections:["nodes","wires"] 仍能便宜地只查连线），缺省则只剩节点索引。
     保留：workflow（这是哪张图）/ scopeInfo（这次看到的是整图还是某颗壳内部）/
     assistScope · scopeNote（跨画布锁定的安全口径）。 */
  function pruneMinimalSnapshot(snap, opts) {
    if (!snap || typeof snap !== "object") return snap;
    const keep = new Set(MINIMAL_SNAPSHOT_SECTIONS);
    const asked =
      opts && Array.isArray(opts.sections) ? opts.sections : [];
    for (const s of asked) keep.add(String(s));
    for (const k of SNAPSHOT_HEAVY_SECTIONS) {
      if (!keep.has(k)) delete snap[k];
    }
    for (const k of MINIMAL_SNAPSHOT_DROP) delete snap[k];
    return snap;
  }

  /* 这次调用是否要带上某一个重型块：非 minimal 档恒要（除非 sections 另行收窄），
     minimal 档只有 sections 显式点名才要。canvasSnapshotFull 与 canvasSnapshot 共用。 */
  function snapshotWantsSection(o, opts, key) {
    if (!o || o.detail !== "minimal") return true;
    const asked = opts && Array.isArray(opts.sections) ? opts.sections : [];
    return asked.map((s) => String(s)).indexOf(key) >= 0;
  }

  /* ── 静态参考表（按需闸）─────────────────────────────────────────────────────
     imageSizes / defaultImageSize / kinds 是三张「建图 / 选尺寸」才用得上的静态表：它们
     既不属于任何档位（minimal / standard / full 缺省都不带），也不是重型块 —— 所以不进
     SNAPSHOT_HEAVY_SECTIONS，只由这一个闸单独判：sections 白名单里出现 "refs"（或别名
     "staticRefs"）才补回。补在裁剪之后，minimal 的 DROP 名单不会再把它们摘掉。 */
  function snapshotWantsStaticRefs(opts) {
    const asked = opts && Array.isArray(opts.sections) ? opts.sections : [];
    return asked
      .map((s) => String(s).trim())
      .some((s) => s === "refs" || s === "staticRefs");
  }

  function attachSnapshotStaticRefs(H, snap) {
    const { imageSizes, defaultImageSize, nodeDefaults } = H;
    if (!snap || typeof snap !== "object") return snap;
    snap.imageSizes = (imageSizes || IMAGE_SIZES).slice();
    snap.defaultImageSize = defaultImageSize || DEFAULT_IMAGE_SIZE;
    snap.kinds = kindsOf(nodeDefaults);
    return snap;
  }

  /* ── 端子表（快照 / 回执 / 连线预检共用同一份推导）─────────────────────────────
     数量 inputCount / outputCount、名称 editPortNameOf、类型 editPortKindOf（工具 /
     函数节点按参数表）、占用按 wf.wires —— 与连线校验 connectError 同一套原语，
     这里只做搬运，不另立第二份端子口径。 */
  function nodePortList(H, node, dir) {
    const S = H.state;
    const { nodeById, isFnToolNode, inputCount, outputCount, editPortNameOf, editPortKindOf } = H;
    if (!node || !S.wf) return [];
    const isFnT = isFnToolNode(node);
    const count = dir === "in" ? inputCount(node) : outputCount(node);
    const wires = S.wf.wires || [];
    const out = [];
    for (let i = 0; i < Math.max(0, count); i++) {
      const links = [];
      for (const w of wires) {
        if (w.rel) continue;
        if (dir === "in") {
          if (w.to !== node.id || Number(w.toIndex || 0) !== i) continue;
          const other = nodeById(w.from);
          links.push({ node: other ? other.title : "", port: Number(w.fromIndex || 0) });
        } else {
          if (w.from !== node.id || Number(w.fromIndex || 0) !== i) continue;
          const other = nodeById(w.to);
          links.push({ node: other ? other.title : "", port: Number(w.toIndex || 0) });
        }
      }
      out.push({
        dir,
        index: i,
        name: editPortNameOf(node, dir, i, isFnT),
        kind: editPortKindOf(node, dir, i, isFnT),
        connectedTo: links.length ? links : null,
      });
    }
    return out;
  }

  /* 端子数固定的节点：快照（standard / full）里直接暴露端口表，让模型接线前就看得见
     「几号端子、什么类型、被谁占了」，不必等 connect 报错再改 —— 运行期才发现端子冲突
     是实测里最贵的一类往返。minimal 档不带（app_state 每轮重发，必须最轻）。 */
  const SNAPSHOT_PORT_KINDS = [
    "proc_image", "video_gen", "video_upscale", "video_interp", "remotion", "judge", "super",
    /* 质检节点（五种同构）：3 进 4 出全由结构钉死，且入 1「质检要求」同时收文字口径与参考样例、
       出 2/3 是门禁分流 —— 接线前必须一次读全。 */
    "qa_text", "qa_image", "qa_video", "qa_audio", "qa_file",
    /* 音频 / 视频输入：两个固定数据出端子（0=音频 / 视频输出＝文件 file:/// URL ·
       1=转写输出＝该文件的文字），接线前就该看得见「哪个是文件、哪个是文字」，
       所以也进定端口名单。 */
    "input_audio", "input_video",
  ];
  function snapshotHasFixedPorts(H, node) {
    const { isAssetNode, isFnToolNode } = H;
    if (!node) return false;
    /* 素材节点：端子数 = 内容条目数（内容条目即端子 · 第 i 入 ↔ 第 i 出）。
       它以前不在 ports 之列，模型只看得见「节点在、里面空」——条目号 / 条目标题 /
       类型 / 占用全要等 connect 报错才知道。条目是可增删的固定端子，必须一起预检。 */
    if (isAssetNode(node)) return true;
    if (isFnToolNode(node)) return true;
    return SNAPSHOT_PORT_KINDS.indexOf(node.kind) >= 0;
  }
  /* 「输入端子随连线增量长出来」的节点（= app.js inputCount 落到泛用增量公式
     `Math.max(1, allWiresTo(id).length + 1)` 的那几类）：端子数是现算的，ports 报的只是
     「当下真实存在」的那几个槽。它们与 SNAPSHOT_PORT_KINDS 有交集（proc_image /
       remotion），所以不能拿「在不在固定名单里」当判据；名单照固定端子节点那一族的写法
       列成常量（真源仍是 app.js inputCount，改那边要顺手核对这里）。 */
  const INCREMENTAL_PORT_KINDS = [
    "proc_text", "proc_image", "agent_task",
    "input_text", "input_image", "input_audio", "input_video", "input_file", "input_any",
  ];
  /* 是不是「随连线增量」的那一类：名单内 + 端子数确实等于「已连数据线 + 1」（再核一道，
     名单漂了也不会误报）。工具 / 函数 / 素材 / super / 控制类节点各有自己的端子口径，排除。 */
  function snapshotInputGrowsWithWires(H, node) {
    const {
      isFnToolNode, isAssetNode, isControlKind, isDynCtrlNode, dynCtrlInPortIndex,
      inputCount, allWiresTo,
    } = H;
    if (!node) return false;
    if (isFnToolNode(node) || isAssetNode(node)) return false;
    if (node.kind === "super" || isControlKind(node)) return false;
    if (INCREMENTAL_PORT_KINDS.indexOf(node.kind) < 0) return false;
    /* 动态端子族（app.js DYN_CTRL_KINDS）：端子数现在含末位那颗专用控制端子，
       按同一份真源核一道（不再按「已连线条数 + 1」数）。 */
    if (
      typeof isDynCtrlNode === "function" &&
      isDynCtrlNode(node) &&
      typeof dynCtrlInPortIndex === "function"
    )
      return (Number(inputCount(node)) || 0) === dynCtrlInPortIndex(node) + 1;
    let wired = 0;
    try {
      wired = allWiresTo(node.id).length;
    } catch (e) {
      wired = 0;
    }
    return (Number(inputCount(node)) || 0) === wired + 1;
  }
  function snapshotPortsOf(H, node) {
    if (!snapshotHasFixedPorts(H, node)) return undefined;
    const ports = nodePortList(H, node, "in").concat(nodePortList(H, node, "out"));
      /* proc_image / remotion 这类节点也在这份「定端口」名单里，但它们的输入是**增量**的：
       空白节点只列得出「端口 0 = 提示词」，实测中模型据此误判「这个节点没有图像参考端子」，
       去试连一条线再看 warnings 反推接法（白花两轮往返）。给它们的 ports 挂一句「端子怎么长」，
       一次读图就读全。理由同 snapshotDynamicPortRule，两处共用一份文案真源。 */
    if (node.kind === "remotion" || snapshotInputGrowsWithWires(H, node)) {
      const rule = snapshotPortRuleOf(H, node);
      if (rule) ports.rule = rule;
    }
    return ports;
  }

  /* Remotion 的端子规则（标准 / 完整档）：它是全仓唯一「数据线与控制线共用同一批端子」的
     节点，Agent 只读 ports 会以为「控制口固定在 0 / 描述口固定在某号」，必须一次说明白。 */
  function snapshotRemotionPortRule(H, node) {
    const I18n = H.i18n;
    const { inputCount, outputCount } = H;
    const nIn = Number(inputCount(node)) || 0;
    const nOut = Number(outputCount(node)) || 0;
    return {
      note: I18n.t(
        "输入端子无差别：端口 0、1、2… 连一条多一个，数据线（视频 / 图片 / 音频 / 台词文本）与控制线共用同一批端子，先占先得；描述已改成节点内字段 text（可空），不占端子。",
      ),
      input: I18n.t("端口 0+ = 输入端子（任意来源：视频 / 图片 → 主素材 hero · 音频 → 语音 voice · 文本 → 台词 narration · 控制节点 → 触发渲染）"),
      output: I18n.t("端口 0 = 内容（mp4 路径）· 端口 1 = 控制输出"),
      now: { in: nIn, out: nOut },
      hint: I18n.t(
        "接线不必指定 toIndex：不传就落第一个空闲端子。三路线（动态层 / 语音 / 台词）依次连即落 0、1、2。描述写进节点 text（支持 @节点标题 引用已接线内容）。",
      ),
    };
  }
  /* ports.rule 的统一取值：remotion 用自己的那一份，其余增量节点用通用那一份 */
  function snapshotPortRuleOf(H, node) {
    if (node && node.kind === "remotion") return snapshotRemotionPortRule(H, node);
    return snapshotDynamicPortRule(H, node);
  }

    /* 端子数**不固定**的节点（proc_text / proc_image / input_* …）：
     它们的输入端子是按已连线条数**增量长出来**的，ports 只能报「当下这一条、这一张图
     真实存在的那几个槽」——空白节点回的就是「端口 0 = 提示词」这一条。只给 ports 会让模型
     以为「这个节点根本没有图像参考端子」（实测：模型读不到 1+ 号槽，就去试连一条线再看
     warnings 反推接法，白花两轮往返）。
     所以这里补一条「端子怎么长」的规则，让读图一次就读全：端口 0 = 提示词 / 文本入口、
     端口 1+ = 数据槽（连一条多一个，文本与图像引用都收）、输出 0 = 内容、末位 = 控制。
     只在 standard / full 档给（minimal 档是纯索引，照旧不带）；接线时怎么读这条规则的
     唯一说明在 canvas_get 描述的 portRule 一条（dsh/gateway/canvas-plugin.mjs），此处不再抄。 */
  function snapshotDynamicPortRule(H, node) {
    const I18n = H.i18n;
    const { inputCount, outputCount, isDynCtrlNode, dynCtrlInPortIndex } = H;
    if (!node) return undefined;
    if (!snapshotInputGrowsWithWires(H, node)) return undefined;
    const nIn = Number(inputCount(node)) || 0;
    const nOut = Number(outputCount(node)) || 0;
    /* 专用控制端子（真源 app.js dynCtrlInPortIndex）：数据槽之后单独一颗，恒存在、可接多条控制线 */
    const ctrl =
      typeof isDynCtrlNode === "function" && isDynCtrlNode(node) && typeof dynCtrlInPortIndex === "function"
        ? dynCtrlInPortIndex(node)
        : null;
    return {
      note: I18n.t(
        "输入端子随连线增量：端口 0 = 提示词 / 内容入口，每多连一条数据线多出一个数据槽；末位另有一颗**专用控制端子**（控制线只连它，数据线永不占它，可接多条 · 任一到达即触发一次）。",
      ),
      input: I18n.t(
        "端口 0 = 提示词 / 文本入口 · 端口 1+ = 数据槽（连一条多一个 · 文本 / 图像引用都收）· 末位 = 控制输入（现在是端口 {n}）",
        { n: ctrl == null ? "—" : ctrl },
      ),
      output: I18n.t("端口 0 = 内容 · 末位 = 控制输出"),
      now: { in: nIn, out: nOut },
      hint: I18n.t(
        "ports 只列当前真实存在的端子；要接参考图直接连端口 1+ 即可，不必先试连一次看 warnings。控制线（▶ control / 上游控制输出）连这颗末位控制端子即可，不传 toIndex 时也会自动落到它。",
      ),
    };
  }

  /* 「参数」端子（renderer/app-node-params.js）：paramKeys = 本节点**可被参数覆写**的键
     （standard / full 档才回，minimal 省 token）。参数只能从端子（toIndex 9001）传入 ——
     canvas_edit 的 params 字段已取消，节点上不存在「自带参数」这回事。
     参数端子的端子号是哨兵值 PARAM_IN_INDEX（不进 0..N-1 的顺序端口）。
     判定与键表都问宿主那份参数系统（H.NParam），内核不另立第二份参数口径。 */
  function snapshotParamKeysOf(H, node, detail) {
    const { NParam } = H;
    return detail !== "minimal" &&
      typeof NParam === "object" &&
      NParam &&
      typeof NParam.eligible === "function" &&
      NParam.eligible(node)
      ? NParam.schemaOf(node).map((s) => s.key)
      : undefined;
  }

  /* ── 素材节点（kind "asset"）在 canvas_get 里的回读口径 ──────────────────────────
     内容实体恒在素材库，节点上只存绑定（assetId / assetRel / assetName / assetDesc）与
     条目快照（items：[{id,title,type}]）。本段是 Agent 读素材节点的唯一出口：
       · snapshotAssetNodeOf —— 绑定 + 条目清单（端子号 = 条目号）。没有它，Agent 读到的
         素材节点配置是空的（每个字段都 undefined），只能看见几条线凭空接在节点上 ——
         这正是「素材节点内容是空的」这条报告的根因；
       · snapshotAssetContentOf —— full / bodies 档的条目正文（文本给正文，媒体给本机
         路径），复用 bodyLimit 截断口径。standard 档只给清单与 *Len 长度提示符，
         正文仍要显式 detail:"full" 才下来（与 text / prompt 同一档位纪律）。
       （snapshotAssetContentOf 要读素材库 / 走异步，留在渲染层 app-nodes.js。） */

  /** 素材节点 Snapshot 绑定 + 条目清单；非素材节点 / 未绑定 / 空条目 → undefined */
  function snapshotAssetNodeOf(H, node) {
    const { isAssetNode, assetItems, assetNodeIsLost } = H;
    if (!isAssetNode(node)) return undefined;
    const assetId = String(node.assetId || "").trim();
    const items = assetItems(node).map((it, i) => ({
      index: i,
      id: it.id,
      title: it.title,
      type: it.type,
    }));
    const lost =
      assetId &&
      typeof assetNodeIsLost === "function" &&
      assetNodeIsLost(node);
    return {
      assetId: assetId || undefined,
      assetName: String(node.assetName || "").trim() || undefined,
      assetRel: String(node.assetRel || "").trim() || undefined,
      assetDesc: String(node.assetDesc || "").trim() || undefined,
      lost: lost ? true : undefined,
      itemCount: items.length,
      items: items.length ? items : undefined,
    };
  }

  /* Agent 侧透出「功能色卡」：唯一真源是 app-devnode.js 的 DEV_FUNC_COLORS 常量（由宿主传
     进来），这里只搬运 key / zh / en / hex（keywords 属内部推断细节，不塞进快照浪费 token）。
     mtnode_canvas_get 与助手快照都通过 devFuncColors 字段读到同一张表。 */
  function devFuncColorCatalog(src) {
    const list = Array.isArray(src) ? src : [];
    return list
      .map((c) => ({
        key: String((c && c.key) || ""),
        zh: String((c && c.zh) || ""),
        en: String((c && c.en) || ""),
        hex: String((c && c.hex) || "").toLowerCase(),
      }))
      .filter((c) => c.key && /^#[0-9a-f]{6}$/.test(c.hex));
  }

  /* ============================== 快照正文 ============================== */
  function canvasSnapshot(H, opts) {
    const S = H.state;
    const I18n = H.i18n;
    const {
      nodeById, currentTaskFocus, currentSuperFocus, nodeInCurrentScope, markInCurrentScope,
      isSuperIoNode, nodeParentSuperId, wfTagCatalog, isFunctionNode, canUseGlobalRefs,
      normalizeNodeTags, isToolNode, ensureFnToolNodeState, fnToolParamList, execIconKeyOf,
      execColorOf, isNetNode, isCustomVideoGen, h3WfPortOf, mediaGenOutputRaw, yueGenCotOf,
      breezeModeOf, breezeCfgScaleOf, breezeSeedOf, breezeFormatOf, remotionContractOf,
      MARK_COLORS, DEV_FUNC_COLORS, relArrowOf, devKindOf, devColorOf, devCoreFilesOf,
      devCoreFilesSourceOf, entryDisplayTitle, singleImageTitle,
    } = H;
    const { imageSizes: IMAGE_SIZES, defaultImageSize: DEFAULT_IMAGE_SIZE } = H;
    const o = normalizeSnapshotOpts(opts);
    const wf = S.wf || { id: "", name: "", nodes: [], wires: [], groups: [], marks: [] };
    const allNodes = wf.nodes || [];
    /* 局部画布（scope）：只返回某颗节点层 / 开发节点里的内容；scopeInfo 恒保留，
       模型永远知道自己看到的是整图还是某一颗壳内部。 */
    const sc = snapshotScopeOf(H, o);
    const inScope = sc.host ? scopedNodeIdSet(H, sc.host, sc.depth) : null;
    const scopeHit = (n) => !inScope || (n && inScope.has(n.id));
    /* 局部视图里一条线 / 一个任务是否算「在壳里」：显式 scope 按 scope 层级，
       否则按当前屏幕那一层（原口径）。标注另有 mark 版判据（看 parentSuperId）。 */
    const viewHit = (n) =>
      sc.host
        ? nodeInSnapshotScope(H, n, sc.host, sc.depth)
        : nodeInCurrentScope(n);
    const markViewHit = (m) =>
      sc.host
        ? !!(m && (m.parentSuperId || "") === sc.host.id)
        : markInCurrentScope(m);
    const scopeNodes = allNodes
      .filter((n) => !isSuperIoNode(n))
      .filter((n) => (sc.host ? nodeInSnapshotScope(H, n, sc.host, sc.depth) : nodeInCurrentScope(n)))
      .filter((n) => scopeHit(n))
      .filter((n) => nodeInFilter(n, o));
    /* 实际会返回的节点 id（scope + 屏幕层 + ids 三层过滤后的结果）：scopeNestedIn 用得到 */
    const returnedNodeIds = new Set(scopeNodes.map((n) => n.id));
    const selNodeIds = o.onlyIds ? new Set(scopeNodes.map((n) => n.id)) : null;
    const ancestorsOfScope = sc.host ? superAncestorIdsOf(H, sc.host.id) : [];
    /* ── childCount 预聚合 ──────────────────────────────────────────────────
       原先是每颗 task / super 各自 allNodes.filter(...) 一遍（O(n²)：整图几百个节点时
       一次快照几十万次比较）。这里先**一次线性扫**出两张计数表，取值口径与逐节点
       filter 完全一致：taskTree 认 parentTaskId，superTree 认 parentSuperId 且排除
       super_io 端子节点；空串不算任何人的孩子（节点 id 恒非空）。 */
    const taskChildCount = new Map();
    const superChildCount = new Map();
    for (const x of allNodes) {
      if (!x) continue;
      const pt = x.parentTaskId;
      if (pt) taskChildCount.set(pt, (taskChildCount.get(pt) || 0) + 1);
      if (isSuperIoNode(x)) continue;
      const ps = nodeParentSuperId(x);
      if (ps) superChildCount.set(ps, (superChildCount.get(ps) || 0) + 1);
    }
    const snap = {
      workflow: {
        id: wf.id,
        name: wf.name,
        nodeCount: allNodes.length,
        workspace: wf.workspace || "",
      },
      view: S.view || "workflow",
      cam: S.cam
        ? { x: Math.round(S.cam.x), y: Math.round(S.cam.y), z: Number(S.cam.z.toFixed(3)) }
        : null,
      /* 静态参考表（imageSizes / defaultImageSize / kinds）不在这里：任何档位缺省都不带，
         只有 sections 点名 "refs" 时由 attachSnapshotStaticRefs 补回（见该函数）。 */
      taskFocus: currentTaskFocus() || undefined,
      superFocus: currentSuperFocus() || undefined,
      taskTree: allNodes
        .filter((n) => n.kind === "task" && viewHit(n) && scopeHit(n))
        .map((n) => ({
          id: n.id,
          title: n.title,
          parentTaskId: n.parentTaskId || "",
          goal: clipStr(n.goal, 160),
          status: n.taskStatus || "pending",
          steps: (n.steps || []).map((s) => (s && s.title) || ""),
          childCount: taskChildCount.get(n.id) || 0,
        })),
      superTree: allNodes
        .filter((n) => n.kind === "super")
        .filter(
          (n) =>
            !inScope ||
            n.id === sc.host.id ||
            ancestorsOfScope.includes(n.id) ||
            inScope.has(n.id),
        )
        .map((n) => ({
          id: n.id,
          title: n.title,
          parentSuperId: n.parentSuperId || "",
          parentTaskId: n.parentTaskId || "",
          subFolder: n.subFolder || "",
          superOpen: !!n.superOpen,
          db: !!n.db,
          dbCount: n.dbIndex && n.dbIndex.records ? n.dbIndex.records.length : 0,
          dev: !!n.dev,
          devPath: n.dev ? String(n.devPath || "") || undefined : undefined,
          devStatus: n.dev ? n.devStatus || "pending" : undefined,
          devKind: n.dev ? devKindOf(n) || "module" : undefined,
          /* 核心文件列表（展示口径：显式写入优先，为空时是自动兜底收集的结果） */
          devFiles: n.dev ? devCoreFilesOf(n) : undefined,
          devModel: n.dev ? String(n.devModel || "").trim() || undefined : undefined,
          devProvider: n.dev
            ? String(n.devProvider || "").trim() || undefined
            : undefined,
          /* Agent 预设 / 思考强度（与会话同一张档位表；空 = 跟随默认） */
          devPreset: n.dev
            ? String(n.devPreset || "").trim() || undefined
            : undefined,
          devEffort: n.dev
            ? String(n.devEffort || "").trim() || undefined
            : undefined,
          childCount: superChildCount.get(n.id) || 0,
          note: clipStr(n.note, 120),
        })),
      tagCatalog: wfTagCatalog().slice(),
      nodes: scopeNodes.map((n) => {
        const inputSnap =
          n.kind === "input_text" ? snapTextField(n.text) : null;
        const promptSnap =
          n.prompt != null ? snapTextField(n.prompt) : null;
        const taskSnap =
          n.task != null ? snapTextField(n.task) : null;
        const goalSnap =
          n.kind === "task" ? snapTextField(n.goal) : null;
        /* 函数节点的 JS 函数体（node.jscode）与 prompt / task 同属正文口径 */
        const jscodeSnap = isFunctionNode(n) ? snapTextField(n.jscode) : null;
        const node = {
        id: n.id,
        kind: n.kind,
        title: n.title,
        x: n.x,
        y: n.y,
        w: n.w,
        h: n.h,
        running: !!n.running,
        text: inputSnap ? inputSnap.text : undefined,
        textLen: inputSnap ? inputSnap.textLen : undefined,
        prompt: promptSnap ? promptSnap.text : undefined,
        promptLen: promptSnap ? promptSnap.textLen : undefined,
        task: taskSnap ? taskSnap.text : undefined,
        taskLen: taskSnap ? taskSnap.textLen : undefined,
        jscode: jscodeSnap ? jscodeSnap.text : undefined,
        jscodeLen: jscodeSnap ? jscodeSnap.textLen : undefined,
        savePath: n.savePath || undefined,
        waitPath: n.kind === "wait_file" ? n.waitPath || undefined : undefined,
        waitIntervalSec:
          n.kind === "wait_file"
            ? Math.max(1, Math.min(60, Math.round(Number(n.waitIntervalSec) || 2)))
            : undefined,
        timerMode: n.kind === "timer" ? n.timerMode || undefined : undefined,
        timerAt: n.kind === "timer" ? n.timerAt || undefined : undefined,
        timerEverySec:
          n.kind === "timer"
            ? Math.max(1, Math.round(Number(n.timerEverySec) || 3600))
            : undefined,
        timerCron: n.kind === "timer" ? n.timerCron || undefined : undefined,
        timerArmed: n.kind === "timer" ? !!n.timerArmed : undefined,
        timerNextAt: n.kind === "timer" ? n.timerNextAt || undefined : undefined,
        delaySec: n.kind === "delayer" ? n.delaySec || undefined : undefined,
        popupTitle: n.kind === "popup" ? String(n.popupTitle || "") : undefined,
        popupText: n.kind === "popup" ? String(n.popupText || "") : undefined,
        seqOutputs: n.kind === "sequencer" ? n.seqOutputs || undefined : undefined,
        seqGapSec: n.kind === "sequencer" ? n.seqGapSec || undefined : undefined,
        gateInputs: n.kind === "gate" ? n.gateInputs || undefined : undefined,
        splitOutputs:
          n.kind === "splitter" ? n.splitOutputs || undefined : undefined,
        counterEvery:
          n.kind === "counter" ? n.counterEvery || undefined : undefined,
        counterCount:
          n.kind === "counter" ? n.counterCount || undefined : undefined,
        mutexInputs: n.kind === "mutex" ? n.mutexInputs || undefined : undefined,
        mutexMode: n.kind === "mutex" ? n.mutexMode || undefined : undefined,
        agent: n.kind === "proc_text" ? !!n.agent : undefined,
        globalRefs: canUseGlobalRefs(n) ? !!n.globalRefs : undefined,
        tags:
          n.kind !== "global" && normalizeNodeTags(n).length
            ? normalizeNodeTags(n).slice()
            : undefined,
        providerId:
          n.kind === "proc_text" ||
          n.kind === "proc_image" ||
          n.kind === "judge"
            ? n.providerId || undefined
            : undefined,
        provider:
          n.kind === "agent_task" || (n.kind === "proc_text" && n.agent)
            ? n.provider || undefined
            : undefined,
        model:
          n.kind === "proc_text" ||
          n.kind === "proc_image" ||
          n.kind === "agent_task" ||
          n.kind === "judge"
            ? n.model || undefined
            : undefined,
        size:
          n.kind === "proc_image"
            ? IMAGE_SIZES.includes(n.size)
              ? n.size
              : DEFAULT_IMAGE_SIZE
            : undefined,
        bgRmOn:
          n.kind === "proc_image" ? !!n.bgRmOn : undefined,
        imgQuality:
          n.kind === "proc_image" ? String(n.imgQuality || "") : undefined,
        imgBackground:
          n.kind === "proc_image" ? String(n.imgBackground || "") : undefined,
        maskOn: n.kind === "proc_image" ? !!n.maskOn : undefined,
        hasImage:
          n.kind === "input_image"
            ? !!(
                n.imageAsset ||
                (Array.isArray(n.entries) &&
                  n.entries.some((e) => e && e.path))
              )
            : undefined,
        imageName:
          n.kind === "input_image" && n.imageAsset
            ? singleImageTitle(n)
            : n.kind === "input_image" &&
                Array.isArray(n.entries) &&
                n.entries[0] &&
                n.entries[0].path
              ? entryDisplayTitle(n.entries[0])
              : undefined,
        imageTitles:
          n.kind === "input_image" && n.batch
            ? (n.entries || [])
                .filter((e) => e && e.path)
                .map((e) => entryDisplayTitle(e))
            : undefined,
        imageCount:
          n.kind === "input_image"
            ? n.batch
              ? (n.entries || []).filter((e) => e && e.path).length
              : n.imageAsset
                ? 1
                : 0
            : undefined,
        ctrlAction: n.kind === "control" ? n.ctrlAction || "run" : undefined,
        ctrlFillOnly: n.kind === "control" ? !!n.ctrlFillOnly : undefined,
        ctrlRole: n.kind === "control" ? n.ctrlRole || undefined : undefined,
        ctrlPinned: n.kind === "control" && n.ctrlPinned ? true : undefined,
        judgeResult: n.kind === "judge" ? n.judgeResult || undefined : undefined,
        parentTaskId: n.parentTaskId || undefined,
        parentSuperId: n.parentSuperId || undefined,
        /* 局部视图（scope）里嵌套更深的子块：它的直接宿主可能被 ids 等再收窄掉，
           这里补一句「谁真正围住它」，避免模型按缺省值误判层级 */
        scopeNestedIn:
          inScope &&
          sc.host &&
          n.parentSuperId &&
          !returnedNodeIds.has(n.parentSuperId)
            ? n.parentSuperId
            : undefined,
        note: n.kind === "super" ? n.note || undefined : undefined,
        expandW: n.kind === "super" ? n.expandW || undefined : undefined,
        expandH: n.kind === "super" ? n.expandH || undefined : undefined,
        subFolder: n.kind === "super" ? n.subFolder || undefined : undefined,
        superOpen: n.kind === "super" ? !!n.superOpen : undefined,
        db: n.kind === "super" ? !!n.db : undefined,
        dbMode:
          n.kind === "super" && n.db ? n.dbMode || "super" : undefined,
        dbCount:
          n.kind === "super" && n.dbIndex && n.dbIndex.records
            ? n.dbIndex.records.length
            : undefined,
        dbNodeId: n.kind === "db_replica" ? n.dbNodeId || undefined : undefined,
        dbName: n.kind === "db_replica" ? n.dbName || undefined : undefined,
        compiledAt: n.kind === "db_replica" ? n.compiledAt || undefined : undefined,
        dev: n.kind === "super" && !n.db ? !!n.dev : undefined,
        devPath:
          n.kind === "super" && n.dev ? String(n.devPath || "") || undefined : undefined,
        devStatus:
          n.kind === "super" && n.dev ? n.devStatus || "pending" : undefined,
        devKind:
          n.kind === "super" && n.dev ? devKindOf(n) || "module" : undefined,
        devColor:
          n.kind === "super" && n.dev ? devColorOf(n) || undefined : undefined,
        devModel:
          n.kind === "super" && n.dev
            ? String(n.devModel || "").trim() || undefined
            : undefined,
        devProvider:
          n.kind === "super" && n.dev
            ? String(n.devProvider || "").trim() || undefined
            : undefined,
        /* Agent 预设 / 思考强度：与本块模型同一就近继承链，空 = 跟随默认 */
        devPreset:
          n.kind === "super" && n.dev
            ? String(n.devPreset || "").trim() || undefined
            : undefined,
        devEffort:
          n.kind === "super" && n.dev
            ? String(n.devEffort || "").trim() || undefined
            : undefined,
        /* 核心文件列表（≤10 · 相对本块项目根）：与节点「文件」按钮同一口径；
           最外层（项目）开发节点恒为空数组 */
        devFiles:
          n.kind === "super" && n.dev ? devCoreFilesOf(n) : undefined,
        devFilesAuto:
          n.kind === "super" && n.dev && devCoreFilesSourceOf(n) === "auto"
            ? true
            : undefined,
        /* 工具节点（kind super + tool:true · 判定 isToolNode）：toolConfig 即定义与端子表；
           函数节点（kind function）：fnName / description / inputs / outputs（jscode 走正文口径）。
           参数即端子（输入 0 = 控制入、1..N = 各入参；输出 0..M-1 = 各出参、末位 = 控制出）。
           回读与 canvas_edit 参数补丁、设置面板、存档加载共用同一归一真源：入参如实带 list
           （列表端子 = 可被多条数据线重复连入、JS 侧取到数组），出参恒单值（list 归一时已清掉）。 */
        tool: isToolNode(n) ? true : undefined,
        toolConfig: isToolNode(n)
          ? (() => {
              ensureFnToolNodeState(n);
              const c = n.toolConfig || {};
              return {
                name: String(c.name || ""),
                description: String(c.description || ""),
                inputs: fnToolParamList(n, "in").map((p) => ({
                  name: p.name,
                  kind: p.kind,
                  list: p.list === true,
                })),
                outputs: fnToolParamList(n, "out").map((p) => ({
                  name: p.name,
                  kind: p.kind,
                })),
              };
            })()
          : undefined,
        fnName: isFunctionNode(n)
          ? String(n.fnName || "") || undefined
          : undefined,
        description: isFunctionNode(n)
          ? String(n.description || "") || undefined
          : undefined,
        inputs: isFunctionNode(n)
          ? fnToolParamList(n, "in").map((p) => ({
              name: p.name,
              kind: p.kind,
              list: p.list === true,
            }))
          : undefined,
        outputs: isFunctionNode(n)
          ? fnToolParamList(n, "out").map((p) => ({ name: p.name, kind: p.kind }))
          : undefined,
        /* 「参数」端子（renderer/app-node-params.js）：paramKeys = 本节点**可被参数覆写**的键
           （standard / full 档才回，minimal 省 token）。参数只能从端子（toIndex 9001）传入 ——
           canvas_edit 的 params 字段已取消，节点上不存在「自带参数」这回事。
           参数端子的端子号是哨兵值 PARAM_IN_INDEX（不进 0..N-1 的顺序端口）。 */
        paramKeys: snapshotParamKeysOf(H, n, o.detail),
        paramStrict: n._npStrict ? true : undefined,
        execPath:
          n.kind === "execute" ? String(n.execPath || "") || undefined : undefined,      execIcon:
          n.kind === "execute" ? execIconKeyOf(n) || undefined : undefined,
        execColor:
          n.kind === "execute" ? execColorOf(n) || undefined : undefined,
        fileCount: n.kind === "input_file" ? (n.files || []).length : undefined,
        dbFiles: n.kind === "input_file" ? (n.files || undefined) : undefined,
        tableDef: n.kind === "db_table" ? n.tableDef || undefined : undefined,
        rows: n.kind === "db_table" ? n.rows || undefined : undefined,
        schemaFile: n.kind === "db_table" ? n.schemaFile || undefined : undefined,
        dataFile: n.kind === "db_table" ? n.dataFile || undefined : undefined,
        builtAt: n.kind === "db_table" ? n.builtAt || undefined : undefined,
        netChannel: isNetNode(n) ? (Number(n.netChannel) || 0) & 0xffff : undefined,
        netProto: isNetNode(n) ? (n.netProto === "udp" ? "udp" : "tcp") : undefined,
        netHost: isNetNode(n) ? String(n.netHost || "127.0.0.1") : undefined,
        netPort: isNetNode(n) ? Number(n.netPort) || 0 : undefined,
        netListening: n.kind === "net_recv" ? !!n.netListening : undefined,
        netAutoListen: n.kind === "net_recv" ? n.netAutoListen !== false : undefined,
        netCount: isNetNode(n) ? n.netCount || 0 : undefined,
        delaySec: n.kind === "delayer" ? n.delaySec || 0 : undefined,
        popupTitle: n.kind === "popup" ? String(n.popupTitle || "") : undefined,
        popupText: n.kind === "popup" ? String(n.popupText || "") : undefined,
        seqOutputs: n.kind === "sequencer" ? n.seqOutputs || 3 : undefined,
        seqGapSec: n.kind === "sequencer" ? n.seqGapSec || 0 : undefined,
        gateInputs: n.kind === "gate" ? n.gateInputs || 2 : undefined,
        splitOutputs: n.kind === "splitter" ? n.splitOutputs || 3 : undefined,
        counterEvery: n.kind === "counter" ? n.counterEvery || 2 : undefined,
        counterCount: n.kind === "counter" ? n.counterCount || 0 : undefined,
        mutexInputs: n.kind === "mutex" ? n.mutexInputs || 2 : undefined,
        mutexMode: n.kind === "mutex" ? n.mutexMode || "first" : undefined,
        /* video_gen / music_gen 配置（agent 可读可改） */
        videoMode: n.kind === "video_gen" ? n.videoMode || "fl2va" : undefined,
        /* 自建 ComfyUI 工作流：非空 = 该节点走工作流库分支（内置参数失效） */
        workflowId:
          n.kind === "video_gen" && String(n.workflowId || "").trim()
            ? String(n.workflowId).trim()
            : undefined,
        wfTitle:
          n.kind === "video_gen" && isCustomVideoGen(n)
            ? String((n.wfMeta && n.wfMeta.title) || "")
            : undefined,
        wfParams:
          n.kind === "video_gen" && isCustomVideoGen(n)
            ? (Array.isArray(n.wfParams) ? n.wfParams : []).map((p) => ({
                key: p.key,
                type: p.type,
                label: p.label,
                port: h3WfPortOf(n, p.key),
                source: p.source,
              }))
            : undefined,
        duration:
          n.kind === "video_gen" || n.kind === "remotion"
            ? Number(n.duration) || 5
            : undefined,
        outputRes:
          n.kind === "video_gen" ? n.outputRes || "auto" : undefined,
        steps: n.kind === "video_gen" ? Number(n.steps) || 20 : undefined,
        ratio: n.kind === "video_gen" ? n.ratio || "16:9" : undefined,
        postEnabled:
          n.kind === "video_gen" ? n.postEnabled !== false : undefined,
        postInterp:
          n.kind === "video_gen" ? n.postInterp !== false : undefined,
        attempts:
          n.kind === "video_gen" ||
          n.kind === "music_gen" ||
          n.kind === "yue_gen" ||
          n.kind === "breeze_gen" ||
          n.kind === "remotion"
            ? Math.max(1, Math.min(10, Math.round(Number(n.attempts) || 1)))
            : undefined,
        outputPath:
          n.kind === "video_gen" ||
          n.kind === "music_gen" ||
          n.kind === "yue_gen" ||
          n.kind === "breeze_gen" ||
          n.kind === "remotion"
            ? mediaGenOutputRaw(n) || n.outputPath || undefined
            : undefined,
        /* yue_gen 配置（agent 可读可改） */
        cot: n.kind === "yue_gen" ? yueGenCotOf(n) : undefined,
        style:
          n.kind === "yue_gen" ? String(n.style || "").slice(0, 2000) : undefined,
        lyrics:
          n.kind === "yue_gen"
            ? String(n.lyrics || "").slice(0, 6000)
            : undefined,
        abc: n.kind === "yue_gen" ? String(n.abc || "").slice(0, 6000) : undefined,
        yueStatus:
          n.kind === "yue_gen"
            ? String(n.yueStatus || "").slice(0, 200) || undefined
            : undefined,
        /* breeze_gen 配置（agent 可读可改）：参考源优先级 = 端子优先，端子空了才用 voice */
        breezeVoice: n.kind === "breeze_gen" ? String(n.voice || "") : undefined,
        breezeMode: n.kind === "breeze_gen" ? breezeModeOf(n) : undefined,
        breezeInstruction: n.kind === "breeze_gen" ? String(n.instruction || "") : undefined,
        breezeCfgScale: n.kind === "breeze_gen" ? breezeCfgScaleOf(n) : undefined,
        breezeSeed: n.kind === "breeze_gen" ? breezeSeedOf(n) : undefined,
        breezeFormat: n.kind === "breeze_gen" ? breezeFormatOf(n) : undefined,
        breezeStatus:
          n.kind === "breeze_gen"
            ? String(n.breezeStatus || "").slice(0, 240) || undefined
            : undefined,
        breezeRefSource:
          n.kind === "breeze_gen"
            ? String(n.refSource || "").slice(0, 120) || undefined
            : undefined,
        breezeOutput:
          n.kind === "breeze_gen" && n.output && n.output.path
            ? {
                kind: "audio",
                path: String(n.output.path),
              }
            : undefined,
        /* remotion 配置（agent 可读可改） */
        remotionSize:
          n.kind === "remotion" ? n.size || "1280x720" : undefined,
        fps:
          n.kind === "remotion" ? Math.max(1, Math.min(60, Number(n.fps) || 30)) : undefined,
        seed: n.kind === "remotion" ? Math.floor(Number(n.seed) || 0) : undefined,
        remotionText:
          n.kind === "remotion" ? String(n.text || "").slice(0, 500) : undefined,
        /* 构建描述（点「构建」时弹窗里填的那段需求）：构建 Agent 唯一的输入。
           与 remotionText（节点功能说明，只给人看）是两个字段，别混。 */
        remotionBuildNote:
          n.kind === "remotion"
            ? String(n.remotionBuildNote || "").slice(0, 2000)
            : undefined,
        remotionTsxLen: n.kind === "remotion" ? (n.tsx || "").length : undefined,
        /* 工程源码树与端子契约（agent 可读可写：canvas_edit 的 remotionFiles / remotionInputs）。
           契约不大，standard 档就给全（它就是当前生效的端子表）；源码树按正文档位
           （detail:"full" / bodies:true）才回，standard 档只回文件名清单，免得一次读图把
           整棵工程灌进上下文。源码只认节点上的 remotionFiles（老节点的 tsxTsx 单文件见 remotionTsxLen）。 */
        remotionFileNames:
          n.kind === "remotion" ? Object.keys(n.remotionFiles || {}) : undefined,
        remotionFiles:
          n.kind === "remotion" && o.wantBodies
            ? (() => {
                const files = n.remotionFiles;
                if (!files || typeof files !== "object") return undefined;
                if (!(o.bodyLimit > 0)) return files;
                const out = {};
                for (const [name, src] of Object.entries(files))
                  out[name] = String(src || "").slice(0, o.bodyLimit);
                return out;
              })()
            : undefined,
        remotionInputs:
          n.kind === "remotion" ? remotionContractOf(n) : undefined,
        remotionBuiltAt:
          n.kind === "remotion" ? Number(n.remotionBuiltAt) || undefined : undefined,
        goal: goalSnap ? goalSnap.text : undefined,
        goalLen: goalSnap ? goalSnap.textLen : undefined,
        steps:
          n.kind === "task"
            ? (n.steps || []).map((s) => (s && s.title) || "")
            : undefined,
        /* 素材节点（kind "asset"）：绑定 + 内容条目清单一起回读 —— 条目即端子，
           第 i 入 ↔ 第 i 出。缺了这一段，Agent 读到的素材节点配置是空的。 */
        assetItems: snapshotAssetNodeOf(H, n),
        taskStatus: n.kind === "task" ? n.taskStatus || "pending" : undefined,
        };
        /* 带端口表的节点（proc_image / video_gen / remotion / judge / 工具 · 函数 /
           super 边界 / 素材节点）：standard 与 full 档直接带端口表（index / name /
           kind / connectedTo），模型接线前就看得见占用情况；minimal 档不带。
           remotion 的输入是增量端子（与 proc_text 同族），端口表随 ports.rule 一起说明
           「连一条长一条、控制线与数据线共用」—— 否则模型会以为它只有一个描述口。
           素材节点的端子名 = 内容条目标题，与 assetItems.items[].title 同一份口径。 */
        if (o.detail !== "minimal" && snapshotHasFixedPorts(H, n)) {
          const ports = snapshotPortsOf(H, n);
          if (ports && ports.length) node.ports = ports;
        }
          /* 端子数**随连线增量**的节点（proc_text / proc_image / input_* …）：
           ports 只报得到「当下真实存在」的那几个槽（空白节点就只剩端口 0 = 提示词），
           实测中模型据此误判「这个节点没有图像参考端子」，去试连一条线再看 warnings 反推接法。
           这里补一条「端子怎么长」的规则 —— 它们与 ports 名单有交集，所以这一支是独立的
           portRule 字段（ports 名单里那几个的规则挂在 ports.rule 上，文案同源）。 */
        if (o.detail !== "minimal") node.portRule = snapshotDynamicPortRule(H, n);
        return pruneNodeSnap(node, o);
      }),
      marks: (wf.marks || [])
        .filter((m) => markViewHit(m))
        .filter((m) => !inScope || inScope.has(String(m.parentSuperId || "")))
        .map((m) => ({
        id: m.id,
        kind: m.kind,
        x: m.x,
        y: m.y,
        w: m.w,
        h: m.h,
        text: m.kind === "text" ? clipStr(m.text, 120) : undefined,
        color: m.color,
        fontSize: m.kind === "text" ? m.fontSize : undefined,
        stroke: m.kind === "box" || m.kind === "arrow" ? m.stroke : undefined,
        x2: m.kind === "arrow" ? m.x2 : undefined,
        y2: m.kind === "arrow" ? m.y2 : undefined,
        parentSuperId: m.parentSuperId || undefined,
      })),
      markColors: (MARK_COLORS || []).slice(),
      /* 开发节点功能色卡（Agent 按功能分类上色要用）：常量透出，真源见 app-devnode.js */
      devFuncColors: devFuncColorCatalog(DEV_FUNC_COLORS),
      wires: (wf.wires || [])
        .filter((w) => {
          const a = nodeById(w.from);
          const b = nodeById(w.to);
          if (!a || !b || !viewHit(a) || !viewHit(b)) return false;
          if (inScope && (!inScope.has(a.id) || !inScope.has(b.id))) return false;
          if (selNodeIds && (!selNodeIds.has(a.id) || !selNodeIds.has(b.id))) return false;
          return true;
        })
        .map((w) => {
        const a = nodeById(w.from);
        const b = nodeById(w.to);
        return {
          id: w.id,
          from: w.from,
          to: w.to,
          fromTitle: a ? a.title : "",
          toTitle: b ? b.title : "",
          rel: w.rel ? true : undefined,
          relLabel: w.rel ? w.relLabel || "" : undefined,
          relArrow: w.rel ? relArrowOf(w) : undefined,
        };
      }),
      groups: (wf.groups || [])
        .filter(
          (g) =>
            !inScope ||
            (g.nodeIds || []).length === 0 ||
            (g.nodeIds || []).every((id) => inScope.has(id)),
        )
        .map((g) => ({
        id: g.id,
        title: g.title,
        nodeIds: (g.nodeIds || []).slice(),
        markIds: (g.markIds || []).slice(),
      })),
      /* 局部画布（scope）：恒保留 —— 模型永远知道自己看到的是整图还是某一颗壳内部，
         以及怎么切回整图（scope:"global"）或换一颗壳（scope:"标题"）。 */
      scopeInfo: scopeInfoBlock(H, sc, allNodes),
    };
    const out = o.detail === "minimal" ? pruneMinimalSnapshot(snap, opts) : snap;
    /* 静态参考表按需闸：裁剪之后才补（否则会被 MINIMAL_SNAPSHOT_DROP 又摘掉）。 */
    if (snapshotWantsStaticRefs(opts)) attachSnapshotStaticRefs(H, out);
    return out;
  }

  /* ── 结构内容哈希 ────────────────────────────────────────────────────────────── */
  /* 结构内容哈希（FNV-1a）：**对画布真源（wf）算，不对过滤后的快照算**。
     为什么必须与快照解耦：这个哈希是写操作的乐观并发闸（MCP 的 baseHash 与自家 Agent
     同一口径）。快照是「按 detail / sections / ids / scope 裁出来的视图」——
     detail:"minimal" 的节点只剩 标题/描述/类别，而 detail:"standard" 带全部配置字段与
     位置连线，同一张没动过的画布会算出两个不同的哈希。客户端按服务端说明「把读回的
     contentHash 原样回传」时就会被判成「画布已被改动」而拒写（实测：minimal 读 → standard
     读，哈希即变，写必被拒）。所以哈希只覆盖真源里会随编辑变化的结构与设置：
     nodes（结构字段 + 正文长度；正文本身不参与——按「显式存盘才改文件」的既有口径）、
     wires / groups / marks / 画布名。刻意剔除 cam / view / selection / 运行态等易变项。 */
  function snapshotContentHashOf(H, snapOrWf) {
    try {
      const src = snapshotHashSource(H, snapOrWf);
      let h = 0x811c9dc5;
      for (let i = 0; i < src.length; i++) {
        h ^= src.charCodeAt(i);
        h = (h * 0x01000193) >>> 0;
      }
      return "fnv1a-" + h.toString(16).padStart(8, "0") + "-" + src.length.toString(16);
    } catch {
      return "";
    }
  }

  /* 标量归一：函数 / undefined / Symbol 一律转成稳定的空串，避免序列化差异。 */
  function hashScalar(v) {
    if (v == null) return "";
    const t = typeof v;
    if (t === "function" || t === "symbol") return "";
    if (t === "number") return Number.isFinite(v) ? v : "";
    if (t === "boolean") return v;
    return String(v);
  }

  /* 画布真源的规范化文本：键按字典序排（对象字面量顺序无关），
     节点正文只取长度（textLen / promptLen / taskLen / goalLen / jscodeLen）。 */
  function snapshotHashSource(H, snapOrWf) {
    const S = H.state;
    const wf = snapOrWf && (snapOrWf.nodes || snapOrWf.wires) ? snapOrWf : S.wf || {};
    const nodePart = (wf.nodes || [])
      .map((n) => {
        if (!n || typeof n !== "object") return "";
        const keys = Object.keys(n)
          .filter((k) => k.charAt(0) !== "_")
          .filter((k) => NODE_BODY_KEYS.indexOf(k) < 0)
          .sort();
        const body =
          NODE_BODY_KEYS.map((k) => k + "Len:" + hashScalar(String(n[k] == null ? "" : n[k]).length)).join(",");
        return (
          "{" +
          keys
            .map((k) => {
              const v = n[k];
              if (Array.isArray(v)) return k + ":[" + v.map((x) => hashScalar(x && typeof x === "object" ? JSON.stringify(x) : x)).join("|") + "]";
              if (v && typeof v === "object") return k + ":" + JSON.stringify(v);
              return k + ":" + hashScalar(v);
            })
            .join(",") +
          "}|" +
          body
        );
      })
      .join("\n");
    const wirePart = (wf.wires || [])
      .map((w) => hashScalar(w && w.from) + ">" + hashScalar(w && w.to) + "#" + hashScalar(w && w.fromIndex) + (w && w.rel ? "~rel" : ""))
      .join(",");
    const groupPart = (wf.groups || [])
      .map((g) => JSON.stringify(g && g.nodes ? { id: g.id, title: g.title, nodes: g.nodes } : g))
      .join(",");
    const markPart = (wf.marks || [])
      .map((m) => JSON.stringify(m))
      .join(",");
    return (
      "name:" + hashScalar(wf.name) + "\n" + nodePart + "\n" + wirePart + "\n" + groupPart + "\n" + markPart
    );
  }

  return {
    /* 静态表 */
    IMAGE_SIZES,
    DEFAULT_IMAGE_SIZE,
    kindsOf,
    /* 档位常量 */
    NODE_MINIMAL_KEYS,
    NODE_BODY_KEYS,
    SNAPSHOT_HEAVY_SECTIONS,
    MINIMAL_SNAPSHOT_SECTIONS,
    MINIMAL_SNAPSHOT_DROP,
    SNAPSHOT_PORT_KINDS,
    INCREMENTAL_PORT_KINDS,
    /* 文本 / 档位 */
    clipStr,
    snapTextField,
    normalizeSnapshotOpts,
    nodeInFilter,
    pruneNodeSnap,
    applySnapshotSectionFilter,
    pruneMinimalSnapshot,
    snapshotWantsSection,
    snapshotWantsStaticRefs,
    attachSnapshotStaticRefs,
    /* scope */
    resolveScopeHost,
    superAncestorIdsOf,
    superSubtreeIds,
    nodeInSuperScope,
    pointInScopeHost,
    scopedNodeIdSet,
    nodeInSnapshotScope,
    snapshotScopeOf,
    scopeInfoBlock,
    /* 端子 / 素材 / 色卡 */
    nodePortList,
    snapshotHasFixedPorts,
    snapshotInputGrowsWithWires,
    snapshotPortsOf,
    snapshotRemotionPortRule,
    snapshotPortRuleOf,
    snapshotDynamicPortRule,
    snapshotParamKeysOf,
    snapshotAssetNodeOf,
    devFuncColorCatalog,
    /* 快照 / 哈希 */
    canvasSnapshot,
    snapshotContentHashOf,
    snapshotHashSource,
    hashScalar,
  };
});
