#!/usr/bin/env node
"use strict";

const path = require("path");
const {
  bundledRoot,
  buildIndexFromTree,
  writeIndexArtifacts,
  flattenIndex,
} = require("../mtnode-agent-skills-lib.js");

const root = bundledRoot(path.join(__dirname, ".."));
const index = buildIndexFromTree(root);
writeIndexArtifacts(root, index);
const n = flattenIndex(index).length;
console.log("[build-mtnode-agent-skill-index] wrote index.json + INDEX.md (" + n + " skills)");
