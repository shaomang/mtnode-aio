/* ===== 研究视图「版本组」：原文 + 它的衍生稿（默认中译 / 英译 / 摘要 / 节选，规则表可配）=====
 * renderer/research-versions.js · window.MTResearchVersions（纯内核 + 一层很薄的实例壳）
 *
 * 一句话：把「一篇原文 + 它的衍生稿」聚成一个版本组，并把每份稿子**上一次同步时的字节哈希**
 * 记进 research/versions.json；当前文件哈希与基线一致 = 绿色（与组内同步），不一致 = 金色（被改过，待扩散）。
 *
 * 为什么要有基线哈希，而不是「谁最后改的」：
 *   · 改动可能来自外部编辑器（用户拿 VSCode 直接写），应用根本没收到事件 —— 只有把「上次同步时的字节」
 *     留在盘上，下一次读出文件时才能判出它变了；
 *   · 判据必须是能复算的东西：同一份文件，界面算出来的哈希与 versions.json 里那串字一样，
 *     用户自己也能对着看，不需要信任任何「模型觉得变了」。
 *
 * 三态（stateOf）：
 *   clean    有基线，当前哈希 === 基线 → 绿色（与组内其它版本同步）
 *   diverged 有基线，当前哈希 !== 基线 → 金色（这一版被改过，建议只在这一版继续改，改完再扩散）
 *   absent   这份文件没有基线（从没生成成功 / 不是本应用产出的），或当前读不到内容 → 不上色
 *
 * 组内四态判色（statusOfGroup）：在上面三态之上加一条「组里有人被改过、这份还没跟上」→ 橙（stale），
 * 树 / 顶栏金色 chip / 阅读区平铺条共用这一份判据（三态是它的底座，别再各自拿 stateOf 拼颜色）。
 *
 * 文件：<工作目录>/research/versions.json（应用独占）
 *   {
 *     ver: 1, updatedAt: <ms>,
 *     groups: {
 *       "notes/40-hardy": {                        // 组键 = 原文去掉 .md 的相对路径
 *         base: "notes/40-hardy.md", title: "…",
 *         members: {
 *           "notes/40-hardy.md":    { h: "<字节哈希>", kind: "original", lang: "zh", at: <ms> },
 *           "notes/40-hardy.zh.md": { h: "<字节哈希>", kind: "zh",       lang: "zh", at: <ms> }
 *         }
 *       }
 *     }
 *   }
 *   组键刻意用「原文路径」而不是哈希：删了原文再建同名文件，组还是同一个（基线跟着新文件重写）。
 *
 * 口径 = **唯一一份衍生规则表**（本模块的 DEFAULT_RULES / normalizeRules / rules / setRules，以及
 * 每页一份的 tables / setTables / tableFor / rulesFor / setTable）：
 * 一个组的成员就是「原文 + 同目录的 原名.<规则后缀>.md」—— 默认那四条是 原名.zh.md /
 * 原名.en.md / 原名.summary.md / 原名.excerpt.md，往某页表里加 { lang: "ja" } 就多认 原名.ja.md。
 * 两张表的层次：ui.deriveRules 是**默认表 = 新页默认值**（界面不再改它）；ui.deriveRulesByPage
 * 按页路径存「这一页自己的表」（键 = notes/xx.md），没有该键的页落到默认表，
 * 键在、值是空数组 = 这一页的空表（变体被删光了，不出任何默认衍生物）。
 * research-derive.js 不复制第二份表：它把这两张表读出来 → setRules / setTables 交到这里，
 * 于是「文件名叫什么 / 归哪一组 / 判什么色」三处永远是同一份口径；
 * 入口条摆哪些变体只问 rulesFor(这一页)，辨认（suffixOf）问的是 knownRules()（默认表 + 各页表并集）。
 * 认 frontmatter 的 parent / parents / derivedFrom / derivesFrom…（与 research-core.js 的
 * readDeriveParents 同一份键表）加 derived / lang；parent 解析不出来时退到文件名后缀 ——
 * 两种情况都要能落进同一组（导入稿 / 手写稿常缺 parent）。
 *
 * 本模块**只算不写**：buildGroups / stateOf / markBaseline / planSpread 都是纯函数，返回组、状态与
 * patch，不碰盘。落盘只有两个入口，且都要求传本模块算出来的东西：
 *   · instance.markBaseline(paths)  → { store, patch, paths }（只算，不写）
 *   · instance.commit(patch)        → 合并 patch 并写 research/versions.json（生成成功 / 扩散成功时由调用方调）
 *
 * 依赖注入（与 app-research-tree.js / research-derive.js 同一套，全部在调用期取）：
 *   ctx.root()   研究目录绝对路径（<工作目录>/research）
 *   ctx.joinP    路径拼接（缺省退到 api.pathJoin）
 *   ctx.api      window.api（fileReadText / fileWriteText / fileMkdir）
 *   ctx.notes()  [{path, title, md, meta}]（与左栏树同源；stateOf 用它取「当前字节」）
 *   ctx.t        翻译（缺省原样返回）；ctx.state() 可选（给的是 RS）
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.MTResearchVersions = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const VER = 1;
  const STORE_FILE = "versions.json"; /* <research>/versions.json */
  const META_FILE = "research.json"; /* <research>/research.json（默认表在 ui.deriveRules，页表在 ui.deriveRulesByPage） */
  const ORIGINAL = "original";
  const MAX_WALK = 12; /* parent 链最多往上数 12 层（防成环） */

  /* ── 衍生规则表（种类 + 语言）· 全仓唯一一份 ──
   * 文件名后缀、归组、判色三处都从这一份表算。research-derive.js 不再写第二份 KINDS：
   * 它把 research.json 里 `ui.deriveRules`（默认表 = 新页默认值）与 `ui.deriveRulesByPage`
   * （每页一份）读出来，normalizeRules 之后 setRules() / setTables() 到这里。
   * 新增一种语言（ja / fr…）只是往**某一页**的表里加一条 —— 文件名叫 notes/原名.ja.md、frontmatter 写
   * derived: translate + lang: ja，本模块就把这份稿子认成标准变体归进版本组（不会当「非标准变体」）。
   *
   * 规则项：{ id, label, derived, lang, suffix, hint }（都可省的按下面的推导补齐）
   *   id      变体 id（versions.json 里记的 kind、组内排序都用它）
   *   label   界面显示名
   *   derived 写进 frontmatter 的 derived（translate / summary / excerpt / 自定义）
   *   lang    译稿的目标语言（zh / en / ja / fr…）；非译稿留空 = 语言由用户选
   *   suffix  文件名后缀：notes/原名.<suffix>.md（译稿默认 = lang，其它默认 = derived）
   *   hint    界面上的一句说明（可选）
   * 配置项写成字符串也认：
   *   "ja"  → 译成日语的译稿（derived: translate、lang / id / suffix 都是 ja）
   *   "summary" → 种类规则（derived / id / suffix 都是 summary）
   */
  /* 3-Pass 法那三条（略读 / 关键概念 / 技术细节）只有一份来源 —— 默认表与旧表迁移都取这里。
     为什么不用「摘要 / 节选」：那两条产出的是「更短的同一篇文章」，读完仍不知道该信哪一句；
     3-Pass 是**三种不同的读法**：第 1 遍回答「这篇贡献是什么」，第 2 遍建立概念直觉
     （可引用原文的图），第 3 遍才落到方法、公式与实验的规格级细节。 */
  const PASS3_RULES = [
    {
      id: "skim",
      label: "略读",
      derived: "skim",
      lang: "",
      suffix: "skim",
      hint: "3-Pass 第 1 遍：贡献、证据强度与边界，一段话能讲完",
    },
    {
      id: "concept",
      label: "关键概念",
      derived: "concept",
      lang: "",
      suffix: "concept",
      hint: "3-Pass 第 2 遍：核心概念（简要定义 + 简化解释）；优先引用原文里的图，必要时补 Mermaid",
    },
    {
      id: "tech",
      label: "技术细节",
      derived: "tech",
      lang: "",
      suffix: "tech",
      hint: "3-Pass 第 3 遍：方法、公式、推导与实验设置的规格级复述",
    },
  ];
  /* 被 3-Pass 取代的两个旧种类：表里遇到就地换成三条（文件一个都不删，见 migrateUiRules） */
  const LEGACY_PASS3 = { summary: true, excerpt: true };
  const DEFAULT_RULES = [
    { id: "zh", label: "中译", derived: "translate", lang: "zh", suffix: "zh", hint: "整篇译成中文，结构原样保留" },
    { id: "en", label: "英译", derived: "translate", lang: "en", suffix: "en", hint: "整篇译成英文，结构原样保留" },
  ].concat(PASS3_RULES.map((r) => Object.assign({}, r)));
  const LANG_LABELS = {
    zh: "中文",
    en: "English",
    ja: "日本語",
    fr: "Français",
    de: "Deutsch",
    es: "Español",
    ko: "한국어",
    ru: "Русский",
    pt: "Português",
    it: "Italiano",
    ar: "العربية",
  };
  function langLabel(id) {
    const k = str(id).trim().toLowerCase();
    return LANG_LABELS[k] || str(id).trim();
  }
  /* ── 原文语言判定（「默认变体」按它走）──
   * frontmatter 写了 lang 就以它为准（调用方先看 meta.lang）；没写才问这里 ——
   * 导入的英文论文通常不带 lang，落到「中文库按中文算」就会给英文原文挂一颗「英译」、把「中译」藏起来，
   * 恰好反了。判据是「汉字数 : 英文词数」：中文一个字约等于一个词，英文一个词 ≈ 5 个字母，
   * 直接比字符数会被 long English words 带偏。代码块 / 行内码 / 公式 / 标签先摘掉 ——
   * 技术笔记里成片的英文代码不属于正文语言。判不准（两边势均力敌 / 正文没有字）返回 ""，
   * 让调用方各自兜底（阅读区按中文，左栏宁可不筛）。 */
  const CJK_CHAR_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g;
  const LATIN_WORD_RE = /[A-Za-z]+/g;
  function detectLang(md) {
    let s = str(md);
    if (!s) return "";
    s = s
      .replace(/^---\r?\n[\s\S]*?\r?\n---[ \t]*\r?\n?/, " ")
      .replace(/```[\s\S]*?```/g, " ")
      .replace(/~~~[\s\S]*?~~~/g, " ")
      .replace(/\$\$[\s\S]*?\$\$/g, " ")
      .replace(/`[^`\r\n]*`/g, " ")
      .replace(/<[^>\r\n]{1,200}>/g, " ");
    const cjk = (s.match(CJK_CHAR_RE) || []).length;
    const words = (s.match(LATIN_WORD_RE) || []).length;
    if (!cjk || !words) {
      if (cjk > 0) return "zh";
      if (words >= 5) return "en";
      return "";
    }
    const zhShare = cjk / (cjk + words);
    if (zhShare >= 0.6) return "zh";
    if (zhShare <= 0.25) return "en";
    return "";
  }

  const LANG_CODE_RE = /^[a-z]{2,3}(?:-[a-z0-9]{2,8})?$/i;
  function slugOf(v) {
    return str(v)
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "");
  }
  /* 一条规则：字符串 / 对象都认；不合理（译稿没给语言、id 空）就丢掉 */
  function normalizeRule(raw) {
    if (raw == null) return null;
    let r = raw;
    if (typeof r === "string") {
      const s = str(r).trim();
      if (!s) return null;
      r = LANG_CODE_RE.test(s) ? { lang: s } : { derived: s };
    }
    if (typeof r !== "object") return null;
    if (r.off === true || r.enabled === false) return null;
    const lang = slugOf(r.lang || r.language);
    const derived = slugOf(r.derived || r.kind || r.type) || (lang ? "translate" : "");
    if (!derived) return null;
    const isT = derived === "translate";
    if (isT && !lang) return null; /* 译稿必须说明译成哪种语言，否则后缀 / 语言都无从谈起 */
    const id = slugOf(r.id) || (isT ? lang : derived);
    if (!id) return null;
    const suffix = slugOf(r.suffix) || (isT ? lang : derived);
    return {
      id: id,
      label: str(r.label).trim() || (isT ? langLabel(lang) : derived),
      derived: derived,
      lang: lang,
      suffix: suffix,
      hint: str(r.hint).trim(),
    };
  }
  /* 整张表：去掉不合理的与重名 id。
     **只有传入的不是数组**（没配置 / 读不到）才退回默认那四条；
     显式空数组就是「空表」—— 这一页不留变体，不偷偷还原成默认表（否则删到空的页又长出默认衍生物）。 */
  function normalizeRules(list) {
    if (!Array.isArray(list)) return DEFAULT_RULES.map((r) => Object.assign({}, r));
    const out = [];
    const seen = new Set();
    for (const raw of list) {
      const r = normalizeRule(raw);
      if (!r || seen.has(r.id)) continue;
      seen.add(r.id);
      out.push(r);
    }
    return out;
  }
  /* ── 旧表迁移（摘要 / 节选 → 3-Pass 三条）──────────────────────────────
   * 一次性、纯函数：读 research.json 时把 ui.deriveRules 与 ui.deriveRulesByPage 里
   * derived 为 summary / excerpt 的条目就地换成 PASS3_RULES 三条，其余条目与顺序一律不动。
   * 三条已经在表里 → 只删旧条，不重复塞。
   * **文件一个都不删**：已生成的 *.summary.md / *.excerpt.md 从此认不出后缀（suffixOf 只认当前表），
   * 于是自动落到「非标准变体」那一档挂在该篇原文下，还能点开看，只是不再重新生成。
   * 返回 { changed, rules, byPage }：changed=false 时调用方一个字节都不要写回。 */
  function migrateLegacyTable(list) {
    if (!Array.isArray(list)) return { changed: false, list: list };
    const hasOld = list.some((raw) => {
      const r = normalizeRule(raw);
      return !!r && LEGACY_PASS3[r.derived] === true;
    });
    if (!hasOld) return { changed: false, list: list };
    const out = [];
    let injected = false;
    const seen = new Set();
    const pushRules = (one) => {
      const r = normalizeRule(one);
      if (!r || seen.has(r.id)) return;
      seen.add(r.id);
      out.push(r);
    };
    for (const raw of list) {
      const r = normalizeRule(raw);
      if (r && LEGACY_PASS3[r.derived] === true) {
        if (!injected) {
          injected = true;
          for (const p of PASS3_RULES) pushRules(p);
        }
        continue;
      }
      pushRules(raw);
    }
    /* 旧条在表里但三条一条都没插进去（表里全是同名 id？）—— 至少把三条补齐 */
    if (!injected) for (const p of PASS3_RULES) pushRules(p);
    return { changed: true, list: out };
  }
  function migrateUiRules(ui) {
    const src = ui && typeof ui === "object" ? ui : {};
    const def = migrateLegacyTable(src.deriveRules);
    const byPageSrc = src.deriveRulesByPage && typeof src.deriveRulesByPage === "object" ? src.deriveRulesByPage : null;
    let byPage = byPageSrc;
    let pageChanged = false;
    if (byPageSrc) {
      const next = {};
      for (const k of Object.keys(byPageSrc)) {
        const r = migrateLegacyTable(byPageSrc[k]);
        if (r.changed) pageChanged = true;
        next[k] = r.list;
      }
      byPage = next;
    }
    const changed = def.changed || pageChanged;
    /* 没有改动时原样返回传入的 ui（调用方按引用判等即可） */
    if (!changed) return { changed: false, ui: src };
    const out = Object.assign({}, src);
    if (def.changed) out.deriveRules = def.list;
    if (pageChanged) out.deriveRulesByPage = byPage;
    return { changed: true, ui: out };
  }

  /* 默认表（research.json 的 ui.deriveRules）：只当「新页默认值」——
   * 界面不再写回它；一页 = 一个 md 文档，它自己那份表在下面的 PAGE_TABLES 里。 */
  let ACTIVE_RULES = normalizeRules(DEFAULT_RULES);

  /* ── 每页一份衍生规则表（research.json → ui.deriveRulesByPage）──
   * 研究视图里每个 md 文档都是一页（原文与衍生稿都算）：页级表只决定「这一页的衍生入口条摆哪些」
   * 以及它生成出来的稿子叫什么；**没有该键**的页 = 用上面的默认表，
   * **键存在但值是空数组** = 这一页的空表（用户把变体删光了，不出任何默认衍生物）。
   * 归一化仍只走这一份 normalizeRule，所以文件名后缀 / 归组 / 判色三处口径永远一致。
   * 键 = 页在 research/ 里的相对路径（notes/xx.md / core/xx.md）。 */
  let PAGE_TABLES = Object.create(null);
  let KNOWN = null; /* knownRules 的缓存：setRules / setTables / setTable 时作废 */

  function rules() {
    return ACTIVE_RULES.map((r) => Object.assign({}, r));
  }
  function setRules(list) {
    ACTIVE_RULES = normalizeRules(list);
    KNOWN = null;
    return rules();
  }
  /* 一页的表：只归一，不兜底（空数组 = 这一页的空表，不是「没有表」） */
  function normalizeTable(list) {
    const out = [];
    const seen = new Set();
    for (const raw of Array.isArray(list) ? list : []) {
      const r = normalizeRule(raw);
      if (!r || seen.has(r.id)) continue;
      seen.add(r.id);
      out.push(r);
    }
    return out;
  }
  function cloneTable(list) {
    return (list || []).map((r) => Object.assign({}, r));
  }
  /* 整份页表（读盘 / 写盘用）：**键存在就留住，哪怕值是空数组** ——
     空数组代表「这一页的变体被删光了」，丢了它就会回落成默认四条、又长出默认衍生物。 */
  function tables() {
    const out = {};
    for (const k of Object.keys(PAGE_TABLES)) out[k] = cloneTable(PAGE_TABLES[k]);
    return out;
  }
  function setTables(obj) {
    const next = Object.create(null);
    if (obj && typeof obj === "object") {
      for (const k of Object.keys(obj)) {
        const key = normRel(k);
        if (!key || !Array.isArray(obj[k])) continue; /* 不是数组 = 这个键坏了，直接跳过 */
        next[key] = normalizeTable(obj[k]);
      }
    }
    PAGE_TABLES = next;
    KNOWN = null;
    return tables();
  }
  /* 这一页自己的表；没有这个键就 null（= 用默认表）。空数组照原样返回（= 这一页不留变体） */
  function tableFor(path) {
    const key = normRel(path);
    const hit = key ? PAGE_TABLES[key] : null;
    return hit ? cloneTable(hit) : null;
  }
  function hasTable(path) {
    return !!tableFor(path);
  }
  /* 一页生效的表：自己有（含空表）就用自己那份，没有这个键才落到「新页默认值」 */
  function rulesFor(path) {
    return tableFor(path) || rules();
  }
  /* 写一页的表（传空数组 = 这一页的空表，不出任何变体）；只算不写，落盘在 research-derive.js */
  function setTable(path, list) {
    const key = normRel(path);
    if (!key) return null;
    const clean = normalizeTable(list);
    const next = Object.create(null);
    for (const k of Object.keys(PAGE_TABLES)) next[k] = PAGE_TABLES[k];
    next[key] = clean;
    PAGE_TABLES = next;
    KNOWN = null;
    return cloneTable(clean);
  }
  /* 辨认口径（只回答「盘上这份文件是哪一类变体 / 归哪一组」）：
     默认表 + 各页表里出现过的规则，按 id 去重、默认表优先 ——
     某页加了「日语」，别的页也认得出那份稿子，但别的页的入口条不会因此多出一颗 chip。 */
  function knownRules() {
    if (KNOWN) return KNOWN;
    const out = rules();
    const seen = new Set(out.map((r) => r.id));
    for (const k of Object.keys(PAGE_TABLES)) {
      for (const r of PAGE_TABLES[k]) {
        if (seen.has(r.id)) continue;
        seen.add(r.id);
        out.push(Object.assign({}, r));
      }
    }
    KNOWN = out;
    return out;
  }
  /* 显式传表就按那份算（一页一表 / 自检），不传就用「辨认口径」那一份 */
  function useRules(x) {
    return Array.isArray(x) && x.length ? normalizeRules(x) : knownRules();
  }
  /* 表里出现过的语言（界面上的语言下拉就用这一份，不再另写一张 LANGS） */
  function languages(list) {
    const out = [];
    for (const k of useRules(list)) {
      if (!k.lang || out.some((x) => x.id === k.lang)) continue;
      out.push({ id: k.lang, label: langLabel(k.lang) });
    }
    return out;
  }
  function kindOrder(list) {
    return [ORIGINAL].concat(useRules(list).map((r) => r.id));
  }

  /* 父笔记的几种写法：与 research-core.js 的 DERIVE_PARENT_KEYS 一致 */
  const PARENT_KEYS = ["parent", "parents", "derivedFrom", "derived_from", "derivesFrom", "derives_from"];

  /* ── 字符串与路径小工具 ── */
  function str(v) {
    return v == null ? "" : String(v);
  }
  function normRel(p) {
    return str(p)
      .replace(/\\/g, "/")
      .replace(/^\.\//, "")
      .replace(/\/+/g, "/")
      .trim();
  }
  function dirOf(rel) {
    const s = normRel(rel);
    const i = s.lastIndexOf("/");
    return i < 0 ? "" : s.slice(0, i + 1);
  }
  function baseName(rel) {
    const s = normRel(rel);
    return s.slice(s.lastIndexOf("/") + 1);
  }
  function baseNoExt(rel) {
    return baseName(rel).replace(/\.md$/i, "");
  }
  function keyOfRel(rel) {
    return dirOf(rel) + baseNoExt(rel);
  }
  /* 归组用的键（不知道 frontmatter 时的兜底）：notes/a.zh.md → notes/a；原文 → notes/a */
  function baseKeyOf(rel) {
    const sfx = suffixOf(rel);
    return sfx ? dirOf(rel) + sfx.base : keyOfRel(rel);
  }

  /* ── 变体口径（规则表是唯一真源；research-derive.js 的 kindOf / langOf / targetRel 都从这里取）──
     三个都可带最后一项 rulesArg：显式给表就按那份算，不给就用 setRules 生效的那份。 */
  function kindOf(id, rulesArg) {
    const list = useRules(rulesArg);
    for (let i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }
  function langOf(kindId, lang, rulesArg) {
    const k = kindOf(kindId, rulesArg);
    if (!k) return str(lang).trim();
    if (k.derived === "translate") return k.lang;
    return str(lang || k.lang || "zh").trim() || "zh";
  }
  /* 同目录兄弟文件：notes/40-hardy.md → notes/40-hardy.zh.md（译稿用语言，其它用 derived） */
  function targetRel(parentRel, kindId, lang, rulesArg) {
    const k = kindOf(kindId, rulesArg);
    if (!k) return "";
    const suffix = k.suffix || (k.derived === "translate" ? langOf(kindId, lang, rulesArg) : k.derived);
    if (!suffix) return "";
    const p = normRel(parentRel);
    return dirOf(p) + baseNoExt(p) + "." + suffix + ".md";
  }
  /* frontmatter 的 derived + lang → 变体 id；translate 只认表里那条语言（新增语言加一行就认） */
  function kindIdOf(derived, lang, rulesArg) {
    const d = str(derived).trim().toLowerCase();
    if (!d) return "";
    const wl = str(lang).trim().toLowerCase();
    for (const k of useRules(rulesArg)) {
      if (k.derived !== d) continue;
      if (k.derived === "translate") {
        if (wl === k.lang) return k.id;
        continue;
      }
      return k.id;
    }
    return "";
  }
  /* 文件名后缀（原名.ja.md → { kind:"ja", base:"原名" }），表里没有这个后缀就返回 null */
  function suffixOf(rel, rulesArg) {
    const base = baseNoExt(rel);
    const m = /^(.*)\.([A-Za-z][A-Za-z0-9-]*)$/.exec(base);
    if (!m || !m[1]) return null;
    const tail = m[2].toLowerCase();
    for (const k of useRules(rulesArg)) {
      if (tail === str(k.suffix).toLowerCase() || tail === k.id) return { kind: k.id, base: m[1] };
    }
    return null;
  }
  function kindRank(kind, rulesArg) {
    const i = kindOrder(rulesArg).indexOf(str(kind));
    const n = useRules(rulesArg).length + 1;
    return i < 0 ? n : i;
  }
  function labelOfKind(kind, rulesArg) {
    const k = kindOf(kind, rulesArg);
    return k ? k.label : "";
  }

  /* ── 字节哈希：FNV-1a ×2（64 位宽）+ 字节长度 ──
   * 为什么自己写 UTF-8：浏览器与 node 都要同一串字（人工复核时 `node -e` 算出来的
   * 必须与界面一致），不能一边 TextEncoder、一边 Buffer。BOM 也算字节，不剥 ——
   * 剥了就无法区分「同内容不同 BOM」的两次写入。
   * 长度并进哈希串：不同长度撞到同一对 32 位哈希的概率再降一档。 */
  function utf8Bytes(s) {
    const out = [];
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c < 0x80) {
        out.push(c);
        continue;
      }
      if (c < 0x800) {
        out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
        continue;
      }
      if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
        const c2 = s.charCodeAt(i + 1);
        if (c2 >= 0xdc00 && c2 <= 0xdfff) {
          const cp = 0x10000 + ((c - 0xd800) << 10) + (c2 - 0xdc00);
          i += 1;
          out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
          continue;
        }
      }
      out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
    return out;
  }
  function hex8(n) {
    const s = (n >>> 0).toString(16);
    return "00000000".slice(s.length) + s;
  }
  function hashText(text) {
    const bytes = utf8Bytes(str(text));
    let h1 = 0x811c9dc5;
    let h2 = 0x27d4eb2d;
    for (let i = 0; i < bytes.length; i++) {
      h1 = Math.imul(h1 ^ bytes[i], 0x01000193) >>> 0;
      h2 = Math.imul(h2 ^ bytes[i], 0x5bd1e995) >>> 0;
      h2 = (h2 ^ (h2 >>> 15)) >>> 0;
    }
    h1 = Math.imul(h1 ^ bytes.length, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ (bytes.length << 3), 0x5bd1e995) >>> 0;
    return hex8(h1) + hex8(h2) + "-" + bytes.length.toString(36);
  }

  /* ── 版本组 ──
   * docs: [{path, title, md, meta}]（研究目录内的相对路径，如 notes/40-hardy.md）
   * 组：{ key, base, title, original, originalExists, members:[{path,title,kind,lang,label,role,parent,exists}] }
   *   key            组键 = 原文去掉 .md 的相对路径
   *   original       原文路径（不存在也给出应有的路径）
   *   members        原文排第一，其余按规则表里的顺序排（默认 中译 / 英译 / 摘要 / 节选）
   *   member.kind    original | zh | en | summary | excerpt | ""（非标准变体：如 import / draft / 其它语言） */
  function parentRefs(meta) {
    const out = [];
    const m = meta || {};
    for (const k of PARENT_KEYS) {
      const v = m[k];
      if (v == null) continue;
      for (const x of Array.isArray(v) ? v : [v]) {
        const s = str(x).trim();
        if (s && out.indexOf(s) < 0) out.push(s);
      }
    }
    return out;
  }
  function derivedOf(meta) {
    const m = meta || {};
    const v = m.derived != null ? m.derived : m.derive;
    return str(v).trim().toLowerCase();
  }
  function buildGroups(docs, rulesArg) {
    const list = [];
    for (const d of docs || []) {
      const rel = normRel(d && d.path);
      if (!rel) continue;
      list.push({ path: rel, title: str(d.title) || baseNoExt(rel), meta: (d && d.meta) || {} });
    }
    /* 引用解析：路径（带不带 .md）与标题都认，额外补 notes/ 与 core/ 两个常见前缀 */
    const byPath = new Map();
    const byTitle = new Map();
    for (const d of list) {
      byPath.set(d.path, d.path);
      if (/\.md$/i.test(d.path)) byPath.set(d.path.replace(/\.md$/i, ""), d.path);
      if (d.title) byTitle.set(d.title, d.path);
    }
    function resolveRef(ref) {
      const raw = str(ref)
        .trim()
        .replace(/^\[\[|\]\]$/g, "")
        .trim();
      if (!raw) return "";
      const cands = [normRel(raw)];
      if (!/\.md$/i.test(raw)) cands.push(normRel(raw + ".md"));
      for (const dir of ["notes/", "core/"]) {
        cands.push(normRel(dir + raw));
        if (!/\.md$/i.test(raw)) cands.push(normRel(dir + raw + ".md"));
      }
      for (const c of cands) if (byPath.has(c)) return byPath.get(c);
      return byTitle.get(raw) || "";
    }
    const parentOf = new Map();
    for (const d of list) {
      for (const ref of parentRefs(d.meta)) {
        const p = resolveRef(ref);
        if (p && p !== d.path) {
          parentOf.set(d.path, p);
          break;
        }
      }
    }
    /* parent 链往上找到根（成环就地断开） */
    function rootOf(rel) {
      let cur = rel;
      const seen = new Set([cur]);
      for (let i = 0; i < MAX_WALK; i++) {
        const p = parentOf.get(cur);
        if (!p || seen.has(p)) break;
        seen.add(p);
        cur = p;
      }
      return cur;
    }
    function keyOf(rel) {
      const rootRel = rootOf(rel);
      const sfx = suffixOf(rootRel, rulesArg);
      /* 根的 parent 没解析出来、文件名又带变体后缀：摘掉后缀当原文（导入稿 / 手写稿的常态） */
      if (sfx && !parentOf.has(rootRel)) return dirOf(rootRel) + sfx.base;
      return keyOfRel(rootRel);
    }

    const groups = new Map();
    for (const d of list) {
      const key = keyOf(d.path);
      if (!key) continue;
      if (!groups.has(key)) {
        groups.set(key, {
          key: key,
          base: key + ".md",
          title: "",
          original: key + ".md",
          originalExists: false,
          members: [],
        });
      }
      const g = groups.get(key);
      const role = d.path === key + ".md" ? ORIGINAL : "variant";
      const sfx = suffixOf(d.path, rulesArg);
      const kind =
        role === ORIGINAL
          ? ORIGINAL
          : kindIdOf(derivedOf(d.meta), d.meta && d.meta.lang, rulesArg) || (sfx ? sfx.kind : "");
      const kk = kindOf(kind, rulesArg);
      const lang =
        role === ORIGINAL ? str(d.meta && d.meta.lang) : str(d.meta && d.meta.lang) || (kk ? kk.lang : "");
      const member = {
        path: d.path,
        title: d.title,
        kind: kind,
        lang: lang,
        label: role === ORIGINAL ? "原文" : labelOfKind(kind, rulesArg) || derivedOf(d.meta) || "衍生",
        role: role,
        parent: key + ".md",
        group: key,
        exists: true,
      };
      if (role === ORIGINAL) {
        g.originalExists = true;
        g.original = d.path;
        g.title = d.title;
      }
      g.members.push(member);
    }
    const out = [];
    for (const g of groups.values()) {
      g.members.sort(
        (a, b) => kindRank(a.kind, rulesArg) - kindRank(b.kind, rulesArg) || a.path.localeCompare(b.path),
      );
      if (!g.title) {
        const orig = g.members.filter((m) => m.role === ORIGINAL)[0];
        g.title = orig ? orig.title : baseNoExt(g.base);
      }
      out.push(g);
    }
    out.sort((a, b) => a.key.localeCompare(b.key));
    return out;
  }
  function asGroups(x) {
    if (!Array.isArray(x) || !x.length) return null;
    const first = x[0] || {};
    return first.key != null && Array.isArray(first.members) ? x : null;
  }
  function groupFor(groups, rel) {
    const p = normRel(rel);
    if (!p) return null;
    for (const g of groups || []) {
      for (const m of g.members) if (m.path === p) return g;
    }
    /* 组里还没有这份文件（比如目标还没生成）：按组键反查一次 */
    const key = baseKeyOf(p);
    for (const g of groups || []) if (g.key === key) return g;
    return null;
  }
  /* groupOf(path, docsOrGroups) —— 传 docs 就先归组再查 */
  function groupOf(path, docsOrGroups, rulesArg) {
    const list = (docsOrGroups || []).slice ? (docsOrGroups || []).slice() : [];
    const groups = asGroups(list) || buildGroups(list, rulesArg);
    return groupFor(groups, path);
  }
  function siblingsOf(path, docsOrGroups) {
    const rel = normRel(path);
    const g = groupOf(rel, docsOrGroups);
    if (!g) return [];
    return g.members.filter((m) => m.path !== rel);
  }

  /* ── 状态文件（versions.json）── */
  const normalized = new WeakSet();
  function emptyStore() {
    const s = { ver: VER, updatedAt: 0, groups: {} };
    normalized.add(s);
    return s;
  }
  function normalizeStore(raw) {
    if (!raw || typeof raw !== "object") return emptyStore();
    if (normalized.has(raw)) return raw;
    const srcGroups = raw.groups && typeof raw.groups === "object" ? raw.groups : {};
    const out = { ver: VER, updatedAt: Number(raw.updatedAt) || 0, groups: {} };
    for (const key of Object.keys(srcGroups)) {
      const k = normRel(key);
      if (!k) continue;
      const g = srcGroups[key] || {};
      const srcMembers = g.members && typeof g.members === "object" ? g.members : {};
      const members = {};
      for (const mp of Object.keys(srcMembers)) {
        const rel = normRel(mp);
        const m = srcMembers[mp] || {};
        const h = str(m.h);
        if (!rel || !h) continue;
        members[rel] = { h: h, kind: str(m.kind), lang: str(m.lang), at: Number(m.at) || 0 };
      }
      if (!Object.keys(members).length) continue;
      out.groups[k] = { base: normRel(g.base) || k + ".md", title: str(g.title), members: members };
    }
    normalized.add(out);
    return out;
  }
  function entryOf(store, rel) {
    const s = normalizeStore(store);
    const want = normRel(rel);
    if (!want) return null;
    for (const key of Object.keys(s.groups)) {
      const members = s.groups[key].members;
      if (members[want]) return { group: key, entry: members[want] };
    }
    return null;
  }

  /* ── stateOf：绿 / 金 / 无基线 ──
   * stateOf(store, path, md) —— md 是**当前文件内容**（读不到就传 null）。
   * 返回 { status, rel, group, kind, lang, hash, baseline, at, reason }
   *   status: "clean" | "diverged" | "absent"
   *   reason: "nobaseline"（从没记过基线）| "unreadable"（有基线但这次没读到内容）| ""
   * 为什么要区分「读不到」与「改了」：读不到时宁可不上色，也不能把 `""` 的哈希当成「全改了」。 */
  function stateOf(store, path, md) {
    const rel = normRel(path);
    const hit = entryOf(store, rel);
    if (!hit) return { status: "absent", rel: rel, group: "", kind: "", lang: "", hash: "", baseline: "", at: 0, reason: "nobaseline" };
    const base = hit.entry;
    if (md == null) {
      return {
        status: "absent",
        rel: rel,
        group: hit.group,
        kind: base.kind,
        lang: base.lang,
        hash: "",
        baseline: base.h,
        at: base.at,
        reason: "unreadable",
      };
    }
    const h = hashText(md);
    return {
      status: h === base.h ? "clean" : "diverged",
      rel: rel,
      group: hit.group,
      kind: base.kind,
      lang: base.lang,
      hash: h,
      baseline: base.h,
      at: base.at,
      reason: "",
    };
  }

  /* ── statusOfGroup：组内四态判色（灰 / 绿 / 橙 / 金）· 全仓唯一一份 ──
   * statusOfGroup(members, store, rulesArg) → [{ path, exists, status, kind }]
   *   灰 absent   文件不存在（exists:false）→ 未生成，不上色（虚线最淡）；
   *              文件在、但没有基线（旧稿 / 外部放进来的稿）→ 界面另标「已生成 · 无基线」（青），
   *              与「未生成」分开上色：颜色只由基线 + 组内是否有人 diverged 决定，判据仍在这一处。
   *   绿 clean    有基线、当前字节 === 基线，且组内没有 diverged → 已生成
   *   橙 stale    有基线、自己没被改过，但组内有 diverged → 未同步（别人改过，这一份还没跟上）
   *   金 diverged 有基线、当前字节 !== 基线 → 就是被改过那一版（界面沿用现有呼吸灯）
   * 左栏树（app-research-tree.js 的 statusOf）、顶栏金色 chip、阅读区上方那条平铺条都问这一份，
   * 谁都不再自己比哈希、也不各定一套颜色 —— 一处改了判据，三处一起变。
   *
   * members 每项：{ path, exists?, md? }
   *   path    组内相对路径（还没生成的目标也列进来，传 exists:false）
   *   exists  省略 = true（组里的成员本来就已落盘）
   *   md      当前字节；传 null = 读不到（判不出就按 absent，理由与 stateOf 的 unreadable 一致）
   * rulesArg 只用来认「这一份是原文还是哪条规则的变体」（kind），不参与判色：
   *   颜色只由基线 + 组内是否有人 diverged 决定，换规则表只会换 kind、不会换颜色。
   */
  function statusOfGroup(members, store, rulesArg) {
    const list = [];
    for (const m of Array.isArray(members) ? members : []) {
      const rel = normRel(m && m.path);
      if (!rel) continue;
      const sfx = suffixOf(rel, rulesArg);
      list.push({
        path: rel,
        exists: !(m && m.exists === false),
        md: m ? m.md : null,
        /* 规则表认得的后缀 = 那条规则的 kind；没有多余点号的 .md 当原文；其余是「非标准变体」 */
        kind: sfx ? sfx.kind : baseNoExt(rel).indexOf(".") < 0 ? ORIGINAL : "",
      });
    }
    let hasGold = false;
    for (const x of list) {
      if (!x.exists) continue;
      if (stateOf(store, x.path, x.md).status === "diverged") {
        hasGold = true;
        break;
      }
    }
    const out = [];
    for (const x of list) {
      const st = x.exists ? stateOf(store, x.path, x.md).status : "absent";
      const status = st === "diverged" ? "diverged" : st === "clean" ? (hasGold ? "stale" : "clean") : "absent";
      out.push({ path: x.path, exists: x.exists, status: status, kind: x.kind });
    }
    return out;
  }

  /* ── markBaseline：算基线（只算不写）──
   * markBaseline(store, entries, at)
   *   entries: [{ path, md, title?, group?, kind?, lang? }] —— md 是刚落盘 / 刚写入的字节
   * 返回 { store: <合并后的完整 store>, patch: <只含本次写入项>, paths: [...], skipped: [...] }
   *   · 读不到内容（md == null）的项不进基线：否则会把「读失败」记成「没改」；
   *   · 不传 group 就按路径归组（摘变体后缀），不传 kind 按 original 记 —— 单篇补基线时够用。 */
  function markBaseline(store, entries, at) {
    const base = normalizeStore(store);
    const stamp = Number(at) || Date.now();
    const next = { ver: VER, updatedAt: stamp, groups: {} };
    for (const k of Object.keys(base.groups)) {
      const g = base.groups[k];
      next.groups[k] = { base: g.base, title: g.title, members: Object.assign({}, g.members) };
    }
    const patch = { ver: VER, updatedAt: stamp, groups: {} };
    const paths = [];
    const skipped = [];
    for (const e of entries || []) {
      const rel = normRel(e && e.path);
      if (!rel) continue;
      if (!e || e.md == null) {
        skipped.push({ path: rel, reason: "unreadable" });
        continue;
      }
      const key = normRel(e.group) || baseKeyOf(rel);
      if (!next.groups[key]) next.groups[key] = { base: key + ".md", title: str(e.title), members: {} };
      const g = next.groups[key];
      if (e.title) g.title = str(e.title);
      const sfx = suffixOf(rel);
      const kind = str(e.kind) || (rel === key + ".md" ? ORIGINAL : sfx ? sfx.kind : "");
      const entry = {
        h: hashText(e.md),
        kind: kind,
        lang: str(e.lang) || (kindOf(kind) ? kindOf(kind).lang : ""),
        at: stamp,
      };
      g.members[rel] = Object.assign({}, g.members[rel], entry);
      if (!patch.groups[key]) patch.groups[key] = { base: g.base, title: g.title, members: {} };
      patch.groups[key].members[rel] = entry;
      paths.push(rel);
    }
    return { store: next, patch: patch, paths: paths, skipped: skipped };
  }
  /* 把 patch 合并进 store（commit 用；也是纯函数） */
  function mergePatch(store, patch) {
    const base = normalizeStore(store);
    const p = normalizeStore(patch);
    const next = { ver: VER, updatedAt: p.updatedAt || base.updatedAt || Date.now(), groups: {} };
    for (const k of Object.keys(base.groups)) {
      const g = base.groups[k];
      next.groups[k] = { base: g.base, title: g.title, members: Object.assign({}, g.members) };
    }
    for (const k of Object.keys(p.groups)) {
      const pg = p.groups[k];
      if (!next.groups[k]) next.groups[k] = { base: pg.base, title: pg.title, members: {} };
      const g = next.groups[k];
      if (pg.title) g.title = pg.title;
      for (const rel of Object.keys(pg.members)) g.members[rel] = Object.assign({}, g.members[rel], pg.members[rel]);
    }
    return next;
  }

  /* ── planSpread：金色版本 → 全组（只算不写）──
   * planSpread({ store, docs|groups, gold, targets?, only? })
   *   目标默认「全组其它版本」；显式 targets 时只算那几项（不在这组里的进 skipped）。
   *   逐项给 mode：
   *     copy     同 kind + 同 lang（中译 → 中译、摘要 → 摘要）→ 直接以金色正文覆盖
   *     generate 跨语言 / 跨种类（中译 → 英译 / 摘要 / 原文）→ 走生成通道改写
   * 返回 { gold, group, targets:[{path,title,kind,lang,mode,role,hasBaseline}], skipped, counts } */
  function planSpread(input) {
    const o = input || {};
    const store = normalizeStore(o.store);
    const groups = asGroups(o.groups) || buildGroups(o.docs || []);
    const goldRel = normRel(o.gold || o.goldPath);
    const g = groupFor(groups, goldRel);
    if (!g) {
      return {
        gold: { path: goldRel, kind: "", lang: "", title: "", hasBaseline: false },
        group: null,
        targets: [],
        skipped: [{ path: goldRel, reason: "notfound" }],
        counts: { copy: 0, generate: 0 },
      };
    }
    const goldMember = g.members.filter((m) => m.path === goldRel)[0] || null;
    const goldHit = entryOf(store, goldRel);
    const gold = {
      path: goldRel,
      kind: goldMember ? goldMember.kind : goldHit ? goldHit.entry.kind : "",
      lang: goldMember ? goldMember.lang : goldHit ? goldHit.entry.lang : "",
      title: goldMember ? goldMember.title : baseNoExt(goldRel),
      hasBaseline: !!goldHit,
    };
    const only = Array.isArray(o.targets) ? new Set(o.targets.map(normRel)) : null;
    const targets = [];
    const skipped = [];
    for (const m of g.members) {
      if (m.path === goldRel) continue;
      if (only && !only.has(m.path)) {
        skipped.push({ path: m.path, reason: "unchecked" });
        continue;
      }
      const same = m.kind !== ORIGINAL && gold.kind !== "" && m.kind === gold.kind && str(m.lang) === str(gold.lang);
      targets.push({
        path: m.path,
        title: m.title,
        kind: m.kind,
        lang: m.lang,
        mode: same ? "copy" : "generate",
        role: m.role,
        hasBaseline: !!entryOf(store, m.path),
      });
    }
    const counts = { copy: 0, generate: 0 };
    for (const x of targets) counts[x.mode] += 1;
    return { gold: gold, group: g, targets: targets, skipped: skipped, counts: counts };
  }

  const PURE = {
    buildGroups: buildGroups,
    groupOf: groupOf,
    siblingsOf: siblingsOf,
    stateOf: stateOf,
    statusOfGroup: statusOfGroup,
    markBaseline: markBaseline,
    mergePatch: mergePatch,
    planSpread: planSpread,
    entryOf: entryOf,
    normalizeStore: normalizeStore,
    hashText: hashText,
    targetRel: targetRel,
    kindIdOf: kindIdOf,
    kindOf: kindOf,
    langOf: langOf,
    kindRank: kindRank,
    keyOfRel: keyOfRel,
    baseKeyOf: baseKeyOf,
    suffixOf: suffixOf,
    labelOfKind: labelOfKind,
    parentRefs: parentRefs,
    derivedOf: derivedOf,
    normalizeRules: normalizeRules,
    rules: rules,
    setRules: setRules,
    /* 每页一份衍生规则表（ui.deriveRulesByPage）：整份读写 + 单页读写 + 一页生效表 */
    tables: tables,
    setTables: setTables,
    tableFor: tableFor,
    hasTable: hasTable,
    rulesFor: rulesFor,
    setTable: setTable,
    knownRules: knownRules,
    languages: languages,
    langLabel: langLabel,
  };

  /* ── 实例：只做「读写 store + 从 RS.notes 取当前字节」，逻辑一律交给上面的纯函数 ── */
  function create(ctx) {
    const c = ctx || {};
    const t = (s) => (c.t ? c.t(s) : s);
    const api = () => (c.api ? c.api() : typeof window !== "undefined" ? window.api : null) || {};
    function join() {
      const list = Array.prototype.slice.call(arguments).filter((x) => x != null && str(x) !== "");
      if (typeof c.joinP === "function") return c.joinP.apply(null, list);
      const a = api();
      if (a && typeof a.pathJoin === "function") return a.pathJoin.apply(a, list);
      return list.join("/").replace(/\/{2,}/g, "/");
    }
    function rootDir() {
      try {
        return str(typeof c.root === "function" ? c.root() : c.root);
      } catch (_) {
        return "";
      }
    }
    function notes() {
      try {
        return (c.notes && c.notes()) || [];
      } catch (_) {
        return [];
      }
    }
    function noteOf(rel) {
      const want = normRel(rel);
      return notes().filter((n) => normRel(n.path) === want)[0] || null;
    }
    function docs() {
      return notes().map((n) => ({ path: n.path, title: n.title, md: n.md, meta: n.meta || {} }));
    }

    const V = { root: "", store: null, loaded: false, loading: null, groups: null, groupsFor: null, groupsSig: "" };

    /* ── 规则表（种类 + 语言）的来路 ──
     * ① 宿主注入：c.rules() / c.KINDS（宿主自己握着默认表时以它为准，页表仍读盘）；
     * ② 否则读 <research>/research.json：ui.deriveRules 是默认表（新页默认值），
     *   ui.deriveRulesByPage 是每页一份（键 = 页相对路径）—— 与 research-derive.js 读写的是
     *   同一批键，所以「衍生物模块写进某一页的新语言」这里立刻认得，不需要两边各配一份；
     * ③ 都没有（没配置 / 读不到）→ normalizeRules 兜底成默认那四条，页表为空（每页都用默认表）。
     * 生效表整进程只有一份（setRules + PAGE_TABLES），于是左栏树、视图外壳、衍生物模块的口径永远一致。 */
    const R = { root: "", loaded: false, loading: null };
    function injectedRules() {
      for (const src of [c.rules, c.KINDS]) {
        let v = src;
        try {
          if (typeof v === "function") v = v();
        } catch (_) {
          v = null;
        }
        if (Array.isArray(v) && v.length) return v;
      }
      return null;
    }
    function ensureRules() {
      const inj = injectedRules();
      if (inj) {
        setRules(inj);
        R.loaded = true;
        return Promise.resolve(rules());
      }
      const r = rootDir();
      if (!r) return Promise.resolve(rules());
      if (R.root !== r) {
        R.root = r;
        R.loaded = false;
        R.loading = null;
      }
      if (R.loaded) return Promise.resolve(rules());
      if (R.loading) return R.loading;
      R.loading = readText(join(r, META_FILE))
        .then((raw) => {
          let list = null;
          let byPage = null;
          const s = str(raw).trim();
          if (s) {
            try {
              const meta = JSON.parse(s);
              list = meta && meta.ui ? meta.ui.deriveRules : null;
              byPage = meta && meta.ui ? meta.ui.deriveRulesByPage : null;
            } catch (_) {
              list = null;
              byPage = null;
            }
          }
          /* 页级表先落地：紧接着那次 setRules 会作废辨认缓存，两张表因此同一步生效 */
          setTables(byPage);
          return setRules(list);
        })
        .catch(() => setRules(null))
        .then((out) => {
          R.loaded = true;
          R.loading = null;
          /* 表可能刚换过（新语言 / 改了后缀）：已算好的版本组作废，下一次按新表重算 */
          V.groups = null;
          V.groupsFor = null;
          return out;
        });
      return R.loading;
    }

    function storePath() {
      const r = rootDir();
      return r ? join(r, STORE_FILE) : "";
    }
    async function readText(abs) {
      const a = api();
      if (!a || typeof a.fileReadText !== "function") return "";
      try {
        const r = await a.fileReadText(abs);
        return r && r.exists ? str(r.content) : "";
      } catch (_) {
        return "";
      }
    }
    async function readStoreFile() {
      const p = storePath();
      if (!p) return emptyStore();
      const raw = (await readText(p)).trim();
      if (!raw) return emptyStore();
      try {
        return normalizeStore(JSON.parse(raw));
      } catch (_) {
        /* 坏文件不阻断研究视图：当作「还没有基线」，下次 commit 会整份重写 */
        return emptyStore();
      }
    }
    function ensureLoaded() {
      const r = rootDir();
      if (!r) return Promise.resolve(null);
      if (V.root !== r) {
        V.root = r;
        V.store = null;
        V.loaded = false;
        V.loading = null;
        V.groups = null;
        V.groupsFor = null;
      }
      if (V.loaded) return Promise.resolve(V.store);
      if (V.loading) return V.loading;
      /* 规则表先落地：归组 / 判色都要用它，store 读完后重算的组才不会按旧的四条表算 */
      V.loading = ensureRules()
        .catch(() => null)
        .then(readStoreFile)
        .then((s) => {
          V.store = s;
          V.loaded = true;
          V.loading = null;
          return s;
        })
        .catch(() => {
          V.store = emptyStore();
          V.loaded = true;
          V.loading = null;
          return V.store;
        });
      return V.loading;
    }
    async function writeStore(store) {
      const r = rootDir();
      if (!r) throw new Error(t("还没有工作目录：先设置画布的工作目录"));
      const a = api();
      if (!a || typeof a.fileWriteText !== "function") throw new Error(t("主进程没有写文件的接口"));
      try {
        if (typeof a.fileMkdir === "function") await a.fileMkdir(r);
      } catch (_) {}
      const next = normalizeStore(store);
      const res = await a.fileWriteText(join(r, STORE_FILE), JSON.stringify(next, null, 2));
      if (res && res.ok === false) throw new Error(str(res.error || t("写文件失败")));
      V.root = r;
      V.store = next;
      V.loaded = true;
      return next;
    }
    /* commit(patch)：markBaseline 算出来的 patch 落盘（生成成功 / 扩散成功时由调用方调） */
    async function commit(patch) {
      if (!patch || !patch.groups) return V.store;
      const cur = (await ensureLoaded()) || emptyStore();
      return writeStore(mergePatch(cur, patch));
    }

    /* 组（同一份 RS.notes 上缓存；notes 数组换了实例、或规则表被换过才重算） */
    function rulesSig() {
      /* 归组口径是「默认表 + 各页表」的并集（knownRules），签名也跟着它走 ——
         否则某页新加了一种语言，这份缓存不会重算，树上那份稿子仍被当成非标准变体 */
      return knownRules()
        .map((r) => r.id + ":" + r.derived + ":" + r.lang + ":" + r.suffix)
        .join("|");
    }
    function groups() {
      const arr = notes();
      const sig = rulesSig();
      if (V.groups && V.groupsFor === arr && V.groupsSig === sig) return V.groups;
      V.groups = buildGroups(arr.map((n) => ({ path: n.path, title: n.title, meta: n.meta || {} })));
      V.groupsFor = arr;
      V.groupsSig = sig;
      return V.groups;
    }
    function groupOf(rel) {
      return groupFor(groups(), rel);
    }
    function siblingsOf(rel) {
      const want = normRel(rel);
      const g = groupOf(want);
      return g ? g.members.filter((m) => m.path !== want) : [];
    }
    function mdOf(rel) {
      const n = noteOf(rel);
      return n ? str(n.md) : null;
    }
    /* 判色要哈希整篇字节：树逐行问、平铺条逐颗问，同一轮里同一份文件只算一次哈希
       （笔记数组换了 / store 换了就整份作废，绝不拿上一轮的结论）。
       stateOf(rel)：读当前 RS.notes 里的字节，与基线比。store 还没加载时一律 absent（不上色） */
    let stMemo = { notes: null, store: null, map: null };
    function stateOf(rel) {
      const want = normRel(rel);
      const arr = notes();
      if (!stMemo.map || stMemo.notes !== arr || stMemo.store !== V.store) {
        stMemo = { notes: arr, store: V.store, map: Object.create(null) };
      }
      const md = mdOf(want);
      const hit = stMemo.map[want];
      /* 同一篇的字节换了（保存落盘 / 扩散后同步 / 撤销重做都是就地换掉那份 md）就必须重判：
         没改时是同一个字符串对象，比较是 O(1)；改了才走一次哈希 —— 绝不拿上一轮的结论 */
      if (hit && hit.md === md) return hit.st;
      const st = stateOfPure(V.store, want, md);
      stMemo.map[want] = { st: st, md: md };
      return st;
    }
    /* groupStatus(members)：组内四态。members 只给 path / exists，当前字节从 RS.notes 补上，
       判色本身一律交给纯函数 statusOfGroup —— 树、顶栏、平铺条都问这一个口。 */
    function groupStatus(members) {
      const list = (Array.isArray(members) ? members : []).map((m) => ({
        path: m && m.path,
        exists: !!m && m.exists !== false,
        md: m && m.path ? mdOf(m.path) : null,
      }));
      return statusOfGroup(list, V.store, rules());
    }
    function hashOf(rel) {
      const md = mdOf(rel);
      return md == null ? "" : hashText(md);
    }
    /* markBaseline(paths)：只算不写，返回 { store, patch, paths, skipped } */
    function markBaseline(paths) {
      const list = (Array.isArray(paths) ? paths : [paths]).filter(Boolean);
      const entries = [];
      const skipped = [];
      for (const p of list) {
        const rel = normRel(p);
        const n = noteOf(rel);
        if (!n) {
          skipped.push({ path: rel, reason: "notfound" });
          continue;
        }
        const g = groupOf(rel);
        const member = g ? g.members.filter((m) => m.path === rel)[0] || null : null;
        entries.push({
          path: rel,
          md: n.md,
          title: g && g.title ? g.title : n.title,
          group: g ? g.key : "",
          kind: member ? member.kind : "",
          lang: member ? member.lang : "",
        });
      }
      const res = markBaselinePure(V.store || emptyStore(), entries);
      res.skipped = res.skipped.concat(skipped);
      return res;
    }
    function planSpread(gold, opts) {
      const o = opts || {};
      return planSpreadPure({
        store: V.store,
        groups: groups(),
        gold: gold,
        targets: o.targets,
      });
    }

    return {
      version: 1,
      /* store 读写 */
      storePath: storePath,
      ensureLoaded: ensureLoaded,
      refresh: ensureLoaded,
      writeStore: writeStore,
      commit: commit,
      /* 组 */
      docs: docs,
      groups: groups,
      groupOf: groupOf,
      siblingsOf: siblingsOf,
      /* 三态 */
      stateOf: stateOf,
      /* 四态判色（灰 / 绿 / 橙 / 金）：树 / 顶栏 chip / 平铺条共用 */
      groupStatus: groupStatus,
      hashOf: hashOf,
      entryOf: (rel) => entryOf(V.store, rel),
      /* 只算不写 */
      markBaseline: markBaseline,
      planSpread: planSpread,
      /* 规则表（种类 + 语言）：宿主注入了就以此为准，否则读 research.json */
      ensureRules: ensureRules,
      rules: rules,
      setRules: setRules,
      /* 页级表（与纯函数同一份，供宿主直接读写一页） */
      tables: tables,
      setTables: setTables,
      tableFor: tableFor,
      hasTable: hasTable,
      rulesFor: rulesFor,
      setTable: setTable,
      knownRules: knownRules,
      languages: languages,
      langLabel: langLabel,
      detectLang: detectLang,
      /* 给调试 / 复核用 */
      state: V,
      get KINDS() {
        return rules();
      },
      get KIND_ORDER() {
        return kindOrder();
      },
      STORE_FILE: STORE_FILE,
      META_FILE: META_FILE,
      ORIGINAL: ORIGINAL,
      _pure: PURE,
    };
  }

  /* 实例里用到的纯函数别名（避免与实例方法同名互相遮住） */
  const stateOfPure = stateOf;
  const markBaselinePure = markBaseline;
  const planSpreadPure = planSpread;

  return {
    VER: VER,
    STORE_FILE: STORE_FILE,
    META_FILE: META_FILE,
    ORIGINAL: ORIGINAL,
    /* 规则表（种类 + 语言）· 唯一一份：默认值、归一化、当前生效那份、语言清单 */
    DEFAULT_RULES: DEFAULT_RULES,
    PASS3_RULES: PASS3_RULES,
    migrateLegacyTable: migrateLegacyTable,
    migrateUiRules: migrateUiRules,
    normalizeRule: normalizeRule,
    normalizeRules: normalizeRules,
    rules: rules,
    setRules: setRules,
    /* 每页一份衍生规则表：一页 = 一个 md 文档，缺省落到「新页默认值」 */
    tables: tables,
    setTables: setTables,
    tableFor: tableFor,
    hasTable: hasTable,
    rulesFor: rulesFor,
    setTable: setTable,
    knownRules: knownRules,
    languages: languages,
    langLabel: langLabel,
    /* 原文语言判定：默认变体（中译 / 英译）按它挑，见 detectLang */
    detectLang: detectLang,
    get KINDS() {
      return rules();
    },
    get KIND_ORDER() {
      return kindOrder();
    },
    create: create,
    /* 纯函数（宿主 / 自检 / node 里人工复核都走这一份） */
    buildGroups: buildGroups,
    groupOf: groupOf,
    siblingsOf: siblingsOf,
    stateOf: stateOf,
    statusOfGroup: statusOfGroup,
    markBaseline: markBaseline,
    mergePatch: mergePatch,
    planSpread: planSpread,
    entryOf: entryOf,
    normalizeStore: normalizeStore,
    hashText: hashText,
    targetRel: targetRel,
    kindIdOf: kindIdOf,
    kindOf: kindOf,
    langOf: langOf,
    labelOfKind: labelOfKind,
    keyOfRel: keyOfRel,
    baseKeyOf: baseKeyOf,
    suffixOf: suffixOf,
    parentRefs: parentRefs,
    derivedOf: derivedOf,
    normRel: normRel,
    baseNoExt: baseNoExt,
    dirOf: dirOf,
  };
});
