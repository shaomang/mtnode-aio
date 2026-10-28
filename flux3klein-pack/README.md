# FLUX 3 Image Klein（本地出图 · 随包脚手架）

这个目录是插件安装窗用的**随包脚手架**（`build.json` 的 extraResources 会把它放进
`resources/flux3klein-pack`）。宿主把它整份复制到用户选的安装目录再跑
`scripts/install.ps1`，所以**它自己不带任何大文件**。

```
flux3klein-pack/
├── manifest.json        版本 / 端口 / 磁盘与显存门槛 / 权重文件名（唯一真源）
├── steps.json           安装步骤标题、提示与错误码文案（zh/en）
├── start_backend.cmd    手动调试用启动器（宿主用同一串参数自己起）
└── scripts/
    ├── install.ps1      纯 ASCII 安装脚本：ComfyUI + venv/CUDA torch + 权重 + 冒烟
    └── step.ps1         安装步骤协议（与其它 *-pack 逐字相同）
```

安装结果（全部在用户选的安装目录里，不写应用目录）：

```
<InstallDir>/ComfyUI/                     官方 ComfyUI 源码
<InstallDir>/ComfyUI/venv/                隔离 Python（CUDA torch cu128）
<InstallDir>/ComfyUI/models/
    diffusion_models/flux3-image-klein-int8-convrot.safetensors
    diffusion_models/flux3-image-klein-bf16.safetensors
    text_encoders/qwen3vl_4b_int8_convrot.safetensors
    text_encoders/qwen3vl_4b_bf16.safetensors
    vae/flux2-vae.safetensors
```

权重来源顺序：ModelScope → hf-mirror（官方仓库，受限需令牌）→ 非受限镜像
`ml-resources/flux-3-image-klein-comfy`。已经下好的文件可以放一份到别处，安装窗里选
「已下载的权重目录」（脚本参数 `-WeightsDir`）即可直接复制、不重下。
