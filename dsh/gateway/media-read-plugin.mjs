// 只读媒体通道（mtnode_media）—— **只做契约真源，不进网关**。
//
// 为什么不在 cordis.yml 里：这一条是给**外部 MCP 客户端**补的缺口 —— 实测（真机走 stdio 桥）
// 证明画布上的媒体节点对外只露「名字」，外部 Agent 连文件在哪都不知道；知道了也读不到内容
// （渲染层没有可读内容，音频 / 视频还得靠本机 ffmpeg 与语音运行时）。应用内的 Agent 本来就有
// audio_transcribe / audio_subtitle / ffmpeg / mtnode_vision，不需要再来一条重复的工具。
//
// 执行方是 MTNode **主进程**（main.js 的 mcpMediaRead）：ffprobe / ffmpeg / 语音运行时只在那里，
// 三个动作全复用既有内核（main-qa-media.js 的探针与抽帧、media-subtitle.js 的 SenseVoice 转写），
// 不另写一套解码 / 识别，也不写任何文件（frames 抽出的 PNG 落在系统临时目录）。
// 图像不在这里读像素：客户端拿路径调 mtnode_vision（同一台机器、同一条识图路由）。
//
// 那为什么放在 dsh/gateway/ 里：scripts/build-mcp-contract.mjs 的工具契约真源就是这一层的
// defineTool 参数表。放这里，参数表只有一份，mcp-tools.json / mcp-tool-schemas.js 照旧生成，
// 不手抄第二份 schema。本文件只被那个脚本 import（真跑 register 抓规格），运行时无人加载。

const MEDIA_DESC =
  'Read the actual content of a local media file (image / audio / video) — the piece canvas_get cannot give you (it only returns paths and metadata).\n' +
  '- action:"probe"（默认）：元信息 —— 存在性 / 字节数 / 像素尺寸（图像）/ 时长 / 帧率 / 有无音视频轨。只读，不写文件。\n' +
  '- action:"audio"：本机官方 SenseVoice 逐句转写（与音频转字幕节点同一份权重、同一条静音切句），回 cues（起止秒 + 正文）、srt、vtt 与拍平后的 text。\n' +
  '- action:"frames"：按时间点抽 PNG（默认 7 帧、均匀分布），回本机绝对路径 —— 要看画面就把每个路径交给 mtnode_vision（question 写你在找什么）。\n' +
  '- 只看图像直接用 mtnode_vision；路径从哪来：canvas_get 回执的 media.files（每个媒体槽都带绝对路径）。\n' +
  '- 读不到就说读不到（文件不存在 / 没有音轨 / 抽帧失败都会明确报错），不静默返回空结果。'

export const name = 'mtnode-media-read'
export const inject = ['tools']

export function apply(ctx) {
  ctx.tools.register(
    defineTool({
      name: 'mtnode_media',
      description: MEDIA_DESC,
      parameters: {
        action: {
          type: 'string',
          required: true,
          enum: ['probe', 'audio', 'frames'],
          description: 'probe = 元信息；audio = 音频转写（SenseVoice，本地）；frames = 视频 / 音频抽帧成 PNG。',
        },
        path: {
          type: 'string',
          required: true,
          description: '媒体文件的本机绝对路径（画布上的路径见 canvas_get 的 media.files[].path）。',
        },
        language: {
          type: 'string',
          enum: ['auto', 'zh', 'en', 'yue', 'ja', 'ko'],
          description: 'audio：语言提示，默认 auto。',
        },
        maxChars: {
          type: 'number',
          description: 'audio：单条字幕最大字数（省略 = 中文 18 / 英文 42）。',
        },
        maxDurationSec: {
          type: 'number',
          description: 'audio：单条字幕最长秒数，默认 6（1–60）。',
        },
        allowLarge: {
          type: 'boolean',
          description: 'audio：放宽时长 / 体积上限（默认 2 小时 / 1GB）。长文件会慢很多。',
        },
        count: {
          type: 'number',
          description: 'frames：抽几帧（默认 7，上限 12）；给了 times 就忽略它。',
        },
        times: {
          type: 'array',
          items: { type: 'number' },
          description: 'frames：按这些秒数抽帧（最多 12 个）。',
        },
      },
      timeoutMs: 900000,
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      async execute() {
        throw new Error('mtnode_media 由 MTNode 主进程执行（main.js 的 mcpMediaRead），不在网关里跑')
      },
    }),
  )
}
