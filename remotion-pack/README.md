# remotion-pack

MTNode 的 Remotion 随包模板：宿主（MTNode 视频生成节点）写入 `render.json` 后，执行
`node render.mjs` 即可用 [Remotion](https://www.remotion.dev/) 渲染视频（默认 `codec=h264`）。

## 目录结构

```
remotion-pack/
├── manifest.json      # 包清单：id=remotion / version / minAppVersion
├── package.json       # 依赖（4.0.518 锁定）+ 脚本
├── tsconfig.json      # 宽松 TS 配置（模板可编译）
├── src/
│   ├── index.tsx       # 入口：注册唯一合成 MTNodeRemotion（占位参数）
│   └── Composition.tsx# 占位画面模板（宿主可整体替换）
├── render.mjs         # 读 render.json -> renderMedia，进度 JSON Lines 输出
├── install.cmd        # npm install（支持 --mirror 国内镜像）
├── README.md
└── .gitignore         # 不提交 node_modules / 锁文件 / 产物
```

## 安装

```bat
install.cmd            :: 普通安装
install.cmd --mirror   :: 使用 npmmirror 国内镜像
```

不提交 `node_modules` 与 `package-lock.json`（随包约定）。

## 渲染

1. 在包根目录准备 `render.json`（宿主自动生成；字段见下）。
2. 执行 `node render.mjs [render.json 路径]`（默认 `./render.json`）。

stdout 输出 JSON Lines：

```json
{"type":"bundled","serveUrl":"..."}
{"type":"progress","progress":0.42}
{"type":"done","outputLocation":"out/output.mp4","codec":"h264","width":1280,"height":720,"fps":30,"durationInFrames":300}
```

失败时输出 `{"type":"error","message":"..."}` 并以退出码 1 结束。

## render.json 字段

| 字段 | 类型 | 默认 | 说明 |
|------|------|------|------|
| `entryPoint` | string | `src/index.tsx` | 合成入口（缺省 serveUrl 时用于就地打包） |
| `serveUrl` | string | — | 宿主预打包后的 bundle 地址/路径；缺省则用 `@remotion/bundler` 就地打包 |
| `composition` | string | `MTNodeRemotion` | 要渲染的合成 id |
| `outputLocation` | string | `out/output.mp4` | 输出视频路径（相对本包根目录） |
| `codec` | string | `h264` | 视频编码（`h264` 等，见 Remotion 文档） |
| `fps` / `width` / `height` / `durationInFrames` | number | 模板占位值 | 覆盖合成参数 |
| `inputProps` | object | `{}` | 传给合成的 props |
| `concurrency` / `jpegQuality` / `audioCodec` / `logLevel` | — | — | 透传给 `renderMedia` |

## 宿主替换契约

- **合成 id**：固定为 `MTNodeRemotion`（`src/index.tsx`）。
- **占位参数**：`src/index.tsx` 中 `durationInFrames / fps / width / height` 四个常量行尾
  带锚点注释 `__MTNODE_DURATION_IN_FRAMES__` / `__MTNODE_FPS__` / `__MTNODE_WIDTH__` /
  `__MTNODE_HEIGHT__`，宿主按 `render.json` 对应值就地替换等号后的数字即可，无需重打包整个文件。
- **画面模板**：`src/Composition.tsx` 为占位，宿主可整体替换实现真实画面。
