# 字幕数据格式与分页

## 1. 一份字幕 JSON 应该长什么样

```json
{
  "language": "zh",
  "fps": 30,
  "source": "audio/vo-full.wav",
  "captions": [
    { "text": "这", "startMs": 0,    "endMs": 180,  "timestampMs": 90,  "confidence": 0.98 },
    { "text": "一", "startMs": 180,  "endMs": 320,  "timestampMs": 250, "confidence": 0.97 },
    { "text": "帧", "startMs": 320,  "endMs": 520,  "timestampMs": 420, "confidence": 0.99 },
    { "text": "值", "startMs": 520,  "endMs": 700,  "timestampMs": 610, "confidence": 0.99 }
  ]
}
```

- 一条 = 一个 token（中文按字、英文按词）。不要一条塞整句再靠字数估时长。
- `startMs/endMs` 必须单调不减；相邻 token 允许有 0–40ms 空隙。
- `confidence` 低于 0.6 的 token 上屏前人工核一遍（专有名词、数字、英文缩写是高发错点）。
- 时间戳保留整数毫秒；换算成帧只在渲染时做一次。

## 2. 从 ASR 到这份 JSON

```bash
# 旁白先抽成 16k 单声道（多数本机 ASR / 对齐工具的要求）
ffmpeg -i public/audio/vo-full.wav -ac 1 -ar 16000 -c:a pcm_s16le vo-16k.wav
```

拿到词级结果后按三步清洗：

1. **补标点**：ASR 常无标点，逐词没有停顿信息 → 用标点做分页边界，靠 `endMs - startMs` 的静默间隙（>250ms）反推句读。
2. **合并英文**：英文按空格切词后，把 `U` `I` 这类单字母与相邻词合并，否则会出现"每帧一个字母"的碎页。
3. **对齐长度**：中文语速约 5.5 字/秒、英文约 2.9 词/秒；若实测偏差 >15%，先怀疑文本与音频不是同一版，不要靠改时间戳凑。

## 3. 分页规则（决定"一屏几个词"）

| 平台 / 类型 | 每页 | 组合上限 | 位置 |
| --- | --- | --- | --- |
| 抖音 / Reels 逐词 | 2–4 词（中文 3–8 字） | 1200ms | 画面 65% 高度 |
| 讲解 / 口播整句 | 中文 ≤16 字，英文 ≤48 字符 | 3000–4000ms | 距底 12–18% |
| 教程（信息密度高） | 中文 ≤20 字，两行以内 | 4000ms | 距底 10–14% |

硬规则：**出现折行压到内容区一律按缺陷处理**——改分页，不缩字号。

```ts
import { createTikTokStyleCaptions } from "@remotion/captions";

const { pages } = createTikTokStyleCaptions({
  captions,                                  // 扁平 token 数组
  combineTokensWithinMilliseconds: 1200,     // 超过这个间隔就另起一页
});
// page: { text: string; startMs: number; tokens: Caption[] }
```

`combineTokensWithinMilliseconds` 不是"每页时长"，而是"相邻 token 间隔超过它就断开"；
真正的一页时长 = 下一页 `startMs` − 本页 `startMs`。

## 4. 自己按标点合并（整句式字幕）

```ts
import type { Caption } from "@remotion/captions";

const BREAK = /[。！？!?；;…]/;

export const toSentencePages = (tokens: Caption[]) => {
  const pages: { startMs: number; endMs: number; tokens: Caption[] }[] = [];
  let buf: Caption[] = [];

  const flush = () => {
    if (!buf.length) return;
    pages.push({ startMs: buf[0].startMs, endMs: buf[buf.length - 1].endMs, tokens: buf });
    buf = [];
  };

  for (const t of tokens) {
    buf.push(t);
    const chars = buf.reduce((n, x) => n + x.text.length, 0);
    if (BREAK.test(t.text) || chars >= 16) flush();
  }
  flush();
  return pages;
};
```

## 5. SRT 互转

```ts
import { parseSrt, serializeSrt, type Caption } from "@remotion/captions";

const { captions } = parseSrt({ input: srtText });

const srt = serializeSrt({
  lines: captions.map((c) => ({ text: c.text, startMs: c.startMs, endMs: c.endMs })),
});
```

- `parseSrt` 给的是整句级 `Caption`（无词级时间），只能做整句式字幕；要做逐词高亮必须有 ASR 的词级戳。
- 交付软字幕时保留原始 `.srt` 文件，不要从渲染后的画面反推。

## 6. 双语字幕

两套 token 各自分页会让行数对不齐。做法：**以主语言（观众语言）分页为准**，副语言按时间重叠度对齐到同一页：

```ts
const zhPages = toSentencePages(zhTokens);
const enPages = toSentencePages(enTokens);

const pages = zhPages.map((zh) => {
  const en = enPages.find((p) => p.endMs > zh.startMs && p.startMs < zh.endMs);
  return { zh, en };
});
```

渲染时主语言在上（字重 700），副语言在下（字重 500、透明度 0.75、字号 0.72×）。

## 7. 上屏前校验脚本

```js
// node check-captions.mjs captions.json
import fs from "node:fs";

const { captions, fps } = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
let prevEnd = -1;
let errors = 0;

for (const [i, c] of captions.entries()) {
  if (c.startMs >= c.endMs) { console.error(`#${i} 起止非法`, c); errors++; }
  if (c.startMs < prevEnd - 1) { console.error(`#${i} 与上一条重叠`, c); errors++; }
  if (c.endMs - c.startMs < 60) { console.error(`#${i} 太短（<60ms），会上屏一瞬`, c); errors++; }
  if (c.confidence != null && c.confidence < 0.6) { console.warn(`#${i} 低置信`, c.text); }
  prevEnd = c.endMs;
}

const lastFrame = Math.round((captions.at(-1).endMs / 1000) * fps);
console.log(`共 ${captions.length} 条，末条结束于第 ${lastFrame} 帧，错误 ${errors} 处`);
process.exit(errors ? 1 : 0);
```

合成 `durationInFrames` 必须 ≥ `lastFrame + 15`（收尾 hold），否则最后一句会被切掉。
