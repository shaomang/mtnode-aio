"use strict";
const fs = require("fs"), path = require("path"), vm = require("vm");
const ROOT = path.join(__dirname);
const LTV = fs.readFileSync(path.join(ROOT, "renderer/app-longtask.js"), "utf8");
const sandbox = {
  window: { api: {} },
  S: { wf: null, config: {} },
  I18n: { t: (s) => s },
  toast() {},
  scheduleSave() {},
  persistWf(wf) {},
  currentVisibleWf() { return null; },
  renderCanvas() {},
  focusNode() {},
  addNode() { return null; },
  console, setTimeout, clearTimeout, Map, Set, Promise, JSON, Math, Date, Object, Array, String, Number, RegExp,
};
vm.createContext(sandbox);
vm.runInContext(LTV, sandbox, { filename: "renderer/app-longtask.js" });
const LT = sandbox.window.LT;
const wf = { id: "wf1", name: "画布一" };
const G1 = {
  nodes: [
    { id: "s", kind: "start", title: "起点" },
    { id: "a", kind: "agent", title: "起草", cfg: { goal: "写一版稿子", outKeys: ["draft"] } },
    { id: "e", kind: "end_ok", title: "收工" },
  ],
  edges: [{ from: "s", to: "a" }, { from: "a", to: "e" }],
};
let r = LT.updateFromGraph(wf, "", G1, "");
console.log("update no task:", JSON.stringify(r));
const created = LT.createFromGraph("审稿流水线", G1, wf);
console.log("create:", JSON.stringify(created, null, 1).slice(0, 2000));
