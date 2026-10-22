# remotion-pack

MTNode 的 Remotion 随包模板：宿主（MTNode 视频生成节点）写入 `render.json` 后，执行
`node render.mjs <render.json 绝对路径>` 即可用 [Remotion](https://www.remotion.dev/) 渲染视频
（默认 `codec=h264`）。

**路径分工**：本包只当**依赖源 + 渲染脚本**（`node_modules` / `render.mjs` / 内置模板）。
用户工程（`index.tsx` / `Composition.tsx` / `render.json`）与成片住在**画布工作目录**的
`.mtnode\remotion\<节点 id>\` 下，由 MTNode 主进程按绝对路径注入（`entryPoint` / `projectDir` /
`nodeModulesDir` / `outputLocation`）。所以：不要往安装目录写用户代码，也不要要求用户改本包再重启。

## 目录结构

```
remotion-pack/
├── manifest.json      # 包清单：id=remotion / version / minAppVersion
├── package.json       # 依赖（4.0.518 锁定）+ 脚本
├── tsconfig.json      # 宽松 TS 配置（模板可编译）
├── src/
│   ├── index.tsx       # 随包占位入口（仅参考；真渲染用工作目录里的工程）
│   └── Composition.tsx# 占位画面模板
├── portrait-dialogue.tsx # 内置「角色动态 + 台词卡」合成（宿主按描述选用）
├── render.mjs         # 读 render.json -> renderMedia，进度 JSON Lines 输出
├── install.cmd        # npm install（默认 registry.npmmirror.com，--official 切官方源）
├── README.md
└── .gitignore         # 不提交 node_modules / 锁文件 / 产物
```

## 安装

```bat
install.cmd              :: 默认走 registry.npmmirror.com
install.cmd --official   :: 需要 npm 官方源时用（registry.npmjs.org）
install.cmd --registry=<url>  :: 自定义 npm 源
```

不提交 `node_modules` 与 `package-lock.json`（随包约定）。

## 渲染

1. 宿主把 `render.json` 写在**工程目录**（画布工作目录里），字段里的路径全是绝对路径。
2. 执行 `node <安装目录>\render.mjs <render.json 绝对路径>`（相对路径按安装目录解析，兼容老用法）。

stdout 输出 JSON Lines：

```json
{"type":"paths","installDir":"...","projectDir":"...","nodeModulesDir":"...","configPath":"..."}
{"type":"bundled","serveUrl":"..."}
{"type":"progress","progress":0.42}
{"type":"done","outputLocation":"<工程目录>\\render-20261019153000.mp4","codec":"h264","width":1280,"height":720,"fps":30,"durationInFrames":300}
```

失败时输出 `{"type":"error","message":"..."}` 并以退出码 1 结束。

## render.json 字段

| 字段 | 类型 | 默认 | 说明 |
|------|------|------|------|
| `entryPoint` | string | `index.tsx` | 合成入口（**绝对路径**优先；相对路径按安装目录解析） |
| `projectDir` | string | render.json 所在目录 | 工程目录（宿主注入，日志与相对路径基准） |
| `nodeModulesDir` | string | `<安装目录>\node_modules` | 依赖源：注入 webpack 的 `resolve.modules`，工程目录里不需要 node_modules |
| `serveUrl` | string | — | 宿主预打包后的 bundle 地址/路径；缺省则用 `@remotion/bundler` 就地打包 |
| `composition` | string | `MTNodeRemotion` | 要渲染的合成 id |
| `outputLocation` | string | `<工程目录>\out\output.mp4` | 输出视频路径（**绝对路径**优先） |
| `codec` | string | `h264` | 视频编码（`h264` 等，见 Remotion 文档） |
| `fps` / `width` / `height` / `durationInFrames` | number | 模板占位值 | 覆盖合成参数 |
| `inputProps` | object | `{}` | 传给合成的 props |
| `concurrency` / `jpegQuality` / `audioCodec` / `logLevel` | — | — | 透传给 `renderMedia` |

## 宿主替换契约

- **合成 id**：固定为 `Main`（宿主生成的入口 `index.tsx` 里注册）。
- **占位参数**：入口模板里的 `durationInFrames / fps / width / height` 由 `render.json` 同名字段
  在 `selectComposition` 之后就地覆盖。
- **画面模板**：`src/Composition.tsx` 与 `portrait-dialogue.tsx` 只是随包参考；真渲染用工程目录里
  宿主写出的 `Composition.tsx`（自定义 TSX 或内置台词卡模板）。
