#!/usr/bin/env node
/**
 * MTNode Remotion 渲染脚本。
 *
 * 用法: node <安装目录>\render.mjs <render.json 绝对路径>
 *
 * 路径分工（重要）：本脚本住在**安装目录**（依赖源，只有 node_modules），
 * 而工程（index.tsx / Composition.tsx）与成片住在**画布工作目录**：
 *   <工作目录>/.mtnode/remotion/<节点 id>/
 * 所以 render.json 里的 entryPoint / outputLocation / projectDir / nodeModulesDir 一律由
 * MTNode 主进程写成**绝对路径**，本脚本不再按「当前目录」猜任何东西；依赖（react / remotion）
 * 靠 nodeModulesDir 注入到 webpack 的 resolve.modules，工作目录里不需要 node_modules。
 *
 * 读取 render.json 后调用 @remotion/renderer 的 renderMedia() 渲染视频，
 * 进度以 JSON Lines 逐行输出到 stdout：
 *   {"type":"bundled","serveUrl":"..."}              （就地打包时）
 *   {"type":"progress","progress":0.42}               （0.5% 步进节流）
 *   {"type":"done","outputLocation":"out/output.mp4","codec":"h264",...}
 *   {"type":"error","message":"..."}                  （失败，exit 1）
 *
 * render.json 字段（其余为可选）：
 *   entryPoint      string  入口文件（绝对路径优先；相对路径按安装目录解析）
 *   projectDir      string  工程目录（宿主注入，仅用于日志与相对路径基准）
 *   nodeModulesDir  string  依赖源（安装目录的 node_modules，绝对路径）
 *   serveUrl        string  宿主预打包后的 bundle 地址/路径（可选；缺省则就地打包）
 *   composition     string  合成 id，默认 "MTNodeRemotion"
 *   outputLocation  string  输出视频路径（绝对路径优先；相对路径按安装目录解析）
 *   codec           string  默认 "h264"（渲染 h264 视频）
 *   fps / width / height / durationInFrames
 *                   number  覆盖合成参数（可选，缺省用模板占位值）
 *   inputProps      object  传给合成的 props（可选）
 *   browserExecutable string
 *                   本机 Chromium 系浏览器路径（可选）。国内网络拿不到 Remotion 硬编码的
 *                   storage.googleapis.com 下载直链时，宿主会先尝试从 npmmirror 代下
 *                   chrome-headless-shell 预置到 node_modules/.remotion；代下也失败才落到这里，
 *                   用本机 Edge / Chrome 渲染（Remotion 会警告版本非钉版、渲染确定性略降）。
 *                   也可用环境变量 MTNODE_REMOTION_BROWSER_EXECUTABLE 传同一个值。
 *   concurrency / jpegQuality / audioCodec / logLevel
 *                           透传给 renderMedia（可选）
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import {fileURLToPath} from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
/* 安装目录 = 本脚本所在目录（依赖源）；工程目录由宿主注入 */
const installDir = path.resolve(here);
const rawConfig = process.argv[2] || 'render.json';
const configPath = path.isAbsolute(rawConfig) ? rawConfig : path.resolve(here, rawConfig);

const DEFAULTS = {
  entryPoint: 'index.tsx',
  composition: 'MTNodeRemotion',
  outputLocation: 'out/output.mp4',
  codec: 'h264',
  logLevel: 'info',
};

/** 宿主给的是绝对路径就原样用；相对路径按安装目录解析（老 render.json 的兼容口径） */
const resolvePath = (p) => {
  const s = String(p || '').trim();
  if (!s) return '';
  return path.isAbsolute(s) ? path.resolve(s) : path.resolve(installDir, s);
};

const emit = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');
const fail = (msg) => {
  emit({type: 'error', message: String(msg)});
  process.exitCode = 1;
};

const main = async () => {
  if (!fs.existsSync(configPath)) {
    fail(`render.json not found: ${configPath}`);
    return;
  }
  /* 读 render.json 时先剥 BOM：外部手写 / 编辑器另存的 UTF-8 BOM 会让 JSON.parse 直接抛
     SyntaxError（宿主自己的 writeJson 不带 BOM，这里只是不让手工现场把渲染卡死） */
  const cfg = {
    ...DEFAULTS,
    ...JSON.parse(fs.readFileSync(configPath, 'utf8').replace(/^\uFEFF/, '')),
  };
  const projectDir = resolvePath(cfg.projectDir) || path.dirname(configPath);
  const nodeModulesDir = resolvePath(cfg.nodeModulesDir) || path.join(installDir, 'node_modules');
  emit({type: 'paths', installDir, projectDir, nodeModulesDir, configPath});

  const {selectComposition, renderMedia} = await import('@remotion/renderer');

  // serveUrl：宿主可预打包后写入 render.json；缺省则就地用 @remotion/bundler 打包 entryPoint。
  let serveUrl = cfg.serveUrl || null;
  if (!serveUrl) {
    const {bundle} = await import('@remotion/bundler');
    /* 依赖解析注入：工程的 import 来自工作目录，但 react / remotion 只装在安装目录里。
       resolve.modules 先看 nodeModulesDir 再看默认的 node_modules —— 工作目录里没有
       node_modules 也能解析，绝不在工作目录里造链接或复制依赖。 */
    const webpackOverride = (conf) => {
      const prev = (conf && conf.resolve && Array.isArray(conf.resolve.modules) && conf.resolve.modules) || [
        'node_modules',
      ];
      const modules = [];
      for (const m of [nodeModulesDir, ...prev]) {
        if (!modules.includes(m)) modules.push(m);
      }
      return {
        ...conf,
        resolve: {
          ...(conf && conf.resolve ? conf.resolve : {}),
          modules,
        },
      };
    };
    serveUrl = await bundle({
      entryPoint: resolvePath(cfg.entryPoint) || path.join(installDir, DEFAULTS.entryPoint),
      onProgress: (p) => emit({type: 'bundleProgress', progress: p}),
      webpackOverride,
    });
    emit({type: 'bundled', serveUrl});
  }

  const inputProps = cfg.inputProps ?? {};
  /* 浏览器口径：优先 render.json.browserExecutable，其次环境变量；都没有 = 让 Remotion 用
     它自己的 chrome-headless-shell 缓存（宿主已尽量从国内镜像预置好，见 main-remotion.js）。 */
  const browserExecutable =
    (typeof cfg.browserExecutable === 'string' && cfg.browserExecutable.trim()) ||
    (typeof process.env.MTNODE_REMOTION_BROWSER_EXECUTABLE === 'string' &&
      process.env.MTNODE_REMOTION_BROWSER_EXECUTABLE.trim()) ||
    null;
  const browserOpt = browserExecutable ? {browserExecutable} : {};
  if (browserExecutable) emit({type: 'browser', browserExecutable});
  const selected = await selectComposition({serveUrl, id: cfg.composition, inputProps, ...browserOpt});
  const composition = {
    ...selected,
    ...(cfg.fps != null ? {fps: cfg.fps} : {}),
    ...(cfg.width != null ? {width: cfg.width} : {}),
    ...(cfg.height != null ? {height: cfg.height} : {}),
    ...(cfg.durationInFrames != null ? {durationInFrames: cfg.durationInFrames} : {}),
  };

  const outputLocation =
    resolvePath(cfg.outputLocation) || path.join(projectDir, 'out', 'output.mp4');
  fs.mkdirSync(path.dirname(outputLocation), {recursive: true});

  let lastBucket = -1;
  /* 渲染桥看门：项目工程里的素材可能是宿主临时起的 127.0.0.1 地址（见 main-remotion.js 的
     startRenderBridge），渲染开始后就没人在取了 —— 空闲满 bridgeIdleMs 就上报 bridgeIdle，
     由宿主关掉那只一次性服务；本脚本不额外起进程，也不在中途抽走素材。 */
  const idleMs = Math.max(60000, Number(cfg.bridgeIdleMs) || 6 * 60 * 1000);
  let lastHit = Date.now();
  const watch = setInterval(() => {
    if (Date.now() - lastHit > idleMs) {
      emit({type: 'bridgeIdle'});
      lastHit = Date.now();
    }
  }, 5000);
  if (watch.unref) watch.unref();
  const progressTick = () => {
    lastHit = Date.now();
  };
  await renderMedia({
    composition,
    serveUrl,
    codec: cfg.codec,
    outputLocation,
    inputProps,
    logLevel: cfg.logLevel,
    ...browserOpt,
    ...(cfg.concurrency ? {concurrency: cfg.concurrency} : {}),
    ...(cfg.jpegQuality ? {jpegQuality: cfg.jpegQuality} : {}),
    ...(cfg.audioCodec ? {audioCodec: cfg.audioCodec} : {}),
    onProgress: ({progress}) => {
      progressTick();
      const bucket = Math.floor(progress * 200); // 0.5% 步进，避免刷屏
      if (bucket !== lastBucket) {
        lastBucket = bucket;
        emit({type: 'progress', progress});
      }
    },
  });
  clearInterval(watch);

  emit({
    type: 'done',
    outputLocation,
    codec: cfg.codec,
    width: composition.width,
    height: composition.height,
    fps: composition.fps,
    durationInFrames: composition.durationInFrames,
  });
};

main().catch((err) => fail(err?.stack || err?.message || err));
