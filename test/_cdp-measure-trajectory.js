/* 临时：用真浏览器（CDP 9222 · 预览页 8799）把本轮改动的几何与配色量一遍，并留截图。
   跑完即删（证据：命令行输出 + 落盘截图）。
   用法：node test/_cdp-measure-trajectory.js
*/
"use strict";
const fs = require("fs");
const PORT = 9222;
const SHOT = "E:\\dev\\tools\\pipeline-console\\test\\_tmp-trajectory-round2.png";

const EXPR = String.raw`(() => {
  const byId = (id) => document.getElementById(id);
  const box = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return {
      w: Math.round(r.width), h: Math.round(r.height),
      top: Math.round(r.top), bottom: Math.round(r.bottom),
      display: cs.display, overflow: cs.overflow,
      color: cs.color, background: cs.backgroundColor, boxShadow: cs.boxShadow,
      borderLeft: cs.borderLeftWidth + " " + cs.borderLeftStyle + " " + cs.borderLeftColor,
    };
  };
  const out = { viewport: window.innerWidth + "x" + window.innerHeight };
  const cs0 = getComputedStyle(document.documentElement);
  out.tokens = {
    rulerH: cs0.getPropertyValue("--dsh-trace-ruler-h").trim(),
    trackH: cs0.getPropertyValue("--dsh-trace-track-h").trim(),
    rowH: cs0.getPropertyValue("--dsh-trace-row-h").trim(),
    tickW: cs0.getPropertyValue("--dsh-trace-tick-w").trim(),
    cyan: cs0.getPropertyValue("--cyan").trim(),
    green: cs0.getPropertyValue("--green").trim(),
  };

  /* ① 轴：高度账（内容 vs 内容框）+ 图例是否被裁 + 方块尺寸 */
  const ruler = byId("rulerA");
  const rulerBox = box(ruler);
  const csr = getComputedStyle(ruler);
  const inner = rulerBox.h - parseFloat(csr.paddingTop) - parseFloat(csr.paddingBottom)
    - parseFloat(csr.borderTopWidth) - parseFloat(csr.borderBottomWidth);
  const ticks = ruler.querySelector(".dsh-trace-ruler-ticks");
  const tracks = byId("bandsA");
  const scale = byId("scaleA");
  const leg = byId("legA");
  const contentH = [ticks, tracks, scale, leg].reduce((n, el) => n + (el ? el.getBoundingClientRect().height : 0), 0);
  const mark = ruler.querySelector('.dsh-trace-mark[data-mk="m0"]');
  const markBox = box(mark);
  out.axis = {
    ruler: rulerBox,
    padding: csr.padding, border: csr.borderTopWidth,
    innerH: Math.round(inner), contentH: Math.round(contentH),
    legendClipped: Math.round(leg.getBoundingClientRect().bottom) > Math.round(ruler.getBoundingClientRect().bottom) + 0.5,
    legendBottomVsRulerBottom: Math.round(leg.getBoundingClientRect().bottom - ruler.getBoundingClientRect().bottom),
    legendInsideOverflow: csr.overflow,
    ticks: box(ticks), tracks: box(tracks), scale: box(scale), legend: box(leg),
    trackCount: tracks.querySelectorAll(".dsh-trace-track").length,
    mark: markBox,
    band: box(byId("bandA")),
    legendItems: leg.querySelectorAll(".dsh-trace-legend-item").length,
    axisIsFirstChild: byId("mainA").children[0] === ruler,
    barPresent: !!document.querySelector(".dsh-trace-bar"),
    searchPresent: !!document.querySelector(".dsh-trace-search"),
  };

  /* ② 行：段型皮肤（左轨 / 底色 / 字色）+ 读数栏 token 两段颜色 */
  const rowOf = (sel) => document.querySelector(sel);
  const rows = Array.from(byId("spacerA").querySelectorAll(".dsh-trace-row"));
  out.rows = rows.map((r) => {
    const tick = r.querySelector(".dsh-trace-tick");
    const tokIn = r.querySelector(".dsh-tok-in");
    const tokOut = r.querySelector(".dsh-tok-out");
    return {
      cls: r.className,
      row: box(r),
      color: getComputedStyle(r).color,
      background: getComputedStyle(r).backgroundColor,
      shadow: getComputedStyle(r).boxShadow,
      tick: box(tick),
      tokIn: tokIn ? { text: tokIn.textContent, color: getComputedStyle(tokIn).color } : null,
      tokOut: tokOut ? { text: tokOut.textContent, color: getComputedStyle(tokOut).color } : null,
      expandBtn: !!r.querySelector(".dsh-trace-expand"),
      onelineText: (r.querySelector(".dsh-trace-oneline") || {}).textContent || "",
    };
  });
  const toolName = rowOf(".dsh-trace-tool-name");
  out.toolNameColor = toolName ? getComputedStyle(toolName).color : null;
  /* 长内容是否真的截断（省略号）：scrollWidth > clientWidth */
  const one = rowOf(".dsh-trace-oneline");
  out.ellipsis = one ? { scrollW: one.scrollWidth, clientW: one.clientWidth, clipped: one.scrollWidth > one.clientWidth + 1 } : null;

  /* ③ 检查器铺满高 + 参数/结果块弹性 + token 两段颜色 */
  const cols = byId("colsA");
  const insp = byId("inspA");
  const code1 = byId("codeA1");
  const code2 = byId("codeA2");
  const meta = byId("inspMetaA");
  const mIn = meta.querySelector(".dsh-tok-in");
  const mOut = meta.querySelector(".dsh-tok-out");
  out.inspector = {
    cols: box(cols), colsRule: { flex: getComputedStyle(cols).flex, maxHeight: getComputedStyle(cols).maxHeight },
    insp: box(insp),
    mainBottom: Math.round(byId("mainA").getBoundingClientRect().bottom),
    footTop: Math.round(byId("footA").getBoundingClientRect().top),
    gapUnderCode2: Math.round(insp.getBoundingClientRect().bottom - code2.getBoundingClientRect().bottom),
    code1: box(code1), code2: box(code2),
    codeMaxHeight: getComputedStyle(code2).maxHeight,
    codeFlex: getComputedStyle(code2).flex,
    tokIn: mIn ? { text: mIn.textContent, color: getComputedStyle(mIn).color } : null,
    tokOut: mOut ? { text: mOut.textContent, color: getComputedStyle(mOut).color } : null,
  };

  /* ④ Token 报告：摘要行与表格两列的颜色 */
  const sum = byId("badgeSumB");
  const sIn = sum.querySelector(".dsh-tok-in");
  const sOut = sum.querySelector(".dsh-tok-out");
  const tds = document.querySelectorAll("#badgeB .tok-badge-table .dsh-tok-in");
  const tdo = document.querySelectorAll("#badgeB .tok-badge-table .dsh-tok-out");
  const cIn = tds[0] ? getComputedStyle(tds[0]).color : null;
  const cOut = tdo[0] ? getComputedStyle(tdo[0]).color : null;
  out.tokBadge = {
    sum: sum.textContent,
    sumIn: sIn ? { text: sIn.textContent, color: getComputedStyle(sIn).color } : null,
    sumOut: sOut ? { text: sOut.textContent, color: getComputedStyle(sOut).color } : null,
    tableInCount: tds.length, tableOutCount: tdo.length, tableInColor: cIn, tableOutColor: cOut,
  };
  /* ⑤ 本轮两条需求：轴上「运行中」块**不闪**（无 animation / 静态描边 + 柔光），
     以及轴身滚轮横向拉伸（锚点局部拉近 → 块变宽 → resetZoom 回全轴）。 */
  const runMark = document.querySelector('.dsh-trace-mark.run');
  const csRun = runMark ? getComputedStyle(runMark) : null;
  const markGeom = () =>
    Array.from(ruler.querySelectorAll(".dsh-trace-mark")).map((m) => m.style.left + "/" + m.style.width);
  const tickGeom = () =>
    Array.from(ruler.querySelectorAll(".dsh-trace-ruler-tick")).map((t) => t.textContent).join("|");
  const before = { marks: markGeom(), ticks: tickGeom(), scale: scale.textContent };
  out.noBlink = {
    runPresent: !!runMark,
    animationName: csRun ? csRun.animationName : null,
    animationDuration: csRun ? csRun.animationDuration : null,
    boxShadow: csRun ? csRun.boxShadow : null,
    borderColor: csRun ? csRun.borderTopColor : null,
    /* 整个轴里不许有任何还带 animation-name 的东西 */
    animatedInAxis: Array.from(ruler.querySelectorAll("*")).filter(
      (el) => getComputedStyle(el).animationName !== "none",
    ).length,
  };
  const rbox = ruler.getBoundingClientRect();
  /* 真滚轮事件：从轴左缘 25% 处往下滚（deltaY = -240 → 拉近），锚点取指针位置 */
  ruler.dispatchEvent(
    new WheelEvent("wheel", {
      deltaY: -240,
      clientX: rbox.left + rbox.width * 0.25,
      clientY: rbox.top + rbox.height / 2,
      bubbles: true,
      cancelable: true,
    }),
  );
  const zoomed = { marks: markGeom(), ticks: tickGeom(), scale: scale.textContent, band: box(byId("bandA")) };
  /* 双击轴 = 回全轴 */
  ruler.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
  const reset = { marks: markGeom(), ticks: tickGeom(), scale: scale.textContent };
  out.zoom = {
    before,
    zoomed,
    reset,
    zoomedWider: (() => {
      const a = Number(String(before.marks[0] || "").split("/")[1].replace("%", ""));
      const b = Number(String(zoomed.marks[0] || "").split("/")[1].replace("%", ""));
      return b > a;
    })(),
    backToFull: reset.marks.join("|") === before.marks.join("|") && reset.ticks === before.ticks,
  };
  return JSON.stringify(out);
})()`;

function cdp(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const pending = new Map();
    ws.onopen = () => resolve({
      send(method, params) {
        const mid = ++id;
        return new Promise((res) => { pending.set(mid, res); ws.send(JSON.stringify({ id: mid, method, params })); });
      },
      close: () => ws.close(),
    });
    ws.onerror = (e) => reject(new Error("WS 失败：" + (e && e.message)));
    ws.onmessage = (ev) => {
      let m = null;
      try { m = JSON.parse(String(ev.data)); } catch { return; }
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    };
  });
}

(async () => {
  const list = await (await fetch("http://127.0.0.1:" + PORT + "/json/list")).json();
  const page = list.find((t) => t.type === "page" && /_preview-trajectory-style\.html/.test(t.url || ""));
  if (!page) { console.error("没找到预览页：", list.map((t) => t.url).join(" | ")); process.exit(2); }
  const c = await cdp(page.webSocketDebuggerUrl);
  const em = await c.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  if (em && em.error) console.error("setDeviceMetricsOverride 失败：" + JSON.stringify(em.error));
  /* 每次都重新载入：量的是**当前**文件（改了 css / html 之后不必手动刷新页面） */
  await c.send("Page.enable", {});
  await c.send("Page.reload", { ignoreCache: true });
  await new Promise((r) => setTimeout(r, 1500));
  const r = await c.send("Runtime.evaluate", { expression: EXPR, returnByValue: true, awaitPromise: true });
  const res = r && r.result && r.result.result ? r.result.result : (r && r.result) || r || {};
  if (res.exceptionDetails) console.error("渲染层抛错：" + JSON.stringify(res.exceptionDetails).slice(0, 600));
  const data = typeof res.value === "string" ? JSON.parse(res.value) : res.value;
  console.log(JSON.stringify(data, null, 2));
  const shot = await c.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
  if (shot && shot.result && shot.result.data) {
    fs.writeFileSync(SHOT, Buffer.from(shot.result.data, "base64"));
    console.log("\n截图已落盘：" + SHOT + "（" + fs.statSync(SHOT).size + " 字节）");
  } else {
    console.error("\n截图失败：" + JSON.stringify(shot).slice(0, 300));
  }
  c.close();
  process.exit(0);
})();
