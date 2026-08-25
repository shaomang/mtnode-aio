---
name: mtnode-agent-rebuild
title: MTNode 改代码后重建
description: 修改 pipeline-console 中影响运行时的源码后，必须用 scripts/agent-rebuild.cmd 结束进程、编译并重启 MTNodeAIO。Use when editing main/preload/renderer/dsh/pet/music3/h3/plugins/*-pack or build.json and the user or task needs a verified runtime build.
---

# MTNode：改完必须重建并重启

对 **pipeline-console（MTNode）** 做完会影响运行时的代码改动后，在收尾前 **必须** 执行：

```bat
scripts\agent-rebuild.cmd
```

（工作目录：`pipeline-console`。该脚本会：结束 `MTNodeAIO.exe` / `electron.exe` → `node ..\build.js --dir` → 启动 `dist\win-unpacked\MTNodeAIO.exe`。）

## 何时必须跑

- 改了 `main.js` / `preload.js` / `updater.js` / `crash-report.js` / `build.json` / `package.json` / `version`
- 改了 `renderer/**`、`dsh/**`、`pet/**`、`music3/**`、`h3/**`、`plugins/**`、`*-pack/**`、`mtnode-agent-skills/**`
- 任何需要打包进 asar / extraResources 才能验证的改动

## 何时可跳过

- 仅改文档（`guides/**`、`*.md`）、仅改 `.cursor/**`
- 用户明确说「不要 compile / 不要重启」

## 约束

- **不要**只改源码就结束；开发态 `npm start` **不能**代替本次要求的 compile 验证
- compile 失败则修好后再跑一遍，直到成功启动
- 同一轮多文件修改：全部改完后 **跑一次**即可
