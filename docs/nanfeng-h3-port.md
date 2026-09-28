# 南风 H3 V10 提示词节点包 · 移植说明与限制

把第三方 ComfyUI 节点包 **`nanfeng_prompt_nodes_v10`**（南风 H3-V10 公开版）移植进 MTNode 的
MiniMax H3（24G ComfyUI）后端，作为**第三条自建工作流**与内置 FL2VA / R2V 并列。
本文记录：移植了什么、落在哪、怎么装、验证证据、以及**在 MTNode 里用不到的部分**。

- 上游源：`E:\mtnode-plugins\comfyui_v10\南风H3-V10-公开版\nanfeng_prompt_nodes_v10`
- 上游性质：一个节点 = 整条 Ref2VA 管线（`NanFengH3MultiReferenceGeneratorV10`，
  `RETURN_TYPES=("IMAGE","AUDIO")`，内部自带 9 图 / 3 视频 / 3 音频、采样与音频锁），
  不是可插拔的小工具节点。

## 一、移植产物（按目录）

| 位置 | 内容 |
| --- | --- |
| `h3-pack/custom_nodes/nanfeng_prompt_nodes_v10/` | 上游包体（29 个文件）。剔除 `__pycache__/`（7 个 .pyc）与根目录 `test_*.py`（14 个）；保留 `web/`、`*.api.py`（storyboard / audio_drive / audio_media / model_refresh）、3 个 skill 目录、`.env.example`（仅模板，无真实密钥）。保留 `web/` 与 `*.api.py` 是**必须**的：`__init__.py` 的 `WEB_DIRECTORY="./web"` 与路由注册都在 import 期生效，缺失会导致插件注册失败。 |
| `h3-pack/workflows/nanfeng-h3-v10-multiref.json` | 第三条自建工作流的真源（API 格式，3 节点）：`NanFengH3MultiReferenceGeneratorV10 → CreateVideo → SaveVideo`。172 个必填参数由目标实例 venv 只读导出（`cls.INPUT_TYPES()`），非手写。**不加外部模型 / VAE 加载节点**：V10 的 `generate()` 用 `GraphBuilder` 在内部展开 `UNETLoader / CLIPLoader / VAELoader`，模型与 VAE 是它自己的 widget，外面再挂 loader 是永不进执行链的死节点。 |
| `h3-pack/scripts/setup_env.ps1` | 新增 `Deploy-LocalCustomNode`（robocopy `/E /XD __pycache__`，无 robocopy 时回退 `Copy-Item`；幂等逐文件覆盖，**不清空 custom_nodes**），在三个 git 克隆之后把 `INSTALL_DIR\custom_nodes\<Name>` 部署到 `ComfyUI\custom_nodes\<Name>`。 |
| `h3-pack/requirements.txt` | 新增 `soundfile>=0.12.1`（`audio_media_api.py` 实际依赖）。`numpy` / `aiohttp` 由 ComfyUI 自身 requirements 提供，不重复装。 |
| `build.json` | h3-pack 的 extraResources 白名单新增 `custom_nodes/**` 与 `workflows/**`。**必须加**：该 `filter` 是显式白名单，不加则打包后脚手架里没有这两样，部署步骤空跑。 |

## 二、MTNode 侧接线

### 1. 扫描规则认得中文控件 · `h3/h3-workflows.js`

`SCAN_RULES` 增补五条：`nanfeng_prompt / nanfeng_image / nanfeng_video / nanfeng_audio / nanfeng_length`，
限定 `NANFENG_CLASS_RE`（`/NanFeng/i`）+ 中文键 `提示词`、`图片1..9`、`视频1..3`、`音频1..3`、`时长秒`，
type / role 复用现有 `text/prompt`、`image/image`、`video/video`、`audio/audio`、`number/length` 语义。
键名真源为 `NANFENG_FIELD_RE` / `NANFENG_MATERIAL_PREFIX` / `nanfengMaterialField(kind, index)`（index 从 0 → `图片1`）。
没有这几条时，画布 `video_gen` 的「提升为节点参数」下拉会是空的（渲染层只列 `meta.candidates` = `scanGraph` 产物）。
**英文规则一条未动**，内置两条模板扫描结果保持原样。

### 2. 素材落点改写 · `h3/main-h3.js`

新增 `H3_REF_ALIAS_RE`（`/^ref_(image|video|audio)_(\d+)$/`）+ `remapNanFengRefFields(graph, params)`：
把参数表里遗留的内置英文素材落点 `ref_image_N / ref_video_N / ref_audio_N`（N 从 0 起）
按序号改写成南风中文键 `图片N / 视频N / 音频N`（N 从 1 起）。
只作用于自建工作流分支 `runCustomWorkflow`，且在 `normalizeParams` **之前**执行（否则图中不存在的字段会被判错）；
条件为「英文键不在该节点 inputs、且对应中文键存在」，内置两条模板的英文键与行为完全不变。

### 3. 第三条工作流的注册 · `h3/main-h3.js`

- `BUNDLED_WORKFLOWS` + `ensureBundledWorkflows()`：首次访问 `h3:wfList` 时把随包图入库，
  标题「南风H3 V10 多参（模板）」，`source.name = bundled:nanfeng-h3-v10-multiref`，`template:true`。
- 幂等且**不回滚**：已入列标记落数据目录 `h3/bundled-workflows.json`，用户改名 / 删除都不会被塞回来。
- `templateToWorkflow("nanfeng")` 走同一份随包图；`fl2va` / `r2v` 原路径未动。
- 入列后**非阻塞**后台跑一次 `/object_info` 校验（后端没起也不会拖慢列表）。
- `h3/ui/ui.js` + `h3/ui/index.html`：「内置图另存」在 fl2va、r2v 之后追加 nanfeng。

## 三、安装链（skill / 脚本）

`skills/minimax-h3-install/SKILL.md` 已同步：目录约定新增 `INSTALL_DIR/custom_nodes/`；
目标 custom_nodes 清单新增 `nanfeng_prompt_nodes_v10`（部署方式、必须保留 `web/` + `*.api.py`、MTNode 只走 `POST /prompt`）；
步骤 4 补部署动作与 `soundfile`；「冒烟与健康检查」新增第 4 条南风节点包自检（关键文件存在性 + `import soundfile, numpy, aiohttp`），并给出补装命令。

上面这句「已同步」现在才真正成立：这份仓库根 `skills/minimax-h3-install/SKILL.md` 是 Agent 拿到的**唯一真源**
——`dsh/main-dsh.js` 的 `INSTALL_SKILL_SOURCES` 与 `h3/main-h3.js` 的 `syncH3InstallSkill()` 都指它，
原先并存的宿主目录副本 `h3/skills/`（旧版，缺南风包 / soundfile / latent 占位这些要件）已删除，
`h3-pack` 里也不再留第二份。改一处即全链生效，真源唯一性与本节的要件由 `test/smoke-plugin-repair.js` [2][8] 钉住
（链路口径见 `docs/plugin-auto-repair.md`）。

## 四、验证证据（本机 RTX 4090 · ComfyUI 0.34.0 · torch 2.9.1+cu130）

| 步骤 | 结果 |
| --- | --- |
| 实例 venv 干跑 import | `CLASS_COUNT = 27`，`INPUT_TYPES_OK = 27/27`，无异常 |
| 启动后端 `/system_stats` | ComfyUI 0.34.0 / PyTorch 2.9.1+cu130 / cuda:0 RTX 4090 |
| `/object_info/NanFengH3MultiReferenceGeneratorV10` | 类在位，177 项 required 参数与工作流 JSON 逐项对齐 |
| 提交第三条工作流 `/prompt` | `{"prompt_id":"6f1e35cc-…","node_errors":{}}` → 无 `prompt_outputs_failed_validation` |
| `/history` | `status_str=success`、`completed=True`，耗时 793s（6 步 · 864×480 · 5s） |
| 输出 | `E:\mtnode-plugins\video\ComfyUI\output\video\NanFengH3_V10_00001_.mp4`，525,538 字节；ffprobe：h264 864×480 · 24fps · 124 帧 · 5.17s + aac 音轨 |
| 画面非空 | 抽第 60 帧 → 864×480，像素 mean 57.9 / std 49.4（非黑帧 / 纯色） |
| `python -m app` 健康检查 | 退出码 0（`comfy_main` / `venv` / `fl2va` / `ref2va` / `clip` / VAE / 后处理权重全部就绪，`cuda=true`） |

实例启动参数按本机真实配置（`%APPDATA%\pipeline-console\pipeline-console\h3\config.json`：
`cpuVae:false`、`optDisablePinnedMemory:true`、`optFp16Intermediates:true`）。

## 五、限制与前提（重要）

1. **MTNode 不加载南风的前端 UI，也不调用它的服务端路由。**
   包内 `WEB_DIRECTORY` 的素材卡、音频驱动、智能分镜前端，以及 `/nanfeng/v10/h3/*` 路由与 `.env` 凭据，
   都面向 ComfyUI 原生界面操作；MTNode 只发 `POST /prompt`。因此：
   - **不可用**：音频驱动、智能分镜（storyboard）、锁音频、二采（公开版已强制关闭）等依赖其 UI / 路由的特性。
   - 要用起来必须由 **MTNode 侧额外桥接**（例如宿主直接调用其路由、或在画布侧实现等价提示词处理）。
2. **`H3潜空间放大模型` 是 required combo，空列表直接拒单。**
   只要 `ComfyUI/models/latent_upscale_models/` 里没有任何文件，`validate_inputs` 会报
   `value_not_in_list: '…' not in []` → `prompt_outputs_failed_validation`，这条工作流**永远提交不进去**，
   与是否开启二采无关（只是该字段需要选项存在）。安装链需保证该目录至少有一个文件（可放占位 safetensors）。
3. **`--cpu-vae` 下这条工作流跑不了。**
   用该旗标时解码阶段报 `RuntimeError: expected m1 and m2 to have the same dtype, but got: float != struct c10::Half`
   （`NanFengH3TimedVideoVAEDecode` → `vae.decode`）。本机实际配置 `cpuVae:false`，GPU VAE 下正常出片。
   即：**南风 H3 需关闭 CPU VAE**。
4. **它是整图，不是可插拔节点。**
   插进现有 19 节点内置模板等于两套采样器抢同一份显存；正确形态就是本移植采用的
   「新建第三条自建工作流（3 节点 API 图）」，与 R2V 那条链并列。
5. `NanFengH3LowPeakLatentUpscaler` 依赖的 `H3LatentUpscalerNodeMegapixels` 全盘无（包内有 try/except 兜底 schema，
   公开版二采强制关闭，该路径本就不用）。VideoHelperSuite 未装也不影响——包本体并不 import 它。

## 六、回归

- `node test/smoke-h3-ui.js` → **146/146 全过**。
- `node test/smoke-h3-custom-workflow.js` → **233/235**；两条失败均为**既有**的手册内容缺口
  （`guides/manual/media-gen.md` 与英文版缺「自建 ComfyUI 工作流」段落），与本次移植的源码改动无关
  （该断言只读 4 个 guides 文件，改编未触及）。本次已把该段补进两版手册，两条断言随之转绿。
- FL2VA / R2V 的内置图反向导出、参数注入、种子下发、输出节点挑选全部保持原样（冒烟 [1]–[11] 全 ok）。
