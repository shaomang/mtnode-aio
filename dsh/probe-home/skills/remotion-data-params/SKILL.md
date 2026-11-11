---
name: remotion-data-params
title: 参数化与数据驱动
description: 让一支片子能被参数与外部数据驱动：props 加 zod schema、calculateMetadata 动态时长、JSON/CSV 驱动画面、一张表批量出 N 条视频。做模板化、批量生产、多语言或多 SKU 版本时读它。
tags: 参数化,zod,批量出片,数据驱动,calculateMetadata,模板
version: 1.0.0
---

# 参数化与数据驱动

一支片子的价值不在"渲出来"，而在"换一批数据还能再渲 100 支"。
参数化做对的三条硬线：**props 有类型与校验**、**时长由数据算**、**渲染不依赖人工改代码**。

## 何时用

- 同一套版式要出多个版本（多语言、多 SKU、多门店、多客户）。
- 文案/数字/图片清单在 Excel、CSV、JSON 里，需要批量出片。
- 时长不能写死：要按旁白音频、字幕末条、数据行数动态算。
- 要在 Remotion Studio 里给非程序员调参（zod schema 会生成表单）。
- 不适用：单支片子的一次性动效（去 animation）、渲染并发与编码（去 render 技能）。

## 核心原则

1. **props 用 `type` 声明，不用 `interface`**：`defaultProps` 的 `satisfies` 才能做结构校验。
2. **`defaultProps` 必须 JSON 可序列化**：`Date` / `Map` / `Set` / `staticFile()` 例外（官方支持），函数与 class 实例一律不行。
3. **每个可变字段都进 schema**：没进 schema 的字段在 Studio 里改不了，批量渲染也不校验。
4. **时长从数据推**：`durationInFrames` 优先由 `calculateMetadata` 算（字幕末条、音频时长、行数 × 每行帧数），不写魔法数字。
5. **渲染不读网络**：`calculateMetadata` 里允许异步 `fetch`，但批量出片时必须缓存到本地，否则 N 条视频 = N 次网络抖动。
6. **一条数据一份 props 文件**：批量前先把"表"物化成 `props/xxx.json`，渲染只读文件——可复现、可重跑、可 diff。
7. **文件名就是主键**：`slug` 由数据行生成（小写、连字符、去重），既做输出名也做断点续跑的依据。
8. **先渲 1 条再放量**：批量脚本必须先成功渲出第一条，再并发；否则 100 条一起失败。

## 工作流

1. **抽字段**（输入：一版样片 + 数据表）→ 列出"哪些字/图/数字每期会变"，其余进常量。产出：字段表（名、类型、示例、是否必填）。
2. **写 schema**（输入：字段表）→ `z.object({...})`，枚举用 `z.enum`，颜色用 `zColor()`。产出：`src/schema.ts`。
3. **接 props**（输入：schema）→ 组件签名 `React.FC<z.infer<typeof Schema>>`，Root 里挂 `schema={...}` 与 `defaultProps`。产出：Studio 出现表单，能改参数看画面。
4. **算时长**（输入：字幕/音频/行数）→ 写 `calculateMetadata`，异步读数据、返回 `durationInFrames`（必要时连 `fps/width/height/props` 一起返回）。产出：不同数据自动不同时长。
5. **物化数据**（输入：Excel / CSV / 接口）→ 脚本转成 `props/<slug>.json`，一条一份，字段名与 schema 完全一致。产出：`props/` 目录 + `manifest.json`。
6. **单条验证**（输入：第一条 props）→ `npx remotion render src/index.ts Main out/test.mp4 --props=props/first.json`。产出：一条正确的成片。
7. **批量渲染**（输入：`manifest.json`）→ 跑批量脚本（并发 2–4、失败重试 1 次、跳过已存在）。产出：`out/<slug>.mp4` + `batch-report.json`。
8. **抽检**（输入：成片）→ 随机抽 10%（至少 3 条）抽帧看：文字有没有溢出、数字格式对不对、时长对不对。产出：抽检记录，异常回改 schema 或版式。

## 关键参数与模板

### schema 与 props

```ts
// src/schema.ts
import { z } from "zod";
import { zColor } from "@remotion/zod-types";

export const MainSchema = z.object({
  title: z.string().min(1).max(40),
  subtitle: z.string().max(80).optional(),
  accent: zColor(),                                  // Studio 出取色器
  stats: z.array(z.object({ label: z.string(), value: z.number() })).min(1).max(4),
  heroImage: z.string(),                             // public/ 下的相对路径
  locale: z.enum(["zh", "en", "ja"]).default("zh"),
});

export type MainProps = z.infer<typeof MainSchema>;
```

```tsx
// src/Main.tsx
import { AbsoluteFill, Img, staticFile } from "remotion";
import type { MainProps } from "./schema";

export const Main: React.FC<MainProps> = ({ title, subtitle, accent, stats, heroImage }) => (
  <AbsoluteFill style={{ background: "#0A0A0F" }}>
    <Img src={staticFile(heroImage)} style={{ width: "100%", height: "60%", objectFit: "cover" }} />
    <h1 style={{ color: "#fff", fontSize: 96 }}>{title}</h1>
    {subtitle ? <p style={{ color: accent, fontSize: 40 }}>{subtitle}</p> : null}
    {stats.map((s) => (
      <div key={s.label} style={{ color: "#fff" }}>
        {s.label}: {s.value}
      </div>
    ))}
  </AbsoluteFill>
);
```

```tsx
// src/Root.tsx —— schema 与 defaultProps 必须成对出现
<Composition
  id="Main"
  component={Main}
  durationInFrames={300}
  fps={30}
  width={1080}
  height={1920}
  schema={MainSchema}
  defaultProps={{ title: "示例标题", accent: "#7C3AED", stats: [{ label: "用户", value: 12000 }], heroImage: "shots/hero.png", locale: "zh" } satisfies MainProps}
/>
```

| 需求 | 写法 |
| --- | --- |
| 颜色 | `zColor()`（来自 `@remotion/zod-types`） |
| 枚举 | `z.enum([...])`，别用 `z.string()` 裸放，Studio 里会变成自由文本 |
| 可选字段 | `.optional()`，组件里必须真的判空，不能只写在 schema 上 |
| 数字范围 | `z.number().min(0).max(100)` |
| 默认值 | `.default(...)` 只在 schema 层生效，`defaultProps` 仍要写一份 |

### calculateMetadata：按数据决定时长

```tsx
import { Composition, staticFile, type CalculateMetadataFunction } from "remotion";
import { Explainer } from "./Explainer";

const FPS = 30;

type Props = { audio: string; captions: { endMs: number }[] };

const calculateMetadata: CalculateMetadataFunction<Props> = async ({ props, abortSignal }) => {
  // 1) 读字幕末条（本地 JSON，避免网络抖动；abortSignal 必须透传）
  const res = await fetch(staticFile("data/captions.json"), { signal: abortSignal });
  const captions: { endMs: number }[] = await res.json();

  // 2) 由数据算时长：末条 + 1s 收尾（calculateMetadata 拿不到 fps，用模块常量）
  const endFrame = Math.ceil((captions.at(-1)!.endMs / 1000) * FPS);
  return {
    durationInFrames: endFrame + FPS,
    props: { ...props, captions },
  };
};

<Composition
  id="Explainer"
  component={Explainer}
  fps={30}
  width={1920}
  height={1080}
  durationInFrames={150}          // 占位值，运行时被覆盖
  defaultProps={{ audio: "audio/vo.wav", captions: [] }}
  calculateMetadata={calculateMetadata}
/>;
```

- 返回字段：`durationInFrames`、`fps`、`width`、`height`、`props`（官方还支持 `defaultCodec` / `defaultOutName` 等，按需查文档，别凭记忆写）。
- `abortSignal` 必须透传给 `fetch`，否则用户在 Studio 里切参数会卡住旧请求。
- 时长公式统一封装：`const endFrame = (ms: number) => Math.ceil((ms / 1000) * fps)`。
- 会改 `props` 的 `calculateMetadata` 要幂等：同一输入两次运行必须得到同一结果。

### 外部 JSON 三种接法

| 接法 | 写法 | 适用 |
| --- | --- | --- |
| 编译期静态导入 | `import data from "../data/rows.json"`（需 `resolveJsonModule: true`） | 数据固定、随代码走 |
| 渲染期读 public | `const d = await (await fetch(staticFile("data/rows.json"))).json()` | 数据要能换、不想重编译 |
| 渲染命令传 props | `--props=props/a.json` | 批量出片（首选） |

`--props` 传的值会**浅覆盖** `defaultProps`：只写要改的字段即可，但数组与嵌套对象要整段给。

### 一张表出 N 条视频

```bash
# 1) CSV → props/*.json（一行一份）
node scripts/table-to-props.mjs data/batch.csv props/
# 2) 批量渲染（内部：bundle 一次 → 每条 selectComposition + renderMedia）
node scripts/render-batch.mjs props/ out/ --concurrency=3
```

```jsonc
// props/acme-q4.json
{
  "title": "ACME 2026 Q4 增长复盘",
  "accent": "#22D3EE",
  "stats": [{ "label": "ARR", "value": 4200000 }],
  "heroImage": "shots/acme-q4.png",
  "locale": "zh"
}
```

批量脚本的硬要求（完整实现见 `references/batch-render.md`）：

| 要求 | 做法 |
| --- | --- |
| 只 bundle 一次 | `bundle()` 在循环外；每条重 bundle 会让 100 条视频多花数十分钟 |
| 并发 | 2–4；每条 `renderMedia` 内部已多进程，叠加会抢内存 |
| 幂等 | 输出已存在且 `--force` 未给则跳过 |
| 失败隔离 | 单条失败记进报告，continue 下一条，最后非零退出 |
| 重试 | 每条最多 1 次，重试前 `openBrowser` 重新开一次浏览器（防 Chromium 崩） |
| 报告 | `batch-report.json`：slug、耗时、字节数、codec、错误信息 |

### 字段命名纪律

| 规则 | 反例 → 正例 |
| --- | --- |
| 全小写驼峰 | `Title` → `title` |
| 单位进名字 | `duration` → `durationMs` / `durationFrames` |
| 布尔用 `is/has/show` | `caption` → `showCaptions` |
| 路径相对 `public/` | `"/img/a.png"` → `"img/a.png"` |
| 时间统一毫秒 | `start: 1.2` → `startMs: 1200` |

## 常见坑

- **Studio 里字段能填但不生效**：schema 与 props 用了两个不同的类型（一个 `z.infer`，一个手写 `interface`）→ 统一从 schema 推导。
- **批量渲染第一条就白屏**：`--props` 缺字段，`defaultProps` 被浅覆盖后必填项变 `undefined` → 渲染前用 schema `.parse()` 校验每份 props，失败即报错并指出文件名。
- **每条视频时长都一样**：`calculateMetadata` 没被调用（挂了但没返回 `durationInFrames`）或读的是 `defaultProps` 而不是入参 `props` → 在函数里打一行 `console.log(props)` 确认。
- **100 条渲到第 37 条卡死**：浏览器实例泄漏 / 内存没释放 → 并发降到 2、每 20 条重启一次浏览器、单条失败重试前关掉旧实例。
- **同名文件互相覆盖**：slug 从标题直接来（含空格、中文、重复）→ 用 `slugify` + 序号后缀 `xxx-02`，并在 manifest 里记录映射。
- **数字格式随语言变**（`12,000` vs `12.000`）：用了 `toLocaleString()` 且 locale 来自系统 → 显式传 `"en-US"` 或参数里的 `locale`。

## 来源与合并说明

| 上游仓库 | ★ | 许可 | 贡献内容 |
| --- | --- | --- | --- |
| calesthio/OpenMontage | 76149 | AGPL-3.0 | `remotion-best-practices` 的 parameters / calculate-metadata 规则：zod schema、defaultProps 与 `satisfies`、动态 metadata 的返回结构 |
| Vincentwei1021/video-shotcraft | 16747 | Apache-2.0 | 时间线常量集中管理（`SHOTS` 派生）、可复现渲染与"参数是调校起点"的纪律 |
| Vincentwei1021/anything2explainer | 3033 | 无许可证 | 由字幕/音频末条反推总时长的口径、批量构建分组与 QC 判据 |
| norahe0304-art/30x-video | 64 | MIT | 模板与数据分离（scene constitution / project blueprint）、同一版式多输入的工程组织 |
| remotion-dev/remotion | 官方 | 见仓库 | `zod` schema 挂载、`calculateMetadata` 入参与返回字段核对 |

- 抓取日期：2026-11-04
- 合并的上游技能：remotion-best-practices（parameters / calculate-metadata）、anything2explainer（时长与 QC 口径）、video-shotcraft（时间线真源）、30x-video（模板/数据分层）
- 冲突与取舍：上游一处把 `defaultProps` 当"运行时数据源"、另一处主张"数据全部走 `--props`"——本技能并列保留：单条调试用 `defaultProps`（Studio 可调），批量一律 `--props`（可复现）；动态时长统一走 `calculateMetadata`，不再用"脚本改源码里的 durationInFrames"这种写法。
