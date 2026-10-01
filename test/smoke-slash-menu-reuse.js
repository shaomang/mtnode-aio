"use strict";
/* test/smoke-slash-menu-reuse.js — 斜杠候选菜单「候选没变就不重建 DOM」的行为口径
 *   node test/smoke-slash-menu-reuse.js
 *
 * 为什么要有它（本轮用户报障：「会话 / 应用开发对话窗输入文字略显卡顿」）：
 *   会话 / 助手输入框每敲一个字都会走一遍 input 处理链，其中斜杠候选（技能与命令）
 *   每次都把菜单「清空 + 逐条建按钮 + 量宽定位」。候选在两键之间往往一模一样
 *   （「/」后面继续打、命中的还是同一批技能），这种重复重建纯属白做。
 *   修法 = showSlashMenu 按「作用域 + 每条 name/标题」记签名，签名一致就只重定位
 *   （见 renderer/app.js 的 showSlashMenu / positionSlashMenu）。
 *
 * 本测试把**真在跑的那几只函数原文**抠进 Electron 页面执行（不抄副本、不另写一份实现），
 * 逐项钉住：
 *   [1] 首次展示照旧真建列表：条数、键面文案、显形（slash-menu + display:block）、sel=0
 *   [2] 候选不变 → 复用同一只列表与同一批按钮节点（一个 DOM 节点都不重建）
 *   [3] 候选变了（条数/内容）→ 真的重建；新一轮候选 sel 归零（与旧行为一致）
 *   [4] 宿主被 @ 引用菜单占用时**不许**把别人的按钮当技能条目用（身份 + 末位双判据）
 *   [5] 回车选中仍把技能名写回正文、菜单收起（交互链一字未改）
 *   [6] 源码契约：重建只发生在一条路径上（菜单宿主每次重建只有一处 innerHTML 清空）
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const rel = (...p) => path.join(ROOT, ...p);

if (!process.versions.electron) {
  const { spawn } = require("child_process");
  const bin = require("electron");
  const env = Object.assign({}, process.env);
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(String(bin), [__filename], { stdio: "inherit", env });
  child.on("exit", (c, s) => process.exit(s ? 1 : c == null ? 1 : c));
} else {
  main().catch((e) => {
    console.error("[smoke-slash-menu-reuse] 失败：", (e && e.stack) || e);
    try {
      require("electron").app.exit(1);
    } catch (_) {}
  });
}

/* 从产品代码里抠函数原文：改名 / 删函数即抛错，断言跟着变红 */
function grabFn(src, name) {
  const re = new RegExp("^(?:async\\s+)?function\\s+" + name + "\\s*\\(", "m");
  const m = re.exec(src);
  if (!m) throw new Error("renderer/app.js 里找不到函数 " + name + "（改名了？断言要跟着改）");
  let i = m.index + m[0].length;
  while (i < src.length && src[i] !== "{") i++;
  if (i >= src.length) throw new Error("函数 " + name + " 找不到函数体起始 {");
  let d = 0;
  for (; i < src.length; i++) {
    if (src[i] === "{") d++;
    else if (src[i] === "}") {
      d--;
      if (!d) return src.slice(m.index, i + 1);
    }
  }
  throw new Error("函数 " + name + " 的收尾 } 没找到（括号不配对？）");
}

const FN_NAMES = [
  "slashToken",
  "slashItemMatch",
  "loadSkillsCached",
  "showSlashMenu",
  "positionSlashMenu",
  "paintSlashSel",
  "selectSlashItem",
  "closeSlashMenu",
];

let fails = 0;
let checks = 0;
function ok(cond, msg) {
  checks++;
  if (cond) console.log("  ok    " + msg);
  else {
    fails++;
    console.log("FAIL  " + msg);
  }
}

const PROBE = `(async function () {
  var S = { slashMenu: null };
  var I18n = { t: function (s) { return s; } };
  var document = window.document;
  var _skillListCache = { at: Date.now(), skills: [] };
  function $(s) { return document.querySelector(s); }
  function closeRefMenu() {}
  function caretXY(ta) { var r = ta.getBoundingClientRect(); return { x: r.left + 8, y: r.top + 20 }; }
  __CODE__
  var menu = document.getElementById('refMenu');
  var ta = document.createElement('textarea');
  ta.className = 'chat-input';
  document.body.appendChild(ta);
  var ITEMS = [
    { name: 'generate-workflow', title: '生成工作流', hint: 'h1' },
    { name: 'generate-task', title: '生成任务', hint: 'h2' },
    { name: 'impeccable', title: '前端设计规范', hint: 'h3' }
  ];
  function show(v, items) {
    ta.value = v;
    ta.setSelectionRange(v.length, v.length);
    return Promise.resolve(showSlashMenu(ta, items, 'agent'));
  }
  var res = {};
  while (menu.firstChild) menu.removeChild(menu.firstChild);
  await show('/gen', ITEMS);
  var listA = menu._slashList;
  var btnsA = menu.querySelectorAll('.slash-item');
  res.firstCount = btnsA.length;
  res.firstText = btnsA[0] && btnsA[0].textContent;
  res.selAfterFirst = S.slashMenu && S.slashMenu.sel;
  res.menuClass = menu.classList.contains('slash-menu');
  res.menuDisplay = menu.style.display;
  res.emptyHintShown = menu.textContent.indexOf('暂无匹配的命令或技能') >= 0;

  await show('/gene', ITEMS);
  res.reusedList = menu._slashList === listA;
  res.reusedNodes = menu.querySelectorAll('.slash-item')[0] === btnsA[0];
  res.countStable = menu.querySelectorAll('.slash-item').length === 3;

  await show('/gene', ITEMS.slice(0, 1));
  res.rebuiltList = menu._slashList !== listA;
  res.rebuiltCount = menu.querySelectorAll('.slash-item').length;
  var listB = menu._slashList;

  S.slashMenu.sel = 1;
  await show('/gene', ITEMS.slice(0, 1));
  res.selReset = S.slashMenu && S.slashMenu.sel;
  res.reusedAfterSel = menu._slashList === listB;

  /* 清空候选（没匹配）也走同一条签名路：空态提示照旧出现 */
  await show('/zzz', []);
  res.emptyCount = menu.querySelectorAll('.slash-item').length;
  res.emptyText = menu.textContent;
  var listEmpty = menu._slashList;
  await show('/zzz2', []);
  res.emptyReused = menu._slashList === listEmpty;

  /* 宿主被 @ 引用菜单占用：往同一只宿主里追加别人的列表 → 斜杠不许复用别人的按钮 */
  var alien = document.createElement('div');
  alien.className = 'ref-list';
  var alienBtn = document.createElement('button');
  alienBtn.className = 'ref-item';
  alienBtn.textContent = '@某个节点';
  alien.appendChild(alienBtn);
  menu.appendChild(alien);
  await show('/zzz2', []);
  res.noAlienReuse = menu._slashList !== listEmpty && menu._slashList !== alien;
  res.slashLastChild = menu.lastElementChild === menu._slashList;

  /* 交互链：回车选中仍按 token 替换正文并收起菜单 */
  while (menu.firstChild) menu.removeChild(menu.firstChild);
  await show('/gen', ITEMS);
  selectSlashItem(ITEMS[0]);
  res.inserted = ta.value;
  res.menuClosed = S.slashMenu === null;
  return res;
})()`;

function runProbe() {
  const { BrowserWindow } = require("electron");
  return (async () => {
    let html = fs.readFileSync(rel("renderer", "index.html"), "utf8");
    for (const m of [...html.matchAll(/<link[^>]+href="([^"]+\.css)"[^>]*>/g)]) {
      const p = rel("renderer", m[1].replace(/^\.\//, ""));
      if (fs.existsSync(p)) html = html.replace(m[0], "<style>" + fs.readFileSync(p, "utf8") + "</style>");
    }
    /* 探针页不跑任何应用逻辑（丢掉 <script>、无 window.api），只量菜单这一小块 */
    html = html.replace(/<script[^>]*src="[^"]+"[^>]*><\/script>/g, "");
    const tmp = path.join(os.tmpdir(), "mtnode-slash-menu-reuse.html");
    fs.writeFileSync(tmp, html, "utf8");
    const win = new BrowserWindow({
      show: false,
      width: 1200,
      height: 800,
      webPreferences: { offscreen: true, contextIsolation: false, nodeIntegration: false },
    });
    await win.loadFile(tmp);
    const src = fs.readFileSync(rel("renderer", "app.js"), "utf8");
    let code = "";
    for (const n of FN_NAMES) code += grabFn(src, n) + "\n";
    const out = await win.webContents.executeJavaScript(
      PROBE.replace("__CODE__", code.replace(/\\/g, "\\\\").replace(/\$/g, "$$$$")),
      true,
    );
    if (process.env.SLASH_MENU_REPORT) console.log(JSON.stringify(out, null, 2));
    try { fs.unlinkSync(tmp); } catch (_) {}
    return out;
  })();
}

async function main() {
  const { app } = require("electron");
  await app.whenReady();
  const src = fs.readFileSync(rel("renderer", "app.js"), "utf8");

  console.log("\n[1]-[5] 真跑：把 app.js 里的菜单实现抠进真实渲染引擎里走一遍");
  const r = await runProbe();
  ok(r.firstCount === 3, "首次展示建出 3 条候选（实得 " + r.firstCount + "）");
  ok(
    r.firstText === "生成工作流/generate-workflowh1",
    "键面 = 标题 + /技能名 + 说明（实得 " + JSON.stringify(r.firstText) + "）",
  );
  ok(r.selAfterFirst === 0, "首次展示 sel=0");
  ok(r.menuClass === true && r.menuDisplay === "block", "菜单显形（slash-menu + display:block）");
  ok(r.emptyHintShown === false, "有候选时不显示空态提示");

  ok(r.reusedList === true, "候选不变 → 复用同一只列表（不重建 DOM）");
  ok(r.reusedNodes === true, "候选不变 → 连按钮节点都没换（一个节点都不重建）");
  ok(r.countStable === true, "复用后条数仍对得上（3 条）");

  ok(r.rebuiltList === true, "候选变了 → 重建列表（列表身份变了）");
  ok(r.rebuiltCount === 1, "重建后条数 = 新候选的条数（实得 " + r.rebuiltCount + "）");
  ok(r.selReset === 0, "新一轮候选 sel 归零（与旧行为一致）");
  ok(r.reusedAfterSel === true, "归零之后仍然复用原列表");

  ok(r.emptyCount === 1 && /暂无匹配的命令或技能/.test(r.emptyText), "没匹配时照旧给空态提示");
  ok(r.emptyReused === true, "空态之间也复用（不反复重建空列表）");

  ok(r.noAlienReuse === true, "宿主被 @ 引用占用时不复用别人的按钮");
  ok(r.slashLastChild === true, "复用/重建后斜杠列表都是宿主最后一个子节点");

  ok(r.inserted === "/generate-workflow ", "回车选中仍把技能名写回正文（实得 " + JSON.stringify(r.inserted) + "）");
  ok(r.menuClosed === true, "选中后菜单收起");

  console.log("\n[6] 源码契约：候选没变就不重建 DOM 的口径写死在产品代码里");
  const fn = grabFn(src, "showSlashMenu");
  ok((fn.match(/innerHTML\s*=/g) || []).length === 1, "重建路径只有一处 innerHTML（清空）");
  ok(/menu\._slashSig === sig/.test(fn), "复用判据按签名（menu._slashSig === sig）");
  ok(/positionSlashMenu\(menu, caretXY\(ta\)\)/.test(fn), "复用与重建都走同一只定位函数");
  ok(/menu\.lastElementChild === prevList/.test(fn), "复用前核对列表身份与末位（宿主与 @ 引用共用）");
  ok(/function positionSlashMenu\(/.test(src), "定位逻辑独立成 positionSlashMenu（可单独复用）");
  const tick = grabFn(src, "slashTick");
  ok(
    /showSlashMenu\(ta, sk\.concat\(cmds\), scope, onChange\)/.test(tick),
    "slashTick 仍把候选原样交给 showSlashMenu（签名口径不外泄）",
  );

  console.log("\n" + (fails ? "FAILED " + fails + "/" + checks : "ALL OK " + checks));
  app.exit(fails ? 1 : 0);
}
