---
name: office-local-install
title: Office→PDF 引擎按需安装（LibreOffice Kit）
description: 在 MTNode 数据目录按需安装 / 修复 Office→PDF 转换引擎（DeepSeek LibreOffice Kit）：把 @deepseek-ai/libreoffice-kit 与 win32-x64 原生引擎（bin/libreoffice-kit.exe，约 182MB）装到 %APPDATA%\pipeline-console\libreoffice-kit\，校验引擎能真跑一次转换，并把该目录的绝对路径写回网关的 skill-office 配置。安装包不再内置这 182MB + 145MB（见 docs/app-size-audit.md）。含自我修复指引。
---

# Office→PDF 引擎（LibreOffice Kit）— 按需安装 / 修复

当用户或 MTNode 需要把 **docx / xlsx / pptx 转成 PDF**、或要用 dsh 的 `office-docx` / `office-pptx` / `office-xlsx` 技能，而本机 **还没有装引擎** 时使用本 skill。

## 为什么是「按需安装」

安装包为了体积**不再内置** LibreOffice 引擎：

| 曾随包内置的包 | 应用包内体积 |
| --- | --- |
| `@deepseek-ai/libreoffice-kit-win32-x64`（原生引擎，`bin/libreoffice-kit.exe` 单个 170.3MB） | 182.0 MB |
| `@deepseek-ai/libreoffice-kit-wasm`（wasm 兜底，Windows 上永不加载） | 145.3 MB |

这两块在 MTNode 里**本来也从未被加载**（`dsh-sdk-app` 的 `skill-office` 行带 `DSH_PRIMARY_RUNTIME` 门控，MTNode 从不设置该变量），所以摘除不改变现状；本 skill 只是把「真要用时怎么装回来」固化成一条流程。判定与清单见 `docs/app-size-audit.md` 与 `docs/app-deps-capability.json` 的 `office` 组。

## 目标

在 **`%APPDATA%\pipeline-console\libreoffice-kit\`**（下称 `ENGINE_DIR`，即 MTNode 数据目录下，**绝不允许放进应用目录 / `app.getAppPath()` / exe 同目录**）建立一份可运行的引擎，并让网关能指向它：

```
ENGINE_DIR\
  node_modules\@deepseek-ai\libreoffice-kit\           # 入口包（lib/index.js · lib/cli.js）
  node_modules\@deepseek-ai\libreoffice-kit-win32-x64\ # 原生引擎（bin/libreoffice-kit.exe + program/）
  package.json
```

命令行入口 = `ENGINE_DIR\node_modules\@deepseek-ai\libreoffice-kit\lib\cli.js`，用**真 Node**（≥22.19）执行，不要用 Electron 的 `process.execPath`。

## 步骤

1. **先探存量**：`%APPDATA%\pipeline-console\libreoffice-kit\node_modules\@deepseek-ai\libreoffice-kit-win32-x64\bin\libreoffice-kit.exe` 存在且能 `--version` → 已装好，跳到第 5 步验证；只缺一半则回到第 2 步补齐（`npm install` 可幂等续装）。
2. **建目录**：`ENGINE_DIR` 下写一份最小 `package.json`（`{"name":"mtnode-libreoffice-kit","private":true}`），**不要**把 `ENGINE_DIR` 建在应用安装目录里。
3. **装包**：在 `ENGINE_DIR` 里执行
   `npm install --no-audit --no-fund @deepseek-ai/libreoffice-kit@0.1.2`
   平台包是它的 `optionalDependencies`（win32-x64 / wasm / darwin-* / win32-arm64），npm 只在匹配平台时装 —— **装完检查 `libreoffice-kit-wasm` 是否也进来了**：它是 Linux 兜底，Windows 上可以删掉（省 145MB），但删之前先确认 `win32-x64` 的原生引擎已在。
   - 网络慢 / 失败：先试 `--registry=https://registry.npmmirror.com`，再回官方源。
   - 装的是 `0.1.2`；换版本前先在 https://www.npmjs.com/package/@deepseek-ai/libreoffice-kit 核对引擎与入口包版本是否配套（`lib/index.js` 里 `wasm: "0.1.1"` 之类的钉版）。
4. **体检**：`node <ENGINE_DIR>\node_modules\@deepseek-ai\libreoffice-kit\lib\cli.js --help`（或 `--version`）能打印用法即引擎可用；报 `Cannot find module .../libreoffice-kit-win32-x64` = 原生包没装上，重跑第 3 步并检查 `npm config get os/arch`。
5. **真跑一次转换**：造一个最小 docx（或让用户给一份）→
   `node <cli.js> convert <输入> <输出.pdf>`（具体子命令以 `--help` 为准）→ 产物存在且体积 > 0 才算装好。**只跑 `--help` 不算验证**：引擎加载失败往往要到真转换才暴露。
6. **接回网关**：`dsh/gateway/cordis.yml` 的 `skill-office` 行（若被摘除则加回来）：
   ```yaml
   - id: skill-office
     name: '@deepseek-ai/dsh-skill-office'
     config:
       assetRoot: !!js "dshHomePath('office-skills')"   # 或引擎包自带的 assets/
       node: <真 Node 绝对路径>
       cli: <ENGINE_DIR>\node_modules\@deepseek-ai\libreoffice-kit\lib\cli.js
   ```
   并确认 `@deepseek-ai/dsh-skill-office` 已回到网关 `node_modules`（它就是本 skill 第 3 步装的同一个 scope 下、需要单独安装的入口）。
7. **收尾回报**：装了什么版本、`ENGINE_DIR` 绝对路径、真跑那次转换的输入 / 输出（附输出文件路径与字节数）、是否删了 wasm 包。

## 自我修复

| 现象 | 先查 | 处理 |
| --- | --- | --- |
| `Cannot find module '@deepseek-ai/libreoffice-kit-win32-x64'` | 平台包目录在不在 | 重跑 `npm install`；确认 `npm config get os` = win32、`arch` = x64 |
| 转换报 `unavailable` / 引擎起不来 | `bin/libreoffice-kit.exe` 能否独立执行 | 杀软可能拦了 170MB 的 exe；加白名单后重装 |
| 报 `input-too-large` / `timeout` | 输入文档大小、超时档 | 换小文件复现；大文件提高超时，不要改引擎 |
| 报 `unsupported-format` | 输入后缀 | 只支持 Office 系（docx/xlsx/pptx 等），PDF 不需要转换 |
| 网关启动即 `ERR_MODULE_NOT_FOUND: @deepseek-ai/dsh-skill-office` | cordis.yml 加了 skill-office 行但包不在 | 要么把包装回网关 `node_modules`，要么先注释掉该行（宁可不挂，也不要让网关起不来） |
| 装了但仍说未安装 | 第 6 步的 `cli` 指到哪 | `cli` 必须是 `ENGINE_DIR` 下的绝对路径；`node` 必须是真 Node（≥22.19），不是 Electron |

## 纪律

- **数据不落应用目录**：`ENGINE_DIR` 只能在 `%APPDATA%\pipeline-console\` 下（或用户明确指定的其它目录），不得写进安装目录 / exe 同目录。
- **不动安装包里的东西**：本 skill 装的是**用户数据目录**；不要去改 `resources/dsh/gateway/node_modules`（升级会被覆盖，且可能没写权限）。
- **删 wasm 是可选**：删掉 `libreoffice-kit-wasm` 省 145MB，Windows 上安全（原生引擎优先）；不确定就留着。
