---
name: remotion-render-encoding
title: 渲染、编码与发布
description: 把 Remotion 工程渲成文件：bundle/selectComposition/renderMedia/renderStill、并发与内存、codec 与 crf 取舍、Serverless 与 CI 部署、报错定位。要出成片时读它。
tags: 渲染,编码,crf,并发,部署,报错
version: 1.0.0
---

# 渲染、编码与发布

渲染是一次"把 React 逐帧截图再编码"的流水线：图片格式与并发决定速度，codec 与 crf 决定体积与画质。
**先渲 1 秒验证，再渲全片**——90% 的渲染事故都在前 30 帧暴露。

## 何时用

- 要把工程出成 mp4 / webm / gif / 封面 png，需要选参数。
- 渲染很慢、内存爆、`Target closed`、`Could not find composition`、音轨丢失。
- 要在 CI / 服务器 / Serverless 上跑，需要无人值守与重试。
- 在 MTNode 里用 `remotion-pack` 的 `render.mjs` 出片，需要知道 `render.json` 字段与产物位置。
- 不适用：动效本身不好看（去 animation / shot-recipes）。

## 核心原则

1. **一次 bundle，多次渲染**：批量与多版本必须在循环外 `bundle()`；每条重打包是最大的时间浪费。
2. **先 `selectComposition` 再 `renderMedia`**：合成不存在、props 校验失败都在这一步暴露，不要等渲完 3 分钟才知道。
3. **母版给足码率余量**：上传平台会二次压缩，母版用 `h264 + crf 16–18`；`crf 23` 只做预览。
4. **`pixelFormat` 默认 `yuv420p`**：需要透明通道才用 `yuva420p`（且 codec 必须是 `vp9` / `prores`）。
5. **并发留一半核**：`concurrency` 超过核数会互相抢内存，实测收益在 核数/2 附近饱和。
6. **输出路径必须可写且不在应用目录**：MTNode 场景下产物写画布工作目录，绝不写安装目录。
7. **渲染完必须验片**：抽 3–5 帧看图 + `ffprobe` 看时长/音轨/分辨率，再交付。
8. **失败要可重跑**：脚本带 `--overwrite` / 幂等跳过 / 失败清单，不靠人记"哪几条没渲"。

## 工作流

1. **定交付规格**（输入：投放平台）→ 分辨率、fps、codec、码率、要不要透明/音频。产出：一行规格字符串。
2. **单帧验版式**（输入：合成 id）→ `npx remotion still src/index.ts Main out/f.png --frame=0`。产出：一张图，确认字体/图片/安全区。
3. **渲 1 秒试片**（输入：规格）→ `--frames=0-29`。产出：能播的短片段，确认音轨与首帧。
4. **全片渲染**（输入：规格 + 试片通过）→ CLI 或脚本 `renderMedia`。产出：`out/main.mp4`。
5. **验片**（输入：成片）→ `ffprobe` 看时长/码率/音轨，`ffmpeg` 抽 5 帧看图。产出：验收记录。
6. **发布版**（输入：母版）→ 需要时再压一版（平台上传用 `crf 20`），透明需求出 webm。产出：交付包 + 规格说明。
7. **上云/上 CI**（输入：可复现命令）→ Serverless 或 CI runner，固定依赖版本与浏览器版本。产出：一条可重复执行的渲染任务。

## 关键参数与模板

### 三种出片方式（并列，按场景选）

```bash
# 方案 A：CLI（本地一次出片，最省事）
npx remotion render src/index.ts Main out/main.mp4 \
  --codec=h264 --crf=18 --pixel-format=yuv420p \
  --concurrency=4 --overwrite

# 只渲一段 / 隔帧取样
npx remotion render src/index.ts Main out/clip.mp4 --frames=0-149
npx remotion render src/index.ts Main out/preview.mp4 --every-nth-frame=2

# 出封面
npx remotion still src/index.ts Cover out/cover.png --frame=45 --image-format=png
```

```ts
// 方案 B：Node 脚本（批量、CI、需要拿进度/上报时）
import path from "node:path";
import { bundle } from "@remotion/bundler";
import { selectComposition, renderMedia, renderStill } from "@remotion/renderer";

const serveUrl = await bundle({ entryPoint: path.resolve("src/index.ts") });
const composition = await selectComposition({ serveUrl, id: "Main", inputProps: {} });

await renderMedia({
  composition,
  serveUrl,
  codec: "h264",
  crf: 18,
  pixelFormat: "yuv420p",
  outputLocation: path.resolve("out/main.mp4"),
  inputProps: {},
  concurrency: 4,
  overwrite: true,
  onProgress: ({ progress }) => console.log(`${(progress * 100).toFixed(1)}%`),
});

await renderStill({ composition, serveUrl, output: "out/cover.png", frame: 45, imageFormat: "png" });
```

```js
// 方案 C：MTNode remotion-pack（本机视频节点走这条）
// 宿主写 render.json，然后用安装目录的 node_modules 渲
// node <安装目录>\render.mjs <render.json 绝对路径>
```

| `render.json` 字段 | 说明 |
| --- | --- |
| `entryPoint` | 合成入口（绝对路径优先） |
| `composition` | 合成 id，默认 `MTNodeRemotion` |
| `outputLocation` | 输出路径，写工作目录，**不写安装目录** |
| `nodeModulesDir` | 依赖源（安装目录的 `node_modules`） |
| `codec` / `fps` / `width` / `height` / `durationInFrames` | 可覆盖合成参数 |
| stdout | JSON Lines：`bundled` / `progress` / `done` / `error` |

MTNode 的约定：工程与成片都在 `.mtnode/remotion/<节点 id>/` 下，`install.cmd` 装在别处；
往安装目录写用户代码会导致升级即丢失。

### codec 选择

| codec | 容器 | 用途 | 注意 |
| --- | --- | --- | --- |
| `h264` | mp4 | 默认交付、全平台兼容 | 首选；`crf` 16–23 |
| `h265` | mp4 | 同画质更小体积 | 老设备/浏览器兼容差 |
| `vp8` / `vp9` | webm | 网页嵌入、需要透明 | 透明必须 `yuva420p` + `vp9` |
| `prores` | mov | 中间片、进剪辑软件二次调色 | 体积极大（约 h264 的 10–20 倍） |
| `gif` | gif | 表情/预览图 | 无音频、体积大、色带明显 |
| `mp3` / `aac` / `wav` | 音频 | 只出音轨 | 配音交付用 |

平台交付预设、透明通道出片流程与验片命令见 `references/encoding-matrix.md`。

### crf 与画质

| crf | 画质 | 用途 | 相对体积 |
| --- | --- | --- | --- |
| 16 | 极高 | 母版 / 需二次剪辑 | 1.6× |
| 18 | 高 | **默认交付**（文字锐利） | 1.0× |
| 20 | 好 | 平台上传（反正会被压） | 0.75× |
| 23 | 中 | 内部预览 | 0.5× |
| 28+ | 低 | 只做节奏检查 | 0.3× |

crf 每 +6 体积约减半；`crf 0` 是无损（h264 下不建议，体积失控）。

### pixelFormat 与 imageFormat

| 参数 | 取值 | 何时用 |
| --- | --- | --- |
| `pixelFormat` | `yuv420p`（默认） | 一切常规交付 |
| | `yuva420p` | 需要透明（配 `vp9` 或 `prores`） |
| | `yuv422p10le` / `yuv444p10le` | 10bit 母版、调色中间片 |
| `imageFormat` | `jpeg`（默认，快） | 无透明、无锐利细线 |
| | `png` | 有大面积透明、细线/文字描边、或要逐帧无损 |
| `scale` | `0.5` / `2` | 半分辨率预览、2 倍超采样再缩（成本高） |

### 并发与内存

| 场景 | `concurrency` | 备注 |
| --- | --- | --- |
| 1080p 常规 | 核数/2（8 核 → 4） | 默认值即约核数一半，通常不用改 |
| 4K / 大量 `blur` | 2–3 | 内存先于 CPU 成为瓶颈 |
| 内存 < 16GB | 2 | 每标签页约 300–800MB |
| 批量 N 条 | 条目并发 2–4 × 内部 2–3 | 两者相乘才是真实压力 |

### Serverless / CI

```ts
// @remotion/lambda：先部署站点与函数，再按需渲染
import { renderMediaOnLambda, getRenderProgress } from "@remotion/lambda/client";

const { renderId, bucketName } = await renderMediaOnLambda({
  region: "us-east-1",
  functionName: "remotion-render-4-0-518-mem2048mb-disk2048mb-120sec",
  serveUrl: "https://your-site.s3.amazonaws.com/index.html",
  composition: "Main",
  codec: "h264",
  inputProps: {},
  framesPerLambda: 60,        // 每片帧数：越大片数越少、单片越久
});

let progress = await getRenderProgress({ renderId, bucketName, functionName, region: "us-east-1" });
while (!progress.done) {
  progress = await getRenderProgress({ renderId, bucketName, functionName, region: "us-east-1" });
  await new Promise((r) => setTimeout(r, 2000));
}
```

| CI 要点 | 做法 |
| --- | --- |
| 依赖锁定 | 所有 `@remotion/*` 同号 + 提交 lockfile；CI 用 `npm ci` |
| 浏览器 | 首次运行会下载 Chrome Headless Shell（约 150MB）；CI 里提前跑一次渲染预热缓存 |
| 字体 | 不用系统字体，用 `@remotion/google-fonts` 或自托管，否则 Linux runner 上换字形 |
| 时区/语言 | 显式 `toLocaleString("en-US")`，别依赖 runner 的 locale |
| 产物 | 上传 `out/` + `batch-report.json`；失败也上传日志 |
| 超时 | 单条 1080p/30s 约 1–3 分钟；给足 10 分钟并设重试 |

## 常见坑

- **`Could not find composition "Main"`**：`id` 拼错、`entryPoint` 指错文件、或 `registerRoot` 没执行 → 先 `npx remotion compositions src/index.ts` 打印真实列表。
- **`Target closed` / 渲染到一半进程退出**：内存不足或浏览器崩 → 并发降到 2、`--image-format=jpeg`、4K 降到 1080p 再放大；批量脚本每 20 条重启一次浏览器。
- **首帧全黑 / 图片没加载**：用了裸 `<img>` 或远程 URL → 换 `<Img src={staticFile(...)} />`；视频用 `<OffthreadVideo>`。
- **成片没有声音**：`<Audio>` 的时间轴在合成时长之外（`Sequence from` 超过总帧数），或渲染时 `muted: true` / `--muted`；用 `ffprobe` 确认有没有音轨。
- **渲染机字体不一样**：依赖系统字体 → `@remotion/google-fonts` 的 `loadFont()` 或 `@font-face` + `staticFile()`，渲染前等字体加载完。
- **Windows 上 GPU 相关崩溃**：加 `--gl=angle`（`chromiumOptions: { gl: "angle" }`）；仍崩就用 `swangle`（软件渲染，慢但稳）。
- **本地能渲、CI 不能**：CI 缺 Chromium 或系统库 → 首次跑一次真实渲染触发下载；容器需装字体与 libnss 等基础库。

报错原文与处置对照表见 `references/troubleshooting.md`。

## 来源与合并说明

| 上游仓库 | ★ | 许可 | 贡献内容 |
| --- | --- | --- | --- |
| calesthio/OpenMontage | 76149 | AGPL-3.0 | `remotion-best-practices` 的 rendering 相关规则与"先 selectComposition 再渲染"的流程 |
| haidrrrry/claude-remotion-skill | 811 | MIT | 交付前 checklist：`--codec h264 --crf 16` 母版、透明度/模糊堆叠用 `--image-format png`、0.25 倍速验片 |
| Vincentwei1021/video-shotcraft | 16747 | Apache-2.0 | `@remotion/motion-blur` 的 `shutterAngle/samples` 渲染成本口径、Sequence 重定基帧的穿帮判例、抽帧验收流程 |
| mromidev/claude-animated-shorts | 1325 | MIT | 成片 QA 与"定格被当成冻结"的判定、渲染前资源盘点 |
| norahe0304-art/30x-video | 64 | MIT | 证据型 QC 门禁（抽帧留证、逐场景核对）与 CI 化出片 |
| remotion-dev/remotion | 官方 | 见仓库 | `bundle` / `selectComposition` / `renderMedia` / `renderStill` 参数、codec/crf/pixelFormat 取值核对 |

- 抓取日期：2026-11-04
- 合并的上游技能：remotion-best-practices（rendering / ffmpeg 部分）、remotion-motion-graphics（交付 checklist）、video-shotcraft（motion-blur 与抽帧验收）、30x-video（QC 门禁）、claude-animated-shorts（成片 QA）
- 冲突与取舍：`crf` 上游给出 16 与 18 两个"母版值"——本技能定为"上传母版 16、默认交付 18、平台再压 20"三档，各自标明用途；`--image-format` 上游有"一律 png 更好"的说法，实测 jpeg 快 2–3 倍且常规画面无损可辨，故仅在透明/细线场景用 png。
