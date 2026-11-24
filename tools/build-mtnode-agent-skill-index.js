#!/usr/bin/env node
"use strict";

const path = require("path");
const lib = require("../mtnode-agent-skills-lib.js");
const {
  bundledRoot,
  buildIndexFromTree,
  writeIndexArtifacts,
  flattenIndex,
} = lib;

/* 应用（窗口插件）开发类目 `app/` 的中文标题只在本脚本钉一次：
   mtnode-agent-skills-lib.js 的 CATEGORY_TITLES 是运行期共用的兜底表，
   发版脚本（tools/*）需要新类目名时在这里补齐，再跑本脚本重生成 index.json / INDEX.md。 */
lib.CATEGORY_TITLES.app = "应用开发";

const root = bundledRoot(path.join(__dirname, ".."));
const index = buildIndexFromTree(root);
/* devMode: true —— 仓库里这份 INDEX.md 是**文档源**，永远列全（含 dev-only 的开发纪律技能）。
   运行期装到 dsh-home 的那份才按开发态过滤，见 mtnode-agent-skills-lib.js 的 devSkillMode。 */
writeIndexArtifacts(root, index, { devMode: true });
const n = flattenIndex(index).length;
console.log("[build-mtnode-agent-skill-index] wrote index.json + INDEX.md (" + n + " skills)");
