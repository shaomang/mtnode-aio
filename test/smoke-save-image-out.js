"use strict";
/* 保存节点 ·「图像输出」（尺寸 / 裁剪 / 格式 / 质量）回归（纯 Node，无 Electron / 无真实 DOM）
 *   node test/smoke-save-image-out.js
 *
 * 钉住的口径：
 *   [1] 参数归一：老存档没有这批字段时一律走「原样 + PNG」缺省，越界值被夹回合法区间
 *   [2] 几何：缩放比例（等比例）/ 自定义像素 / 从中间裁（按目标比例取中央最大矩形）/ 自定义矩形
 *   [3] 落盘：prepareSaveImage 按格式换 mime（png 无损不收质量、jpg/webp 有损收质量）；
 *       BMP 被 Chromium 拒绝时退回 PNG 重编码，绝不落一张空文件
 *   [4] 后缀：saveImageExtFor 让保存路径的后缀跟随所选格式（.png → .jpg / .webp）
 *   [5] 接线：保存链改走 saveImageToDest（旧的「原样复制」保留为默认档）；
 *       节点头部按钮、app.js 浮层互斥、index.html / css 接入齐备
 *   [6] 「从中间裁」不写成静态矩形：它按目标长宽比在运行时算，目标宽高改了就跟着变
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

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
const ROOT = path.join(__dirname, "..");
const read = (rel) =>
  fs.readFileSync(path.join(ROOT, rel.split("/").join(path.sep)), "utf8");

/* ═══════════ 沙箱：只加载 renderer/app-imageout.js，DOM / 落盘全部打桩 ═══════════
   打桩口径：canvas 只把「plan 画了什么」记下来，toBlob 给一个 4 字节假图，
   assetWriteBase64 记下 ext，fileCopyAssetTo 记下 src → dest。 */
function load(opts) {
  opts = opts || {};
  const calls = { written: [], copied: [], draws: [], blobs: [], toasts: [] };
  const sandbox = {};
  sandbox.window = sandbox;
  sandbox.console = console;
  sandbox.URL = URL;
  /* FileReader 打桩：只把 blob 变成一段固定 base64，编码本身不在这里验 */
  sandbox.FileReader = class {
    readAsDataURL() {
      this.result = "data:image/png;base64,QkJCQg==";
      if (this.onload) this.onload();
    }
  };
  sandbox.I18n = { t: (s) => String(s) };
  sandbox.S = { wf: { id: "wf-1" } };
  sandbox.toast = (m) => calls.toasts.push(String(m));
  sandbox.renderCanvas = () => {};
  sandbox.scheduleSave = () => {};
  sandbox.pushHistory = () => {};
  sandbox.isSaveNode = (n) => !!(n && n.kind === "save");
  sandbox.saveMediaKind = () => "image";
  sandbox.saveExtForMedia = () => ".png";
  sandbox.forcePathExt = (p, ext) => {
    const s = String(p || "");
    return /\.[A-Za-z0-9]+$/.test(s) ? s.replace(/\.[A-Za-z0-9]+$/, ext) : s + ext;
  };
  sandbox.fileExtNoDot = (p) => {
    const m = /\.([A-Za-z0-9]+)$/.exec(String(p || ""));
    return m ? m[1].toLowerCase() : "";
  };
  sandbox.resolveSavePath = (p) => ({ ok: true, path: "E:\\out\\" + p });
  sandbox.isAbsPath = () => true;
  sandbox.fileUrlWithBust = (p) => "file:///" + p + "?t=1";
  sandbox.closeNodePopsExcept = (keep) => {
    calls.popsKeep = keep;
  };
  sandbox.nodePopAnchor = () => {};
  sandbox.placeNodePop = () => {};
  sandbox.inputValuesFor = () => [];
  sandbox.pathFromMediaValue = (v) => (v && v.path) || "";

  sandbox.Image = class {
    set src(u) {
      calls.lastImageUrl = u;
      this.naturalWidth = opts.srcW || 400;
      this.naturalHeight = opts.srcH || 200;
      if (this.onload) this.onload();
    }
  };
  sandbox.document = {
    createElement(tag) {
      if (tag === "canvas") {
        const c = {
          width: 0,
          height: 0,
          getContext() {
            return {
              imageSmoothingEnabled: false,
              imageSmoothingQuality: "",
              fillStyle: "",
              fillRect() {},
              drawImage(img, sx, sy, sw, sh, dx, dy, dw, dh) {
                calls.draws.push({
                  sx,
                  sy,
                  sw,
                  sh,
                  dx,
                  dy,
                  dw,
                  dh,
                  dt: [dx, dy, dw, dh],
                });
              },
            };
          },
          toBlob(cb, mime, q) {
            calls.blobs.push({ mime, quality: q });
            /* blobNullMs：只让指定 mime 拿不到 blob（模拟 Chromium 不支持 BMP），
               退回档（PNG）必须还能编出来，否则测的就不是「退回」而是「全挂」 */
            if (opts.blobNullMs && mime === opts.blobNullMs) cb(null);
            else if (opts.blobNull) cb(null);
            else cb({ size: 4 });
          },
        };
        return c;
      }
      return { style: {}, classList: { add() {}, remove() {} }, appendChild() {} };
    },
    querySelector: () => null,
    getElementById: () => null,
    body: { appendChild() {} },
  };
  sandbox.api = {
    toFileUrl: (p) => "file:///" + p,
    assetWriteBase64: (wfId, name, b64, ext) => {
      calls.written.push({ wfId, name, b64, ext });
      /* 真实主进程口径：dest = name + assetOutExt(ext) —— 即 name 后面直接接 ".ext" */
      return Promise.resolve({ ok: true, path: "E:\\asset\\" + name + "." + ext });
    },
    assetReadDataUrl: () => Promise.resolve({ ok: true, dataUrl: "data:image/png;base64,AAAA" }),
    fileExists: () => Promise.resolve(true),
  };
  sandbox.window.api = sandbox.api;
  sandbox.require = (m) => require(m);

  vm.createContext(sandbox);
  vm.runInContext(read("renderer/app-imageout.js"), sandbox, {
    filename: "app-imageout.js",
  });
  return { sandbox, calls };
}

const srcPath = "E:\\asset\\src.png";
async function prepare(node, o) {
  const { sandbox, calls } = load(o);
  const r = await vm.runInContext("prepareSaveImage", sandbox)(node, srcPath);
  return { r, calls, sandbox };
}

(async () => {
  console.log("[" + 1 + "] 参数归一：缺省 = 原样 + PNG；越界值被夹回");
  {
    const { sandbox } = load();
    const node = { kind: "save", savePath: "a.png" };
    vm.runInContext("normalizeImageOut", sandbox)(node);
    ok(node.oopMode === "orig", "缺省尺寸模式 = orig（原样）");
    ok(node.oopCrop === "none", "缺省裁剪 = none");
    ok(node.oopFormat === "png", "缺省格式 = png");
    ok(node.oopScale === 100, "缺省缩放比例 = 100%");
    ok(node.oopQuality === 0.92, "缺省质量 = 0.92");
    ok(node.oopWidth === 0 && node.oopHeight === 0, "缺省自定义宽高 = 0（跟随源图）");
    ok(
      vm.runInContext("imageOutActive", sandbox)(node) === false,
      "默认档判定为「未改过设定」（面板不高亮、摘要不出声）",
    );
    const bad = {
      kind: "save",
      oopMode: "zoom",
      oopCrop: "cut",
      oopFormat: "tiff",
      oopScale: "9999",
      oopQuality: "7",
      oopWidth: -5,
    };
    vm.runInContext("normalizeImageOut", sandbox)(bad);
    ok(bad.oopMode === "orig" && bad.oopCrop === "none" && bad.oopFormat === "png",
      "非法枚举一律回落到默认档");
    ok(bad.oopScale === 1600, "缩放比例上限夹到 1600%");
    ok(bad.oopQuality === 1, "质量上限夹到 1.0");
    ok(bad.oopWidth === 0, "负数宽高归一为 0（= 跟随源图）");
  }

  console.log("\n[2] 几何：缩放 / 自定义像素 / 从中间裁 / 自定义矩形");
  {
    const { sandbox } = load();
    const plan = (n, w, h) =>
      vm.runInContext("imageOutPlan", sandbox)(
        Object.assign({ kind: "save" }, n),
        w,
        h,
      );
    let p = plan({}, 400, 200);
    ok(p.x === 0 && p.y === 0 && p.w === 400 && p.h === 200, "原样：裁区 = 全图");
    ok(p.tw === 400 && p.th === 200, "原样：输出 = 源像素");
    p = plan({ oopMode: "scale", oopScale: 50 }, 400, 200);
    ok(p.tw === 200 && p.th === 100, "等比缩小 50% → 200×100（长宽比不变）");
    p = plan({ oopMode: "scale", oopScale: 250 }, 400, 200);
    ok(p.tw === 1000 && p.th === 500, "等比放大 250% → 1000×500，裁区仍是全图");
    ok(p.w === 400 && p.h === 200, "缩放不改裁区（采样而非裁剪）");
    p = plan({ oopMode: "custom", oopWidth: 640, oopHeight: 640 }, 400, 200);
    ok(p.tw === 640 && p.th === 640, "自定义尺寸直接生效（允许改变长宽比）");
    ok(p.w === 400 && p.h === 200, "自定义尺寸本身不裁剪");
    p = plan({ oopCrop: "manual", oopCropX: 50, oopCropY: 20, oopCropW: 100, oopCropH: 80 }, 400, 200);
    ok(p.x === 50 && p.y === 20 && p.w === 100 && p.h === 80, "自定义矩形：按源图像素取块");
    ok(p.tw === 100 && p.th === 80, "自定义矩形：输出 = 裁区（未同时改尺寸）");
    p = plan({ oopCrop: "manual", oopCropX: 380, oopCropY: 190, oopCropW: 100, oopCropH: 100 }, 400, 200);
    ok(p.x === 300 && p.y === 100 && p.w === 100 && p.h === 100,
      "越界矩形被夹回图内（右下角贴边，不会取到画布外）");
    p = plan({ oopCrop: "center", oopMode: "custom", oopWidth: 300, oopHeight: 300 }, 400, 200);
    ok(p.w === 200 && p.h === 200, "从中间裁 1:1 → 取 200×200（受短边限制）");
    ok(p.x === 100 && p.y === 0, "居中：x = (400-200)/2，y = (200-200)/2");
    ok(p.tw === 300 && p.th === 300, "再缩到目标 300×300");
    p = plan({ oopCrop: "center", oopMode: "custom", oopWidth: 400, oopHeight: 100 }, 400, 200);
    ok(p.w === 400 && p.h === 100, "从中间裁 4:1 → 取 400×100");
    ok(p.y === 50, "居中：y = (200-100)/2");
    /* 目标比例改了，裁区必须跟着变 —— 这就是「从中间裁」不写成静态矩形的原因 */
    const p2 = plan({ oopCrop: "center", oopMode: "custom", oopWidth: 100, oopHeight: 100 }, 400, 200);
    ok(p2.w !== p.w || p2.h !== p.h, "目标比例变化 → 裁区随之重算（不是固定矩形）");
  }

  console.log("\n[3] 落盘：格式换 mime / 有损才收质量 / BMP 不支持时退回 PNG");
  {
    const r1 = await prepare({ kind: "save", oopFormat: "png", oopQuality: 0.5 });
    ok(r1.r.ok === true, "PNG 默认档编码成功");
    ok(r1.calls.blobs[0].mime === "image/png", "PNG → image/png");
    ok(r1.calls.blobs[0].quality === undefined, "PNG 无损：不传 quality");
    ok(r1.calls.written[0].ext === "png", "资产按 png 扩展名写入");

    const r2 = await prepare({ kind: "save", oopFormat: "jpg", oopQuality: 0.6 });
    ok(r2.calls.blobs[0].mime === "image/jpeg", "JPG → image/jpeg");
    ok(r2.calls.blobs[0].quality === 0.6, "JPG 有损：把质量传下去");
    ok(r2.calls.written[0].ext === "jpg", "jpeg 家族落 .jpg（不是 .jpeg）");

    const r3 = await prepare({ kind: "save", oopFormat: "webp", oopQuality: 0.4 });
    ok(r3.calls.blobs[0].mime === "image/webp", "WebP → image/webp");
    ok(r3.calls.blobs[0].quality === 0.4, "WebP 有损：把质量传下去");
    ok(r3.calls.written[0].ext === "webp", "资产按 webp 写入");

    const r4 = await prepare({ kind: "save", oopFormat: "bmp" }, { blobNullMs: "image/bmp" });
    ok(r4.calls.blobs.length === 2, "BMP 拿不到 blob → 再编一次 PNG");
    ok(r4.calls.blobs[1].mime === "image/png", "退回档 = PNG");
    ok(r4.r.ok === true && r4.calls.written[0].ext === "png",
      "退回后落盘扩展名同步为 png（不会写出空的 .bmp）");

    const r5 = await prepare({ kind: "save" }, { srcW: 400, srcH: 200 });
    ok(r5.calls.draws[0].sw === 400 && r5.calls.draws[0].sh === 200,
      "默认档：整幅源图一次性画进输出 canvas（等价原样复制）");
    const r6 = await prepare(
      { kind: "save", oopMode: "scale", oopScale: 50 },
      { srcW: 400, srcH: 200 },
    );
    ok(r6.calls.draws[0].dw === 200 && r6.calls.draws[0].dh === 100,
      "等比 50%：drawImage 的目标宽高同步缩小（真的改了尺寸）");
    ok(r6.calls.written[0].ext === "png", "默认档 PNG：资产扩展名 = png");
  }

  console.log("\n[4] 后缀：saveImageExtFor 让保存路径跟随所选格式");
  {
    const { sandbox } = load();
    const ext = vm.runInContext("saveImageExtFor", sandbox);
    ok(ext({ savePath: "a.png" }) === ".png", "默认档 + .png 路径 → 保持 .png");
    ok(ext({ savePath: "a.webp" }) === ".webp",
      "默认档但路径写了 .webp → 尊重用户后缀（与改动前一致）");
    ok(ext({ savePath: "a.png", oopFormat: "jpg" }) === ".jpg",
      "显式选了 JPG → 后缀换成 .jpg");
    ok(ext({ savePath: "a.png", oopFormat: "jpeg" }) === ".jpg",
      "jpeg 别名同样落 .jpg");
    ok(ext({ savePath: "a.png", oopFormat: "bmp" }) === ".bmp", "BMP → .bmp");
    ok(
      vm.runInContext("imageOutMime", sandbox)({ oopFormat: "webp" }) === "image/webp",
      "mime 与格式对应",
    );
  }

  console.log("\n[5] 接线：保存链 / 头部按钮 / 浮层互斥 / 资源接入");
  {
    const nodes = read("renderer/app-nodes.js");
    ok(
      nodes.indexOf("async function saveImageToDest(node, srcPath, destBase)") >= 0,
      "app-nodes.js 新增 saveImageToDest（裁剪 → 缩放 → 重编码 → 复制）",
    );
    ok(
      nodes.indexOf("await saveImageToDest(node, ins[0].value.path, destBase0)") >= 0,
      "单张保存走 saveImageToDest",
    );
    ok(
      nodes.indexOf("batchOutPath(destBase0, titles[idx], \".png\")") >= 0 &&
        nodes.indexOf("await saveImageToDest(") >= 0,
      "批量保存逐个走 saveImageToDest（按条目给基名）",
    );
    ok(
      nodes.indexOf("const saved = await saveImageToDest(node, paths[0], dest0);") >= 0,
      "聚合保存也走同一编码口径",
    );
    ok(
      nodes.indexOf("node.savedPath = destBase") >= 0 &&
        /const destBase = saved\.path;/.test(nodes),
      "落盘记录用实际写入路径（后缀换掉后记录不会指向旧 .png）",
    );
    ok(
      nodes.indexOf("图像输出设定未能应用（已按原样复制）") >= 0,
      "编码失败时明确提示并退回原样复制（不静默丢图）",
    );

    const canvas = read("renderer/app-canvas.js");
    ok(
      canvas.indexOf("window.imageOutButtonEl(node)") >= 0 &&
        canvas.indexOf('saveMediaKind(node) === "image"') >= 0,
      "节点头部只在「按图像保存」时挂图像输出按钮",
    );
    ok(
      canvas.indexOf("function saveImageOutLine(node)") >= 0 &&
        canvas.indexOf("saveImageOutLine(node)") >= 0,
      "画布侧有实际落盘路径摘要（后缀被格式换掉一眼可见）",
    );
    ok(
      canvas.indexOf("图像输出（尺寸 / 裁剪 / 格式 / 质量）") >= 0 &&
        canvas.indexOf("window.openImageOutPop(node, anchor || ob)") >= 0,
      "⚙ 保存设置窗里有「图像输出设定…」入口",
    );
    ok(
      /signature: \(node\) =>[\s\S]{0,160}imageOutSummary/.test(canvas),
      "设置窗签名带上图像输出摘要（改格式后提示与占位会刷新）",
    );

    const app = read("renderer/app.js");
    ok(
      app.indexOf('else if (id === "imgOutPop" && typeof window.closeImgOutPop === "function")') >= 0,
      "app.js closeNodePopById 认 imgOutPop（浮层互斥 / 切画布收干净）",
    );
    ok(app.indexOf('["imgOut", "imgOutPop", null]') >= 0, "closeNodePopsExcept 互斥表带上图像输出面板");
    const repopLine = /for \(const id of \[[\s\S]{0,160}?\]\) \{/.exec(
      app.slice(app.indexOf("function repositionNodePops()")),
    );
    ok(
      !!repopLine && repopLine[0].indexOf('"imgOutPop"') >= 0,
      "repositionNodePops 平移 / 缩放后把面板贴回按钮（含 imgOutPop）",
    );

    const html = read("renderer/index.html");
    ok(
      html.indexOf('<script src="app-imageout.js"></script>') >= 0 &&
        html.indexOf('src="app-imageout.js"') > html.indexOf('src="app-canvas.js"'),
      "index.html 在 app-canvas.js 之后接入 app-imageout.js",
    );

    const css = read("renderer/css/components.css");
    ok(
      css.indexOf(".img-out-pop {") >= 0 && css.indexOf(".n-imgout-btn.on {") >= 0,
      "components.css 有面板容器与头部按钮样式",
    );

    const mod = read("renderer/app-imageout.js");
    for (const name of [
      "window.imageOutButtonEl",
      "window.openImageOutPop",
      "window.closeImgOutPop",
      "window.prepareSaveImage",
      "window.saveImageExtFor",
      "window.normalizeImageOut",
    ])
      ok(mod.indexOf(name) >= 0, "对外导出 " + name);
    ok(
      mod.indexOf("ctx.imageSmoothingEnabled = true") >= 0 &&
        /ctx\.imageSmoothingQuality = /.test(mod),
      "缩放走 canvas 平滑采样（不是最近邻放大）",
    );
    ok(
      /if \(node\.oopFormat === "jpg" \|\| node\.oopFormat === "jpeg" \|\| node\.oopFormat === "bmp"\)/.test(mod),
      "无 Alpha 格式先铺白底（透明区不会变黑）",
    );
  }

  console.log(
    "\n" + (fails ? "FAIL" : "PASS") + " — " + checks + " 项，失败 " + fails + " 项",
  );
  process.exit(fails ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
