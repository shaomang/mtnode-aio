/* renderer/app-longtask-out.js —— 长周期任务「产出回流」（编辑感知 + 判不准就问用户）
 *
 * 需求：长任务执行中生成的信息 / 文件内容都已经同步写进画布上的「产出节点」（见
 * app-longtask.js 的 ltOutputPublish + kind ltout），用户随时可以查阅与修改；**后续环节
 * 必须吃用户改后的内容**，判不准时不许按记忆里的旧版往下猜 —— 先问用户再继续。
 *
 * 本文件只做三件事，不碰状态机口径、不建自己的存储：
 *   ① 读产出：把已登记的产出（节点正文 + 文件引用）整理成 prompt 里的一段
 *      （ltOutPromptSection，接在 app-longtask.js 的 ltAgentPrompt 【当前状态】之后）；
 *   ② 判是否被用户改过：逐条走 app-longtask.js 的登记层判据 ltOutputDirty / ltOutputRead，
 *      结论只有 edited / clean / unknown（ltOutScan）；
 *   ③ 判不准就问用户（ltOutGate → ltOutAsk）：把确认问题落成条带人工卡上的一个「问题条目」
 *      （复用既有 human/interrupt：run.waits 的 deliver 卡 + 系统建的交付节点），
 *      本次执行到此为止不再往下跑；用户在卡里作答并确认后走 ltOutResolveAsk 续跑，
 *      答案写进状态键（LT_OUT_ASK_KEY），后续环节读得到。
 *
 * 加载顺序：必须在 app-longtask.js 之后（用到它的 ltOutputRec / ltOutputDirty /
 * ltOutputRead / ltEnsureDeliverNode / ltPushWait / ltDropWait / ltStatePut / ltSave 等）。
 * 这些全局在沙箱 / 老运行时可能缺一个两个：所有外部调用都带 typeof 判空，缺料时降级成
 * 「不拦、只少一段 prompt」，绝不因为本模块把长任务跑挂。
 */
const LT_OUT_PROMPT_MAX = 4; /* 一段 prompt 最多带几个产出节点（多的留给画布自己看） */
const LT_OUT_ASK_KEY = "ltout_confirm"; /* 用户对「产出判不准」的答复落进这个状态键 */

/* ── 与引擎同源的兜底取值（外部全局缺了也不抛）────────────────────── */
function ltOutArr(v) {
  return typeof ltArr === "function" ? ltArr(v) : Array.isArray(v) ? v : [];
}
function ltOutNow() {
  return typeof ltNow === "function" ? ltNow() : Date.now();
}
function ltOutStr(v, max) {
  return typeof ltStr === "function" ? ltStr(v, max) : String(v == null ? "" : v).slice(0, max || 0);
}
function ltOutT(s) {
  return typeof ltT === "function" ? ltT(s) : String(s == null ? "" : s);
}
function ltOutValMax() {
  return typeof LT_VAL_MAX === "number" ? LT_VAL_MAX : 6000;
}
function ltOutRecOf(run, path) {
  if (typeof ltOutputRec === "function") return ltOutputRec(run, path);
  return (run && run.outputs && run.outputs[path]) || null;
}
/* 产出节点按**本 run 所属画布**找（本轮需求）：用户切去别的画布时，按 S.wf 找会把
   本环节的产出节点判成「被删了」（unknown），还可能拿别的画布上同 id 的节点当它。 */
function ltOutNodeOf(nodeId, run) {
  const wf = typeof ltRunCanvas === "function" ? ltRunCanvas(run) : null;
  if (typeof ltOutputNodeOf === "function") return ltOutputNodeOf(nodeId, wf || undefined);
  const w = wf || (typeof S !== "undefined" && S ? S.wf : null);
  if (!w) return null;
  const id = String(nodeId || "");
  return id ? ltOutArr(w.nodes).find((n) => n && String(n.id || "") === id) || null : null;
}
function ltOutHash(s) {
  if (typeof ltOutputHash === "function") return ltOutputHash(s);
  return "";
}
function ltOutTime(ms) {
  const n = Number(ms) || 0;
  if (!n) return "";
  try {
    return new Date(n).toLocaleString();
  } catch (_) {
    return String(n);
  }
}
/* 本环节的步骤状态槽（run.nodes[path]）。取不到就当作「没这条运行态」。 */
function ltOutStat(run, path) {
  return run && run.nodes ? run.nodes[String(path || "")] || null : null;
}

/* ── ① 相关产出：本环节「要用到」哪些产出节点 ────────────────────────
 * 自认 / 上游（祖先）优先，其余按登记时间倒序；**排除本环节的下游**（回跳场景下下游
 * 可能留着上一版的产出登记，但那不是我要用的输入）。 */
function ltOutRelevant(run, path) {
  if (!run || !run.outputs) return [];
  const self = String(path || "");
  const items = [];
  for (const k of Object.keys(run.outputs)) {
    const rec = run.outputs[k];
    if (!rec || !k) continue;
    if (self && k !== self && k.indexOf(self + "/") === 0) continue; /* 下游的产出不算输入 */
    items.push({ path: k, rec: rec });
  }
  const rank = (x) => (x.path === self ? 0 : self && self.indexOf(x.path + "/") === 0 ? 1 : 2);
  items.sort((a, b) => rank(a) - rank(b) || (Number(b.rec.at) || 0) - (Number(a.rec.at) || 0));
  return items;
}

/* ── ② prompt 段：【产出（以画布为准）】────────────────────────────
 * 同步函数（ltAgentPrompt 是同步的）：只读内存里的登记 + 画布节点正文，不碰文件系统；
 * 文件只给绝对路径（用户在应用外改过的文件由引擎落盘路径自己读，本段只指路）。 */
function ltOutPromptSection(run, path, opts) {
  const list = ltOutRelevant(run, path);
  if (!list.length) return "";
  const max = Math.max(1, Number((opts || {}).max) || LT_OUT_PROMPT_MAX);
  const L = [];
  L.push(
    ltOutT(
      "以下内容直接来自画布上的「产出节点」（用户可以随时查阅与修改）：与 lt_state 里的旧值、你的记忆、你上一轮的结论冲突时，一律以此为准，不要用旧版覆盖它。",
    ),
  );
  list.slice(0, max).forEach((x) => {
    const node = ltOutNodeOf(x.rec.nodeId, run);
    const title = (node && node.title) || String(x.rec.nodeId || "") || x.path;
    L.push("");
    L.push("### " + title + "（path " + x.path + "）");
    if (x.rec.edited)
      L.push(
        "⚠ " +
          ltOutT("用户已修改过这个产出节点") +
          (Number(x.rec.editAt) ? "（" + ltOutT("用户") + " · " + ltOutTime(x.rec.editAt) + "）" : "") +
          "：" +
          ltOutT("下面是用户改后的现内容。"),
      );
    if (!node) {
      L.push("⚠ " + ltOutT("画布上找不到这个产出节点（可能被用户删了）：正文读不到，先按下面的文件 / 状态键来，别猜。"));
    } else {
      const text = String(node.text == null ? "" : node.text);
      L.push(text.trim() ? ltOutStr(text, ltOutValMax()) : "（" + ltOutT("产出节点当前是空的") + "）");
    }
    const files = ltOutArr(x.rec.fileRefs);
    if (files.length) {
      L.push(ltOutT("关联文件（绝对路径，用户可能已在应用外改过，落盘前先读一遍）："));
      for (const f of files)
        L.push("- " + String((f && f.path) || "") + (f && f.size != null ? "（" + Number(f.size) + " " + ltOutT("字节") + "）" : ""));
    }
  });
  if (list.length > max)
    L.push("\n" + ltOutT("（还有 ") + (list.length - max) + ltOutT(" 个产出节点未列出：内容都在画布上，需要时去画布看。）"));
  return L.join("\n");
}

/* ── ③ 判定：读产出 → 有没有被用户改过 ─────────────────────────────
 * state：none（还没登记过产出）/ edited（确证被改）/ clean（全对得上）/ unknown（判不准）。
 * unknown = 缺料（节点被删 / 文件读不到 / 没基线），**绝不当成 clean**。 */
async function ltOutCheck(run, path) {
  const rec = ltOutRecOf(run, path);
  if (!rec)
    return { path: String(path || ""), state: "none", reason: "no-baseline", nodeId: "", missing: false, text: "", hash: "", files: [], at: 0, edited: false, editAt: 0 };
  let dirty = "unknown";
  try {
    if (typeof ltOutputDirty === "function") dirty = await ltOutputDirty(run, path);
  } catch (_) {}
  let read = null;
  try {
    if (typeof ltOutputRead === "function") read = await ltOutputRead(run, path);
  } catch (_) {}
  const node = ltOutNodeOf(rec.nodeId, run);
  const text = node ? String(node.text == null ? "" : node.text) : "";
  return {
    path: String(path || ""),
    state: dirty,
    reason: (read && read.reason) || "",
    nodeId: String(rec.nodeId || ""),
    missing: !node,
    text: text,
    hash: ltOutHash(text),
    files: ltOutArr(rec.fileRefs),
    at: Number(rec.at) || 0,
    edited: !!rec.edited,
    editAt: Number(rec.editAt) || 0,
  };
}
/* 一次扫完所有相关产出，顺手把结论汇总成一次性闸值。 */
async function ltOutScan(run, path) {
  const items = [];
  for (const x of ltOutRelevant(run, path)) items.push(await ltOutCheck(run, x.path));
  const unknown = items.filter((i) => i.state === "unknown");
  const edited = items.filter((i) => i.state === "edited");
  return {
    items: items,
    unknown: unknown,
    edited: edited,
    state: unknown.length ? "unknown" : edited.length ? "edited" : items.length ? "clean" : "none",
  };
}
/* 同一份「不确定的料」只在同一个签名上问一次（问过并确认后不再反复拦）。 */
function ltOutAskHash(scan) {
  const parts = ltOutArr(scan && scan.items)
    .filter((i) => i && i.state === "unknown")
    .map((i) => i.path + ":" + (i.missing ? "node-missing" : i.reason || "unknown") + ":" + (i.hash || ""));
  return ltOutHash(parts.join("|") || "ltout");
}
function ltOutAskWhy(scan) {
  const rows = [];
  for (const i of ltOutArr(scan && scan.items)) {
    if (i.state !== "unknown") continue;
    const why = i.missing
      ? ltOutT("画布上的产出节点找不到了（可能被删）")
      : i.reason === "file-unreadable"
        ? ltOutT("登记在案的产出文件现在读不到")
        : i.reason === "no-baseline"
          ? ltOutT("这个环节还没有登记过产出基线")
          : ltOutT("无法确定是否被改过");
    rows.push("- " + i.path + "：" + why);
  }
  return (
    ltOutT("这些产出的现状我核对不上，不能假定「没改过」。请确认后续按画布上的现内容继续（要改就先去画布上的产出节点改好）：") +
    "\n" +
    (rows.join("\n") || ltOutT("（没有可列出的细节）"))
  );
}

/* ── ④ 判不准就问用户：落成条带人工卡上的一个「问题条目」──────────────
 * 复用既有 human/interrupt 机制，不新造暂停态：
 *   · 本环节进入 waiting_delivery（run 随之变 waiting，主循环不再点火它）；
 *   · 往画布上补一颗系统建的交付节点（ltEnsureDeliverNode，uid 按 task+path 稳定）；
 *   · 条带「等你处理」出现人工卡，卡里就一个必填问题条目：用户填完并点「确认交付完成」。
 * 用户在卡里作答后走 ltOutResolveAsk（见下），把答复写进状态键并让本环节重新排队。 */
async function ltOutAsk(run, path, scan, node) {
  const st = ltOutStat(run, path);
  if (!st) return { ok: false, error: ltOutT("找不到这一环的运行态，没法落确认项") };
  const sig = ltOutAskHash(scan);
  if (st.ask && st.ask.sig === sig) return { ok: true, already: true, sig: sig };
  const why = ltOutAskWhy(scan);
  const item = {
    id: LT_OUT_ASK_KEY,
    kind: "text",
    title: ltOutT("产出判不准，请确认"),
    desc: why,
    required: true,
    done: false,
    value: "",
  };
  /* 交付节点的 uid 按 task + path 稳定：同一个环节反复判不准也只补同一颗节点，不堆新的。 */
  const uid = "ltout-" + ltOutHash(String((run && run.taskId) || "") + "|" + String(path || ""));
  const gNode = {
    title: (node && node.title) || String(path || ""),
    cfg: { uid: uid, goal: why, items: [item] },
  };
  st.ask = { at: ltOutNow(), sig: sig, why: why, paths: ltOutArr(scan && scan.items).filter((i) => i.state === "unknown").map((i) => i.path), items: [item] };
  st.items = [item];
  st.status = "waiting_delivery";
  st.err = "";
  st.round = Math.max(1, Number(st.round) || 1);
  try {
    if (typeof ltEnsureDeliverNode === "function") {
      const dn = await ltEnsureDeliverNode(run, path, gNode);
      if (dn) {
        dn.ltAsk = 1;
        dn.ltItems = [JSON.parse(JSON.stringify(item))];
        if (typeof renderCanvas === "function") renderCanvas();
      }
    }
  } catch (_) {}
  try {
    if (typeof ltPushWait === "function") ltPushWait(run, path, "deliver", gNode);
  } catch (_) {}
  /* 每一条判不准的料都记上「这一份签名已经问过了」：同一个基线 + 同一个原因不再反复问；
     引擎一登记新基线（ltOutputWrite 换掉整条 rec），问题就重新问一遍。 */
  for (const i of ltOutArr(scan && scan.items)) {
    if (i.state !== "unknown") continue;
    const r2 = ltOutRecOf(run, i.path);
    if (!r2) continue;
    r2.askedSig = sig;
    r2.askedAt = ltOutNow();
  }
  try {
    if (typeof ltLog === "function") ltLog(run, ltOutT("产出判不准，已停下来问你：") + why, "warn");
  } catch (_) {}
  try {
    if (typeof ltSave === "function") ltSave(run, true);
  } catch (_) {}
  try {
    if (typeof ltRenderStripSoon === "function") ltRenderStripSoon();
  } catch (_) {}
  return { ok: true, sig: sig, waitPath: String(path || "") };
}

/* 闸：相关产出全对得上（clean / edited）→ 放行；判不准 → 问用户并让本环节停下等答复。
 * 返回 { state, asked, confirmed }：asked = 本次已经把问题落进人工卡（调用方必须停下）。 */
async function ltOutGate(run, path, node) {
  const scan = await ltOutScan(run, path);
  if (scan.state !== "unknown") return { state: scan.state, asked: false, confirmed: false, scan: scan };
  const sig = ltOutAskHash(scan);
  /* 每一条判不准的料：它自己那份登记上已经记过这个签名 → 用户确认过了，不再拦。
     全部确认过才放行；只要还有没问过的（新基线 / 新原因）就再问一次。 */
  const pend = ltOutArr(scan.unknown).filter((i) => {
    const rec = ltOutRecOf(run, i.path);
    return !(rec && rec.askedSig === sig && rec.askedAt);
  });
  if (!pend.length) return { state: "unknown", asked: false, confirmed: true, scan: scan };
  const r = await ltOutAsk(run, path, scan, node);
  return { state: "unknown", asked: !!(r && r.ok), confirmed: false, scan: scan };
}

/* 用户答完：把答复写进状态键、清掉确认项、本环节重新排队（ltPump 再点火一次）。
 * 不是「交付完成」——不写交付清单、不 fireOut，本环节的正文还没生成。 */
async function ltOutResolveAsk(run, path, items) {
  const st = ltOutStat(run, path);
  if (!st || !st.ask) return { ok: false, error: ltOutT("这一环当前不在等产出确认") };
  const list = ltOutArr(items && items.length ? items : st.items);
  const it = list[0] || {};
  const answer = String(it.value == null ? "" : it.value).trim();
  const ask = st.ask;
  try {
    if (typeof ltStatePut === "function")
      ltStatePut(run, path, LT_OUT_ASK_KEY, { at: ltOutNow(), answer: ltOutStr(answer, 4000), sig: ask.sig, paths: ask.paths || [], why: ask.why || "" });
  } catch (_) {}
  st.ltOutAsk = { sig: ask.sig, at: ltOutNow(), answer: ltOutStr(answer, 1000) };
  st.ask = null;
  delete st.ask;
  st.items = [];
  st.status = "pending";
  st.err = "";
  const rec = ltOutRecOf(run, path);
  if (rec) {
    rec.confirmedAt = ltOutNow();
    rec.confirmedAnswer = ltOutStr(answer, 1000);
  }
  try {
    if (typeof ltDropWait === "function") ltDropWait(run, path);
  } catch (_) {}
  try {
    if (typeof ltLog === "function")
      ltLog(run, ltOutT("产出确认已收到，继续跑这一环") + (answer ? "：" + ltOutStr(answer, 200) : ""), "");
  } catch (_) {}
  try {
    if (typeof ltSave === "function") ltSave(run, true);
  } catch (_) {}
  try {
    if (typeof ltRenderStripSoon === "function") ltRenderStripSoon();
  } catch (_) {}
  try {
    if (typeof ltPump === "function") ltPump(run);
  } catch (_) {}
  return { ok: true, resumed: true, answer: answer };
}

if (typeof window !== "undefined")
  window.LTOUT = {
    PROMPT_MAX: LT_OUT_PROMPT_MAX,
    ASK_KEY: LT_OUT_ASK_KEY,
    relevant: ltOutRelevant,
    promptSection: ltOutPromptSection,
    check: ltOutCheck,
    scan: ltOutScan,
    gate: ltOutGate,
    ask: ltOutAsk,
    resolveAsk: ltOutResolveAsk,
  };
