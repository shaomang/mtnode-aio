"""契约常量、错误码、警告码与字段字典。

本文件是 /analyze 契约（docs/audio-analysis/）在实现侧的**唯一真源**：
版本号、时间基准、帧网格、单位字典、错误码 → HTTP 状态映射、字段中文说明。
改契约口径只改这里，其它模块一律从本文件取值。

全部注释与消息为中文。
"""

from __future__ import annotations

# ---------------------------------------------------------------- 服务身份

SERVICE_NAME = "mtnode.audio.analyze"
# 1.1.0：只增字段（beatGrid.tempoMap / energy.curves / energy.perFrame / edit.cues /
# diagnostics.overridesApplied 等），不删不改既有字段的语义与单位 —— 按 1.0.0 写的解析器仍成立
# 1.2.0：只增字段（beatGrid.bars[].energyDb / energy01 与 energy.barEnergy），rmsDb/lowDb 语义不变
VERSION = "1.2.0"

# ---------------------------------------------------------------- 策略常量（与 /health.limits 一一对应）

MAX_DURATION_SEC = 7200                 # 单次分析素材时长上限（2 小时），超了直接拒绝，不截断
MAX_SOURCE_BYTES = 2 * 1024 ** 3        # 源文件体积上限 2 GiB
ANALYZE_BUDGET_SEC = 300                # /analyze 硬预算；超时回 504 但后台线程继续跑完
DOWNSAMPLE_OVER_SEC = 600              # 超过 10 分钟降采样到 11025 Hz（帧率不变）
REQUEST_BODY_BYTES = 65536              # 请求体上限 64 KiB
SECTIONS_FALLBACK_OVER_SEC = 1200       # 超过 20 分钟强制 energyPhase 段落法
CONNECTION_LIMIT = 16                   # 同时连接数上限
ARTIFACT_MAX_BYTES = 8 * 1024 ** 2      # 单张产物上限 8 MB

# 缓存策略（service-contract §九）
CACHE_MAX_BYTES = 2 * 1024 ** 3         # 缓存总容量 2 GiB
CACHE_MAX_ENTRY_BYTES = 256 * 1024 ** 2  # 单条超过 256 MiB 不落盘
CACHE_TTL_SEC = 30 * 86400              # 30 天未使用即淘汰

# ---------------------------------------------------------------- 帧网格（两档帧率相同，时间坐标不漂）

GRID_FULL = {"sr": 22050, "hopLength": 512, "nFft": 2048}
GRID_DOWNSAMPLED = {"sr": 11025, "hopLength": 256, "nFft": 2048}

ENERGY_HOP_SEC = 0.1                    # 能量栅格固定 0.1 s（与帧网格无关的第二套栅格）
ATTACK_HOP_SEC = 0.001                  # attack 精修用的 1 ms 细栅格（内部量，不进响应）

# ---------------------------------------------------------------- 检测器系统延迟（标定值）
#
# 每个检测器的输出时间轴相对真实声学事件都有一个**固定的系统延迟**（算法结构决定，与素材无关）：
# 1 ms attack 栅格上的平滑偏置、块 RMS 的「标签取块起点」偏置、逐帧池化的「标签取帧起点」偏置。
# 数值在合成脉冲 / 点击轨上标定（`scripts/calibrate_latency.py`，真值已知），本文件是唯一真源：
#   * 分析链按这里的常数做校正 —— onsets / beats 是时间轴的标量平移，
#     curves / kick 是块栅格的半块平移（采样级），perFrame 是池化栅格的半帧平移；
#   * `scripts/calibrate_latency.py --check` 逐项对账（容差 LATENCY_TOLERANCE_MS）；
#   * `scripts/check.py` 与 `test/smoke-audio-analysis.js` 在合成点击轨上复核（拍点误差 < 5 ms）。
# 单位毫秒，**正 = 输出比真实事件晚**（校正时减去）；栅格类的延迟是「半个栅格」，
# 这里的数值按名义栅格折算，运行期用 detector_latency_ms(name, grid_sec) 按真实栅格缩放
# （换了帧率 / 采样率不用重新标定）。
DETECTOR_LATENCY_MS = {
    # 谱通量峰 → 1 ms attack 精修：3 ms 包络平滑 + 1 ms 采样栅格，整体偏早约 1.5 ms
    "onsets": -1.45,
    # 拍点走同一条 attack 精修链（beats.refine 吸附的也是 attack），所以与 onsets 同值
    "beats": -1.45,
    # 块 RMS（hop≈5.805 ms）：点 k 的标签取块起点，比块中心早半个 hop
    "curves": -2.9,
    # 曲线里的 onset 是块 RMS 的半波整流差分，不引入额外偏移：标定值必须与 curves 一致
    "onset": -2.9,
    # kick 走同一条块 RMS（40–80 Hz 窄带），同样早半个 hop
    "kick": -2.9,
    # 逐帧池化：帧 k 的标签取帧起点，比帧中心早半帧（30 fps 名义值 = -16.67）
    "perFrame": -16.67,
}

#: 栅格类延迟的**名义栅格**（秒）：运行期按实际栅格等比缩放（半块 / 半帧）。
#: curves/kick：curve_hop(22050)=128 采样点 → 128/22050 s；perFrame：30 fps 的帧长。
GRID_LATENCY_NOMINAL_SEC = {
    "curves": 128.0 / 22050.0,
    "onset": 128.0 / 22050.0,
    "kick": 128.0 / 22050.0,
    "perFrame": 1.0 / 30.0,
}

#: 标定对账容差（毫秒）：低于它就认为「contract 里的常数仍然是当前实现的真值」。
LATENCY_TOLERANCE_MS = 0.5


def detector_latency_ms(name: str, grid_sec: float | None = None) -> float:
    """某个检测器的系统延迟（毫秒，正 = 输出偏晚）；栅格类按实际栅格缩放。

    `grid_sec` 只对栅格类（curves / onset / kick / perFrame）有意义：
    延迟是半个栅格，栅格一变（帧率、采样率降档）就等比缩放，不用重新标定。
    """
    base = float(DETECTOR_LATENCY_MS.get(str(name), 0.0))
    nominal = GRID_LATENCY_NOMINAL_SEC.get(str(name))
    if grid_sec and nominal and nominal > 0:
        return base * (float(grid_sec) / float(nominal))
    return base


def detector_latency_sec(name: str, grid_sec: float | None = None) -> float:
    """同上，换成秒（分析链内部用）。"""
    return detector_latency_ms(name, grid_sec) / 1000.0

# ---------------------------------------------------------------- 单位字典

UNITS = {
    "s": "秒（从媒体起点算起）",
    "Hz": "赫兹",
    "dBFS": "分贝（0 = 满刻度）",
    "dB": "分贝（相对量）",
    "LUFS": "整体响度（LKFS/LUFS）",
    "BPM": "每分钟拍数",
    "ms": "毫秒",
    "px": "像素",
    "B": "字节",
    "0-1": "归一化无量纲量",
    "count": "个（计数）",
}

# ---------------------------------------------------------------- 错误码 → (HTTP 状态, 中文消息)

ERRORS = {
    "E_INPUT_MISSING": (400, "输入文件缺失或路径不合法"),
    "E_UNAUTHORIZED": (401, "缺少或错误的 API Key"),
    "E_TOO_LONG": (413, "素材超过时长或体积上限"),
    "E_UNSUPPORTED_FORMAT": (415, "扩展名与内容都不在可解码范围"),
    "E_NO_AUDIO_STREAM": (422, "容器里没有音频流"),
    "E_BUSY": (429, "后端忙（单并发，已有分析在跑）"),
    "E_DECODE_FAILED": (500, "解码失败（ffmpeg 返回非 0）"),
    "E_INTERNAL": (500, "后端内部错误"),
    "E_TIMEOUT": (504, "超过分析预算"),
}

# ---------------------------------------------------------------- 警告码（schema 枚举，一个不多一个不少）

WARNING_CODES = (
    "LOW_CONFIDENCE_BPM",
    "TEMPO_HALF_DOUBLE",
    "NO_ONSET",
    "NO_DOWNBEAT",
    "NO_GRID",
    "SHORT_AUDIO",
    "ONSETS_TRUNCATED",
    "SECTIONS_FALLBACK",
    "KEY_UNRELIABLE",
    "DOWNSAMPLED",
)

# 段落标签（schema 枚举）
SECTION_LABELS = (
    "intro", "verse", "prechorus", "chorus", "bridge",
    "breakdown", "drop", "outro", "unknown",
)


class AnalyzeError(Exception):
    """分析失败的统一异常：code 决定 HTTP 状态，detail 只写日志（响应里截 3 行）。"""

    def __init__(self, code: str, message: str = "", detail: str = "", http: int = 0):
        self.code = code
        base_http, base_msg = ERRORS.get(code, (500, "后端内部错误"))
        self.http = http or base_http
        self.message = message or base_msg
        self.detail = detail or ""
        super().__init__(self.message)

    def to_error_block(self) -> dict:
        """→ 响应里的 error 块；detail 截前 3 行（traceback 全文只进日志）。"""
        block = {"code": self.code, "message": self.message}
        detail = _tail_lines(self.detail, 3)
        if detail:
            block["detail"] = detail
        return block


def _tail_lines(text: str, n: int = 3) -> str:
    """取最后 n 行；空文本回空串。"""
    if not text:
        return ""
    lines = [ln for ln in str(text).splitlines() if ln.strip()]
    return "\n".join(lines[-n:])


# ---------------------------------------------------------------- 网格与契约块


def frame_grid(duration_sec: float | None) -> tuple[dict, bool]:
    """按时长选帧网格；返回 (grid, 是否降采样)。两档帧率都是 43.066 fps。"""
    if duration_sec is not None and duration_sec > DOWNSAMPLE_OVER_SEC:
        return dict(GRID_DOWNSAMPLED), True
    return dict(GRID_FULL), False


def frame_rate_hz(grid: dict) -> float:
    return grid["sr"] / float(grid["hopLength"])


def contract_block(grid: dict) -> dict:
    """contract 块：成功与错误响应共用同一份形状。"""
    sr = int(grid["sr"])
    hop = int(grid["hopLength"])
    return {
        "name": SERVICE_NAME,
        "version": VERSION,
        "timeBase": {
            "unit": "s",
            "origin": "media_start",
            "description": "所有时间字段单位为秒（浮点），原点是解码后音频的第 0 个采样点（不是容器 PTS）。",
        },
        "frameGrid": {
            "sr": sr,
            "hopLength": hop,
            "nFft": int(grid["nFft"]),
            "frameRateHz": round(frame_rate_hz(grid), 3),
            "frameSec": round(hop / float(sr), 5),
        },
        "energyGrid": {"hopSec": ENERGY_HOP_SEC},
        "units": dict(UNITS),
    }


# ---------------------------------------------------------------- 字段字典（给 Agent 读的中文说明）

# 键 = 响应体里的字段路径；值 = 一句话：单位 + 怎么用 / 什么时候别信。
FIELD_GUIDE = {
    # —— 顶层
    "ok": "布尔值：true = 分析成功（结构按成功分支解析），false = 失败（只看 error 块，别读其它块）。",
    "contract": "自描述块：先读它才知道其余字段的单位与坐标基准，别用别的版本猜。",
    "contract.name": "服务标识，恒为 mtnode.audio.analyze；用于确认对面就是音频分析后端。",
    "contract.version": "契约版本（语义化，当前 1.2.0）：主版本不同说明字段可能被删改，不要照旧解析；次版本升级只代表新增字段（如 tempoMap / energy.curves / energy.barEnergy / bars[].energy01），老字段语义不变。",
    "contract.timeBase": "时间基准说明：单位秒、原点=解码后第一个采样点（不是容器 PTS，也不是首帧时间戳）。",
    "contract.frameGrid": "帧级坐标基准（STFT 帧）：拍点/onset 的频率分析都在这套参数下做的。",
    "contract.frameGrid.sr": "分析采样率（Hz）：22050，长素材降为 11025；全链路唯一，不要用源文件采样率换算。",
    "contract.frameGrid.hopLength": "帧移（采样点）：与 sr 一起决定帧率；降采样时同步减半，所以帧率不变。",
    "contract.frameGrid.nFft": "STFT 窗长（采样点），决定频率分辨率 sr/nFft（22050 下约 10.8 Hz）。",
    "contract.frameGrid.frameRateHz": "帧率（帧/秒），两档都是 43.066；用它做秒→帧换算：frame=round(t*43.066)。",
    "contract.frameGrid.frameSec": "每帧时长（秒）≈0.02322；这就是网格的时间量化精度，卡点误差下限。",
    "contract.energyGrid.hopSec": "能量栅格步长（秒），恒 0.1；与帧网格是两套栅格，别互相换算。",
    "contract.units": "单位字典：字段里出现的每个单位符号在这里给中文含义，别猜。",
    # —— meta
    "meta": "元信息块：这段音频是什么、多长、按什么规格分析，用于回溯与对齐视频。",
    "meta.source.path": "输入媒体的本机绝对路径（realpath 后）。",
    "meta.source.bytes": "源文件字节数（B）。",
    "meta.source.sha256": "文件内容摘要；本实现不算，恒为空串（用 mtime+size 做缓存键）。",
    "meta.source.container": "容器/扩展名（小写，如 mp3/wav/mp4），仅作提示，判断可解码性要看实际解码结果。",
    "meta.durationSec": "分析时长（秒）= 解码后采样数 / 采样率；所有 *Sec 字段都不超过它。",
    "meta.sampleRateHz": "分析采样率（Hz），恒等于 contract.frameGrid.sr。",
    "meta.sourceSampleRateHz": "源文件原始采样率（Hz）：分析前被重采样过，回溯重采样损耗时看这里。",
    "meta.channels": "分析声道数，恒 1（已下混为单声道）。",
    "meta.sourceChannels": "源文件声道数，用于判断素材是不是立体声/多声道。",
    "meta.decoder.tool": "解码器名，恒 ffmpeg；换解码器会带来毫秒级偏移。",
    "meta.decoder.version": "ffmpeg 版本串（首行截取）。",
    "meta.decoder.args": "实际使用的解码参数（-vn -ac 1 -ar <sr> -f f32le），留痕用。",
    "meta.analyzedAt": "本次分析完成的时刻（ISO-8601 UTC，带 Z）。",
    # —— global
    "global": "全局属性块：速度、拍号、重拍相位、调性；全部是估计值，先看置信度再用。",
    "global.bpm": "每分钟拍数（BPM），已做倍频纠正；只作近似描述，卡点请用 beatGrid.beatsSec。",
    "global.bpmConfidence": "BPM 置信度 0-1：≥0.8 可信，<0.5 建议人工确认或改手工网格。",
    "global.beatPeriodSec": "一拍时长（秒）=60/bpm；只用于外推 beatsSec 覆盖不到的尾部，别用它累乘整条时间轴。",
    "global.bpmCandidates": "候选速度表（永远多于一条）：用于诊断倍频误判，真值常藏在半速/倍速条目里。",
    "global.bpmCandidates[].bpm": "某一个候选的 BPM 数值。",
    "global.bpmCandidates[].source": "候选来源：beatTrack（拍轨）/medianInterBeat（中位拍间隔）/tempogram（自相关峰）/foldRefine（倍频纠正）/userHint（调用方给的先验）。",
    "global.bpmCandidates[].score": "该候选的分数 0-1（越高越可信）；不同 source 的分数不可直接横比。",
    "global.timeSignature": "拍号猜测（启发式）：分母固定 4，分子只给 2/3/4/6/7。",
    "global.timeSignature.numerator": "每小节拍数（分子），4 = 4/4；没判出重拍时恒 4 且 confidence 很低。",
    "global.timeSignature.denominator": "拍号分母，固定 4。",
    "global.timeSignature.confidence": "拍号猜测置信度 0-1；<0.4 说明重拍证据不足，别把它写进画面节奏说明。",
    "global.timeSignature.method": "拍号判据：lowBandPhase（低频相位）/barAccent（小节重音）/none（没判出来）。",
    "global.downbeatPhase": "小节内第几拍是重拍（0 基，0-3）；与 beatGrid.downbeatsSec 同源，downbeatMethod=none 时无意义。",
    "global.tempoVerified": "三条独立路径（拍轨/中位间隔/tempogram）的 log2 比值是否都落在 ±0.02；false = 速度存疑。",
    "global.tempoConfidence": "分段速度图的整体置信度 0-1（onset 包络在拍周期上自相关复核，时长加权）：<0.5 说明速度存疑或与半步/倍步候选分不开，卡点仍以 beatsSec 为准。",
    "global.key": "调性 {tonic,mode,confidence,method}；本实现恒 null（不做调性估计），别当 C 大调。",
    # —— beatGrid
    "beatGrid": "拍网格块（核心）：卡点只认这里的秒数，不要用 bpm 乘出来。",
    "beatGrid.beatsSec": "全部拍点时间（秒，严格升序，已吸附到真实 attack，并已扣除 1 ms attack 栅格上的系统延迟约 1.5 ms）；卡点唯一坐标，长度=beatCount。",
    "beatGrid.beatCount": "拍数（= beatsSec 长度）；0 表示没判出网格，下游走无节奏分支，禁止除零。",
    "beatGrid.downbeatsSec": "小节重拍时间（秒，升序），是 beatsSec 的子集；空数组=没判出 downbeat。",
    "beatGrid.firstBeatSec": "首拍时间（秒），等于 beatsSec[0]；可能 >0（前奏不进网格）。",
    "beatGrid.downbeatMethod": "重拍判据：lowBandPhase（低频相位，唯一主判据）/energyOnset/barAccent（启发式）/none（没判出）。",
    "beatGrid.gridConfidence": "网格置信度 0-1，等于 attackCoverage（拍点落在真实 attack ±25ms 的占比）；<0.8 不可信，<0.5 已降级为空网格。",
    "beatGrid.gridCalibrationMs": "attack 精修后整条网格的位移（毫秒）；|·|>30 需要人工看一眼，正=网格后移。",
    "beatGrid.tempoMap": "分段速度图（拍序号↔时刻做 Huber 稳健回归后切段，段首尾相接覆盖 0→durationSec）：变速素材的卡点、逐帧相位与渲染都读这一块，不要只用 global.bpm 一个数。",
    "beatGrid.tempoMap[].start": "该段起点（秒）；首段恒 0，末段 end 恒等于 durationSec。",
    "beatGrid.tempoMap[].end": "该段终点（秒），等于下一段起点。",
    "beatGrid.tempoMap[].bpm": "该段速度（BPM）= 60 / 回归斜率（秒/拍）；段内近似恒定，跨段才是变速。",
    "beatGrid.tempoMap[].beat0": "该段首拍时刻（秒）：段内第 k 拍 = beat0 + k × 60/bpm（逐帧取相位就用这条式子）。",
    "beatGrid.tempoMap[].confidence": "该段速度置信度 0-1（局部 onset 包络自相关）；<0.5 时这一段的 bpm 只当量级，卡点用 beatsSec。",
    "beatGrid.tempoMap[].octaveHint": "半步/倍步复核：none（拍周期上就是自相关主峰）/double（半拍处更强，真实速度可能两倍）/half（两拍处更强，可能一半）。",
    "beatGrid.tempoMap[].beatFrom": "该段起点对应的原始检测拍序号（0 基）；与 diagnostics.beatsRaw 对账用。",
    "beatGrid.tempoMap[].beatTo": "该段终点对应的原始检测拍序号（不含）。",
    "beatGrid.tempoMap[].beatIndex0": "该段首拍在重生成网格里的全局拍序号（0 基）；拍序号跨段连续，逐帧相位靠它定位。",
    "beatGrid.tempoMap[].beats": "该段实际生成了几拍（可能为 0：段太短或相位被上一段吃掉）。",
    "beatGrid.tempoMap[].fitDevMs": "该段 Huber 回归的中位残差（毫秒）；越大说明这段拍点越晃（变速或自由节奏），别按等间隔外推。",
    "beatGrid.bars": "小节分组（首尾相接、index 从 0 连续）；给小节级卡点与响度对比用。",
    "beatGrid.bars[].index": "小节序号（0 基，相对本音频起点）。",
    "beatGrid.bars[].startSec": "小节起点（秒）= 该小节第一拍。",
    "beatGrid.bars[].endSec": "小节终点（秒）= 下一小节起点；末小节可能到 durationSec。",
    "beatGrid.bars[].downbeatSec": "该小节重拍时间（秒），等于 startSec。",
    "beatGrid.bars[].beatCountInBar": "小节内实际拍数；末小节可能不足（如 3）。",
    "beatGrid.bars[].rmsDb": "该小节 RMS 电平（dBFS），用于找 intro/drop/break。",
    "beatGrid.bars[].lowDb": "该小节低频（<150Hz）RMS 电平（dBFS），比 rmsDb 更能反映鼓的力度。",
    "beatGrid.bars[].energyDb": "该小节感知电平（dB，相对全曲最响帧，≤0）：6 带近似 K 加权后按功率域平均，低频被压低、中高频被抬高，跟耳朵听到的「满 / 空」一致；缺帧特征时该键不存在。",
    "beatGrid.bars[].energy01": "该小节感知能量 0-1：energyDb 按全曲小节 p5–p95 稳健归一（个别爆音 / 静音尾巴不会压扁整条）；画柱高、排切点密度用它，不要再用 rmsDb 线性拉伸。",
    "beatGrid.phrases": "乐句（4 小节一组，末句用 durationSec 收口）；做大段落级镜头编排用。",
    "beatGrid.phrases[].index": "乐句序号（0 基）。",
    "beatGrid.phrases[].startSec": "乐句起点（秒）。",
    "beatGrid.phrases[].endSec": "乐句终点（秒），末句 = durationSec。",
    "beatGrid.phrases[].barStart": "起始小节序号（含）。",
    "beatGrid.phrases[].barEnd": "结束小节序号（含）。",
    "beatGrid.beats": "逐拍明细；仅 options.detail=true 时下发，省 token 时不要请求它。",
    "beatGrid.beats[].t": "该拍时间（秒），与 beatsSec 同源。",
    "beatGrid.beats[].index": "全局拍序号（0 基）。",
    "beatGrid.beats[].bar": "所属小节序号；空网格时为 0，别拿来定位。",
    "beatGrid.beats[].beatInBar": "小节内第几拍（0 基）；与 global.downbeatPhase 配合找重拍。",
    "beatGrid.beats[].isDownbeat": "是否小节重拍（等价于 t 落在 downbeatsSec 里）。",
    "beatGrid.beats[].onsetStrength": "该拍位置的 onset 包络强度 0-1（局部归一）；低值说明这一拍是推出来的而非打出来的。",
    "beatGrid.beats[].snapped": "该拍是否吸附到了附近真实 attack；false 说明附近 40ms 内没有明确 attack。",
    "beatGrid.beats[].offsetMs": "吸附位移（毫秒，正=后移）；|·|>30 的那一拍值得复核。",
    # —— onsets
    "onsets": "敲击事件块：这一下是什么、多强、落在网格哪一格；按「叮」剪素材时用它。",
    "onsets.count": "全曲检测到的（截断前）事件总数；0 = 静音或没有敲击，不是错误。",
    "onsets.ratePerSec": "事件密度（个/秒）= count/durationSec；>4 通常说明鼓组很密或误检偏多。",
    "onsets.truncated": "events 是否被 onsetsLimit 截断；true 时 count 仍是真值。",
    "onsets.limit": "events 上限（默认 2000）：按 strength 取前 N 再按 t 升序回排。",
    "onsets.events[].t": "事件时间（秒，已精修到 attack 起点，并已扣除 1 ms attack 栅格上的系统延迟约 1.5 ms）；按「叮」剪就用它。",
    "onsets.events[].strength": "包络强度 0-1（局部归一）：同一段内可比，跨段不可比。",
    "onsets.events[].energy": "该帧全带功率 / 全曲最大 0-1：与画面冲击力线性对应，选重音用。",
    "onsets.events[].bands": "三带相对占比（power 归一），三个数之和≈1：判断这一下是闷的还是脆的。",
    "onsets.events[].bands.low": "低频占比 0-1（<150Hz）：高 = 底鼓/贝斯重击。",
    "onsets.events[].bands.mid": "中频占比 0-1（150-2000Hz）：高 = 军鼓/人声/吉他。",
    "onsets.events[].bands.high": "高频占比 0-1（≥2000Hz，降采样时只到 5512Hz）：高 = 镲/齿音。",
    "onsets.events[].bandDb": "三带绝对电平（dBFS，可选）：要看真实响度差时用它，占比会被同时刻其它带拉平。",
    "onsets.events[].bandDb.low": "低频绝对电平（dBFS）。",
    "onsets.events[].bandDb.mid": "中频绝对电平（dBFS）。",
    "onsets.events[].bandDb.high": "高频绝对电平（dBFS）。",
    "onsets.events[].drum": "鼓型：kick/snare/hat/perc/glitch/unknown（窄带核判定）；宁可给 perc 也不硬判成 hat。",
    "onsets.events[].drumConfidence": "鼓型可信度 0-1；<0.5 时把 drum 当 perc 看。",
    "onsets.events[].grid": "相对网格的强弱位：strong（16 分格 0/8）、weak（2/4/6/10/12/14）、syncopated（其余格）、offGrid（偏离 16 分线>1/8 拍）、unknown（无网格）。",
    "onsets.events[].beatIndex": "所在拍的全局序号（0 基）；无网格时缺省。",
    "onsets.events[].beatInBar": "所在拍在小节内的序号（0 基）；无网格时缺省。",
    "onsets.events[].step16": "相对小节起点的十六分音符格 0-15；0/8 是强位，4/12 是次强位。",
    "onsets.events[].offsetMs": "相对最近 16 分线的偏差（毫秒，正=晚）；|·|>半格说明这不在格上。",
    "onsets.events[].special": "特殊语义：hardStop（紧贴突然停顿，剪辑必须留白）/riser（爬升前奏，剪辑应加速）。",
    # —— energy
    "energy": "能量块：0.1s RMS 包络 + 粗相位 + 关键转折；给视觉密度用，不参与卡点。",
    "energy.hopSec": "每点代表的秒数，恒 0.1。",
    "energy.points": "点数 = ceil(durationSec/0.1)；与 rmsNorm/rmsDb 同长。",
    "energy.rmsNorm": "每 0.1s RMS 归一到全曲最大=1 的数组（给程序读，别整段塞进上下文）；基准是最大 RMS 不是 0dBFS。",
    "energy.rmsDb": "每 0.1s RMS 电平（dBFS，底 -80），与 rmsNorm 同长同序。",
    "energy.globalDb": "整段电平统计（dBFS）。",
    "energy.globalDb.rms": "整段 RMS 电平（dBFS）。",
    "energy.globalDb.peak": "整段峰值电平（dBFS）；接近 0 说明已经削顶。",
    "energy.globalDb.lufsIntegrated": "整体响度（LUFS），仅 options.loudness=true 时算（走 ebur128），算不出为 null。",
    "energy.phases": "粗相位段（0.2/0.4/0.65 三阈值分四档后合并相邻同档）；找「哪里进副歌」「哪里留白」用它。",
    "energy.phases[].label": "档位：VOID（近乎无声，换气窗）/LOW/MEDIUM/HIGH（按归一 RMS）。",
    "energy.phases[].startSec": "该相位起点（秒）。",
    "energy.phases[].endSec": "该相位终点（秒）= 下一相位起点，末段到 durationSec。",
    "energy.phases[].character": "音色印象：full（全带宽厚）/heavy（低频重）/bright（高频亮）/intimate（中频贴耳）/sparse（稀疏）。",
    "energy.phases[].bands": "6 带能量占比（sub/bass/lowMid/mid/presence/air，和≈1），判定 character 的依据。",
    "energy.phases[].onsetRate": "该段事件密度（个/秒）：越高越适合快剪。",
    "energy.phases[].peakDb": "该段峰值电平（dBFS）。",
    # —— energy.curves（raw 高频曲线）
    "energy.curves": "抽稀后的 raw 高频曲线（原生 hop≈5.8ms，六条各 0-1）；看包络形状与瞬态，别拿它的 argmax 当拍点（拍点只认 beatsSec）。",
    "energy.curves.hopSec": "下发点距（秒）= 原生 hop × stride；第 k 个点的时刻 = k × hopSec（块中心已按检测器系统延迟对齐到 k×hopSec，见 diagnostics.parameters.detectorLatencyMs）。",
    "energy.curves.nativeHopSec": "原生 hop（秒，≈0.0058；降采样档同比减半，仍是同一时间口径）；stride=1 时等于 hopSec。",
    "energy.curves.stride": "抽稀倍数（整数）：1 = 未抽稀；>1 表示一个点由 stride 个原生点合成（瞬态取 max、响度取 mean，不抹掉瞬态）。",
    "energy.curves.points": "点数（= 六条曲线的共同长度）；读数组前先看它，别假定等于 durationSec/hopSec。",
    "energy.curves.rms": "全带 RMS 曲线 0-1（按全曲最大归一）；看整体响度走势。",
    "energy.curves.low": "低频（<150Hz）RMS 曲线 0-1；底鼓/贝斯厚不厚看它。",
    "energy.curves.mid": "中频（150-2000Hz）RMS 曲线 0-1；人声/军鼓/吉他落在这一带。",
    "energy.curves.high": "高频（≥2000Hz，降采样档只到 Nyquist）RMS 曲线 0-1；镲与齿音。",
    "energy.curves.onset": "起音曲线 0-1（块 RMS 的半波整流一阶差分，只留「起」）；找「叮」的候选用它，精确时刻仍以 onsets.events 为准。",
    "energy.curves.kick": "底鼓窄带（40-80Hz）曲线 0-1（按全曲最大归一）；做逐帧闪拍的触发信号。",
    # —— energy.perFrame（逐帧池化）
    "energy.perFrame": "逐帧强度表（按 options.fps；瞬态类取 max、响度类取 mean，再套 5ms/150ms 非对称平滑）；卡点闪拍直接读这一块。",
    "energy.perFrame.fps": "池化用的帧率（24/25/30/50/60，默认 30）；不要拿 contract.frameGrid.frameRateHz（43.066）替代它。",
    "energy.perFrame.frameSec": "每个点覆盖的时长（秒）= stride / fps；第 k 个点的时刻 = k × frameSec（帧中心已按检测器系统延迟对齐到 k×frameSec；渲染按帧取强度就用这条）。",
    "energy.perFrame.stride": "抽稀倍数：1 = 一帧一点；>1 表示素材超过下发预算，一个点覆盖多帧（时间仍按 frameSec 算）。",
    "energy.perFrame.points": "点数（= 各条曲线共同长度）≈ ceil(durationSec / frameSec)。",
    "energy.perFrame.attackSec": "平滑的起音时间常数（秒，恒 0.005）：快起，所以峰值不会被磨平。",
    "energy.perFrame.releaseSec": "平滑的释放时间常数（秒，恒 0.15）：慢落，所以强度在峰值之后还有尾巴，别当它是精确包络。",
    "energy.perFrame.rms": "逐帧全带强度 0-1（已平滑）：画面整体亮度跟它走。",
    "energy.perFrame.low": "逐帧低频强度 0-1（响度类取 mean）。",
    "energy.perFrame.mid": "逐帧中频强度 0-1（响度类取 mean）。",
    "energy.perFrame.high": "逐帧高频强度 0-1（响度类取 mean）。",
    "energy.perFrame.onset": "逐帧起音强度 0-1（瞬态类取 max）：闪白 / 缩放的第一选择。",
    "energy.perFrame.kickPulse": "逐帧底鼓脉冲 0-1（40-80Hz 窄带逐帧 max + 平滑）：跟着底鼓做逐帧冲击用它；它是强度曲线，不是 kick 事件本身。",
    # —— energy.barEnergy（小节感知能量）
    "energy.barEnergy": "小节级感知能量（第 i 个值对应 beatGrid.bars[i]）：逐小节 RMS 只差几 dB、按 dB 线性拉伸看不出听感，这里给近似 K 加权 + 稳健归一的值。",
    "energy.barEnergy.method": "算法标记：perceptualBarEnergy（6 带近似 K 加权 → 功率域平均 → p5–p95 归一）/ none（没有帧特征或旧缓存，别当 0 能量）。",
    "energy.barEnergy.percentile": "稳健归一用的分位 [低, 高]，恒 [5, 95]：低于低分位记 0、高于高分位记 1。",
    "energy.barEnergy.floorDb": "感知电平下限（dB，相对全曲最响帧），恒 -70；静音小节记在这里。",
    "energy.barEnergy.points": "值的个数（= 有能量的小节数）；等于 beatGrid.bars 的长度，缺帧特征时为 0。",
    "energy.barEnergy.db": "逐小节感知电平（dB，≤0，相对全曲最响帧）：比较「哪段更满」用它，比 rmsDb 更贴听感。",
    "energy.barEnergy.norm": "逐小节感知能量 0-1（已按 p5–p95 归一）：柱高、切点密度、闪拍强度直接按它排。",
    # —— sections
    "sections": "段落数组（首段 startSec=0、末段 endSec=durationSec、无缝无叠）；切点优先级最高的一层。",
    "sections[].index": "段落序号（0 基，按时间升序）。",
    "sections[].label": "段落标签（9 选 1，启发式）：intro/verse/prechorus/chorus/bridge/breakdown/drop/outro/unknown；只保证边界不保证命名，必读 confidence。",
    "sections[].label.intro": "前奏：低能量、事件稀疏、位于开头；适合长镜头与字幕标题。",
    "sections[].label.verse": "主歌：中等能量、节奏稳定；常规推进用 medium 档镜头。",
    "sections[].label.prechorus": "预副歌：能量上行、密度增加；适合加速剪辑铺垫。",
    "sections[].label.chorus": "副歌：高能量、密度最高；适合 fast 档快剪与最大动效。",
    "sections[].label.bridge": "桥段：副歌之后的中等能量段，音色/密度与前后不同。",
    "sections[].label.breakdown": "降段：高能量之后突然抽空的低能量段；留白与情绪回落。",
    "sections[].label.drop": "爆发点：低能量之后突然的高能量进入；给最大动效。",
    "sections[].label.outro": "尾奏：末尾的低能量段；收尾长镜头。",
    "sections[].label.unknown": "只给出边界、未敢命名（能量证据不足）；按边界的秒数用，别按标签做审美决策。",
    "sections[].startSec": "段落起点（秒）；首段恒 0。",
    "sections[].endSec": "段落终点（秒）；末段恒 durationSec。",
    "sections[].confidence": "标签可信度 0-1；<0.4 时只敢用边界，不敢用名字。",
    "sections[].method": "切分依据：energyPhase（能量相位，默认）/keyMoment（关键转折）/recurrence（自相似，更贵）/manual。",
    "sections[].snappedToDownbeat": "边界是否已吸附到最近 downbeat；false 时边界就是能量转折的原始位置。",
    "sections[].downbeatOffsetMs": "吸附位移（毫秒，正=后移）；snappedToDownbeat=false 时无意义。",
    # —— visuals
    "visuals": "可视化资产数组：已落盘的 PNG，可直接喂识图复核拍点。",
    "visuals[].kind": "图种：spectrogram（频谱）/waveform（波形）/beatOverlay（拍点竖线）/energyCurve（能量曲线）。",
    "visuals[].path": "本机绝对路径（PNG），文件一定存在；识图直接用它，别自己拼路径。",
    "visuals[].widthPx": "真实像素宽；与图片文件头一致。",
    "visuals[].heightPx": "真实像素高；与图片文件头一致。",
    "visuals[].format": "固定 png。",
    "visuals[].bytes": "文件字节数（B）。",
    "visuals[].generatedBy": "生成方式，本实现恒 numpy-zlib-png（无 Pillow/matplotlib）。",
    "visuals[].artifact": "取图名 <key16>/<kind>.png；HTTP 就是 GET /artifact/<这个名字>。",
    "visuals[].artifactUrl": "可直接拼到 baseUrl 后面的路径 /artifact/<key16>/<kind>.png。",
    # —— edit
    "edit": "剪辑建议块：切点、强调点、镜头时长档位；全部由网格与事件推导，不含主观审美。",
    "edit.cutPoints": "候选切点（按 t 升序，已按「段落>downbeat>beat>onset」预排）；直接用，别再自己从网格抽。",
    "edit.cutPoints[].t": "切点时间（秒）。",
    "edit.cutPoints[].snap": "该点吸附的锚点类型：section（换段）/downbeat（换小节）/beat（换拍）/onset（跟鼓点）。",
    "edit.cutPoints[].strength": "作为切点的权重 0-1；越高越该在这里剪。",
    "edit.cutPoints[].barIndex": "所属小节序号；无小节时缺省。",
    "edit.cutPoints[].beatInBar": "小节内拍序号；无小节时缺省。",
    "edit.cutPoints[].reason": "一句话理由（如 chorus entry / bar accent / hard stop），可直接写进剪辑说明。",
    "edit.accents": "强拍强调点（按 strength 降序）：画面该给重击的位置。",
    "edit.accents[].t": "强调点时间（秒）。",
    "edit.accents[].kind": "strongBeat（缩放/闪白）/drop（最大动效）/hardStop（必须留白至少一拍）/riser（加速）/sectionEntry（段落进入）。",
    "edit.accents[].strength": "强调强度 0-1。",
    "edit.shotDurationTiers": "镜头时长档位表：以拍为单位给出秒数区间，按段落密度选档。",
    "edit.shotDurationTiers[].name": "档位名：fast（副歌/高密度）/medium（主歌）/slow（过门留白）/cinematic（intro/outro）。",
    "edit.shotDurationTiers[].beats": "该档等于几拍（0.5=八分、1=一拍、2=两拍、4=四拍）；别自己再除 2。",
    "edit.shotDurationTiers[].minSec": "镜头时长下限（秒），由 beatPeriodSec×beats 算出。",
    "edit.shotDurationTiers[].maxSec": "镜头时长上限（秒），恒 ≥ minSec。",
    "edit.shotDurationTiers[].useCase": "适用段落/素材（中文一句话）。",
    "edit.cues": "手写 cue 点（来自 options.overrides.cues，按 t 升序、name 唯一）；与自动 accents / cutPoints 并存，不互相覆盖。",
    "edit.cues[].t": "cue 时间（秒）；已随 globalVisualOffsetMs 一起推移，并钳在 [0,duration]。",
    "edit.cues[].name": "cue 名（如 big hit）：同一份结果里唯一，下游按名字取点，重名只留先给的那条。",
    "edit.cues[].strength": "cue 强度 0-1（缺省 0.8，越界被钳）：给闪白/冲击的力度。",
    "edit.cues[].source": "来源标记：manual = 本次由 options.overrides 手写；没有这一项说明是别处合并进来的。",
    # —— video（做卡点闪拍 / 逐帧工程要抄的那几个数，节点侧算，服务端不产）
    "video": "做卡点闪拍用的换算块：拍长 / 小节长 / 帧数 / 闪拍帧数 / 整帧漂移。按秒剪和按帧剪都用这一块，别自己用 bpm 乘。",
    "video.fps": "换算用的帧率（节点 ⚙ 里选 24/25/30/50/60，默认 30）。",
    "video.beatSec": "一拍多少秒 = 60/bpm。",
    "video.barSec": "一小节多少秒 = beatSec × beatsPerBar。",
    "video.beatsPerBar": "一小节几拍（拍号的分子）。",
    "video.framesPerBeat": "一拍多少帧 = beatSec × fps（常常不是整数，别四舍五入后累加）。",
    "video.framesPerBar": "一小节多少帧。",
    "video.flashFrames": "建议的闪白 / 闪拍长度（帧）≈ 1/5 拍，钳在 2–6 帧：短闪看得见，长了变频闪。",
    "video.frameDriftMsPerBeat": "一拍按整帧取整会漂多少毫秒；≠0 时用 round(t×fps) 逐点取整，别按「每拍 +N 帧」累加。",
    "video.downbeatCount": "可用的重拍数量（闪拍卡的就是它，时间表见 beatGrid.downbeatsSec）。",
    "video.firstBeatSec": "第一拍的时刻（秒）：时间线起点的对齐参考。",
    # —— diagnostics
    "diagnostics": "自证块：warnings/method/caveat/参数/耗时/缓存；先看这里再决定这份数能不能信。",
    "diagnostics.warnings": "警告数组：非空说明有降级或存疑，按 code 分派（NO_GRID/NO_ONSET=素材问题，LOW_CONFIDENCE_BPM/TEMPO_HALF_DOUBLE=速度问题，DOWNSAMPLED=长素材降级）。",
    "diagnostics.warnings[].code": "警告码（固定 10 个取值）：LOW_CONFIDENCE_BPM/TEMPO_HALF_DOUBLE/NO_ONSET/NO_DOWNBEAT/NO_GRID/SHORT_AUDIO/ONSETS_TRUNCATED/SECTIONS_FALLBACK/KEY_UNRELIABLE/DOWNSAMPLED。",
    "diagnostics.warnings[].message": "中文说明：写清降级到什么程度、影响哪些字段。",
    "diagnostics.warnings[].t": "该警告相关的时刻（秒，可选）；NO_GRID 这类全局警告没有这个字段。",
    "diagnostics.method": "一段人话：用了哪些算法、什么顺序；排查「这个数哪来的」先读它。",
    "diagnostics.caveat": "一段人话：这些数不可全信在哪里；写交付说明时可直接引用。",
    "diagnostics.parameters": "本次运行参数留痕（sr/hop/nFft/downsampled/tightness/detail/onsetsLimit/onsetLagMs/fps/curvePoints/perFramePoints/overridesCount/ignoredOptions…）；复盘「这份结果是怎么算出来的」先看它。",
    "diagnostics.timingsMs": "各阶段耗时（毫秒）：decode/onsets/beats/sections/visuals/total；命中缓存时是产生这份结果那次的耗时。",
    "diagnostics.timingsMs.decode": "解码耗时（毫秒）。",
    "diagnostics.timingsMs.onsets": "onset 检测（STFT + 峰拾取 + 精修）耗时（毫秒）。",
    "diagnostics.timingsMs.beats": "速度与拍网格耗时（毫秒）。",
    "diagnostics.timingsMs.sections": "能量相位与段落耗时（毫秒）。",
    "diagnostics.timingsMs.visuals": "PNG 绘制耗时（毫秒）。",
    "diagnostics.timingsMs.total": "整次分析总耗时（毫秒），不含缓存读盘。",
    "diagnostics.parameters.detectorLatencyMs": "各检测器的系统延迟（毫秒，负 = 该检测器输出比真实事件早）：contract.py 里的标定常数按本次运行的栅格折算后的实际值（onsets/beats 是 1 ms attack 栅格上的平移量，curves/kick 半个块，perFrame 半个帧）；分析链已按这些常数校正，校正后残差 ≤ 半个栅格（curves ≈2.9 ms，perFrame ≈17 ms）。对不上时先看 gridSec（本次的块长 / 帧长）。",
    "diagnostics.cache": "缓存信息（服务层追加）：判断这次是命中还是重算。",
    "diagnostics.cache.hit": "是否直接读了缓存；true 时 timingsMs 是当初算出来的耗时，不是本次读盘耗时。",
    "diagnostics.cache.key": "缓存键（32 hex，含 realpath+size+mtimeMs+optionsHash）；同一素材同参数两次请求应当相同。",
    "diagnostics.cache.createdAt": "这份结果是何时算出来的（ISO-8601 UTC）；用来发现「素材被替换但 mtime 没变」。",
    "diagnostics.cache.reason": "没写缓存的原因：source_changed（分析期间源文件被改）/bypass（options.cache=bypass）/write_failed（落盘失败）；空串=正常写入。",
    "diagnostics.beatsRaw": "原始检测拍点（按分段速度图重生成网格之前的版本）：想知道网格改了哪里就看这里，别拿 bpm 反推。",
    "diagnostics.beatsRaw.count": "原始检测到的拍数（可能多于/少于 beatsSec 的 beatCount）。",
    "diagnostics.beatsRaw.firstSec": "原始检测的首拍时刻（秒）。",
    "diagnostics.beatsRaw.lastSec": "原始检测的末拍时刻（秒）。",
    "diagnostics.beatsRaw.medianShiftMs": "重生成网格相对原始检测的中位偏移（毫秒，取绝对值）：接近 0 说明速度图贴合检测。",
    "diagnostics.beatsRaw.maxShiftMs": "重生成网格相对原始检测的最大偏移（毫秒）：>30 的那些拍值得对图复核。",
    "diagnostics.beatsRaw.beatsSec": "原始检测的全部拍点（秒，升序）；仅 options.detail=true 时下发，省 token 时不要请求。",
    # —— diagnostics.overridesApplied（人工覆盖留痕）
    "diagnostics.overridesApplied": "人工覆盖留痕块（options.overrides 作为最后一步合并的结果）：谁生效、和自动值冲突在哪、哪些没应用、校验修了几点；报告里直接可读。",
    "diagnostics.overridesApplied.applied": "是否真的改过结果：false = 没给覆盖或一条都没生效，此时整份 body 与纯自动结果一致。",
    "diagnostics.overridesApplied.count": "生效条目数（= entries 长度）；0 表示什么也没动。",
    "diagnostics.overridesApplied.summary": "一句话中文总结（生效几条 / 未应用几条 / 冲突几处 / 校验修正几点），可直接写进交付说明。",
    "diagnostics.overridesApplied.entries": "逐条生效记录（中文，如 forcedBpm=128.000（自动 120.190））：排查「这条覆盖到底进没进」先看它。",
    "diagnostics.overridesApplied.globalVisualOffsetMs": "实际应用的全局音画偏移（毫秒，正 = 全部时间字段后移）；0 = 没动。与声学时间的差就是它。",
    "diagnostics.overridesApplied.forcedBpm": "实际应用的强制速度（BPM，45-240）；null = 没强制。只改 global.bpm / beatPeriodSec / 镜头时长档位，拍网格本身不按它重生成。",
    "diagnostics.overridesApplied.downbeatShift": "重拍相位平移的留痕：{shift 平移拍数, phaseFrom 原相位, phaseTo 新相位, barLength 每小节拍数, downbeats 重建后重拍数}；null = 没平移。",
    "diagnostics.overridesApplied.sections": "段落覆盖记录：{op: rename|merge, index, label, auto 自动标签, from 合并成员}；动过的段落 method=manual、confidence=1。",
    "diagnostics.overridesApplied.cues": "手写 cue 的最终清单（{t,name,strength}，按 t 升序、name 唯一）；与 edit.cues 同源。",
    "diagnostics.overridesApplied.conflicts": "人工与自动的冲突对照表：每条给 kind/target/auto/manual/note；结果一律取 manual，auto 只作对照，便于退回自动值。",
    "diagnostics.overridesApplied.ignored": "没应用的覆盖项与中文原因（超范围 / 枚举外 / 找不到目标段 / 没有可用拍网格）；不影响其余条目生效。",
    "diagnostics.overridesApplied.validation": "合并后统一校验的修正量：clamped 越界钳制点数、dropped 去重或丢弃点数、notes 逐条说明；全 0 表示覆盖值与不变量自洽。",
    "diagnostics.fieldGuide": "本字典自身：键是字段路径，值是中文一句话（单位 + 怎么用 / 什么时候别信）；不要再问人「这个字段是什么意思」。",
}


def field_guide() -> dict:
    """返回字段字典的浅拷贝（避免调用方改到常量）。"""
    return dict(FIELD_GUIDE)
