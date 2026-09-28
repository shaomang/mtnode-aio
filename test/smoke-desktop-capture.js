"use strict";
/* 桌面 / 窗口截图（内置工具「屏幕 / 窗口截图」）—— 链路级冒烟测试（纯 Node · 零依赖）
 *   node test/smoke-desktop-capture.js
 *
 * 被测代码都是「真实源码 / 真实模块」，不是抄一份逻辑：
 *   desktop-capture.js         参数归一（target / 屏幕 / 窗口 / 区域）、计划脚本构建、
 *                              结果行解析、文件名、跨平台降级；并在 Windows 上**真跑**
 *                              PowerShell（列屏幕 / 列窗口 / 拍一张 / 区域裁剪 / 报错分支）
 *   renderer/preset-tools.json 内置工具库条目的形状（函数节点 + 图像输出 + jscode），
 *                              并把 jscode 在 vm 里真执行一遍（入参 → mtnode.screenShot → 路径）
 *   tools-store.js             内置条目并入 tools:list / tools:get（builtin: 前缀）、
 *                              开关覆写落 data 目录、改名与删除被拒（用户工具行为不变）
 *   main.js / fn-runtime.js / preload.js  接线契约（fnRuntime.screenCapture /
 *                              mtnode 桥三只 / IPC desktop:list|desktop:shot）
 * 覆盖：
 *   [1] 参数归一与计划脚本（纯函数）
 *   [2] 真跑：列屏幕 / 列窗口 / 拍屏幕 / 区域 / 拍窗口 / 报错分支（Windows）
 *   [3] 内置工具库条目（清单形状 + jscode 真执行 + 与工具库存储的合并）
 *   [4] 接线契约（主进程 / worker 桥 / preload）
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");
const Module = require("module");

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
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const DC = require(path.join(ROOT, "desktop-capture.js"));
const IS_WIN = process.platform === "win32";
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mtnode-dcap-"));

(async () => {
  /* ═════════════════ [1] 参数归一与计划脚本（纯函数） ════════════════ */
  console.log("\n[1] 参数归一与计划脚本");
  ok(DC.normTarget("screen") === "screen" && DC.normTarget("窗口") === "window", "[1] target 认英文 screen/window 与中文 屏幕/窗口");
  ok(DC.normTarget("all") === "all" && DC.normTarget("整块桌面") === "all" && DC.normTarget("desktop") === "all", "[1] all / desktop / 整块桌面 都归到整块虚拟桌面");
  ok(DC.normTarget("zzz") === "", "[1] 认不出的 target 回空串（由调用方给点名文案，不猜）");

  const p1 = DC.normCaptureParams({ target: "screen" });
  ok(p1.ok === true && p1.target === "screen" && p1.screen === "" && p1.w == null && p1.x === 0, "[1] 只给 target → 主屏整屏（x/y 缺省 0，w/h 缺省 null）");
  const p2 = DC.normCaptureParams({ mode: "window", windowTitle: "记事本", x: "10", y: "20", w: 300, h: "200" });
  ok(p2.ok === true && p2.target === "window" && p2.window === "记事本" && p2.x === 10 && p2.y === 20 && p2.w === 300 && p2.h === 200, "[1] mode/windowTitle 别名 + 字符串坐标都收（window 只要关键字，可只写一部分）");
  const p3 = DC.normCaptureParams({ target: "window", pid: "1234" });
  ok(p3.ok === true && p3.pid === 1234 && p3.hwnd === null, "[1] 窗口也能按 pid 点名（pid/handle 别名归一）");
  const p4 = DC.normCaptureParams({ target: "window" });
  ok(p4.ok === false && /窗口标题关键字/.test(p4.error), "[1] target=window 没给任何窗口标识 → 拒绝并点名要 window/hwnd/pid 三者之一");
  const p5 = DC.normCaptureParams({ target: "screen", w: 100 });
  ok(p5.ok === false && /同时给 w 与 h/.test(p5.error), "[1] 只给 w 不给 h → 拒绝（区域必须成对）");
  const p6 = DC.normCaptureParams({ target: "nope" });
  ok(p6.ok === false && /target 只能是/.test(p6.error), "[1] 非法 target → 拒绝并列出三个合法值");
  const p7 = DC.normCaptureParams({ target: "screen", screen: "1" });
  ok(p7.ok === true && p7.w === null && p7.h === null && p7.x === 0 && p7.y === 0, "[1] 不给坐标 → x/y 落 0、w/h 落 null（脚本按整屏 / 整窗算）");
  ok(DC.parseNum("") === null && DC.parseNum(" 12 ") === 12 && DC.parseNum("abc") === null && DC.parseIntOrNull("7.6") === 8, "[1] 数字解析：空串 / 非数字回 null，数字去空白，小数取整（脏输入不静默变 0）");
  const p7b = DC.normCaptureParams({ target: "screen", x: "-40", y: "-20", w: 100, h: 50 });
  ok(p7b.x === -40 && p7b.y === -20, "[1] 支持负偏移（虚拟桌面里主屏左侧那块屏幕是靠负坐标定位的）");

  const pS = DC.normCaptureParams({ target: "screen", screen: "1", x: 5, y: 6, w: 7, h: 8 });
  const sS = DC.buildPowerShell("capture", Object.assign({}, pS, { outPath: "C:\\out\\a.png" }));
  ok(/\$WantScreen = '1'/.test(sS) && /\$OffX = 5/.test(sS) && /\$OffY = 6/.test(sS) && /\$RegionW = 7/.test(sS) && /\$RegionH = 8/.test(sS), "[1] 脚本把屏幕 / 偏移 / 区域逐项钉成确定常量（不经命令行传参）");
  ok(/Pick-MtnodeScreen/.test(sS) && /CopyFromScreen/.test(sS), "[1] 屏幕分支用 Pick-MtnodeScreen 定位 + CopyFromScreen 抓取");
  ok(sS.indexOf("$OutPath = 'C:\\out\\a.png'") >= 0, "[1] 输出路径原样写进脚本（Windows 反斜杠不被转义）");
  const sW = DC.buildPowerShell("capture", Object.assign({}, DC.normCaptureParams({ target: "window", window: "记事本" }), { outPath: "x.png" }));
  ok(/PrintWindow/.test(sW) && /Test-MtnodeBlank/.test(DC.buildCaptureScript(DC.normCaptureParams({ target: "window", window: "x" }))), "[1] 窗口分支用 PrintWindow，并带「整幅同色退回复制屏幕」的检测函数");
  const sQ = DC.buildPowerShell("capture", Object.assign({}, DC.normCaptureParams({ target: "screen" }), { outPath: "a'b.png" }));
  ok(/a''b\.png/.test(sQ), "[1] 路径里的单引号按 PowerShell 字面量翻倍（注入面收口）");
  ok(/没找到匹配的窗口/.test(sW) && /没有匹配的屏幕/.test(sS), "[1] 找不到目标时脚本自己给出中文原因（不回一张黑图）");
  const sScreens = DC.buildPowerShell("screens", {});
  ok(/AllScreens/.test(sScreens) && /deviceName/.test(sScreens) && /primary/.test(sScreens), "[1] screens 模式枚举屏幕（deviceName / primary / 矩形）");
  const sWins = DC.buildPowerShell("windows", {});
  ok(/MainWindowHandle/.test(sWins) && /GetWindowRect/.test(sWins) && /hwnd/.test(sWins), "[1] windows 模式枚举窗口（hwnd / pid / 标题 / 矩形）");

  const parsed = DC.parseCaptureOutput("noise\n" + DC.CAPTURE_MARK + '{"ok":true,"path":"C:\\\\a.png"}\nmore');
  ok(parsed && parsed.ok === true && parsed.path === "C:\\a.png", "[1] 结果解析只认带前缀的那一行（PowerShell 的 CLIXML 噪声不影响）");
  ok(DC.parseCaptureOutput("nothing") === null, "[1] 没有结果行 → null（调用方转成明确错误，不静默）");

  const fnName = DC.captureFileName(DC.normCaptureParams({ target: "window", window: "记事本 - 未命名" }), 1758000000000);
  ok(/^shot-window-记事本 - 未命名-\d{8}-\d{6}-\d{3}\.png$/.test(fnName), "[1] 文件名 = shot-<目标>-<摘要>-<时间戳>.png");
  const fnBad = DC.captureFileName(DC.normCaptureParams({ target: "screen", screen: 'a/b\\c:d*e?f"g<h>i|j' }), 1758000000000);
  ok(!/[<>:"/\\|?*]/.test(fnBad), "[1] 文件名里的 Windows 非法字符全部换掉（不会写出失败）");
  ok(DC.rectLooksVisible({ x: 100, y: 100, width: 300, height: 200 }) === true && DC.rectLooksVisible({ x: -32000, y: -32000, width: 200, height: 100 }) === false && DC.rectLooksVisible({ x: 0, y: 0, width: 0, height: 0 }) === false, "[1] 可见性兜底：屏幕内 true / 摆到 -32000 false / 零尺寸 false");
  ok(DC.rectLooksVisible({ x: -2048, y: 0, width: 2048, height: 1152 }) === true, "[1] 主屏左侧那块副屏（负坐标）仍算可见（多屏不会被误判）");

  const nonWin = DC.createDesktopCapture({ outDir: tmpRoot, platform: "darwin" });
  ok(nonWin.available() === false, "[1] 非 Windows → available() 为 false（如实降级，不假装能拍）");
  const rNonWin = await nonWin.capture({ target: "screen" });
  ok(rNonWin.ok === false && /Windows/.test(rNonWin.error), "[1] 非 Windows 上拍一张 → 明确说「只在 Windows 上实现」，不抛异常");
  const rNoDir = await DC.createDesktopCapture({ outDir: "", platform: "win32" }).capture({ target: "screen" });
  ok(rNoDir.ok === false && /输出目录/.test(rNoDir.error), "[1] 没给输出目录 → 明确拒绝（不会写到意外位置）");

  /* ─ 计划脚本执行器：注入假 spawn，钉住「编码命令 + 超时 + 退出码」契约 ── */
  const fakeSpawn = (exe, args, opts) => {
    const handlers = {};
    const child = {
      stdout: { on: (ev, cb) => (handlers["out"] = cb) },
      stderr: { on: (ev, cb) => (handlers["err"] = cb) },
      on: (ev, cb) => (handlers[ev] = cb),
      kill: () => {},
    };
    lastSpawn = { exe, args, opts };
    setTimeout(() => {
      if (handlers.out) handlers.out("junk\n" + DC.CAPTURE_MARK + '{"ok":true,"screens":[]}\n');
      if (handlers.close) handlers.close(0);
    }, 0);
    return child;
  };
  let lastSpawn = null;
  const runRes = await DC.runPowerShellEncoded("Write-Output 1", { spawn: fakeSpawn, exe: "pwsh-test.exe" });
  ok(runRes.ok === true && lastSpawn.exe === "pwsh-test.exe", "[1] 脚本执行器支持注入 exe（测试 / 非默认 PowerShell 路径）");
  const cmd = lastSpawn.args.join(" ");
  ok(/-NoProfile/.test(cmd) && /-NonInteractive/.test(cmd) && /-EncodedCommand/.test(cmd), "[1] 一律走 -NoProfile -NonInteractive -EncodedCommand（不做交互、不吃用户 profile）");
  ok(lastSpawn.opts.windowsHide === true, "[1] 隐藏启动，绝不闪一个控制台窗口");
  const tail = lastSpawn.args[lastSpawn.args.length - 1];
  const decoded = Buffer.from(tail, "base64").toString("utf16le");
  ok(decoded === "Write-Output 1", "[1] 命令按 UTF-16LE + base64 编码（中文路径 / 中文关键字不会乱码）");

  const fakeFail = (exe, args, opts) => {
    const handlers = {};
    const child = {
      stdout: { on: (ev, cb) => (handlers.out = cb) },
      stderr: { on: (ev, cb) => (handlers.err = cb) },
      on: (ev, cb) => (handlers[ev] = cb),
      kill: () => {},
    };
    setTimeout(() => {
      if (handlers.err) handlers.err("PowerShell 报错：无法加载程序集\r\n");
      if (handlers.close) handlers.close(1);
    }, 0);
    return child;
  };
  const runFail = await DC.runPowerShellEncoded("x", { spawn: fakeFail });
  ok(runFail.ok === false && /退出码 1/.test(runFail.error) && /无法加载程序集/.test(runFail.error), "[1] 脚本非零退出 → ok:false 并带上 stderr 最后一行（失败原因看得见）");
  ok(/退出码 1/.test(runFail.error) && !/找不到 PowerShell/.test(runFail.error), "[1] 非零退出不再换候选重跑（截图有副作用，不重复执行）");

  /* 候选链：第一个候选不存在（ENOENT）→ 自动换系统兜底路径；两个都没有 → 点名报错 */
  const tried = [];
  const spawnEnoent = (exe, args, opts) => {
    const handlers = {};
    const child = {
      stdout: { on: (ev, cb) => (handlers.out = cb) },
      stderr: { on: (ev, cb) => (handlers.err = cb) },
      on: (ev, cb) => (handlers[ev] = cb),
      kill: () => {},
    };
    tried.push(exe);
    setTimeout(() => {
      if (exe === "powershell.exe") {
        const e = new Error("spawn powershell.exe ENOENT");
        e.code = "ENOENT";
        if (handlers.error) handlers.error(e);
        else if (handlers.close) handlers.close(-2);
      } else {
        if (handlers.out) handlers.out(DC.CAPTURE_MARK + '{"ok":true}\n');
        if (handlers.close) handlers.close(0);
      }
    }, 0);
    return child;
  };
  const runFallback = await DC.runPowerShellEncoded("x", { spawn: spawnEnoent });
  ok(runFallback.ok === true && tried.length === 2 && tried[0] === "powershell.exe" && /System32/.test(tried[1]), "[1] PATH 里没有 powershell.exe → 自动退到系统自带的绝对路径（候选链）· got " + JSON.stringify({ ok: runFallback.ok, tried: tried, error: runFallback.error }));
  ok(DC.PS_EXE_CANDIDATES.length >= 2 && /System32/.test(DC.PS_EXE_CANDIDATES[1]), "[1] 候选链写死系统兜底路径（PATH 被改坏的机器也能拍）");

  /* ═════════════════ [2] 真跑（Windows） ═════════════════ */
  console.log("\n[2] 真跑 PowerShell（列屏幕 / 列窗口 / 拍一张 / 区域 / 报错分支）");
  const outDir = path.join(tmpRoot, "captures");
  const cap = DC.createDesktopCapture({ outDir, platform: process.platform, timeoutMs: 60000 });
  if (!IS_WIN) {
    console.log("  skip  非 Windows：真跑分支跳过（已在上文断言如实降级）");
  } else {
    const scr = await cap.listScreens();
    ok(scr.ok === true && Array.isArray(scr.screens) && scr.screens.length >= 1, "[2] 列屏幕：至少一块屏幕（" + JSON.stringify((scr.screens || []).map((s) => s.width + "x" + s.height)) + "）");
    ok((scr.screens || []).every((s) => typeof s.deviceName === "string" && typeof s.primary === "boolean" && s.width > 0 && s.height > 0), "[2] 每块屏幕都有 deviceName / primary / 正尺寸（可原样回传给 capture）");
    const primary = (scr.screens || []).find((s) => s.primary) || (scr.screens || [])[0] || {};

    const wins = await cap.listWindows();
    ok(wins.ok === true && Array.isArray(wins.windows), "[2] 列窗口：返回数组（本机 " + ((wins.windows || []).length) + " 个可见窗口）");
    ok((wins.windows || []).every((w) => typeof w.hwnd === "number" && typeof w.visible === "boolean" && typeof w.minimized === "boolean"), "[2] 每个窗口都带 hwnd / visible / minimized（拿得到精确目标，最小化窗口会被标出来）");

    const shot = await cap.capture({ target: "screen" });
    ok(shot.ok === true && /\.png$/.test(String(shot.path)) && shot.width === primary.width && shot.height === primary.height, "[2] 拍主屏：出 PNG，尺寸与枚举到的主屏一致（" + shot.width + "x" + shot.height + "）");
    ok(shot.bytes > 1000 && fs.existsSync(shot.path), "[2] 截图真的落盘了（" + shot.bytes + " 字节）");
    ok(String(shot.path).indexOf(outDir) === 0, "[2] 落盘位置 = 注入的输出目录（数据目录下的 captures/）");

    const region = await cap.capture({ target: "screen", screen: String(primary.index), x: 10, y: 10, w: 320, h: 200 });
    ok(region.ok === true && region.width === 320 && region.height === 200, "[2] 区域截图：给 x/y/w/h 就只拍那块（320x200）");
    ok(region.method === "copyfromscreen", "[2] 屏幕分支方法 = copyfromscreen（记录来源，便于排查）");

    /* 找一个真窗口拍：优先 MTNode 自己（本机一定有），否则随便一个可见窗口 */
    const mine = (wins.windows || []).find((w) => /MTNode/i.test(String(w.title || "")) && w.visible !== false);
    const anyVisible = (wins.windows || []).find((w) => w.visible !== false && w.width > 100 && w.height > 100);
    const targetWin = mine || anyVisible;
    if (targetWin) {
      const wShot = await cap.capture({ target: "window", hwnd: targetWin.hwnd });
      ok(wShot.ok === true && wShot.width === targetWin.width && wShot.height === targetWin.height, "[2] 拍窗口（按 hwnd）：尺寸 = 该窗口矩形" + (mine ? "（MTNode 自己的窗口）" : ""));
      ok(/printwindow|copyfromscreen/.test(String(wShot.method)), "[2] 窗口分支记录了实际用到的抓法（" + wShot.method + "）");
      const byKeyword = await cap.capture({ target: "window", window: String(targetWin.title).slice(0, 6) });
      ok(byKeyword.ok === true, "[2] 拍窗口（按标题关键字，只写前几个字）：也能命中");
    } else {
      console.log("  skip  本机没有可见窗口，窗口抓取分支跳过");
    }

    const notFound = await cap.capture({ target: "window", window: "zzz-绝不存在-zzz" });
    ok(notFound.ok === false && /没找到匹配的窗口/.test(notFound.error), "[2] 窗口名对不上 → ok:false + 中文原因（用户知道该改什么）");
    const badScreen = await cap.capture({ target: "screen", screen: "DISPLAY-99" });
    ok(badScreen.ok === false && /没有匹配的屏幕/.test(badScreen.error), "[2] 屏幕名对不上 → ok:false + 中文原因");

    /* 最小化窗口：按 hwnd 点名时应当被拦下（否则只会给一张黑图） */
    const hidden = (wins.windows || []).find((w) => w.visible === false);
    if (hidden) {
      const rHide = await cap.capture({ target: "window", hwnd: hidden.hwnd });
      ok(rHide.ok === false && /不在屏幕上/.test(rHide.error), "[2] 按 hwnd 拍一个最小化窗口 → 拦下并说明「先显示出来再拍」");
    } else {
      console.log("  skip  本机没有被最小化的窗口，黑图拦截分支跳过");
    }
    const bad = await cap.capture({ target: "screen", w: 10 });
    ok(bad.ok === false && /同时给 w 与 h/.test(bad.error), "[2] 非法区域在真跑入口同样被拦下（不落到脚本里）");
  }

  /* ═════════════════ [3] 内置工具库条目 ═════════════════ */
  console.log("\n[3] 内置工具库条目（清单形状 + jscode 真执行 + 工具库合并）");
  const manifest = JSON.parse(read("renderer/preset-tools.json"));
  ok(Array.isArray(manifest.tools) && manifest.tools.length >= 1, "[3] preset-tools.json 有工具条目");
  const entry = manifest.tools.find((t) => t.key === "desktop-capture") || manifest.tools[0];
  ok(entry.kind === "function" && /截图/.test(entry.name), "[3] 条目是函数包（单节点 JS 计算）：" + entry.name);
  const rootNode = entry.graph.nodes.find((n) => n.id === entry.graph.rootId);
  ok(!!rootNode && rootNode.kind === "function", "[3] graph.rootId 指向那个函数节点（插入画布即用）");
  ok(Array.isArray(rootNode.inputs) && rootNode.inputs.length === 7 && rootNode.inputs.map((p) => p.name).join(",") === "target,screen,window,x,y,w,h", "[3] 输入端子：target / screen / window / x / y / w / h（用户要的屏幕 id + 窗口 + 两个坐标）");
  ok(Array.isArray(rootNode.outputs) && rootNode.outputs.length === 1 && rootNode.outputs[0].kind === "image", "[3] 输出端子声明成「图像」（下游保存节点自动按 .png 落盘）");
  ok(JSON.stringify(entry.inputs.map((p) => p.name)) === JSON.stringify(rootNode.inputs.map((p) => p.name)), "[3] 包级参数表与节点参数表一致（插入 / Agent 调用按同一份取数）");
  ok(rootNode.jscode.indexOf("mtnode.screenShot") >= 0 && rootNode.jscode.indexOf("图像路径") >= 0, "[3] jscode 走 mtnode.screenShot 并回「图像路径」输出");
  ok(rootNode.jscode.indexOf("typeof mtnode.screenShot") >= 0, "[3] jscode 先探测桥是否存在（老版本上给点名错误而不是 TypeError）");
  ok(entry.presets && typeof entry.presets.target === "string", "[3] 带参数预设（测试台点开就有能跑的样例值）");

  /* jscode 真执行：入参 → 桥调用 → 图像路径字符串 */
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const fnBody = new AsyncFunction("input", "mtnode", rootNode.jscode);
  const shotCalls = [];
  const logs = [];
  const fakeBridge = {
    log: (...a) => logs.push(a.join(" ")),
    screenShot: async (p) => {
      shotCalls.push(p);
      return { ok: true, path: "C:\\cap\\shot.png", width: 800, height: 600, method: "printwindow", target: p.target };
    },
  };
  const out1 = await fnBody({ target: "screen" }, fakeBridge);
  ok(out1 && out1["图像路径"] === "C:\\cap\\shot.png", "[3] jscode 真跑：target=screen → 回图像路径");
  ok(shotCalls[0].target === "screen" && shotCalls[0].x === null && shotCalls[0].w === null, "[3] 没给坐标 → 透传 null（等于整屏 / 整窗，不是 0x0）");
  const out2 = await fnBody({ target: { kind: "text", text: "window" }, window: { kind: "text", text: "MTNode" }, x: "10", w: "300", h: "200" }, fakeBridge);
  ok(out2 && shotCalls[1].target === "window" && shotCalls[1].window === "MTNode" && shotCalls[1].x === 10 && shotCalls[1].w === 300, "[3] 端子值写成 {kind,text} 对象也认（线上来的就是这种形状）");
  ok(logs.length >= 2 && /已拍/.test(logs[0]), "[3] 拍完写一条过程日志（节点日志区看得见拍了什么）");
  let failureText = "";
  try {
    await fnBody({ target: "screen" }, Object.assign({}, fakeBridge, { screenShot: async () => ({ ok: false, error: "没有匹配的屏幕" }) }));
  } catch (e) {
    failureText = (e && e.message) || "";
  }
  ok(failureText === "没有匹配的屏幕", "[3] 桥回 ok:false → jscode 抛错（节点上显示 ✕ 与原因，不静默成功）");
  let noBridgeText = "";
  try {
    await fnBody({ target: "screen" }, { log: () => {} });
  } catch (e) {
    noBridgeText = (e && e.message) || "";
  }
  ok(/不支持桌面截图/.test(noBridgeText), "[3] 桥不存在 → 点名「当前 MTNode 不支持桌面截图」");

  /* tools-store 合并：内置条目出现在 tools:list，可 get 全量包；改名 / 删除被拒 */
  const handlers = new Map();
  const electronStub = {
    ipcMain: { handle: (ch, fn) => handlers.set(ch, fn), on() {}, once() {}, off() {}, removeHandler() {}, removeAllListeners() {} },
    ipcRenderer: { sendSync: () => undefined, send() {}, on() {}, invoke: () => Promise.resolve(), removeListener() {} },
    app: {},
    dialog: {},
  };
  const origLoad = Module._load;
  Module._load = function (request) {
    if (request === "electron") return electronStub;
    return origLoad.apply(this, arguments);
  };
  const { registerToolsIpc } = require(path.join(ROOT, "tools-store.js"));
  Module._load = origLoad;
  const dataDir = path.join(tmpRoot, "data");
  registerToolsIpc({ getDataDir: () => dataDir });
  const call = (ch, arg) => Promise.resolve(handlers.get(ch)(null, arg));

  const list = await call("tools:list");
  ok(list.ok === true && Array.isArray(list.tools), "[3] tools:list 正常（内置 + 用户工具一份清单）");
  const bi = (list.tools || []).find((t) => t.builtin === true && /截图/.test(t.name));
  ok(!!bi && String(bi.id).indexOf("builtin:") === 0, "[3] 内置条目在清单里（id 带 builtin: 前缀，用户工具永远撞不上）");
  ok(bi && bi.always === false && bi.nodeCount === 1 && bi.wireCount === 0, "[3] 清单条目：默认不进 Agent 可调用（always=false）· 1 节点 0 连线");
  ok((list.tools || []).every((t) => !t.graph), "[3] 清单仍是轻量口径（不带内部图，省带宽）");

  const got = await call("tools:get", "builtin:desktop-capture");
  ok(got.ok === true && got.tool && Array.isArray(got.tool.graph.nodes) && got.tool.graph.nodes.length === 1, "[3] tools:get 取内置全量包（插入画布 / 会话调用都走这条）");
  ok(got.tool.graph.nodes[0].jscode.indexOf("mtnode.screenShot") >= 0, "[3] 取回的包带 jscode（不是空壳）");

  const patched = await call("tools:patch", { id: "builtin:desktop-capture", patch: { always: true } });
  ok(patched.ok === false && /不支持「会话随时可调用」/.test(patched.error), "[3] 函数条目的「会话随时可调用」被拒（该链路跑的是工具节点的内部图，函数包没有这条执行路）");
  const list2 = await call("tools:list");
  ok(((list2.tools || []).find((t) => t.id === "builtin:desktop-capture") || {}).always === false, "[3] 被拒后清单里 always 仍是 false（没写进覆写文件）");
  const gotFn = await call("tools:get", "builtin:desktop-capture");
  ok(gotFn.tool.always === false, "[3] tools:get 取回的包同样恒 false（两端口径一致，不出现「界面关了但清单里开着」）");
  ok(fs.existsSync(path.join(dataDir, "tools", "_builtin.json")) === false, "[3] 被拒的开关没有留下任何覆写文件");
  const rename = await call("tools:patch", { id: "builtin:desktop-capture", patch: { name: "换个名字" } });
  ok(rename.ok === false && /不能改名/.test(rename.error), "[3] 内置条目改名被拒（随包文件改了下次升级也没）");
  const del = await call("tools:delete", "builtin:desktop-capture");
  ok(del.ok === false && /不可删除/.test(del.error), "[3] 内置条目删除被拒（不误删用户以为「工具没了」）");
  const stillThere = await call("tools:get", "builtin:desktop-capture");
  ok(stillThere.ok === true, "[3] 被拒两次后条目仍在（拒绝是真的没写盘）");

  /* 用户工具路径没被影响：存一个普通包 → 能列出 / 能删 */
  const saved = await call("tools:save", {
    name: "用户自建工具",
    description: "",
    inputs: [],
    outputs: [],
    graph: { rootId: "u1", nodes: [{ id: "u1", kind: "function", title: "用户自建工具", jscode: "return 1" }], wires: [] },
  });
  ok(saved.ok === true && /^tl/.test(saved.id), "[3] 用户工具照旧保存（id 仍是 tl…，与内置前缀不冲突）");
  const list3 = await call("tools:list");
  ok((list3.tools || []).some((t) => t.id === saved.id && !t.builtin), "[3] 用户工具与内置条目同列出现且各自标记分明");
  const delUser = await call("tools:delete", saved.id);
  ok(delUser.ok === true, "[3] 用户工具仍可删除（内置限制没有外溢）");

  /* ═════════════════ [4] 接线契约 ═════════════════ */
  console.log("\n[4] 接线契约（主进程 / worker 桥 / preload）");
  const MAIN = read("main.js");
  const FNRT = read("fn-runtime.js");
  const PRELOAD = read("preload.js");
  const APPFN = read("renderer/app-tools.js");
  ok(/require\("\.\/desktop-capture\.js"\)/.test(MAIN), "[4] main.js require 桌面截图模块（根目录模块，打包白名单同步）");
  ok(/screenCapture: \(action, params\) => fnScreenCapture\(action, params\)/.test(MAIN), "[4] fnRuntime 注入 screenCapture（函数节点桥的宿主实现）");
  ok(/ipcMain\.handle\("desktop:list"/.test(MAIN) && /ipcMain\.handle\("desktop:shot"/.test(MAIN), "[4] 主进程注册 desktop:list / desktop:shot（渲染层入口）");
  ok(/join\(DATA\(\), "captures"\)/.test(MAIN), "[4] 截图落盘在数据目录下 captures/（不落应用文件夹）");
  ok(/if \(!String\(p\.w \|\| ""\)\.trim\(\)\)[\s\S]{0,200}screenShot/.test(MAIN) === false, "[4] main.js 里没有把截图参数再抄一份（口径唯一在 desktop-capture.js）");

  ok(/screenShot: \(params\) => call\("screenShot", params \|\| \{\}\)/.test(FNRT) && /screenList: \(\) => call\("screenList", \{\}\)/.test(FNRT) && /windowList: \(\) => call\("windowList", \{\}\)/.test(FNRT), "[4] worker 桥暴露 mtnode.screenShot / screenList / windowList");
  ok(/action === "screenShot" \|\| action === "screenList" \|\| action === "windowList"/.test(FNRT), "[4] 主进程侧分派这三只桥调用（未知动作仍走兜底错误）");
  ok(/deps\.screenCapture/.test(FNRT) && /桌面截图后端未接线/.test(FNRT), "[4] 没接线时给明确错误（用户代码不会拿到 undefined）");

  ok(/desktopList: \(what\)[\s\S]{0,120}desktop:list/.test(PRELOAD) && /desktopShot: \(params\)[\s\S]{0,120}desktop:shot/.test(PRELOAD), "[4] preload 白名单桥暴露 desktopList / desktopShot");
  ok(/applyToolPresetInputs\(rootCp, pkg\.presets\)/.test(APPFN) && /function applyToolPresetInputs/.test(APPFN), "[4] 插入画布时把内置条目的参数预设写进测试台快照（点开就能试跑）");
  ok(/tool\.builtin/.test(APPFN), "[4] 工具库清单对内嵌条目隐藏改名 / 删除按钮");
  ok(/\{ "name": "图像路径", "kind": "image" \}/.test(read("renderer/preset-tools.json")), "[4] 内置清单里的图像输出端子（文件形状可断言）");

  /* ── 汇总 ── */
  console.log(
    "\n" + (fails ? "FAILED " : "PASS ") + (checks - fails) + "/" + checks + " 项通过" + (fails ? "（失败 " + fails + "）" : ""),
  );
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {}
  process.exitCode = fails ? 1 : 0;
})();