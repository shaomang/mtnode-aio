---
name: remotion-animation-timing
title: Remotion 动画与时序
description: 用 interpolate / spring / Easing 排动画手感：参数含义、进入退出编排、错峰节奏、帧率换算与逐帧性能。写镜头动效、觉得动作"很廉价"或某段卡顿时读它。
tags: 动画,缓动,spring,时序,错峰,性能
version: 1.0.0
---

# Remotion 动画与时序

帧是唯一的时间变量：`interpolate` 管"从 A 到 B 的可控过渡"，`spring` 管"带物理感的落位"。
两者都能用，区别在手感与可预期性——本技能把选择标准、具体数值和性能边界写死。

## 何时用

- 写任何进入/退出/位移/缩放/透明度动画，需要确定时长与曲线。
- 画面"能动但很廉价"：匀速、只淡入、所有元素同一帧进场——按本技能的编排表改。
- 要把 30fps 的片子改成 60fps，或按秒给的节奏换算成帧。
- 动画段掉帧、渲染时间异常长，怀疑每帧重算。
- 不适用：镜头语言与配方选型（去 `remotion-shot-recipes`）、音频卡点（去 audio 技能）。

## 核心原则

1. **禁止线性**：除纯机械匀速（跑马灯、无限滚动）外，所有 `interpolate()` 必须给 `easing`。
2. **进入用 spring，行程用 bezier**：落位类（弹入、弹出、logo 定版）用 `spring()`；有明确起止的位移/擦除用 `interpolate` + `Easing.bezier`。
3. **两个 extrapolate 都写 `clamp`**：漏写会让透明度变成负值或大于 1，出现闪黑/过曝。
4. **一次进入动 2–3 个属性**：透明度 + 位移 + 缩放（或模糊），三通道走同一条进度；只动透明度 = PPT 淡入。
5. **错峰，不同时**：同级元素间隔 3–6 帧；批量入场用非线性间隔（越来越密），均匀间隔读作机械。
6. **退出比进入快**：进入 18–24 帧，退出 10–14 帧；退场必须做，不能靠切镜硬消失。
7. **留静止**：每个镜头至少 15–20 帧完全静止（fast move → stillness → next move）；全程在动 = 业余。
8. **每帧只做 O(1) 的活**：重数组、大计算、随机数、DOM 测量一律提到模块作用域或 `useMemo`，且随机必须可复现。

## 工作流

1. **定节拍**（输入：镜头意图 + BGM/旁白）→ 写下"动作在哪个秒发生、持续多少秒"，全部用秒记。产出：一张 `动作 | 起点秒 | 时长秒` 表。
2. **换算帧**（输入：秒表 + fps）→ `帧 = Math.round(秒 × fps)`；写成 `const at = (s: number) => Math.round(s * fps)`，全组件复用。产出：常量区。
3. **选驱动**（输入：动作类型）→ 落位/弹性 → `spring()`；有明确终点或要精确时长 → `interpolate()` + bezier；循环/呼吸 → `Math.sin`。产出：每个动作一行驱动代码。
4. **定曲线与幅度**（输入：手感要求）→ 进入 `Easing.bezier(0.16, 1, 0.3, 1)` 或 `spring` 的三档预设；位移幅度按画幅给（竖屏 40–80px，横屏 30–60px）。产出：可预览的第一版。
5. **排错峰**（输入：元素数量 n）→ 线性 `i * 4` 帧；要"越来越快"用 `delay = D * (1 - (1 - i/(n-1)) ** 1.5)`。产出：入场节奏。
6. **补退出与 hold**（输入：镜头边界）→ 每个元素给 `exitStart`，镜头末留 15–20 帧静止。产出：完整镜头。
7. **0.25 倍速验片**（输入：Studio 预览）→ 慢放看曲线有没有折角、落位有没有"啪"地一跳。产出：修完的曲线。
8. **性能过一遍**（输入：最长的一镜）→ 检查每帧是否新建大数组、是否 `Math.random()`、是否每次 `getBoundingClientRect`。产出：无重算的组件。

## 关键参数与模板

### interpolate 参数

```tsx
import { interpolate, useCurrentFrame, useVideoConfig, Easing } from "remotion";

const frame = useCurrentFrame();
const { fps } = useVideoConfig();

const p = interpolate(frame, [0, 0.6 * fps], [0, 1], {
  easing: Easing.bezier(0.16, 1, 0.3, 1), // easeOutExpo：进入首选
  extrapolateLeft: "clamp",
  extrapolateRight: "clamp",
});
```

| 选项 | 取值 | 说明 |
| --- | --- | --- |
| `inputRange` | 递增的帧数组 | 必须严格递增，重复值会得到 `NaN` |
| `outputRange` | 与 inputRange 等长 | 可以反序（做反向动画） |
| `easing` | `Easing.*` | 缺省是线性——除匀速运动外都要给 |
| `extrapolateLeft/Right` | `"clamp"` / `"extend"` / `"identity"` | 动画一律 `"clamp"` |
| `output` | `"perceptual-scale"` | 缩放专用：让视觉面积线性变化，避免"前快后慢"的假缩放 |

### spring 参数

```tsx
import { spring } from "remotion";

const s = spring({
  frame: frame - delay,          // 可为负：负帧返回起始值，天然支持延迟
  fps,
  config: { damping: 20, stiffness: 90, mass: 1 },
  durationInFrames: 24,          // 可选：把弹簧"压"进固定时长
  overshootClamping: false,      // true = 禁止过冲（正式 UI、文字落位）
});
```

| 预设 | damping / stiffness / mass | 手感 | 用在哪 |
| --- | --- | --- | --- |
| snappy | 14 / 160 / 0.6 | 快、轻微过冲 | 文字词、按钮、chip |
| smooth | 20 / 90 / 1 | 稳、无过冲 | 大卡片、面板、整屏元素 |
| bouncy | 11 / 170 / 0.7 | 明显回弹 | logo、强调数字、趣味点缀 |
| 官方默认 | 10 / 100 / 1 | 中等弹性 | 不确定时的起点 |

- `damping` 越小越弹；`damping ≥ 20` 基本不过冲。`stiffness` 越大越快。`mass` 越大越沉。
- 一个镜头里**只让一个主角过冲**，同级元素用 smooth/snappy；全员回弹 = 卡通。
- 需要"过冲后稳在 1"用 spring；需要"精确停在 1.0 且时长可控"用 interpolate。

### 两套写法并列：spring vs interpolate

| 维度 | `spring()` | `interpolate()` + Easing |
| --- | --- | --- |
| 时长 | 由物理参数决定（可用 `durationInFrames` 约束） | 精确可控 |
| 过冲 | 天然有 | 需自己写 bezier `y1 > 1` |
| 与 fps 的关系 | 自动按 fps 归一，换帧率手感不变 | 帧区间要手动重算 |
| 适用 | 落位、弹入、跟随、松开 | 擦除、进度条、视差、Ken Burns、按秒对齐的动作 |

```tsx
// 需要"精确在 0.6s 处擦完"的擦除：interpolate
const wipe = interpolate(frame, [0, 0.6 * fps], [0, 100], {
  easing: Easing.bezier(0.83, 0, 0.17, 1),
  extrapolateLeft: "clamp",
  extrapolateRight: "clamp",
});
```

### Easing 速查

| 用途 | 曲线 |
| --- | --- |
| 进入（easeOutExpo） | `Easing.bezier(0.16, 1, 0.3, 1)` |
| 位移/相机（easeInOutQuint） | `Easing.bezier(0.83, 0, 0.17, 1)` |
| 退出（easeIn） | `Easing.bezier(0.7, 0, 0.84, 0)` |
| 轻微过冲落位 | `Easing.bezier(0.3, 0.25, 0.25, 1.15)`（`y2 > 1` 才会回弹） |
| 急刹（速度对比） | `Easing.out(Easing.exp)` |
| 组合 | `Easing.inOut(Easing.cubic)`、`Easing.out(Easing.back(1.7))` |

### 进入 / 退出编排

```tsx
// 进入：三通道同一条进度（位移 + 缩放 + 透明度）
const enter = spring({ frame: frame - delay, fps, config: { damping: 20, stiffness: 90, mass: 1 } });
const style: React.CSSProperties = {
  opacity: enter,
  transform: `translateY(${interpolate(enter, [0, 1], [48, 0])}px) scale(${interpolate(enter, [0, 1], [0.94, 1])})`,
};

// 退出：更快、更干脆（10–14 帧），且要 clamp
const outStart = durationInFrames - 14;
const exit = interpolate(frame, [outStart, durationInFrames], [0, 1], {
  easing: Easing.bezier(0.7, 0, 0.84, 0),
  extrapolateLeft: "clamp",
  extrapolateRight: "clamp",
});
```

| 动作 | 帧数（30fps） | 幅度（竖屏 1080 宽） |
| --- | --- | --- |
| 文字词入场 | 12–18 | y +24px，blur 8→0 |
| 卡片入场 | 18–24 | y +48px，scale 0.94→1 |
| 整屏/章节入场 | 24–36 | scale 0.97→1 |
| 主角落位（过冲） | 20–28 | scale 1.06→1 |
| 退出 | 10–14 | 反向，幅度 60% |
| hold（静止） | 15–20 | 完全不动 |

### 错峰公式

```tsx
const STAGGER = 4;                                     // 均匀：词与词
const delay = i * STAGGER;

// 非线性：越来越密（发牌、批量入场），首末固定
const n = items.length;
const dealDelay = (i: number) => 4 + 36 * (1 - Math.pow(1 - i / (n - 1), 1.5));
```

- 网格用对角波：`delay = (i % COLS) * 2 + Math.floor(i / COLS) * 5`，比从左到右整齐划一更有生气。
- 超过 20 个元素时，把单元素入场压到 10–12 帧，否则最后几个还没进场镜头就切了。

### 帧率换算

```tsx
const at = (seconds: number) => Math.round(seconds * fps);
// 30fps: at(0.6) = 18   60fps: at(0.6) = 36
```

- `spring()` 内部按 fps 归一，换帧率**不用改**参数。
- `interpolate` 的帧区间、`Sequence` 的 `from/durationInFrames`、SFX 钉帧**必须**重算。
- 25fps 与 29.97fps 不要四舍五入成 30：跟素材帧率走，否则音画每秒漂 1 帧。

### 性能：每帧只算一次

```tsx
// ❌ 每帧新建 500 个对象 + 随机数 → 渲染时间翻倍且不可复现
const dots = Array.from({ length: 500 }, () => ({ x: Math.random() * 1080 }));

// ✅ 模块作用域算一次，确定性伪随机
const rand = (i: number) => ((Math.sin(i * 12.9898) * 43758.5453) % 1 + 1) % 1;
const DOTS = Array.from({ length: 500 }, (_, i) => ({ x: rand(i) * 1080 }));
```

| 禁止（每帧执行） | 替代 |
| --- | --- |
| `Math.random()` | 种子函数 `rand(i)`，保证多次渲染一致 |
| `Date.now()` / `performance.now()` | 只用 `frame` |
| `getBoundingClientRect()` 量文本 | 预先量一次存常量，或用固定宽高 |
| 每帧 `Array.prototype.sort/map` 大数组 | `useMemo` 依赖 `[items]`，与 `frame` 无关 |
| 每帧 `setState` | 用 `frame` 派生值，不写状态 |
| 每帧新建 `filter: blur()` 大图层 | 用 `transform`/`opacity`，模糊放在少数关键帧 |

异步资源（字体、远程图）用 `delayRender()` / `continueRender(handle)` 或 `@remotion/google-fonts` 的 `loadFont()`，不要在渲染中 `await`。

可直接粘用的 14 个组件（入场、逐词、背景网格、颗粒、暗角、Ken Burns、数字滚动、呼吸、视差、退出、运动模糊、擦除、确定性随机）见 `references/motion-patterns.md`。

## 常见坑

- **元素闪一下黑**：`extrapolateRight` 没 clamp，`frame` 超出区间后透明度变负 → 两个方向都 `"clamp"`。
- **spring 一动就过冲，文字看起来在抖**：`damping` 给到 20 以上，或 `overshootClamping: true`；文字落位不要用 bouncy。
- **换 60fps 后所有动画变快一倍**：`interpolate` 的帧区间是硬编码的 30fps 值 → 全部改成 `秒 × fps`。
- **入场"很整齐但很廉价"**：所有元素同一帧进场 + 只有透明度 → 加 3–6 帧错峰，补位移/缩放，末帧留 hold。
- **同一段动画每次渲染位置不同**：用了 `Math.random()` → 改成种子伪随机（渲染必须可复现，否则无法比对回归）。
- **慢放看出折角**：把两段动画首尾相接（先移到中间再移到底）→ 合成一条 bezier 或一条 spring，别叠两段。

## 来源与合并说明

| 上游仓库 | ★ | 许可 | 贡献内容 |
| --- | --- | --- | --- |
| haidrrrry/claude-remotion-skill | 811 | MIT | 主题化的 easing/spring 三档预设、进入三通道、设计规则中的节奏与 hold 口径、动效组件库 |
| calesthio/OpenMontage | 76149 | AGPL-3.0 | `remotion-best-practices` 的 animations / timing 规则：`useCurrentFrame` 驱动、禁止 CSS 动画、帧与秒换算 |
| norahe0304-art/30x-video | 64 | MIT | `rules/motion.md` 的有机动效词汇表（wiggle / 惯性过冲 / idle float / 对角错峰）与"不要处处过冲"的判断 |
| Vincentwei1021/video-shotcraft | 16747 | Apache-2.0 | 硬加速错峰公式、确定性伪随机、0.25 倍速验片与"匀速读作 PPT"的判例 |
| remotion-dev/remotion | 官方 | 见仓库 | `interpolate` / `spring` / `Easing` 的参数与 `output: "perceptual-scale"` 等官方口径核对 |

- 抓取日期：2026-11-04
- 合并的上游技能：remotion-motion-graphics（design-rules / motion-patterns）、remotion-best-practices（animations / timing）、30x-video（rules/motion.md）、video-shotcraft（aesthetic-rules R2/R3 与参数表）
- 冲突与取舍：上游对"进入用 spring 还是 bezier"各有偏好——本技能保留两套并写成对照表（落位用 spring、精确时长用 interpolate）；上游部分组件用 `spring` 的 `config` 内联数值，本技能统一收进三档预设，避免同片混用多套手感。
