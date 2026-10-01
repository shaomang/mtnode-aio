/* 临时：在**真浏览器**里驱动真模块（test/_preview-trajectory-interactive.html）量本轮两条需求 ——
   [1] 轴上「运行中」的块不闪（计算样式 animation-name = none，且整条轴里没有别的动画）；
   [2] 轴身滚轮横向拉伸：锚点处拉近 → 块变宽 / 刻度跟着走 → 双击轴回全轴。
   与冒烟 [16] 的区别：这里的 WheelEvent 是真事件、指针位置由 getBoundingClientRect 算出来
   （冒烟里的迷你 DOM 量不到布局，锚点走的是「左缘」兜底）。

   本轮扩测两段（同样只读地驱动真模块，事件一律真 PointerEvent / WheelEvent）：
   [3] **滑窗带可拖动平移**：按住 .dsh-trace-window（落点 = 带自己的矩形中心，与 bandHitAt 同一只矩形）
       派发 pointerdown → pointermove × N（位移过 DRAG_SLOP 才进拖动态）→ pointerup，
       量拖动前后的 window left / width（**宽不变**、left 随 Δx 单调右移）、列表 scrollTop 与
       首可见行、拖动中轴与带的 .dragging / 光标 / 带改吃指针、松开即收，另加两条出口：
       拖动中按 Esc 当场收掉在拖的那一次、松开后按 Esc 回全轴（缩放窗归零、块几何逐值回全轴那一份）。
   [4] **行皮肤与对话逐值对比**：t-think / t-tool / t-say 三种行的 border-left 宽度 · 计算色值 ·
       圆角 · 淡底，与同一份 renderer/style.css 里的真对话段 .dsh-seg-*（在联调页里现挂三只真段）
       逐值比。
   [3] 的前置有一条口径要交代：滑窗带的宽度 = **本视窗那几行的真实跨度**，原现场 4 条记录长短不一
   （400 / 300 / 1900 / 未回），拖动时带子本就会忽宽忽窄 —— 「宽不变」只有在**等距等长**的序列上
   才是一条有意义的断言，故 [3] 先把现场换成 40 条等距（每 300ms 一次、各 150ms）的调用（走模块
   自己的 render），原现场只留给 [4] 量三种行。

   跑完即删（证据：命令行输出 + 落盘截图两张）。
   用法：node test/_cdp-measure-trajectory-zoom.js
*/
"use strict";
const fs = require("fs");
const PORT = Number(process.argv[2] || 9222);
const SHOT = "E:\\dev\\tools\\pipeline-console\\test\\_tmp-trajectory-zoom.png";
const SHOT_DRAG = "E:\\dev\\tools\\pipeline-console\\test\\_tmp-trajectory-drag.png";
const PAGE = /_preview-trajectory-interactive\.html/;

function cdp(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const pending = new Map();
    ws.onopen = () =>
      resolve({
        send(method, params) {
          const mid = ++id;
          return new Promise((res) => {
            pending.set(mid, res);
            ws.send(JSON.stringify({ id: mid, method, params }));
          });
        },
        close: () => ws.close(),
      });
    ws.onerror = (e) => reject(new Error("WS 失败：" + (e && e.message)));
    ws.onmessage = (ev) => {
      let m = null;
      try {
        m = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (m.id && pending.has(m.id)) {
        pending.get(m.id)(m);
        pending.delete(m.id);
      }
    };
  });
}

const call = async (c, expression) => {
  const r = await c.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  const res = r && r.result && r.result.result ? r.result.result : (r && r.result) || r || {};
  if (res.exceptionDetails) throw new Error("渲染层抛错：" + JSON.stringify(res.exceptionDetails).slice(0, 500));
  return res.value;
};

(async () => {
  const list = await (await fetch("http://127.0.0.1:" + PORT + "/json/list")).json();
  const page = list.find((t) => t.type === "page" && PAGE.test(t.url || ""));
  if (!page) {
    console.error("没找到联调页：", list.map((t) => t.url).join(" | "));
    process.exit(2);
  }
  const c = await cdp(page.webSocketDebuggerUrl);
  const em = await c.send("Emulation.setDeviceMetricsOverride", {
    width: 1280,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  if (em && em.error) console.error("setDeviceMetricsOverride 失败：" + JSON.stringify(em.error));
  await c.send("Page.enable", {});
  await c.send("Page.reload", { ignoreCache: true });
  await new Promise((r) => setTimeout(r, 1500));

  const out = {};
  out.ready = await call(c, "!!(window.__mtn && window.__mtn.ready)");
  if (!out.ready) {
    console.error("联调页没就绪（window.__mtn.ready 为假）");
    process.exit(1);
  }
  /* 本视窗先摆到中间一行（整表可见时滑窗带 = 全部，看不出「本视窗」这件事） */
  out.before = await call(c, "window.__mtn.scroll(0)");
  /* [1] 不闪 + [2] 锚点 25% 处拉近 */
  out.zoom1 = await call(c, "window.__mtn.wheel(0.25, -240)");
  out.zoom2 = await call(c, "window.__mtn.wheel(0.25, -240)");
  out.zoomOut = await call(c, "window.__mtn.wheel(0.25, 240)");
  out.afterDbl = await call(c, "window.__mtn.dblclick()");
  out.afterReset = await call(c, "window.__mtn.resetZoom()");
  /* 视窗在尾部时拉近：缩放窗应当**盖住本视窗那一段**（domainOf 的「视窗跟着走」，
     判据 = 视窗时间段的**中点**落在窗内 15%–85%），而不是把视窗关在窗外。
     本页面只有 8 行（96px 视窗 = 三行），视窗在尾部时那一段是 4200–7000 —— 拉近一档后
     窗长 2400ms，中点 5600 在窗外 → 本帧把窗平移过去盖住它。 */
  out.tail = await call(c, "window.__mtn.scroll('tail')");
  out.zoomTail = await call(c, "window.__mtn.wheel(0.5, -240)");

  const one = (s) => Number(String((s.marks[0] || "").split("/")[1] || "0").replace("%", ""));
  const lines = [];
  let fails = 0;
  const ok = (cond, label) => {
    lines.push((cond ? "  ok    " : "  FAIL  ") + label);
    if (!cond) fails++;
  };
  lines.push("联调页 = " + page.url);
  /* [0] 轴框高度账：刻度 / 色块轨 / 读数 / 图例四件都要在轴框内（图例被 overflow:hidden
     裁掉是上一轮修掉的 bug，这里在真浏览器里留一道可复核的判据）。 */
  const ax = out.before.axis || {};
  const inFrame = (x) => !!x && x.clipped === false;
  ok(
    inFrame(ax.ticks) && inFrame(ax.tracks) && inFrame(ax.scale) && inFrame(ax.legend),
    "[0] 轴框里五件都在（刻度 / 3 轨 / 读数 / 图例都没被裁掉）：轴高 " +
      (ax.ruler ? ax.ruler.h : "?") +
      "px · 刻度 " +
      (ax.ticks ? ax.ticks.h : "?") +
      " / 轨区 " +
      (ax.tracks ? ax.tracks.h : "?") +
      "（" +
      ax.trackCount +
      " 轨 · " +
      ax.markCount +
      " 块） / 读数 " +
      (ax.scale ? ax.scale.h : "?") +
      " / 图例 " +
      (ax.legend ? ax.legend.h : "?") +
      "（" +
      ax.legendItems +
      " 项 · " +
      ax.overflow +
      "）",
  );
  ok(
    out.before.runAnim && out.before.runAnim.name === "none" && out.before.animCount === 0,
    "[1] 轴上没有闪烁：run 块 animation-name=" +
      (out.before.runAnim ? out.before.runAnim.name : "无") +
      " / duration=" +
      (out.before.runAnim ? out.before.runAnim.dur : "无") +
      "，整条轴里带动画的元素 " +
      out.before.animCount +
      " 个；静态柔光 " +
      String(out.before.runAnim && out.before.runAnim.shadow).slice(0, 60),
  );
  ok(
    one(out.zoom1) > one(out.before) && out.zoom1.debug.zoomLo != null,
    "[2] 轴身滚轮拉近：块变宽 " +
      one(out.before).toFixed(3) +
      "% → " +
      one(out.zoom1).toFixed(3) +
      "%（视窗在顶部时），缩放窗 " +
      Math.round(out.zoom1.debug.zoomLo) +
      "–" +
      Math.round(out.zoom1.debug.zoomHi),
  );
  ok(
    one(out.zoom2) > one(out.zoom1),
    "[2] 再滚一档继续拉近（一档一档叠着拉）：" +
      one(out.zoom1).toFixed(3) +
      "% → " +
      one(out.zoom2).toFixed(3) +
      "%",
  );
  ok(
    one(out.zoomOut) < one(out.zoom2),
    "[2] 反方向滚 = 拉远（同一套窗算回去）：" +
      one(out.zoom2).toFixed(3) +
      "% → " +
      one(out.zoomOut).toFixed(3) +
      "%",
  );
  ok(
    out.zoom1.ticks.join("|") !== out.before.ticks.join("|") && /缩放 [\d.]+×/.test(out.zoom1.scale),
    "[2] 刻度跟着走本帧窗口 + 读数挂出缩放倍数：刻度「" +
      out.before.ticks.join("|") +
      "」→「" +
      out.zoom1.ticks.join("|") +
      "」· 读数「" +
      out.zoom1.scale +
      "」",
  );
  ok(
    out.zoom1.band && /%$/.test(String(out.zoom1.band.left)) && /%$/.test(String(out.zoom1.band.width)),
    "[2] 缩放时滑窗带仍在（与块同一套横坐标，只是按新窗缩过）：带 " +
      (out.zoom1.band
        ? out.zoom1.band.left + " / " + out.zoom1.band.width + " · " + out.zoom1.band.at + "–" + out.zoom1.band.end
        : "无"),
  );
  ok(
    out.afterDbl.marks.join("|") === out.before.marks.join("|") &&
      out.afterDbl.ticks.join("|") === out.before.ticks.join("|") &&
      out.afterDbl.debug.zoomLo == null,
    "[2] 双击轴 = 回全轴（块与刻度逐值回到未缩放那一份）",
  );
  ok(out.afterReset === false, "[2] 已回全轴时再归零 = 空操作（resetZoom 回 false，不重画）");
  const bt = out.tail.band || {};
  const zt = out.zoomTail.debug || {};
  const midT = (Number(bt.at) + Number(bt.end)) / 2;
  const fT = zt.zoomLo != null ? (midT - zt.zoomLo) / (zt.zoomHi - zt.zoomLo) : -1;
  ok(
    zt.zoomLo != null && fT >= 0.15 && fT <= 0.85,
    "[2] 视窗在尾部时拉近 → 窗**平移**到盖住本视窗（视窗中点落在窗内 15%–85%）：视窗 " +
      bt.at +
      "–" +
      bt.end +
      "（中点 " +
      Math.round(midT) +
      "）· 窗 " +
      Math.round(zt.zoomLo) +
      "–" +
      Math.round(zt.zoomHi) +
      "，中点落在窗内 " +
      (fT * 100).toFixed(0) +
      "% 处",
  );
  ok(
    zt.zoomLo != null && zt.zoomHi - zt.zoomLo < 8400,
    "[2] 平移不改尺度（窗仍比全轴短）：窗长 " +
      (zt.zoomLo != null ? Math.round(zt.zoomHi - zt.zoomLo) : "无") +
      "ms / 全轴 8400ms",
  );

  /* ── [4] 行皮肤 vs 对话 .dsh-seg-*（在**原现场**量：那里才有 think / tool / say 三种行）──
     先往联调页里现挂三只**真对话段**（同一份 renderer/style.css、真 .dsh-seg-* 类名、挂在
     .agent-list 下、离屏摆放、段里有字避开 .dsh-seg:empty）—— 对照物因此是这份样式表算出来的
     真值，不是我抄的期望值。 */
  await call(
    c,
    `(function () {
  var q = function (s, r) { return (r || document).querySelector(s); };
  var ruler = function () { return document.getElementById("agentTraceRuler"); };
  var listOf = function () { return q(".dsh-trace-list"); };
  var bandOf = function () { var r = ruler(); return r ? r.querySelector(".dsh-trace-window") : null; };
  var txt = function (el) { return String((el && el.textContent) || ""); };
  var gv = function (el, k) { return getComputedStyle(el).getPropertyValue(k).trim(); };
  var cssOf = function (el) {
    return {
      blw: gv(el, "border-left-width"),
      bls: gv(el, "border-left-style"),
      blc: gv(el, "border-left-color"),
      radius: [gv(el, "border-top-left-radius"), gv(el, "border-top-right-radius"), gv(el, "border-bottom-right-radius"), gv(el, "border-bottom-left-radius")].join(" "),
      bg: gv(el, "background-color"),
      color: gv(el, "color")
    };
  };
  /* 读数快照：带的 left / width（行内百分比，模块自己写的）+ 带的那段真实时刻、列表滚动位置与
     首可见行、拖动态三件（轴与带的 .dragging、轴光标、带改吃指针）、脚下读数（拖动中会多一段
     「拖动中 · 窗 起–止」）、轴上块几何、模块诊断（dragOn / dragPend / dragWin / zoomLo / zoomHi）。 */
  var snap = function () {
    var r = ruler();
    var list = listOf();
    var b = bandOf();
    var out = {
      left: b ? b.style.left : null,
      width: b ? b.style.width : null,
      bandAt: b ? Number(b.dataset.at) : null,
      bandEnd: b ? Number(b.dataset.end) : null,
      bandDragging: !!(b && b.classList.contains("dragging")),
      bandPE: b ? b.style.pointerEvents : "",
      bandCursor: b ? b.style.cursor : "",
      rulerDragging: !!(r && r.classList.contains("dragging")),
      rulerCursor: r ? r.style.cursor : "",
      scale: txt(q(".dsh-trace-scale", r)),
      marks: Array.prototype.map.call((r || document).querySelectorAll(".dsh-trace-mark"), function (m) { return m.style.left + "/" + m.style.width; }),
      scrollTop: list ? Number(list.scrollTop) || 0 : -1,
      vis: 0,
      first: null,
      debug: window.MTNodeTrajectory._debug()
    };
    if (list) {
      var lb = list.getBoundingClientRect();
      var rows = [];
      Array.prototype.forEach.call(list.querySelectorAll(".dsh-trace-row"), function (el) {
        var rb = el.getBoundingClientRect();
        if (!(rb.height > 0)) return;
        if (!(rb.bottom > lb.top + 0.5 && rb.top < lb.bottom - 0.5)) return;
        var mm = String(el.className).match(/t-[a-z]+/);
        rows.push({ idx: Number(el.dataset.idx), kind: mm ? mm[0] : "", tick: txt(q(".dsh-trace-tick", el)) });
      });
      rows.sort(function (a, b2) { return a.idx - b2.idx; });
      out.vis = rows.length;
      out.first = rows[0] || null;
    }
    return out;
  };
  /* 真指针事件：落点 = 带自己的矩形中心（bandHitAt 用的就是这只矩形，纵向也一并判掉）。 */
  var px = 0, py = 0, lastDx = 0;
  var pe = function (type, x, y, buttons) {
    return new PointerEvent(type, {
      pointerId: 11, pointerType: "mouse", isPrimary: true, button: 0, buttons: buttons,
      clientX: x, clientY: y, bubbles: true, cancelable: true, composed: true
    });
  };
  var api = {
    snap: snap,
    bandBox: function () {
      var b = bandOf();
      if (!b) return null;
      var r = b.getBoundingClientRect();
      return { left: r.left, top: r.top, w: r.width, h: r.height, cx: r.left + r.width / 2, cy: r.top + r.height / 2 };
    },
    down: function () {
      var bx = api.bandBox();
      if (!bx) return null;
      px = bx.cx; py = bx.cy; lastDx = 0;
      ruler().dispatchEvent(pe("pointerdown", px, py, 1));
      return snap();
    },
    move: function (dx) {
      lastDx = dx;
      ruler().dispatchEvent(pe("pointermove", px + dx, py, 1));
      return snap();
    },
    up: function () {
      ruler().dispatchEvent(pe("pointerup", px + lastDx, py, 0));
      return snap();
    },
    esc: function () {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      return snap();
    },
    segSkin: function () {
      var host = document.getElementById("dgnSegRef");
      if (!host) {
        host = document.createElement("div");
        host.id = "dgnSegRef";
        host.className = "agent-list";
        host.setAttribute("style", "position:fixed;left:-4000px;top:0;width:360px;");
        ["think", "tool", "say"].forEach(function (k) {
          var el = document.createElement("div");
          el.className = "dsh-seg dsh-seg-" + k;
          el.id = "dgnSeg-" + k;
          el.textContent = "参考段 " + k;
          host.appendChild(el);
        });
        document.body.appendChild(host);
      }
      return { think: cssOf(q("#dgnSeg-think")), tool: cssOf(q("#dgnSeg-tool")), say: cssOf(q("#dgnSeg-say")) };
    },
    rowSkin: function (kind) {
      var el = q(".dsh-trace-list .dsh-trace-row.t-" + kind);
      return el ? cssOf(el) : null;
    },
    /* 把列表摆到「第 idx 行居中」的位置（与模块 scrollRowCenter 同一套算式：行高 32、
       半行 16，再加行流起点的偏移）—— 视窗因此恒装 3 行，滑窗带宽度是定值。 */
    recenter: function (idx) {
      var list = listOf();
      var sp = q(".dsh-trace-spacer", list);
      var streamAt = sp ? Number(sp.offsetTop) || 0 : 0;
      var ch = Number(list.clientHeight) || 0;
      list.scrollTop = Math.max(0, Math.round(idx * 32 + streamAt - ch / 2 + 16));
      return snap();
    },
    /* 等距等长的工具序列（每 300ms 一次调用、各 150ms）：视窗恒装 3 行 → 滑窗带宽度是定值，
       「拖动时宽不变」这才量得到。换现场走模块自己的 render（与真应用同一条通路）。 */
    scene: function (n) {
      var items = [], tools = [];
      for (var i = 0; i < n; i++) {
        var cid = "u" + i;
        items.push({ k: "tool", text: "", round: 1, step: i + 1, callId: cid });
        var at = 1000 + i * 300;
        tools.push({ callId: cid, round: 1, step: i + 1, name: "read", at: at, doneAt: at + 150, args: { path: "f" + i + ".js" }, result: [{ text: "ok" }] });
      }
      window.__items = items;
      S.agentSessions[0]._liveTools = tools;
      window.MTNodeTrajectory.render("aslive");
      return snap();
    }
  };
  window.__dgn = api;
})()`,
  );

  const segRef = await call(c, "window.__dgn.segSkin()");
  const rowSkin = {};
  for (const k of ["think", "tool", "say"]) rowSkin[k] = await call(c, "window.__dgn.rowSkin('" + k + "')");
  const skinSame = (k) =>
    !!rowSkin[k] && !!segRef[k] && rowSkin[k].blw === segRef[k].blw && rowSkin[k].bls === segRef[k].bls &&
    rowSkin[k].blc === segRef[k].blc && rowSkin[k].radius === segRef[k].radius && rowSkin[k].bg === segRef[k].bg;
  const skinTxt = (k) =>
    "t-" + k + " " + rowSkin[k].blw + " " + rowSkin[k].bls + " " + rowSkin[k].blc + " · 圆角 " + rowSkin[k].radius + " · 底 " + rowSkin[k].bg +
    " ⇄ .dsh-seg-" + k + " " + segRef[k].blw + " " + segRef[k].bls + " " + segRef[k].blc + " · 圆角 " + segRef[k].radius + " · 底 " + segRef[k].bg;
  ok(
    skinSame("think") && skinSame("tool"),
    "[24] 思考行 / 工具行的 border-left 宽度 · 计算色值 · 圆角 · 淡底与对话段逐值相同：" + skinTxt("think") + " ｜ " + skinTxt("tool"),
  );
  ok(
    !!rowSkin.say && !!segRef.say && rowSkin.say.blw === segRef.say.blw && rowSkin.say.bls === segRef.say.bls,
    "[24] 正文行 / 正文段都不上轨（border-left 0px / none）：" + skinTxt("say"),
  );
  lines.push(
    "  ·     正文行的圆角取行底 --dsh-r-md（" + rowSkin.say.radius + "）、对话 .dsh-seg-say 无圆角（" + segRef.say.radius +
      "）—— t-say 按口径**不写皮**（无轨无底），这一处是行底自带的值，不是皮肤偏差；正文行/段底色同为 " + rowSkin.say.bg,
  );

  /* ── [3] 真 PointerEvent 拖动滑窗带（先把现场换成等距等长的 40 条调用）──
     两件前置：① 横轴缩放先归零 —— 缩放态下拖动平移的是**缩放窗**（窗里的滑窗带被重新居中，
     左缘会随每帧的窗平移来回走），本条口径量的是「未缩放时平移滑窗带自己」；② 列表摆到
     第 13 行居中（与模块 scrollRowCenter 同一套算式），视窗恒装 3 行 → 带宽是定值。
     事件序列分四次调用派发（down → move × N → 截图 → up），拖动那张截图要在**按住**那一帧拍，
     所以不能把整串塞进一次 evaluate。 */
  await call(c, "window.MTNodeTrajectory.resetZoom(); window.__dgn.scene(40)");
  await call(c, "window.__mtn.scroll(390)");
  await call(c, "window.__dgn.recenter(13)");
  await new Promise((r) => setTimeout(r, 250));
  const dBox = await call(c, "window.__dgn.bandBox()");
  const d0 = await call(c, "window.__dgn.snap()");
  const DRAG_DX = [8, 40, 72, 104, 136, 168];
  const dDown = await call(c, "window.__dgn.down()");
  const dSteps = [];
  for (const dx of DRAG_DX) dSteps.push(await call(c, "window.__dgn.move(" + dx + ")"));
  const shotDrag = await c.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
  let dragShotMsg = "";
  if (shotDrag && shotDrag.result && shotDrag.result.data) {
    fs.writeFileSync(SHOT_DRAG, Buffer.from(shotDrag.result.data, "base64"));
    dragShotMsg = SHOT_DRAG + "（" + fs.statSync(SHOT_DRAG).size + " 字节）";
  } else {
    dragShotMsg = "失败：" + JSON.stringify(shotDrag).slice(0, 200);
  }
  const dUp = await call(c, "window.__dgn.up()");

  const pct = (s) => Number(String(s).replace("%", ""));
  const lefts = dSteps.map((s) => pct(s.left));
  const widths = dSteps.map((s) => String(s.width));
  const tops = dSteps.map((s) => s.scrollTop);
  const idxs = dSteps.map((s) => (s.first ? s.first.idx : -1));
  const mono = (a) => a.every((v, i) => i === 0 || v >= a[i - 1]);
  lines.push("  拖动现场：轴宽 " + Math.round(dBox.w) + "px 的滑窗带（矩形 " + Math.round(dBox.left) + "–" + Math.round(dBox.left + dBox.w) + "px）· 起点 " + d0.left + " / " + d0.width + " · 视窗 " + (d0.bandAt != null ? d0.bandAt + "–" + d0.bandEnd + "ms" : "无") + " · 列表 scrollTop " + d0.scrollTop + " · 首可见行 #" + (d0.first ? d0.first.idx + " " + d0.first.kind + " " + d0.first.tick : "无") + " · 共 " + d0.vis + " 行在视窗里");
  for (let i = 0; i < DRAG_DX.length; i++) {
    const s = dSteps[i];
    lines.push(
      "    Δx=+" + DRAG_DX[i] + "px → window " + s.left + " / " + s.width + " · 窗 " + (s.bandAt != null ? s.bandAt + "–" + s.bandEnd + "ms" : "无") +
        " · scrollTop " + s.scrollTop + " · 首可见行 #" + (s.first ? s.first.idx + " " + s.first.kind + " " + s.first.tick : "无") +
        " · .dragging " + (s.bandDragging && s.rulerDragging ? "轴+带" : "无") + " · 光标「" + s.rulerCursor + "」· 带 pointer-events " + s.bandPE,
    );
  }
  lines.push("  拖动中读数：「" + dSteps[dSteps.length - 1].scale + "」");
  ok(
    widths.every((v) => v === String(d0.width)) && String(dUp.width) === String(d0.width),
    "[23] 拖的是「看哪一段」不是「改窗长」：window 宽全程不变 " + d0.width + "（逐帧 " + widths.join(" / ") + "）",
  );
  ok(
    mono(lefts) && lefts[lefts.length - 1] > lefts[0],
    "[23] window left 随 Δx 单调右移：" + lefts.map((v) => v.toFixed(3) + "%").join(" → ") + "（Δx +8 → +" + DRAG_DX[DRAG_DX.length - 1] + "px）",
  );
  ok(
    mono(tops) && tops[tops.length - 1] > tops[0] && mono(idxs) && idxs[idxs.length - 1] > idxs[0],
    "[23] 下方列表跟着窗中点滚：scrollTop " + tops.join(" → ") + " · 首可见行 #" + idxs.join(" → #"),
  );
  ok(
    d0.bandDragging === false && d0.rulerDragging === false && d0.rulerCursor === "" && d0.bandPE === "none" &&
      dDown.debug.dragPend === true && dDown.debug.dragOn === false && dDown.bandDragging === false &&
      dSteps.every((s) => s.bandDragging && s.rulerDragging && s.rulerCursor === "grabbing" && s.bandPE === "auto"),
    "[23] 按下只记候选（未过阈值不进拖动态），位移过阈值才挂 .dragging + 光标 grabbing + 带改吃指针：按下时 dragPend=" +
      dDown.debug.dragPend + " / dragOn=" + dDown.debug.dragOn + " / .dragging " + (dDown.bandDragging ? "有" : "无") +
      "；六帧拖动中轴与带都挂着 .dragging、光标「grabbing」、带 pointer-events=auto",
  );
  ok(
    dUp.debug.dragOn === false && dUp.debug.dragPend === false && dUp.debug.dragWin === null &&
      dUp.bandDragging === false && dUp.rulerDragging === false && dUp.rulerCursor === "" && dUp.bandPE === "none",
    "[23] 松开即收：dragOn=false / dragPend=false / dragWin=null，轴与带的 .dragging 摘掉、光标归空、带回 pointer-events=none（读数也回到常规那一份：「" + dUp.scale + "」）",
  );

  /* 出口一：**拖动中**按 Esc = 当场收掉在拖的那一次（回全轴那一帧顺带结束拖动）。 */
  const dDown2 = await call(c, "window.__dgn.down()");
  const dMove2 = await call(c, "window.__dgn.move(48)");
  const dEsc = await call(c, "window.__dgn.esc()");
  const dUp2 = await call(c, "window.__dgn.up()");
  ok(
    dMove2.bandDragging && dMove2.debug.dragOn === true && dMove2.debug.dragPend === true &&
      dEsc.bandDragging === false && dEsc.rulerDragging === false && dEsc.rulerCursor === "" &&
      dEsc.debug.dragOn === false && dEsc.debug.dragPend === false && dEsc.debug.dragWin === null,
    "[23] 拖动中按 Esc 当场收掉在拖的那一次：拖动帧 dragOn=true / dragPend=true，按 Esc 后 dragOn=false / dragPend=false / dragWin=null、.dragging 摘掉、光标归空（松手不再有任何收尾动作：dragPend=" + dUp2.debug.dragPend + "）",
  );

  /* 出口二：松开后按 Esc = 回全轴（缩放窗归零，轴上块几何逐值回到未缩放那一份）。 */
  const zIn = await call(c, "window.__mtn.wheel(0.5, -240)");
  const zSnap = await call(c, "window.__dgn.snap()");
  const zEsc = await call(c, "window.__dgn.esc()");
  ok(
    zSnap.debug.zoomLo != null && zSnap.debug.zoomHi != null &&
      zEsc.debug.zoomLo == null && zEsc.debug.zoomHi == null &&
      zEsc.marks.join("|") === d0.marks.join("|"),
    "[22]/[23] 松开后按 Esc 复位（回全轴）：缩放窗 " +
      (zSnap.debug.zoomLo != null ? Math.round(zSnap.debug.zoomLo) + "–" + Math.round(zSnap.debug.zoomHi) + "ms" : "无") +
      " → Esc 后 zoomLo/zoomHi=null、读数的「缩放 N×」摘掉、轴上 " + zEsc.marks.length + " 个块逐值回到全轴那一份（" + zEsc.scale + "）",
  );

  console.log(lines.join("\n"));

  /* 截图前把页面摆成「一眼看得出缩放」的样子：滚到链路中段再拉近两档
     （截图是给人复核的，停在尾部那种「带比轴还宽」的状态看不出细节）。 */
  await call(c, "window.__mtn.resetZoom(); window.__mtn.scroll(64)");
  await call(c, "window.__mtn.wheel(0.5, -240)");
  await call(c, "window.__mtn.wheel(0.5, -240)");
  const shotState = await call(c, "window.__mtn.snap()");
  console.log(
    "（截图状态：缩放窗 " +
      (shotState.debug.zoomLo != null
        ? Math.round(shotState.debug.zoomLo) + "–" + Math.round(shotState.debug.zoomHi) + "ms"
        : "全轴") +
      " · 读数「" +
      shotState.scale +
      "」）",
  );

  const shot = await c.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
  if (shot && shot.result && shot.result.data) {
    fs.writeFileSync(SHOT, Buffer.from(shot.result.data, "base64"));
    console.log("\n截图已落盘：" + SHOT + "（" + fs.statSync(SHOT).size + " 字节）");
  } else {
    console.error("\n截图失败：" + JSON.stringify(shot).slice(0, 300));
  }
  /* 拖动那张证据截图是**按住那一帧**拍的（带挂 .dragging、读数写着「拖动中 · 窗 起–止」） */
  if (dragShotMsg) console.log("拖动中截图：" + dragShotMsg);
  c.close();
  console.log(fails ? "\n✗ " + fails + " 项失败" : "\n✓ 真浏览器复核通过");
  process.exit(fails ? 1 : 0);
})();
