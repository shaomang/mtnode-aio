---
name: flux3-klein-local-install
title: FLUX 3 Image Klein 本地出图后端安装
description: 在用户指定目录安装 FLUX 3 Image Klein（5.6B 蒸馏 · 独立 ComfyUI · 端口 8197）后端：探测 GPU / 磁盘 / Python，下载官方 ComfyUI，建隔离 venv 并装 CUDA torch 与依赖，用 ModelScope（回退 hf-mirror）下载 INT8 / BF16 两档蒸馏权重与 flux2-vae，跑 /object_info 冒烟后写 .install-ok；含按错误码分派的自我修复指引与显存 / 精度口径。
---

# FLUX 3 Image Klein 本地出图后端安装

当用户或 MTNode 插件要求在某目录**安装 / 自我修复**「FLUX 3 Image Klein（本机图像生成）」时使用本 skill。

插件调用时：

- **当前工作区就是 `INSTALL_DIR`**，可直接读写并执行命令。
- **`SCAFFOLD_REF`（或 `.scaffold-ref`）只作参考**：随包脚手架 `flux3klein-pack/` 是示例实现，不代表已经装好。
- 若任务附带 **CONSOLE_LOG**，以「最近失败焦点」为准分析（更早的报错可能已被后续步骤绕开）。
- **先探测再动手**：非 NVIDIA 或显存 < 8GB 可以装（INT8 能跑），但要先跟用户确认；磁盘 < 40GB 直接说明装不下全套。

## 目录约定

```
INSTALL_DIR/
  ComfyUI/                                 官方 ComfyUI（zip 解包，不用 git）
    main.py
    venv/Scripts/python.exe                隔离解释器（禁止 --system-site-packages）
    models/
      diffusion_models/
        flux3-image-klein-int8-convrot.safetensors     约 5.83GB（默认档）
        flux3-image-klein-bf16.safetensors             约 11.1GB（24G 卡档）
      text_encoders/
        qwen3vl_4b_int8_convrot.safetensors            约 4.86GB
        qwen3vl_4b_bf16.safetensors                     约 8.88GB
      vae/flux2-vae.safetensors                         约 336MB
  .install-ok                              冒烟通过后写
```

- 端口 **8197**（与 H3 8188 / SoulX 8198 / InfiniteTalk 8199 隔离）。
- 安装脚本：`flux3klein-pack/scripts/install.ps1`，参数
  `-InstallDir -DiskHintGb -Force -SkipWeights -SkipSmoke -SkipBf16 -WeightsDir`。
- 步骤与错误码文案：`flux3klein-pack/steps.json`（脚本 stdout 走 `step.ps1` 的 `mtnodeStep` 协议）。

## 安装步骤（脚本已经按这个顺序跑）

1. `disk` — 检查剩余空间（建议 ≥40GB；只装 INT8 约 21GB）。
2. `comfy` — 下载官方 ComfyUI zip（`ghfast.top` → `gh-proxy.com` → GitHub）并解包到 `ComfyUI/`。
3. `venv` — 用 `py -3.11 / -3.12 / py -3` 建隔离 venv，先装 `requirements.txt`，再装 CUDA torch
   （`download.pytorch.org/whl/cu128` → 阿里云 cu128 → `download.pytorch.org/whl/cu126`，用 `Test-Cuda` 验）。
   顺序不能反：`requirements.txt` 里的 `torch` 是 PyPI 的 **CPU 轮子**，先装 torch 会被它顶掉；
   装 torch 时还必须把 `PIP_EXTRA_INDEX_URL` 清空，否则同版本 CPU 轮子会被优先解析（实测下载了两个 124MB 的 CPU 包才回退到 cu126）。
4. `weights` — 按精度下载扩散 / 文本编码器 / VAE（`-SkipBf16` 只装 INT8）。
5. `files` — 核对关键文件确实在（缺一个就报 `flux3klein.files.missing`）。
6. `smoke` — 在 8197 起 ComfyUI，等 `/object_info/ReferenceMultiLatent` 出现，通过后写 `.install-ok`。

## 权重源顺序

1. `ModelScope`：`/models/<repo>/resolve/master/<rel>` 与 `/api/v1/models/<repo>/repo?...`。
2. `hf-mirror`：`https://hf-mirror.com/ml-resources/flux-3-image-klein-comfy/resolve/main/<rel>`（未门禁，实测 206）。
3. 官方 HF：`black-forest-labs/flux-3-image-klein-comfy`（**需授权 token**，只作最后兜底）。

> 官方仓库在 ModelScope / HF 上都是**授权门禁**形态：直接 resolve 会 404 / 403（2026-10 真机实测：ModelScope 上
> 连仓库都没有，两个 resolve 形式都 404；hf-mirror 的官方仓 403；**唯一能下的是第 2 条的 `ml-resources` 镜像**）。
> 别把它当唯一来源，也别据此断言「权重不存在」。用户已有本地权重时优先用 `-WeightsDir` 指过去，一个字节都不重下。

## 重跑与幂等边界（脚本每轮都从第一步跑到底）

脚本没有「只跑某一步」的开关，省时间靠各步自己的跳过条件：

| 步骤 | 重跑时会不会重做 | 能否跳过 |
| --- | --- | --- |
| `disk` | 每次必跑，只算剩余空间（毫秒级） | 不能；门槛用 `-DiskHintGb` 调 |
| `comfy` | `<安装目录>\ComfyUI\main.py` 在就复用；半截目录（没有 `main.py`）会重下并整目录替换 | 不能直接跳；手工解包到 `ComfyUI\` 也算就位 |
| `venv` | venv 里 python 是 3.11 / 3.12 就复用，否则删了重建；**但 requirements 与 CUDA torch 每轮都会再装一遍**（torch `--force-reinstall --no-deps`，约 2.6GB，真机约 117s） | 没有 `-SkipVenv`：这是重跑的固定成本，别说「重跑很快」 |
| `weights` | 逐文件比十进制体积：≥99.5% 跳过；1%–99.5% 断点续传（`curl -C -`）；<1% 或 >105% 删掉重下 | `-SkipWeights` 只跳下载；`files` 仍按同一清单校验，权重没齐照样失败 |
| `files` | 每次必跑，纯校验（存在 + 体积），很便宜；`-SkipBf16` 时 BF16 两件不在清单 | 不能跳 |
| `smoke` | 每次必跑：8197–8217 找空闲端口起一次 ComfyUI，等 `/object_info/ReferenceMultiLatent`（最多 600s）后 kill | `-SkipSmoke` 可跳，但**跳过也会写 `.install-ok`**（等于没验过就标成已装），只在确定环境没问题时用 |

- `.install-ok` 写两次：脚本 `ok` + ISO 时间（ASCII），宿主随后覆盖成 `{"ok":true,"at":<ms>}`。
  宿主判「已装」看的是 `projectSignals().ready`（`ComfyUI/main.py` + venv + INT8 扩散 + INT8 文本编码器 + VAE），
  **不是**只看标记 —— 删标记不会让权重重下；反过来脚本 exit 0 也不算装好，宿主复查不齐会报「安装脚本结束但项目不完整」。
- 想彻底重来：删掉 `venv/` 或 `ComfyUI/models/` 下对应文件再跑；**只删 `.install-ok` 不会重下任何东西**（它只是状态标记，
  宿主按目录里的实际文件判「已装」，脚本也不读它）。

## 权重目录复用（推荐用法）

`install.ps1 -WeightsDir <dir>`：按相对路径在三个位置找，再退化成「只按文件名」找（平铺目录也认）：
`<dir>` → `<dir>\models` → `<dir>\ComfyUI\models`。

- 只复制体积达标的文件；本地那份不完整就跳过并回落到下载。
- 是复制不是移动，目标盘要有额外余量（全套约 31GB）。
- **推荐**：直接指向另一份已装好的安装目录（`-WeightsDir E:\flux3-klein-local`）或它的 `ComfyUI\models`；
  重装、换盘、重拉 ComfyUI 源码时一个字节都不重下。
- 只装 INT8 加 `-SkipBf16`（`weights` / `files` 都按 INT8 三件收口）。
- 通用安装窗不透传 `-WeightsDir`（宿主 `installProject` 收 `opts.weightsDir`，窗里没有这个输入位）：
  要用就走命令行 / 本技能直接跑脚本，或把文件按目录放好再点安装（`weights` 步会跳过已完整的）。

## 端口与共存

- 只占 **8197**；ComfyUI 与 H3 / InfiniteTalk / SoulX 的安装目录**完全隔离**（各自的 venv 与 models）。
- 显存：INT8 约 8GB 起（1:1 / 1024²）；BF16 与 2048 长边建议 24GB。
- 与其它本地图像 / 视频节点共用**全局媒体大锁**，同时只会有一个生成任务。

## 【自我修复】

先读错误码，再按下面这张表动手；修好后**重跑一次安装**（脚本从头跑，但各步会跳过已就位的部分，见上面「重跑与幂等边界」）。

| 错误码 | 判据 | 处置 |
| --- | --- | --- |
| `flux3klein.disk.low_space` | 剩余空间 < `diskHintGb` | 清磁盘或换目录；`-SkipBf16` 可省约 19GB |
| `comfy.download_failed` | 三个源都拿不到 zip | 依次换代理重试；仍失败让用户手动放 `ComfyUI.zip` 到安装目录 |
| `comfy.extract_failed` | 解包报错 / 目录结构不对 | 删掉半截 `ComfyUI/` 重跑；确认 `ComfyUI/main.py` 存在 |
| `venv.no_python` | 找不到 3.11 / 3.12 / 3 | 让用户装 Python 3.11（或 `uv` 装一份），再重跑 |
| `venv.create_failed` | venv 建不出来 | 删 `venv/` 重跑；检查路径是否有中文 / 权限 |
| `venv.torch_failed` | torch 装不上 / 不是 CUDA 版 | 换索引重试；确认 `venv\Scripts\python.exe -c "import torch;print(torch.cuda.is_available())"` 为 True |
| `venv.pip_failed` | requirements 装不上 | 看日志里第一个失败包；多数是 torch 版本与镜像不匹配，固定 torch 后重跑 |
| `weights.download_failed` | 权重 404 / 超时 / 大小不对 | 换源；或 `-WeightsDir <本地目录>` 复用已有权重；核对文件名与体积 |
| `files.missing` | 关键文件缺失 | 按报错列出的文件补下（多半是 VAE 或文本编码器没落对目录） |
| `smoke.backend_failed` | 8197 起不来 / `/object_info` 超时 | 端口冲突先换端口；`venv\Scripts\python.exe main.py --listen 127.0.0.1 --port 8197` 手跑看报错 |

**常见现场**

- **从插件卡片点「安装」立刻失败、日志空白**：`error=backend_plugin_route:flux3klein`，步骤表多出 `prepare` / `download`、真步骤全 pending。
  这不是后端坏了，是**通用安装窗的路由缺行**：`install/app.js` 的 `BACKEND_INSTALL_API` 没有 `flux3-klein-local` / `flux3klein`，
  `installApiOf()` 回落到窗口插件那条 `appPluginsInstall`，本地后端插件直接抛错。修法是在那张表里加两条
  （与 `infinitetalk` / `soulxflashhead` 同写法，长 id 与 kind 短名都要给）：

  ```js
  "flux3-klein-local": "flux3kleinInstall",
  flux3klein: "flux3kleinInstall",
  ```

  选目录桥由 `flux3kleinInstall → flux3kleinPickInstallDir` 自动推出（preload 里已有）。**还要补第二张表** ——
  安装窗调桥先过白名单 `plugins/main-install.js` 的 `INSTALL_API_CHANNELS`（少了它会被挡成 `api_not_allowed`）：

  ```js
  flux3kleinInstall: "flux3klein:install",
  flux3kleinPickInstallDir: "flux3klein:pickInstallDir",
  // 同一文件的 BACKEND_ID_ALIASES（短名 → 目录 id，卸载与「需要目录吗」判定靠它）
  flux3klein: "flux3-klein-local",
  ```

  三处已于 2026-10 落地。验收：点「安装」后步骤表必须是
  `steps.json` 那 6 条；`test/smoke-flux3klein.js` 不检查这两张表，冒烟全绿不代表这条路通。
  宿主 `flux3klein:install` 本身是好的 —— 同样的安装也能用 `window.api.flux3kleinInstall` 跑通。
- **界面显示「未设置插件根目录」**：多半是手工拷进来的 `config.json` 带 UTF-8 BOM，`JSON.parse` 判废。存成无 BOM 再打开。
- **生成时报 `ReferenceMultiLatent` 找不到**：ComfyUI 里缺 Klein 相关节点（旧版 ComfyUI）。更新 `ComfyUI/` 到官方最新。
- **出图全黑 / 全白**：`model` 与 `precision` 不匹配（INT8 档加载了 bf16 文件名）。改回默认精度或补齐对应权重。
- **显存不足（OOM）**：把精度切 INT8、比例桶退回 `1:1`、步数不加；仍 OOM 说明卡小于 8GB。
- **透明背景边缘毛糙**：调低「抠图噪点地板」、加大「边缘羽化」；复杂背景本身就不是差分抠图的强项。

## 卸载

插件卡片卸载走通用口径：先 `flux3klein:stop` 停后端，再删安装目录；**已生成的图不删**（在画布资产目录里）。
