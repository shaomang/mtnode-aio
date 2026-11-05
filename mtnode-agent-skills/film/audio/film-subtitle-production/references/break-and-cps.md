# 断句、CPS 与翻译校对

## 1. 断句算法（可复现）

输入：一条 ASR 段（`text` + 起止时间 + 词/字时间戳）。输出：若干 cue。

```text
1. 归一化：去首尾空白，删句末多余句号，全角/半角数字统一，保留语义标点。
2. 切块：按 。！？；… 切成句块；句块仍超长时按 ，、： 切子块。
3. 合并：相邻子块相加 ≤ max_chars 就合并；整句结束（句末标点）必断。
4. 平衡拆分：单个子块 > max_chars 时，按「词数」均分成 ceil(len/max_chars) 块，
   不按字符硬切（中文按词、英文按空格）。
5. 分配时间：块时长 = 段时长 × (该块有效字数 / 总有效字数)；
   最后一块的 end 直接取段 end，避免累计误差。
6. 兜底：任一块时长 < 1.0 s → 与前块合并；合并后仍超 max_chars → 允许该条保持，
   但把字号降到该平台下限（不低于画面高 4.5%）。
7. 重叠清理：后一条 start ≥ 前一条 end + 0.08 s。
```

关键点：

- 中文「有效字数」按汉字计，数字逐个计 1，`%` 计 3（读作「百分之」），英文单词按 1 个词。
- 英文不按字符断词：`broken_inside_word` 属于错误，宁可超一行也要整词换行。
- 时间按字数比例分配只是**切片级近似**，不是逐字对齐；需要卡拉OK级逐字高亮时必须用词级时间戳。
- 一条 cue 最多 2 行；换行位置优先在语义边界，其次在等宽处，禁止只有一个词落在第二行。

## 2. CPS 计算与校对

```python
import re

CPS_LIMIT = {"zh": 9.0, "en": 20.0, "zh_comfort": 7.0, "en_comfort": 17.0}

def effective_chars(text, lang="zh"):
    t = re.sub(r"[\s，。！？；：、,.!?;:\"'（）()《》…—]", "", text)
    if lang == "zh":
        return len(t)
    return len(re.findall(r"[A-Za-z0-9']+", t)) / 1.0  # 英文按词计，再乘换算系数

def check(cue, lang="zh"):
    dur = max(cue["end"] - cue["start"], 1e-6)
    cps = effective_chars(cue["text"], lang) / dur
    problems = []
    if dur < 1.0:
        problems.append("short")
    if dur > 7.0:
        problems.append("long")
    if cps > CPS_LIMIT[lang]:
        problems.append(f"cps:{cps:.1f}")
    return cps, problems
```

判定与处理：

| 症状 | 判定 | 修法（按顺序） |
| --- | --- | --- |
| 显示 < 1.0 s | `short` | 并入相邻 cue → 延到 1.0 s（不越过下一条）→ 删冗余词 |
| 显示 > 7.0 s | `long` | 按语义拆两条；句子本身长就重写 |
| 中文 > 9 字/秒 | `cps` | 删虚词（「其实」「 basically」）→ 换短同义词 → 拆 cue |
| 英文 > 20 CPS | `cps` | 缩写（`do not`→`don't`）→ 删修饰 → 拆 cue |
| 单行 > 20 字（中）/ 42 字符（英） | `width` | 换行（≤2 行）→ 拆 cue → 改写 |
| 相邻重叠 | `overlap` | 后条后移，或前条提前结束 80 ms |

批量校对脚本骨架：

```bash
python3 - <<'PY'
import json, re, sys
subs = json.load(open("cues.json", encoding="utf-8"))
for c in subs:
    dur = c["end"] - c["start"]
    n = len(re.sub(r"[\s，。！？；：、,.!?;:]", "", c["text"]))
    cps = n / max(dur, 1e-6)
    if dur < 1.0 or cps > 9.0 or n > 20:
        print(f'{c["id"]}: dur={dur:.2f}s chars={n} cps={cps:.1f} -> {c["text"]}')
PY
```

## 3. 翻译与双语对齐

- **先断句后翻译**：一条 cue 一个完整意思；不要把一句话拆到两条再各译一半。
- **长度控制**：译文有效字数目标 ≤ 原文 × 1.15；中文译英文按 1 汉字 ≈ 0.6–0.7 词估，英文译中文按 1 词 ≈ 1.6–1.8 字估（通用经验值）。超长就改写，不缩字号。
- **专名与数字**：建术语表（人名、产品名、单位、货币），逐条比对；数字、日期、百分比必须与画面对得上。
- **语气一致**：同一角色全片用同一人称与语域（「您 / 你」不混用）。
- **双语结构**：一条 cue 内 `english` + `chinese`（+ 可选 `note`），共用 `start`/`end`；不要生成两条时间轴再对齐。
- **不译的部分**：画内文字、片名卡、UI 截图里的字，另开 `note` 层或做图形替换，不塞进对白字幕。

双语 cue 示例：

```json
{
  "start": 0.2, "end": 3.8,
  "english": "One word. [[THREE LAYERS.]]",
  "chinese": "一个词，三层意思。",
  "note": "EARTH → INVESTIGATE → LIKE",
  "source": "TED-Ed 原片"
}
```

`[[文字]]` 在渲染器里会变成强调色；`note` 放顶部留白，`source` 只在需要时显示（默认不烧）。

## 4. 时间轴修正

| 问题 | 做法 |
| --- | --- |
| 整体偏移（字幕比声音早/晚） | 全片统一 `--offset -0.4` 一类平移，再抽首尾两条复核 |
| 逐条漂移（越到后面越偏） | 说明时间基准错了：用剪后时间线重建，不做局部修补 |
| 单条错位 | 只改该条 `start`/`end`，保持 ≥1.0 s 且不与邻条重叠 |
| 帧率换算 | `帧 = round(秒 × fps)`；25 fps 一帧 40 ms，30 fps 33.3 ms；只在导出前换算 |
| 变速片段 | 先按变速后的输出时间算，不要用原片时间再乘倍率（会累积误差） |

## 5. 输出格式规范

- SRT：`00:00:01,200 --> 00:00:03,800`，逗号毫秒，序号连续，UTF-8 无 BOM。
- VTT：`00:00:01.200 --> 00:00:03.800`，点号毫秒，首行必须是 `WEBVTT`。
- ASS：`PlayResX/PlayResY` 与画面一致（常用 1920×1080 或 1080×1920），样式名固定（`Chinese` / `English` / `Note`），时间 `h:mm:ss.cc`（厘秒）。
- 一条 cue 的文本内不要手动塞 `\N` 之外的换行符；需要强制换行用 `\N`。

## 6. 交付自检

- [ ] 每条都有 `< 20 字 / 行`、`≤ 2 行`、`1.0–7.0 s`。
- [ ] CPS 全部在上限内，超限条目有改写记录。
- [ ] 无重叠、无空条、无只有标点的条。
- [ ] 首条、末条、最长条、双语条已抽帧看过。
- [ ] 软字幕流带 `language` 与 `title` 元数据；烧录版与软字幕版内容一致。
- [ ] 术语表、数字、专名与画面对得上。
