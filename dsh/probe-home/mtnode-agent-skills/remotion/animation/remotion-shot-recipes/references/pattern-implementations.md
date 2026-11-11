# 镜头模式的可粘实现

每个片段都是完整可编译的组件；共用 `src/theme.ts`（见 animation 技能的 `references/motion-patterns.md` 第 0 节）。
所有运动都是 `useCurrentFrame()` 的纯函数：同一帧必定同一画面。

## 1. 急推 + 落位缓冲（crash zoom）

```tsx
import React from "react";
import { AbsoluteFill, Easing, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";

export const CrashZoom: React.FC<{ children: React.ReactNode; startFrame?: number }> = ({
  children,
  startFrame = 30,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const push = interpolate(frame, [startFrame, startFrame + 6], [1, 2.6], {
    easing: Easing.bezier(0.3, 0, 0.25, 1),
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const settle = spring({
    frame: frame - (startFrame + 6),
    fps,
    config: { damping: 12, stiffness: 180, mass: 0.7 },
  });
  const scale = push + (1 - settle) * 0.06;

  // 撞停震屏：落位后 3 帧内 ±6px 归零
  const shake = interpolate(frame, [startFrame + 6, startFrame + 9], [6, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill style={{ overflow: "hidden" }}>
      <AbsoluteFill
        style={{
          transform: `translate(${shake}px, ${-shake * 0.6}px) scale(${scale})`,
          transformOrigin: "62% 44%",
        }}
      >
        {children}
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
```

要点：前 hold ≥30 帧建立全景，后 hold ≥45 帧读特写；`transformOrigin` 就是"推到哪"，别用 `translate` 模拟。

## 2. 缓推近（任何 hold 段都要有）

```tsx
import { AbsoluteFill, interpolate, useCurrentFrame, useVideoConfig } from "remotion";

export const HoldWithPush: React.FC<{ children: React.ReactNode; amount?: number }> = ({
  children,
  amount = 0.05,
}) => {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const scale = 1 + (amount * frame) / Math.max(1, durationInFrames);
  return (
    <AbsoluteFill style={{ overflow: "hidden" }}>
      <AbsoluteFill style={{ transform: `scale(${scale})` }}>{children}</AbsoluteFill>
    </AbsoluteFill>
  );
};
```

30s 镜用 `0.04`、单镜 3–5s 用 `0.02–0.03`；超过 8% 会读作"推镜"而不是"呼吸"。

## 3. 变速定格（帧号 remap）

```tsx
import { useCurrentFrame } from "remotion";

const FLOW_PX_PER_FRAME = 26;
const FREEZE_START = 40;
const FREEZE_LEN = 67;   // ≥45 帧才够"凝视"
const THAW_LEN = 22;

export const SpeedRampTrack: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const frame = useCurrentFrame();

  const x = (() => {
    if (frame < FREEZE_START) return frame * FLOW_PX_PER_FRAME;
    if (frame < FREEZE_START + FREEZE_LEN) return FREEZE_START * FLOW_PX_PER_FRAME;
    const u = Math.min(1, (frame - FREEZE_START - FREEZE_LEN) / THAW_LEN);
    const s = u * u * u * (u * (u * 6 - 15) + 10);          // smootherstep
    return FREEZE_START * FLOW_PX_PER_FRAME + s * FLOW_PX_PER_FRAME * 1.8;
  })();

  // 速度 → 方向模糊：|v| < 8px/帧不挂滤镜
  const v = x - (frame > 0 ? prevX(frame - 1) : 0);
  const blur = Math.abs(v) > 8 ? Math.min(18, Math.abs(v) * 0.22) : 0;

  return (
    <div style={{ transform: `translateX(${-x}px)`, filter: blur ? `blur(${blur}px)` : undefined }}>
      {children}
    </div>
  );
};

const prevX = (f: number) => {
  if (f < FREEZE_START) return f * FLOW_PX_PER_FRAME;
  if (f < FREEZE_START + FREEZE_LEN) return FREEZE_START * FLOW_PX_PER_FRAME;
  const u = Math.min(1, (f - FREEZE_START - FREEZE_LEN) / THAW_LEN);
  const s = u * u * u * (u * (u * 6 - 15) + 10);
  return FREEZE_START * FLOW_PX_PER_FRAME + s * FLOW_PX_PER_FRAME * 1.8;
};
```

定格那一帧必须给"暂停信号"：白闪 3 帧 + 取景框四角 + 角标文字从 `LIVE` 变 `PAUSED`，否则观众读作卡顿。

## 4. 群体发牌（硬加速网格）

```tsx
import { AbsoluteFill, Easing, interpolate, useCurrentFrame } from "remotion";

type Card = { x: number; y: number };

export const DealGrid: React.FC<{
  cards: Card[];
  startFrame?: number;
  children: (index: number) => React.ReactNode;
}> = ({ cards, startFrame = 36, children }) => {
  const frame = useCurrentFrame();
  const dealDelay = (k: number) => startFrame + 4 * k - 0.0792 * k * (k - 1);

  return (
    <AbsoluteFill>
      {cards.map((c, k) => {
        const local = frame - dealDelay(k);
        const fly = interpolate(local, [0, 8], [0, 1], {
          easing: Easing.bezier(0.3, 0, 0.2, 1),
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
        });
        const settle = interpolate(local, [8, 12], [0, 1], {
          easing: Easing.bezier(0.3, 0, 0.25, 1.15),   // y2 > 1 才有回弹
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
        });
        const press = interpolate(local, [12, 14], [0.996, 1], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
        });

        const arc = Math.sin(fly * Math.PI) * 110;     // z 弧顶
        return (
          <div
            key={k}
            style={{
              position: "absolute",
              left: c.x,
              top: c.y,
              opacity: fly,
              transform: `translateY(${(1 - settle) * 12 - arc * 0.15}px) scale(${0.9 + 0.1 * fly + (1 - press) * 0.004})`,
            }}
          >
            {children(k)}
          </div>
        );
      })}
    </AbsoluteFill>
  );
};
```

- 26 张时首末间隔约 4 帧 → 0.2 帧，读作"倾泻"；少于 8 张改用均匀 3–5 帧错峰。
- 满板后必须静止 hold ≥0.5s（只留 1–1.5% 缓推近）。

## 5. 对角波点阵（点阵/图标矩阵）

```tsx
import { AbsoluteFill, Easing, interpolate, useCurrentFrame } from "remotion";

export const DotWave: React.FC<{ cols?: number; rows?: number; gap?: number }> = ({
  cols = 17,
  rows = 9,
  gap = 56,
}) => {
  const frame = useCurrentFrame();
  const origin = { x: 0, y: 0 };

  return (
    <AbsoluteFill style={{ alignItems: "center", justifyContent: "center" }}>
      <div style={{ display: "grid", gridTemplateColumns: `repeat(${cols}, ${gap}px)`, gap: 6 }}>
        {Array.from({ length: cols * rows }).map((_, i) => {
          const cx = i % cols;
          const cy = Math.floor(i / cols);
          const dist = Math.hypot(cx - origin.x, cy - origin.y);
          const local = frame - dist * 1.5;
          const pop = interpolate(local, [0, 10, 18], [0, 1.5, 1], {
            easing: Easing.out(Easing.cubic),
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
          });
          return (
            <div
              key={i}
              style={{
                width: gap - 12,
                height: gap - 12,
                borderRadius: "50%",
                background: "#22D3EE",
                opacity: 0.25 + 0.6 * Math.min(1, pop),
                transform: `scale(${Math.max(0, pop)})`,
              }}
            />
          );
        })}
      </div>
    </AbsoluteFill>
  );
};
```

欧氏距离错峰天然成"波纹"；用行优先顺序会读作扫描线。

## 6. 数字滚动 + 迷你曲线

```tsx
import { Easing, interpolate, useCurrentFrame, useVideoConfig } from "remotion";

export const Kpi: React.FC<{ value: number; suffix?: string; points?: number[] }> = ({
  value,
  suffix = "",
  points = [8, 12, 10, 18, 26, 24, 34],
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const p = interpolate(frame, [0, 1.2 * fps], [0, 1], {
    easing: Easing.out(Easing.exp),
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const shown = Math.round(value * p);

  const w = 260;
  const h = 80;
  const max = Math.max(...points);
  const d = points
    .map((v, i) => `${i === 0 ? "M" : "L"} ${(i / (points.length - 1)) * w} ${h - (v / max) * h}`)
    .join(" ");

  return (
    <div>
      <div style={{ fontSize: 96, fontWeight: 800, fontVariantNumeric: "tabular-nums", color: "#fff" }}>
        {shown.toLocaleString("en-US")}
        {suffix}
      </div>
      <svg width={w} height={h}>
        <path d={d} fill="none" stroke="#7C3AED" strokeWidth={3} strokeLinecap="round" />
        <circle
          cx={w * p}
          cy={h - (points[points.length - 1] / max) * h}
          r={6}
          fill="#22D3EE"
          opacity={p}
        />
      </svg>
    </div>
  );
};
```

`tabular-nums` 必须写，否则数字变宽时整行左右抖。

## 7. 马克笔划线（SVG 描边）

```tsx
import { Easing, interpolate, useCurrentFrame, useVideoConfig } from "remotion";

export const MarkerUnderline: React.FC<{ width: number; delay?: number }> = ({ width, delay = 0 }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const len = width * 1.08;
  const p = interpolate(frame - delay, [0, (10 / 30) * fps], [0, 1], {
    easing: Easing.bezier(0.3, 0.1, 0.2, 1),
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <svg width={width} height={22} style={{ display: "block", transform: "rotate(-1.2deg)" }}>
      <path
        d={`M 4 12 C ${width * 0.28} 6, ${width * 0.62} 16, ${width - 8} 9`}
        fill="none"
        stroke="#E8A33D"
        strokeWidth={7}
        strokeLinecap="round"
        strokeDasharray={len}
        strokeDashoffset={len * (1 - p)}
      />
    </svg>
  );
};
```

笔宽变化（中段粗、首尾细）靠 `strokeWidth` 做不了，需要两段 path 叠画；先求"一笔画完 + 微上斜"，别一步到位。

## 8. 套印错位（riso hit）

```tsx
import { Easing, interpolate, useCurrentFrame } from "remotion";

export const RisoHit: React.FC<{ text: string }> = ({ text }) => {
  const frame = useCurrentFrame();

  const offset = interpolate(frame, [0, 3, 6, 9, 12], [10, -6, 4, -2, 0], {
    easing: Easing.out(Easing.quad),
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  const style: React.CSSProperties = {
    fontSize: 128,
    fontWeight: 800,
    position: "absolute",
    mixBlendMode: "multiply",
  };

  return (
    <div style={{ position: "relative" }}>
      <div style={{ ...style, color: "#F25F5C", transform: `translate(${offset}px, ${offset * 0.4}px)` }}>{text}</div>
      <div style={{ ...style, color: "#247BA0", transform: `translate(${-offset}px, ${-offset * 0.3}px)` }}>{text}</div>
      <div style={{ ...style, color: "#0A0A0F" }}>{text}</div>
    </div>
  );
};
```

三层叠印：两层色版 + 一层深色正文。抖动在 12 帧内收敛，超过 20 帧读作故障。

## 9. 甩镜转场（whip pan）

```tsx
import { AbsoluteFill, Easing, interpolate, useCurrentFrame } from "remotion";

export const WhipPan: React.FC<{ from: React.ReactNode; to: React.ReactNode; switchAt?: number }> = ({
  from,
  to,
  switchAt = 18,
}) => {
  const frame = useCurrentFrame();
  const p = interpolate(frame, [0, switchAt], [0, 1], {
    easing: Easing.in(Easing.cubic),
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const q = interpolate(frame, [switchAt, switchAt + 14], [0, 1], {
    easing: Easing.out(Easing.cubic),
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const blur = 18 * Math.sin(Math.min(1, frame / (switchAt + 14)) * Math.PI);

  return (
    <AbsoluteFill style={{ overflow: "hidden", filter: `blur(${blur}px)` }}>
      <AbsoluteFill style={{ transform: `translateX(${-100 * p}%)` }}>{from}</AbsoluteFill>
      <AbsoluteFill style={{ transform: `translateX(${100 * (1 - q)}%)` }}>{to}</AbsoluteFill>
    </AbsoluteFill>
  );
};
```

甩出与甩入必须同向；方向反了读作"两段不相干的画面撞在一起"。

## 10. 单次扫光（sheen）

```tsx
import { AbsoluteFill, Easing, interpolate, useCurrentFrame } from "remotion";

export const Sheen: React.FC<{ startAt?: number; durationInFrames?: number }> = ({
  startAt = 24,
  durationInFrames = 16,
}) => {
  const frame = useCurrentFrame();
  const p = interpolate(frame, [startAt, startAt + durationInFrames], [-0.4, 1.4], {
    easing: Easing.inOut(Easing.quad),
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill style={{ pointerEvents: "none", overflow: "hidden" }}>
      <div
        style={{
          position: "absolute",
          inset: 0,
          transform: `translateX(${p * 100}%)`,
          background: "linear-gradient(105deg, transparent 40%, rgba(255,255,255,0.35) 50%, transparent 60%)",
          mixBlendMode: "screen",
        }}
      />
    </AbsoluteFill>
  );
};
```

扫光只做一次（12–18 帧）；重复扫会被读作"加载中"。
