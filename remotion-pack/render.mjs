#!/usr/bin/env node
/**
 * MTNode Remotion 渲染脚本。
 *
 * 用法: node render.mjs [render.json 路径，默认 ./render.json]
 *
 * 读取 render.json 后调用 @remotion/renderer 的 renderMedia() 渲染视频，
 * 进度以 JSON Lines 逐行输出到 stdout：
 *   {"type":"bundled","serveUrl":"..."}              （就地打包时）
 *   {"type":"progress","progress":0.42}               （0.5% 步进节流）
 *   {"type":"done","outputLocation":"out/output.mp4","codec":"h264",...}
 *   {"type":"error","message":"..."}                  （失败，exit 1）
 *
 * render.json 字段（其余为可选）：
 *   entryPoint      string  入口文件，默认 "src/index.tsx"
 *   serveUrl        string  宿主预打包后的 bundle 地址/路径（可选；缺省则就地打包）
 *   composition     string  合成 id，默认 "MTNodeRemotion"
 *   outputLocation  string  输出视频路径，默认 "out/output.mp4"
 *   codec           string  默认 "h264"（渲染 h264 视频）
 *   fps / width / height / durationInFrames
 *                   number  覆盖合成参数（可选，缺省用模板占位值）
 *   inputProps      object  传给合成的 props（可选）
 *   concurrency / jpegQuality / audioCodec / logLevel
 *                           透传给 renderMedia（可选）
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import {fileURLToPath} from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const configPath = path.resolve(here, process.argv[2] || 'render.json');

const DEFAULTS = {
  entryPoint: 'src/index.tsx',
  composition: 'MTNodeRemotion',
  outputLocation: 'out/output.mp4',
  codec: 'h264',
  logLevel: 'info',
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
  const cfg = {...DEFAULTS, ...JSON.parse(fs.readFileSync(configPath, 'utf8'))};

  const {selectComposition, renderMedia} = await import('@remotion/renderer');

  // serveUrl：宿主可预打包后写入 render.json；缺省则就地用 @remotion/bundler 打包 entryPoint。
  let serveUrl = cfg.serveUrl || null;
  if (!serveUrl) {
    const {bundle} = await import('@remotion/bundler');
    serveUrl = await bundle({
      entryPoint: path.resolve(here, cfg.entryPoint),
      onProgress: (p) => emit({type: 'bundleProgress', progress: p}),
    });
    emit({type: 'bundled', serveUrl});
  }

  const inputProps = cfg.inputProps ?? {};
  const selected = await selectComposition({serveUrl, id: cfg.composition, inputProps});
  const composition = {
    ...selected,
    ...(cfg.fps != null ? {fps: cfg.fps} : {}),
    ...(cfg.width != null ? {width: cfg.width} : {}),
    ...(cfg.height != null ? {height: cfg.height} : {}),
    ...(cfg.durationInFrames != null ? {durationInFrames: cfg.durationInFrames} : {}),
  };

  const outputLocation = path.resolve(here, cfg.outputLocation);
  fs.mkdirSync(path.dirname(outputLocation), {recursive: true});

  let lastBucket = -1;
  await renderMedia({
    composition,
    serveUrl,
    codec: cfg.codec,
    outputLocation,
    inputProps,
    logLevel: cfg.logLevel,
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
