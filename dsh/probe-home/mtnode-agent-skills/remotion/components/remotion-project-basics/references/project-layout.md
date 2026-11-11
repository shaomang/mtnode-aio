# 工程模板与配置清单

## 1. package.json（依赖同号）

```json
{
  "name": "my-video",
  "private": true,
  "scripts": {
    "dev": "remotion studio",
    "build": "remotion render src/index.ts Main out/main.mp4",
    "still": "remotion still src/index.ts Cover out/cover.png --frame=0",
    "compositions": "remotion compositions src/index.ts",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@remotion/cli": "4.0.518",
    "@remotion/media": "4.0.518",
    "@remotion/captions": "4.0.518",
    "@remotion/google-fonts": "4.0.518",
    "@remotion/motion-blur": "4.0.518",
    "@remotion/transitions": "4.0.518",
    "remotion": "4.0.518",
    "react": "19.0.0",
    "react-dom": "19.0.0",
    "zod": "3.23.8"
  },
  "devDependencies": {
    "@types/react": "19.0.0",
    "typescript": "5.6.3"
  }
}
```

- 所有 `@remotion/*` 与 `remotion` **必须同号**，混版本会出 `The following packages have mismatching versions` 或渲染白屏。
- 按需装：不做字幕就不装 `@remotion/captions`，不用转场就不装 `@remotion/transitions`。
- 本机 MTNode 用 `remotion-pack` 时依赖在**安装目录**，工程目录里不要 `npm install`（会被当成第二份依赖源）。

## 2. tsconfig.json（宽松即可编译）

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "jsx": "react-jsx",
    "strict": true,
    "noEmit": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "lib": ["DOM", "ES2020"]
  },
  "include": ["src", "remotion.config.ts"]
}
```

`strict: true` 保留：`defaultProps` 与 `schema` 的类型对齐全靠它兜住。

## 3. 画幅与帧率速查

| 平台 / 用途 | width × height | fps | 30s 的 durationInFrames |
| --- | --- | --- | --- |
| 抖音 / Reels / Shorts 竖屏 | 1080 × 1920 | 30 | 900 |
| YouTube / B 站横屏 | 1920 × 1080 | 30 | 900 |
| 横屏 60fps 流畅版 | 1920 × 1080 | 60 | 1800 |
| 方图（信息流） | 1080 × 1080 | 30 | 900 |
| 4K 横屏 | 3840 × 2160 | 30 | 900（渲染耗时约 1080p 的 4 倍） |
| 与 25fps 实拍混剪 | 1920 × 1080 | 25 | 750 |

安全区（竖屏）：上下各留 220px、左右各留 60px 不被平台 UI 遮挡；字幕基线放在 65% 高度处最稳。

## 4. Composition 与 Still 的取舍

| 需求 | 用 |
| --- | --- |
| 一段视频 | `<Composition>` |
| 一张封面 / 缩略图 / 社交图 | `<Still>`（无 fps，单帧） |
| 同一支片子多语言 | 一个 `<Composition>` + 多份 `inputProps`（不要复制组件） |
| 同一组件多画幅 | 多个 `<Composition>` 指向同一 `component`，画幅不同、`id` 不同 |
| 侧栏分组 | `<Folder name="2026Q4">` 包住若干 Composition |

`<Still>` 渲染：

```bash
npx remotion still src/index.ts Cover out/cover.png --frame=45 --image-format=png
```

## 5. 静态资源目录约定

```
public/
├── audio/
│   ├── bgm.mp3
│   └── voice/full.wav
├── shots/            # 分镜图、页面截图
├── fonts/            # 自托管字体（可选）
└── props/            # 外部 JSON 数据（可用 staticFile 读，也可以直接 import）
```

- 引用路径 **不带** `public/` 前缀：`staticFile("audio/bgm.mp3")`。
- 文件名全小写 + 连字符，避免中文与空格（Windows 与 Linux CI 行为不一致的高发点）。
- 渲染机上不联网：所有远程图片/音频先落到 `public/`，不要在组件里写 `https://`。
- 素材体积控制：单张图 ≤ 2MB、BGM 用 192kbps mp3；10 分钟以上的长音频先裁到实际使用区间。

## 6. remotion.config.ts 常用项

```ts
import { Config } from "@remotion/cli/config";

Config.setEntryPoint("src/index.ts");
Config.setVideoImageFormat("jpeg");     // 中间帧 jpeg 比 png 快 2–3 倍
Config.setConcurrency(4);               // 默认约核数一半
Config.setCodec("h264");
Config.setCrf(18);                      // 质量/体积平衡点
Config.setPixelFormat("yuv420p");       // 兼容性最好
Config.setOverwriteOutput(true);
Config.setChromiumOpenGlRenderer("angle"); // Windows 上更稳
```

配置优先级：CLI 参数 > `remotion.config.ts` > 内置默认值。多机渲染时把差异写进 CLI 而不是改配置文件。

## 7. 帧-秒换算表（30fps）

| 秒 | 帧 | 常用含义 |
| --- | --- | --- |
| 0.1 | 3 | 一次白闪 / 一帧冲击 |
| 0.2 | 6 | 急推落位 |
| 0.5 | 15 | 一个短 hold |
| 0.7 | 21 | 一次词槽轮换 |
| 1.0 | 30 | 品牌字标最短 hold |
| 1.5 | 45 | 一次停顿呼吸 |
| 3.0 | 90 | 开场主体动作弧下限 |
| 5.0 | 150 | 一条完整镜头 |

换帧率时所有常量按 `帧 = 秒 × fps` 重算，不要沿用 30fps 的硬编码帧数。

## 8. 自检清单（交接前）

- [ ] `npx remotion compositions src/index.ts` 列出的 `id`、时长、画幅与预期一致
- [ ] 首帧与末帧都不是空画面（末帧留 hold，不留黑场）
- [ ] 所有资源来自 `public/`，无 `https://` 远程引用
- [ ] `durationInFrames` = 最后一个镜头端点 + 收尾 hold
- [ ] 组件里没有 `transition` / `@keyframes` / Tailwind `animate-*`
- [ ] 每个 `<Sequence>` 都有 `name`（长片时间轴可读）
