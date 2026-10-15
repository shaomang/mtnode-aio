/**
 * 一次性只读探针 #2（不入库、不随包、用完删）：直接跑**产品真代码**
 * dsh/gateway/browser-host.mjs 的 ensureBrowser + startViewStream（不是复刻版），
 * 在隔离的 dsh-home 下量：
 *   · 无窗口那只真开流时到几帧 / 首帧多久 / 看门狗有没有误回落
 *   · stop → start 反复开关（用户点「重试」那条路）是否还能再出帧
 * 用法：node .probe-real-viewstream.mjs [headless|windowed|both]
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  profileDirOf, downloadDirOf, ensureBrowser, startViewStream, stopViewStream,
  setViewMode, viewStatus, statusOf, stopBrowser, registerViewSink, setDownloadDir,
} from "./dsh/gateway/browser-host.mjs";

const MODE = String(process.argv[2] || "headless");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function runOne(mode) {
  const base = path.join(os.tmpdir(), "mtnode-probe2-" + mode + "-" + Date.now().toString(36));
  fs.mkdirSync(base, { recursive: true });
  const dshHome = path.join(base, "dsh-home");
  fs.mkdirSync(dshHome, { recursive: true });
  const out = { mode, frames: 0, events: [], seqs: [], status: null, errs: [] };
  const sink = (f) => {
    if (f && f.event) out.events.push({ at: Date.now(), event: f.event, reason: f.reason || "", fallback: !!f.fallback });
    if (f && Number(f.seq) > 0 && f.frame) {
      out.frames += 1;
      out.seqs.push(f.seq);
      if (out.firstFrameMs == null) out.firstFrameMs = Date.now() - out.t0;
      /* 校验「裸 base64 JPEG」这条契约（渲染层直接补 dataURL 解码） */
      if (out.jpegOk == null) out.jpegOk = /^\/9j/.test(String(f.frame)) && String(f.frame).length > 500;
      out.lastLen = String(f.frame).length;
      out.lastMeta = { w: f.w, h: f.h, dpr: f.dpr };
    }
  };
  registerViewSink(sink);
  try {
    out.t0 = Date.now();
    const r = await ensureBrowser({ profileDir: profileDirOf(dshHome), dshHome, visible: mode === "windowed" });
    out.ensure = { reused: !!r.reused, headless: !!r.headless, port: r.port, exe: String(r.exe || "").slice(-40) };
    try { await setDownloadDir(downloadDirOf(dshHome)); } catch {}
    out.statusAfterEnsure = { headless: statusOf().headless, running: !!statusOf().running };
    /* 第 1 轮：开流 3 秒 */
    const v1 = await startViewStream({});
    out.start1 = { ok: v1.ok !== false, on: v1.on, mode: v1.mode, parked: v1.parked, headless: v1.headless, reason: v1.reason || "" };
    await wait(3000);
    out.framesAfter3s = out.frames;
    out.eventsAfter3s = out.events.slice();
    /* 第 2 轮：关流再开（= 用户点「重试」） */
    await stopViewStream();
    await wait(400);
    const before = out.frames;
    const v2 = await startViewStream({});
    await wait(3000);
    out.restartFrames = out.frames - before;
    out.start2 = { ok: v2.ok !== false, on: v2.on, mode: v2.mode, parked: v2.parked };
    /* 第 3 轮：显式 docked（真窗口拖回来）再开一次 */
    const vm = await setViewMode("docked");
    out.modeDocked = { ok: vm.ok !== false, mode: vm.mode, parked: vm.parked, reason: vm.reason || "" };
    await wait(1500);
    out.totalFrames = out.frames;
    out.viewStatus = viewStatus();
  } catch (e) {
    out.fatal = String((e && e.stack) || (e && e.message) || e);
  } finally {
    try { await stopViewStream(); } catch {}
    try { await stopBrowser({ silent: true }); } catch {}
    await wait(600);
    try { fs.rmSync(base, { recursive: true, force: true }); } catch {}
  }
  return out;
}

const modes = MODE === "both" ? ["headless", "windowed"] : [MODE];
const res = [];
for (const m of modes) res.push(await runOne(m));
console.log(JSON.stringify(res, null, 2));
process.exit(0);
