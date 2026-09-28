# 依赖减重（app-deps）— 设计与操作手册

> 起因：「`dsh/gateway` 有哪些内容是本应用不需要的？移除冗余 node module 给整个应用减重」。
> 结论先行：**能删的包几乎没有，能删的文件非常多**。所以本模块交付的不是一次性的删除，
> 而是一套「体检 → 按名单剪枝 → 六道守卫复验」的可重复工具链。
>
> 名单只有两种口径，都生成在 `docs/` 下、都被 after-pack 直接读取：
> **零引用**（`app-deps-prune.json`，机器判定：从入口出发完全没有任何引用）与
> **能力取舍组**（`app-deps-capability.json`，人工判定：包在懒加载闭包里可达，但 MTNode
> 这套部署永不加载该能力）。见 §2 / §7。

## 1. 三个文件，一条链

| 文件 | 角色 |
| --- | --- |
| `scripts/app-deps-usage.mjs` | 体检：对两棵 `node_modules` 做可达性标记-清除 + 文件级剪枝量度量，产出 `docs/app-deps-prune.json`（零引用口径）；再以能力组入口重算独占下游闭包，产出 `docs/app-deps-capability.json`（`--capability` 只看这一份） |
| `scripts/app-deps-rules.cjs` | **唯一的规则源**（CommonJS）：包名级平台剪枝、文件级剪枝、入口解析，以及排除器 `loadExcluder()` / 按组判定 `gatewayPruneDecision()`。after-pack / 体检 / 复验三处共用，避免「分析说能省、打包实际没省」 |
| `scripts/app-deps-check.mjs` | 复验：把同一套规则应用到临时镜像，跑六道守卫 + `dsh/smoke-gateway.mjs`（见 §4） |

消费方：`dsh/after-pack.cjs`（经 `RULES.loadExcluder()` 合并读 `docs/app-deps-prune.json` 的
`trees.gateway.excludePackages` **与** `docs/app-deps-capability.json` 的各 `groups[]`，决定
`resources/dsh/gateway` 复制什么，并按组打印实测省下的 MB）与 `build.json` 的 `files` 取反规则
（决定 `app.asar` / `app.asar.unpacked` / `extraResources` 里剩什么；能力组四组通配在根
`node_modules` 命中 0 个包，故根树不需要跟随取反）。

**剪枝只发生在打包阶段**：`node_modules` 树、`package.json` 依赖声明、锁文件、`.dsh-probe/`
一律不动（AGENTS.md「不要修改」清单）。

> 入库口径：`.gitignore` 把 `scripts/`（第 10 行）与 `build.json`（第 7 行）划在「打包链不入库」里，
> 所以随仓库流转的只有 `docs/` 下那两份名单 —— `docs/app-deps-prune.json`（零引用）与
> `docs/app-deps-capability.json`（能力组）。`dsh/after-pack.cjs`（入库）读不到某一份时只警告并
> 跳过该口径（不打断打包），而 `scripts/app-deps-rules.cjs` 与既有的
> `scripts/ensure-app-update-yml.cjs` 一样，默认只在作者工作副本内。

## 2. 可达性口径（为什么「删包」几乎没得删）

- 根 = 本仓源码里出现的引用 + `dsh/gateway/cordis.yml` 的 `name:` 挂载 + 直接依赖/CLI 依赖
  （`dsh/gateway/package.json` 的 dependencies；根 `package.json` 的 devDependencies）。
- 边 = **无状态**的「引号里正好是包名」匹配（`QUOTED_RE`）+ 模板前缀（`@img/sharp-${…}`）。
  不用词法器：正则字面量里的引号会让状态机跑偏，实测会凭空造出 100MB 假死重。
- 懒加载分支（`await import()`、profile 表里的字符串、SDK 的可选适配器）**算可达 → 保留**。
  这是用户明确约定的口径：「不要动懒加载的分支以及其他任何可能被项目引用的包」。
- 静态扫描没抓到引用 ≠ 运行时不会 require。因此不可达的包还要过**声明守卫**：只要它是某个
  活包的 `dependencies`/`optionalDependencies`，就不自动排除（`--no-decl-guard` 可看差异）。

实测（1.2.2 / win32-x64）：

| 树 | 包数 / 体积 | 零引用可移除 | 守卫兜底 |
| --- | --- | --- | --- |
| `dsh/gateway/node_modules` | 540 / 226.8MB | **16 包 / 1.92MB** | 17 包 / 2.8MB |
| 根 `node_modules` | 296 / 440.95MB | **0 包** | 0（production 闭包 22 包 / 37.5MB 全部可达；其余 400MB 是 devDependencies，本就不随包发布） |

网关那 16 个包：`@deepseek-ai/dsh{,-terminal,-terminal-bash,-schedule,-persona,-authorization,-time-context,-tmux-context,-tool-cordis,-tool-bash-persistent,-tool-pwsh-persistent,-agent-tool-presentation}`、`@tanstack/virtual-core`、`@types/ms`、`ts-algebra`、`@babel/runtime`。

## 3. 文件级规则（99% 的减重量在这里）

只删「本机运行期一定加载不到」的东西，全部规则集中在 `scripts/app-deps-rules.cjs`：

| 理由 | 内容 | 为什么安全 |
| --- | --- | --- |
| `types` | `*.d.ts / *.d.cts / *.d.mts / *.tsbuildinfo` | Node 不加载声明文件；`types` 条件只给 TS 看 |
| `map` | `*.map` | 只服务 devtools（after-pack 早就在排，这次统一进规则源） |
| `platform` / `platform-pkg` / `platform-binary` | 包名或目录名带 `darwin/linux/musl/freebsd/arm64/ia32/loong64/…` 且非 `win32-x64`；`prebuilds/win32-arm64/*.node` 等 | win32-x64 上 `dlopen` 不可能成功；`.dll`/`.exe` **永不**按平台名剪（node-pty 的 `winpty.dll`、`OpenConsole.exe` 要留） |
| `build-intermediate` | `.pdb .obj .o .a .lib .iobj .ipdb .exp .tlog .recipe .vcxproj .sln .gyp .gypi` 与 `build/*/obj/` | 编译期产物；链接期静态库不参与运行（node-pty 一家带 20MB `.pdb`） |
| `top-dir` | **包根第一层**的 `test tests __tests__ example examples docs benchmark benchmarks coverage` | npm 惯例；绝不用「路径里出现过」判断 |
| `doc-file` | 文件名为 `README/CHANGELOG/HISTORY/CONTRIBUTING/SECURITY/CODE_OF_CONDUCT/AUTHORS` 的 `.md` | 其余 `.md` 可能是插件运行时要读的提示词/技能正文，一律保留；`LICENSE*` 一律保留 |
| `pkg-src` | `better-sqlite3/{deps,src}`、`uiohook-napi/{libuiohook,src}`、`node-addon-api/tools` | 运行期走 `prebuilds/` 或已编译 `.node`；`build/Release/*.node` 保留（node-gyp-build 优先加载它） |

## 4. 六道守卫（改规则、改名单或升级 dsh 后必须全绿）

体检里还有一道前置的**声明守卫**：不可达但被某个活包声明为 runtime/optional 依赖的包不自动排除
（`--no-decl-guard` 可看差异）。`npm run deps:check` 则在临时镜像上按下面六道跑，排除集 =
**零引用 ∪ 能力组**（与打包同一份名单、同一个判定函数，镜像就是最终进包的那棵树）：

| # | 守卫 | 判据 | 抓到过什么 |
| --- | --- | --- | --- |
| ① | 入口自检 | 保留包的 `main`/`exports` 目标不得被规则判为可剪；按「源树有、镜像无」比较，不把上游本来就缺的文件算到剪枝头上 | — |
| ② | 相对引用完整性 | 扫描镜像里全部保留的 `.js/.mjs/.cjs`，任何 `./`、`../` 指向的文件若「源树有、镜像无」即报错（`*.d.ts` 例外：JSDoc `import('./x.d.ts')` 不是运行时加载） | `yaml/dist/doc/directives.js`（见下方事故） |
| ③ | 裸包名引用 | 保留文件里 `from` / `require(` / `import(` 的**裸包名**命中排除集即失败；例外只有写死的**懒加载白名单**（下表），命中记进 `lazyHits`、不致命 | 一次真实的「半摘」：`@tanstack/react-virtual` 被保留、`virtual-core` 被摘 |
| ④ | runtimeBin 加载探针 | `@deepseek-ai/dsh-sdk-jsonrpc-demo/lib/bin.js` + `cordis.yml` 在剪枝镜像与仓库原始树上都必须加载成功，出现 `Cannot find module` / `fatal load failure` 直接失败 | — |
| ⑤ | 启动探针 | 在被测目录内真实 `await import()`：`@earendil-works/pi-ai/providers/all`（把 models.generated 与 providers 的相对链跑到底）、`api/openai-completions.lazy`（懒加载壳）；再按 `cordis.yml` 逐行 resolve + import 插件链（含 `disabled` 门控）；最后 `node gateway.mjs` 真起一次（stdin EOF 自退出） | — |
| ⑥ | 协议冒烟 | `dsh/smoke-gateway.mjs`：status / pluginList（含 `mtnode-canvas`、描述字段）/ run 事件流 / shutdown / 退出码 0 | — |

守卫 ③ 的懒加载白名单（写死在 `scripts/app-deps-check.mjs`，每条注明它是哪个 `.lazy.js` 的下游；
`MTNODE_DEPS_VERBOSE=1` 打印放行明细）：

| 引用方（保留在包里） | 是哪个懒加载壳的下游 | 它静态 import 的排除包 |
| --- | --- | --- |
| `pi-ai/dist/api/mistral-conversations.js` | `api/mistral-conversations.lazy.js` | `@mistralai/mistralai` |
| `pi-ai/dist/api/bedrock-converse-stream.js` | `api/bedrock-converse-stream.lazy.js` | `@aws-sdk/client-bedrock-runtime`、`@smithy/node-http-handler`、`http(s)-proxy-agent` |
| `dsh-session-telemetry-otel/**` | `dsh-base/cordis.patch.yml` 的挂载行（本部署永不读取） | `@opentelemetry/*` |

> 白名单两点如实备注：第三行今天是**空转**的（`dsh-session-telemetry-otel` 整包已随 `otel` 组被排除，
> 没有保留文件落在该目录下），留着是为了「父包保留、只摘 OTel SDK」那种拆法；
> `http-proxy-agent` / `https-proxy-agent` 目前**不在**排除清单里（bedrock 的下游没算它们），
> 所以这两个小包仍在包里 —— 即便将来被排除，③ 也会因引用方在白名单内而放行。

> 「懒加载」意味着静态分析看不出问题、真跑才知道 —— 所以 ③ 是**白名单**而不是「放行一切字符串提到」，
> 且 ④⑤⑥ 必须跑在**含能力组的完整排除集**上。`--mirror-only` 只跑到 ③（纯静态、几秒），
> 改完名单先跑它，再跑全量；`--keep` 保留镜像目录便于手摸。

> 历史事故（守卫 ② 的由来）：`PRUNE_DIRS` 早期含 `doc`，把 `yaml/dist/doc/directives.js`
> 当文档目录剪掉了 —— `yaml` 的 `dist/compose/composer.js` 运行时 `require('../doc/directives.js')`，
> 网关 `run` 直接 `fatal load failure`。协议冒烟当时**没有**报错（它只回显 60 字符 stderr，
> 且断言的是 error+done 事件），所以单靠冒烟不够，守卫 ② 与探针 ④⑤ 缺一不可。

## 5. 实测收益（1.2.2，win nsis x64）

| 位置 | 剪枝前 | 零引用 + 文件级 | **+ 能力组（当前）** |
| --- | --- | --- | --- |
| `resources/dsh`（网关全树） | 191.18MB | 124.80MB | **76.30MB** |
| `resources/app.asar` | 10.68MB | 9.28MB | 9.29MB |
| `resources/app.asar.unpacked` | 29.08MB | 2.43MB | 2.43MB |
| `resources/uiohook-napi`（extraResources） | 8.02MB | 0.50MB | 0.50MB |
| **resources 合计** | **243.71MB** | **141.76MB** | **93.27MB（−61.7%）** |
| **安装包 `MTNodeAIO-Setup-*.exe`** | **154.9MB** | **130.1MB** | **117.79MB（−24.0%）** |

安装包降幅（−37.11MB）小于 `resources` 降幅（−150.44MB）是因为 NSIS 压缩对 `.c/.map/.d.ts`
这类文本本来就压得很狠（≈10:1），摘掉的又大半是已压过的 JS/JSON；`resources` 少 150MB 仍然有意义：
安装后磁盘占用、解压耗时、以及后续增量更新的 blockmap 体积。

打包侧日志即真相：after-pack 按**桶**打印实测剪掉的包目录数与 MB（`zero-ref` / `cap:<组>` /
`cap:collateral` / `manual` / 文件级各桶），并附清单声明值 —— 两者不一致就是名单漂了。

## 6. 日常操作

```
npm run deps:usage          # 体检：两棵树 → docs/app-deps-prune.json + docs/app-deps-capability.json
npm run deps:cap            # 只重算能力组闭包并打印（网关树；两份 JSON 的 gateway 段随之刷新）
npm run deps:check          # 镜像复验：六道守卫 + 冒烟（零引用 ∪ 能力组，与打包同口径）
npm run deps:check -- --mirror-only         # 只跑静态守卫 ①②③（改完名单先跑这个，几秒）
npm run deps:usage -- --why=@deepseek-ai/dsh-web-app   # 某个包为什么算可达
npm run deps:usage -- --tree=gateway                   # 只查一棵树
```

- **升级 dsh 后**（改 `dsh/gateway/package.json` + `npm install`）必须重跑 `deps:usage` +
  `deps:check`：可达名单会变，两份清单都会重算，守卫会拦住新的误剪。能力组的 `reason` / `risk`
  里写的证据链（哪个文件挂载、哪个懒加载壳）也要顺手复核 —— 脚本只算闭包，**判「这个能力还要不要」是人的事**。
- **回滚一个零引用包**：从 `docs/app-deps-prune.json` 的 `excludePackages` 删掉该包名即可（该文件是
  生成物，若要永久改变口径就改 `scripts/app-deps-usage.mjs` 的 `TREES.forceKeep`）；文件级规则
  要回滚就改 `scripts/app-deps-rules.cjs`（改完重跑 `deps:check`）。
- **回滚一整个能力组**：删掉 `docs/app-deps-capability.json` 的 `groups[]` 里那个组对象 —— 不改任何代码。
- `dsh/after-pack.cjs` 里的 `EXTRA_EXCLUDE_PACKAGES` 是人工兜底名单，目前为空 —— 一切以体检为准。

## 7. 能力取舍组（本轮已实施 · `docs/app-deps-capability.json`）

与 §2 的区别就是**判定者**：零引用是机器判的（从入口出发完全没有任何引用）；能力组是**人判的**——
包在懒加载分支里可达、机器不许摘，但业务上确认「MTNode 这套部署永不加载这个能力」。用户点名四组，
逐组核过引用机制后才落清单：

| 组 | 摘什么 | 入口 + 独占下游 | MB | 代价 |
| --- | --- | --- | --- | --- |
| `otel` | `@opentelemetry/*`（含 `pi-ai` 内 1 份嵌套副本） | 11 + 0 | 21.51 | OTLP 遥测导出不可用 |
| `awsui` | `@deepseek-ai/dsh-web-app` + `dsh-web-frontend`（网关自带 Web 外壳与已构建前端产物） | 2 + 152 | 40.00 | 网关自带 Web UI / `--profile web` 起不来 |
| `mistral` | `@mistralai/mistralai` | 1 + 0 | 9.24 | 原生 Mistral 服务商接不了 |
| `aws` | `@aws-sdk/*` + `@smithy/*` + `@aws-crypto/*` | 32 + 2 | 5.81 | AWS Bedrock 适配器不可用 |
| — | `cap:collateral` 连带桶（摘组后顺带不可达：`dsh-base`、`dsh-headless`、`picocolors`…） | 15 | 0.66 | 随组一起消失 |

合计 **215 包 / 77.2MB**（入口 46 + 独占下游 169，嵌套副本净增 1.16MB）；after-pack 实测
21.51 / 40.01 / 9.24 / 5.79 + 连带 0.66，与声明一致。网关树 `node_modules` 227.87MB 剪到
**76.3MB**（只剪零引用时是 122.72MB —— 能力组这一步再降 **46.42MB**）。

**为什么这四组安全（各自的证据链，全文见 JSON 里的 `reason` / `risk`）**

- `otel`：挂载 `dsh-session-telemetry-otel` 的那一行只存在于 `@deepseek-ai/dsh-base/cordis.patch.yml`
  的 bundle 层，而本部署把 `dsh/gateway/cordis.yml` 直接喂给 `dsh-sdk-jsonrpc-demo/lib/bin.js`
  （无 built-in fallback、不套 profile 层）→ 永不读取；`dsh-base` 自己也随组进了清单。
- `awsui`：MTNode 用自己的 renderer，网关以 stdio JSON-RPC 无界面启动；`dsh-app-boot` 里只有
  `SHIPPED_PROFILE_TEMPLATES` 的**字符串**提到它（mention，不是挂载）。
- `mistral` / `aws`：唯一入口是 `pi-ai` 的 `dist/api/mistral-conversations.js` 与
  `dist/api/bedrock-converse-stream.js`，两者都是 `lazyApi(() => import(...))` 的下游 ——
  包不在时只在真选那家的模型时报错，主链路 `openai-completions` 一行都不碰它们。

**下游 152 包不是手写的**：以四组入口为新的不可达起点重算一遍闭包，只有「只被这四组引用」的才并进来
（`react`/`react-dom`/`scheduler`/`zustand`/`immer`/`@tanstack/*`/`shiki`/`@shikijs/*`/`katex`/
`micromark·mdast·hast·unist` 全家，以及整套 `@deepseek-ai/dsh-client-ui-*` + `dsh-client-runtime`）。

**硬保护名单 `rejected`（114 包）**：仍被保留侧硬引用的名字一律不摘，scope 通配与连带桶都越不过它。
最容易踩的一条：`@deepseek-ai/dsh-web` 与 `awsui` 组同前缀，但它是 `cordis.yml:351` 挂载的**联网搜索**
（纯净模式也只保留联网），所以 `awsui` 的 `globs` 写的是两个精确名字而不是 `@deepseek-ai/dsh-web*`；
`dsh-web-search-deepseek` / `dsh-tool-web` 同理保留。`openai`、`zod`、`koffi`、`yaml`、`@deepseek-ai/dsh-api-gateway`
这条真挂载链也都在 `rejected` 里，原因逐条写明是哪个保留包、哪种边、哪个文件。

**要恢复某项能力**：删掉 `groups[]` 里对应组对象（连带桶没有组可删，按名字从 `excludePackages` 删），
重跑 `npm run deps:check` 再打包即可 —— 开发树 `node_modules` 从未被改动，包一直都在。
**若日后改为走 `dsh --profile web/headless`，或在设置里挂载 `dsh-session-telemetry-otel`**：必须先把
`otel` 与 `awsui` 两组撤掉，否则网关启动即 `ERR_MODULE_NOT_FOUND`。

**已知观感问题（不影响体积）**：`@opentelemetry`、`@mistralai`、`@aws-sdk`、`@smithy`、`@aws-crypto`、
`@shikijs` 在包内留下 **0 文件 / 0 MB 的空 scope 目录**（after-pack 先建 scope 目录再判定子包）。

## 8. 仍未摘的（需要你决策，属「能力取舍」不是「冗余」）

用户只点名了四组，其余懒加载分支按约定一个没动。若还想继续减，可逐个再验再摘（体积为包本体，未计文件级收益）：

| 目标 | 体积 | 引用来源（可达原因） | 取舍 |
| --- | --- | --- | --- |
| `@google/genai` | 13.74MB | `pi-ai/dist/api/google-generative-ai.js` / `google-vertex.js` / `google-shared.js`（懒加载适配器的静态 import；`utils/error-body.js` 只是注释里提到） | 不用 Gemini / Vertex 原生协议时可摘 |
| `@img/sharp-wasm32` | 8.65MB | `sharp/dist/sharp.cjs` 的无原生回退 | 桌面端有 win32-x64 原生二进制，wasm 回退基本用不到 |
| `@mixmark-io/domino` + `turndown` | 7.38MB | 联网工具的 HTML→Markdown | 摘了 `web_fetch` 返回就不是 MD；且它是**已上线功能**，不建议 |
| `@anthropic-ai/sdk` | 3.90MB | `pi-ai` 的 anthropic 懒加载适配器 | 不用 Claude 原生协议时可摘 |
| `openai` | 7.15MB | `pi-ai/dist/api/openai-*`（**主链路**） | 建议永久保留 |
| 根 `node_modules` 的 `marked` 等「声明但零引用」依赖 | — | `package.json` 里有、代码里没人 import | 不影响体积（本就不进包），纯声明卫生 |
