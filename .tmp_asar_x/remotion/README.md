# remotion 应用插件（Remotion 动效视频）

MTNode 应用插件（宿主型 `kind=remotion`）：为画布提供「Remotion 视频」节点——输入文本描述，由用户配置的 LLM 生成 React 动效合成（Composition.tsx），再经本机 [Remotion](https://www.remotion.dev/) 渲染为 `.mp4`。未安装或卸载插件时，节点菜单入口与画布节点均不显示。

## 目录结构

```
remotion/
├── main-remotion.js      # 主进程宿主（数据目录 %APPDATA%/pipeline-console/remotion/：
│                         #   config.json / installed.json / console.log / ui/）
├── preload-remotion.js   # contextBridge 白名单桥（window.remotionApi）
└── ui/                   # 简易控制台窗（状态卡 / 安装按钮 / 日志尾巴）
../remotion-pack/         # 随包脚手架（依赖锁版本 + render.mjs + 模板），
                          # 经 build.json extraResources 打进安装包
```

## 数据流

**安装**：插件对话框 → 选择目录 → 从随包 `remotion-pack` 复制模板 → `npm install`（支持国内镜像）→ 校验 `node_modules/remotion` 版本 → 写 `installed.json`。

**技能**：安装过程不会自动下载任何 Agent 技能。技能属可选增强，获取方式见下方「技能（可选）」；本节点的动效代码生成与本地渲染都不依赖任何技能。

**渲染**：节点描述（来自上游文本节点连线端口 1，节点内无描述字段）→ 渲染层 `apiCall`（用户所选 provider/model）生成 Composition.tsx → IPC `remotion:render` → 主进程写 `src/` 模板与 `render.json`（契约见下）→ spawn `node render.mjs` → 进度事件 `remotion:progress` → 完成返回 `{ ok, path }`，视频由**下游「保存」节点**复制到其 savePath（节点自身不设输出路径；渲染产物默认在安装目录 `out/`，宿主 `resolveOutputPath` 自动去重）。渲染前经 `media-gen-global-lock` 获取音视频全局互斥（与 music_gen / video_gen 全局唯一）。

**合成来源**（`writeRenderSources` + `normalizeCustomComposition`）：优先采用渲染层下发的 `params.tsx`（LLM 生成的动效代码）作为 `src/Composition.tsx`——**渲染出来的就是这份代码**；只有它为空时才回退内置标题卡模板（结构化参数 `title` / `subtitle` / `bgColor` / `images` / `audioPath`）。下发代码先做两步轻校验，不合规直接以节点 error 返回（不静默回退，避免「生成的是动效、出来的却是标题卡」）：

- `custom_tsx_bad_import: <模块>` —— 只允许 `react` / `remotion`（相对路径放行）；安装目录没有其它 npm 包，放行则必然在打包阶段炸且日志难定位。
- `custom_tsx_no_main_export` —— 找不到可注册的组件。入口固定以 id `Main` 注册 `./Composition` 的 `Main`；`export default X` 或唯一的大写具名导出会自动补 `export const Main = X;` 别名，markdown 代码围栏会被剥掉。

## render.json 契约（remotion-pack/render.mjs）

宿主每次渲染前在安装目录写 `render.json`（脚本默认读 `./render.json`，不再使用环境变量）：

| 字段 | 说明 |
|------|------|
| `entryPoint` | 入口文件，宿主写 `src/index.tsx`（`writeRenderSources` 生成的入口：定义 `RemotionRoot` 并以 id `Main` 注册 `<Composition>`，组件为 `./Composition` 的 `Main`，尺寸/时长是节点参数算出的字面量占位，`render.json` 同字段在 `selectComposition` 后就地覆盖；入口只 import `{ Main }`，不 import `CFG`（自定义合成不导出它）。**必须 `.tsx`**——入口含 JSX，esbuild 不在 `.ts` 中解析 JSX |
| `composition` | 合成 id，宿主默认 `Main`（与 `writeRenderSources` 注册的 id 一致，可按需覆盖） |
| `fps` / `width` / `height` / `durationInFrames` | 渲染参数（宿主由节点参数计算，durationInFrames = round(duration×fps)） |
| `inputProps` | `{title, subtitle, bgColor}`，可选 `audioPath`（非空才附带）；仅内置模板读取，自定义合成忽略 |
| `codec` | `h264` |
| `outputLocation` | 输出视频绝对路径（`resolveOutputPath` 结果，默认安装目录 `out/`，文件名自动去重） |

脚本 stdout 为 JSON Lines：`{"type":"bundleProgress"|"bundled",...}`（就地打包）、`{"type":"progress","progress":0..1}`（渲染进度，0.5% 节流）、`{"type":"done","outputLocation":"..."}`（完成）、`{"type":"error","message":"..."}`（失败，exit 1）。宿主 `parseRenderProgressLine` 按此解析进度与完成路径。

**IPC 通道**：`remotion:getStatus / pickInstallDir / setInstallDir / install / cancelInstall / render / cancelRender / getLock / consoleTail / open / close / removePluginMeta / freeDisk`，事件 `remotion:progress / remotion:console / remotion:consoleChanged`。

## 发布方式

- 应用内置目录条目维护在 `plugins/catalog.default.json`（本仓库）。
- **远端 catalog 发布（插件市场 / 创意工坊）属运维流程**：经 `ext-repo/` 构建与上传，本模块不包含，也不在此重复实现。

## 卸载 / 移除

插件对话框「移除入口」仅删除数据目录 `ui/`（并取消进行中的渲染），**保留**安装目录与已安装项目，重装可复用；彻底删除安装目录需在控制台手动操作。

## 技能（可选）

安装与渲染过程**都不会自动下载任何 Agent 技能**——不装技能照样能生成动效代码并本地渲染。技能只是可选增强：当需要 LLM 写出更规范的动效代码（少踩 `custom_tsx_bad_import` / `custom_tsx_no_main_export` / esbuild `Transform failed` 这类失败）时再装。

- **推荐获取路径**：右上角「创意工坊」→ 顶部切到 **Skill** 分类 → 搜索 **Remotion 动效视频** → 下载。下载后落在本机数据目录 `%APPDATA%\pipeline-console\dsh-home\skills\`（源文件见 `ext-repo/skills/remotion-video/SKILL.md`），全局助手、智能会话与智能节点（含本节点的绑定会话）都能直接使用，输入 `/` 可呼出。工坊里再点「更新」会用远端版本覆盖本机副本。
- **进阶（官方整包，用户自行执行）**：官方 `remotion-dev/skills` 整包受体积 / 附件数与许可限制不上架 MTNode 扩展目录，需要时由用户自己跑：

  ```
  npx -y skills add https://github.com/remotion-dev/skills --skill remotion-best-practices
  ```

  工坊上架的是自撰精简版，另补了 MTNode 宿主契约（`render.json`、`src/index.tsx`、合成 id `Main`），比官方原文更贴合画布用法。
