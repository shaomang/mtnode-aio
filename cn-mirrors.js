"use strict";
/**
 * 国内镜像源单一真源 —— 插件 / 后端**安装链**共用（8 个插件宿主 + 网关）
 *
 * 口径（用户确认）：
 *   · pip    清华 → 阿里云 / USTC → 官方（官方只做最后一级兜底）
 *   · torch  SJTU → 阿里云 pytorch-wheels → 官方
 *   · 权重   ModelScope 优先 → hf-mirror → 官方
 *   · npm    registry.npmmirror.com
 *   · git    ghfast.top → gh-proxy.com → ghproxy.net
 *   · 二进制 node / uv / ffmpeg / chrome-for-testing 一律 npmmirror
 *
 * 关键坑（真机实测，本次报错就是它）：
 *   本机**机器级** pip.ini 常被 NVIDIA PyIndex 塞进
 *   `extra-index-url = https://pypi.ngc.nvidia.com`，国内 DNS 直接失败。
 *   命令行只写 `--index-url` 覆盖不了 extra-index-url，于是每个包白等 5 次重试
 *   （日志里那串 NameResolutionError / pypi.ngc.nvidia.com）。
 *   正解：用 PIP_* 环境变量在**安装子进程内**把 index / extra-index / trusted-host
 *   一起盖掉（不动用户机器上的 pip.ini）；并且**不要**用 `pip --isolated` ——
 *   它忽略环境变量与用户级 config，机器级 extra-index 照样生效，等于白设。
 *
 * 宿主用法（不要各自再抄一份 hex / host）：
 *   const mirrors = require("../cn-mirrors.js");
 *   await runPs(script, args, { env: mirrors.installEnv({ MT_XX: "..." }) });
 *   console.log(mirrors.banner("h3 install"));
 */

const PIP_INDEX = "https://pypi.tuna.tsinghua.edu.cn/simple";
const PIP_TRUSTED_HOST = "pypi.tuna.tsinghua.edu.cn";
const PIP_FALLBACKS = ["https://mirrors.aliyun.com/pypi/simple/", "https://mirrors.ustc.edu.cn/pypi/simple/"];
const PIP_OFFICIAL = "https://pypi.org/simple";

const TORCH_MIRRORS = ["https://mirror.sjtu.edu.cn/pytorch-wheels", "https://mirrors.aliyun.com/pytorch-wheels"];
const TORCH_OFFICIAL = "https://download.pytorch.org/whl";

const NPM_REGISTRY = "https://registry.npmmirror.com";
const NPM_OFFICIAL = "https://registry.npmjs.org";

const MODELSCOPE = "https://www.modelscope.cn";
const HF_ENDPOINT = "https://hf-mirror.com";
const HF_OFFICIAL = "https://huggingface.co";

/* GitHub 代理回退链：前三个是 sensenova 链实测可用的，ghproxy.com 是各 pack 原有写法（保留，
   失败就下一个，最后才直连）。 */
const GH_PROXIES = [
  "https://ghfast.top",
  "https://gh-proxy.com",
  "https://ghproxy.net",
  "https://ghproxy.com",
];

const BIN_MIRROR = "https://registry.npmmirror.com/-/binary";
const PYTHON_STANDALONE_MIRROR = BIN_MIRROR + "/python-build-standalone";
const NODE_BIN_MIRROR = BIN_MIRROR + "/node";
const ELECTRON_MIRROR = BIN_MIRROR + "/electron/";
const CHROME_FOR_TESTING_MIRROR = BIN_MIRROR + "/chrome-for-testing";

/** pip 三级链（国内优先，官方最后一级兜底）。 */
function pipIndexChain() {
  return [PIP_INDEX].concat(PIP_FALLBACKS, [PIP_OFFICIAL]);
}

/** torch 轮子索引链：<base>/<cuXXX>，官方最后。 */
function torchIndexChain(cu) {
  const suffix = String(cu || "").replace(/^\/+/, "");
  const tail = suffix ? "/" + suffix : "";
  return TORCH_MIRRORS.map((b) => b + tail).concat([TORCH_OFFICIAL + tail]);
}

/**
 * GitHub 直链的国内代理回退链（按顺序试，第一个成功即用）。
 * 只用于**下载归档 / release**；不改用户机器上的 git 全局配置。
 */
function ghProxyUrls(url) {
  const u = String(url || "");
  if (!/^https?:\/\/(www\.)?github\.com\//i.test(u)) return [u];
  return GH_PROXIES.map((p) => p.replace(/\/+$/, "") + "/" + u).concat([u]);
}

/** 用户级覆盖（显式设了才生效）：MTNODE_PIP_INDEX / MTNODE_NPM_REGISTRY / MTNODE_HF_ENDPOINT。 */
function envOverride(name, fallback) {
  const v = process.env[name];
  return v && String(v).trim() ? String(v).trim() : fallback;
}

/**
 * 安装子进程统一环境变量。
 * 用户级覆盖只走 MTNODE_*（与各包既有的 MT_H3_PIP_INDEX / BREEZE_TORCH_INDEX 并存）；
 * extra 后写，所以插件自己的覆盖项照旧生效。
 */
function installEnv(extra) {
  const pipIndex = envOverride("MTNODE_PIP_INDEX", PIP_INDEX);
  const npmRegistry = envOverride("MTNODE_NPM_REGISTRY", NPM_REGISTRY);
  const hfEndpoint = envOverride("MTNODE_HF_ENDPOINT", HF_ENDPOINT);
  return Object.assign(
    {
      /* pip：三个一起设（只设 index 盖不住机器级 extra-index） */
      PIP_INDEX_URL: pipIndex,
      PIP_EXTRA_INDEX_URL: pipIndex,
      PIP_TRUSTED_HOST: PIP_TRUSTED_HOST,
      PIP_DISABLE_PIP_VERSION_CHECK: "1",
      PIP_NO_INPUT: "1",
      PIP_DEFAULT_TIMEOUT: "60",
      /* 权重：HF 一律走镜像 + 关掉 xet（xet 走 cas-server，镜像站不支持） */
      HF_ENDPOINT: hfEndpoint,
      HF_HUB_DISABLE_XET: "1",
      /* npm / pnpm：DSH 扩展安装、remotion npm install 都吃这两个名 */
      npm_config_registry: npmRegistry,
      NPM_CONFIG_REGISTRY: npmRegistry,
      /* uv（python-build-standalone）与 electron 二进制 */
      UV_PYTHON_INSTALL_MIRROR: PYTHON_STANDALONE_MIRROR,
      UV_DEFAULT_INDEX: pipIndex,
      ELECTRON_MIRROR: ELECTRON_MIRROR,
    },
    extra || {},
  );
}

/** 安装日志用的一行「这次实际用的是哪些源」——出问题时一眼看出卡在哪。 */
function banner(label) {
  const e = installEnv();
  return (
    "[" +
    (label || "install") +
    "] 镜像源：pip=" +
    e.PIP_INDEX_URL +
    "（回退 " +
    PIP_FALLBACKS.join(" / ") +
    " → 官方）· 权重=" +
    MODELSCOPE +
    " → " +
    e.HF_ENDPOINT +
    " · npm=" +
    e.npm_config_registry +
    " · git 代理=" +
    GH_PROXIES.join(" / ")
  );
}

/** 与 banner 同源的字段版（宿主控制台按行打，或写进 installed.json 排障用）。 */
function summary() {
  const e = installEnv();
  return {
    pipIndex: e.PIP_INDEX_URL,
    pipExtraIndex: e.PIP_EXTRA_INDEX_URL,
    pipTrustedHost: e.PIP_TRUSTED_HOST,
    pipFallbacks: PIP_FALLBACKS.slice(),
    torchIndices: TORCH_MIRRORS.slice(),
    npmRegistry: e.npm_config_registry,
    weightSources: [MODELSCOPE, e.HF_ENDPOINT, HF_OFFICIAL],
    hfEndpoint: HF_ENDPOINT,
    ghProxies: GH_PROXIES.slice(),
  };
}

module.exports = {
  PIP_INDEX,
  PIP_TRUSTED_HOST,
  PIP_FALLBACKS,
  PIP_OFFICIAL,
  TORCH_MIRRORS,
  TORCH_OFFICIAL,
  NPM_REGISTRY,
  NPM_OFFICIAL,
  MODELSCOPE,
  HF_ENDPOINT,
  HF_OFFICIAL,
  GH_PROXIES,
  BIN_MIRROR,
  PYTHON_STANDALONE_MIRROR,
  NODE_BIN_MIRROR,
  ELECTRON_MIRROR,
  CHROME_FOR_TESTING_MIRROR,
  pipIndexChain,
  torchIndexChain,
  ghProxyUrls,
  installEnv,
  banner,
  summary,
};
