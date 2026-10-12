"use strict";
/* 国内镜像源口径 —— 冒烟测试（纯 Node：只读文件 + 读常量，不联网、不真跑安装）
 *   node test/smoke-cn-mirrors.js
 *
 * 为什么要有这只用例（本轮需求 + 真机故障）：
 *   插件安装时 pip 反复卡在不可达的 `pypi.ngc.nvidia.com`：
 *   `WARNING: Retrying ... NameResolutionError("... pypi.ngc.nvidia.com ... getaddrinfo failed")`。
 *   根因是机器级 pip.ini 被 NVIDIA PyIndex 塞了 `extra-index-url`，命令行只写 `--index-url`
 *   盖不住它，而 `pip --isolated` 又会忽略环境变量（等于把那个不可达索引放回来）。
 *
 * 口径（用户确认，单一真源 = 仓库根 cn-mirrors.js）：
 *   · pip    清华 → 阿里云 → USTC → 官方（官方只做最后一级兜底）；用 PIP_INDEX_URL /
 *            PIP_EXTRA_INDEX_URL / PIP_TRUSTED_HOST 在**安装子进程内**覆盖
 *   · torch  SJTU → 阿里云 pytorch-wheels → 官方
 *   · 权重   ModelScope 优先 → hf-mirror（+ HF_HUB_DISABLE_XET=1）→ 官方
 *   · npm    registry.npmmirror.com
 *   · git    ghfast.top / gh-proxy.com / ghproxy.net / ghproxy.com → 直连
 *   · 二进制 node / uv / electron / chrome-for-testing 走 npmmirror
 *   · **不修改用户机器上的 pip.ini / npmrc**，只在安装子进程里覆盖
 *
 * 覆盖：
 *   [1] 统一真源 cn-mirrors.js：常量、三条索引链的顺序、installEnv 三件套、MTNODE_* 覆盖、banner
 *   [2] 打包白名单 build.json 含 cn-mirrors.js
 *   [3] 8 个插件宿主：require 真源 + 安装 env 走 mirrors.installEnv() + 打镜像源日志 + 无 pip --isolated
 *   [4] 8 个随包安装脚本：PIP_* 三件套、无 --isolated、国内优先顺序、权重 ModelScope 优先、npm 默认 npmmirror
 *   [5] Remotion：从国内镜像代下 Chrome Headless Shell 预置 + 本机浏览器兜底（不再撞 Google 直连）
 *   [6] 语音权重默认国内源（main.js）、网关 npm registry（dsh/main-dsh.js）
 *   [7] 纪律：不写用户机器上的 pip.ini / npmrc
 *   [8] 文档：docs/mirror-sources.md 与内置安装技能同步了新口径
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
const ROOT = path.join(__dirname, "..");
const abs = (rel) => path.join(ROOT, rel.split("/").join(path.sep));
const exists = (rel) => fs.existsSync(abs(rel));
const read = (rel) => fs.readFileSync(abs(rel), "utf8").replace(/\r\n/g, "\n");
const has = (text, needle, msg) => ok(text.indexOf(needle) >= 0, msg + "  [" + needle + "]");
const hasnt = (text, needle, msg) => ok(text.indexOf(needle) < 0, msg + "  [无 " + needle + "]");
const eqStr = (a, b, msg) => ok(String(a) === String(b), msg + "（得到 " + JSON.stringify(a) + "）");

/** 去掉脚本注释行（# / REM），只留真正会执行的行：断言「命令里没有 --isolated」时才不会被注释误判。 */
function codeLines(text) {
  return String(text)
    .split("\n")
    .filter((l) => {
      const t = l.trim();
      return t && t[0] !== "#" && !/^rem\b/i.test(t);
    })
    .join("\n");
}

/** 更进一步：再去掉只做提示的横幅行（Write-Host / Write-Output / echo / Say / log）。
 *  判断「谁排在谁前面」时只看**会干活的行** —— 脚本开头那几行横幅把官方地址写在前面是正常的，
 *  它不产生任何下载；真正决定顺序的是 pip / 下载命令那一行。 */
function workLines(text) {
  return codeLines(text)
    .split("\n")
    .filter((l) => !/^\s*(write-host|write-output|echo|say|log|console\.log|print)\b/i.test(l))
    .join("\n");
}

const mirrors = require("../cn-mirrors.js");

/* ---------------- [1] 统一真源 ---------------- */
console.log("[1] 统一真源 cn-mirrors.js");
eqStr(mirrors.PIP_INDEX, "https://pypi.tuna.tsinghua.edu.cn/simple", "pip 主源 = 清华");
ok(mirrors.PIP_FALLBACKS.some((u) => /mirrors\.aliyun\.com\/pypi/.test(u)), "pip 回退含阿里云");
ok(mirrors.PIP_FALLBACKS.some((u) => /mirrors\.ustc\.edu\.cn/.test(u)), "pip 回退含 USTC");
const pipChain = mirrors.pipIndexChain();
ok(pipChain[0] === mirrors.PIP_INDEX, "pip 链第一级 = 清华");
eqStr(pipChain[pipChain.length - 1], mirrors.PIP_OFFICIAL, "pip 链最后一级 = 官方（只做兜底）");
const torchChain = mirrors.torchIndexChain("cu128");
ok(/mirror\.sjtu\.edu\.cn\/pytorch-wheels\/cu128$/.test(torchChain[0]), "torch 链第一级 = SJTU 镜像");
ok(/mirrors\.aliyun\.com\/pytorch-wheels\/cu128$/.test(torchChain[1]), "torch 链第二级 = 阿里云镜像");
ok(/^https:\/\/download\.pytorch\.org\/whl\/cu128$/.test(torchChain[torchChain.length - 1]), "torch 链最后一级 = 官方");
const env = mirrors.installEnv();
eqStr(env.PIP_INDEX_URL, mirrors.PIP_INDEX, "installEnv 下发 PIP_INDEX_URL");
eqStr(env.PIP_EXTRA_INDEX_URL, env.PIP_INDEX_URL, "installEnv 同时下发 PIP_EXTRA_INDEX_URL（这才是压掉 ngc 的关键）");
eqStr(env.PIP_TRUSTED_HOST, "pypi.tuna.tsinghua.edu.cn", "installEnv 下发 PIP_TRUSTED_HOST");
eqStr(env.HF_ENDPOINT, "https://hf-mirror.com", "installEnv 下发 HF_ENDPOINT=hf-mirror");
eqStr(env.HF_HUB_DISABLE_XET, "1", "installEnv 关掉 HF xet");
eqStr(env.npm_config_registry, "https://registry.npmmirror.com", "installEnv 钉 npm registry=npmmirror");
eqStr(env.NPM_CONFIG_REGISTRY, env.npm_config_registry, "大写 NPM_CONFIG_REGISTRY 同值（pnpm / 老工具读它）");
ok(/npmmirror/.test(String(env.UV_PYTHON_INSTALL_MIRROR)), "uv 的 python-build-standalone 走 npmmirror");
ok(/npmmirror/.test(String(env.ELECTRON_MIRROR)), "electron 二进制走 npmmirror");
eqStr(mirrors.CHROME_FOR_TESTING_MIRROR, "https://registry.npmmirror.com/-/binary/chrome-for-testing", "chrome-for-testing 二进制走 npmmirror");
ok(mirrors.GH_PROXIES.length >= 4, "GitHub 代理链至少四个（实测 " + mirrors.GH_PROXIES.length + " 个）");
ok(mirrors.GH_PROXIES.every((u) => /^https:\/\//.test(u)), "代理链都是 https");
const rawUrl = "https://github.com/a/b/archive/refs/tags/v1.tar.gz";
const proxied = mirrors.ghProxyUrls(rawUrl);
eqStr(proxied[proxied.length - 1], rawUrl, "ghProxyUrls 最后一级回落到直连");
ok(proxied.length === mirrors.GH_PROXIES.length + 1, "ghProxyUrls 逐级产出代理 URL");
eqStr(mirrors.ghProxyUrls("https://example.com/x.zip").length, 1, "非 GitHub 链接不加代理");
/* 用户级覆盖：只认 MTNODE_* 三个显式变量 */
process.env.MTNODE_PIP_INDEX = "https://mirror.corp.example/simple";
process.env.MTNODE_NPM_REGISTRY = "https://npm.corp.example";
process.env.MTNODE_HF_ENDPOINT = "https://hf.corp.example";
const overridden = mirrors.installEnv();
eqStr(overridden.PIP_INDEX_URL, "https://mirror.corp.example/simple", "MTNODE_PIP_INDEX 可覆盖 pip 源（公司内网镜像）");
eqStr(overridden.PIP_EXTRA_INDEX_URL, "https://mirror.corp.example/simple", "覆盖时 extra-index 一起跟随");
eqStr(overridden.npm_config_registry, "https://npm.corp.example", "MTNODE_NPM_REGISTRY 可覆盖 npm 源");
eqStr(overridden.HF_ENDPOINT, "https://hf.corp.example", "MTNODE_HF_ENDPOINT 可覆盖权重回退源");
ok(mirrors.banner("unit test").indexOf("镜像源") >= 0, "banner 会打出这次实际用的源");
eqStr(mirrors.summary().weightSources[0], mirrors.MODELSCOPE, "权重源顺序：ModelScope 优先");
delete process.env.MTNODE_PIP_INDEX;
delete process.env.MTNODE_NPM_REGISTRY;
delete process.env.MTNODE_HF_ENDPOINT;

/* ---------------- [2] 打包白名单 ---------------- */
console.log("\n[2] 打包白名单");
has(read("build.json"), '"cn-mirrors.js"', "build.json files 含 cn-mirrors.js（漏了就是打包后 Cannot find module）");

/* ---------------- [3] 插件宿主 ---------------- */
console.log("\n[3] 7 个插件宿主的安装环境");
const HOSTS = [
  ["breeze", "breeze/main-breeze.js"],
  ["llama", "llama/main-llama.js"],
  ["h3", "h3/main-h3.js"],
  ["music3", "music3/main-music3.js"],
  ["yue", "yue/main-yue.js"],
  ["sensenova", "sensenova/main-sensenova.js"],
  ["remotion", "remotion/main-remotion.js"],
];
for (const [id, rel] of HOSTS) {
  const src = read(rel);
  has(src, 'require("../cn-mirrors.js")', id + " require 统一真源");
  has(src, "mirrors.installEnv(", id + " 安装链用 mirrors.installEnv() 下发国内源");
  has(src, "mirrors.banner(", id + " 安装日志打出实际使用的源");
  hasnt(src, '"https://hf-mirror.com"', id + " 不再自己写死 hf-mirror 字面量");
  hasnt(src, "https://pypi.org/simple", id + " 宿主里没有官方 PyPI 作为默认源");
  const code = codeLines(src);
  hasnt(code, '"install", "--isolated"', id + " 命令层不再带 pip --isolated（它会忽略 PIP_*）");
  hasnt(code, '"--isolated",', id + " 参数数组里也没有 --isolated");
}

/* ---------------- [4] 随包安装脚本 ---------------- */
console.log("\n[4] 7 个随包安装脚本的源口径");
const PACKS = [
  { id: "breeze", rel: "breeze-pack/scripts/install.ps1", pip: true, torch: true, weights: "breeze-pack/scripts/download_weights.py", modelscope: true, ghChain: true },
  { id: "llama", rel: "llama-pack/scripts/install.ps1", pip: true, torch: false, weights: "llama-pack/scripts/install.ps1", modelscope: false, ghChain: true },
  { id: "h3", rel: "h3-pack/scripts/setup_env.ps1", pip: true, torch: true, weights: "h3-pack/scripts/download_models.ps1", modelscope: true, ghChain: false,
    extraPipChain: ["h3-pack/scripts/repair_torch_kitchen.ps1"],
    pipStepScript: "h3-pack/scripts/install.ps1", pack: "h3-pack" },
  { id: "music3", rel: "music3-pack/scripts/setup_env.ps1", pip: true, torch: false, weights: "music3-pack/scripts/download_models.ps1", modelscope: true, ghChain: false,
    extraPipChain: [],
    pipStepScript: "music3-pack/scripts/install.ps1", pack: "music3-pack" },
  /* YuE2 的权重仓库（m-a-p/YuE2-3B）只走 hf-mirror：它没有可用的 ModelScope 同名仓库，
     所以这一条只钉「hf-mirror + HF_ENDPOINT」，不要求 ModelScope（见 docs/mirror-sources.md）。 */
  { id: "yue", rel: "yue-pack/scripts/install.ps1", pip: true, torch: true, weights: "yue-pack/scripts/install.ps1", modelscope: false, ghChain: false },
  { id: "sensenova", rel: "sensenova-pack/scripts/install.ps1", pip: true, torch: true, weights: "sensenova-pack/scripts/install.ps1", modelscope: true, ghChain: true },
  /* remotion 装的是 npm 依赖，没有 pip / 权重链：只钉 npm 默认源（见 [4b]） */
  { id: "remotion", rel: "remotion-pack/scripts/install.ps1", pip: false, torch: false, weights: "", modelscope: false, ghChain: false },
];
for (const p of PACKS) {
  ok(exists(p.rel), p.id + " 安装脚本存在（" + p.rel + "）");
  const src = read(p.rel);
  const code = codeLines(src);
  if (p.pip) {
    has(src, "pypi.tuna.tsinghua.edu.cn", p.id + " 脚本里有清华 pip 源");
    has(src, "PIP_INDEX_URL", p.id + " 下发 PIP_INDEX_URL");
    has(src, "PIP_EXTRA_INDEX_URL", p.id + " 下发 PIP_EXTRA_INDEX_URL（压掉机器级 pip.ini 的不可达 extra-index）");
    has(src, "PIP_TRUSTED_HOST", p.id + " 下发 PIP_TRUSTED_HOST");
    hasnt(code, "--isolated", p.id + " 命令行不再带 pip --isolated（它会把 PIP_* 一起忽略）");
    hasnt(code, 'PIP_EXTRA_INDEX_URL = ""', p.id + " 不再用「清空 extra-index」的旧写法");
    /* 官方源只允许出现在国内源之后（作为最后一级兜底）—— 只看会干活的行，注释与横幅不算 */
    const work = workLines(src);
    const off = work.indexOf("pypi.org/simple");
    if (off >= 0) ok(work.indexOf("pypi.tuna.tsinghua.edu.cn") < off, p.id + " 官方 PyPI 只作为最后一级兜底（干活的行里排在国内源之后）");
    /* pip 索引回退链：单级源在「镜像只缺一个子包」时会整步失败（2026-10 现场：
       comfyui-workflow-templates-media-assets-02==0.1.11 清华与 USTC 都没同步）。
       本轮只覆盖 h3 与 music3（见每条的 extraPipChain / pipStepScript）：
       干活的行里必须凑齐 ≥3 个国内/官方索引、官方排最后，并且真的逐级走链。 */
    if (p.extraPipChain) {
      const chainSrcs = [p.rel].concat(p.extraPipChain);
      for (const rel of chainSrcs) {
        const w = workLines(read(rel));
        const offAt = w.indexOf("pypi.org/simple");
        const dom = ["pypi.tuna.tsinghua.edu.cn", "mirrors.aliyun.com/pypi", "mirrors.ustc.edu.cn/pypi"].filter((s) => w.indexOf(s) >= 0);
        ok(offAt >= 0 && dom.length >= 2, rel + " 干活的行里有 ≥3 个 pip 索引（国内 " + dom.length + " + 官方）");
        ok(offAt < 0 || dom.every((s) => w.indexOf(s) >= 0 && w.indexOf(s) < offAt), rel + " 官方 PyPI 排在全部国内索引之后");
        has(w, "$PipIndexChain", rel + " 索引链是显式数组（逐级可查）");
        has(w, "$PipIndexChain.Count", rel + " 真的按链长度逐级迭代");
        /* 这两句是脚本往安装窗打的进度行（Write-Host），workLines 会把它们滤掉，所以查原文。 */
        has(read(rel), "pip index=$n/$($PipIndexChain.Count) host=$host_", rel + " 每次尝试都打一行「第几级 / 用的哪个源」");
        has(read(rel), "falling back to the next index", rel + " 一级失败继续走下一级");
      }
      /* 这一句是脚本自带的失败契约说明（注释）：全级失败时 pip 的原始输出里是
         「No matching distribution found for <包名>」，脚本把日志尾部当 tail 参数附给失败步。 */
      has(read(p.pipStepScript), "No matching distribution found for", p.id + " 安装脚本写明全级失败时点名缺哪个包（pip 原文 No matching distribution found for <pkg>）");
      /* 「pip 已依次试过清华 / 阿里云 / USTC / 官方 PyPI」与「No matching distribution found for
         某包」这两句给人看的话，本轮从安装脚本（必须纯 ASCII）搬进了同包 steps.json 的
         messages 失败文案表，由宿主按错误码解析。判据跟着落到文案表上。 */
      const failTable = JSON.stringify((JSON.parse(read(p.pack + "/steps.json")).steps || []).map((s) => s.messages || {}));
      ok(
        failTable.indexOf("清华") >= 0 && failTable.indexOf("USTC") >= 0,
        p.id + " 安装编排的失败文案（steps.json messages 表）写明「pip 已走完四级源」",
      );
      ok(
        failTable.indexOf("No matching distribution found for") >= 0,
        p.id + " 失败文案（steps.json messages 表）全级失败时点名缺哪个包",
      );
    }
  }
  if (p.torch) {
    /* torch 顺序只在**CUDA 轮子**那条链上比：`-Cpu` 后门分支本来就只有官方 `whl/cpu` 一种来源
       （国内镜像链里没有这份 CPU 轮子），把它算进来会得出「官方优先」的假结论。 */
    const work = workLines(src)
      .split("\n")
      .filter((l) => !/pytorch\.org\/whl\/cpu/i.test(l))
      .join("\n");
    const firstDomestic = Math.min(
      ...[work.indexOf("mirror.sjtu.edu.cn/pytorch-wheels"), work.indexOf("mirrors.aliyun.com/pytorch-wheels")].filter((i) => i >= 0),
    );
    const official = work.indexOf("download.pytorch.org");
    ok(Number.isFinite(firstDomestic), p.id + " torch 走国内镜像（SJTU / 阿里云）");
    ok(official < 0 || firstDomestic < official, p.id + " torch 国内镜像排在官方之前（CUDA 链，干活的行里）");
  }
  if (p.weights) {
    ok(exists(p.weights), p.id + " 权重下载脚本存在（" + p.weights + "）");
    const wc = codeLines(read(p.weights));
    has(wc, "hf-mirror", p.id + " 权重走 hf-mirror");
    if (p.modelscope) {
      const ms = wc.toLowerCase().indexOf("modelscope");
      const hf = wc.indexOf("hf-mirror", ms);
      ok(ms >= 0, p.id + " 权重主源先用 ModelScope");
      ok(hf > ms || /HF_ENDPOINT/.test(wc), p.id + " hf-mirror 作为 ModelScope 之后的回退端点");
    }
  }
}
console.log("\n[4c] 全量清扫：所有 *-pack 脚本里都不再有 pip --isolated / 清空 extra-index 的旧写法");
/** 递归收集仓库根下所有 `*-pack/` 里的脚本（.ps1 / .py / .cmd）——含辅助脚本与自修复脚本。 */
function packScripts() {
  const out = [];
  for (const entry of fs.readdirSync(ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/-pack$/.test(entry.name)) continue;
    const walk = (dir) => {
      for (const it of fs.readdirSync(dir, { withFileTypes: true })) {
        if (it.name === "node_modules" || it.name === ".git" || it.name === "venv" || it.name === ".venv") continue;
        const p = path.join(dir, it.name);
        if (it.isDirectory()) walk(p);
        else if (/\.(ps1|py|cmd)$/i.test(it.name)) out.push(path.relative(ROOT, p).split(path.sep).join("/"));
      }
    };
    walk(path.join(ROOT, entry.name));
  }
  return out.sort();
}
const PACK_SCRIPTS = packScripts();
ok(PACK_SCRIPTS.length >= 20, "扫到 " + PACK_SCRIPTS.length + " 个随包脚本（含辅助脚本）");
for (const rel of PACK_SCRIPTS) {
  const work = workLines(read(rel));
  hasnt(work, "--isolated", rel + " 无 pip --isolated（它会忽略 PIP_* 环境变量）");
  hasnt(work, 'PIP_EXTRA_INDEX_URL = ""', rel + " 无「清空 extra-index」的旧写法");
}
/* GitHub 直连处必须带代理回退：走归档下载 / git clone 的包要求成链（≥ 3 个代理），
   只做 pip `git+https://github.com/` 改写的那类（music3）命中 1 个即算数。 */
for (const p of PACKS) {
  const src = read(p.rel);
  if (!/github\.com/i.test(codeLines(src))) continue;
  const used = mirrors.GH_PROXIES.filter((u) => src.indexOf(u.replace(/^https:\/\//, "")) >= 0);
  const need = p.ghChain ? 3 : 1;
  ok(used.length >= need, p.id + " GitHub 下载带代理回退（命中 " + used.length + " 个，要求 ≥" + need + "）");
}
console.log("\n[4b] npm 默认源");
const remotionPs = read("remotion-pack/scripts/install.ps1");
const remotionWork = workLines(remotionPs);
has(remotionPs, "registry.npmmirror.com", "remotion 安装脚本用 npmmirror");
const npmjsAt = remotionWork.indexOf("registry.npmjs.org");
ok(npmjsAt < 0 || remotionWork.indexOf("registry.npmmirror.com") < npmjsAt, "remotion 官方 npm 源只作为可选项，排在 npmmirror 之后");
for (const rel of ["remotion-pack/install.cmd", "remotion-pack/steps.json", "remotion-pack/README.md"]) {
  has(read(rel), "npmmirror", rel + " 写明默认走 npmmirror");
}

/* ---------------- [5] Remotion 浏览器 ---------------- */
console.log("\n[5] Remotion 的 Chrome Headless Shell");
const remotionHost = read("remotion/main-remotion.js");
has(remotionHost, "ensureRenderBrowser", "宿主有代下 / 预置浏览器的入口");
has(remotionHost, "CHROME_FOR_TESTING_MIRROR", "走 npmmirror 的 chrome-for-testing 镜像");
has(remotionHost, "chrome-headless-shell-", "按 Remotion 的缓存布局放 zip 内容");
has(remotionHost, "VERSION", "写 Remotion 认的 VERSION 文件（否则它判 version-mismatch 又去撞官方直链）");
has(remotionHost, "findLocalChromium", "代下失败回退本机 Chromium 系浏览器");
has(remotionHost, "msedge.exe", "本机兜底包含 Edge");
hasnt(remotionHost, "storage.googleapis.com", "宿主里不出现 Remotion 那条硬编码的 Google 直链");
has(read("remotion-pack/render.mjs"), "browserExecutable", "render.mjs 支持 browserExecutable");
has(read("remotion-pack/render.mjs"), "MTNODE_REMOTION_BROWSER_EXECUTABLE", "render.mjs 支持环境变量覆盖浏览器路径");

/* ---------------- [6] 语音权重与网关 npm ---------------- */
console.log("\n[6] 语音权重默认源 + 网关 npm registry");
const dshSrc = read("dsh/main-dsh.js");
has(dshSrc, "mirrors.installEnv().npm_config_registry", "网关 spawn 时把 npm registry 钉在 npmmirror");
has(dshSrc, "p.downloadSource = mirrors.HF_ENDPOINT", "语音权重默认源钉在统一真源的 hf-mirror");
has(dshSrc, "action === 'prepare'", "只对 prepare（下载权重那一步）注入默认源");
has(read("main.js"), "语音权重（约 239MB）的**国内镜像默认源**在 dsh/main-dsh.js", "main.js 注释指认默认源的唯一收口（不在两处各写一份）");
hasnt(read("main.js"), "downloadSource = mirrors.HF_ENDPOINT", "main.js 不再自己兜一份默认源（收口在 dsh 适配器）");

/* ---------------- [7] 纪律：不动用户机器全局配置 ---------------- */
console.log("\n[7] 不修改用户机器上的全局 pip / npm 配置");
const touched = HOSTS.map(([, rel]) => rel).concat(PACKS.map((p) => p.rel));
for (const rel of touched) {
  const src = read(rel);
  hasnt(src, "npm config set", rel + " 不改用户 npm 全局配置");
  hasnt(src, "pip config set", rel + " 不改用户 pip 全局配置");
  hasnt(src, "ProgramData\\pip", rel + " 不碰机器级 pip 配置目录");
}
has(read("cn-mirrors.js"), "不动用户机器上的 pip.ini", "统一真源写明「不动机器级 pip.ini」这条纪律");

/* ---------------- [8] 文档与技能 ---------------- */
console.log("\n[8] 文档 / 技能同步");
ok(exists("docs/mirror-sources.md"), "docs/mirror-sources.md 存在（口径说明页）");
has(read("docs/mirror-sources.md"), "cn-mirrors.js", "口径页指向单一真源 cn-mirrors.js");
const SKILLS = [
  "skills/sensenova-local-install/SKILL.md",
  "skills/minimax-h3-install/SKILL.md",
  "skills/breeze-tts-local-install/SKILL.md",
  "skills/llama-local-install/SKILL.md",
  "skills/yue2-local-install/SKILL.md",
];
for (const rel of SKILLS) {
  if (!exists(rel)) {
    ok(false, rel + " 存在");
    continue;
  }
  const src = read(rel);
  has(src, "PIP_EXTRA_INDEX_URL", rel + " 写明 PIP_* 三件套覆盖（含 extra-index）");
  has(src, "hf-mirror", rel + " 权重写明 hf-mirror");
}
has(read("skills/office-local-install/SKILL.md"), "--registry=https://registry.npmmirror.com", "Office→PDF 安装技能默认走 npmmirror（官方源只作兜底）");
has(read("plugins/install-step-reporter.js"), "registry.npmmirror.com", "安装失败提示语写明 npm 已默认走 npmmirror");

console.log("\n" + (fails === 0 ? "smoke-cn-mirrors：全部通过" : "smoke-cn-mirrors：失败 " + fails + " 项") + "（共 " + checks + " 项）");
process.exitCode = fails === 0 ? 0 : 1;
