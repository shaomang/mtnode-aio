# MCP 接口契约（生成物与生成器）

- **机器可读契约**：[`../mcp-tools.json`](../mcp-tools.json) —— 工具清单与 JSON Schema、resources、prompts。
  由 `node scripts/build-mcp-contract.mjs` 生成，**禁止手改**。
- **校验表**：[`../mcp-tool-schemas.js`](../mcp-tool-schemas.js) —— 工具名 → 输入 schema，主进程在
  `tools/call` 之前用它做必填与类型校验（同一个生成器写出）。
- 接入指南与协议细节：[`mcp-server.md`](mcp-server.md)；用户手册：`guides/manual/mcp-server.md`。

## 为什么是「生成」而不是「手写一份」

项目硬规矩是**提示词单一真源**：画布 / 数据库节点的参数机制只写在
`dsh/gateway/{canvas,db,ai-facts,longtask,assets}-plugin.mjs` 的工具定义里。
所以 MCP 侧**不抄第二份**参数表 —— 生成器把插件模块的 `import` 剥掉、用桩替掉
`defineTool`，真实调用它的 `apply(ctx)`，于是每个 `defineTool({...})` 的
`name` / `description` / `parameters` 原样被抓下来；`parameters` 再交给**官方
`defineTool`（网关 `node_modules` 里那份，与运行时同一个函数）编译**成 JSON Schema。

插件改一个参数 → 契约与校验表一起变，不需要任何人记得同步。

## 生成与校验

```bash
node scripts/build-mcp-contract.mjs          # 重新生成两个产物
node scripts/build-mcp-contract.mjs --check  # 只比对，不一致退码 1（冒烟用它）
```

`test/smoke-mcp-server.js` 会跑 `--check` 口径：契约与插件参数表漂移即判失败。

## 生成器读什么、产出什么

| 输入 | 输出 |
| --- | --- |
| `dsh/gateway/canvas-plugin.mjs`（`mtnode_canvas_get` / `mtnode_app` / `mtnode_canvas_edit` / `mtnode_vision`） | `mcp-tools.json` 的 `tools[]`（含 `inputSchema`） |
| `dsh/gateway/db-plugin.mjs`（`mtnode_db`） | 同上 |
| `dsh/gateway/ai-facts-plugin.mjs`（`mtnode_facts`） | 同上 |
| `dsh/gateway/longtask-plugin.mjs`（`lt_state`） | 同上 |
| `dsh/gateway/assets-plugin.mjs`（`mtnode_assets`） | 同上 |
| 生成器内的 `MCP_RESOURCES` / `MCP_PROMPTS`（MCP 侧自有，无插件真源） | `resources[]` / `prompts[]` |

**不在导出范围**的插件（有意的边界，见 `guides/mcp-server.md` §5）：
`browser-plugin.mjs`（会话自己的浏览器，13 个工具）、`tools-plugin.mjs`（用户工具节点，参数由画布决定）、
`bridge-plugin.mjs` / `speech-plugin.mjs` / `longtask` 的记忆类动作等（宿主内部通道）。

## 契约里的字段

```
protocol  { name:"mtnode", version:1 }        MCP 握手用的服务标识
tools[]   { name, description, family,        family = 渲染层分派的 op 族
            source, inputSchema }
resources[]  { uri | uriTemplate, name, title, mimeType, description }
prompts[]    { name, title, description, arguments, builder(内部字段) }
```

`family` 与 `renderer/mcp-bridge.js`、`mcp-server.js` 的 `TOOL_OPS` 表三方对齐；
`test/smoke-mcp-server.js` 会钉住「契约里的每个工具都有接线」。
