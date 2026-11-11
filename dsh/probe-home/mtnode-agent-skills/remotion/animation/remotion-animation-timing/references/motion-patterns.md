# 动效组件库（可直接粘进项目）

全部假设项目里有 `src/theme.ts`；每个组件都从 `useCurrentFrame()` / `useVideoConfig()` 取时间。
代码用 TypeScript + React，`remotion` 4.x。

## 0. theme.ts —— 颜色/曲线/弹簧的唯一来源

```ts
// src/theme.ts
import { Easing } from "remotion";

export const theme = {
  colors: {
    bg: "#0A0A0F",
    bgAlt: "#12121A",
    primary: "#7C3AED",   // 主角色：一帧里最多一个元素用它
    accent: "#22D3EE",
    text: "#F4F4F5",
    textDim: "#A1A1AA",
  },
  fonts: { display: "Clash Display", body: "Inter", mono: "JetBrains Mono" },
  ease: {
    out: Easing.bezier(0.16, 1, 0.3, 1),
    inOut: Easing.bezier(0.83, 0, 0.17, 1),
    in: Easing.bezier(0.7, 0, 0.84, 0),
  },
  spring: {
    snappy: { damping: 14, stiffness: 160, mass: 0.6 },
    smooth: { damping: 20, stiffness: 90, mass: 1 },
    bouncy: { damping: 11, stiffness: 170, mass: 0.7 },
  },
} as const;
```

组件里禁止内联颜色与曲线：一改主题要能全片生效。

## 1. 通用入场（三通道同一条进度）

```tsx
import React from "react";
import { interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { theme } from "../theme";

export const Entrance: React.FC<{ delay?: number; children: React.ReactNode }> = ({
  delay = 0,
  children,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const p = spring({ frame: frame - delay, fps, config: theme.spring.smooth });
  return (
    <div
      style={{
        opacity: p,
        transform: `translateY(${interpolate(p, [0, 1], [48, 0])}px) scale(${interpolate(p, [0, 1], [0.94, 1])})`,
      }}
    >
      {children}
    </div>
  );
};
```

## 2. 错峰容器（均匀 / 越来越密）

```tsx
export const Stagger: React.FC<{ items: React.ReactNode[]; step?: number; accelerate?: boolean }> = ({
  items,
  step = 4,
  accelerate = false,
}) => {
  const n = items.length;
  const delay = (i: number) =>
    accelerate && n > 1 ? 4 + 36 * (1 - Math.pow(1 - i / (n - 1), 1.5)) : i * step;
  return (
    <>
      {items.map((node, i) => (
        <Entrance key={i} delay={delay(i)}>
          {node}
        </Entrance>
      ))}
    </>
  );
};
```

## 3. 逐词揭示（标题主力）

```tsx
export const WordReveal: React.FC<{ text: string; startAt?: number; perWord?: number }> = ({
  text,
  startAt = 0,
  perWord = 4,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return (
    <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
      {text.split(" ").map((word, i) => {
        const p = spring({
          frame: frame - startAt - i * perWord,
          fps,
          config: theme.spring.snappy,
        });
        return (
          <span
            key={i}
            style={{
              display: "inline-block",
              opacity: p,
              transform: `translateY(${interpolate(p, [0, 1], [24, 0])}px)`,
              filter: `blur(${interpolate(p, [0, 1], [8, 0])}px)`,
            }}
          >
            {word}
          </span>
        );
      })}
    </div>
  );
};
```

中文按字切时把 `split(" ")` 换成 `[...text]`，`perWord` 相应缩到 2–3 帧。

## 4. 背景网格（禁止纯色平铺）

```tsx
export const MeshBackground: React.FC = () => (
  <div
    style={{
      position: "absolute",
      inset: 0,
      background: `radial-gradient(60% 50% at 18% 12%, ${theme.colors.primary}22, transparent 60%),
                   radial-gradient(50% 40% at 82% 78%, ${theme.colors.accent}1a, transparent 62%),
                   ${theme.colors.bg}`,
    }}
  />
);
```

## 5. 程序化颗粒（不用素材文件）

```tsx
import { useCurrentFrame } from "remotion";

export const Grain: React.FC<{ opacity?: number }> = ({ opacity = 0.08 }) => {
  const frame = useCurrentFrame();
  const seed = Math.floor(frame / 2) % 8; // 每 2 帧换一次，避免高频闪烁
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        pointerEvents: "none",
        opacity,
        backgroundImage: `url("data:image/svg+xml;utf8,${encodeURIComponent(
          `<svg xmlns='http://www.w3.org/2000/svg' width='120' height='120'>
             <filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' seed='${seed}'/></filter>
             <rect width='120' height='120' filter='url(#n)' opacity='0.6'/>
           </svg>`,
        )}")`,
        backgroundSize: "240px 240px",
        mixBlendMode: "overlay",
      }}
    />
  );
};
```

## 6. 暗角

```tsx
export const Vignette: React.FC<{ strength?: number }> = ({ strength = 0.55 }) => (
  <div
    style={{
      position: "absolute",
      inset: 0,
      pointerEvents: "none",
      background: `radial-gradient(75% 60% at 50% 45%, transparent 55%, rgba(0,0,0,${strength}) 100%)`,
    }}
  />
);
```

## 7. 静图 Ken Burns（所有静图都要有）

```tsx
export const KenBurns: React.FC<{ src: string; from?: number; to?: number }> = ({
  src,
  from = 1,
  to = 1.08,
}) => {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const p = interpolate(frame, [0, durationInFrames], [0, 1], {
    easing: theme.ease.inOut,
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  return (
    <div style={{ position: "absolute", inset: 0, overflow: "hidden" }}>
      <img
        src={src}
        style={{
          width: "100%",
          height: "100%",
          objectFit: "cover",
          transform: `scale(${from + (to - from) * p})`,
        }}
      />
    </div>
  );
};
```

`durationInFrames` 来自 `useVideoConfig()` 时要在 `<Sequence>` 内使用，拿到的才是本段时长。

## 8. 数字滚动（tabular-nums 防抖）

```tsx
export const Counter: React.FC<{ to: number; from?: number; decimals?: number }> = ({
  to,
  from = 0,
  decimals = 0,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const p = interpolate(frame, [0, 1.2 * fps], [0, 1], {
    easing: theme.ease.out,
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const value = from + (to - from) * p;
  return (
    <span style={{ fontVariantNumeric: "tabular-nums" }}>
      {value.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}
    </span>
  );
};
```

## 9. 呼吸 / 悬浮（hold 段不死）

```tsx
export const Breathing: React.FC<{ children: React.ReactNode; amp?: number; period?: number }> = ({
  children,
  amp = 0.012,
  period = 3,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const k = Math.sin((frame / (period * fps)) * Math.PI * 2);
  return (
    <div style={{ transform: `scale(${1 + amp * k}) translateY(${2 * k}px)` }}>{children}</div>
  );
};
```

`period` 秒一个完整周期：2.5–4s 最像呼吸，<1.5s 会读作抖动。

## 10. 视差（多层速度梯度）

```tsx
export const Parallax: React.FC<{ children: React.ReactNode; depth?: number }> = ({
  children,
  depth = 1,
}) => {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const p = interpolate(frame, [0, durationInFrames], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  return <div style={{ transform: `translateX(${-120 * depth * p}px)` }}>{children}</div>;
};
```

三层 `depth = 0.5 / 1 / 1.8` 就有纵深；同一层里元素速度必须一致。

## 11. 退出（比进入快）

```tsx
export const Exit: React.FC<{ at: number; children: React.ReactNode }> = ({ at, children }) => {
  const frame = useCurrentFrame();
  const p = interpolate(frame, [at, at + 12], [0, 1], {
    easing: theme.ease.in,
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  return (
    <div style={{ opacity: 1 - p, transform: `translateY(${-24 * p}px) scale(${1 - 0.04 * p})` }}>
      {children}
    </div>
  );
};
```

## 12. 相机运动模糊（只包快速段）

```tsx
import { CameraMotionBlur } from "@remotion/motion-blur";
import { Sequence } from "remotion";

<Sequence from={120} durationInFrames={45}>
  <CameraMotionBlur shutterAngle={180} samples={10}>
    <FastPanScene />
  </CameraMotionBlur>
</Sequence>;
```

- 只包"快速运镜"那一段（>30px/帧）；整镜全包会把慢速段的细纹理抹软，且渲染时间随 `samples` 线性上涨。
- `shutterAngle` 超过 270 会糊；30fps 下 180 接近实拍电影感。

## 13. 擦除/揭示（按秒卡准）

```tsx
export const WipeIn: React.FC<{ seconds?: number; children: React.ReactNode }> = ({
  seconds = 0.6,
  children,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const w = interpolate(frame, [0, seconds * fps], [0, 100], {
    easing: theme.ease.inOut,
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  return <div style={{ clipPath: `inset(0 ${100 - w}% 0 0)` }}>{children}</div>;
};
```

`clipPath` 比 `width` 动画便宜，且不会触发子元素重排。

## 14. 确定性伪随机（禁用 Math.random）

```tsx
export const rand = (i: number, salt = 1) => {
  const x = Math.sin((i + 1) * 12.9898 * salt) * 43758.5453;
  return x - Math.floor(x); // 0..1
};
```

任何"随机"抖动（卡片歪角、点阵位置、光斑）都用它：同 seed 必定同画面，才能做渲后帧比对。
