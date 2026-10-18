"use strict";
/* 「保存不许夺焦」回归 —— 纯 Node，只读源码 + vm 跑判据（不依赖 Electron）
 *   node test/smoke-edit-focus.js
 *
 * 要保住的行为（用户需求原文）：**编辑框，任何保存都不要造成 defocus 导致无法继续输入**。
 * 四个 Markdown 编辑面共用一份实现（renderer/app-mdedit.js 的 MTMdEdit）：
 *   ① 文本节点 ✎ 编辑器（富文本档 .rv-rich / 源码档 .rv-src）
 *   ② ✎ AI 审阅窗（.rv-rich / .rv-src）
 *   ③ 内置 Markdown 阅读器编辑态（#mdViewerRich / #mdViewerEditor）
 *   ④ 画布节点板身正文框（#stage textarea.n-text）
 * 落盘路径：停笔自动保存 / Ctrl+S / 关窗与切档收尾 / AI 修订落地 / 板身⇄编辑器同步。
 *
 * 覆盖：
 *   [1] 出口与面登记表就位（surfaceKey / captureEditFocus / restoreEditFocus / keepEditFocus）
 *   [2] surfaceKey 只认这四个面（普通控件 / body 一律不算）
 *   [3] keepEditFocus：保存把 DOM 换掉 → 焦点、光标（selectionStart/End）与滚动原位还原
 *   [4] keepEditFocus：fn 抛错也还原，异常原样抛出（保存失败不许把光标吞了）
 *   [5] 焦点已被用户换到另一个编辑面 → 不抢回来
 *   [6] 编辑面真的没了 → 不抢焦点（宁可正常失焦，也不替用户乱放光标）
 *   [7] contenteditable 的文本偏移往返（跨元素 / 跨文本节点）
 *   [8] 画布闸：renderCanvas 认 Markdown 编辑面、推迟的那一拍不清账、不回填舞台焦点
 *   [9] 文本节点 ✎：落盘口不直接重绘画布（改走 teRepaintAfterSave）、整段包在 teKeepFocus、
 *       序列化前挪块（teLiftBlocksOutOfP）前后有光标快照、关窗交还焦点并补拍
 *   [10] 阅读器：保存收尾（广播 mtnode:file-saved）包在 keepEditFocus 里
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

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
const read = (rel) =>
  fs
    .readFileSync(path.join(__dirname, "..", rel.split("/").join(path.sep)), "utf8")
    .replace(/\r\n/g, "\n");

const mdedit = read("renderer/app-mdedit.js");
const canvasJs = read("renderer/app-canvas.js");
const textedit = read("renderer/app-textedit.js");
const app = read("renderer/app.js");

/* 取任意缩进的 function 声明（整段，含函数名）；找不到就 throw（判据缺失 = 失败） */
function fnSrc(src, name) {
  const m = src.match(new RegExp("(^|\\n)[ \\t]*(?:async[ \\t]+)?function " + name + "\\s*\\(", "m"));
  if (!m) throw new Error("找不到函数：" + name);
  const at = src.indexOf("{", m.index);
  let depth = 0;
  let inStr = null;
  for (let j = at; j < src.length; j++) {
    const c = src[j];
    if (inStr) {
      if (c === "\\") j++;
      else if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") inStr = c;
    else if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (!depth) return src.slice(m.index, j + 1);
    }
  }
  throw new Error("函数体没闭合：" + name);
}
function fnBody(src, name) {
  return fnSrc(src, name);
}
/* 出现次数（判「没有裸调用」时用） */
function count(src, needle) {
  return src.split(needle).length - 1;
}

/* ---------- 假 DOM：只够跑「焦点保管」那几个函数 ---------- */
function makeSandbox() {
  const sb = { console: { log() {} } };
  const doc = {
    activeElement: null,
    _els: [],
    querySelectorAll(sel) {
      return doc._els.filter((e) => e._sels.indexOf(sel) >= 0 && e.isConnected !== false);
    },
    createRange() {
      return {
        start: null,
        setStart(n, o) {
          this.start = { node: n, offset: o };
        },
        setEnd(n, o) {
          this.end = { node: n, offset: o };
        },
      };
    },
  };
  const sel = {
    _range: null,
    rangeCount: 1,
    getRangeAt() {
      return sel._range;
    },
    removeAllRanges() {
      sel._range = null;
    },
    addRange(r) {
      sel._range = r;
    },
  };
  sb.document = doc;
  sb.window = { getSelection: () => sel };
  sb.globalThis = sb;
  return sb;
}
function makeEl(sb, selList, opts) {
  const el = Object.assign(
    {
      nodeType: 1,
      isConnected: true,
      isContentEditable: false,
      scrollTop: 0,
      scrollLeft: 0,
      _sels: [].concat(selList || []),
      _focusCount: 0,
      matches(s) {
        return this._sels.indexOf(s) >= 0;
      },
      closest() {
        return null;
      },
      getClientRects() {
        return [{ width: 10, height: 10 }];
      },
      focus() {
        this._focusCount++;
        sb.document.activeElement = this;
      },
      setSelectionRange(a, b) {
        this.selectionStart = a;
        this.selectionEnd = b;
      },
    },
    opts || {},
  );
  sb.document._els.push(el);
  return el;
}
/* 把「焦点保管」那几个函数搬进沙箱跑（依赖只有一个假 document / window） */
const FNS = [
  "surfaceKey",
  "surfaceNodeId",
  "surfaceVisible",
  "findSurface",
  "isAtomEl",
  "isBlockEl",
  "nodeOffsetLen",
  "idxInParent",
  "richTextOffset",
  "richNodeAtOffset",
  "textareaCaretSame",
  "richCaretSame",
  "captureEditFocus",
  "restoreEditFocus",
  "keepEditFocus",
];
function loadFocusApi(sb) {
  const surfIdx = mdedit.indexOf("const SURFACES = [");
  if (surfIdx < 0) throw new Error("找不到 SURFACES 登记表");
  const surfEnd = mdedit.indexOf("];", surfIdx);
  const surfSrc = mdedit.slice(surfIdx, surfEnd + 2);
  /* 偏移尺子的两个标签常量（函数体里引用它们，沙箱要一并带上） */
  const constSrc = (name) => {
    const m = mdedit.match(new RegExp("(^|\\n)[ \\t]*const " + name + "\\s*="));
    if (!m) throw new Error("找不到常量：" + name);
    const end = mdedit.indexOf(";", m.index);
    return mdedit.slice(m.index, end + 1);
  };
  const src =
    surfSrc +
    "\n" +
    constSrc("ATOM_TAG") +
    "\n" +
    constSrc("BLOCK_TAG") +
    "\n" +
    FNS.map((n) => fnSrc(mdedit, n)).join("\n") +
    "\n";
  vm.createContext(sb);
  vm.runInContext(
    src +
      "\n;globalThis.__fx = { surfaceKey, captureEditFocus, restoreEditFocus, keepEditFocus, richTextOffset, richNodeAtOffset, SURFACES };",
    sb,
  );
  return sb.__fx;
}

console.log("\n[1] 出口与编辑面登记表");
{
  ok(/\bapi\b/.test(mdedit) && mdedit.indexOf("surfaceKey,") > 0, "MTMdEdit 暴露 surfaceKey");
  ok(mdedit.indexOf("captureEditFocus,") > 0, "MTMdEdit 暴露 captureEditFocus");
  ok(mdedit.indexOf("restoreEditFocus,") > 0, "MTMdEdit 暴露 restoreEditFocus");
  ok(mdedit.indexOf("keepEditFocus,") > 0, "MTMdEdit 暴露 keepEditFocus");
  const surf = mdedit.slice(mdedit.indexOf("const SURFACES = ["), mdedit.indexOf("];", mdedit.indexOf("const SURFACES = [")));
  [".rv-rich", ".rv-src", "#mdViewerRich", "#mdViewerEditor", "#stage textarea.n-text", "#textEditDlg", "#reviewDlg", "#mdViewerDlg"]
    .forEach((needle) => ok(surf.indexOf(needle) >= 0, "登记表覆盖 " + needle));
  ok((surf.match(/key: "/g) || []).length === 7, "登记表恰好 7 个编辑面（四个面的富文本 / 源码两档 + 板身）");
}

console.log("\n[2] surfaceKey 只认这四个面");
{
  const sb = makeSandbox();
  const fx = loadFocusApi(sb);
  const rich = makeEl(sb, ["#textEditDlg .rv-rich"]);
  const src = makeEl(sb, ["#textEditDlg .rv-src"]);
  const rvRich = makeEl(sb, ["#reviewDlg .rv-rich"]);
  const mdRich = makeEl(sb, ["#mdViewerDlg #mdViewerRich"]);
  const mdSrc = makeEl(sb, ["#mdViewerDlg #mdViewerEditor"]);
  const board = makeEl(sb, ["#stage textarea.n-text"]);
  const plain = makeEl(sb, ["input.x"]);
  ok(fx.surfaceKey(rich) === "te-rich", "✎ 富文本档 → te-rich");
  ok(fx.surfaceKey(src) === "te-src", "✎ 源码档 → te-src");
  ok(fx.surfaceKey(rvRich) === "rv-rich", "审阅窗富文本档 → rv-rich");
  ok(fx.surfaceKey(mdRich) === "mdv-rich", "阅读器富文本档 → mdv-rich");
  ok(fx.surfaceKey(mdSrc) === "mdv-src", "阅读器源码档 → mdv-src");
  ok(fx.surfaceKey(board) === "node-body", "板身正文框 → node-body");
  ok(fx.surfaceKey(plain) === "", "普通输入框不算编辑面");
  ok(fx.surfaceKey(null) === "" && fx.surfaceKey({ nodeType: 3 }) === "", "空 / 文本节点不算编辑面");
}

console.log("\n[3] keepEditFocus：保存换掉 DOM 也要把焦点与光标放回原位");
{
  const sb = makeSandbox();
  const fx = loadFocusApi(sb);
  const ta = makeEl(sb, ["#mdViewerDlg #mdViewerEditor"], { selectionStart: 5, selectionEnd: 7, scrollTop: 40 });
  sb.document.activeElement = ta;
  const box = makeEl(sb, []);
  const fresh = makeEl(sb, ["#mdViewerDlg #mdViewerEditor"], { selectionStart: 0, selectionEnd: 0 });
  const out = fx.keepEditFocus(() => {
    /* 模拟「保存顺手把编辑区重建了一遍」：老元素下线，新元素顶上并把焦点吞进窗体 */
    ta.isConnected = false;
    sb.document.activeElement = box;
    return "saved";
  });
  ok(out === "saved", "keepEditFocus 原样返回 fn 的结果");
  ok(sb.document.activeElement === fresh, "焦点落到重建后的同一个编辑面（同 key 找回）");
  ok(fresh.selectionStart === 5 && fresh.selectionEnd === 7, "光标 / 选区按原偏移还原（5..7）");
  ok(fresh.scrollTop === 40, "滚动位置还原（40）");
  ok(box._focusCount === 0, "没把焦点留在窗体 / 菜单壳上");
}

console.log("\n[4] keepEditFocus：保存失败（fn 抛错）也把光标放回去");
{
  const sb = makeSandbox();
  const fx = loadFocusApi(sb);
  const ta = makeEl(sb, ["#textEditDlg .rv-src"], { selectionStart: 3, selectionEnd: 3, scrollTop: 12 });
  sb.document.activeElement = ta;
  const fresh = makeEl(sb, ["#textEditDlg .rv-src"]);
  let threw = null;
  try {
    fx.keepEditFocus(() => {
      ta.isConnected = false; /* 落盘抛错那一拍顺手重建了编辑区 */
      sb.document.activeElement = makeEl(sb, []);
      throw new Error("写盘失败");
    });
  } catch (e) {
    threw = e;
  }
  ok(threw && /写盘失败/.test(threw.message), "fn 抛错原样抛出（调用方照旧能 toast）");
  ok(sb.document.activeElement === fresh, "抛错这一拍也把焦点放回编辑面");
  ok(fresh.selectionStart === 3, "抛错这一拍光标同样还原");
}

console.log("\n[5] 用户自己换了台 → 不抢焦点");
{
  const sb = makeSandbox();
  const fx = loadFocusApi(sb);
  const rich = makeEl(sb, ["#textEditDlg .rv-rich"]);
  sb.document.activeElement = rich;
  const other = makeEl(sb, ["#mdViewerDlg #mdViewerEditor"], { selectionStart: 1, selectionEnd: 1 });
  fx.keepEditFocus(() => {
    sb.document.activeElement = other;
  });
  ok(sb.document.activeElement === other, "焦点留在用户点过去的那一个编辑面");
  ok(rich._focusCount === 0, "没有把焦点抢回来");
}

console.log("\n[6] 编辑面真没了 → 不替用户乱放光标");
{
  const sb = makeSandbox();
  const fx = loadFocusApi(sb);
  const board = makeEl(sb, ["#stage textarea.n-text"]);
  sb.document.activeElement = board;
  const btn = makeEl(sb, ["button.x"]);
  fx.keepEditFocus(() => {
    board.isConnected = false; /* 节点被删了：同 key 的替代元素也不复存在 */
    sb.document.activeElement = btn;
  });
  ok(sb.document.activeElement === btn, "找不到同一个面就正常失焦（焦点还在按钮上）");
}

console.log("\n[7] contenteditable 文本偏移往返（块 / <br> 都占位）");
{
  const sb = makeSandbox();
  const fx = loadFocusApi(sb);
  const mkText = (v) => ({ nodeType: 3, nodeValue: v, childNodes: [] });
  /* 假元素要带上 parentNode / previousSibling：块与 <br> 的落点按父节点下标算 */
  const mkEl8 = (kids, tag) => {
    const el = {
      nodeType: 1,
      tagName: tag || "SPAN",
      childNodes: kids,
      textContent: kids.map((k) => k.nodeValue || "").join(""),
    };
    kids.forEach((k, i) => {
      k.parentNode = el;
      k.previousSibling = i ? kids[i - 1] : null;
    });
    return el;
  };
  const t1 = mkText("abc");
  const t2 = mkText("defgh");
  const p1 = mkEl8([t1], "P");
  const p2 = mkEl8([t2], "P");
  const root = mkEl8([p1, p2], "DIV");
  /* 块尾各占一位（p1 的 3 字 + 1 位块尾），所以第二段第 2 字 = 6 而不是 5。
     早先不计块尾 / <br>：回车后的新行开头与上一行末尾算出同一个偏移，
     按偏移还原只能落回上一行 —— 用户报的「回车光标不往下走」。 */
  ok(fx.richTextOffset(root, t2, 2) === 6, "偏移把块尾算进去（第二段第 2 字 = 6）");
  const hit = fx.richNodeAtOffset(root, 6);
  ok(hit && hit.node === t2 && hit.offset === 2, "偏移反查回到同一节点同一处");
  const hit0 = fx.richNodeAtOffset(root, 0);
  ok(hit0 && hit0.node === t1 && hit0.offset === 0, "偏移 0 落在第一段开头");
  /* 回车在段内插 <br>：落点在 <br> 之后（父里的下一个位置），不能与「上一行末尾」重合 */
  const a = mkText("ab");
  const br = mkEl8([], "BR");
  const b = mkText("cd");
  const p3 = mkEl8([a, br, b], "P");
  const root2 = mkEl8([p3], "DIV");
  const atEndOfFirst = fx.richTextOffset(root2, p3, 1); /* 光标在 <br> 之前 */
  const afterBreak = fx.richTextOffset(root2, p3, 2); /* 光标在 <br> 之后 */
  ok(afterBreak === atEndOfFirst + 1, "<br> 占一位：换行前后的落点不再算成同一个偏移");
  const back = fx.richNodeAtOffset(root2, afterBreak);
  ok(back && back.node === p3 && back.offset === 2, "换行后的偏移反查落在 <br> 之后（父里第 3 个位置）");
}

console.log("\n[8] 画布闸：认 Markdown 编辑面");
{
  ok(/function markdownEditSurfaceFocused\s*\(/.test(canvasJs), "app-canvas.js 有 markdownEditSurfaceFocused");
  ok(
    fnBody(canvasJs, "markdownEditSurfaceFocused").indexOf("MTMdEdit.surfaceKey") > 0,
    "它只认 MTMdEdit.surfaceKey（判据单一真源，不另抄一份选择器）",
  );
  const rc = fnBody(canvasJs, "renderCanvas");
  ok(rc.indexOf("markdownEditSurfaceFocused()") > 0, "renderCanvas 的推迟闸把 Markdown 编辑面算进去");
  ok(
    /canvasFieldFocused\(\)\s*\|\|\s*markdownEditSurfaceFocused\(\)/.test(rc),
    "闸门条件是「舞台可写字段 或 Markdown 编辑面」（同一个推迟出口）",
  );
  ok(/S\._deferCanvasForFieldEdit = true;/.test(rc), "推迟时记账（_deferCanvasForFieldEdit）");
  const flush = fnBody(canvasJs, "flushDeferredCanvasFocus");
  ok(
    flush.indexOf("markdownEditSurfaceFocused()") > 0 && /if \(markdownEditSurfaceFocused\(\)\) return;/.test(flush),
    "flushDeferredCanvasFocus：编辑面还在打字就继续记账（不清账、不画）",
  );
  ok(
    /S\._deferCanvasForFieldEdit = false;[\s\S]*try \{\s*renderCanvas\(\);\s*\} finally \{\s*S\._resumeCanvasFocus = false;/.test(flush),
    "补拍时放行旗用 try/finally 复位（不会把闸门永久打开）",
  );
  ok(
    /fieldFocus && !markdownEditSurfaceFocused\(\)\)?/.test(rc) &&
      /if \(fieldFocus && !markdownEditSurfaceFocused\(\)\) restoreCanvasFieldFocus/.test(rc),
    "重建后不回填舞台焦点（正在编辑框里打字时不许把光标挪回画布）",
  );
}

console.log("\n[9] 文本节点 ✎ 的落盘口");
{
  const save = fnBody(textedit, "teSaveToNode");
  ok(save.indexOf("renderCanvas()") < 0, "teSaveToNode 里没有裸 renderCanvas()（保存那一下不直接重绘）");
  ok(save.indexOf("teRepaintAfterSave()") > 0, "改用 teRepaintAfterSave（编辑中推迟、停手后补拍）");
  ok(/return teKeepFocus\(\(\) => \{/.test(save), "整个落盘动作包在 teKeepFocus 里（焦点 / 光标 / 滚动原样放回）");
  const repaint = fnBody(textedit, "teRepaintAfterSave");
  ok(repaint.indexOf("surfaceKey(document.activeElement)") > 0, "teRepaintAfterSave 按 surfaceKey 判「正在编辑」");
  ok(repaint.indexOf("S._deferCanvasForFieldEdit = true") > 0, "编辑中就记账推迟，不画");
  ok(repaint.indexOf("renderCanvas();") > 0, "没人在编辑面里就照旧即时画（别处看不出差别）");
  const commit = fnBody(textedit, "teCommit");
  const lift = commit.indexOf("teLiftBlocksOutOfP(ed)");
  ok(lift > 0, "teCommit 序列化前仍先挪块（teLiftBlocksOutOfP）");
  ok(commit.indexOf("teKeepFocusSnapshot(ed)") > 0 && commit.indexOf("teKeepFocusSnapshot(ed)") < lift, "挪块前先拍光标快照");
  ok(commit.indexOf("teRestoreFocusSnapshot(keep)") > lift, "挪块后立刻把光标放回去");
  const close = fnBody(textedit, "teClose");
  ok(/ae\.blur\(\)/.test(close), "关窗把窗里的焦点交出去（编辑面不再拦着补拍）");
  ok(close.indexOf("renderCanvas()") > 0, "关窗照旧重绘一次");
  ok(close.indexOf("flushDeferredCanvasFocus()") > 0, "关窗把之前挂着的推迟账清掉");
}

console.log("\n[10] 阅读器落盘收尾");
{
  const mc = fnBody(app, "mdViewerCommit");
  ok(mc.indexOf("keepFocus(") > 0, "收尾包在 keepFocus 里");
  const at = mc.indexOf("keepFocus(() =>");
  const tail = mc.slice(at);
  ok(tail.indexOf("mtnode:file-saved") > 0, "广播（会连带刷画布节点）在 keepFocus 内");
  ok(tail.indexOf("mdViewerSetSaveState(\"ok\")") > 0, "保存状态回写也在 keepFocus 内");
  ok(/typeof MTMdEdit !== "undefined"/.test(mc), "MTMdEdit 缺失时是直通（不会把保存搞崩）");
}

console.log(
  "\n" +
    (fails ? "FAIL " : "PASS ") +
    checks +
    " 项断言，失败 " +
    fails +
    " 项\n",
);
process.exit(fails ? 1 : 0);
