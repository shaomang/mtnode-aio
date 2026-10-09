"use strict";
/* MiniMax H3 · R2V 参考素材「端口上有线却取不到值」不再静默丢图 —— 渲染层回归
 *   node test/smoke-h3-ref-assets.js
 *
 * 真出过的问题：H3 节点用 R2V 模式、参考图（素材节点）+ 参考音频一起接上跑出来，
 * 参考图**完全不起作用**。查提交给 ComfyUI 的原始图：ref_audio_0 在、**一张 ref_image_* 都没有**，
 * 全图没有 LoadImage —— 参考图根本没进请求，模型从没见过它。
 *
 * 根因（本脚本 [2]/[3] 用真函数钉住）：
 *   videoGenSlotValue → valueForInput(kind "asset") → assetItemValueOf
 *   → assetItemAbsPath → 素材库扫描摘要（assetSummaryById）
 *   摘要是「扫过一次」才有的；没就位时返回 ""，assetItemValueOf 于是回 null，
 *   而 videoGenSlotValue 把「还没读到」与「这个槽是空的」返回同一个 null，
 *   R2V 收集循环 `if (v && v.path)` 静默跳过 —— 参考图悄悄丢了，全程无一处报警。
 *   参考音频那条路取自上游节点自己的 node.output（无异步依赖）→ 音频进得去、图进不去，
 *   用户看到的就是「一加参考音频，参考图完全失效」。
 *
 * 覆盖：
 *   [1] 摘要还没就位时，扫描摘要的同步投影仍能给出条目绝对路径（ASSET_ABS_INDEX）
 *   [2] 跑前预检 videoGenRefSlotsPreflight：占线槽取不到值 → 点名报出来（I1/I2 标签）
 *   [3] 预检不误报：端口空着 / 值取得到，都回空清单
 *   [4] 警告文案：槽号标签 + 参考图/视频/音频名 + 「不会带上」的口径
 *   [5] 兜底补读：摘要与缓存都空时同步取值仍回 ""，但必须把读取发出去（fire-and-forget）
 *   [6] 接线：playVideoGenNode 跑前调预检、警告进状态行且**不拦截运行**
 *
 * 替身只替与判定无关的部分：DOM / IPC / i18n / 连线控制判据；取值链与预检全是源码真函数。
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
function section(t) {
  console.log("\n── " + t + " ──");
}
const read = (rel) =>
  fs.readFileSync(path.join(__dirname, "..", rel.split("/").join(path.sep)), "utf8");
const show = (v) => JSON.stringify(v);
const has = (src, needle, msg) =>
  ok(
    String(src).indexOf(needle) >= 0,
    msg + (String(src).indexOf(needle) >= 0 ? "" : "（缺 " + show(needle) + "）"),
  );

const appSrc = read("renderer/app.js");
const assetsSrc = read("renderer/app-assets.js");
const nodesSrc = read("renderer/app-nodes.js");

/* ---------- 从源码按名字抠出顶层函数 ---------- */
function fnBody(src, name) {
  const pats = [
    new RegExp("\\n(?:async\\s+)?function " + name + "\\s*\\(", "m"),
    new RegExp("\\nconst " + name + "\\s*=", "m"),
  ];
  let at = -1;
  for (const p of pats) {
    const m = src.match(p);
    if (m) {
      at = m.index + 1;
      break;
    }
  }
  if (at < 0) throw new Error("找不到函数 / 常量：" + name);
  if (/^(async\s+)?function/.test(src.slice(at, at + 14))) {
    const i = src.indexOf("{", at);
    let depth = 0;
    let inStr = null;
    for (let j = i; j < src.length; j++) {
      const c = src[j];
      const p = src[j - 1];
      if (inStr) {
        if (c === inStr && p !== "\\") inStr = null;
        continue;
      }
      if (c === "/" && src[j + 1] === "/") {
        j = src.indexOf("\n", j) - 1;
        continue;
      }
      if (c === "/" && src[j + 1] === "*") {
        j = src.indexOf("*/", j) + 1;
        continue;
      }
      if (c === '"' || c === "'" || c === "`") {
        inStr = c;
        continue;
      }
      if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (!depth) return src.slice(at, j + 1);
      }
    }
    throw new Error("函数体不完整：" + name);
  }
  const lineEnd = src.indexOf("\n", at);
  return src.slice(at, lineEnd) + ";";
}
const extract = (src, names) => names.map((n) => fnBody(src, n)).join("\n");

const AID = "asmu3h09rhj4ybe9";
const IID = "itmu3h2538eq2qx8";
const ABS = "E:\\mtnode-plugins\\assets\\DS Adventure\\Characters\\AI娘原人设三视图\\items\\itmu3h2538eq2qx8.png";
const H3_ID = "n3h3node";
const ASSET_ID = "nasset";

/* ---------- 沙箱：真函数 + 最小替身 ---------- */
function makeSandbox(opts) {
  const o = opts || {};
  const S = {
    wf: {
      nodes: [
        {
          id: H3_ID,
          kind: "video_gen",
          title: "Minimax H3 节点",
          videoMode: "r2v",
          videoPortV2: true,
          videoPortV3: true,
          videoPortV4: true,
        },
        {
          id: ASSET_ID,
          kind: "asset",
          title: "AI娘原人设三视图",
          assetId: AID,
          assetRel: "DS Adventure/Characters/AI娘原人设三视图",
          items: [{ id: IID, title: "Deepseek_threeview", type: "image" }],
        },
      ],
      wires: o.wires || [
        {
          id: "w1",
          from: ASSET_ID,
          to: H3_ID,
          fromIndex: 0,
          toIndex: 2,
        },
      ],
    },
  };
  const ASSET_ITEM_VIEW = new Map();
  const ASSET_ABS_INDEX = new Map();
  const ASSET_LIB = { scanned: false, scan: { assets: [] } };
  const ASSET_ITEM_BUSY = new Set();
  const ASSET_ITEM_LOAD = new Map();
  const reads = [];
  const toasts = [];
  const renders = { n: 0 };
  /* readResult 可在拿到沙箱后改：测「先读失败、文件补回来后重跑能不能自愈」 */
  const ctl = { readResult: o.readResult || "ok" };
  const api = {
    assetsItemRead: (aid, iid) => {
      reads.push(aid + "|" + iid);
      if (o.debug)
        console.log(
          "        [read#" + reads.length + "] cache=",
          show(ASSET_ITEM_VIEW.get(aid + "|" + iid)),
          "busy=",
          show([...ASSET_ITEM_BUSY]),
          "load=",
          show([...ASSET_ITEM_LOAD.keys()]),
        );
      return Promise.resolve(
        ctl.readResult === "fail"
          ? { ok: false, error: "内容文件缺失" }
          : { ok: true, type: "image", absPath: ABS, bytes: 1234 },
      );
    },
  };
  const I18n = {
    t: (s) => s,
  };
  const sandbox = {
    S,
    ASSET_ITEM_VIEW,
    ASSET_ABS_INDEX,
    ASSET_LIB,
    ASSET_ITEM_BUSY,
    ASSET_ITEM_LOAD,
    ASSET_ITEM_TYPES: { text: 1, image: 1, audio: 1, video: 1 },
    window: { api },
    I18n,
    document: { getElementById: () => null, querySelector: () => null },
    console,
    setTimeout,
    clearTimeout,
    Promise,
    Math,
    Number,
    String,
    Object,
    Array,
    JSON,
    RegExp,
    isFinite,
    /* 替身：与判定无关的外部依赖 */
    isControlKind: () => false,
    isSuperLikeNode: (n) => !!n && n.kind === "super",
    isItemPortSource: (n) => !!n && n.kind === "asset",
    wireFromIsControl: () => false,
    isVideoPostKind: (n) => !!n && (n.kind === "video_upscale" || n.kind === "video_interp"),
    assetNodeIsLost: (n) => {
      const id = String((n && n.assetId) || "").trim();
      if (!id || !ASSET_LIB.scanned) return false;
      const list = (ASSET_LIB.scan && ASSET_LIB.scan.assets) || [];
      return !list.some((a) => a && String(a.id) === id);
    },
    assetItemViewInvalidate: (aid, iid) => {
      if (o.debug)
        console.log(
          "        [invalidate] 前 cache=",
          show(ASSET_ITEM_VIEW.get(aid + "|" + iid)),
          "busy=",
          show([...ASSET_ITEM_BUSY]),
        );
      ASSET_ITEM_VIEW.delete(aid + "|" + iid);
      ASSET_ITEM_BUSY.delete(aid + "|" + iid);
    },
    assetItemViewLoad: (aid, iid) => {
      const k = aid + "|" + iid;
      if (ASSET_ITEM_LOAD.has(k)) return ASSET_ITEM_LOAD.get(k);
      if (ASSET_ITEM_BUSY.has(k)) return Promise.resolve();
      const cur = ASSET_ITEM_VIEW.get(k);
      if (cur && !cur.missing && !cur.loading) return Promise.resolve();
      ASSET_ITEM_BUSY.add(k);
      /* 与 app-assets.js 同一份缓存口径（只做 Map 操作，不调 eval 域里的函数） */
      ASSET_ITEM_VIEW.set(k, Object.assign({}, ASSET_ITEM_VIEW.get(k) || {}, { loading: true }));
      const p = api
        .assetsItemRead(aid, iid)
        .then((r) => {
          const next =
            !r || !r.ok
              ? { loading: false, missing: true, error: (r && r.error) || "读取失败" }
              : {
                  loading: false,
                  missing: false,
                  absPath: r.absPath || "",
                  bytes: Number(r.bytes) || 0,
                  type: r.type || "",
                };
          ASSET_ITEM_VIEW.set(k, Object.assign({}, ASSET_ITEM_VIEW.get(k) || {}, next));
        })
        .catch((e) => {
          ASSET_ITEM_VIEW.set(
            k,
            Object.assign({}, ASSET_ITEM_VIEW.get(k) || {}, {
              loading: false,
              missing: true,
              error: String((e && e.message) || e),
            }),
          );
        })
        .finally(() => {
          ASSET_ITEM_BUSY.delete(k);
          ASSET_ITEM_LOAD.delete(k);
        });
      ASSET_ITEM_LOAD.set(k, p);
      return p;
    },
    assetItemViewLoaded: (aid, iid) => {
      if (!aid || !iid) return Promise.resolve();
      /* 与 app-assets.js 同口径：在飞的那次也要等到（LOAD 表里只留正在飞的） */
      if (ASSET_ITEM_LOAD.has(aid + "|" + iid)) return ASSET_ITEM_LOAD.get(aid + "|" + iid);
      return assetItemViewLoad(aid, iid);
    },
    /* 取不到值的素材源节点自身没有可展示的图像 → null（与「没读到内容」同一条路径） */
    displayValueOf: () => null,
    toast: (m) => toasts.push(String(m)),
    renderCanvas: () => {
      renders.n++;
    },
    allWiresTo: (id) =>
      S.wf.wires
        .filter((w) => w.to === id && !w.rel)
        .sort((a, b) => a.toIndex - b.toIndex),
  };

  const code = [
    /* 素材侧（app-assets.js） */
    extract(assetsSrc, [
      "assetSummaryById",
      "assetViewKey",
      "assetItemViewGet",
      "assetItemViewSet",
      "assetLibAbsPathIndex",
      "assetLibAbsPathOf",
    ]),
    /* 取值链（app.js） */
    extract(appSrc, [
      "mediaFileUrlOf",
      "isAssetNode",
      "assetItems",
      "assetItemSummary",
      "assetItemAbsPath",
      "assetItemValueOf",
      "valueForInput",
      "valueFromWire",
      "nodeById",
      "wiresTo",
      "videoGenMode",
      "videoGenMaxImages",
      "videoGenMaxVideos",
      "videoGenMaxAudios",
      "videoGenPortOfSlot",
      "videoGenSlotMeta",
      "isCustomVideoGen",
      "videoGenWfFileParams",
      "videoGenWfTextParam",
      "videoGenDataSlotsTotal",
      "videoGenMaxChains",
      "videoGenChainSlotIndex",
      "videoGenProgressiveCount",
      "videoGenSlotOccupied",
    ]),
    /* 预检 + 文案 + 槽取值（app-nodes.js） */
    extract(nodesSrc, ["videoGenSlotValue", "videoGenRefSlotsPreflight", "videoGenRefSlotsWarning"]),
    "return { wireValue: valueFromWire, videoGenSlotValue, videoGenRefSlotsPreflight, videoGenRefSlotsWarning, assetItemAbsPath, assetItemValueOf, assetLibAbsPathIndex, assetLibAbsPathOf, setAbsIndex: (scan) => { ASSET_LIB.scanned = true; ASSET_LIB.scan = scan; return assetLibAbsPathIndex(scan); } };",
  ].join("\n");

  const names = Object.keys(sandbox);
  const F = new Function(...names, code)(...names.map((n) => sandbox[n]));
  return { F, sandbox, reads, toasts, renders, api, ctl };
}

/* 冒烟主体：包一层 async（脚本仍是 CJS —— 顶层 await 会被 Node 24 判成 ESM） */
async function main() {
/* ═══════════ [1] 摘要没就位时，同步投影仍能给出路径 ═══════════ */
section("[1] 素材库摘要没就位（未扫过）时，条目路径仍取得到（ASSET_ABS_INDEX 投影）");
{
  const { F } = makeSandbox();
  const node = { kind: "asset", assetId: AID, items: [{ id: IID, type: "image" }] };
  const it = { id: IID, type: "image" };
  ok(F.assetItemAbsPath(node, it) === "", "未扫过且无缓存：同步取值回空（原来就卡在这里）");
  const sum = {
    assets: [
      {
        id: AID,
        rel: "DS Adventure/Characters/AI娘原人设三视图",
        items: [{ id: IID, absPath: ABS, bytes: 1234, missing: false }],
      },
    ],
  };
  const n = F.setAbsIndex(sum);
  ok(n === 1, "扫描摘要一次投影进索引（" + n + " 条）");
  ok(F.assetLibAbsPathOf(AID, IID) === ABS, "投影里按 assetId|itemId 取到绝对路径");
  ok(F.assetItemAbsPath(node, it) === ABS, "assetItemAbsPath 落到投影上（不再依赖当期摘要在手上）");
  const v = F.assetItemValueOf(node, 0);
  ok(!!v && v.path === ABS && v.kind === "image", "素材端子取值不再回 null（kind=image + 真路径）");
}

/* ═══════════ [2] 跑前预检：占线槽取不到值要点名报出 ═══════════ */
section("[2] videoGenRefSlotsPreflight：盘点「端口上有线却取不到值」的参考槽");
{
  /* 场景 A：素材还没读过 → 预检先把它读齐（补读成功 → 值到手，不报缺） */
  const A = makeSandbox({ readResult: "ok" });
  const h3 = {
    id: H3_ID,
    kind: "video_gen",
    videoMode: "r2v",
    videoPortV2: true,
    videoPortV3: true,
    videoPortV4: true,
  };
  const missA = await A.F.videoGenRefSlotsPreflight(h3);
  ok(A.reads.length === 1, "预检为占线槽补读了一次素材条目（IPC：" + show(A.reads) + "）");
  ok(missA.length === 0, "补读成功 → 预检不报缺（值已经取到，不再静默丢掉）");
  ok(
    A.F.videoGenSlotValue(h3, 2).path === ABS,
    "预检之后同一个取值入口真拿到参考图路径（I1 → refImages 会带上它）",
  );
  /* 场景 B：读取失败（库里文件缺失）→ 必须点名 */
  const B = makeSandbox({ readResult: "fail", debug: true });
  const missB = await B.F.videoGenRefSlotsPreflight(h3);
  ok(missB.length === 1, "读失败时预检点名 " + missB.length + " 个槽");
  ok(!!missB[0] && missB[0].label === "I1", "点名到具体端子：I1（第 1 路参考图）");
  ok(!!missB[0] && missB[0].slot === 2, "报出的是数据槽号（槽 2 = I1）");

  /* 场景 C：失败缓存不许永久钉死 —— 文件补回来后，下一次预检要能自愈 */
  const before = B.reads.length;
  B.ctl.readResult = "ok";
  const missC1 = await B.F.videoGenRefSlotsPreflight(h3);
  /* 预检只保证「读取已发出并等到响应」；缓存落进 Map（app-assets 的 .finally 收尾）是紧随其后的一拍，
     真跑时预检与取值之间隔着整个生成过程，这里等一拍把同一时序补上。 */
  await new Promise((r) => setTimeout(r, 10));
  ok(B.reads.length === before + 1, "过期失败缓存被强制重读一次（" + (B.reads.length - before) + " 次）");
  ok(missC1.length === 0, "文件补回来后不再报缺（自愈，不必重启会话）");
}

/* ═══════════ [3] 预检不误报 ═══════════ */
section("[3] 预检不误报：端口空着 / 值取得到都回空清单");
{
  /* 端口空着：没线 → 不算「取不到值」 */
  const A = makeSandbox({ wires: [] });
  const h3 = { id: H3_ID, kind: "video_gen", videoMode: "r2v", videoPortV2: true };
  const missA = await A.F.videoGenRefSlotsPreflight(h3);
  ok(missA.length === 0, "端口上没连线 → 不报警（空槽是正常状态）");
  /* 值取得到：投影在 → 不报警，也不打 IPC */
  const B = makeSandbox();
  B.F.setAbsIndex({
    assets: [{ id: AID, items: [{ id: IID, absPath: ABS, missing: false }] }],
  });
  const missB = await B.F.videoGenRefSlotsPreflight(h3);
  ok(missB.length === 0, "有值 → 不报警");
  ok(B.reads.length === 0, "有值时不打多余的 IPC（" + B.reads.length + " 次）");
}

/* ═══════════ [4] 警告文案 ═══════════ */
section("[4] 警告文案：点名到端子 + 素材类型 + 「不会带上」");
{
  const { F } = makeSandbox();
  const msg = F.videoGenRefSlotsWarning([
    { slot: 2, kind: "image", label: "I1" },
    { slot: 12, kind: "audio", label: "A1" },
  ]);
  has(msg, "参考素材取不到内容", "文案点明「参考素材取不到内容」");
  has(msg, "不会带上", "文案说明本次请求不会带上它们");
  has(msg, "I1", "点名 I1");
  has(msg, "参考图", "带上素材类型：参考图");
  has(msg, "A1", "点名 A1");
  has(msg, "参考音频", "带上素材类型：参考音频");
  has(msg, "素材库未就绪", "给出可能原因（素材库未就绪）");
  ok(F.videoGenRefSlotsWarning([]) === "", "没有缺项 → 空串（状态行不会被污染）");
}

/* ═══════════ [5] 兜底补读（fire-and-forget） ═══════════ */
section("[5] 摘要与缓存都空时：同步回空，但必须把读取发出去");
{
  const { F, reads } = makeSandbox();
  const node = { kind: "asset", assetId: AID, items: [{ id: IID, type: "image" }] };
  const p = F.assetItemAbsPath(node, { id: IID, type: "image" });
  ok(p === "", "同步取值仍回空（不阻塞渲染）");
  ok(reads.length === 1, "补读已发出（1 次）；到货后落在缓存里，下次取值直接命中");
  await new Promise((r) => setTimeout(r, 10));
  ok(
    F.assetItemAbsPath(node, { id: IID, type: "image" }) === ABS,
    "读取到货后同一取值路径拿到真路径（自愈，不必重启会话）",
  );
  ok(reads.length === 1, "第二次取值不重复打 IPC");
}

/* ═══════════ [6] 接线：playVideoGenNode 真调预检 ═══════════ */
section("[6] 接线：生成前跑预检、警告进状态行、不拦截运行");
{
  const play = nodesSrc
    .split("async function playVideoGenNode(node, quiet)")[1]
    .split("async function ")[0];
  has(play, "await videoGenRefSlotsPreflight(node)", "playVideoGenNode 在收参考素材前 await 预检（过期的失败缓存由预检自己重读）");
  const pre = play.indexOf("videoGenRefSlotsPreflight(node)");
  const collect = play.indexOf("const refImages = []");
  ok(pre >= 0 && collect > pre, "预检排在 refImages 收集之前（先读齐再取值）");
  has(play, "videoGenRefSlotsWarning(refMissing)", "预检结论走统一文案函数");
  has(play, "if (!quiet) toast(refWarn", "缺参考素材时弹提示");
  has(play, "node.videoStatus =", "缺参考素材写进节点状态行");
  ok(
    play.indexOf("return;") === -1 || play.indexOf("videoGenRefSlotsWarning") < play.indexOf("const refImages = []"),
    "预检之后**不 return**：按约定「明确报错但继续运行」",
  );
  const fn = nodesSrc
    .split("async function videoGenRefSlotsPreflight(node)")[1]
    .split("function videoGenRefSlotsWarning")[0];
  has(fn, "videoGenSlotValue(node, slot)", "预检用与收集循环同一个取值入口（同一份判据）");
  has(fn, "allWiresTo(node.id)", "预检按真实连线判「端口是不是占着线」");
  has(fn, "await assetItemViewLoaded(aid, iid)", "预检等素材条目内容就位（不自造另一套读取）");
  has(fn, "assetItemViewInvalidate(aid, iid)", "过期失败缓存顶掉重读（不再永久钉死）");
  has(fn, "stillLoading(slot)", "复判带「还在飞就先等」的收尾（避开到货差一拍）");
  const collectSrc = nodesSrc.split("if (mode === \"r2v\") {")[1].split("const chainVideoPath")[0];
  has(collectSrc, "if (v && v.path) refImages.push(v.path);", "收集循环本身口径未动（只补了跑前预检）");
}

}

main()
  .catch((e) => {
    fails++;
    console.log("FAIL  冒烟自身抛错：" + String((e && e.stack) || e));
  })
  .then(() => {
    console.log(
      "\n" + (fails ? "FAILED " + fails + " / " + checks + " checks" : "ALL OK  " + checks + " checks"),
    );
    process.exit(fails ? 1 : 0);
  });
