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
 *                   浏览器可执行文件路径（宿主现在**几乎总是**给）：npmmirror 代下的
 *                   chrome-headless-shell 预置在 <安装目录>/node_modules/.remotion，宿主把那份
 *                   exe 绝对路径交过来 —— 必须给，否则 Remotion 按 process.cwd() 去
 *                   <工程目录>/.remotion 找，找不到就重下 113MB（每换一个工程目录重下一遍）。
 *                   代下失败时才落到本机 Edge / Chrome（Remotion 会警告版本非钉版、确定性略降）。
 *                   也可用环境变量 MTNODE_REMOTION_BROWSER_EXECUTABLE 传同一个值。
 *   concurrency / jpegQuality / audioCodec / logLevel
 *                           透传给 renderMedia（可选）
 *   mediaBlobs      object  宿主内联的媒体二进制（可选）：{ hero?: base64, voice?: base64, poster?: base64 }
 *                           为什么要有它：宿主的 inlineMediaPropsOf 以前把媒体直接写成
 *                           `data:video/mp4;base64,...` 塞进 inputProps，而 Remotion 的
 *                           <OffthreadVideo> 会把 src 原样拼进 `/proxy?src=<编码后的整个 data URL>`，
 *                           1.9MB 的片子就是一个 2.6MB 长的查询串 → 浏览器报
 *                           `431 Request Header Fields Too Large`，整条渲染失败
 *                           （<Img> 走的是另一条路，所以同一份 data URL 图片反而正常）。
 *                           本脚本在打包前把原始字符串换成规范化的 data URL（只重编码一次），
 *                           打包后再按本文件的规则把**压缩版**写回。
 *   mediaBlobsMeta  object  可选：{ hero: {mime}, voice: {mime}, poster: {mime} }，缺省按 contentType 推断
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import {fileURLToPath} from 'node:url';
import {dataUrlToMedia, unpackMediaBlobs, describeMedia, parkedName} from './pack/park-media.mjs';

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

  /* ── 媒体落地（见 pack/park-media.mjs 顶部说明）────────────────────────────
     宿主以前把音视频当 data URL 直接放进 inputProps：<OffthreadVideo> 会把它拼进
     `/proxy?src=...`，2MB 级别的片子直接 431。这里把视频 / 音频写成
     <projectDir>/public/<prop>.<ext>，渲染页用短文件名取（Remotion 静态根 = 工程目录）。
     图片不动：<Img> 不走 proxy，data URL 对它是安全的。 */
  const inputProps = {...(cfg.inputProps ?? {})};
  const mediaReport = [];
  const parked = {...unpackMediaBlobs(cfg)};
  /* 兼容老宿主：data URL 仍出现在 inputProps 里时，这里就地接管并清空该键 */
  for (const prop of ['hero', 'voice']) {
    const value = inputProps[prop];
    if (typeof value === 'string' && /^data:/i.test(value.trim())) {
      const media = dataUrlToMedia(value, prop);
      if (media) {
        parked[prop] = media;
        delete inputProps[prop];
      }
    }
  }
  /* 落点：**bundle 根**。Remotion 的 staticFile() 在渲染进程里生成的是
     public/<文件名>（见 remotion/dist/cjs/static-file.js），服务根就是 bundle 目录，
     所以媒体必须落在 <bundle>/public/ 下；工程里也留一份 public/ 便于重渲复用，
     打包后由这里的 copy 同步过去。 */
  const publicDir = path.join(projectDir, 'public');
  const parkedNames = [];
  for (const [prop, media] of Object.entries(parked)) {
    /* 契约通道：宿主已在 meta.name 里定好文件名（含数组项序号），这里只照写，
       再把文件名回填到 props[meta.key]（数组端子落到第 meta.index 项）。 */
    const name = media.name || parkedName(prop, media.contentType);
    fs.mkdirSync(publicDir, {recursive: true});
    fs.writeFileSync(path.join(publicDir, name), media.bytes);
    /* 合成层的 assetSrc() 对裸文件名会走 staticFile()，与落点对齐 */
    if (media.key) {
      if (media.index >= 0) {
        const cur = inputProps[media.key];
        const arr = Array.isArray(cur) ? cur : [];
        arr[media.index] = name;
        inputProps[media.key] = arr;
      } else {
        inputProps[media.key] = name;
      }
    } else {
      inputProps[prop] = name;
    }
    parkedNames.push(name);
    mediaReport.push(`${prop}→${name} ${describeMedia(media)}`);
  }
  if (mediaReport.length) emit({type: 'media', parked: mediaReport});

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
    /* 媒体进 bundle：staticFile() 要的是 <bundle>/public/<文件名>，与工程 public/ 对齐 */
    if (parkedNames.length) {
      const bundlePublic = path.join(serveUrl, 'public');
      fs.mkdirSync(bundlePublic, {recursive: true});
      for (const name of parkedNames) {
        fs.copyFileSync(path.join(publicDir, name), path.join(bundlePublic, name));
      }
      emit({type: 'media', bundled: parkedNames.map((n) => 'public/' + n)});
    }
    emit({type: 'bundled', serveUrl});
  }

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
      const bucket = Math.floor(progress * 200); // 0.5% 步进，避免刷屏
      if (bucket !== lastBucket) {
        lastBucket = bucket;
        emit({type: 'progress', progress});
      }
    },
  });

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

