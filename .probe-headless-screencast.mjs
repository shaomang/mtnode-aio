/**
 * 一次性只读探针（不入库、不随包、用完删）：复刻 dsh/gateway/browser-host.mjs 的 launchArgs，
 * 分别以 --headless=new 与「带窗口 + 移出可视区」两种形态起 Edge，打 CDP Page.startScreencast，
 * 数 6 秒内真到几帧。用来判定「会话右栏实况无画面」到底是「无窗口那只不出帧」还是「通路没接上」。
 *
 * 用法：node .probe-headless-screencast.mjs [headless|windowed|both]
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const EXE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const MODE = String(process.argv[2] || "both");

function pickFreePort() {
  return new Promise((resolve) => {
    import("node:net").then(({ default: net }) => {
      const srv = net.createServer();
      srv.once("error", () => resolve(0));
      srv.listen(0, "127.0.0.1", () => {
        const p = srv.address().port;
        srv.close(() => resolve(p));
      });
    });
  });
}

async function fetchJson(url, timeoutMs) {
  const ctl = new AbortController();
  const to = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctl.signal });
    return await r.json();
  } finally { clearTimeout(to); }
}

class Cdp {
  constructor(wsUrl) { this.wsUrl = wsUrl; this.id = 0; this.pending = new Map(); this.handlers = []; }
  open() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl);
      this.ws = ws;
      ws.onopen = () => resolve(this);
      ws.onerror = (e) => reject(new Error("ws error " + String(e && e.message || e)));
      ws.onmessage = (ev) => {
        let m = null;
        try { m = JSON.parse(String(ev.data)); } catch { return; }
        if (m.id && this.pending.has(m.id)) {
          const { res, rej, to } = this.pending.get(m.id);
          this.pending.delete(m.id);
          clearTimeout(to);
          m.error ? rej(new Error(m.error.message || JSON.stringify(m.error))) : res(m.result);
          return;
        }
        for (const h of this.handlers) { try { h(m); } catch {} }
      };
      ws.onclose = () => { for (const { rej, to } of this.pending.values()) { clearTimeout(to); rej(new Error("ws closed")); } this.pending.clear(); };
    });
  }
  send(method, params, timeoutMs) {
    const id = ++this.id;
    const msg = JSON.stringify({ id, method, params: params || {} });
    return new Promise((res, rej) => {
      const to = setTimeout(() => { this.pending.delete(id); rej(new Error("timeout " + method)); }, timeoutMs || 8000);
      this.pending.set(id, { res, rej, to });
      try { this.ws.send(msg); } catch (e) { clearTimeout(to); this.pending.delete(id); rej(e); }
    });
  }
  on(fn) { this.handlers.push(fn); return () => { this.handlers = this.handlers.filter((x) => x !== fn); }; }
  close() { try { this.ws.close(); } catch {} }
}

function launchArgs(profileDir, port, headless) {
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-features=Translate,OptimizationHints,CalculateNativeWinOcclusion",
    "--disable-backgrounding-occluded-windows",
    "--disable-sync",
    "--password-store=basic",
    "about:blank",
  ];
  if (headless) args.unshift("--headless=new");
  return args;
}

async function waitDebugPort(port, deadlineMs) {
  const end = Date.now() + deadlineMs;
  let last = "";
  while (Date.now() < end) {
    try {
      const v = await fetchJson(`http://127.0.0.1:${port}/json/version`, 1500);
      if (v && v.webSocketDebuggerUrl) return v;
      last = "no webSocketDebuggerUrl";
    } catch (e) { last = String((e && e.message) || e); }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("debug port not up: " + last);
}

async function findPage(browserWsUrl) {
  const bws = await new Cdp(browserWsUrl).open();
  try {
    const { targetInfos } = await bws.send("Target.getTargets", {}, 8000);
    const pages = (targetInfos || []).filter((t) => t && t.type === "page" && !String(t.url || "").startsWith("devtools://"));
    let target = pages.find((t) => /^https?:/.test(String(t.url || ""))) || pages[0];
    if (!target) {
      const c = await bws.send("Target.createTarget", { url: "about:blank" }, 8000);
      target = { targetId: c.targetId };
    }
    const list = await fetchJson(`http://127.0.0.1:${port}/json/list`, 4000).catch(() => []);
    const hit = (Array.isArray(list) ? list : []).find((t) => t && t.id === target.targetId);
    return { targetId: target.targetId, wsUrl: (hit && hit.webSocketDebuggerUrl) || "" };
  } finally { bws.close(); }
}

let port = 0;

async function runOne(mode) {
  const headless = mode === "headless";
  const profileDir = path.join(os.tmpdir(), "mtnode-probe-profile-" + mode + "-" + Date.now().toString(36));
  fs.mkdirSync(profileDir, { recursive: true });
  port = await pickFreePort();
  if (!port) port = 9300 + Math.floor(Math.random() * 90);
  const started = Date.now();
  const proc = spawn(EXE, launchArgs(profileDir, port, headless), { stdio: "ignore", windowsHide: headless });
  const out = { mode, headless, port, profileDir, frames: 0, firstFrameMs: null, errors: [], argvHasHeadless: false, parked: null };
  try {
    const ver = await waitDebugPort(port, 12000);
    out.debugReadyMs = Date.now() - started;
    const page = await findPage(ver.webSocketDebuggerUrl);
    if (!page.wsUrl) throw new Error("no page ws url");
    const cdp = await new Cdp(page.wsUrl).open();
    try {
      await cdp.send("Page.enable", {}, 6000);
      const sub = cdp.on((m) => {
        if (!m || m.method !== "Page.screencastFrame") return;
        out.frames += 1;
        if (out.firstFrameMs == null) out.firstFrameMs = Date.now() - started;
        const meta = (m.params && m.params.metadata) || {};
        out.lastMeta = { w: meta.deviceWidth, h: meta.deviceHeight, ts: meta.timestamp };
        cdp.send("Page.screencastFrameAck", { sessionId: m.params.sessionId }, 3000).catch(() => {});
      });
      await cdp.send("Page.startScreencast", { format: "jpeg", quality: 90, maxWidth: 2560, maxHeight: 1600, everyNthFrame: 1 }, 8000);
      const url = "data:text/html," + encodeURIComponent(
        "<body style='margin:0;background:#123456'><div id=x style='width:600px;height:300px;background:#e0b000;color:#fff;font:28px sans-serif'>probe</div>" +
        "<script>let n=0;setInterval(()=>{n++;document.getElementById('x').style.background=(n%2?'#e0b000':'#00806a');document.getElementById('x').textContent='probe '+n;},250)</script></body>",
      );
      await cdp.send("Page.navigate", { url }, 8000).catch((e) => out.errors.push("navigate: " + e.message));
      /* 移屏：带窗口那只复刻 parkSessionWindow 的落点 */
      if (!headless) {
        try {
          const bws = await new Cdp(ver.webSocketDebuggerUrl).open();
          const { windowId } = await bws.send("Browser.getWindowForTarget", { targetId: page.targetId }, 4000);
          out.windowId = windowId || 0;
          const r = await bws.send("Browser.setWindowBounds", { windowId, bounds: { left: -2400, top: -2400, width: 1280, height: 860, windowState: "normal" } }, 4000).then(() => true).catch((e) => "err:" + e.message);
          out.parked = r;
          bws.close();
        } catch (e) { out.errors.push("park: " + e.message); }
      }
      await new Promise((r) => setTimeout(r, 6000));
      out.framesAfter6s = out.frames;
      /* 再探一次：静置 6 秒后加一次显式重绘（reload），看是不是「只有变化才出帧」 */
      await cdp.send("Runtime.evaluate", { expression: "document.title='x'+Date.now()" }, 4000).catch(() => {});
      await new Promise((r) => setTimeout(r, 2000));
      out.framesAfter8s = out.frames;
      sub();
      await cdp.send("Page.stopScreencast", {}, 4000).catch(() => {});
    } finally { cdp.close(); }
  } catch (e) {
    out.fatal = String((e && e.message) || e);
  } finally {
    try { proc.kill(); } catch {}
    await new Promise((r) => setTimeout(r, 800));
    try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch {}
  }
  return out;
}

const modes = MODE === "both" ? ["headless", "windowed"] : [MODE];
const results = [];
for (const m of modes) results.push(await runOne(m));
console.log(JSON.stringify(results, null, 2));
