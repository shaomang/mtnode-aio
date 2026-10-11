---
name: mtnode-verify-in-app
title: 真机自验（改 MTNode 时怎么验）
description: 开发 MTNode 自身功能（插件 / 应用 / 窗口交互 / 渲染层 UI）时的自验纪律：起一只独立数据目录的开发态实例，经 tools/mtnode-gui.mjs 用 MCP 驱动真实窗口（outline / click / type / set / screenshot），截图读像素确认，留下可复核证据；做不到就如实写「未验证 + 原因」，不许拿 smoke 当「功能真的能用」。Use when developing MTNode itself (plugin install / console UI / app window / renderer CSS / dialog behaviour) and you must prove the change really works in the running desktop app, not only in node smoke tests.
---

# 真机自验（改 MTNode 时怎么验）

本技能是**仓库内部开发纪律**（不写 `menu: user`，不进用户技能清单）：改 MTNode 自己的功能时，收尾前**先把真实 MTNode 跑起来、用 MCP 点它、截图看像素**，再谈「做完了」。

为什么有这条：`node test/run-all.mjs` 那批 smoke 覆盖的是**调用参数与调用次序**（它们不启动 Electron）。窗口类改动——插件的安装窗与控制台、应用窗口、设置面板、渲染层 CSS / 布局、报错弹窗——冒烟全绿也可能在真机上根本不对。仓库自己的自检报告就把这类结论写成了「未验证」（见 `docs/reports/prelaunch-selfcheck-1.5.0.md`：真机 GUI 点验列在「本轮口径外」）。

---

## 一、什么时候必须做

| 改动性质 | 自验要求 |
| --- | --- |
| **窗口 / UI / 插件交互**：插件卡片与安装窗、控制台 UI、应用窗口、渲染层 CSS 与布局、对话框与参数面板、报错弹窗、节点头部按钮 | **必须真机自验**（第二～五节全做） |
| 主进程行为 / 数据落盘 / 打包白名单 / 纯逻辑与协议面 | 以既有 smoke 与探针为主（见第七节），真机自验可选 |
| 任何情况下都做不到真机自验时 | **不许沉默**：在交付里逐条写明「未验证 + 原因」，并给用户一句怎么自己验 |

---

## 二、起一只属于你自己的实例

**铁律：绝不驱动用户正在用的那只实例，绝不占默认数据目录**（`%APPDATA%\pipeline-console`）。用户就在这个应用里工作，你的一次误点会落在他的窗口和画布上。

主进程**没有单实例锁**，所以可以和用户那只并存；用独立数据目录把副作用全圈起来：

```powershell
# 每轮新建干净目录（<out> 取仓库外的工作目录，别落在仓库里）
$ts   = Get-Date -Format 'yyyyMMdd-HHmmss'
$run  = "<out>\verify-$ts"                    # 本轮的证据根目录
$data = "$run\clean"; New-Item -ItemType Directory -Force -Path $data | Out-Null
$env:MTNODE_DATA_DIR = $data                  # 应用真正的数据目录 = $data\pipeline-console
npm start                                     # = electron .，跑仓库源码（改动只在源码态才验得准）
```

- 起的是**开发态**（`electron .`）：验的是你刚改的源码，不是装好的旧包。
- 数据目录、日志、截图都放进 `$run`，**跑完关掉这只实例**（连子进程一起），别把它留在后台。
- `MTNODE_DATA_DIR` 是「上一层」，应用会在其下再建一层 `pipeline-console\`——`--data` 两种都能自动认（见下）。

---

## 三、接通 MCP（握手）

MCP 服务端**默认开启**（`mcp-server.js` 的 `enabled: true`），实例一起来就会把端口与令牌写进 `<数据目录>\mcp-server.json`。仓库里有一把零依赖驱动 `tools/mtnode-gui.mjs`：它自己读那份 JSON（`--data` → `--data\pipeline-console` → `$MTNODE_DATA_DIR` 顺序找），直连 `POST /ctl`，你**不必**自己写 MCP 客户端。

```bash
node tools/mtnode-gui.mjs discover --data "<out>\verify-<ts>\clean"
# → ok:true · health{port,pid} · tools:[mtnode_canvas_get, mtnode_app, mtnode_canvas_edit,
#    mtnode_vision, mtnode_db, mtnode_facts, lt_state, mtnode_assets, mtnode_gui] · hasGui:true
```

**握手这一步就是第一条判据**：`ok:true` 且 `tools/list` 里见到你要用的工具（窗口动作看 `hasGui`）。端口是随机分配的，所以永远由脚本发现，不要去猜。

---

## 四、驱动真实窗口与截图

```bash
node tools/mtnode-gui.mjs gui windows  --data "<dir>"                        # 现在开着哪些窗（id/标题/可见/最小化）
node tools/mtnode-gui.mjs gui outline  --data "<dir>" [--which main|install|"<标题子串>"]
node tools/mtnode-gui.mjs gui text     --data "<dir>"                        # 只看可见文本
node tools/mtnode-gui.mjs gui click    --target '{"text":"开始安装"}' --which install --data "<dir>"
node tools/mtnode-gui.mjs gui type     --target '{"css":"#url"}'  --args '{"text":"…"}' --data "<dir>"
node tools/mtnode-gui.mjs gui screenshot --args '{"path":"<run>\\shots\\01-install.png"}' --which install --data "<dir>"
node tools/mtnode-gui.mjs call mtnode_app --args '{"action":"status"}' --data "<dir>"   # 任何工具都能这么调
```

- `mtnode_gui` 点的是页面里**真实的 DOM 元素**（不是屏幕坐标），所以窗口不必在前台；`target` 五种写法 `{css}` / `{text,exact?,index?}` / `{title}` / `{role,name?}` / `{ref}`（`ref` 来自 `outline`）。
- PowerShell / cmd 常把 `--args '{"path":"…"}'` 的引号吞掉：改用环境变量 **`MTNODE_GUI_ARGS`** 传 JSON（脚本会兜底读它）。
- 退出码：`0` = 回执 ok；`2` = 回执 `ok:false`（错误文本照打，读它再调整，别盲目重试）；`1` = 用法 / 环境错误。
- 每次动作的回执都带 `{ok, window, element?:{tag,id,cls,text,label}}`；失败会说清「没找到什么」。

**够不着的**（如实避开，别反复试）：原生菜单、系统文件选择框、托盘菜单、最小化 / 隐藏窗口的截图、任何凭据输入。

---

## 五、判据四步 + 证据落点

一次真机自验**四步全做到才算验过**：

1. **握手**：实例起来、`discover` 成功、`tools/list` 里有你要用的工具；
2. **真读真点**：用 `gui outline` / `gui text` 读界面，用 `click` / `type` / `set` 真的操作控件——不是读源码推断；
3. **截图读像素**：`gui screenshot` 把关键状态拍下来，再用读图能力**看像素**确认（外观、按钮、弹窗、布局）；
4. **证据可复核**：截图绝对路径 + 跑过的命令 + 数据目录（+ 一份 `report.json`）留在证据目录里，交付时把路径写给用户。

证据目录（**仓库外**，别往仓库塞产物、别混进用户数据目录）：

```
<out>\verify-<时间戳>\
  clean\           本轮实例的数据目录（MTNODE_DATA_DIR 指向它）
  shots\           01-xxx.png / 02-yyy.png …（每张对应一个被验证的状态）
  logs\            实例 stdout / stderr
  report.json      { ts, dataDir, mcp:{port,pid,tools}, steps:[{what,cmd,result,shot}], unverified:[{what,why}] }
```

---

## 六、做不到时的写法（同样是纪律）

- **先自己修**：MCP 连不上多半是实例没起来 / 起晚了 → 重起一次，必要时换一个全新数据目录再来（旧的 `mcp-server.json` 端口早失效，硬连只会得到 `fetch failed` 这种假象）。
- 仍然不行：**如实记「未验证 + 原因」**，并给用户一句可执行的指引——MCP 总开关在「设置 → 扩展能力 → 管理… → 服务端」（数据目录里 `mcp-server.json` 没被创建 / `enabled:false` / `port:0` 都能从这里看出来）。
- 不许把「smoke 全绿」「源码里写着」当成真机验过的结论。

---

## 七、两层验证：真机为主，smoke 仍要跑

| 层 | 验什么 | 命令 |
| --- | --- | --- |
| **真机自验**（主） | 功能在真实窗口里到底能不能用 | 见第二～五节 |
| smoke 回归（补） | 调用参数、调用次序、落盘与白名单、协议面 | `node test/run-all.mjs <子串>`、`node scripts/probe-mcp-server.mjs`、`node scripts/build-mcp-contract.mjs --check` |

smoke 不替代真机自验——它不启动 Electron。反过来，真机自验也不替代 smoke：改一处就把相关那只 smoke 跑一遍。

**现成先例**（照抄它们的起实例 / 收尾 / 客观证据写法，别重造）：

- `scripts/e2e-mcp-inchanged.mjs` —— 起干净数据目录的真实例 + 真 HTTP MCP（Bearer）+ 落整窗截图与 JSON 报告；
- `scripts/e2e-mcp-full.mjs` —— 真应用 + 真渲染层，按 MCP 协议逐条打全部工具 / 资源 / 提示词；
- `tools/plugin-install-drive.mjs` —— 用 `mtnode_gui` 真的点插件安装界面（窗口动作当 API 用的范例）；
- `scripts/probe-mcp-server.mjs` / `probe-mcp-stdio.mjs` —— **假渲染层**，只验协议面，**不算真机自验**。

---

## 八、常见坑

| 坑 | 后果 | 怎么办 |
| --- | --- | --- |
| 拿用户正在用的实例做验证 | 点在用户窗口上、写坏他的数据与画布 | 永远另起独立 `MTNODE_DATA_DIR` 实例 |
| 沿用上一轮的 `mcp-server.json` | 端口早失效 → `fetch failed` 假象 | 每轮新数据目录；或先 `discover` 确认 `health.ok` |
| 用打包态（安装包 / `npm run compile` 产物）验源码改动 | 验的是旧代码，绿了也是假绿 | 开发态 `npm start`（`electron .`） |
| `--args '{"path":"…"}'` 引号被吞 | 参数变成空对象，动作静默不带路径 | 用 `MTNODE_GUI_ARGS` 环境变量传 JSON |
| 只拍截图不看像素就当验过 | 截图里明明是旧的 / 错的布局也放过 | 截图后用读图能力确认，并把结论写进 `report.json` |
| 验证实例忘了关 | 后台留一只 Electron，下次端口 / 锁与现场全乱 | 收尾连子进程一起关掉，日志留在 `logs\` |
| 把「未验证」说成「应该没问题」 | 用户以为验过了 | 逐条写「未验证 + 原因」，并给一句怎么自己验 |

**真源纪律**：`mtnode_gui` 等工具的参数表只有一处真源——`dsh/gateway/*-plugin.mjs`；工具面清单与 MCP 服务端口径见技能 `mtnode-mcp-server`。本技能不抄第二份，冲突时以代码与那份技能为准。
