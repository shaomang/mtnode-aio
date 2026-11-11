# 渲染报错对照表

按"症状 → 原因 → 修法"查。报错原文保留英文，便于在日志里 grep。

## 1. 打包与合成

| 症状 / 报错原文 | 原因 | 修法 |
| --- | --- | --- |
| `Could not find composition "Main"` | `id` 拼错；`entryPoint` 指到了 `Root.tsx` 而不是 `index.ts`；`registerRoot` 未执行 | `npx remotion compositions src/index.ts` 打印真实列表，用返回的 `id` |
| `No composition with the name ... was found` | 多条合成时大小写/空格不同 | `id` 全用大驼峰、无空格，别在后期改名 |
| `Module not found: Can't resolve './scene/X'` | Windows 大小写不一致 / 文件没保存 | 文件名与 import 逐字对齐；CI 上 Linux 对大小写敏感 |
| `Cannot find module '@remotion/media'` | 装了 `remotion` 但没装子包 | `npm i @remotion/media@<与 remotion 同号>` |
| `The following packages have mismatching versions` | `@remotion/*` 版本不齐 | 全部锁到同一版本号，删 `node_modules` 重装 |

## 2. 浏览器与并发

| 症状 | 原因 | 修法 |
| --- | --- | --- |
| `Target closed` / `Protocol error` | 内存不足、标签页崩溃、并发过高 | `--concurrency=2`；4K 降到 1080p；批量每 20 条重启浏览器 |
| `Failed to launch browser` / 下载卡住 | Chrome Headless Shell 未就绪、离线 | 联网跑一次真实渲染触发下载；离线环境预置浏览器目录 |
| `Timed out waiting for ...` | 资源加载慢（远程图/字体/大视频） | 资源全部本地化；`delayRender()` 要保证有对应的 `continueRender()` |
| `Rendering was aborted` | `abortSignal` 被触发、或 Studio 中途改参数 | 重跑；`calculateMetadata` 里把 `abortSignal` 透传给 `fetch` |
| Windows 上崩溃且无明确报错 | GPU 合成问题 | `--gl=angle`；仍崩改 `--gl=swangle`（慢但稳） |

## 3. 画面问题

| 症状 | 原因 | 修法 |
| --- | --- | --- |
| 首帧黑屏 | 图片未加载完就截帧；用了裸 `<img>` | 换 `<Img src={staticFile(...)} />`；视频用 `<OffthreadVideo>` |
| 图片 404（Studio 正常、渲染报错） | `staticFile("/a.png")` 多了前导斜杠，或文件不在 `public/` | `staticFile("a.png")`，路径相对 `public/` |
| 动画停在第一帧 | 用了 CSS `transition` / `@keyframes` / Tailwind `animate-*` | 全部改成 `useCurrentFrame()` 派生值 |
| 中间某段全黑 | `Sequence` 的 `from` 超出总时长，或 `durationInFrames` 算小了 | 用最后一个镜头的端点反算总帧数 |
| 字体在渲染机上变形 | 依赖系统字体 | `@remotion/google-fonts` 的 `loadFont()` 或 `@font-face` + `staticFile()` |
| 文字有彩色毛边/蚊噪 | crf 过高、或 `pixelFormat` 不是 `yuv420p` | `--crf=16~18`、`--pixel-format=yuv420p`；细线场景 `--image-format=png` |
| 画面整体偏暗/偏色 | 中间帧用了 jpeg 且有大面积渐变 | 该片改用 `--image-format=png` |

## 4. 音频问题

| 症状 | 原因 | 修法 |
| --- | --- | --- |
| 成片无声 | `<Audio>` 在总时长之外、`muted`/`--muted`、或 `volume` 为 0 | `ffprobe` 查有没有音轨；核对 `Sequence from` 与总帧数 |
| 音频比画面短 | `durationInFrames` 未给且源文件短 | `getAudioDurationInSeconds()` 量真实时长后对齐 |
| 有"啪"的爆音 | 首帧/末帧音量为非零突变 | 首尾各做 0.5–1.0s 淡入淡出 |
| 声音变调 | `playbackRate` 超出 0.5–2 | 保持在 0.5–2，或改用 `toneFrequency`（仅服务端生效） |
| 预览有声、渲染无声 | `toneFrequency` 只在渲染生效；或反过来用了远程 URL | 全部本地 `public/` 文件 |

## 5. 批量与 CI

| 症状 | 原因 | 修法 |
| --- | --- | --- |
| 第 N 条开始全部失败 | 浏览器实例泄漏 / 磁盘满 | 每 20 条重启浏览器；渲染前查磁盘余量（每条 50–300MB） |
| 每条视频时长都一样 | `calculateMetadata` 未生效 | 打日志确认入参 `props`；确认返回值含 `durationInFrames` |
| 输出互相覆盖 | slug 重复或含空格/中文 | `slugify` + 序号后缀，manifest 记录映射 |
| CI 上字体/数字格式不同 | runner locale 与系统字体 | 显式 `toLocaleString("en-US")`、打包字体 |
| 上传产物是 0 字节 | 渲染失败但没检查退出码 | 脚本里校验文件大小 > 100KB，失败即非零退出 |

## 6. 排查顺序（照这个顺序走，别乱试）

1. `npx remotion compositions src/index.ts` —— 合成在不在、时长对不对。
2. `npx remotion still ... --frame=0` —— 单帧能不能出图（排除资源问题）。
3. `--frames=0-29` 渲 1 秒 —— 音轨、首帧、动画是否推进。
4. `--log=verbose` 看是哪一步慢/哪条资源超时。
5. 降并发 → 换 `--gl=angle` → 降分辨率 —— 依次排除资源与显存问题。
6. 最后才怀疑代码逻辑：用 `--frames=<问题帧>-<问题帧+1>` 精确重渲那两帧。
