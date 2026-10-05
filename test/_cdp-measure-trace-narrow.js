/* 临时：真浏览器（CDP 9222 · 预览页 8799）量本轮两条需求 ——
   [1] 轨迹主内容缩窄：.dsh-trace-cols / .dsh-trace-foot 封顶 980px 并居中，
       顶部横轴保持整宽但绘图区左右缘与列表对齐（量绘图区与列表的左/右缘差）；
   [2] 左侧读数栏（时刻 · 耗时 · 每步 token）文字不再被裁：量 .dsh-trace-tick 的
       clientWidth / scrollWidth 与每个子读数的实际位置（有没有互相压 / 被右缘切）。
   三个视口各量一遍（1400 = 完整三项 / 1100 = 仍完整 / 950 = 已收 token），并落一张截图。
   跑完即删（证据：命令行输出 + 落盘截图）。
   用法：node test/_cdp-measure-trace-narrow.js
*/
"use strict";
const fs = require("fs");
const PORT = 9222;
const SHOT = "E:\\dev\\tools\\pipeline-console\\test\\_tmp-trace-narrow.png";
const PAGE = /_preview-trajectory-interactive\.html/;

const EXPR = String.raw`(() => {
  const q = (s, r) => (r || document).querySelector(s);
  const rect = (el) => { if (!el) return null; const r = el.getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height), left: Math.round(r.left), right: Math.round(r.right) }; };
  const tokText = { in: "↑182k（新增 12.3k）", out: "↓12.3k", dur: "1234ms", at: "12:34:56" };
  const list = q(".dsh-trace-list");
  const cols = q(".dsh-trace-cols");
  const foot = q(".dsh-trace-foot");
  const plot = q(".dsh-trace-ruler-plot");
  const ruler = q(".dsh-trace-ruler");
  const main = q(".dsh-trace-main");
  /* 把第一行（工具行）的读数栏灌成**最宽的真实值**，再量它装不装得下。
     token 那一段按真模块的 DOM 口径现建（.dsh-trace-tick-tok = dsh-tok 容器 +
     .dsh-tok-in（自带 .dsh-tok-new 子 span）+ .dsh-tok-out），不另造一套类名。 */
  const row = q(".dsh-trace-row.t-tool");
  const tick = row ? q(".dsh-trace-tick", row) : null;
  let tickM = null;
  if (tick) {
    const at = q(".dsh-trace-tick-at", tick);
    const dur = q(".dsh-trace-tick-dur", tick);
    if (at) at.textContent = tokText.at;
    if (dur) dur.textContent = tokText.dur;
    const tok = document.createElement("span");
    tok.className = "dsh-trace-tick-tok dsh-tok";
    const up = document.createElement("span");
    up.className = "dsh-tok-in";
    up.textContent = "↑182k";
    const nn = document.createElement("span");
    nn.className = "dsh-tok-new";
    nn.textContent = "（新增 12.3k）";
    up.appendChild(nn);
    const dn = document.createElement("span");
    dn.className = "dsh-tok-out";
    dn.textContent = tokText.out;
    tok.appendChild(up);
    tok.appendChild(dn);
    tick.appendChild(tok);
    const cs = getComputedStyle(tick);
    tickM = {
      text: String(tick.textContent),
      clientW: tick.clientWidth, scrollW: tick.scrollWidth,
      clippedPx: Math.max(0, tick.scrollWidth - tick.clientWidth),
      box: rect(tick), overflow: cs.overflow, whiteSpace: cs.whiteSpace,
      parts: [at, dur, tok].map((el) => el ? { cls: el.className.split(" ")[0], box: rect(el), scrollW: el.scrollWidth, clientW: el.clientWidth } : null),
      tokParts: Array.from(tok.children).map((el) => ({ cls: el.className, box: rect(el) })),
      /* 三个读数之间有没有互相压：后一件的左缘 < 前一件的右缘 = 重叠。
         hidden 的那两栏（收列后 display:none）矩形是 0×0、左缘 0 —— 不参与判定。 */
      overlaps: (() => {
        const b = [at, dur, tok].filter((el) => el && el.getBoundingClientRect().width > 0).map((el) => rect(el));
        const bad = [];
        for (let i = 1; i < b.length; i++) if (b[i].left < b[i - 1].right) bad.push(i);
        return bad;
      })(),
      /* 读数栏右缘有没有切到内容（最后一个子件的右缘超出读数栏右缘 = 被裁） */
      lastRightOver: (() => {
        const b = [at, dur, tok].filter(Boolean).map((el) => rect(el));
        const last = b[b.length - 1];
        const tb = rect(tick);
        return last && tb ? Math.round(last.right - tb.right) : null;
      })(),
    };
  }
  const cs0 = getComputedStyle(document.documentElement);
  /* 选中第一行：检查器露出来（真应用里点行即可），量「窄主内容 + 检查器 340」时列表还剩多宽 */
  if (row) row.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  return JSON.stringify({
    viewport: window.innerWidth + "x" + window.innerHeight,
    tokens: {
      tickW: cs0.getPropertyValue("--dsh-trace-tick-w").trim(),
      contentW: cs0.getPropertyValue("--dsh-trace-content-w").trim(),
      rowH: cs0.getPropertyValue("--dsh-trace-row-h").trim(),
    },
    main: rect(main),
    cols: Object.assign(rect(cols) || {}, { maxWidth: cols ? getComputedStyle(cols).maxWidth : null, margin: cols ? getComputedStyle(cols).marginLeft : null }),
    list: rect(list),
    insp: rect(q(".dsh-trace-insp:not([hidden])")) || rect(q(".dsh-trace-insp")),
    foot: Object.assign(rect(foot) || {}, { maxWidth: foot ? getComputedStyle(foot).maxWidth : null }),
    ruler: rect(ruler),
    plot: rect(plot),
    plotVsList: plot && list ? { leftDiff: Math.round(plot.left - list.left), rightDiff: Math.round((plot.right - list.right)) } : null,
    rulerPadding: ruler ? getComputedStyle(ruler).paddingLeft + " / " + getComputedStyle(ruler).paddingRight : null,
    /* 行栅格第一列的实际宽（= --dsh-trace-tick-w 解析值） */
    rowGrid: row ? getComputedStyle(row).gridTemplateColumns : null,
    tick: tickM,
    /* 检查器可见时列表还剩多少——确认窄主内容下正文不会被挤死 */
    bodyW: row ? rect(q(".dsh-trace-body", row)) : null,
  });
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
  let page = list.find((t) => t.type === "page" && PAGE.test(t.url || ""));
  if (!page) {
    page = list.find((t) => t.type === "page");
    if (!page) { console.error("没有可用页面：", JSON.stringify(list).slice(0, 300)); process.exit(2); }
  }
  const c = await cdp(page.webSocketDebuggerUrl);
  await c.send("Page.enable", {});
  for (const w of [1400, 1100, 950]) {
    await c.send("Emulation.setDeviceMetricsOverride", { width: w, height: 900, deviceScaleFactor: 1, mobile: false });
    await c.send("Page.navigate", { url: "http://127.0.0.1:8799/test/_preview-trajectory-interactive.html" });
    await new Promise((r) => setTimeout(r, 1600));
    const r = await c.send("Runtime.evaluate", { expression: EXPR, returnByValue: true, awaitPromise: true });
    const res = r && r.result && r.result.result ? r.result.result : (r && r.result) || r || {};
    if (res.exceptionDetails) console.error("渲染层抛错：" + JSON.stringify(res.exceptionDetails).slice(0, 600));
    const data = typeof res.value === "string" ? JSON.parse(res.value) : res.value;
    console.log("\n===== 视口 " + w + "px =====");
    console.log(JSON.stringify(data, null, 2));
  }
  await c.send("Emulation.setDeviceMetricsOverride", { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
  await c.send("Page.navigate", { url: "http://127.0.0.1:8799/test/_preview-trajectory-interactive.html" });
  await new Promise((r) => setTimeout(r, 1600));
  const shot = await c.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
  if (shot && shot.result && shot.result.data) {
    fs.writeFileSync(SHOT, Buffer.from(shot.result.data, "base64"));
    console.log("\n截图已落盘：" + SHOT + "（" + fs.statSync(SHOT).size + " 字节）");
  }
  c.close();
  process.exit(0);
})();
