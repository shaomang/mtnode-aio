/* canvas-doc-diff —— 画布文档「改了哪里」的纯差量与就地应用（同一份代码，两处入口）
 * ============================================================================
 * 一句话：`diffDocs(before, after)` 算出画布文档的**差量**，`applyDocDiff(doc, diff)` 把差量
 * 就地合回一份文档 —— 合出来的结果必须与「把 after 整份贴上去」深相等（判据见
 * test/smoke-canvas-doc-parity.js 的 [5]）。
 *
 * 为什么要它（任务 6/8 · 编辑引擎进文档服务）：
 *   写路径搬到主进程之后，文档真源在服务侧，编辑由服务执行并落盘。渲染层不再拿整份文档，
 *   只拿「改了哪些」—— 否则每笔编辑都要过桥一次整张画布（大画布实测几 MB），铺开的正是
 *   这一步要省掉的那份拷贝。
 *
 * 两处入口（与 canvas-doc-core / canvas-doc-edit 同一口径）：
 *   · 浏览器：renderer/index.html 在 app-nodes.js 之前以 <script> 引入，挂 globalThis.MTCanvasDocDiff
 *   · Node（主进程 / 脚本）：require("canvas-doc/canvas-doc-diff.js") 拿同一份 api
 *
 * 差量形状（v1，只有这四个集合 + 顶层标量，文档里没有别的块）：
 *   {
 *     v: 1,
 *     keys:  { set: {名字: 值}, del: [名字] },          // 顶层标量（name / workspace / appId / view / cam …）
 *     nodes: { set: [条目], del: [id], order?: [id] },  // 四个集合同形
 *     wires: { … }, marks: { … }, groups: { … },
 *     <集合>.whole: [条目]                              // 兜底：集合里有「没有 id 的项」时整份替换
 *   }
 *   · set   = 新增或内容变了的条目（整条目，不是字段级补丁：条目本来就不大，字段级差量省不了多少，
 *             却要多一层「哪些字段被删了」的表达，错一次就是文档静默漂移）
 *   · del   = 消失的 id
 *   · order = 只在「id 序列变了」时出现（顺序本身是文档的一部分：渲染层按数组序画）
 *   · 缺省 = 这个集合没变（省字节，也让 applyDocDiff 什么都不做）
 *
 * 纪律：
 *   · 不碰 DOM、不读 S、不持有状态 —— 入参 → 返回值。
 *   · 应用差量**保对象身份**：变了的条目就地清键重写，没变的条目原对象不动，数组也原地重排。
 *     渲染层的设置窗 / 选中项 / 节点元素都抓着节点对象，换新对象等于让它们抓住孤儿。
 * ============================================================================
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.MTCanvasDocDiff = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  /** 文档里唯四的集合块（顺序也是 applyDocDiff 的处理顺序，与文档字段顺序无关） */
  const COLLECTIONS = ["nodes", "wires", "marks", "groups"];

  const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o || {}, k);
  const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  const idOf = (it) => (it && it.id != null && it.id !== "" ? String(it.id) : "");
  /* 值比较：文档里全是 JSON 可序列化的东西（renderer 落盘前也先 JSON.stringify），
     逐字节比就是最省事也最不会漏的口径。 */
  function jsonEq(a, b) {
    if (a === b) return true;
    if (a === undefined || b === undefined) return false;
    try {
      return JSON.stringify(a) === JSON.stringify(b);
    } catch (_) {
      return false;
    }
  }

  /* ── 一个集合的差量；没变返回 null ── */
  function diffList(before, after) {
    const b = Array.isArray(before) ? before : [];
    const a = Array.isArray(after) ? after : [];
    /* 没有 id 的项（理论上不存在）：不做逐条比对，整份替换 —— 宁可多传一次，不许漏一次 */
    const idless = b.some((it) => !idOf(it)) || a.some((it) => !idOf(it));
    if (idless) {
      if (jsonEq(b, a)) return null;
      return { whole: clone(a) };
    }
    const bById = new Map();
    for (const it of b) bById.set(idOf(it), it);
    const aIds = a.map(idOf);
    const bIds = b.map(idOf);
    const set = [];
    const seen = new Set();
    for (const it of a) {
      const id = idOf(it);
      seen.add(id);
      const old = bById.get(id);
      if (old === undefined || !jsonEq(old, it)) set.push(clone(it));
    }
    const del = bIds.filter((id) => !seen.has(id));
    const order = bIds.join("\u0000") === aIds.join("\u0000") ? null : aIds;
    if (!set.length && !del.length && !order) return null;
    const d = { set, del };
    if (order) d.order = order;
    return d;
  }

  /* ── 差量：before → after（两份都是画布文档） ── */
  function diffDocs(before, after) {
    const b = before || {};
    const a = after || {};
    const diff = { v: 1 };
    const keysSet = {};
    const keysDel = [];
    const all = new Set(Object.keys(b).concat(Object.keys(a)));
    for (const k of all) {
      if (COLLECTIONS.indexOf(k) >= 0) continue;
      if (!hasOwn(a, k)) {
        if (hasOwn(b, k)) keysDel.push(k);
        continue;
      }
      if (!hasOwn(b, k) || !jsonEq(b[k], a[k])) keysSet[k] = clone(a[k]);
    }
    if (keysDel.length || Object.keys(keysSet).length) diff.keys = { set: keysSet, del: keysDel };
    for (const name of COLLECTIONS) {
      const d = diffList(b[name], a[name]);
      if (d) diff[name] = d;
    }
    return diff;
  }

  /** 差量是不是「什么都没有改」（空笔 / 只回执不落盘的那种） */
  function diffIsEmpty(diff) {
    if (!diff) return true;
    if (diff.keys && (diff.keys.del || []).length) return false;
    if (diff.keys && Object.keys(diff.keys.set || {}).length) return false;
    for (const name of COLLECTIONS) {
      const d = diff[name];
      if (!d) continue;
      if (d.whole && d.whole.length) return false;
      if ((d.set || []).length || (d.del || []).length) return false;
      if (d.order && d.order.length) return false;
    }
    return true;
  }

  /* 就地改写一个条目：清键 → 按新条目自己的键序写回。
     为什么不是 Object.assign：assign 删不掉「新版本里已经没有的键」，也排不出新的键序；
     「清键再写」既保住对象身份（设置窗 / 选中项抓着的还是同一个对象），又让序列化结果
     与整份重放逐字节一致。 */
  function syncInPlace(target, incoming) {
    for (const k of Object.keys(target)) delete target[k];
    for (const k of Object.keys(incoming)) target[k] = clone(incoming[k]);
    return target;
  }

  /* ── 应用差量：就地合进 doc（返回同一个 doc） ──
     幂等性不在契约里（差量是「这一次变了什么」，贴两次没有意义），但贴一次的结果必须
     与「整份重放」深相等 —— 这是 [5] 的判据。 */
  function applyDocDiff(doc, diff) {
    if (!doc || !diff) return doc;
    if (diff.keys) {
      const set = diff.keys.set || {};
      for (const k of Object.keys(set)) doc[k] = clone(set[k]);
      for (const k of diff.keys.del || []) delete doc[k];
    }
    for (const name of COLLECTIONS) {
      const d = diff[name];
      if (!d) continue;
      if (!Array.isArray(doc[name])) doc[name] = [];
      const cur = doc[name];
      if (d.whole) {
        cur.length = 0;
        for (const it of d.whole) cur.push(clone(it));
        continue;
      }
      if ((d.del || []).length) {
        const gone = new Set((d.del || []).map(String));
        for (let i = cur.length - 1; i >= 0; i--) if (gone.has(idOf(cur[i]))) cur.splice(i, 1);
      }
      if ((d.set || []).length) {
        const at = new Map();
        cur.forEach((it, i) => at.set(idOf(it), i));
        for (const item of d.set) {
          const id = idOf(item);
          const i = at.get(id);
          if (i === undefined) {
            cur.push(clone(item));
            at.set(id, cur.length - 1);
          } else {
            syncInPlace(cur[i], item);
          }
        }
      }
      if (d.order && d.order.length) {
        const by = new Map();
        for (const it of cur) by.set(idOf(it), it);
        const next = [];
        for (const id of d.order) {
          const it = by.get(String(id));
          if (it === undefined) continue;
          next.push(it);
          by.delete(String(id));
        }
        /* 差量里没提到的条目：留着（顺序放在末尾）—— 宁可多留一颗，也不许因为差量不全丢节点 */
        for (const it of by.values()) next.push(it);
        cur.length = 0;
        for (const it of next) cur.push(it);
      }
    }
    return doc;
  }

  return { COLLECTIONS, diffDocs, applyDocDiff, diffIsEmpty };
});
