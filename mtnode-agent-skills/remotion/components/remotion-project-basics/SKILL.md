---
name: remotion-project-basics
title: Remotion 工程与合成基础
description: 搭 Remotion 工程骨架与合成：项目结构、Composition/Still、useCurrentFrame、Sequence 与 Series 取舍、staticFile 与常用配置。新建工程或首帧跑不起来时读它。
tags: Remotion,工程结构,Composition,Sequence,静态资源,配置
version: 1.0.0
---

# Remotion 工程与合成基础

Remotion 把 React 组件按帧渲染成视频：一个组件 = 一帧画面，`frame` 是唯一的时间输入。
本技能只管"骨架能跑起来"：目录、注册、合成参数、两个时间轴原语、静态资源。
动画手感看 `remotion-animation-timing`，出片看 `remotion-render-encoding`。

## 何时用

- 从零起一个 Remotion 工程，或把 MTNode `remotion-pack` 的占位工程改成真实片子。
- 要新增画幅（9:16 / 1:1 / 4K）、新增一条片子、给已有工程加第二支 Composition。
- 需要在两个场景之间排时间：不清楚该用 `<Sequence>` 还是 `<Series>`。
- `npx remotion studio` 报 "Composition not found"、白屏、图片 404、时长不对。
- 不适用：纯调动画曲线（去 animation 技能）、渲染参数与编码（去 render 技能）。

## 核心原则

1. **入口只注册一次**：`src/index.ts` 里 `registerRoot(RemotionRoot)`，全工程唯一；其它文件不调 `registerRoot`。
2. **`id` 一经用于渲染就不要改**：CLI / `selectComposition()` / MTNode 的 `render.json` 都按 `id` 找合成，改名等于换片。
3. **帧数是整数，时间是秒**：`durationInFrames = Math.round(秒 × fps)`；不要在合成里写 `durationInFrames: 10.5`。
4. **禁止 CSS 动画与 CSS transition**：`@keyframes`、`transition`、Tailwind 的 `animate-*` 在逐帧渲染下不推进，必须用 `useCurrentFrame()` 算值。
5. **子组件不感知绝对时间**：放进 `<Sequence from={...}>` 后，子组件里的 `useCurrentFrame()` 从 0 开始；用相对帧写动画，镜头才能整段搬移。
6. **静态资源必须走 `public/` + `staticFile()`**：`import img from "./a.png"` 在渲染时可能拿不到，`staticFile()` 才会被 webpack 复制进 bundle。
7. **合成时长先算后写**：`durationInFrames` 与内容实际长度不符 = 片尾死气或内容被截断，收工前用最后一帧的 `Sequence` 端点反查一次。
8. **一镜一个组件文件**：`src/scenes/*.tsx`，由 Root 或一个 `Main` 组合；不要把所有画面堆进一个 4000 行的组件。

## 工作流

1. **定画幅与帧率**（输入：投放平台）→ 竖屏短视频 1080×1920 / 30fps；横屏 1920×1080 / 30fps；方图 1080×1080 / 30fps；需要与实拍素材混剪时跟随素材帧率（25/29.97/30/60）。产出：一张 `width / height / fps` 三行参数表。
2. **建目录**（输入：参数表）→ `src/index.ts`、`src/Root.tsx`、`src/Main.tsx`、`src/scenes/`、`public/`。产出：能 `npm run dev` 起来的空工程，见 `references/project-layout.md`。
3. **写 Root**（输入：画幅参数）→ `<Composition id component durationInFrames fps width height defaultProps />`；要静态封面再挂一个 `<Still>`。产出：Studio 侧栏出现该合成。
4. **搭时间轴骨架**（输入：分镜表，每个镜头起止秒）→ 先只放占位色块，用 `<Sequence>` 或 `<Series>` 排出镜头顺序，跑一遍 Studio 看节奏。产出：镜头边界正确的空片。
5. **接静态资源**（输入：图片/视频/音频文件）→ 全部放进 `public/`，代码里 `staticFile("shots/a.png")`（不加前导斜杠）。产出：Studio 与渲染两端都能出图。
6. **算总时长**（输入：最后一个镜头的起点 + 时长 + 收尾 hold）→ 回填 `durationInFrames`。产出：与内容严格等长的合成。
7. **交接**（输入：可跑的工程）→ 动画、字幕、参数化、渲染各自交给对应技能；把 `id`、`fps`、画幅、总帧数写进 `README` 或 MTNode `render.json`。产出：可渲染工程 + 参数清单。

## 关键参数与模板

### 项目结构（最小可渲染）

```
my-video/
├── src/
│   ├── index.ts        # registerRoot
│   ├── Root.tsx        # Composition 注册表
│   ├── Main.tsx        # 全片时间轴
│   └── scenes/         # 一镜一个组件
├── public/             # staticFile 根目录（音频/图片/视频）
├── remotion.config.ts  # CLI 默认值
├── package.json        # remotion / react / @remotion/cli 同号
└── tsconfig.json
```

```ts
// src/index.ts —— 全工程唯一入口
import { registerRoot } from "remotion";
import { RemotionRoot } from "./Root";

registerRoot(RemotionRoot);
```

### Root：Composition / Still / Folder

```tsx
// src/Root.tsx
import { Composition, Folder, Still } from "remotion";
import { Main, MainSchema, type MainProps } from "./Main";
import { Cover } from "./Cover";

const defaultProps: MainProps = { title: "第一帧就成立", accent: "#7C3AED" };

export const RemotionRoot: React.FC = () => (
  <>
    <Folder name="成片">
      <Composition
        id="Main"
        component={Main}
        durationInFrames={900}   // 30s @ 30fps
        fps={30}
        width={1080}
        height={1920}
        defaultProps={defaultProps}
        schema={MainSchema}      // 可选：见 data-params 技能
      />
    </Folder>
    <Folder name="封面">
      <Still id="Cover" component={Cover} width={1080} height={1920} defaultProps={defaultProps} />
    </Folder>
  </>
);
```

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `id` | 是 | 渲染入口名，全工程唯一，不随版本改 |
| `component` | 是 | `React.FC<Props>`，接收 `defaultProps`/`inputProps` |
| `durationInFrames` | 是 | 整数帧；可用 `calculateMetadata` 动态算 |
| `fps` | 是 | 30 是默认安全值；与素材不一致会导致音画漂移 |
| `width` / `height` | 是 | 9:16 用 1080×1920；4K 横屏 3840×2160（渲染时间约 ×4） |
| `defaultProps` | 否 | 必须是 JSON 可序列化值；`satisfies Props` 拿类型检查 |
| `schema` | 否 | zod schema，Studio 里出表单 |
| `calculateMetadata` | 否 | 异步按 props 改时长/画幅，见 `remotion-data-params` |

`<Still>` 参数更少：`id / component / width / height / defaultProps`，没有 `fps` 与 `durationInFrames`——它是单帧，渲染时用 `--frame` 指定取哪一帧。

### 两个取值钩子

```tsx
import { useCurrentFrame, useVideoConfig, AbsoluteFill } from "remotion";

export const Scene: React.FC = () => {
  const frame = useCurrentFrame();                       // 相对当前 Sequence 的帧号
  const { fps, durationInFrames, width, height, id } = useVideoConfig();
  const t = frame / fps;                                 // 秒，最常用
  return <AbsoluteFill style={{ background: "#0A0A0F" }}>{t.toFixed(2)}s</AbsoluteFill>;
};
```

- `useCurrentFrame()` 在 `<Sequence>` 内已减去 `from`；要拿全片绝对帧用 `useCurrentFrame()` + 自己传下来的 offset。
- `useVideoConfig()` 给的是**所在合成**的配置，不是 Sequence 的；不要用它推 Sequence 长度。

### 时间轴原语：Sequence 与 Series（并列，按场景选）

| 维度 | `<Sequence>` | `<Series>` |
| --- | --- | --- |
| 时间基准 | `from` 是相对父级的绝对帧 | 顺次累加：前一段的 `durationInFrames` 自动成下一段起点 |
| 重叠 | 可任意重叠（画中画、并行图层、音轨） | 不重叠，天然串行 |
| 改时长 | 后面所有镜头要手动跟着改 | 改一段，后面自动顺延 |
| 负帧 | `from` 可为负（提前起播） | 不支持 |
| 典型场景 | 卡点、字幕、BGM、同一时刻多层 | 章节流、一条叙事线、镜头顺序稳定的片子 |

```tsx
// 方案 A：Sequence —— 绝对帧编排（适合卡点片、多层并行）
import { AbsoluteFill, Sequence, staticFile } from "remotion";
import { Audio } from "@remotion/media";

export const Timeline: React.FC = () => (
  <AbsoluteFill style={{ background: "#0A0A0F" }}>
    <Sequence from={0} durationInFrames={90} name="开场">
      <Hook />
    </Sequence>
    <Sequence from={72} durationInFrames={120} name="主体" premountFor={30}>
      <Body />
    </Sequence>
    <Sequence from={0} durationInFrames={900} name="BGM">
      <Audio src={staticFile("audio/bgm.mp3")} />
    </Sequence>
  </AbsoluteFill>
);
```

```tsx
// 方案 B：Series —— 顺次累加（适合叙事流，改时长不牵连后续）
import { Series } from "remotion";

export const Timeline: React.FC = () => (
  <Series>
    <Series.Sequence durationInFrames={90} name="开场"><Hook /></Series.Sequence>
    <Series.Sequence durationInFrames={120} offset={-18} name="主体"><Body /></Series.Sequence>
    <Series.Sequence durationInFrames={150} name="收尾"><Outro /></Series.Sequence>
  </Series>
);
```

- `offset` 是 Series 里唯一的重叠手段（负值提前、正值留白），要三层以上并行还是换回 `<Sequence>`。
- `premountFor` 让后一段提前挂载以预加载图片/视频，避免切入瞬间白闪；一般给 20–60 帧。
- `layout` 默认 `absolute-fill`（铺满父级）；要让 Sequence 只占文档流用 `layout="none"`。
- `name` 显示在 Studio 时间轴上，长片必须写，否则时间轴是一排匿名条。

### 静态资源

```tsx
import { Img, staticFile, getStaticFiles } from "remotion";

<Img src={staticFile("shots/hero.png")} style={{ width: "100%" }} />;
// 文件名不要带前导斜杠：staticFile("a.png") ✅  staticFile("/a.png") ❌
```

| 场景 | 写法 |
| --- | --- |
| 图片 | `<Img src={staticFile("x.png")} />`（不要用裸 `<img>`，`Img` 会等图片加载完再截帧） |
| 视频 | `<OffthreadVideo src={staticFile("x.mp4")} />`（比 `<Video>` 渲染快且不掉帧） |
| 音频 | `<Audio src={staticFile("x.mp3")} />`（`@remotion/media`，见 audio 技能） |
| 字体 | `@remotion/google-fonts/*` 的 `loadFont()`，或 `@font-face` + `staticFile()` |
| 列目录 | `getStaticFiles()` 返回 `public/` 全部文件，可做批量引用 |

### remotion.config.ts（CLI 默认值）

```ts
import { Config } from "@remotion/cli/config";

Config.setVideoImageFormat("jpeg");   // 中间帧格式，jpeg 更快
Config.setConcurrency(4);             // 大约留一半核给系统
Config.setCodec("h264");
Config.setCrf(18);
Config.setOverwriteOutput(true);
```

### 常用命令

| 命令 | 用途 |
| --- | --- |
| `npx remotion studio` | 打开预览（改代码热更新） |
| `npx remotion compositions src/index.ts` | 列出全部 `id` 与时长，核对注册 |
| `npx remotion render src/index.ts Main out/main.mp4` | 渲染 |
| `npx remotion still src/index.ts Cover out/cover.png --frame=0` | 出单帧封面 |
| `npx remotion render ... --props=./props.json` | 换一组 props 出片 |

## 常见坑

- **Studio 侧栏没有合成**：`registerRoot` 没调、调了两次、或 `Root` 返回空 Fragment 之外还写了条件渲染（`if (!x) return null` 在根上会整排消失）→ 先 `npx remotion compositions` 确认，再查入口文件路径。
- **图片/音频在 Studio 有、渲染 404**：用了相对 `import` 或 `staticFile("/a.png")` 前导斜杠 → 一律改成 `staticFile("a.png")` 且文件真的在 `public/` 下。
- **CSS 动画不播**：`transition`/`@keyframes`/Tailwind `animate-*` 在渲染时停在第一帧 → 改成 `interpolate(frame, ...)` 或 `spring()`。
- **片尾多出 3 秒黑屏 / 最后一句被切**：`durationInFrames` 与最后一个 `Sequence` 的 `from + durationInFrames` 不等 → 用最后一个镜头的端点反算总帧数，再留 15–30 帧收尾 hold。
- **`useCurrentFrame()` 拿到几百而不是 0**：组件放在了 `<Sequence>` 外层，或用了 `Series` 却在其外部读帧 → 动画组件必须真的渲染在 Sequence 内部。
- **上游写法差异（以官方文档为准）**：部分上游把 `trimBefore` / `trimAfter` 说成"秒"，官方口径是**帧**；旧版 `<Audio>` 用 `startFrom` / `endAt`，现推荐 `@remotion/media` 的 `trimBefore` + `durationInFrames`。本技能统一按官方帧口径写。

## 来源与合并说明

| 上游仓库 | ★ | 许可 | 贡献内容 |
| --- | --- | --- | --- |
| calesthio/OpenMontage | 76149 | AGPL-3.0 | `remotion-best-practices` 的 compositions / sequencing / timing 规则：Composition 与 Still、Folder、defaultProps、Sequence 语义、禁止 CSS 动画 |
| haidrrrry/claude-remotion-skill | 811 | MIT | 工程骨架与"一镜一组件"的结构约定、渲染前必查项 |
| Vincentwei1021/video-shotcraft | 16747 | Apache-2.0 | 镜头按 Sequence 绝对帧编排、`premountFor` 预挂载避免白闪的实战口径 |
| remotion-dev/remotion | 官方 | 见仓库 | API 名称与参数（`registerRoot`、`Composition`、`Still`、`Folder`、`Sequence`、`Series`、`staticFile`、`useVideoConfig`）核对 |

- 抓取日期：2026-11-04
- 合并的上游技能：remotion-best-practices（compositions / sequencing / timing）、remotion-motion-graphics（工程与结构部分）、video-shotcraft（时间线编排部分）
- 冲突与取舍：`<Sequence>` 与 `<Series>` 上游各自成篇、互相不引用，本技能改为并列对照表，按"是否需要绝对帧"选型；`trimBefore` 单位上游有"秒"的说法，按官方文档统一为帧并在常见坑标注。
