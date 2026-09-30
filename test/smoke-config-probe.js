/* 冒烟：宿主托管的设置在**真实运行时**里生效（端到端，跳过真模型对话）
 *
 * 为什么要这一条：0.2 把设置真源从 <DSH_HOME>/settings.yaml 搬到 profile 补丁层
 * （<DSH_HOME>/profiles/sdk/cordis.patch.yml）。只断言「宿主写了文件」不够 ——
 * 还得断言「运行时读到了」。本冒烟走真实链路：
 *   ① 起真网关（DSH_HOME = 临时目录）→ ② 发一轮 run（带服务商目录 + 官方模型清单 +
 *   权限预设 + 人设；key 是假的，网络请求会失败，但我们只关心装配）→ ③ 轮子在跑时
 *   调 gateway 的 configProbe 桥，让**运行时自己**把生效行表（id + config）报回来 →
 *   ④ 断言那四段确实抵达运行时。
 *
 * 跑法：node test/smoke-config-probe.js     （约 20–60s：真起一次运行时）
 */
"use strict";
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

let pass = 0;
let fail = 0;
function ok(cond, label) {
  if (cond) {
    pass++;
    console.log("  ✓ " + label);
  } else {
    fail++;
    console.log("  ✗ " + label);
  }
}

const GATEWAY = path.resolve(__dirname, "..", "dsh", "gateway", "gateway.mjs");

/* 与 dsh/smoke-gateway.mjs 同一套本地协议客户端（换行分隔 JSON）。 */
function connect(child) {
  let buf = "";
  const pending = new Map();
  const events = [];
  let id = 0;
  child.stdout.on("data", (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let m;
      try { m = JSON.parse(line); } catch { continue; }
      if (m.event) { events.push(m.event); continue; }
      if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    }
  });
  function req(method, params, timeoutMs = 60000) {
    return new Promise((resolve, reject) => {
      const rid = ++id;
      pending.set(rid, resolve);
      child.stdin.write(JSON.stringify({ id: rid, method, params }) + "\n");
      setTimeout(() => { if (pending.has(rid)) { pending.delete(rid); reject(new Error("timeout: " + method)); } }, timeoutMs);
    });
  }
  return { req, events };
}

(async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mtnode-probe-home-"));
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "mtnode-probe-ws-"));
  console.log("config-probe smoke — DSH_HOME=" + home);

  const child = spawn(process.execPath, [GATEWAY], {
    cwd: path.dirname(GATEWAY),
    env: { ...process.env, DSH_HOME: home },
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stderr.on("data", (d) => {
    const s = d.toString();
    if (/applySettings:|config-probe/.test(s)) process.stdout.write("[gw stderr] " + s.slice(0, 600));
  });
  const { req, events } = connect(child);

  try {
    const st = await req("status");
    /* 运行时的 bin 路径形态随网关依赖布局变：pnpm isolated = …/@deepseek-ai+dsh@0.2.0-rc.2/…，
       hoisted（本仓固定口径，见 smoke-gateway-packaging [1]）= …/@deepseek-ai/dsh/lib/bin.js
       —— 路径里没有版本号。所以认「bin 在盘上 + 它所属包的 manifest 版本 = 0.2.0-rc.2」，
       既不放过换版本，也不误报换布局。 */
    const runtimeBin = String((st && st.result && st.result.runtimeBin) || "");
    let dshVersion = "";
    try {
      dshVersion = String(JSON.parse(fs.readFileSync(path.join(path.dirname(runtimeBin), "..", "package.json"), "utf8")).version || "");
    } catch {
      /* 读不到 manifest = 下面判失败 */
    }
    ok(
      !!runtimeBin && fs.existsSync(runtimeBin) && dshVersion === "0.2.0-rc.2",
      "[1] 网关 status 指向 0.2.0-rc.2 运行时（bin 在盘上 + manifest 版本对上）",
    );

    const officialModels = [
      { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash", contextWindow: 131072, maxTokens: 8192, inputModalities: ["text", "image"] },
    ];
    /* 宿主托管的**服务商目录**（llm-pi-ai.providers）不在这条冒烟里下发：pi-ai 的路由是
       按设置**活挂**的，自定义路由要等设置段生效才注册，而运行时的握手（initialize）
       先按路由找适配器 —— 自定义路由会让这次握手直接失败（引擎原话：no adapter
       registered for provider）。服务商目录的写入由 test/smoke-settings-profile-patch.js
       的 [1] 段按补丁层形状钉住；这里走官方路由（deepseek-official 由 SDK 服务端自挂载）
       把「其余三段真的抵达运行时」核到底。 */
    const runReqId = "probe-run-1";
    const accepted = await req("run", {
      reqId: runReqId,
      workspace,
      input: "探针",
      model: "deepseek-flash",
      provider: "deepseek-official",
      maxTokens: 1024,
      apiKey: "sk-not-a-real-key",
      baseUrl: "https://api.deepseek.com",
      systemPrompt: "",
      hostPersona: "你是 MTNode 探针人设。",
      permissionPreset: "workspace-write",
      effort: "high",
      officialModels,
      dshHome: home,
    });
    ok(accepted && accepted.ok && accepted.result && accepted.result.accepted === true, "[2] run 被接受（真起运行时）");

    /* 探针要在**运行时还在池里**的时候打：run 被接受只是排上队，runtime 是异步
       spawn + 握手的（池里没有 = { ok:false, reason:'no_runtime' }，不是失败，是还没起好）。
       所以这里边等 done 边轮询探针，探到即断言。 */
    let probeRes = null;
    const t0 = Date.now();
    while (Date.now() - t0 < 120000) {
      if (!(probeRes && probeRes.result && probeRes.result.ok === true)) {
        try {
          probeRes = await req("configProbe", { reqId: runReqId }, 20000);
          if (probeRes && probeRes.result && probeRes.result.ok === true) {
            console.log("      probe 回执：" + JSON.stringify(probeRes.result).slice(0, 1000));
          } else if (probeRes && probeRes.result) {
            console.log("      probe 未就绪：" + JSON.stringify(probeRes.result).slice(0, 300));
          }
        } catch (err) {
          console.log("      probe 调用失败：" + String((err && err.message) || err));
        }
      }
      if (events.find((e) => e.reqId === runReqId && e.type === "done")) break;
      await new Promise((r) => setTimeout(r, 400));
    }
    ok(!!events.find((e) => e.reqId === runReqId && e.type === "done"), "[3] 本轮正常收尾（done）");
    ok(!!(probeRes && probeRes.result && probeRes.result.ok === true), "[4] configProbe 拿到 live runtime 的生效装配");
    /* 回执嵌套：本地协议回 { ok, result:{ ok, result:<探针体> } }；两层都收，防形状漂移。 */
    const r1 = probeRes && probeRes.result;
    const probe = (r1 && r1.result) || (r1 && r1.probe) || (r1 && r1.ok === true && r1.entries ? r1 : {}) || {};
    ok(String(probe.dshHome || "") === home, "[4] 探针报的是本次 DSH_HOME");
    const rows = new Map((probe.entries || []).map((e) => [e.id, e.config]));
    ok(rows.size > 0, "[4] 探针至少回报一行配置");

    /* ── 关键：宿主托管的三段是否抵达运行时 ─────────────────────────────── */
    const ds = rows.get("llm-deepseek");
    ok(ds && ds.reasoningEffort === "high", "[5] llm-deepseek.reasoningEffort 已抵达运行时");
    const mods = (ds && ds.models && ds.models.find((m) => m.id === "deepseek-v4-flash")) || null;
    ok(!!mods, "[5] 官方模型清单（deepseek-v4-flash）已抵达运行时");
    ok(mods && Array.isArray(mods.inputModalities) && mods.inputModalities.includes("image"), "[5] 视觉模型带 inputModalities: [text, image]（看图轮的前置）");

    const perm = rows.get("permission");
    ok(perm && perm.defaultPreset === "workspace-write", "[5] permission.defaultPreset 已抵达运行时");

    const sp = rows.get("system-prompt");
    ok(sp && typeof sp.personaPrefix === "string" && /探针人设/.test(sp.personaPrefix), "[5] 宿主人设写 personaPrefix 并抵达运行时");

    ok(!fs.existsSync(path.join(home, "settings.yaml")), "[6] 0.1 死信 settings.yaml 不再被写（0.2 只认 profile 补丁层）");
    ok(fs.existsSync(path.join(home, "profiles", "sdk", "cordis.patch.yml")), "[6] profile 补丁层文件在盘上");

    const sh = await req("shutdown");
    ok(!!(sh && sh.ok), "[7] shutdown 正常");
  } finally {
    child.stdin.end();
    await Promise.race([
      new Promise((r) => child.once("exit", r)),
      new Promise((r) => setTimeout(r, 8000)),
    ]);
    try { child.kill(); } catch { /* ignore */ }
    try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
    try { fs.rmSync(workspace, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  console.log("\nconfig-probe smoke: pass " + pass + " / fail " + fail);
  process.exitCode = fail ? 1 : 0;
})().catch((err) => {
  console.error("config-probe smoke 崩了：", err);
  process.exitCode = 1;
});
