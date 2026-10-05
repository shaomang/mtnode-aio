"use strict";
/* 冒烟：函数节点出图 —— mtnode.image(...)（本轮需求 C）+ appHost.imageEdit 的接线面
 *   node test/smoke-fn-image.js
 *
 * 背景（本文件钉住的契约）：
 *   函数节点跑在主进程的独立 worker 线程里，既没有 window.api，也拿不到任何图像后端。
 *   本次给它加一条出图桥：jscode 里 await mtnode.image(prompt, opts) 经桥回主进程，
 *   由 **apps-store 的 hostImageGenerate**（与应用通道 appHost.imageGen 同一个内核）出图，
 *   产物落**本次运行所属画布的资产目录**（<数据目录>/assets/<wfId>），回本机绝对路径。
 *   节点自己选定的图像后端（节点头部「图像后端」按钮 → node.imgModel）随 fn:run 下发。
 *
 * 覆盖：
 *   [1] 真 worker 跑 jscode：prompt / images / strength / model / nodeId / wfId 逐字到宿主，
 *       回执透传 · imgConfig 只读摘要 · 调用级覆盖 · 未选后端（跟随 auto）· 空 prompt 本地拦
 *   [2] 主进程接线：fnRuntime.imageCall 注入 · fnImageCall 复用 hostImageGenerate 并落画布资产目录
 *   [3] 渲染层 / 桥接线：头部按钮（函数有、工具无）· functionImageSpec 两条运行路径 · js-exec 透传 ·
 *       preload 的 imageBackends · appHost.imageEdit · apps-store 的参考图整组下发
 *   [4] i18n：新词条都有英文译文（缺一条界面就会露出中文原文）
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const read = (rel) =>
  fs.readFileSync(path.join(ROOT, rel.split("/").join(path.sep)), "utf8").replace(/\r\n?/g, "\n");

let checks = 0;
let fails = 0;
function ok(cond, msg) {
  checks++;
  if (cond) console.log("  ok    " + msg);
  else {
    fails++;
    console.log("FAIL  " + msg);
  }
}

const PROC_HOST = require("../main-proc-host.js");
const FNR = require("../fn-runtime.js");

/* 画布相关全局变量（app-nodes.js 的 S.wf.id 口径）—— 源码断言之外不真跑渲染层 */
const MAIN = read("main.js");
const STORE_SRC = read("apps-store.js");
const FNR_SRC = read("fn-runtime.js");
const PRE = read("preload.js");
const PRE_APP = read("preload-app.js");
const JSEXEC = read("renderer/js-exec.js");
const NODES = read("renderer/app-nodes.js");
const CANVAS = read("renderer/app-canvas.js");
const AICALL = read("renderer/app-aicall.js");
const I18N = read("renderer/i18n.js");

async function main() {
  /* ═══════════ [1] 真 worker：mtnode.image 经桥到主进程宿主 ═══════════ */
  console.log("\n[1] 真 worker：await mtnode.image(...) 经桥出图（注入假图像后端）");
  const calls = [];
  const rt = FNR.createFnRuntime({
    procHost: PROC_HOST,
    imageCall: async (spec) => {
      calls.push(spec);
      return {
        ok: true,
        path: "C:/assets/wf-9/fn-n42-1.png",
        bytes: 1234,
        model: spec.model || "auto",
        via: "cloud",
        warnings: [],
      };
    },
  });
  const imgSpec = {
    model: "sensenova-local",
    label: "本机图像生成（SenseNova）",
    local: true,
    refImages: true,
    maxRefImages: 4,
    strength: true,
  };
  const rImg = await rt.run(
    {
      runId: "img-run",
      code:
        'const x = await mtnode.image("一只猫", { images: ["C:/ref.png"], strength: 0.5 });\n' +
        "return { ok: x.ok, path: x.path, model: x.model, via: x.via," +
        " cfg: mtnode.imgConfig.model, local: mtnode.imgConfig.local, max: mtnode.imgConfig.maxRefImages," +
        " capStrength: mtnode.imgConfig.strength };",
      input: {},
      img: imgSpec,
      wfId: "wf-9",
      nodeId: "n42",
    },
    () => {},
  );
  ok(
    rImg.ok === true && rImg.value && rImg.value.ok === true,
    "函数体 await mtnode.image(...) 正常返回 { ok:true }",
  );
  ok(
    rImg.value.path === "C:/assets/wf-9/fn-n42-1.png" && rImg.value.via === "cloud",
    "回执里的产物路径 / via 原样回到用户代码（可直接给图像输出端子）",
  );
  ok(
    calls.length === 1 &&
      calls[0].prompt === "一只猫" &&
      JSON.stringify(calls[0].images) === JSON.stringify(["C:/ref.png"]) &&
      calls[0].strength === 0.5,
    "prompt / images（参考图 → 图生图）/ strength 逐字下发到宿主",
  );
  ok(
    calls[0].model === "sensenova-local" && calls[0].nodeId === "n42" && calls[0].wfId === "wf-9",
    "节点「图像后端」的选择与运行归属（nodeId / wfId = 产物落哪个画布资产目录）随桥下发",
  );
  ok(
    rImg.value.cfg === "sensenova-local" &&
      rImg.value.local === true &&
      rImg.value.max === 4 &&
      rImg.value.capStrength === true,
    "mtnode.imgConfig 只读摘要回显选中后端的能力（模型 / 本机 / 参考图上限 / 强度）",
  );

  /* 调用级覆盖：只覆盖这一次，不改节点选择 */
  const rOver = await rt.run(
    {
      runId: "img-override",
      code: 'return await mtnode.image("x", { model: "img-1" });',
      input: {},
      img: imgSpec,
    },
    () => {},
  );
  ok(
    rOver.value.ok === true && calls[calls.length - 1].model === "img-1",
    "调用级 opts.model 覆盖这一次（不写回节点的「图像后端」选择）",
  );

  /* 没选过图像后端：不拦、不报错，交给主进程按 auto 走（云端优先、其次本机） */
  const rAuto = await rt.run(
    {
      runId: "img-auto",
      code: 'const x = await mtnode.image("跟随默认"); return { ok: x.ok, model: x.model };',
      input: {},
      img: null,
    },
    () => {},
  );
  ok(
    rAuto.value.ok === true &&
      !calls[calls.length - 1].model &&
      calls[calls.length - 1].img === null,
    "未选图像后端 → model 空 + img null（主进程按 auto 走），不拦不报错",
  );

  /* 空 prompt：桥本地先拦，不白跑一次主进程 */
  const before = calls.length;
  const rEmpty = await rt.run(
    { runId: "img-empty", code: 'return await mtnode.image("");', input: {}, img: imgSpec },
    () => {},
  );
  ok(
    rEmpty.value.ok === false &&
      String(rEmpty.value.error).indexOf("缺少 prompt") >= 0 &&
      calls.length === before,
    "空 prompt → mtnode.image 本地拦下并给明确错误（不发起桥调用）",
  );

  /* 主进程没注入后端：点名报错，不静默空跑 */
  const rtNo = FNR.createFnRuntime({ procHost: PROC_HOST });
  const rNo = await rtNo.run(
    { runId: "img-nobackend", code: 'return await mtnode.image("x");', input: {}, img: imgSpec },
    () => {},
  );
  ok(
    rNo.ok === true && rNo.value.ok === false && String(rNo.value.error).indexOf("未接线") >= 0,
    "主进程未注入 imageCall → mtnode.image 明确报「后端未接线」",
  );

  /* ═══════════ [2] 主进程接线：注入 + 产物落画布资产目录 ═══════════ */
  console.log("\n[2] 主进程接线：fnImageCall 复用同一个图像内核 + 产物落画布资产目录");
  ok(
    MAIN.indexOf("imageCall: (params) => fnImageCall(params)") > 0 &&
      MAIN.indexOf("async function fnImageCall(params)") > 0,
    "main.js 把 fnImageCall 注入 fnRuntime（与 aiCall 同一处）",
  );
  ok(
    MAIN.indexOf("hostImageGenerate({") > 0 && MAIN.indexOf('appId: "fn-" + nodeId') > 0,
    "fnImageCall 复用 apps-store 的 hostImageGenerate（**不是**第二套图像内核）",
  );
  ok(
    MAIN.indexOf("wfId ? assetDir(wfId) : mk(join(DATA(), \"fn-images\"))") > 0,
    "产物目录 = 本次画布资产目录（无画布时退回数据目录 fn-images，绝不落应用文件夹）",
  );
  ok(
    MAIN.indexOf('join(outDir, "fn-" + nodeId + "-" + Date.now() + "." + ext)') > 0 &&
      MAIN.indexOf('writeAssetBytes(file, Buffer.from(String(r.base64), "base64"))') > 0,
    "云端 base64 由宿主写进同一目录（本机后端则直写该目录）—— 两条路落在同一处",
  );
  ok(
    MAIN.indexOf('ipcMain.handle("image:backends"') > 0,
    "主窗口渲染层拿图像后端清单的通道 image:backends",
  );
  ok(
    FNR_SRC.indexOf("const imageCallFn = typeof deps.imageCall === \"function\" ? deps.imageCall : null;") > 0 &&
      FNR_SRC.indexOf('if (action === "image")') > 0 &&
      FNR_SRC.indexOf("image: (a, b) => {") > 0,
    "fn-runtime：imageCall 接线 + dispatchProc 的 image 分支 + mtnode.image 桥",
  );
  ok(
    FNR_SRC.indexOf("img: () => imgSpec") > 0 &&
      FNR_SRC.indexOf("imgSpec = msg.img && typeof msg.img === \"object\" ? msg.img : null;") > 0 &&
      FNR_SRC.indexOf("img: st.img,") > 0,
    "start 帧把节点选定的图像后端带进 worker（imgSpec → imgConfig / 桥）",
  );

  /* ═══════════ [3] 渲染层与两套桥的接线 ═══════════ */
  console.log("\n[3] 渲染层接线：节点头部按钮 · 运行 spec · 桥透传 · appHost.imageEdit");
  ok(
    AICALL.indexOf("function imgBackendResolved(node)") > 0 &&
      AICALL.indexOf("function imgBackendButtonEl(node)") > 0 &&
      AICALL.indexOf('getElementById("imgBackendPop")') > 0 &&
      AICALL.indexOf('if (typeof node.imgModel !== "string") node.imgModel = "";') > 0,
    "app-aicall：图像后端字段 / 生效值 / 头部按钮 / 独立弹层（与「AI 调用」并列）",
  );
  ok(
    CANVAS.indexOf("if (!isTool && typeof imgBackendButtonEl === \"function\")") > 0 &&
      CANVAS.indexOf("head.appendChild(imgBackendButtonEl(node))") > 0,
    "节点头部按钮：函数节点有、工具节点不显示（工具节点内部子图直接放图像节点）",
  );
  ok(
    NODES.indexOf("function functionImageSpec(node)") > 0 &&
      NODES.indexOf("img: functionImageSpec(n),") > 0 &&
      NODES.indexOf("img: functionImageSpec(node),") > 0,
    "app-nodes：画布运行与「测试」试跑两条路都带上图像后端 spec",
  );
  ok(
    NODES.indexOf("wfId: S.wf ? S.wf.id : \"\",") > 0 && NODES.indexOf("nodeId: n.id,") > 0,
    "运行参数带上 wfId / nodeId（决定产物落哪个画布资产目录）",
  );
  ok(
    JSEXEC.indexOf("img: opts.img && typeof opts.img === \"object\" ? opts.img : undefined,") > 0 &&
      JSEXEC.indexOf("wfId: opts.wfId ? String(opts.wfId) : undefined,") > 0 &&
      JSEXEC.indexOf("nodeId: opts.nodeId ? String(opts.nodeId) : undefined,") > 0,
    "js-exec 把 img / wfId / nodeId 透传给 fn:run",
  );
  ok(
    PRE.indexOf("imageBackends: () => ipcRenderer.invoke('image:backends')") > 0,
    "preload：主窗口桥暴露 imageBackends（列图像后端）",
  );
  ok(
    PRE_APP.indexOf("imageEdit: (opts, cb) => {") > 0 &&
      PRE_APP.indexOf('invoke("apps:hostImageEdit"') > 0 &&
      PRE_APP.indexOf("imageEdit(opts, cb)") > 0,
    "appHost.imageEdit：参考图必填的显式图生图入口（文档注释 + 实现）",
  );
  ok(
    STORE_SRC.indexOf('ipcMain.handle("apps:hostImageEdit"') > 0 &&
      STORE_SRC.indexOf("async function hostImageEdit(e, opts)") > 0 &&
      STORE_SRC.indexOf('return bad(t("图像编辑需要至少一张参考图（opts.images）"), "no_ref_image");') > 0,
    "apps-store：imageEdit 通道 + 参考图必填（不降级成文生图）",
  );
  ok(
    STORE_SRC.indexOf("images: refs.images.slice(),") > 0,
    "apps-store：参考图**整组**进 spec.images（云端图生图真下发的修复点）",
  );
  ok(
    STORE_SRC.indexOf('imageBackendsForUi,') > 0 && STORE_SRC.indexOf("function imageBackendsForUi()") > 0,
    "apps-store 导出 imageBackendsForUi（主窗口与应用窗口共用同一份清单口径）",
  );

  /* ═══════════ [4] i18n：新词条都有英文译文 ═══════════ */
  console.log("\n[4] i18n：图像后端 / 出图错误码的中英词条");
  const keys = [
    "图像后端",
    "云端",
    "支持参考图",
    "不支持参考图",
    "支持参考强度",
    "刷新清单",
    "跟随默认（自动）",
    "本节点已选择：",
    "当前继承自「",
    "未选择：函数节点里的 mtnode.image(...) 跟随 MTNode 默认图像后端（云端图像服务商优先，其次本机 SenseNova）。",
    "暂无可用图像后端：请先在 设置 → 模型服务 里配图像服务商（或安装本机 SenseNova 插件）。",
    "清除本节点「图像后端」这一格的选择，退回跟随默认（或继承上层）。",
    "当前图像后端不支持参考强度（strength），本次已忽略；本机 SenseNova 后端支持它",
    "图像编辑需要至少一张参考图（opts.images）",
    "未配置可用的图像后端（请在「设置 · API/配置」里配图像服务商，或安装本机 SenseNova 插件）",
    "mtnode.image：函数节点的图像后端未接线（主进程未注入 fnRuntime.imageCall）",
  ];
  const miss = [];
  for (const k of keys) {
    /* EN 表的键就是中文原文，值 = 英文译文：键后面必须紧跟冒号与内容 */
    const at = I18N.indexOf('"' + k + '":');
    if (at < 0) miss.push(k);
  }
  ok(miss.length === 0, "16 条新词条都在 i18n 的 EN 表里" + (miss.length ? "（缺：" + miss.join(" / ") + "）" : ""));
  ok(
    I18N.indexOf('"图像后端": "Image backend"') > 0,
    "抽查译文：「图像后端」→ Image backend",
  );

  console.log("\n" + (fails ? "FAILED " + fails + " / " + checks + " 项检查" : "ALL PASS " + checks + " 项检查"));
  process.exit(fails ? 1 : 0);
}

main().catch((e) => {
  console.error("冒烟脚本自身异常：", e);
  process.exit(1);
});
