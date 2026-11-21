# MT 音频频谱分析（本机 · 音频 / 视频 → 拍点 · 段落 · 频谱 JSON）

画布右键 → **处理节点 › MT 音频频谱分析**（节点类型 `audio_spectrum`）。本机跑一份**只依赖 numpy** 的离线分析服务（浏览器不看画面、不联网、无权重），把一段音频（或视频里的音轨）算成「拍点 / BPM / 小节 / 段落 / onset / 能量包络 / 分段速度图 / 高频曲线 / 逐帧强度」，同时画一张**热力图频谱**贴在节点上。产物是**结构化 JSON**（契约 1.1.0），专门给 Agent 与下游节点读。

它不做的事：不转写歌词（那是「MOSS-Music 音乐理解」）、不生成音频（那是 `music_gen` / `yue_gen`）。

## 端子
- **输入**：端口 0 = **音频或视频**（就这一颗；视频只取音轨。值是本机绝对路径或 `file:///` URL）
- **输出**：端口 0 = 分析结果 JSON（自带 `fieldGuide` 字段字典）· 端口 1 = 频谱图 PNG 的绝对路径（图像值）· 端口 2 = 控制输出

## 板身（节点上看到的）
0. **默认收纳**：板身只显示一条灰色的「波形与频谱 ▸」折叠条 —— 波形播放器、热力图、事件叠加层**一个都不绘制**（一张画布上放好几颗频谱节点也不会为解码位图而卡）。点一下这条才展开；展开状态记在节点上（`aaViewOpen`），重绘 / 重开画布都维持展开。还没有结果时这条更灰一档，写着「无内容 · 跑一次 ▶ 后显示」。折叠条下面不会因为收纳而动其他东西：报告入口一直在。
1. **波形播放器**（展开后）：方角播放条 + 波形，点 / 拖波形任意位置就从该处试听（与「音频输入」节点同一只播放引擎，切节点 / 重绘不断音）。2. **热力图频谱**：跑一次 ▶ 后出现。横轴时间、纵轴频率、亮处 = 能量强；**播放时竖线跟着声音走**，点频谱也能定位试听。
3. **频谱上方的事件叠加**：青色长齿 = 重拍（`downbeatsSec`）、灰色短齿 = 拍点（`beatsSec`）、黄色虚线 + 段名 = 段落界线、底边红点 = 能量关键瞬间。右上角那颗 **「事件」** 按钮点一下就能隐藏 / 再显示（默认显示；状态记在节点上，也算设置里的一项）。
4. **「查看分析报告」** 一行：点开在大窗里看排版好的报告（概览 / 段落 / 节奏 / 事件 / 能量 / 诊断 / 产物）。body 里没有摘要 / 输入提示 / 参数摘要 / 状态行。

### 板身什么时候真的去画（性能口径，都是自动的）
- **一屏之内才建**：展开后先只放一块**轻占位**（按宽高比预留高度，不画任何东西、不读音频）；节点滚进「视口外扩一屏」才建波形播放器 / 频谱 / 事件叠加层，滚出一屏就拆掉、占位装回来。拆的时候**正在放的那只会被停下**（外壳都拆了还出声就是 bug）；滚回来重建不重新解码（波形峰值按 `path + size + mtime` 记着上次的结果）。
- **画布缩成缩略总览（缩放到 25% 以下）时不建**：进总览就把重内容全拆掉、只留折叠条；拉回普通档自动按可见性重建。
- **波形不抢 IO**：展开后只挂音源与时间 / 时长占位，波形峰值等「空闲」才排队取（一次只解一件，几颗节点同时展开也不并发解码）；点播放 / 点波形 / 点频谱会把它提到队首。
- **收起着实收高度**：点收起把节点高度收到最小（`minHFor(audio_spectrum)` = 280），展开时还回原来的高度（收起后又手拖改了高度，就保留手拖值）。

## 设置（⚙ 齿轮）
- **下发逐拍明细（detail）**：开 = `beatGrid.beats[]` 逐拍带 onset 强度 / 偏差（更费 token）；关（默认）= 只给 `beatsSec` 与小节表。
- **onset 事件上限**：按强度取前 N（默认 2000，50–20000）。
- **段落算法**：`energyPhase`（默认，快）· `recurrence`（更准更贵；>20 分钟会被自动回退并给 `SECTIONS_FALLBACK`）。
- **额外算 LUFS 响度**：默认关，开了一次多花几秒（要按平台响度交付时开）。
- **可视化**：`spectrogram`（板身用的就是它，建议常开）/ `beatOverlay`（竖线画在拍上的验收图）/ `waveform` / `energyCurve`。
- **频谱上方叠加事件**：默认开（重拍 / 拍点 / 段落界线 / 关键瞬间）；与板身右上角「事件」按钮是同一个开关。
- **缓存策略**：`auto` 命中即用 · `refresh` 强制重算 · `bypass` 只算不写。
- **视频帧率**（24/25/30/50/60）：只影响板身「卡点参数」与报告里的帧数 / 闪拍帧数换算；`energy.perFrame` 按服务默认 30 fps 池化（想换帧率就给它传 `options.fps`）。
- **人工覆盖（overrides）**：⚙ 里没有这一项，节点不发 `options.overrides`；需要手改速度 / 重拍相位 / 段落 / cue 时走 API 或下游脚本，回执看 `diagnostics.overridesApplied`。

## 输出 JSON 怎么给 Agent 读
端口 0 给的是**自描述摘要**，第一层就有 `fieldGuide`（键 = 字段路径，值 = 一句话中文说明 + 单位 + 什么情况下别信）。要点：

- **卡点只读** `beatGrid.beatsSec` / `downbeatsSec`，**不要**用 `global.bpm` 乘出时间轴（浮点会漂）。
- **变速素材**读 `beatGrid.tempoMap`：段内第 k 拍 = `beat0 + k×60/bpm`，段首尾相接覆盖 `0→durationSec`；`beatIndex0` 用来算逐帧拍位（`pos = beatIndex0 + (t−beat0)×bpm/60`，小数部分就是拍内相位）。
- **逐帧闪拍**读 `energy.perFrame`（`kickPulse` / `onset` / `rms`，第 k 点时刻 `t = k×frameSec`）；`energy.curves` 是同一份数据的 raw 曲线（点距看 `hopSec`，原生 hop 看 `nativeHopSec`，`stride>1` 表示抽稀过）。两者**都是强度、不是事件** —— 精确时刻仍回 `beatsSec` / `onsets.events`。
- **人工覆盖**（`options.overrides`：全局音画偏移 / 强制 BPM / 重拍相位平移 / 段落重命名与合并 / 手写 cue）是服务的最后一步合并，结果与冲突对照写进 `diagnostics.overridesApplied`；手写 cue 落 `edit.cues`（`name` 唯一、按 `t` 升序）。节点的 ⚙ 里**没有**这一项，要走 API / 下游脚本传。
- **先看** `diagnostics.warnings` 与 `beatGrid.gridConfidence`：`< 0.8` 或出现 `LOW_CONFIDENCE_BPM` / `TEMPO_HALF_DOUBLE` / `NO_GRID` 时，降级为「按段落剪」，别按拍剪。
- **切点优先级**：`sections[].startSec` > `beatGrid.downbeatsSec` > `beatGrid.beatsSec` > `onsets.events[].t`；`edit.cutPoints` 已经按这个顺序排好（摘要里前 120 条，形状 `{t, snap, strength}`）。手写 cue 另在 `edit.cues`（不和它们抢位）。
- **镜头时长**：`edit.shotDurationTiers`（fast / medium / slow / cinematic，各自 minSec / maxSec）；`forcedBpm` 生效时这一档会按新拍长重算。
- **摘要里的压缩形状**（都是为了让 Agent 少烧 token，完整版在 `fullJsonPath`）：`beatGrid.bars` = 每条 `[startSec, endSec, beatCount, rmsDb, lowDb]`；`onsets.events` 只留前 60 条 `{t, strength, drum, snap}`；`energy.phases` 在超预算时只留段界。`beatGrid.tempoMap`、`energy.curves` / `energy.perFrame`、`edit.cues`、`diagnostics.overridesApplied` **不在摘要里**，只出现在 `fullJsonPath` 指向的整份分析中（要走逐帧闪拍或核对人工覆盖，就读那个文件）。
- **字段字典三档**（⚙ → 字段字典）：`compact`（默认 · 只给这份摘要里真出现的键）/ `full`（服务端全量，当前约 250 条）/ `off`。
- **整份明细**（逐拍数组 `beats[]`、逐事件 `bands` / `step16` / `offsetMs`、`rmsNorm` / `rmsDb`、完整小节表与切点表）只在 `fullJsonPath` 指向的 `analysis.json` 里；长素材的摘要会按长度预算裁剪，裁了什么写在 `truncated[]`。
- **复核**：把 `visuals[].path`（尤其 `beatOverlay`）直接喂识图，看竖线是否压在鼓点上 —— 检测出的网格与算出来的网格，只有看图能分开。

## 消费端：`beatclock.mjs`（卡点 / 逐帧 / 段落，零依赖）

做下游工程（Remotion / 脚本 / ffmpeg 排点）不用自己再解一遍契约：仓库里的 [`docs/audio-analysis/helpers/beatclock.mjs`](../../docs/audio-analysis/helpers/beatclock.mjs)（类型声明同目录 `beatclock.d.ts`）是**六个纯函数、零依赖**，直接吃 `/analyze` 的整份 JSON —— 读 `fullJsonPath` 指向的那份（`tempoMap` / `energy.perFrame` / `curves` 不在输出 0 的摘要里；摘要里的 `beatsSec` 可能被抽样，本库优先用 `tempoMap` 定位拍序号）。

| 函数 | 给什么 | 典型用途 |
|---|---|---|
| `beatAt(rep, t)` | `{ index, startSec, endSec, phase, beatInBar, barIndex, isDownbeat }` | 这一秒在第几拍 / 下一拍几点 |
| `phaseAt(rep, t)` | 0–1（0 = 正拍、0.5 = 半拍） | 闪拍、脉冲、呼吸 |
| `sectionAt(rep, t)` | `{ index, label, startSec, endSec, localSec, progress }` | 换场景、按段落改调色 / 动效 |
| `curveAt(rep, t, kind, source)` | 0–1（线性插值） | 逐帧包络驱动缩放 / 亮度 / 位移 |
| `nextEvent(rep, t, opts)` | `{ t, kind, … }` | 排下一个切点（section / downbeat / cue / accent / onset / beat） |
| `frameOf(rep, t, fps)` | 整数帧号 `round(t×fps)` | 帧工程排 `Sequence` 的 `from` / `durationInFrames` |

```js
import rep from "./bgm.analysis.json"; // /analyze 的整份 JSON（Node 里改用 fs.readFileSync + JSON.parse）
import { nextEvent } from "./docs/audio-analysis/helpers/beatclock.mjs";

// 排切点：从 0 往后跳，优先换段 / 换小节
const cuts = [];
let t = 0;
for (;;) {
  const ev = nextEvent(rep, t, { kinds: ["section", "downbeat"] }); // 要跟鼓就加 "onset"
  if (!ev) break;
  cuts.push({ t: ev.t, snap: ev.kind }); // → ffmpeg 的 -ss / 剪辑台的时间线
  t = ev.t;
}
```

```jsx
import { AbsoluteFill, Sequence, useCurrentFrame, useVideoConfig } from "remotion";
import { beatAt, curveAt, frameOf } from "./docs/audio-analysis/helpers/beatclock.mjs";
import rep from "./bgm.analysis.json";

// ① 闪拍一闪：拍内相位 < 0.2 就是闪白窗口（≈1/5 拍），起亮后线性落回
const FlashOnBeat = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const b = beatAt(rep, frame / fps);
  if (!b) return null;
  const flash = b.phase < 0.2 ? 0.55 * (1 - b.phase / 0.2) + 0.25 : 0; // 重拍可再乘 b.isDownbeat
  return <AbsoluteFill style={{ background: "#fff", opacity: flash, mixBlendMode: "screen" }} />;
};

// ② 逐帧包络驱动缩放：曲线本身就是逐帧强度（第 k 点 t = k×frameSec），别再拿 bpm 数拍
const EnvelopeScale = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const kick = curveAt(rep, frame / fps, "kickPulse") ?? 0; // perFrame 缺了会自动退回 curves
  const scale = 1 + 0.12 * kick * kick; // 平方：小信号不抖，重击才顶起来
  return <AbsoluteFill style={{ transform: `scale(${scale})` }}>{/* 画面 */}</AbsoluteFill>;
};

// ③ 段落换场景：一段一条 Sequence，长度直接读契约里的秒数（frameOf 按 fps 逐点取整）
const SectionScenes = () => {
  const { fps } = useVideoConfig();
  return (
    <>
      {rep.sections.map((s) => {
        const from = frameOf(rep, s.startSec, fps);
        const dur = Math.max(1, frameOf(rep, s.endSec, fps) - from);
        return (
          <Sequence key={s.index} from={from} durationInFrames={dur} name={s.label}>
            <AbsoluteFill style={{ background: s.label === "chorus" ? "#ff2d55" : "#111" }} />
          </Sequence>
        );
      })}
    </>
  );
};
```

要点：**拍内相位**、**逐帧强度**、**段落边界**分别走 `phaseAt` / `curveAt` / `sectionAt`，三套口径互不换算；帧号一律 `frameOf` 逐点取整（一拍通常不是整帧，按「每拍 +N 帧」累加会漂）。`curveAt` 的 `source` 换 `"curves"` 可读 raw 曲线（点距看 `hopSec`）。TS 想拿到类型：从 `"./beatclock"`（不带 `.mjs`）import，或复制一份 `beatclock.d.mts`。

## 触发方式
- 节点头部 **▶** 直接跑；也可从工具栏「运行」走到它（执行体统一在 `playNodeBody` 里分派）。
- 它**没有控制输入**（按需求「单个输入端子」）：下游保存 / 智能节点来取数时如果它还没结果，会先把它补跑一遍（`isAutoProcKind` 口径），所以整条链照样能一键跑到底。
- 跑完会从**输出 2（控制输出）**往下游发一次控制信号，串控制流时接这一颗。

## 注意
- **首次使用会先准备后端**：同步脚手架 → 建 venv → 装 numpy（国内镜像）→ 起本机服务（8774 起顺延）。这一步只发生一次，状态行会写「准备后端：…」；失败时点节点头部的 **▤** 打开后端目录看 `console.log`。
- **上限**：>2 小时或 >2 GiB **直接拒绝**（不截断 —— 截断会让下游按错的秒数切画面）；429「忙」会由宿主自动退避重试（5/10/20 s）。
- **静音素材不算错误**：回空网格 + `NO_ONSET` / `NO_GRID` 警告。
- **产物归缓存 LRU 管**（2 GiB / 30 天）：过期后同一个路径取不到，正确做法是重新点 ▶（命中缓存会重建图）；要长期留存就把输出 1 接「保存图像」节点。
- **契约版本 1.1.0**：升级后 `analyzerVersion` 变了，升级前的旧缓存全部作废（旧条目没有 `curves` / `perFrame` / `overridesApplied`），第一次跑会重算一次，属正常。
- 端口 0 没值时点 ▶ 只会提示「没有音频输入」，不会起后端。
