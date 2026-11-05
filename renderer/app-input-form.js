/* ============ 表单输入节点（kind: input_form） ============
 *
 * 需求（用户共识，改之前先读这一段）：
 *   输入节点族里多一种「表单」：本体就是一份设计好结构的 JSON，供人填写 / 拖入素材；
 *   图像与视频可以写描述、打标签、做注释（图像矩形框 · 视频时间点 / 起止段），
 *   描述可由识图模型自动补充；Agent 每次 @引用 都能看到（摘要进上下文 + 全文落盘可读）。
 *
 * 真源分工（别在别处再写一套）：
 *   · 节点默认值 / 端子数 / 取值 / @引用：renderer/app.js（NODE_DEFAULTS.input_form /
 *     inputCount / outputCount / isTextSource / valueForInput / allTextItems）
 *   · 板身渲染挂载点：renderer/app-canvas.js（buildBody 里 IF.renderBody）
 *   · 本文件：字段模型、模板、JSON 组包与摘要、落盘 / 回读、大面板（拖入 / 标注 / 识图 / 联动）
 *
 * 数据形态（节点上的字段）：
 *   node.formName  模板 / 表单名（默认「表单」）
 *   node.fields    [{ id, label, type, required, hint, options[], default, calc, showWhen, children[] }]
 *   node.values    { 字段id: 值 }；媒体值是 { path, name, desc, tags[], marks[] }；
 *                  列表值是 [{ id, values:{ 子字段id: 值 } }]
 *   node.formFile  相对工作目录的落盘路径（mtnode-forms/<名字>.json；没设工作目录时为 ""）
 *   node.formMtime 上次与磁盘同步时的文件 mtime（冲突判定 = 谁的时间新谁赢）
 *   node.formStamp 本地最后一次编辑时间（ms）
 *
 * 落盘 / 回读口径（用户共识）：展开大面板时与「刷新」按钮各检查一次 mtime；
 * 值与字段结构都回读，结构不合法整份拒收并保留节点原值。
 */
(function () {
  "use strict";

  const FIELD_TYPES = [
    { id: "text", label: "单行文本" },
    { id: "textarea", label: "多行文本" },
    { id: "number", label: "数字" },
    { id: "select", label: "单选" },
    { id: "multiselect", label: "多选" },
    { id: "switch", label: "开关" },
    { id: "image", label: "图像" },
    { id: "video", label: "视频" },
    { id: "audio", label: "音频" },
    { id: "file", label: "文件" },
    { id: "datetime", label: "日期时间" },
    { id: "list", label: "列表（可增删行）" },
  ];
  const MEDIA_TYPES = { image: 1, video: 1, audio: 1, file: 1 };
  const TYPE_ACCEPT = {
    image: "png,jpg,jpeg,webp,gif,bmp,avif",
    video: "mp4,mov,mkv,webm,avi,m4v",
    audio: "mp3,wav,m4a,flac,aac,ogg",
    file: "*",
  };

  let _uidSeq = 0;
  function fid(p) {
    _uidSeq += 1;
    return String(p || "f") + Date.now().toString(36).slice(-4) + _uidSeq.toString(36);
  }
  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = String(text);
    return n;
  }
  function T(s) {
    return typeof I18n !== "undefined" && I18n.t ? I18n.t(s) : s;
  }
  function nodeOf(id) {
    try {
      return typeof nodeById === "function" ? nodeById(id) : null;
    } catch (_) {
      return null;
    }
  }
  function num(v, dflt) {
    const n = Number(v);
    return Number.isFinite(n) ? n : dflt || 0;
  }

  /* ---------------- 字段与值 ---------------- */

  function blankField(type) {
    const t = FIELD_TYPES.some((x) => x.id === type) ? type : "text";
    return {
      id: fid(t === "list" ? "ls" : "fd"),
      label: (FIELD_TYPES.find((x) => x.id === t) || {}).label || "字段",
      type: t,
      required: false,
      hint: "",
      options: t === "select" || t === "multiselect" ? ["选项一", "选项二"] : [],
      default: "",
      calc: "",
      showWhen: null,
      children: t === "list" ? [blankField("text"), blankField("textarea")] : [],
    };
  }
  /* 归一化一律**就地改写**（保持对象身份不变）：面板里的闭包（media / 字段引用）依赖
     身份稳定，一旦换成新对象，刚敲的字就写进了已经不在节点上的旧对象里。 */
  function normField(f) {
    if (!f || typeof f !== "object") f = {};
    const type = FIELD_TYPES.some((x) => x.id === f.type) ? f.type : "text";
    if (!f.id) f.id = fid(type === "list" ? "ls" : "fd");
    f.id = String(f.id);
    f.label = String(f.label || "字段");
    f.type = type;
    f.required = !!f.required;
    f.hint = String(f.hint || "");
    f.options = Array.isArray(f.options) ? f.options.map((x) => String(x)) : [];
    if (f.default == null) f.default = "";
    f.calc = String(f.calc || "");
    if (f.showWhen && f.showWhen.field) {
      f.showWhen = {
        field: String(f.showWhen.field),
        op: String(f.showWhen.op || "notEmpty"),
        value: f.showWhen.value != null ? String(f.showWhen.value) : "",
      };
    } else {
      f.showWhen = null;
    }
    if (type === "list") {
      /* 列表的子字段不许再嵌列表（嵌套列表 UI 与摘要都会失控），其余类型照旧全留着：
         注意别把「简单类型」过滤掉 —— 镜号 / 景别 / 时长这些正是列表行里最常见的子字段。 */
      const kids = (Array.isArray(f.children) ? f.children : []).filter(
        (c) => c && c.type !== "list",
      );
      f.children = kids.map(normField);
      if (!f.children.length) f.children = [blankField("text"), blankField("textarea")];
    } else {
      f.children = [];
    }
    return f;
  }
  function blankValue(f) {
    if (f.type === "switch") return false;
    if (f.type === "multiselect") return [];
    if (f.type === "list") return [];
    if (MEDIA_TYPES[f.type] === 1) return null;
    if (f.type === "number") return "";
    return "";
  }
  function normMedia(v) {
    if (!v || typeof v !== "object" || !v.path) return null;
    v.path = String(v.path);
    /* 名字为空时按路径补（板身 / 摘要 / 素材行都要显示文件名） */
    v.name = String(v.name || v.path.split(/[\\/]/).filter(Boolean).pop() || "");
    v.desc = String(v.desc || "");
    v.tags = Array.isArray(v.tags) ? v.tags.map((x) => String(x)) : [];
    v.marks = (Array.isArray(v.marks) ? v.marks : [])
      .filter((m) => m && typeof m === "object")
      .map((m) => {
        m.id = String(m.id || fid("mk"));
        m.text = String(m.text || "");
        m.x = num(m.x, NaN);
        m.y = num(m.y, NaN);
        m.w = num(m.w, NaN);
        m.h = num(m.h, NaN);
        m.start = m.start != null && m.start !== "" ? num(m.start, 0) : null;
        m.end = m.end != null && m.end !== "" ? num(m.end, 0) : null;
        return m;
      });
    return v;
  }
  function normRow(f, row) {
    if (!row || typeof row !== "object") row = {};
    if (!row.id) row.id = fid("rw");
    row.id = String(row.id);
    if (!row.values || typeof row.values !== "object") row.values = {};
    for (const c of f.children || []) row.values[c.id] = normValue(c, row.values[c.id]);
    return row;
  }
  function normValue(f, v) {
    if (MEDIA_TYPES[f.type] === 1) return normMedia(v);
    if (f.type === "list") {
      const arr = Array.isArray(v) ? v : [];
      for (let i = 0; i < arr.length; i++) arr[i] = normRow(f, arr[i]);
      return arr;
    }
    if (f.type === "switch") return v === true;
    if (f.type === "multiselect") return Array.isArray(v) ? v.map((x) => String(x)) : [];
    if (f.type === "number") return v === "" || v == null ? "" : num(v, "");
    if (f.type === "select") return v == null ? "" : String(v);
    return v == null ? "" : String(v);
  }

  /* 外部引用条目（从输入端子连入后被吸收的一份拷贝）：形状固定，缺项补齐。
     kind = text | image | video | audio | file（来源给什么就记什么），
     text / path 二者按来源类型至少有一个非空。 */
  function normRef(r) {
    if (!r || typeof r !== "object") return null;
    const kind = String(r.kind || "text");
    const text = r.text == null ? "" : String(r.text);
    const path = r.path == null ? "" : String(r.path);
    if (!text && !path) return null;
    return {
      fromTitle: String(r.fromTitle || ""),
      kind,
      text,
      path,
      at: num(r.at, 0),
    };
  }
  /* 节点归一化：缺字段补齐（老画布 / 手工改坏的文件都走这里） */
  function normalize(node) {
    if (!node) return null;
    if (!String(node.formName || "").trim()) node.formName = T("表单");
    if (!Array.isArray(node.fields) || !node.fields.length) node.fields = defaultTemplateFields();
    node.fields = node.fields.map(normField);
    if (!node.values || typeof node.values !== "object") node.values = {};
    for (const f of node.fields) {
      node.values[f.id] = normValue(f, node.values[f.id]);
    }
    /* 外部引用（吸收来的拷贝）与板身折叠状态：老节点没有这两个键，一律补成空 */
    node.refs = (Array.isArray(node.refs) ? node.refs : []).map(normRef).filter(Boolean);
    const ids = new Set(node.fields.map((f) => f.id));
    node.uiCollapsed = (Array.isArray(node.uiCollapsed) ? node.uiCollapsed : [])
      .map((x) => String(x))
      .filter((x, i, arr) => ids.has(x) && arr.indexOf(x) === i);
    applyDefaultsAndCalc(node);
    return node;
  }

  /* ---------------- 模板 ---------------- */

  function mediaField(label, type, extra) {
    return Object.assign(blankField(type), { label }, extra || {});
  }
  function listField(label, children) {
    const f = blankField("list");
    f.label = label;
    f.children = children;
    return f;
  }

  const BUILTIN_TEMPLATES = [
    {
      id: "tpl_material",
      name: "素材清单",
      desc: "多条图像 / 视频 + 描述 + 用途",
      fields: () => [
        mediaField("封面", "image"),
        listField("素材", [
          mediaField("图像 / 视频", "image"),
          Object.assign(blankField("textarea"), { label: "描述" }),
          Object.assign(blankField("text"), { label: "标签", hint: "逗号分隔" }),
          Object.assign(blankField("text"), { label: "用途" }),
        ]),
        Object.assign(blankField("textarea"), { label: "整体说明" }),
      ],
    },
    {
      id: "tpl_character",
      name: "角色设定",
      desc: "外貌 / 服装 / 性格 + 参考图",
      fields: () => [
        Object.assign(blankField("text"), { label: "角色名", required: true }),
        Object.assign(blankField("textarea"), { label: "外貌" }),
        Object.assign(blankField("textarea"), { label: "服装" }),
        Object.assign(blankField("textarea"), { label: "性格" }),
        Object.assign(blankField("image"), { label: "三视图" }),
        listField("参考图", [
          mediaField("图像", "image"),
          Object.assign(blankField("text"), { label: "说明" }),
        ]),
      ],
    },
    {
      id: "tpl_shot",
      name: "分镜镜头",
      desc: "镜号 / 景别 / 运镜 / 时长 / 参考帧",
      fields: () => [
        listField("镜头", [
          Object.assign(blankField("text"), { label: "镜号" }),
          Object.assign(blankField("textarea"), { label: "画面" }),
          Object.assign(blankField("select"), {
            label: "景别",
            options: ["远景", "全景", "中景", "近景", "特写"],
          }),
          Object.assign(blankField("select"), {
            label: "运镜",
            options: ["固定", "推", "拉", "摇", "移", "跟"],
          }),
          Object.assign(blankField("number"), { label: "时长（秒）", default: "5" }),
          mediaField("参考帧", "image"),
        ]),
        Object.assign(blankField("text"), {
          label: "总时长",
          calc: "h.sum(h.col(v.镜头, '时长（秒）'))",
        }),
      ],
    },
    {
      id: "tpl_product",
      name: "产品图集",
      desc: "多角度图 + 卖点",
      fields: () => [
        Object.assign(blankField("text"), { label: "产品名", required: true }),
        listField("角度图", [
          mediaField("图像", "image"),
          Object.assign(blankField("text"), { label: "角度" }),
          Object.assign(blankField("textarea"), { label: "卖点" }),
        ]),
        Object.assign(blankField("textarea"), { label: "整体卖点" }),
      ],
    },
    {
      id: "tpl_params",
      name: "通用参数表",
      desc: "风格 / 比例 / 数量 / 开关",
      fields: () => [
        Object.assign(blankField("text"), { label: "风格", default: "cinematic" }),
        Object.assign(blankField("select"), { label: "比例", options: ["16:9", "9:16", "1:1", "4:3"], default: "16:9" }),
        Object.assign(blankField("number"), { label: "张数", default: "4" }),
        Object.assign(blankField("switch"), { label: "带字幕" }),
        Object.assign(blankField("text"), {
          label: "提示词",
          calc: "v.风格 + ' · ' + v.比例 + ' · ' + v.张数 + ' 张'",
        }),
      ],
    },
  ];

  function defaultTemplateFields() {
    return BUILTIN_TEMPLATES[0].fields().map(normField);
  }
  function builtinTemplates() {
    return BUILTIN_TEMPLATES.map((t) => ({
      id: t.id,
      name: t.name,
      desc: t.desc,
      builtin: true,
      fields: t.fields().map(normField),
    }));
  }
  function myTemplates() {
    const list = (typeof S !== "undefined" && S.config && S.config.inputFormTemplates) || [];
    return Array.isArray(list)
      ? list
          .filter((t) => t && Array.isArray(t.fields))
          .map((t) => ({
            id: String(t.id || ""),
            name: String(t.name || "我的模板"),
            desc: String(t.desc || "自建模板"),
            fields: t.fields.map(normField),
          }))
      : [];
  }
  function allTemplates() {
    return builtinTemplates().concat(myTemplates());
  }
  async function saveAsMyTemplate(node) {
    normalize(node);
    if (typeof S === "undefined" || !S.config) return null;
    const name = String(node.formName || "我的模板").trim() || "我的模板";
    const list = Array.isArray(S.config.inputFormTemplates) ? S.config.inputFormTemplates.slice() : [];
    list.push({
      id: "my_" + Date.now().toString(36),
      name,
      desc: T("自建模板") + " · " + node.fields.length + T(" 个字段"),
      fields: JSON.parse(JSON.stringify(node.fields)),
    });
    S.config.inputFormTemplates = list.slice(-40);
    try {
      if (window.api && window.api.configSave) await window.api.configSave(S.config);
    } catch (_) {}
    return name;
  }
  function applyTemplate(node, tplId, opts) {
    const tpl = allTemplates().find((t) => t.id === tplId);
    if (!tpl) return false;
    normalize(node);
    const keepValues = !!(opts && opts.keepValues);
    const prev = keepValues ? node.values : {};
    node.formName = tpl.name;
    node.fields = tpl.fields.map((f) => normField(JSON.parse(JSON.stringify(f))));
    node.values = {};
    /* 换了字段集：板身的「默认只展开前 3 行」要按新字段重算一次折叠状态 */
    node.uiCollapsed = [];
    BD.seeded[node.id] = false;
    /* 同名字段沿用旧值：换模板不该把已经填好的内容清掉（用户共识：模板是起步形态） */
    const byLabel = {};
    for (const f of node.fields) byLabel[f.label] = f;
    for (const k of Object.keys(prev)) {
      const old = (opts && opts.oldFields ? opts.oldFields : []).find((x) => x.id === k);
      const tgt = old ? byLabel[old.label] : null;
      if (tgt) node.values[tgt.id] = normValue(tgt, prev[k]);
    }
    for (const f of node.fields) if (!(f.id in node.values)) node.values[f.id] = blankValue(f);
    applyDefaultsAndCalc(node);
    return true;
  }

  /* ---------------- 联动：显示规则 + 默认值 / 计算 ---------------- */

  const EXPR_BAD = /[;{}\n\r]|=>|\bfunction\b|\bwindow\b|\bdocument\b|\brequire\b|\bglobalThis\b|\bprocess\b|\beval\b|\bimport\b/;
  const HELPERS = {
    sum: (arr) => (Array.isArray(arr) ? arr.reduce((a, b) => a + (Number(b) || 0), 0) : 0),
    len: (arr) => (Array.isArray(arr) ? arr.length : arr ? 1 : 0),
    join: (arr, sep) => (Array.isArray(arr) ? arr.join(sep == null ? "、" : String(sep)) : ""),
    now: () => new Date().toISOString().slice(0, 10),
    /* 一列取值：h.col(列表字段, '时长（秒）') → [3, 4.5]（列表汇总的常用姿势；
       表达式里不许写 function / 箭头函数，取一整列只能靠它） */
    col: (rows, label) =>
      Array.isArray(rows)
        ? rows.map((r) => (r && typeof r === "object" ? r[String(label)] : undefined))
        : [],
  };
  /* 受限表达式：只允许一行简单运算（与长周期任务 cond 同一种克制的口径）。
     作用域：v = 按「字段标签」取值（同名字段也认 id），h = 内置帮手。 */
  function evalExpr(expr, scope, fallback) {
    const s = String(expr || "").trim();
    if (!s) return fallback;
    if (EXPR_BAD.test(s)) return fallback;
    try {
      const fn = new Function("v", "h", '"use strict";return (' + s + ");");
      const out = fn(scope || {}, HELPERS);
      return out === undefined ? fallback : out;
    } catch (_) {
      return fallback;
    }
  }
  function scopeOf(node) {
    const v = {};
    for (const f of node.fields || []) {
      if (f.type === "list") {
        const rows = node.values[f.id] || [];
        v[f.label] = rows.map((r) => {
          const o = {};
          for (const c of f.children || []) o[c.label] = (r.values || {})[c.id];
          return o;
        });
        v[f.id] = v[f.label];
      } else {
        v[f.label] = node.values[f.id];
        v[f.id] = node.values[f.id];
      }
    }
    return v;
  }
  function truthyRule(node, rule) {
    if (!rule || !rule.field) return true;
    const scope = scopeOf(node);
    const cur = scope[rule.field];
    const op = rule.op || "notEmpty";
    if (op === "notEmpty") return Array.isArray(cur) ? cur.length > 0 : cur != null && String(cur).trim() !== "" && cur !== false;
    if (op === "empty") return Array.isArray(cur) ? !cur.length : cur == null || String(cur).trim() === "" || cur === false;
    if (op === "eq") return String(cur) === String(rule.value);
    if (op === "neq") return String(cur) !== String(rule.value);
    if (op === "truthy") return !!cur;
    return true;
  }
  function visibleMap(node) {
    const out = {};
    for (const f of node.fields || []) {
      /* 「引用内容」（refsBox）：从输入端子吸收进来的那份内容**必须看得见** ——
         它由程序自己建、没有真正的依赖字段（老档里写的是一条恒假的 showWhen），
         若按规则判就会隐身：用户把线接到「引用」端子上，线被吸收摘掉、板身却什么都没变，
         看上去就像「引用端子接不进去」。所以这类字段一律按可见处理，板身 / 面板都能读能改。 */
      out[f.id] = f.refsBox ? true : truthyRule(node, f.showWhen);
    }
    return out;
  }
  function applyDefaultsAndCalc(node) {
    normalizeNoLoop(node);
    for (const f of node.fields) {
      const cur = node.values[f.id];
      const empty =
        cur == null ||
        (typeof cur === "string" && !cur.trim()) ||
        (Array.isArray(cur) && !cur.length) ||
        (typeof cur === "number" && !Number.isFinite(cur));
      if (empty && f.default != null && String(f.default) !== "") {
        const dv = String(f.default);
        const val = dv.charAt(0) === "=" ? evalExpr(dv.slice(1), scopeOf(node), blankValue(f)) : dv;
        node.values[f.id] = normValue(f, val);
      }
      if (f.calc && String(f.calc).trim()) {
        const out = evalExpr(f.calc, scopeOf(node), null);
        if (out != null) node.values[f.id] = normValue(f, out);
      }
    }
  }
  /* normalize 内部用的轻量版本（避免递归）：只保证 fields/values 形状存在 */
  function normalizeNoLoop(node) {
    if (!Array.isArray(node.fields)) node.fields = defaultTemplateFields();
    if (!node.values || typeof node.values !== "object") node.values = {};
  }
  function missingRequired(node) {
    const vis = visibleMap(node);
    const out = [];
    for (const f of node.fields || []) {
      if (!f.required || !vis[f.id]) continue;
      const v = node.values[f.id];
      const empty =
        v == null ||
        (typeof v === "string" && !v.trim()) ||
        (Array.isArray(v) && !v.length) ||
        (MEDIA_TYPES[f.type] === 1 && (!v || !v.path));
      if (empty) out.push({ id: f.id, label: f.label });
    }
    return out;
  }

  /* ---------------- JSON / 摘要 / 取值 ---------------- */

  function payload(node) {
    normalize(node);
    return {
      form: node.formName,
      fields: node.fields,
      values: node.values,
      /* 从输入端子吸收进来的外部引用（一次性拷贝；上游后来怎么变都不影响这份） */
      refs: node.refs || [],
      meta: { nodeId: node.id, updatedAt: node.formStamp || 0 },
    };
  }
  function refText(node) {
    return JSON.stringify(payload(node), null, 2);
  }
  function mediaLine(v, type) {
    const bits = [];
    const kind = type === "image" ? "图像" : type === "video" ? "视频" : type === "audio" ? "音频" : "文件";
    bits.push("[" + T(kind) + "] " + (v.name || v.path));
    bits.push(T("路径：") + v.path);
    if (v.desc) bits.push(T("描述：") + v.desc);
    else bits.push(T("描述：（未填）"));
    if (v.tags && v.tags.length) bits.push(T("标签：") + v.tags.join("、"));
    if (v.marks && v.marks.length) {
      const ms = v.marks.map((m) => {
        const where =
          m.start != null || m.end != null
            ? "[" + num(m.start, 0) + "s~" + (m.end != null ? num(m.end, 0) + "s" : T("到结尾")) + "]"
            : Number.isFinite(m.x)
              ? "[" + Math.round(m.x * 100) + "%," + Math.round(m.y * 100) + "% " + Math.round(m.w * 100) + "%x" + Math.round(m.h * 100) + "%]"
              : "";
        return where + (m.text || "");
      });
      bits.push(T("注释：") + ms.join("；"));
    }
    return bits.join(" · ");
  }
  /* 摘要里的一条引用：来源名 — 首行（全文很长，摘要只留能认出来的一句） */
  function firstLineOf(s, max) {
    const t = String(s || "").replace(/\r/g, "").split("\n").find((x) => x.trim()) || "";
    const tt = t.trim();
    const lim = max || 120;
    return tt.length > lim ? tt.slice(0, lim) + "…" : tt;
  }
  function refLine(r) {
    const name = String(r.fromTitle || "").trim() || T("上游");
    const body = r.text
      ? firstLineOf(r.text)
      : r.path
        ? String(r.path).split(/[\\/]/).filter(Boolean).pop() || r.path
        : "";
    const kindTag = r.kind && r.kind !== "text" ? "[" + T(r.kind) + "] " : "";
    return T("引用：") + name + " — " + kindTag + (body || T("（空内容）"));
  }
  function summary(node) {
    normalize(node);
    const vis = visibleMap(node);
    const lines = [];
    const p = filePathOf(node, true);
    lines.push("【" + T("表单") + " · " + String(node.formName || "") + "】" + (p ? T("文件：") + p : T("（未落盘：画布没有设置工作目录）")));
    for (const f of node.fields || []) {
      /* 「引用内容」也是正常字段（板身可见），照常进摘要，Agent @引用 才看得到 */
      if (!vis[f.id] && !f.refsBox) continue;
      const v = node.values[f.id];
      if (f.type === "list") {
        const rows = Array.isArray(v) ? v : [];
        lines.push("- " + f.label + "（" + rows.length + " 行）");
        rows.forEach((r, i) => {
          const cell = (f.children || []).map((c) => {
            const cv = (r.values || {})[c.id];
            if (MEDIA_TYPES[c.type] === 1) return cv && cv.path ? mediaLine(cv, c.type) : c.label + "：—";
            return c.label + "：" + (Array.isArray(cv) ? cv.join("、") : cv === true ? "是" : cv === false ? "否" : String(cv == null ? "" : cv) || "—");
          });
          lines.push("  " + (i + 1) + ") " + cell.join(" | "));
        });
        continue;
      }
      if (MEDIA_TYPES[f.type] === 1) {
        lines.push("- " + f.label + "：" + (v && v.path ? mediaLine(v, f.type) : T("（未填）")));
        continue;
      }
      const shown = Array.isArray(v) ? v.join("、") : v === true ? T("是") : v === false ? T("否") : String(v == null ? "" : v);
      lines.push("- " + f.label + "：" + (shown && shown.trim() ? shown : T("（未填）")));
    }
    /* 外部引用：从输入端子连入时复制进来的那份内容（每条一行：来源名 — 首行） */
    if ((node.refs || []).length) {
      lines.push(T("外部引用（") + node.refs.length + T(" 条 · 已复制进本表单）"));
      for (const r of node.refs) lines.push("- " + refLine(r));
    }
    const miss = missingRequired(node);
    if (miss.length) lines.push(T("未填必填：") + miss.map((x) => x.label).join("、"));
    return lines.join("\n");
  }
  function textOf(node) {
    return summary(node);
  }

  /* ---------------- 落盘 / 回读 ---------------- */

  function safeName(s) {
    return (
      String(s || "")
        .replace(/[\\/:*?"<>|\s]+/g, "_")
        .replace(/^[._]+/, "")
        .slice(0, 40) || "form"
    );
  }
  function workspaceOf(node) {
    try {
      if (typeof wfWorkspace === "function") return String(wfWorkspace() || "");
    } catch (_) {}
    return (typeof S !== "undefined" && S.wf && S.wf.workspace) || "";
  }
  function relPathOf(node) {
    return "mtnode-forms/" + safeName(node.formName) + "-" + String(node.id || "").slice(-4) + ".json";
  }
  function filePathOf(node, force) {
    const ws = workspaceOf(node);
    if (!ws) return "";
    const rel = node.formFile || relPathOf(node);
    if (force) return ws.replace(/[\\/]+$/, "") + "\\" + rel.replace(/\//g, "\\");
    return ws.replace(/[\\/]+$/, "") + "\\" + rel.replace(/\//g, "\\");
  }
  let _writeTimer = null;
  function touch(node, opts) {
    if (!node) return;
    node.formStamp = Date.now();
    try {
      if (typeof scheduleSave === "function") scheduleSave();
    } catch (_) {}
    if (opts && opts.structural) {
      try {
        if (typeof pushHistory === "function") pushHistory();
      } catch (_) {}
    }
    if (_writeTimer) clearTimeout(_writeTimer);
    _writeTimer = setTimeout(() => {
      _writeTimer = null;
      writeFile(node, { silent: true });
    }, 320);
  }
  async function writeFile(node, opts) {
    if (!node) return { ok: false, error: "no-node" };
    const p = filePathOf(node);
    if (!p || !window.api || typeof window.api.fileWriteText !== "function")
      return { ok: false, error: "no-workspace" };
    try {
      const dir = p.replace(/[\\/][^\\/]+$/, "");
      if (typeof window.api.fileMkdir === "function") await window.api.fileMkdir(dir);
      const r = await window.api.fileWriteText(p, JSON.stringify(payload(node), null, 2));
      if (r && r.ok === false) throw new Error(r.error || "写入失败");
      let mt = 0;
      try {
        const st = await window.api.fileStat(p);
        mt = num(st && (st.mtimeMs || st.mtime), 0);
      } catch (_) {}
      node.formFile = node.formFile || relPathOf(node);
      node.formMtime = mt || Date.now();
      IF.ui.lastSavedAt = Date.now();
      if (!opts || !opts.silent) {
        try {
          if (typeof toast === "function") toast(T("已写入：") + p, "ok");
        } catch (_) {}
      }
      return { ok: true, path: p };
    } catch (e) {
      IF.ui.lastError = String((e && e.message) || e);
      if (!opts || !opts.silent) {
        try {
          if (typeof toast === "function") toast(T("写盘失败：") + IF.ui.lastError, "warn");
        } catch (_) {}
      }
      return { ok: false, error: IF.ui.lastError };
    }
  }
  function validExternal(obj) {
    if (!obj || typeof obj !== "object") return false;
    if (!Array.isArray(obj.fields) || !obj.fields.length) return false;
    if (!obj.values || typeof obj.values !== "object") return false;
    for (const f of obj.fields) {
      if (!f || !f.id || !FIELD_TYPES.some((t) => t.id === f.type)) return false;
    }
    return true;
  }
  /* 回读：谁的 mtime 新谁赢（用户共识）。返回 {ok, took, reason} */
  async function readBack(node, opts) {
    if (!node) return { ok: false };
    const p = filePathOf(node);
    if (!p || !window.api || typeof window.api.fileReadText !== "function") return { ok: false, reason: "no-workspace" };
    let st = null;
    try {
      st = await window.api.fileStat(p);
    } catch (_) {}
    if (!st || st.ok === false) return { ok: false, reason: "missing" };
    const mt = num(st.mtimeMs || st.mtime, 0);
    if (!mt) return { ok: false, reason: "no-mtime" };
    if (mt <= num(node.formMtime, 0)) return { ok: true, took: false };
    if (mt <= num(node.formStamp, 0) && num(node.formMtime, 0) > 0) return { ok: true, took: false };
    let txt = "";
    try {
      /* 主进程 file:readText 回的是 { ok, exists, content } —— 不是裸字符串 */
      const rd = await window.api.fileReadText(p);
      txt =
        rd && typeof rd === "object"
          ? rd.exists === false
            ? ""
            : String(rd.content || "")
          : String(rd || "");
    } catch (_) {}
    let obj = null;
    try {
      /* 手改文件常见带 UTF-8 BOM（记事本 / 部分编辑器默认）——先去 BOM 再解析，
         不然一个不可见的 BOM 就会被判成「不是 JSON」而整份拒收。 */
      obj = JSON.parse(String(txt || "").replace(/^\uFEFF/, ""));
    } catch (_) {
      obj = null;
    }
    if (!validExternal(obj)) {
      if (!opts || !opts.silent) {
        try {
          if (typeof toast === "function") toast(T("磁盘上的表单结构不合法，整份拒收：") + p, "warn");
        } catch (_) {}
      }
      node.formMtime = mt;
      return { ok: false, reason: "invalid" };
    }
    const prevFields = (node.fields || []).slice();
    node.fields = obj.fields.map(normField);
    node.values = {};
    for (const f of node.fields) node.values[f.id] = normValue(f, obj.values[f.id]);
    if (obj.form) node.formName = String(obj.form);
    node.formMtime = mt;
    node.formStamp = mt;
    /* 结构变了 → 旧连线 / 下游值失效（与改节点内容同一口径） */
    try {
      if (typeof clearDownstream === "function") clearDownstream(node.id);
      if (typeof scheduleSave === "function") scheduleSave();
      if (typeof renderCanvas === "function") renderCanvas();
    } catch (_) {}
    if (prevFields.length !== node.fields.length && (!opts || !opts.silent)) {
      try {
        if (typeof toast === "function") toast(T("已按磁盘上的 .json 更新字段结构"), "ok");
      } catch (_) {}
    }
    return { ok: true, took: true };
  }

  /* ---------------- 识图补充 ---------------- */

  function videoFrameTimes(duration) {
    const d = num(duration, 0);
    if (!d) return [0];
    const n = d < 2 ? 1 : d < 6 ? 3 : 4;
    const out = [];
    for (let i = 0; i < n; i++) out.push(Math.round(((i + 0.5) / n) * d * 100) / 100);
    return out;
  }
  /* 识图提示词默认值（图像 / 视频各一份）。弹窗里可以改；改过的那份只用于本次识别。
     末句是硬口径：图像随消息一起发给模型，模型只需看图 —— 不许它去找原图 / 读磁盘 /
     调识图工具（过去就是因为这句话没说，模型会先满盘找文件再「用视觉节点读画面」）。 */
  function visionPromptDefault(type) {
    const noGuess = T(
      "图像已随本消息一起发给你：直接看图作答，不要去找图片文件、不要读取磁盘、不要调用任何工具。",
    );
    if (type === "video")
      return (
        T(
          "请用中文直接看这几帧，合成一段可直接给下游复用的视频内容描述（100 字以内：画面里发生了什么 / 主体 / 场景 / 镜头运动），只输出描述正文。",
        ) + noGuess
      );
    return (
      T(
        "请用中文直接看这张图，输出一段可直接给下游复用的内容描述（80 字以内：主体 / 构图 / 风格 / 关键细节），只输出描述正文。",
      ) + noGuess
    );
  }
  /* 识图调用：走应用自己的模型调用（window.api.apiCall → main.js 的 buildRequestSpec），
     图像被压好后以 data URL **直接内联**进 chat/completions 的 user 消息，模型拿到的就是
     像素本身。与工具节点 mtnode_vision（applyVisionInspect）同一条路、同一份路由解析。
     以前走 dsh 的一轮 agent（dshRunTask）：图要先过 dsh 的 durable attachment 与模型输入
     模态门控，模型条目没声明 image 时运行时会把图换成
     「[image omitted because this model accepts text only; attachment sha256:…]」占位文本，
     模型只能回「附件只带一个哈希值，我看不到画面」；而且要绕一整轮工具循环，慢到描述
     迟迟不回填。这条路没有附件服务、没有工具循环：一次请求 = 一段描述。 */
  async function callVisionModel(prompt, images, spec) {
    const sp = spec || {};
    /* 路由：服务商顺序 → 模型顺序，目录标明能吃图的排前面（与 mtnode_vision 同一份
       resolveVisionInspectRoutes）。用户在弹窗里选的那一格排最前，失败自动换下一条。 */
    let routes = [];
    try {
      if (typeof resolveVisionInspectRoutes === "function")
        routes = resolveVisionInspectRoutes(sp.model ? String(sp.model) : "") || [];
    } catch (_) {
      routes = [];
    }
    if (!routes.length)
      throw new Error(T("没有可用的识图模型：请先在「设置 → 模型服务」里配置一个能读图的模型"));
    const wantProv = String(sp.provider || "");
    const isPicked = (r) =>
      !!r &&
      String((r.provider && r.provider.id) || "") === wantProv &&
      (!sp.model || String(r.model) === String(sp.model));
    if (wantProv) {
      const hit = routes.filter(isPicked);
      if (hit.length) routes = hit.concat(routes.filter((r) => !isPicked(r)));
    }
    const failures = [];
    for (let i = 0; i < routes.length; i++) {
      const r = routes[i];
      const label = String(r.providerName || (r.provider && r.provider.id) || "") + " / " + r.model;
      /* 服务商副本上钉 vision：main.js 只在 provider.vision 时才把图拼进 parts */
      const provider = Object.assign({}, r.provider, { vision: true });
      let rr = null;
      try {
        rr = await window.api.apiCall({
          provider,
          kind: "text",
          model: r.model,
          prompt,
          texts: [],
          images,
          temperature: 0.2,
          effort: sp.effort || "off",
          abKey: sp.abKey || "",
        });
      } catch (e) {
        const msg = String((e && e.message) || e);
        failures.push(label + " → " + msg);
        continue;
      }
      if (rr && rr.ok) {
        const text = String(rr.text || "").trim();
        /* 占位文本：模型根本没看到像素，绝不能当成描述写回素材 */
        if (textOnlyImageReply(text))
          throw new Error(
            T("所选模型不支持读图（图片被换成了占位文字），请换一个能读图的模型后重试"),
          );
        if (text) return text;
        failures.push(label + " → " + T("模型没有返回任何内容"));
        continue;
      }
      const err = String((rr && rr.error) || T("识图调用失败"));
      failures.push(label + " → " + err);
      if (typeof isCancelishError === "function" && isCancelishError(err)) throw new Error(err);
    }
    throw new Error(failures.join("\n") || T("识图调用失败"));
  }
  /* spec（可选）= 弹窗里选的识图档：{ provider, model, effort, prompt }。
     · prompt = 用户改过的提示词（空 = 用 visionPromptDefault）；
     · 一次单轮调用，不带人设 / 不带工具：识图是「看一张图」，不是「派个 agent 去办」。 */
  async function describeMedia(node, media, type, spec) {
    if (!media || !media.path) return "";
    if (!window.api || typeof window.api.apiCall !== "function")
      throw new Error(T("识图入口不可用"));
    /* 文件真的在盘上才发；找不到就明确报错，不让模型自己去找（那一步既慢又不可控） */
    let st = null;
    try {
      if (window.api && typeof window.api.fileStat === "function")
        st = await window.api.fileStat(media.path);
    } catch (_) {
      st = null;
    }
    if (st && st.ok === false) throw new Error(T("图片文件不存在：") + media.path);
    const sp = spec || {};
    const ask = String(sp.prompt || "").trim();
    const abKey = "vision:" + String((node && node.id) || "");
    const spec2 = {
      provider: sp.provider || "",
      model: sp.model || "",
      effort: sp.effort || "off",
      abKey,
    };
    if (type === "image") {
      const text = await callVisionModel(ask || visionPromptDefault("image"), [media.path], spec2);
      return String(text || "").trim().slice(0, 400);
    }
    if (type === "video") {
      let frames = [];
      try {
        const probe = await window.api.qaProbe({ path: media.path });
        const times = videoFrameTimes(probe && (probe.durationSec || probe.duration));
        const r = await window.api.qaFrames({ path: media.path, times, shotId: "input-form" });
        frames = (r && r.frames ? r.frames : []).map((f) => f.path).filter(Boolean);
      } catch (_) {}
      if (!frames.length) throw new Error(T("抽帧失败，没法识图"));
      const text = await callVisionModel(
        T("这是同一个视频按时间顺序抽出的 ") +
          frames.length +
          T(" 帧。") +
          (ask || visionPromptDefault("video")),
        frames.slice(0, 6),
        spec2,
      );
      return String(text || "").trim().slice(0, 500);
    }
    return "";
  }
  /* ---- 识图在途登记（用户要求：识图运行要进左下角运行队列，看得见、停得掉）----
     不挂 node.running：那套是画布处理节点的运行态（会被扫幽灵、级联、串行队列接管），
     识图只是给素材补一段描述。这里单独一张在途表，app.js 的 collectRunQueueAll 读它
     出一行（类型仍是节点行：点行定位节点），行内 ■ 按 runKey 精确取消这一轮。 */
  const visionRuns =
    typeof window !== "undefined"
      ? (window.MTNodeVisionRuns = window.MTNodeVisionRuns || { rows: new Map() })
      : { rows: new Map() };
  function visionRunBegin(node, type) {
    if (!visionRuns || !visionRuns.rows) return "";
    try {
      const key = "v" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      visionRuns.rows.set(key, {
        key,
        nodeId: (node && node.id) || "",
        title: (node && node.title) || T("表单"),
        type: type === "video" ? "video" : "image",
        /* 取消这一轮 = 按 abKey 中止主进程那次 chat/completions 请求（见 describeMedia） */
        abKey: "vision:" + String((node && node.id) || ""),
        runKey: (node && node.id) || "vision",
        startedAt: Date.now(),
      });
      if (typeof updateRunQueuePanel === "function") updateRunQueuePanel();
      return key;
    } catch (_) {
      return "";
    }
  }
  function visionRunEnd(key) {
    if (!key || !visionRuns || !visionRuns.rows) return;
    try {
      visionRuns.rows.delete(key);
      if (typeof updateRunQueuePanel === "function") updateRunQueuePanel();
    } catch (_) {}
  }
  async function autoDescribe(node, field, media, spec) {
    if (!media || !media.path) return false;
    const vkey = visionRunBegin(node, field && field.type);
    try {
      const desc = await describeMedia(node, media, field.type, spec);
      if (!desc) return false;
      media.desc = desc;
      touch(node);
      return true;
    } catch (e) {
      /* 用户在运行队列里按了 ■：这是他要的结果，不要再报一次「识图失败」 */
      const msg = String((e && e.message) || e);
      if (typeof isCancelishError === "function" && isCancelishError(msg)) return false;
      try {
        if (typeof toast === "function") toast(T("识图失败：") + msg, "warn");
      } catch (_) {}
      return false;
    } finally {
      visionRunEnd(vkey);
    }
  }

  /* ---- 识图确认弹窗（用户共识）：模型可换、默认「无思考」档、出口只有「识图」和「关闭」 ---- */

  /* 候选 = 「能读图」的路由，直接复用 mtnode_vision 的那份解析
     （resolveVisionInspectRoutes：只收配了文本能力、目录标注了 image 的模型或服务商
     明明带 vision 开关的模型）。这样清单里不会再出现 TTS / 本地文本模型 ——
     把图发给那种模型只会得到「我看不到这张图」。 */
  function visionCandidates() {
    let routes = [];
    try {
      if (typeof resolveVisionInspectRoutes === "function")
        routes = resolveVisionInspectRoutes("") || [];
    } catch (_) {
      routes = [];
    }
    const out = [];
    const seen = new Set();
    for (const r of routes) {
      const provider = String((r.provider && r.provider.id) || "");
      const model = String(r.model || "").trim();
      if (!provider || !model) continue;
      const key = provider + "|" + model;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        provider,
        providerName: String(r.providerName || provider),
        model,
        vision: true,
      });
    }
    return out;
  }
  /* 默认档 = 会话默认模型（它本身就在识图候选里时才用），否则第一条能读图的。 */
  function visionDefaultPick(list) {
    const d = (typeof S !== "undefined" && S.config && S.config.dsh) || {};
    const dm = String(d.model || "").trim();
    return (dm && list.find((x) => x.model === dm)) || list[0] || null;
  }
  /* 运行时给「只吃文本的模型」的图换成这段占位文本（dsh-llm 的 textOnlyImageText）。
     收到它就说明这一轮模型根本没看到像素 —— 绝不能把它当成描述写回素材。 */
  function textOnlyImageReply(s) {
    return /\[image omitted because this model accepts text only/i.test(String(s || ""));
  }
  /* 返回 Promise<{provider, model, effort, prompt} | null>：null = 点了「关闭」（不识图）。
     type 给了就把默认提示词填进去（可改）；不给（批量识图，图像 / 视频混着）就留空，
     每条按自己的类型用默认提示词。 */
  async function askVisionSpec(kindLabel, type) {
    /* 先把服务商目录拉到位：候选排序（目录标注能吃图）要用到它 */
    try {
      if (typeof ensureProviderCatalog === "function") await ensureProviderCatalog();
    } catch (_) {}
    const list = visionCandidates();
    if (!list.length) {
      try {
        if (typeof toast === "function")
          toast(T("没有可用的识图模型：请先在「设置 → 模型服务」里配置一个能读图的模型"), "warn");
      } catch (_) {}
      return null;
    }
    const pick = visionDefaultPick(list);
    const efforts =
      (typeof AGENT_EFFORT_UI_ORDER !== "undefined" && Array.isArray(AGENT_EFFORT_UI_ORDER) && AGENT_EFFORT_UI_ORDER) ||
      ["off", "low", "high", "xhigh", "max"];
    const labels =
      (typeof AGENT_EFFORT_LABELS !== "undefined" && AGENT_EFFORT_LABELS) || {};
    if (typeof mtDialogForm !== "function")
      return Promise.resolve({ provider: pick.provider, model: pick.model, effort: "off" });
    let picked = null; /* 当前选中的 { provider, model, effort }（弹窗关掉后 DOM 会被清，这里先留一份） */
    return mtDialogForm({
      title: T("识图"),
      msg: T("用识图模型为这份") + String(kindLabel || "") + T("补一段内容描述（只写描述，不动其它内容）。"),
      custom: (host) => {
        host.appendChild(el("div", "if-dlg-lab", T("模型")));
        const modelSel = el("select", "if-in if-dlg-sel");
        const byProv = [];
        for (const it of list) {
          let g = byProv.find((x) => x.id === it.provider);
          if (!g) {
            g = { id: it.provider, name: it.providerName, items: [] };
            byProv.push(g);
          }
          g.items.push(it);
        }
        let idx = 0;
        for (const g of byProv) {
          const og = document.createElement("optgroup");
          og.label = g.name || g.id;
          for (const it of g.items) {
            const o = el("option", "", it.model);
            o.value = String(idx++);
            o.dataset.provider = it.provider;
            o.dataset.model = it.model;
            if (pick && it.provider === pick.provider && it.model === pick.model) o.selected = true;
            og.appendChild(o);
          }
          modelSel.appendChild(og);
        }
        host.appendChild(modelSel);
        host.appendChild(el("div", "if-dlg-lab", T("思考强度")));
        const effortSel = el("select", "if-in if-dlg-sel");
        for (const v of efforts) {
          const o = el("option", "", T(labels[v] || v));
          o.value = v;
          if (v === "off") o.selected = true; /* 默认无思考档 */
          effortSel.appendChild(o);
        }
        host.appendChild(effortSel);
        /* 提示词（可改）：默认填好本次类型的口径，用户想换个说法直接在这里改 */
        host.appendChild(el("div", "if-dlg-lab", T("提示词（可改）")));
        const promptEl = el("textarea", "if-in if-dlg-ta");
        promptEl.rows = 4;
        promptEl.spellcheck = false;
        promptEl.value = type ? visionPromptDefault(type) : "";
        promptEl.placeholder = T("留空 = 用默认提示词（图像 / 视频各一份）");
        host.appendChild(promptEl);
        const readSel = () => {
          const o = modelSel.options[Number(modelSel.value)] || null;
          picked = {
            provider: (o && o.dataset && o.dataset.provider) || (pick && pick.provider) || "",
            model: (o && o.dataset && o.dataset.model) || (pick && pick.model) || "",
            effort: effortSel.value || "off",
            prompt: String(promptEl.value || "").trim(),
          };
        };
        modelSel.onchange = readSel;
        effortSel.onchange = readSel;
        promptEl.oninput = readSel;
        readSel();
      },
      actions: [
        { id: "vision", label: T("识图"), primary: true },
        { id: "close", label: T("关闭") },
      ],
    }).then((r) => (r && r.action === "vision" && picked ? picked : null));
  }

  /* ---------------- 素材拖入 ---------------- */

  function extOf(p) {
    const m = String(p || "").match(/\.([a-z0-9]+)$/i);
    return m ? m[1].toLowerCase() : "";
  }
  function mediaKindOfPath(p) {
    const e = extOf(p);
    if (/^(png|jpg|jpeg|webp|gif|bmp|avif)$/.test(e)) return "image";
    if (/^(mp4|mov|mkv|webm|avi|m4v)$/.test(e)) return "video";
    if (/^(mp3|wav|m4a|flac|aac|ogg)$/.test(e)) return "audio";
    return "file";
  }
  async function importPath(path, field) {
    const kind = mediaKindOfPath(path);
    const name = String(path).split(/[\\/]/).pop() || path;
    /* 图像复制进画布资产（换盘不丢）；音视频 / 任意文件只记原绝对路径（用户共识） */
    if (field.type === "image" && kind === "image" && typeof copyImageFromPath === "function") {
      const copied = await copyImageFromPath(path, field.id);
      return { path: copied.path, name, desc: "", tags: [], marks: [] };
    }
    return { path: String(path), name, desc: "", tags: [], marks: [] };
  }
  function mediaValueMatches(field, path) {
    const kind = mediaKindOfPath(path);
    if (field.type === "file") return true;
    return kind === field.type;
  }
  /* holder 省略时写 node.values；列表行的素材传 row.values */
  async function setMedia(node, field, paths, holder) {
    const list = (paths || []).filter((p) => mediaValueMatches(field, p));
    if (!list.length) return false;
    const target = holder || node.values;
    try {
      target[field.id] = await importPath(list[0], field);
      touch(node);
      return true;
    } catch (e) {
      try {
        if (typeof toast === "function") toast(T("导入失败：") + String((e && e.message) || e), "warn");
      } catch (_) {}
      return false;
    }
  }
  function materialListField(node) {
    return (node.fields || []).find((f) => f.type === "list");
  }
  async function appendToMaterialList(node, paths) {
    let list = materialListField(node);
    if (!list) {
      list = listField("素材", [
        mediaField("图像 / 视频", "image"),
        Object.assign(blankField("textarea"), { label: "描述" }),
        Object.assign(blankField("text"), { label: "标签" }),
      ]);
      node.fields.push(list);
      node.values[list.id] = [];
    }
    const mediaChild =
      (list.children || []).find((c) => c.type === "image") ||
      (list.children || []).find((c) => c.type === "video") ||
      (list.children || []).find((c) => MEDIA_TYPES[c.type] === 1);
    if (!mediaChild) {
      try {
        if (typeof toast === "function") toast(T("这个列表里没有素材字段，先把字段类型改成图像 / 视频"), "warn");
      } catch (_) {}
      return 0;
    }
    let n = 0;
    for (const p of paths || []) {
      if (!mediaValueMatches(mediaChild, p)) continue;
      try {
        const row = normRow(list, null);
        row.values[mediaChild.id] = await importPath(p, mediaChild);
        node.values[list.id].push(row);
        n += 1;
      } catch (_) {}
    }
    if (n) touch(node);
    return n;
  }
  async function acceptPaths(node, field, paths) {
    if (!paths || !paths.length) return;
    if (field && MEDIA_TYPES[field.type] === 1) {
      const ok = await setMedia(node, field, paths);
      const rest = paths.slice(1);
      if (ok && rest.length) await appendToMaterialList(node, rest);
    } else {
      const n = await appendToMaterialList(node, paths);
      if (!n) {
        try {
          if (typeof toast === "function") toast(T("没有可接收这类文件的素材字段"), "warn");
        } catch (_) {}
      }
    }
    if (typeof renderCanvas === "function") renderCanvas();
    if (IF.ui.nodeId === node.id) paintPanel();
  }

  /* ---------------- 输入端子吸收（一次性 @引用） ----------------
   * 连到「表单输入」的那条线不长期留着：落线的那一刻就把上游**当前**内容复制进本表单，
   * 随后把线摘掉 —— 上游之后怎么变都不再影响这份拷贝（用户共识）。
   * 上游此刻没有任何值 → 不断线（把线吞掉会让人以为「连不上」），只提示一次。 */

  /* 上游值归一成「可落位的条目」。valueForInput 的形状并不统一（文本 / 媒体 / {items,images}
     聚合 / 任意对象），这里只做形状识别，不猜内容、不编值。 */
  function refItemsOf(v, src) {
    const out = [];
    const title = String((src && src.title) || "");
    const pushText = (text) => {
      const s = String(text == null ? "" : text);
      if (s.trim()) out.push({ kind: "text", text: s, path: "", fromTitle: title });
    };
    const pushPath = (path, kind) => {
      const p = String(path == null ? "" : path).trim();
      if (!p) return;
      out.push({ kind: kind || mediaKindOfPath(p), text: "", path: p, fromTitle: title });
    };
    const pushJson = (obj) => {
      let s = "";
      try {
        s = typeof obj === "string" ? obj : JSON.stringify(obj, null, 2);
      } catch (_) {
        s = "";
      }
      if (s && s.trim()) out.push({ kind: "json", text: s, path: "", fromTitle: title });
    };
    if (v == null) return out;
    if (typeof v === "string") {
      pushText(v);
      return out;
    }
    if (Array.isArray(v)) {
      for (const x of v) for (const it of refItemsOf(x, src)) out.push(it);
      return out;
    }
    if (typeof v !== "object") {
      pushText(String(v));
      return out;
    }
    if (v.kind === "text" || (v.text != null && v.kind == null && v.path == null)) {
      pushText(v.text);
      return out;
    }
    if (MEDIA_TYPES[v.kind] === 1) {
      pushPath(v.path || v.text, v.kind);
      return out;
    }
    if (v.path && v.kind == null) {
      pushPath(v.path);
      return out;
    }
    if (typeof v.image === "string" && v.image) {
      pushPath(v.image, "image");
      return out;
    }
    if (Array.isArray(v.images) && v.images.length)
      for (const im of v.images) pushPath(im && (im.path || im.image), "image");
    if (Array.isArray(v.items) && v.items.length)
      for (const it of v.items) pushText(it && it.text);
    if (out.length) return out;
    /* 既不是文本也不是媒体 → 整份 JSON 进 refs[]（不进「引用内容」，免得撑爆那个多行框） */
    pushJson(v);
    return out;
  }
  const REFS_BOX_LABEL = "引用内容";
  function refsTextField(node) {
    const want = T(REFS_BOX_LABEL);
    return (node.fields || []).find(
      (f) =>
        f &&
        f.type === "textarea" &&
        (f.refsBox || f.label === REFS_BOX_LABEL || f.label === want),
    );
  }
  /* 吸收来的文本没有可写字段时自动建一个：字段就是板身上那张「引用内容」卡（refsBox），
     与普通字段一样可见可改，内容同时进 JSON 与摘要（见 summary 的 refsBox 例外）。 */
  function ensureRefsTextField(node) {
    let f = refsTextField(node);
    if (f) {
      /* 老档里这张卡被写成了「恒假 showWhen → 隐身」：接一次引用线，内容就进去了，
         但界面上什么都看不到。这里顺手把隐身规则摘掉（可见性另有 visibleMap 兜底）。 */
      if (f.showWhen && f.showWhen.field === "__refs_box__") f.showWhen = null;
      return f;
    }
    f = Object.assign(blankField("textarea"), {
      label: REFS_BOX_LABEL,
      hint: T("从输入端子吸收的外部内容（自动追加，可直接改）"),
      refsBox: true,
      showWhen: null,
    });
    node.fields.push(f);
    node.values[f.id] = "";
    return f;
  }
  /* 防重入：同一次落线里（renderCanvas / 事件回调 / 面板重绘都可能再走一遍）只吸一次 */
  const _absorbing = {};
  /* 把一条通向本表单的线吸收掉：node = 表单节点，wire 省略时取它当前那条入线。
     opts.history === false：调用方（addWire 的接线钩子）已经在落线前记过一笔撤销，
     这里不再记第二笔 —— 写入值 + 摘线落在同一步撤销里。 */
  async function absorbWire(node, wire, opts) {
    if (!node || node.kind !== "input_form") return { ok: false, reason: "not-form" };
    const wires =
      typeof S !== "undefined" && S.wf && Array.isArray(S.wf.wires) ? S.wf.wires : null;
    if (!wires) return { ok: false, reason: "no-wire" };
    let w = wire && wires.indexOf(wire) >= 0 ? wire : null;
    if (!w) w = wires.find((x) => x && !x.rel && x.to === node.id);
    /* 幂等：吸过一次线就没了 → 再来一次是无操作（绝不重复追加同一份内容） */
    if (!w || w.rel || w.to !== node.id) return { ok: false, reason: "no-wire" };
    if (_absorbing[node.id]) return { ok: false, reason: "busy" };
    const src = nodeOf(w.from);
    if (!src) return { ok: false, reason: "no-source" };
    let v = null;
    try {
      if (typeof valueForInput === "function")
        v = valueForInput(src, Number(w.fromIndex || 0), node);
    } catch (_) {
      v = null;
    }
    const items = refItemsOf(v, src);
    if (!items.length) {
      /* quiet：静默重试（上游还没跑到 / 还没值时由 maybeAbsorbPending 反复来看一眼），
         不弹提示 —— 否则每重绘一次就弹一条。 */
      try {
        if (!(opts && opts.quiet) && typeof toast === "function")
          toast(T("上游还没有内容：线先留在端子上，等它有值了自动复制进本表单"), "warn");
      } catch (_) {}
      /* 线留在端子上了 → 挂一只轻表等上游「有值」的那一刻（见 ensurePendingWatch） */
      try {
        ensurePendingWatch();
      } catch (_) {}
      return { ok: true, absorbed: false, reason: "empty" };
    }
    if (!opts || opts.history !== false) {
      try {
        if (typeof pushHistory === "function") pushHistory();
      } catch (_) {}
    }
    _absorbing[node.id] = true;
    try {
      normalize(node);
      /* ① 摘线：线一断，上游后续变化就与这份拷贝无关 */
      const at = wires.indexOf(w);
      if (at >= 0) wires.splice(at, 1);
      const textItems = items.filter((it) => it.kind === "text");
      const jsonItems = items.filter((it) => it.kind === "json");
      const mediaItems = items.filter((it) => it.path && it.kind !== "json");
      /* ② 文本 → 「引用内容」多行字段（没有就自动建一个，建出来就是板身上一张正常的卡） */
      if (textItems.length) {
        const f = ensureRefsTextField(node);
        const cur = String(node.values[f.id] == null ? "" : node.values[f.id]);
        const block = textItems.map((it) => it.text).join("\n\n");
        node.values[f.id] = cur.trim() ? cur.replace(/\s+$/, "") + "\n\n" + block : block;
      }
      /* ③ 图像 / 视频 / 音频 / 文件路径 → 素材列表（存储口径沿用既有 importPath：
         图像复制进画布资产，其余只记绝对路径）。列表里没有能收的类型 → 退回 refs[]，绝不丢。 */
      const leftover = [];
      if (mediaItems.length) {
        if (!materialListField(node)) {
          /* 没有素材列表时先建一张（appendToMaterialList 自己会建），第一条当场写进去；
             写成功才从待办里摘掉，失败的那条退回 refs[]，不丢内容 */
          let n0 = 0;
          try {
            n0 = await appendToMaterialList(node, [mediaItems[0].path]);
          } catch (_) {}
          if (n0 > 0) mediaItems.shift();
        }
        const list = materialListField(node);
        const child =
          list &&
          ((list.children || []).find((c) => c.type === "image") ||
            (list.children || []).find((c) => c.type === "video") ||
            (list.children || []).find((c) => MEDIA_TYPES[c.type] === 1));
        const okPaths = [];
        for (const it of mediaItems)
          (child && mediaValueMatches(child, it.path) ? okPaths : leftover).push(it);
        if (okPaths.length) {
          try {
            await appendToMaterialList(node, okPaths.map((x) => x.path));
          } catch (_) {}
        }
      }
      /* ④ 其它 JSON 与没落进素材列表的媒体 → node.refs[] */
      for (const it of jsonItems.concat(leftover)) {
        node.refs = node.refs || [];
        node.refs.push({
          fromTitle: it.fromTitle,
          kind: it.kind,
          text: it.text || "",
          path: it.path || "",
          at: Date.now(),
        });
      }
      touch(node);
      /* 板身得当场换上吸进来的那张卡（renderCanvas 只在节点形态变化时才重建 body，
         光调它板身还是旧的 → 用户看着「线没了、板身没变」） */
      try {
        if (typeof refreshNodeBody === "function") refreshNodeBody(node);
      } catch (_) {}
      try {
        BD.reveal[node.id] = Date.now();
        revealRefsCard(node);
        if (typeof setTimeout === "function")
          setTimeout(() => {
            if (BD.reveal[node.id] && Date.now() - BD.reveal[node.id] >= 4000)
              delete BD.reveal[node.id];
          }, 4200);
      } catch (_) {}
      try {
        if (typeof renderCanvas === "function") renderCanvas();
      } catch (_) {}
      if (IF.ui.nodeId === node.id) {
        try {
          paintPanel();
        } catch (_) {}
      }
      try {
        if (typeof toast === "function")
          toast(T("已引用并断开连线，上游后续变化不再影响本表单"), "ok");
      } catch (_) {}
      return { ok: true, absorbed: true, count: items.length };
    } finally {
      _absorbing[node.id] = false;
    }
  }

  /* 吸收完把「引用内容」那张卡亮出来：取消它自己的折叠，并在板身自己的滚动容器里滚到可见。
     否则内容可能落在折叠组里 / 折叠区外 —— 用户照样看不到「东西进来了」。 */
  function revealRefsCard(node, tries) {
    const f = refsTextField(node);
    if (!f) return;
    if ((node.uiCollapsed || []).indexOf(f.id) >= 0) {
      node.uiCollapsed = node.uiCollapsed.filter((x) => x !== f.id);
      applyBoardCollapse(node, boardBodyOf(node));
    }
    const left = tries == null ? 3 : tries;
    const step = () => {
      const body = boardBodyOf(node);
      const wall = body && body.querySelector(".if-wall");
      const g = body && body.querySelector('.if-grp[data-field-id="' + f.id + '"]');
      if (!wall || !g) return;
      const wr = wall.getBoundingClientRect();
      const gr = g.getBoundingClientRect();
      if (gr.top >= wr.top - 1 && gr.bottom <= wr.bottom + 1) return; /* 已在视野里 */
      wall.scrollTop += gr.top - wr.top - 4;
      /* 内容比可视区还高 / 排版晚一拍：再补一两次，够了就停 */
      if (left > 0) {
        if (typeof requestAnimationFrame === "function")
          requestAnimationFrame(() => revealRefsCard(node, left - 1));
      }
    };
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(step);
    else step();
  }

  /* 上游**当下还没有内容**时，落线那一刻没东西可吸 → 线留在端子上（不吞线）。
     以前这样就永远停在这里：要用户「等上游有值了再连一次」，等于引用端子接不进来。
     现在板身每次重绘顺手看一眼：线上游一旦有值就照一次性的老口径吸收并摘线
     （静默、不弹提示；成功那一次才弹「已引用并断开连线」）。 */
  const _pendingTry = {};
  function maybeAbsorbPending(node, opts) {
    if (!node || node.kind !== "input_form") return null;
    const wires = typeof S !== "undefined" && S.wf && Array.isArray(S.wf.wires) ? S.wf.wires : null;
    if (!wires) return null;
    const w = wires.find((x) => x && !x.rel && x.to === node.id);
    if (!w) return null;
    if (_absorbing[node.id]) return null;
    /* 轻节流：重绘可能很密（拖动 / 运行中的状态刷新），同一节点 500ms 内只看一眼 */
    const now = Date.now();
    if (!(opts && opts.force) && _pendingTry[node.id] && now - _pendingTry[node.id] < 500) return null;
    _pendingTry[node.id] = now;
    return absorbWire(node, w, { quiet: true, history: false });
  }
  /* 线上游还没值时，板身未必会重绘（节点 body 只在形态变化时才重建），所以另挂一只
     轻表：只在「确实有表单节点的引用端子上留着线」时跑，每 800ms 看一眼，一旦没有
     这种线立刻停表（不常驻轮询、不动节点数据）。 */
  let _pendingTimer = 0;
  function ensurePendingWatch() {
    if (_pendingTimer) return;
    if (typeof setInterval !== "function") return;
    _pendingTimer = setInterval(() => {
      let any = false;
      try {
        const wf = (typeof S !== "undefined" && S.wf) || null;
        for (const n of (wf && wf.nodes) || []) {
          if (!n || n.kind !== "input_form") continue;
          const w = (wf.wires || []).find((x) => x && !x.rel && x.to === n.id);
          if (!w) continue;
          any = true;
          const p = maybeAbsorbPending(n);
          if (p && typeof p.catch === "function") p.catch(() => {});
        }
      } catch (_) {}
      if (!any && _pendingTimer) {
        clearInterval(_pendingTimer);
        _pendingTimer = 0;
      }
    }, 800);
  }

  /* 这一拖是不是「文件 / 素材」：只认系统文件与左侧文件栏的内部拖拽
   *（text/plain 单独出现多半是拖一段选中的文字，不抢它的默认行为） */
  function dragHasPaths(ev) {
    const dt = ev && ev.dataTransfer;
    if (!dt) return false;
    const t = dt.types;
    if (!t) return true;
    for (let i = 0; i < t.length; i++) {
      if (t[i] === "Files" || t[i] === "application/x-mtnode-files") return true;
    }
    return false;
  }
  /* 落点提示浮标：dragover 时在容器里浮一句「松开即加入」（只动 DOM，不落盘、不进节点数据） */
  function dropOver(host, text) {
    if (!host || !host.appendChild) return;
    host.classList.add("if-drop-on");
    let flag = null;
    for (const c of host.children) if (c.classList && c.classList.contains("if-drop-flag")) flag = c;
    if (!flag) {
      flag = el("div", "if-drop-flag");
      host.appendChild(flag);
    }
    flag.textContent = text || T("松开即加入");
    flag.classList.add("is-on");
  }
  function dropOut(host) {
    if (!host || !host.classList) return;
    host.classList.remove("if-drop-on");
    for (const c of host.children) {
      if (c.classList && c.classList.contains("if-drop-flag")) c.classList.remove("is-on");
    }
  }
  /* 落下动画：给落点一次「吸收」高亮（reduced-motion 下由 CSS 降级为瞬切） */
  function flashDrop(target) {
    if (!target || !target.classList) return;
    target.classList.remove("is-drop-in");
    void target.offsetWidth;
    target.classList.add("is-drop-in");
    setTimeout(() => {
      try {
        target.classList.remove("is-drop-in");
      } catch (_) {}
    }, 320);
  }
  /* 拖进来的路径，按来源依次取：
   * ① 系统文件（dt.files）② 左侧文件栏内部拖拽 application/x-mtnode-files（JSON 数组，
   *    见 renderer/app-sidebar-files.js）③ text/plain 多行路径兜底（别处拖来的一串路径）。 */
  function pathsFromDrop(ev) {
    const dt = ev && ev.dataTransfer;
    if (!dt) return [];
    const out = [];
    const push = (p) => {
      const s = String(p == null ? "" : p).trim().replace(/^"|"$/g, "");
      if (s && out.indexOf(s) < 0) out.push(s);
    };
    if (dt.files && dt.files.length) {
      for (let i = 0; i < dt.files.length; i++) {
        const f = dt.files[i];
        const p = window.api && window.api.getPathForFile ? String(window.api.getPathForFile(f) || "") : "";
        if (p) push(p);
      }
      if (out.length) return out;
    }
    const raw = dt.getData ? dt.getData("application/x-mtnode-files") : "";
    if (raw) {
      try {
        const arr = JSON.parse(raw);
        if (Array.isArray(arr)) for (const p of arr) push(p);
      } catch (_) {}
      if (out.length) return out;
    }
    const txt = dt.getData ? dt.getData("text/plain") : "";
    if (txt) {
      for (const line of String(txt).split(/\r?\n/)) {
        if (/[\\/]/.test(line)) push(line);
      }
    }
    return out;
  }

  /* ---------------- 板身（节点 body）：卡片墙 ----------------
   * 口径（用户共识）：板身上只显示「项 + 内容」——
   *   · 一个字段一张卡：媒体字段方形卡、文字 / 数字 / 开关 / 单选等 16:9 卡；
   *   · 列表每个行一张卡（行里有素材 → 方形卡，否则 16:9），按字段成组、组头可折叠；
   *   · 点卡 → 节点旁浮层就地改这一项（字段 / 列表行 / 素材）；大面板 = 全屏编辑，保持原样；
   *   · 卡片区在自己的滚动容器里滚 + 严格裁剪、节点高度固定：内容顶不开节点，也压不到端子栏；
   *   · 缩略图懒加载：进可视区才挂图（图像走 mtnode-thumb://，视频取首帧，音频 / 文件给图标）。
   * 纪律：写值只改 node.values 并局部刷新卡面，**不调用 renderCanvas()**（整画布重绘会把浮层顶掉）。 */
  /* node.id → 板身容器：同屏可能同时有多个表单节点，各自刷新自己的板身，不串台 */
  const B = { bodies: Object.create(null) };
  /* 板身运行时状态（不进节点对象：画布是整份 JSON.stringify 落盘的，节点上多一个键就会被写进文件） */
  const BD = {
    seeded: Object.create(null),
    fitH: Object.create(null),
    obs: Object.create(null),
    search: Object.create(null),
    /* 刚吸收过一条引用的节点（时间戳）：板身重建后把「引用内容」卡滚进视野一次。
       吸收后可能紧接着发生一次延迟重建（deferNodeForm），滚动会被重置，所以记在这儿
       让下一次 paintBoard 补一次。 */
    reveal: Object.create(null),
  };
  function boardBodyOf(node) {
    return (node && B.bodies[node.id]) || null;
  }

  function fieldById(node, id) {
    return (node.fields || []).find((f) => f.id === id) || null;
  }
  function typeLabelOf(t) {
    const hit = FIELD_TYPES.find((x) => x.id === t);
    return hit ? hit.label : "";
  }
  /* 类型角标 / 空位图标：只画一个字符，不依赖字体图标 */
  function typeGlyph(t) {
    if (t === "image") return "🖼";
    if (t === "video") return "🎬";
    if (t === "audio") return "♪";
    if (t === "file") return "▣";
    return "▧";
  }
  function collapsedSet(node) {
    return new Set(Array.isArray(node.uiCollapsed) ? node.uiCollapsed : []);
  }
  /* 首次画板身：把第 4 组往后折起来（一人一次；之后完全听 uiCollapsed） */
  function seedBoardCollapse(node) {
    if (!node || !node.id) return;
    if (BD.seeded[node.id]) return;
    BD.seeded[node.id] = true;
    if ((node.uiCollapsed || []).length) return;
    const vis = visibleMap(node);
    const shown = (node.fields || []).filter((f) => vis[f.id]);
    if (shown.length <= BD_OPEN_FIRST) return;
    node.uiCollapsed = shown.slice(BD_OPEN_FIRST).map((f) => f.id);
    try {
      if (typeof scheduleSave === "function") scheduleSave();
    } catch (_) {}
  }
  /* 高度：固定一档，内容在卡片区里自己滚（不再按行数自适应/被内容顶开）。
     用户自己拉过高度（node.h 与上次记的不一致）就不再抢。 */
  const BD_OPEN_FIRST = 3;
  const BD_H_DEFAULT = 320;
  function boardHeightDom(node, h) {
    const eln = document.querySelector('.wf-node[data-nid="' + node.id + '"]');
    if (!eln) return false;
    let calm = false;
    try {
      calm = !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
    } catch (_) {}
    if (!calm) eln.style.transition = "height var(--dur-fast) var(--ease-out)";
    eln.style.height = h + "px";
    eln.style.setProperty("--nh", h + "px");
    try {
      if (typeof refreshPorts === "function") refreshPorts(eln, node);
    } catch (_) {}
    try {
      if (typeof updateWires === "function") updateWires(new Set([node.id]));
    } catch (_) {}
    if (!calm) {
      setTimeout(() => {
        if (eln.isConnected) eln.style.transition = "";
        try {
          if (typeof updateWires === "function") updateWires(new Set([node.id]));
        } catch (_) {}
      }, 190);
    }
    return true;
  }
  function fitBoardHeight(node) {
    const last = BD.fitH[node.id];
    const cur = Number(node.h) || 0;
    if (last != null && cur && Math.abs(cur - last) > 1) return; /* 本次会话里手动拉过 → 不再抢高度 */
    if (last == null && cur >= BD_H_DEFAULT) return; /* 上次会话里拉高的，原样留着 */
    BD.fitH[node.id] = BD_H_DEFAULT;
    if (cur && Math.abs(cur - BD_H_DEFAULT) < 2) return;
    node.h = BD_H_DEFAULT;
    if (boardHeightDom(node, BD_H_DEFAULT)) return;
    requestAnimationFrame(() => {
      if (BD.fitH[node.id] === BD_H_DEFAULT) boardHeightDom(node, BD_H_DEFAULT);
    });
  }

  /* ---------------- 缩略图（懒加载） ---------------- */
  function encPathSegs(p) {
    return String(p)
      .replace(/\\/g, "/")
      .split("/")
      .filter((s) => s !== "")
      .map(encodeURIComponent)
      .join("/");
  }
  /* 图像走主进程的缩略图协议（长边 ≤ edge）；视频走同一个协议的另一支（首帧） */
  function mediaThumbUrl(p, edge) {
    return "mtnode-thumb://img/" + encPathSegs(p) + "?e=" + String(edge || 320);
  }
  function videoThumbUrl(p, edge) {
    return "mtnode-thumb://video/" + encPathSegs(p) + "?e=" + String(edge || 320);
  }
  /* 进可视区才真正挂图：板身一屏可能有几十张卡，首屏外的图不该解码 */
  function armLazy(node, eln, fn) {
    if (typeof IntersectionObserver !== "function") {
      fn();
      return;
    }
    let obs = BD.obs[node.id];
    if (!obs) {
      obs = new IntersectionObserver(
        (entries) => {
          for (const en of entries) {
            if (!en.isIntersecting) continue;
            const t = en.target;
            try {
              obs.unobserve(t);
            } catch (_) {}
            const run = t._ifLoad;
            t._ifLoad = null;
            if (typeof run === "function") run();
          }
        },
        { root: null, rootMargin: "160px" },
      );
      BD.obs[node.id] = obs;
    }
    eln._ifLoad = fn;
    obs.observe(eln);
  }
  function lazyThumb(node, media, type) {
    const box = el("div", "if-tile-media");
    /* 音频 / 文件没有画面：给文件名首字，不画「图像 icon」 */
    if (type === "audio" || type === "file") {
      box.classList.add("if-tile-media-ico");
      const nm = String(media.name || String(media.path).split(/[\\/]/).pop() || "");
      box.appendChild(el("div", "if-tile-ico", (nm.trim()[0] || "·").toUpperCase()));
      return box;
    }
    const img = el("img");
    img.alt = "";
    img.draggable = false;
    box.appendChild(img);
    const src = type === "video" ? videoThumbUrl(media.path, 320) : mediaThumbUrl(media.path, 320);
    armLazy(node, box, () => {
      img.src = src;
    });
    img.onerror = () => {
      img.hidden = true;
      box.classList.add("is-broken");
    };
    return box;
  }

  /* ---------------- 卡面 ---------------- */
  function previewOfValue(f, v) {
    if (f.type === "list") return String(Array.isArray(v) ? v.length : 0) + T(" 行");
    if (MEDIA_TYPES[f.type] === 1) {
      if (v && v.path) return String(v.name || String(v.path).split(/[\\/]/).pop() || "");
      return T("（未选）");
    }
    if (v === true) return T("是");
    if (v === false) return T("否");
    const s = String(v == null ? "" : Array.isArray(v) ? v.join("、") : v);
    return s.trim() ? firstLineOf(s, 40) : T("（未填）");
  }
  /* 组头的第二行：展开时给一眼摘要，折叠时整组就是「标签：值摘要」 */
  function groupMetaText(node, f) {
    const v = node.values[f.id];
    if (MEDIA_TYPES[f.type] === 1) {
      const m = v && v.path ? v : null;
      const name = m ? String(m.name || String(m.path).split(/[\\/]/).pop() || "") : T("（未选）");
      const marks = m && Array.isArray(m.marks) ? m.marks.length : 0;
      return name + (marks ? " · " + T("标注 ") + marks : "");
    }
    return previewOfValue(f, v);
  }
  /* 列表行里「用哪份素材当卡面」：第一个有 path 的媒体子字段 */
  function rowMediaOf(f, row) {
    for (const c of f.children || []) {
      if (MEDIA_TYPES[c.type] !== 1) continue;
      const m = row && row.values ? normMedia(row.values[c.id]) : null;
      if (m && m.path) return { child: c, media: m };
    }
    return null;
  }
  function rowIndexText(node, f, row) {
    const rows = Array.isArray(node.values[f.id]) ? node.values[f.id] : [];
    const i = rows.indexOf(row);
    return T("行 ") + String(i >= 0 ? i + 1 : 1);
  }
  /* 16:9 文字卡的内容：普通字段 = 值；列表行 = 各子字段拼一行 */
  function tileValueOf(node, f, row) {
    if (!row) {
      const v = node.values[f.id];
      if (f.type === "switch") return v ? T("开") : T("关");
      if (Array.isArray(v)) return v.join("、");
      return String(v == null ? "" : v);
    }
    const bits = [];
    for (const c of f.children || []) {
      const v = row.values[c.id];
      if (MEDIA_TYPES[c.type] === 1) {
        if (v && v.path) bits.push(String(v.name || String(v.path).split(/[\\/]/).pop() || ""));
        continue;
      }
      if (c.type === "switch") {
        bits.push(c.label + ":" + (v ? T("开") : T("关")));
        continue;
      }
      if (Array.isArray(v)) {
        if (v.length) bits.push(c.label + ":" + v.join("、"));
        continue;
      }
      const s = String(v == null ? "" : v).trim();
      if (s) bits.push(c.label + ":" + s);
    }
    return bits.join(" · ");
  }
  function appendTileBadges(tile, f, row, media, type, badSet) {
    const box = el("div", "if-tile-badges");
    if (type) box.appendChild(el("i", "if-tile-type", typeGlyph(type)));
    if (media) {
      const marks = Array.isArray(media.marks) ? media.marks.length : 0;
      if (marks) box.appendChild(el("i", "if-tile-mark", String(marks)));
      if (media.desc) box.appendChild(el("i", "if-tile-desc", "✎"));
    }
    if (badSet && badSet.has(f.id)) box.appendChild(el("i", "if-tile-bad", "•"));
    if (box.children.length) tile.appendChild(box);
  }

  /* 空卡：只留一颗更大的 +（不画类型 icon、不写提示文字） */
  function tilePlus() {
    return el("div", "if-tile-plus", "＋");
  }
  /* 空卡点击 = 直接进这一步该做的事：媒体选文件、文字就地编辑 */
  async function pickMediaForTile(node, f, row, mediaField) {
    const type = mediaField.type;
    const exts = (TYPE_ACCEPT[type] || "*").split(",");
    const r = await window.api.fileOpenDialog({
      title: T("选择文件"),
      filters: exts[0] === "*" ? [{ name: T("全部文件"), extensions: ["*"] }] : [{ name: T("文件"), extensions: exts }],
    });
    if (r && r.path) await replaceMediaAt(node, f, row, mediaField, [r.path]);
  }

  function mediaTile(node, f, row, mediaField, badSet) {
    const type = mediaField.type;
    const holder = row ? row.values : node.values;
    const media = normMedia(holder[mediaField.id]);
    holder[mediaField.id] = media;
    const tile = el("button", "if-tile if-tile-sq");
    tile.type = "button";
    tile.dataset.fieldId = f.id;
    if (row) tile.dataset.rowId = row.id;
    if (mediaField.id !== f.id) tile.dataset.childId = mediaField.id;
    const has = !!(media && media.path);
    if (!has) tile.classList.add("is-empty");
    const thumb = el("div", "if-tile-thumb");
    if (has) thumb.appendChild(lazyThumb(node, media, type));
    else thumb.appendChild(tilePlus());
    tile.appendChild(thumb);
    const capText = has
      ? String(media.name || String(media.path).split(/[\\/]/).pop() || "")
      : row
        ? rowIndexText(node, f, row)
        : f.label;
    tile.appendChild(el("div", "if-tile-cap", capText));
    appendTileBadges(tile, f, row, media, null, badSet);
    tile.title = has
      ? String(media.desc || media.path || "") + " · " + T("点击预览并编辑描述")
      : T("点击选择") + typeLabelOf(type);
    tile.onmousedown = (ev) => ev.stopPropagation();
    tile.onclick = (ev) => {
      ev.stopPropagation();
      /* 空卡 → 直接选文件；有内容 → 预览 + 文本编辑（描述 / 标签 / 移除 / 更换） */
      if (!has) pickMediaForTile(node, f, row, mediaField);
      else openItem(node, f, row ? row.id : "", tile);
    };
    attachTileDrop(tile, node, async (paths) => {
      await replaceMediaAt(node, f, row, mediaField, paths);
    });
    return tile;
  }

  function textTile(node, f, row, badSet) {
    const tile = el("button", "if-tile if-tile-wide");
    tile.type = "button";
    tile.dataset.fieldId = f.id;
    if (row) tile.dataset.rowId = row.id;
    const text = tileValueOf(node, f, row);
    if (!text) tile.classList.add("is-empty");
    const top = el("div", "if-tile-top");
    top.appendChild(el("span", "if-tile-name", row ? rowIndexText(node, f, row) : f.label));
    top.appendChild(el("i", "if-tile-kind", typeLabelOf(f.type)));
    tile.appendChild(top);
    if (text) tile.appendChild(el("div", "if-tile-text", text));
    else tile.appendChild(tilePlus());
    appendTileBadges(tile, f, row, null, null, badSet);
    tile.title = f.label + (f.hint ? " · " + f.hint : "");
    tile.onmousedown = (ev) => ev.stopPropagation();
    tile.onclick = (ev) => {
      ev.stopPropagation();
      /* 空卡 → 直接进文本编辑（弹层里焦点落在输入框）；有内容 → 预览值 + 改 */
      openItem(node, f, row ? row.id : "", tile, { focus: !text });
    };
    return tile;
  }

  function attachTileDrop(tile, node, accept) {
    tile.ondragover = (ev) => {
      if (!dragHasPaths(ev)) return;
      ev.preventDefault();
      ev.stopPropagation();
      if (ev.dataTransfer) ev.dataTransfer.dropEffect = "copy";
      tile.classList.add("if-drop-on");
    };
    tile.ondragleave = (ev) => {
      if (ev && ev.relatedTarget && tile.contains(ev.relatedTarget)) return;
      tile.classList.remove("if-drop-on");
    };
    tile.ondrop = async (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      tile.classList.remove("if-drop-on");
      const paths = pathsFromDrop(ev);
      if (!paths.length) return;
      flashDrop(tile);
      await accept(paths);
    };
  }
  /* 卡上落文件 = 换这份素材（多份时第一份进这张卡，其余追加进素材列表） */
  async function replaceMediaAt(node, f, row, mediaField, paths) {
    const holder = row ? row.values : node.values;
    const ok = await setMedia(node, mediaField, paths, holder);
    if (!ok) return;
    const rest = paths.slice(1);
    if (rest.length) await appendToMaterialList(node, rest);
    touch(node);
    writeFile(node, { silent: true });
    paintBoard(node, boardBodyOf(node));
  }

  function addListRow(node, f) {
    if (!Array.isArray(node.values[f.id])) node.values[f.id] = [];
    node.values[f.id].push(normRow(f, null));
    touch(node, { structural: true });
    writeFile(node, { silent: true });
    paintBoard(node, boardBodyOf(node));
  }

  function fieldGroup(node, f, badSet) {
    const g = el("section", "if-grp");
    g.dataset.fieldId = f.id;
    if (collapsedSet(node).has(f.id)) g.classList.add("is-collapsed");
    const head = el("div", "if-grp-head");
    const lab = el("button", "if-grp-lab");
    lab.type = "button";
    lab.title = T("点一下折叠 / 展开这一组");
    lab.appendChild(el("i", "if-grp-chev", "▾"));
    lab.appendChild(el("span", "if-grp-name", f.label));
    if (f.required) lab.appendChild(el("i", "if-req", "*"));
    if (f.calc) lab.appendChild(el("i", "if-auto", T("自动")));
    lab.onclick = (ev) => {
      ev.stopPropagation();
      toggleBoardCollapse(node, f.id);
    };
    head.appendChild(lab);
    head.appendChild(el("span", "if-grp-meta", groupMetaText(node, f)));
    if (f.type === "list") {
      const add = el("button", "if-mini if-grp-add", "＋");
      add.type = "button";
      add.title = T("追加一行");
      add.onclick = (ev) => {
        ev.stopPropagation();
        addListRow(node, f);
      };
      head.appendChild(add);
    }
    g.appendChild(head);
    const bodyEl = el("div", "if-grp-body");
    g.appendChild(bodyEl);
    fillGrpBody(node, f, bodyEl, badSet);
    return g;
  }
  function fillGrpBody(node, f, host, badSet) {
    if (MEDIA_TYPES[f.type] === 1) {
      host.appendChild(mediaTile(node, f, null, f, badSet));
      return;
    }
    if (f.type === "list") {
      const rows = Array.isArray(node.values[f.id]) ? node.values[f.id] : [];
      for (const row of rows) {
        const hit = rowMediaOf(f, row);
        host.appendChild(hit ? mediaTile(node, f, row, hit.child, badSet) : textTile(node, f, row, badSet));
      }
      const add = el("button", "if-tile if-tile-add");
      add.type = "button";
      add.title = T("追加一行");
      add.appendChild(el("span", "if-tile-add-ico", "＋"));
      add.onclick = (ev) => {
        ev.stopPropagation();
        addListRow(node, f);
      };
      host.appendChild(add);
      return;
    }
    host.appendChild(textTile(node, f, null, badSet));
  }

  /* ---------------- 折叠 / 搜索 / 局部刷新 ---------------- */
  /* 折叠只影响显示：字段、取值、JSON、@引用一律不变（状态记在 node.uiCollapsed） */
  function applyBoardCollapse(node, body) {
    if (!body) return;
    const vis = visibleMap(node);
    const col = collapsedSet(node);
    for (const g of body.querySelectorAll(".if-grp")) {
      const id = g.dataset.fieldId || "";
      const f = fieldById(node, id);
      if (!f) continue;
      g.classList.toggle("is-collapsed", col.has(id));
      const meta = g.querySelector(".if-grp-meta");
      if (meta) meta.textContent = groupMetaText(node, f);
    }
    const shown = (node.fields || []).filter((f) => vis[f.id]);
    const allCol = shown.length > 0 && shown.every((f) => col.has(f.id));
    const all = body.querySelector(".if-bd-all");
    if (all) {
      all.textContent = allCol ? T("展开全部") : T("全部折叠");
      all.title = allCol ? T("把所有字段组展开") : T("把所有字段组折成一行摘要");
    }
    updateBoardMore(node, body);
  }
  function updateBoardMore(node, body) {
    if (!body) return;
    const more = body.querySelector(".if-bd-more");
    if (!more) return;
    const vis = visibleMap(node);
    const col = collapsedSet(node);
    const n = (node.fields || []).filter((f) => vis[f.id] && col.has(f.id)).length;
    more.hidden = n <= 0;
    more.textContent = T("还有 ") + n + T(" 组");
  }
  function setBoardAllCollapsed(node, on) {
    const vis = visibleMap(node);
    const shown = (node.fields || []).filter((f) => vis[f.id]);
    node.uiCollapsed = on ? shown.map((f) => f.id) : [];
    touch(node);
    applyBoardCollapse(node, boardBodyOf(node));
  }
  function toggleBoardCollapse(node, fieldId) {
    const arr = Array.isArray(node.uiCollapsed) ? node.uiCollapsed.slice() : [];
    const i = arr.indexOf(fieldId);
    if (i >= 0) arr.splice(i, 1);
    else arr.push(fieldId);
    node.uiCollapsed = arr;
    touch(node);
    applyBoardCollapse(node, boardBodyOf(node));
  }
  /* 字段多到一屏放不下才出现搜索框：按组名 / 卡面名字过滤（只改显示） */
  function filterBoard(node, body, q) {
    if (!body) return;
    const key = String(q || "").trim().toLowerCase();
    for (const g of body.querySelectorAll(".if-grp")) {
      if (!key) {
        g.classList.remove("if-grp-hide");
        continue;
      }
      let hay = "";
      const name = g.querySelector(".if-grp-name");
      if (name) hay += " " + String(name.textContent || "");
      for (const c of g.querySelectorAll(".if-tile-name")) hay += " " + String(c.textContent || "");
      for (const c of g.querySelectorAll(".if-tile-cap")) hay += " " + String(c.textContent || "");
      g.classList.toggle("if-grp-hide", hay.toLowerCase().indexOf(key) < 0);
    }
  }
  /* 一处改动后：只刷这一张卡的文字 + 组头摘要（不重建整面墙，缩略图不会反复重载） */
  function refreshBoardItem(node, f, rowId) {
    const body = boardBodyOf(node);
    if (!body) return;
    const g = body.querySelector('.if-grp[data-field-id="' + f.id + '"]');
    if (g) {
      const meta = g.querySelector(".if-grp-meta");
      if (meta) meta.textContent = groupMetaText(node, f);
    }
    if (MEDIA_TYPES[f.type] === 1) return;
    const sel = '.if-tile[data-field-id="' + f.id + '"]' + (rowId ? '[data-row-id="' + rowId + '"]' : "");
    const tile = body.querySelector(sel);
    if (!tile) return;
    const row = rowId ? (node.values[f.id] || []).find((r) => r.id === rowId) : null;
    const text = tileValueOf(node, f, row);
    const t = tile.querySelector(".if-tile-text");
    const ph = tile.querySelector(".if-tile-plus");
    if (text) {
      tile.classList.remove("is-empty");
      if (t) t.textContent = text;
      else if (ph) {
        ph.className = "if-tile-text";
        ph.textContent = text;
      }
    } else {
      tile.classList.add("is-empty");
      if (t) {
        t.className = "if-tile-plus";
        t.textContent = "＋";
      }
    }
  }

  function paintBoard(node, body) {
    if (!node || !body) return;
    normalize(node);
    seedBoardCollapse(node);
    B.bodies[node.id] = body;
    body.innerHTML = "";
    body.classList.add("if-board");

    const vis = visibleMap(node);
    const shown = (node.fields || []).filter((f) => vis[f.id]);
    const badSet = new Set(missingRequired(node).map((m) => m.id));

    /* 板身只显示项与内容：不写「表单 N 项」「必填已填齐」这类状态文案（顶部只在字段多时出一条搜索框） */
    if (shown.length >= 9) {
      const head = el("div", "if-bd-head");
      const q = el("input", "if-bd-search");
      q.type = "search";
      q.placeholder = T("搜字段 / 文件名");
      q.value = String(BD.search[node.id] || "");
      q.onmousedown = (ev) => ev.stopPropagation();
      q.oninput = () => {
        BD.search[node.id] = String(q.value || "");
        filterBoard(node, body, BD.search[node.id]);
      };
      head.appendChild(q);
      body.appendChild(head);
    } else {
      BD.search[node.id] = "";
    }

    /* 卡片墙：自己的滚动容器 + 严格裁剪（内容不出 body、更不压端子栏） */
    const wall = el("div", "if-wall");
    for (const f of shown) wall.appendChild(fieldGroup(node, f, badSet));
    body.appendChild(wall);

    /* body 里不再放按钮：「全部折叠 / 展开 / 刷新」三颗小 icon 已挪到节点头部
       （见本文件的 headButtons，接入点在 renderer/app-canvas.js 的 nodeElement）。 */

    applyBoardCollapse(node, body);
    if (BD.search[node.id]) filterBoard(node, body, BD.search[node.id]);

    body.ondblclick = (ev) => {
      const t = ev && ev.target;
      if (t && t.closest && (t.closest("button") || t.closest("input") || t.closest("textarea") || t.closest("select") || t.closest(".if-grp"))) return;
      openPanel(node.id);
    };
    /* 拖到卡片之间的空白 = 追加进素材列表（卡片自己有落点，会先 stopPropagation） */
    body.ondragover = (ev) => {
      if (!dragHasPaths(ev)) return;
      ev.preventDefault();
      if (ev.dataTransfer) ev.dataTransfer.dropEffect = "copy";
      dropOver(body, T("松开即加入素材列表"));
    };
    body.ondragleave = (ev) => {
      if (ev && ev.relatedTarget && body.contains(ev.relatedTarget)) return;
      dropOut(body);
    };
    body.ondrop = async (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      dropOut(body);
      const paths = pathsFromDrop(ev);
      if (!paths.length) return;
      flashDrop(body);
      await acceptPaths(node, null, paths);
      const nb = boardBodyOf(node);
      if (!nb) return;
      if (nb.isConnected) paintBoard(node, nb);
      flashDrop(nb);
    };

    fitBoardHeight(node);
    /* 刚吸收过引用 → 板身一建好就把「引用内容」那张卡滚进视野（吸收后可能紧接一次重建） */
    if (BD.reveal[node.id] && Date.now() - BD.reveal[node.id] < 4000) {
      try {
        revealRefsCard(node);
      } catch (_) {}
    }
    /* 「引用」端子上还留着线（上次连进来上游还没值）→ 这次重绘顺手看它有没有值了：
       有就吸收并摘线，没有就静默等着（不弹提示、不改节点数据）。 */
    try {
      const p = maybeAbsorbPending(node);
      if (p && typeof p.catch === "function") p.catch(() => {});
    } catch (_) {}
  }

  function renderBody(node, body) {
    if (!node || !body) return;
    paintBoard(node, body);
  }

  /* ---------------- 条目浮层（点卡就地编辑这一项） ----------------
   * 口径：节点旁浮层、跟随节点（nodePopAnchor + placeNodePop），persistent（点窗外不关，只走 ✕ / Esc）；
   * 里面保留「在面板中编辑」入口 —— 大面板仍是全屏编辑模式，撤掉浮层不影响它。 */
  const ITEM = { el: null, nodeId: "", fieldId: "", rowId: "" };
  function itemHost() {
    let host = document.getElementById("ifItemPop");
    if (!host) {
      host = el("div", "if-item-pop");
      host.id = "ifItemPop";
      host.hidden = true;
      host.onmousedown = (ev) => ev.stopPropagation();
      host.onkeydown = (ev) => {
        if (ev.key === "Escape") {
          ev.stopPropagation();
          closeItemPop();
        }
      };
      document.body.appendChild(host);
      /* 焦点不在浮层里（刚点完卡就按 Esc）也要能关：捕获阶段先收，且让位给更上面的
         输入框 / 对话框 —— 只在焦点落在画布 / 节点 / body 时才认这一下 Esc。 */
      if (typeof document.addEventListener === "function")
        document.addEventListener(
        "keydown",
        (ev) => {
          if (ev.key !== "Escape" || ev.defaultPrevented) return;
          const pop = ITEM.el;
          if (!pop || !pop.classList.contains("on")) return;
          const a = document.activeElement;
          const inPop = !!(a && pop.contains(a));
          const neutral = !a || a === document.body || !!(a.closest && a.closest(".wf-node"));
          if (!inPop && !neutral) return;
          ev.preventDefault();
          ev.stopPropagation();
          closeItemPop();
        },
        true,
      );
    }
    return host;
  }
  function closeItemPop() {
    ITEM.nodeId = "";
    ITEM.fieldId = "";
    ITEM.rowId = "";
    const eln = ITEM.el || document.getElementById("ifItemPop");
    if (!eln) return;
    eln.classList.remove("on");
    eln.hidden = true;
    eln.innerHTML = "";
  }
  try {
    window.closeIfItemPop = closeItemPop;
  } catch (_) {}
  function openItem(node, f, rowId, anchorEl, opts) {
    if (!node || !f) return;
    try {
      if (typeof closeNodePopsExcept === "function") closeNodePopsExcept("ifItem");
    } catch (_) {}
    ITEM.nodeId = node.id;
    ITEM.fieldId = f.id;
    ITEM.rowId = rowId || "";
    const host = itemHost();
    ITEM.el = host;
    host.hidden = false;
    host.classList.add("on");
    paintItem();
    /* 空卡点进来 = 直接进文本编辑：焦点落到第一个可写的输入框 */
    if (opts && opts.focus) {
      try {
        const a = host.querySelector("textarea, input:not([type=checkbox]):not([type=radio])");
        if (a && !a.readOnly && !a.disabled) a.focus();
      } catch (_) {}
    }
    try {
      if (typeof nodePopAnchor === "function")
        nodePopAnchor(host, '.wf-node[data-nid="' + node.id + '"]', { w: 360 }, node.id);
      if (typeof placeNodePop === "function") {
        const anchor = anchorEl && anchorEl.getBoundingClientRect ? anchorEl : document.querySelector('.wf-node[data-nid="' + node.id + '"]');
        placeNodePop(host, anchor, { w: 360 });
      }
    } catch (_) {}
  }
  function itemCommit(node, opts) {
    touch(node);
    writeFile(node, { silent: true });
    const o = opts || {};
    if (o.repaint) paintBoard(node, boardBodyOf(node));
    else refreshBoardItem(node, fieldById(node, o.field), o.rowId || "");
    if (o.close) closeItemPop();
  }
  function paintItem() {
    const host = ITEM.el || itemHost();
    ITEM.el = host;
    const node = nodeOf(ITEM.nodeId);
    const f = node ? fieldById(node, ITEM.fieldId) : null;
    if (!node || !f) {
      closeItemPop();
      return;
    }
    host.innerHTML = "";
    host.classList.add("on");
    const rows = f.type === "list" ? (Array.isArray(node.values[f.id]) ? node.values[f.id] : []) : [];
    const row = ITEM.rowId ? rows.find((r) => r.id === ITEM.rowId) : null;

    const head = el("div", "if-item-head");
    const tt = el("div", "if-item-tt");
    tt.appendChild(el("b", "", row ? f.label + " · " + rowIndexText(node, f, row) : f.label));
    tt.appendChild(el("i", "if-item-kind", typeLabelOf(f.type)));
    head.appendChild(tt);
    const bx = el("button", "if-mini", "✕");
    bx.type = "button";
    bx.title = T("关闭（Esc）");
    bx.onclick = () => closeItemPop();
    head.appendChild(bx);
    host.appendChild(head);

    const box = el("div", "if-item-box");
    if (f.type === "list" && row) {
      for (const c of f.children || []) {
        const cell = el("label", "if-item-cell");
        cell.appendChild(el("span", "if-item-lab", c.label));
        if (MEDIA_TYPES[c.type] === 1) cell.appendChild(itemMedia(node, f, row, c));
        else
        cell.appendChild(
          itemValueControl(
            node,
            row.values,
            c,
            () => itemCommit(node, { field: f.id, rowId: row.id }),
            () => refreshBoardItem(node, f, row.id),
          ),
        );
        box.appendChild(cell);
      }
    } else if (MEDIA_TYPES[f.type] === 1) {
      box.appendChild(itemMedia(node, f, row, f));
    } else {
      box.appendChild(
      itemValueControl(
        node,
        node.values,
        f,
        () => itemCommit(node, { field: f.id, rowId: "" }),
        () => refreshBoardItem(node, f, ""),
      ),
    );
    }
    host.appendChild(box);

    const foot = el("div", "if-item-foot");
    const bPanel = el("button", "mini", T("在面板中编辑"));
    bPanel.type = "button";
    bPanel.title = T("大面板（全屏编辑）：字段定义 / 模板 / 逐行编辑 / 标注 / JSON");
    bPanel.onclick = () => {
      closeItemPop();
      openPanel(node.id);
    };
    foot.appendChild(bPanel);
    if (f.type === "list" && row) {
      const bDel = el("button", "mini if-danger", T("删除这一行"));
      bDel.type = "button";
      bDel.onclick = () => {
        const arr = node.values[f.id] || [];
        const i = arr.indexOf(row);
        if (i >= 0) arr.splice(i, 1);
        touch(node, { structural: true });
        writeFile(node, { silent: true });
        closeItemPop();
        paintBoard(node, boardBodyOf(node));
      };
      foot.appendChild(bDel);
    }
    host.appendChild(foot);
    host.hidden = false;
  }

  /* 普通字段控件（值写到 holder[c.id]；列表行的子字段走同一个函数） */
  function itemValueControl(node, holder, c, commit, onEdit) {
    const wrap = el("div", "if-item-ctrl");
    const disabled = !!c.calc;
    const setVal = (v) => {
      holder[c.id] = v;
      touch(node);
      /* 卡面跟着变：打字时就把这张卡的值换掉，不用等失焦 */
      if (typeof onEdit === "function") {
        try {
          onEdit();
        } catch (_) {}
      }
    };
    const done = () => {
      holder[c.id] = normValue(c, holder[c.id]);
      commit();
    };
    if (c.type === "textarea") {
      const ta = el("textarea", "if-in if-ta");
      /* 1 行文字只占 1 行，多了自己长到 3 行封顶（.if-ta 的 field-sizing: content） */
      ta.rows = 1;
      ta.value = String(holder[c.id] == null ? "" : holder[c.id]);
      ta.readOnly = disabled;
      ta.oninput = () => setVal(ta.value);
      ta.onblur = done;
      wrap.appendChild(ta);
    } else if (c.type === "number" || c.type === "datetime" || c.type === "text") {
      const inp = el("input", "if-in");
      inp.type = c.type === "number" ? "number" : c.type === "datetime" ? "datetime-local" : "text";
      inp.value = holder[c.id] == null ? "" : String(holder[c.id]);
      inp.readOnly = disabled;
      inp.oninput = () => setVal(inp.value);
      inp.onblur = done;
      inp.onkeydown = (ev) => {
        if (ev.key === "Enter") {
          ev.preventDefault();
          inp.blur();
        }
      };
      wrap.appendChild(inp);
    } else if (c.type === "switch") {
      const lab = el("label", "if-switch");
      const cb = el("input");
      cb.type = "checkbox";
      cb.checked = !!holder[c.id];
      cb.disabled = disabled;
      cb.onchange = () => {
        setVal(!!cb.checked);
        done();
      };
      lab.appendChild(cb);
      lab.appendChild(el("span", "if-switch-track"));
      wrap.appendChild(lab);
    } else if (c.type === "select") {
      const sel = el("select", "if-in");
      const o0 = el("option", "", T("（未选）"));
      o0.value = "";
      sel.appendChild(o0);
      for (const o of c.options || []) {
        const op = el("option", "", o);
        op.value = o;
        if (String(holder[c.id]) === o) op.selected = true;
        sel.appendChild(op);
      }
      sel.disabled = disabled;
      sel.onchange = () => {
        setVal(sel.value);
        done();
      };
      wrap.appendChild(sel);
    } else if (c.type === "multiselect") {
      const cur = Array.isArray(holder[c.id]) ? holder[c.id] : [];
      const chips = el("div", "if-chips");
      for (const o of c.options || []) {
        const b = el("button", "if-chip" + (cur.indexOf(o) >= 0 ? " on" : ""), o);
        b.type = "button";
        b.disabled = disabled;
        b.onclick = (ev) => {
          ev.stopPropagation();
          const arr = Array.isArray(holder[c.id]) ? holder[c.id].slice() : [];
          const i = arr.indexOf(o);
          if (i >= 0) arr.splice(i, 1);
          else arr.push(o);
          setVal(arr);
          b.classList.toggle("on");
          done();
        };
        chips.appendChild(b);
      }
      wrap.appendChild(chips);
    } else {
      const inp = el("input", "if-in");
      inp.value = String(holder[c.id] == null ? "" : holder[c.id]);
      inp.readOnly = disabled;
      inp.oninput = () => setVal(inp.value);
      inp.onblur = done;
      wrap.appendChild(inp);
    }
    if (disabled) wrap.classList.add("if-item-ro");
    return wrap;
  }

  /* 素材编辑：预览 / 描述 / 标签 / 标注 / 识图 / 更换 / 移除 */
  function itemMedia(node, f, row, c) {
    const type = c.type;
    const holder = row ? row.values : node.values;
    let media = normMedia(holder[c.id]);
    holder[c.id] = media;
    const box = el("div", "if-item-media");
    const repaint = () => {
      itemCommit(node, { repaint: true });
    };
    if (!media || !media.path) {
      const dz = el("div", "if-drop");
      dz.appendChild(el("div", "if-drop-ico", typeGlyph(type)));
      dz.appendChild(el("div", "if-drop-txt", T("拖入或点击选择") + typeLabelOf(type)));
      const pick = async () => {
        const exts = (TYPE_ACCEPT[type] || "*").split(",");
        const r = await window.api.fileOpenDialog({
          title: T("选择文件"),
          filters: exts[0] === "*" ? [{ name: T("全部文件"), extensions: ["*"] }] : [{ name: T("文件"), extensions: exts }],
        });
        if (r && r.path) await replaceMediaAt(node, f, row, c, [r.path]);
      };
      dz.onclick = (ev) => {
        ev.stopPropagation();
        pick();
      };
      dz.ondragover = (ev) => {
        if (!dragHasPaths(ev)) return;
        ev.preventDefault();
        ev.stopPropagation();
        dz.classList.add("on");
      };
      dz.ondragleave = () => dz.classList.remove("on");
      dz.ondrop = async (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        dz.classList.remove("on");
        const paths = pathsFromDrop(ev);
        if (paths.length) await replaceMediaAt(node, f, row, c, paths);
      };
      box.appendChild(dz);
      return box;
    }

    const top = el("div", "if-media-top");
    const thumb = el("div", "if-media-thumb");
    if (type === "image") {
      const img = el("img");
      img.src = typeof thumbUrlWithBust === "function" ? thumbUrlWithBust(media.path, undefined, 640) : media.path;
      img.alt = "";
      /* 图像预览：点缩略图看大图（与画布其它图片同一条灯箱口径） */
      if (typeof bindImagePreview === "function") bindImagePreview(img, media.path, media.name || "");
      else img.title = T("点击查看大图");
      box.classList.add("if-media-zoom");
      thumb.appendChild(img);
    } else if (type === "video") {
      const v = el("video");
      v.controls = true;
      v.preload = "metadata";
      v.src = window.api && window.api.toFileUrl ? window.api.toFileUrl(media.path) : media.path;
      thumb.appendChild(v);
      thumb.classList.add("if-media-thumb-wide");
    } else if (type === "audio") {
      const a = el("audio");
      a.controls = true;
      a.src = window.api && window.api.toFileUrl ? window.api.toFileUrl(media.path) : media.path;
      thumb.appendChild(a);
      thumb.classList.add("if-media-thumb-wide");
    } else {
      thumb.appendChild(el("div", "if-file-ico", "📄"));
    }
    top.appendChild(thumb);

    const meta = el("div", "if-media-meta");
    meta.appendChild(el("div", "if-media-name", media.name || String(media.path).split(/[\\/]/).pop()));
    const opsRow = el("div", "if-media-ops");
    if (type === "image" || type === "video") {
      const bAuto = el("button", "if-mini", T("识图补充"));
      bAuto.type = "button";
      bAuto.title = T("用识图模型补一段描述（视频抽 3~6 帧汇总）");
      bAuto.onclick = async () => {
        if (IF.ui.busy[f.id]) return;
        /* 识图先弹窗确认（可选模型 / 思考档 / 提示词，默认无思考），出口只有「识图」和「关闭」 */
        const spec = await askVisionSpec(typeLabelOf(type), type);
        if (!spec) return;
        IF.ui.busy[f.id] = true;
        bAuto.textContent = T("识图中…");
        bAuto.disabled = true;
        const ok = await autoDescribe(node, c, media, spec);
        IF.ui.busy[f.id] = false;
        if (ok) writeFile(node, { silent: true });
        /* 识图一结束就要看见新描述：这张卡在浮层里，paintBoard 刷不到浮层本身 ——
           只重绘板身的话，得关掉浮层再打开才看到内容（本次修的「没第一时间更新」）。 */
        refreshBoardItem(node, f, row ? row.id : "");
        if (ITEM.nodeId === node.id && ITEM.fieldId === f.id) paintItem();
        else repaint();
        try {
          if (typeof toast === "function" && ok) toast(T("描述已补充"), "ok");
        } catch (_) {}
      };
      opsRow.appendChild(bAuto);
      const bMark = el("button", "if-mini", T("标注") + "（" + (media.marks || []).length + "）");
      bMark.type = "button";
      bMark.onclick = () => {
        IF.ui.annotate = { fieldId: f.id, rowId: row ? row.id : "" };
        openPanel(node.id);
        IF.ui.annotate = { fieldId: f.id, rowId: row ? row.id : "" };
        paintPanel();
      };
      opsRow.appendChild(bMark);
    }
    const bReplace = el("button", "if-mini", T("更换"));
    bReplace.type = "button";
    bReplace.onclick = async () => {
      const exts = (TYPE_ACCEPT[type] || "*").split(",");
      const r = await window.api.fileOpenDialog({
        title: T("选择文件"),
        filters: exts[0] === "*" ? [{ name: T("全部文件"), extensions: ["*"] }] : [{ name: T("文件"), extensions: exts }],
      });
      if (r && r.path) await replaceMediaAt(node, f, row, c, [r.path]);
    };
    opsRow.appendChild(bReplace);
    const bClear = el("button", "if-mini if-danger", T("移除"));
    bClear.type = "button";
    bClear.onclick = () => {
      holder[c.id] = null;
      media = null;
      touch(node);
      writeFile(node, { silent: true });
      closeItemPop();
      paintBoard(node, boardBodyOf(node));
    };
    opsRow.appendChild(bClear);
    meta.appendChild(opsRow);
    top.appendChild(meta);
    box.appendChild(top);

    const desc = el("textarea", "if-in if-desc");
    /* 描述框：1 行文字只占 1 行，最多 3 行（.if-desc 的 field-sizing: content） */
    desc.rows = 1;
    desc.placeholder = T("内容描述（可点「识图补充」自动填；每次 @引用 时 Agent 都会看到）");
    desc.value = media.desc || "";
    desc.oninput = () => {
      media.desc = desc.value;
      touch(node);
    };
    desc.onblur = () => {
      writeFile(node, { silent: true });
      refreshBoardItem(node, f, row ? row.id : "");
    };
    box.appendChild(desc);

    const tags = el("input", "if-in");
    tags.placeholder = T("标签，逗号分隔");
    tags.value = (media.tags || []).join(",");
    tags.onchange = () => {
      media.tags = String(tags.value || "")
        .split(/[,，]/)
        .map((x) => x.trim())
        .filter(Boolean);
      touch(node);
      writeFile(node, { silent: true });
      refreshBoardItem(node, f, row ? row.id : "");
    };
    box.appendChild(tags);

    if ((type === "image" || type === "video") && media.marks && media.marks.length) {
      const list = el("div", "if-marks");
      for (const m of media.marks) {
        const line = el("div", "if-mark-line");
        const where =
          m.start != null || m.end != null
            ? "[" + num(m.start, 0) + "s~" + (m.end != null ? num(m.end, 0) + "s" : "…") + "]"
            : Number.isFinite(m.x)
              ? "[" + Math.round(m.x * 100) + "%," + Math.round(m.y * 100) + "%]"
              : "";
        line.appendChild(el("span", "if-mark-where", where));
        line.appendChild(el("span", "if-mark-text", m.text || T("（无文字）")));
        list.appendChild(line);
      }
      box.appendChild(list);
    }
    return box;
  }

  /* ---------------- 大面板 ---------------- */

  const IF = {
    ui: {
      nodeId: "",
      editingField: "",
      previewJson: false,
      annotate: null,
      busy: {},
      lastSavedAt: 0,
      lastError: "",
    },
  };

  /* 展开 = 占满画布面积（不是整窗浮窗）：按 #canvas 的实际矩形贴合，窗口 / 布局变化时重贴 */
  function fitPanelToCanvas(host) {
    const h = host || document.getElementById("ifOverlay");
    if (!h) return;
    const cv = document.getElementById("canvas");
    if (!cv || typeof cv.getBoundingClientRect !== "function") {
      h.classList.add("is-window");
      h.style.left = h.style.top = h.style.width = h.style.height = "";
      return;
    }
    const r = cv.getBoundingClientRect();
    if (!r || r.width < 40 || r.height < 40) {
      h.classList.add("is-window");
      h.style.left = h.style.top = h.style.width = h.style.height = "";
      return;
    }
    h.classList.remove("is-window");
    h.style.left = Math.round(r.left) + "px";
    h.style.top = Math.round(r.top) + "px";
    h.style.width = Math.round(r.width) + "px";
    h.style.height = Math.round(r.height) + "px";
  }
  function panelHost() {
    let host = document.getElementById("ifOverlay");
    if (host) return host;
    host = el("div", "if-overlay");
    host.id = "ifOverlay";
    host.hidden = true;
    document.body.appendChild(host);
    host.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape") {
        ev.stopPropagation();
        closePanel();
      }
    });
    const refit = () => {
      if (host.hidden) return;
      fitPanelToCanvas(host);
    };
    window.addEventListener("resize", refit);
    if (typeof window !== "undefined" && typeof window.requestAnimationFrame === "function")
      window.requestAnimationFrame(refit);
    return host;
  }
  function openPanel(nodeId) {
    const node = nodeOf(nodeId);
    if (!node) return;
    IF.ui.nodeId = nodeId;
    IF.ui.editingField = "";
    IF.ui.annotate = null;
    const host = panelHost();
    host.hidden = false;
    fitPanelToCanvas(host);
    paintPanel();
    fitPanelToCanvas(host);
    readBack(node).then((r) => {
      if (r && r.took) {
        paintPanel();
        try {
          if (typeof toast === "function") toast(T("已按磁盘上的 .json 更新"), "ok");
        } catch (_) {}
      }
    });
    const first = host.querySelector("input.if-name");
    if (first) setTimeout(() => first.focus(), 30);
  }
  function closePanel() {
    const host = document.getElementById("ifOverlay");
    if (host) {
      host.hidden = true;
      host.innerHTML = "";
    }
    IF.ui.nodeId = "";
    IF.ui.annotate = null;
  }

  function paintPanel() {
    const host = document.getElementById("ifOverlay");
    const node = nodeOf(IF.ui.nodeId);
    if (!host || !node) return;
    normalize(node);
    const scroll = host.querySelector(".if-scroll");
    const keep = scroll ? scroll.scrollTop : 0;
    host.innerHTML = "";
    const panel = el("div", "if-panel");
    host.appendChild(panel);

    /* 头部 */
    const head = el("header", "if-head");
    const titleBox = el("div", "if-title");
    titleBox.appendChild(el("span", "if-dot"));
    const nameIn = el("input", "if-name");
    nameIn.value = String(node.formName || "");
    nameIn.spellcheck = false;
    nameIn.title = T("表单名（同时是落盘文件名）");
    nameIn.onchange = () => {
      const v = String(nameIn.value || "").trim() || T("表单");
      if (v === node.formName) return;
      node.formName = v;
      node.formFile = relPathOf(node);
      touch(node, { structural: true });
      writeFile(node, { silent: true });
      if (typeof renderCanvas === "function") renderCanvas();
    };
    titleBox.appendChild(nameIn);
    head.appendChild(titleBox);

    const ops = el("div", "if-head-ops");
    const tplSel = el("select", "if-tpl");
    tplSel.title = T("套用模板（同名字段沿用已填内容）");
    const opt0 = el("option", "", T("套用模板…"));
    opt0.value = "";
    tplSel.appendChild(opt0);
    for (const t of allTemplates()) {
      const o = el("option", "", t.name + (t.builtin ? "" : " · " + T("我的")));
      o.value = t.id;
      tplSel.appendChild(o);
    }
    tplSel.onchange = () => {
      const id = tplSel.value;
      if (!id) return;
      const oldFields = (node.fields || []).slice();
      applyTemplate(node, id, { keepValues: true, oldFields });
      touch(node, { structural: true });
      writeFile(node, { silent: true });
      if (typeof renderCanvas === "function") renderCanvas();
      paintPanel();
      try {
        if (typeof toast === "function") toast(T("已套用模板：") + node.formName, "ok");
      } catch (_) {}
    };
    ops.appendChild(tplSel);

    const bSaveTpl = el("button", "mini", T("存为我的模板"));
    bSaveTpl.onclick = async () => {
      const nm = await saveAsMyTemplate(node);
      if (nm) {
        try {
          if (typeof toast === "function") toast(T("已存为模板：") + nm, "ok");
        } catch (_) {}
        paintPanel();
      }
    };
    ops.appendChild(bSaveTpl);

    const bRefresh = el("button", "mini", T("刷新"));
    bRefresh.title = T("从磁盘回读 .json（结构与值都回读；谁的时间新谁赢）");
    bRefresh.onclick = async () => {
      const r = await readBack(node);
      paintPanel();
      try {
        if (typeof toast === "function")
          toast(r && r.took ? T("已按磁盘上的 .json 更新") : T("磁盘上没有更新的内容"), r && r.took ? "ok" : "warn");
      } catch (_) {}
    };
    ops.appendChild(bRefresh);

    const bJson = el("button", "mini" + (IF.ui.previewJson ? " on" : ""), T("JSON"));
    bJson.onclick = () => {
      IF.ui.previewJson = !IF.ui.previewJson;
      paintPanel();
    };
    ops.appendChild(bJson);

    const bClose = el("button", "mini if-close", "✕");
    bClose.title = T("收起面板（Esc）");
    bClose.onclick = closePanel;
    ops.appendChild(bClose);
    head.appendChild(ops);
    panel.appendChild(head);

    /* 落盘信息条 */
    const info = el("div", "if-info");
    const p = filePathOf(node);
    info.textContent = p
      ? T("落盘：") + p + (IF.ui.lastSavedAt ? T("　· 已保存 ") + new Date(IF.ui.lastSavedAt).toLocaleTimeString() : "")
      : T("还没有设置画布工作目录：内容会跟着画布保存，但不会生成 .json 文件供 Agent 直接读。");
    if (!p) info.classList.add("warn");
    panel.appendChild(info);

    /* 主体 */
    const scrollBox = el("div", "if-scroll");
    panel.appendChild(scrollBox);

    /* 面板也能整块接：拖到面板任意处 → 追加到素材列表（与板身同一口径，acceptPaths 内部去重） */
    panel.ondragover = (ev) => {
      if (!dragHasPaths(ev)) return;
      ev.preventDefault();
      if (ev.dataTransfer) ev.dataTransfer.dropEffect = "copy";
      dropOver(panel, T("松开即加入素材列表"));
    };
    panel.ondragleave = (ev) => {
      if (ev && ev.relatedTarget && panel.contains(ev.relatedTarget)) return;
      dropOut(panel);
    };
    panel.ondrop = async (ev) => {
      ev.preventDefault();
      dropOut(panel);
      const paths = pathsFromDrop(ev);
      if (!paths.length) return;
      flashDrop(panel);
      await acceptPaths(node, null, paths);
    };

    if (IF.ui.previewJson) {
      const pre = el("pre", "if-json");
      pre.textContent = JSON.stringify(payload(node), null, 2);
      const box = el("div", "if-json-wrap");
      box.appendChild(pre);
      scrollBox.appendChild(box);
      maybeAnnotate(node, host);
      return;
    }

    const fieldsWrap = el("div", "if-fields");
    const vis = visibleMap(node);
    let idx = 0;
    for (const f of node.fields || []) {
      idx += 1;
      fieldsWrap.appendChild(fieldCard(node, f, idx, vis));
    }
    scrollBox.appendChild(fieldsWrap);

    /* 底部：加字段 */
    const foot = el("div", "if-foot");
    const addWrap = el("div", "if-add");
    const bAdd = el("button", "if-add-btn", T("＋ 添加字段"));
    bAdd.onclick = (ev) => {
      ev.stopPropagation();
      const menu = addWrap.querySelector(".if-add-menu");
      if (menu) {
        menu.remove();
        return;
      }
      const m = el("div", "if-add-menu");
      for (const t of FIELD_TYPES) {
        const b = el("button", "if-add-item", t.label);
        b.onclick = () => {
          node.fields.push(blankField(t.id));
          touch(node, { structural: true });
          writeFile(node, { silent: true });
          if (typeof renderCanvas === "function") renderCanvas();
          paintPanel();
        };
        m.appendChild(b);
      }
      addWrap.appendChild(m);
    };
    addWrap.appendChild(bAdd);
    foot.appendChild(addWrap);

    const miss = missingRequired(node);
    const hint = el("div", "if-foot-hint" + (miss.length ? " bad" : ""));
    hint.textContent = miss.length ? T("必填未填：") + miss.map((m) => m.label).join("、") : T("必填已填齐");
    foot.appendChild(hint);

    const bBatch = el("button", "mini", T("一键补齐空描述"));
    bBatch.title = T("对还没写描述的图像 / 视频批量识图（会消耗模型调用）");
    bBatch.onclick = async () => {
      if (IF.ui.busy.batch) return;
      const spec = await askVisionSpec(T("素材"), "");
      if (!spec) return;
      IF.ui.busy.batch = true;
      paintPanel();
      let n = 0;
      for (const f of node.fields || []) {
        if (MEDIA_TYPES[f.type] === 1 && (f.type === "image" || f.type === "video")) {
          const v = node.values[f.id];
          if (v && v.path && !String(v.desc || "").trim()) {
            if (await autoDescribe(node, f, v, spec)) n += 1;
          }
        }
        if (f.type === "list") {
          for (const r of node.values[f.id] || []) {
            for (const c of f.children || []) {
              if (c.type !== "image" && c.type !== "video") continue;
              const cv = (r.values || {})[c.id];
              if (cv && cv.path && !String(cv.desc || "").trim()) {
                if (await autoDescribe(node, c, cv, spec)) n += 1;
              }
            }
          }
        }
      }
      IF.ui.busy.batch = false;
      writeFile(node, { silent: true });
      paintPanel();
      try {
        if (typeof toast === "function") toast(n ? T("已补充 ") + n + T(" 条描述") : T("没有需要补充的素材"), n ? "ok" : "warn");
      } catch (_) {}
    };
    foot.appendChild(bBatch);
    scrollBox.appendChild(foot);

    maybeAnnotate(node, host);
    fitPanelToCanvas(host);
    requestAnimationFrame(() => {
      const s = host.querySelector(".if-scroll");
      if (s) s.scrollTop = keep;
    });
  }

  /* 单个字段卡片 */
  function fieldCard(node, f, idx, vis) {
    const card = el("section", "if-card" + (vis[f.id] ? "" : " if-hidden"));
    card.dataset.fieldId = f.id;
    const head = el("div", "if-card-head");
    const lab = el("label", "if-card-label");
    lab.textContent = f.label;
    if (f.required) lab.appendChild(el("i", "if-req", "*"));
    if (f.calc) lab.appendChild(el("i", "if-auto", T("自动")));
    if (!vis[f.id]) lab.appendChild(el("i", "if-off", T("已隐藏")));
    head.appendChild(lab);
    const ops = el("div", "if-card-ops");
    const bEdit = el("button", "if-mini" + (IF.ui.editingField === f.id ? " on" : ""), "⚙");
    bEdit.title = T("编辑字段定义（标签 / 类型 / 必填 / 选项 / 默认值 / 计算 / 显示规则）");
    bEdit.onclick = () => {
      IF.ui.editingField = IF.ui.editingField === f.id ? "" : f.id;
      paintPanel();
    };
    ops.appendChild(bEdit);
    if (IF.ui.editingField === f.id) {
      const bUp = el("button", "if-mini", "↑");
      bUp.title = T("上移");
      bUp.onclick = () => {
        const i = node.fields.indexOf(f);
        if (i > 0) {
          node.fields.splice(i, 1);
          node.fields.splice(i - 1, 0, f);
          touch(node, { structural: true });
          writeFile(node, { silent: true });
          paintPanel();
        }
      };
      ops.appendChild(bUp);
      const bDel = el("button", "if-mini if-danger", "✕");
      bDel.title = T("删除这个字段");
      bDel.onclick = () => {
        node.fields = node.fields.filter((x) => x.id !== f.id);
        delete node.values[f.id];
        IF.ui.editingField = "";
        touch(node, { structural: true });
        writeFile(node, { silent: true });
        if (typeof renderCanvas === "function") renderCanvas();
        paintPanel();
      };
      ops.appendChild(bDel);
    }
    head.appendChild(ops);
    card.appendChild(head);

    if (IF.ui.editingField === f.id) card.appendChild(fieldEditor(node, f));
    card.appendChild(fieldControl(node, f, vis[f.id]));

    if (f.hint && IF.ui.editingField !== f.id) {
      const h = el("div", "if-hint", f.hint);
      card.appendChild(h);
    }
    return card;
  }

  function fieldEditor(node, f) {
    const box = el("div", "if-editor");
    const row1 = el("div", "if-row");
    const labIn = el("input", "if-in");
    labIn.value = f.label;
    labIn.placeholder = T("字段名");
    labIn.onchange = () => {
      f.label = String(labIn.value || "").trim() || f.label;
      touch(node, { structural: true });
      writeFile(node, { silent: true });
      if (typeof renderCanvas === "function") renderCanvas();
      paintPanel();
    };
    row1.appendChild(labIn);
    const typeSel = el("select", "if-in");
    for (const t of FIELD_TYPES) {
      const o = el("option", "", t.label);
      o.value = t.id;
      if (t.id === f.type) o.selected = true;
      typeSel.appendChild(o);
    }
    typeSel.onchange = () => {
      const t = typeSel.value;
      f.type = t;
      if (t === "list" && (!f.children || !f.children.length)) f.children = [blankField("text"), blankField("textarea")];
      if ((t === "select" || t === "multiselect") && (!f.options || !f.options.length)) f.options = ["选项一", "选项二"];
      node.values[f.id] = blankValue(f);
      touch(node, { structural: true });
      writeFile(node, { silent: true });
      paintPanel();
    };
    row1.appendChild(typeSel);
    box.appendChild(row1);

    const row2 = el("div", "if-row");
    const cb = el("input");
    cb.type = "checkbox";
    cb.checked = !!f.required;
    cb.onchange = () => {
      f.required = !!cb.checked;
      touch(node, { structural: true });
      paintPanel();
    };
    const cbLab = el("label", "if-check");
    cbLab.appendChild(cb);
    cbLab.appendChild(document.createTextNode(T("必填") + "（只提示不阻断）"));
    row2.appendChild(cbLab);
    box.appendChild(row2);

    const hintIn = el("input", "if-in");
    hintIn.value = f.hint || "";
    hintIn.placeholder = T("字段说明（给人和 Agent 看的提示）");
    hintIn.onchange = () => {
      f.hint = String(hintIn.value || "");
      touch(node);
      paintPanel();
    };
    box.appendChild(hintIn);

    if (f.type === "select" || f.type === "multiselect") {
      const optIn = el("input", "if-in");
      optIn.value = (f.options || []).join(",");
      optIn.placeholder = T("选项，逗号分隔");
      optIn.onchange = () => {
        f.options = String(optIn.value || "")
          .split(/[,，]/)
          .map((x) => x.trim())
          .filter(Boolean);
        touch(node, { structural: true });
        writeFile(node, { silent: true });
        paintPanel();
      };
      box.appendChild(optIn);
    }

    const defIn = el("input", "if-in");
    defIn.value = f.default == null ? "" : String(f.default);
    defIn.placeholder = T("默认值（写 =表达式 走计算，例：=4 或 =h.now()）");
    defIn.onchange = () => {
      f.default = String(defIn.value || "");
      applyDefaultsAndCalc(node);
      touch(node);
      writeFile(node, { silent: true });
      paintPanel();
    };
    box.appendChild(defIn);

    const calcIn = el("input", "if-in");
    calcIn.value = f.calc || "";
    calcIn.placeholder = T("计算表达式（只读字段）：v.张数 * 2 ／ h.sum(v.列表.map(function(r){return Number(r['时长'])||0;}))");
    calcIn.onchange = () => {
      f.calc = String(calcIn.value || "");
      applyDefaultsAndCalc(node);
      touch(node, { structural: true });
      writeFile(node, { silent: true });
      paintPanel();
    };
    box.appendChild(calcIn);

    /* 显示规则：当某字段满足条件时才显示 */
    const ruleRow = el("div", "if-row");
    const sw = el("select", "if-in");
    const oNone = el("option", "", T("总是显示"));
    oNone.value = "";
    sw.appendChild(oNone);
    for (const other of node.fields || []) {
      if (other.id === f.id) continue;
      const o = el("option", "", T("当「") + other.label + "」…");
      o.value = other.id;
      if (f.showWhen && f.showWhen.field === other.id) o.selected = true;
      sw.appendChild(o);
    }
    sw.onchange = () => {
      if (!sw.value) f.showWhen = null;
      else f.showWhen = { field: sw.value, op: (f.showWhen && f.showWhen.op) || "notEmpty", value: (f.showWhen && f.showWhen.value) || "" };
      touch(node, { structural: true });
      paintPanel();
    };
    ruleRow.appendChild(sw);
    if (f.showWhen) {
      const opSel = el("select", "if-in");
      const OPS = [
        ["notEmpty", "有值"],
        ["empty", "为空"],
        ["eq", "等于"],
        ["neq", "不等于"],
        ["truthy", "为真"],
      ];
      for (const [id, label] of OPS) {
        const o = el("option", "", label);
        o.value = id;
        if (f.showWhen.op === id) o.selected = true;
        opSel.appendChild(o);
      }
      opSel.onchange = () => {
        f.showWhen.op = opSel.value;
        touch(node, { structural: true });
        paintPanel();
      };
      ruleRow.appendChild(opSel);
      if (f.showWhen.op === "eq" || f.showWhen.op === "neq") {
        const valIn = el("input", "if-in if-in-sm");
        valIn.value = f.showWhen.value || "";
        valIn.placeholder = T("比较值");
        valIn.onchange = () => {
          f.showWhen.value = String(valIn.value || "");
          touch(node, { structural: true });
          paintPanel();
        };
        ruleRow.appendChild(valIn);
      }
    }
    box.appendChild(ruleRow);

    if (f.type === "list") {
      const chBox = el("div", "if-children");
      chBox.appendChild(el("div", "if-children-title", T("每行的子字段")));
      (f.children || []).forEach((c) => {
        const r = el("div", "if-row");
        const nIn = el("input", "if-in");
        nIn.value = c.label;
        nIn.onchange = () => {
          c.label = String(nIn.value || "").trim() || c.label;
          touch(node, { structural: true });
          writeFile(node, { silent: true });
          paintPanel();
        };
        r.appendChild(nIn);
        const tSel = el("select", "if-in");
        for (const t of FIELD_TYPES) {
          if (t.id === "list") continue;
          const o = el("option", "", t.label);
          o.value = t.id;
          if (t.id === c.type) o.selected = true;
          tSel.appendChild(o);
        }
        tSel.onchange = () => {
          c.type = tSel.value;
          touch(node, { structural: true });
          writeFile(node, { silent: true });
          paintPanel();
        };
        r.appendChild(tSel);
        const del = el("button", "if-mini if-danger", "✕");
        del.onclick = () => {
          f.children = f.children.filter((x) => x.id !== c.id);
          touch(node, { structural: true });
          writeFile(node, { silent: true });
          paintPanel();
        };
        r.appendChild(del);
        chBox.appendChild(r);
      });
      const addChild = el("button", "if-mini", T("＋ 子字段"));
      addChild.onclick = () => {
        f.children.push(blankField("text"));
        touch(node, { structural: true });
        writeFile(node, { silent: true });
        paintPanel();
      };
      chBox.appendChild(addChild);
      box.appendChild(chBox);
    }
    return box;
  }

  /* 字段控件（按类型） */
  function fieldControl(node, f, visible) {
    const wrap = el("div", "if-ctrl");
    const setVal = (v) => {
      node.values[f.id] = v;
      touch(node);
    };
    const commit = () => {
      writeFile(node, { silent: true });
      if (typeof renderCanvas === "function") renderCanvas();
    };
    const disabled = !!f.calc;

    if (f.type === "text" || f.type === "datetime") {
      const inp = el("input", "if-in if-main");
      inp.type = f.type === "datetime" ? "datetime-local" : "text";
      inp.value = String(node.values[f.id] || "");
      inp.readOnly = disabled;
      inp.oninput = () => setVal(inp.value);
      inp.onchange = commit;
      wrap.appendChild(inp);
    } else if (f.type === "textarea") {
      const ta = el("textarea", "if-in if-main if-ta");
      /* 同上：最小 1 行，最多 3 行 */
      ta.rows = 1;
      ta.value = String(node.values[f.id] || "");
      ta.readOnly = disabled;
      ta.oninput = () => setVal(ta.value);
      ta.onchange = commit;
      wrap.appendChild(ta);
    } else if (f.type === "number") {
      const inp = el("input", "if-in if-main");
      inp.type = "number";
      inp.value = node.values[f.id] === "" ? "" : String(node.values[f.id]);
      inp.readOnly = disabled;
      inp.oninput = () => setVal(inp.value === "" ? "" : Number(inp.value));
      inp.onchange = commit;
      wrap.appendChild(inp);
    } else if (f.type === "switch") {
      const lab = el("label", "if-switch");
      const cb = el("input");
      cb.type = "checkbox";
      cb.checked = !!node.values[f.id];
      cb.disabled = disabled;
      cb.onchange = () => {
        setVal(!!cb.checked);
        commit();
      };
      lab.appendChild(cb);
      lab.appendChild(el("span", "if-switch-track"));
      wrap.appendChild(lab);
    } else if (f.type === "select") {
      const sel = el("select", "if-in if-main");
      const o0 = el("option", "", T("（未选）"));
      o0.value = "";
      sel.appendChild(o0);
      for (const o of f.options || []) {
        const op = el("option", "", o);
        op.value = o;
        if (String(node.values[f.id]) === o) op.selected = true;
        sel.appendChild(op);
      }
      sel.disabled = disabled;
      sel.onchange = () => {
        setVal(sel.value);
        commit();
      };
      wrap.appendChild(sel);
    } else if (f.type === "multiselect") {
      const cur = Array.isArray(node.values[f.id]) ? node.values[f.id] : [];
      const box = el("div", "if-chips");
      for (const o of f.options || []) {
        const b = el("button", "if-chip" + (cur.indexOf(o) >= 0 ? " on" : ""), o);
        b.disabled = disabled;
        b.onclick = () => {
          const arr = Array.isArray(node.values[f.id]) ? node.values[f.id].slice() : [];
          const i = arr.indexOf(o);
          if (i >= 0) arr.splice(i, 1);
          else arr.push(o);
          setVal(arr);
          commit();
          b.classList.toggle("on");
        };
        box.appendChild(b);
      }
      wrap.appendChild(box);
    } else if (f.type === "list") {
      wrap.appendChild(listControl(node, f));
    } else if (MEDIA_TYPES[f.type] === 1) {
      wrap.appendChild(mediaControl(node, f, f.type));
    } else {
      const inp = el("input", "if-in if-main");
      inp.value = String(node.values[f.id] || "");
      inp.oninput = () => setVal(inp.value);
      inp.onchange = commit;
      wrap.appendChild(inp);
    }
    if (!visible) wrap.classList.add("if-ctrl-off");
    return wrap;
  }

  function listControl(node, f) {
    const box = el("div", "if-list");
    const rows = Array.isArray(node.values[f.id]) ? node.values[f.id] : [];
    rows.forEach((r, i) => {
      const row = el("div", "if-list-row");
      const bar = el("div", "if-list-bar");
      bar.appendChild(el("span", "if-list-no", String(i + 1)));
      const ops = el("div", "if-card-ops");
      const bDel = el("button", "if-mini if-danger", "✕");
      bDel.title = T("删除这一行");
      bDel.onclick = () => {
        rows.splice(i, 1);
        touch(node, { structural: true });
        writeFile(node, { silent: true });
        if (typeof renderCanvas === "function") renderCanvas();
        paintPanel();
      };
      ops.appendChild(bDel);
      bar.appendChild(ops);
      row.appendChild(bar);
      for (const c of f.children || []) {
        const cell = el("div", "if-cell");
        const lab = el("div", "if-cell-label");
        lab.textContent = c.label;
        cell.appendChild(lab);
        const holder = el("div", "if-cell-ctrl");
        /* 行内子字段复用同一套控件：用一层临时 node 视图把值接到 row.values 上 */
        holder.appendChild(cellControl(node, f, r, c));
        cell.appendChild(holder);
        row.appendChild(cell);
      }
      box.appendChild(row);
    });
    const add = el("button", "if-add-row", T("＋ 添加行"));
    add.onclick = () => {
      if (!Array.isArray(node.values[f.id])) node.values[f.id] = [];
      node.values[f.id].push(normRow(f, null));
      touch(node, { structural: true });
      writeFile(node, { silent: true });
      if (typeof renderCanvas === "function") renderCanvas();
      paintPanel();
    };
    box.appendChild(add);
    return box;
  }

  /* 列表行里的子字段控件（值存在 row.values[c.id] 上） */
  function cellControl(node, parent, row, c) {
    const wrap = el("div", "if-ctrl");
    const setVal = (v) => {
      row.values[c.id] = v;
      touch(node);
    };
    const commit = () => {
      writeFile(node, { silent: true });
      if (typeof renderCanvas === "function") renderCanvas();
    };
    if (c.type === "textarea") {
      const ta = el("textarea", "if-in if-main if-ta");
      /* 列表行里的子字段同样：1 行起，最多 3 行 */
      ta.rows = 1;
      ta.value = String(row.values[c.id] || "");
      ta.oninput = () => setVal(ta.value);
      ta.onchange = commit;
      wrap.appendChild(ta);
    } else if (c.type === "number") {
      const inp = el("input", "if-in if-main");
      inp.type = "number";
      inp.value = row.values[c.id] === "" ? "" : String(row.values[c.id]);
      inp.oninput = () => setVal(inp.value === "" ? "" : Number(inp.value));
      inp.onchange = commit;
      wrap.appendChild(inp);
    } else if (c.type === "switch") {
      const cb = el("input");
      cb.type = "checkbox";
      cb.checked = !!row.values[c.id];
      cb.onchange = () => {
        setVal(!!cb.checked);
        commit();
      };
      wrap.appendChild(cb);
    } else if (c.type === "select") {
      const sel = el("select", "if-in if-main");
      const o0 = el("option", "", T("（未选）"));
      o0.value = "";
      sel.appendChild(o0);
      for (const o of c.options || []) {
        const op = el("option", "", o);
        op.value = o;
        if (String(row.values[c.id]) === o) op.selected = true;
        sel.appendChild(op);
      }
      sel.onchange = () => {
        setVal(sel.value);
        commit();
      };
      wrap.appendChild(sel);
    } else if (MEDIA_TYPES[c.type] === 1) {
      wrap.appendChild(mediaControl(node, c, c.type, row));
    } else {
      const inp = el("input", "if-in if-main");
      inp.value = String(row.values[c.id] || "");
      inp.oninput = () => setVal(inp.value);
      inp.onchange = commit;
      wrap.appendChild(inp);
    }
    return wrap;
  }

  /* 媒体字段：拖入区 / 缩略图 / 描述 / 标签 / 标注 / 识图 */
  function mediaControl(node, f, type, row) {
    const box = el("div", "if-media");
    const holder = row ? row.values : node.values;
    let media = normMedia(holder[f.id]);
    holder[f.id] = media;
    const setMediaValue = (v) => {
      holder[f.id] = v;
      media = v;
      touch(node);
      writeFile(node, { silent: true });
      if (typeof renderCanvas === "function") renderCanvas();
      paintPanel();
    };

    if (!media || !media.path) {
      const dz = el("div", "if-drop");
      dz.appendChild(el("div", "if-drop-ico", type === "image" ? "🖼" : type === "video" ? "🎬" : type === "audio" ? "🎵" : "📄"));
      const dzTxt = el("div", "if-drop-txt", T("拖入或点击选择") + (type === "image" ? T("图像") : type === "video" ? T("视频") : type === "audio" ? T("音频") : T("文件")));
      const dzBase = dzTxt.textContent;
      dz.appendChild(dzTxt);
      dz.onclick = async () => {
        const exts = (TYPE_ACCEPT[type] || "*").split(",");
        const r = await window.api.fileOpenDialog({
          title: T("选择文件"),
          filters: exts[0] === "*" ? [{ name: T("全部文件"), extensions: ["*"] }] : [{ name: T("文件"), extensions: exts }],
        });
        if (r && r.path) await acceptPaths(node, Object.assign({ type }, f), [r.path]);
      };
      dz.ondragover = (ev) => {
        if (!dragHasPaths(ev)) return;
        ev.preventDefault();
        ev.stopPropagation();
        if (ev.dataTransfer) ev.dataTransfer.dropEffect = "copy";
        dz.classList.add("on");
        dzTxt.textContent = T("松开即加入");
      };
      dz.ondragleave = () => {
        dz.classList.remove("on");
        dzTxt.textContent = dzBase;
      };
      dz.ondrop = async (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        dz.classList.remove("on");
        dzTxt.textContent = dzBase;
        const paths = pathsFromDrop(ev);
        if (!paths.length) return;
        flashDrop(dz);
        await acceptPaths(node, Object.assign({ type }, f), paths);
      };
      box.appendChild(dz);
      return box;
    }

    const top = el("div", "if-media-top");
    const thumb = el("div", "if-media-thumb");
    if (type === "image") {
      const img = el("img");
      img.src = typeof thumbUrlWithBust === "function" ? thumbUrlWithBust(media.path) : media.path;
      img.alt = "";
      if (typeof bindImagePreview === "function") bindImagePreview(img, media.path, media.name || "");
      else img.title = T("点击查看大图");
      thumb.appendChild(img);
    } else if (type === "video") {
      const v = el("video");
      v.controls = true;
      v.preload = "metadata";
      v.src = window.api && window.api.toFileUrl ? window.api.toFileUrl(media.path) : media.path;
      thumb.appendChild(v);
      thumb.classList.add("if-media-thumb-wide");
    } else if (type === "audio") {
      const a = el("audio");
      a.controls = true;
      a.src = window.api && window.api.toFileUrl ? window.api.toFileUrl(media.path) : media.path;
      thumb.appendChild(a);
      thumb.classList.add("if-media-thumb-wide");
    } else {
      thumb.appendChild(el("div", "if-file-ico", "📄"));
    }
    top.appendChild(thumb);

    const meta = el("div", "if-media-meta");
    meta.appendChild(el("div", "if-media-name", media.name || media.path.split(/[\\/]/).pop()));
    const opsRow = el("div", "if-media-ops");
    if (type === "image" || type === "video") {
      const bAuto = el("button", "if-mini", T("识图补充"));
      bAuto.title = T("用识图模型补一段描述（视频抽 3~6 帧汇总）");
      bAuto.onclick = async () => {
        if (IF.ui.busy[f.id]) return;
        const spec = await askVisionSpec(typeLabelOf(type), type);
        if (!spec) return;
        IF.ui.busy[f.id] = true;
        bAuto.textContent = T("识图中…");
        bAuto.disabled = true;
        const ok = await autoDescribe(node, f, media, spec);
        IF.ui.busy[f.id] = false;
        if (ok) writeFile(node, { silent: true });
        refreshBoardItem(node, f, row ? row.id : "");
        paintPanel();
        try {
          if (typeof toast === "function" && ok) toast(T("描述已补充"), "ok");
        } catch (_) {}
      };
      opsRow.appendChild(bAuto);
      const bMark = el("button", "if-mini", T("标注") + "（" + (media.marks || []).length + "）");
      bMark.onclick = () => {
        IF.ui.annotate = { fieldId: f.id, rowId: row ? row.id : "" };
        paintPanel();
      };
      opsRow.appendChild(bMark);
    }
    const bReplace = el("button", "if-mini", T("更换"));
    bReplace.onclick = async () => {
      const exts = (TYPE_ACCEPT[type] || "*").split(",");
      const r = await window.api.fileOpenDialog({
        title: T("选择文件"),
        filters: exts[0] === "*" ? [{ name: T("全部文件"), extensions: ["*"] }] : [{ name: T("文件"), extensions: exts }],
      });
      if (r && r.path) await acceptPaths(node, Object.assign({ type }, f), [r.path]);
    };
    opsRow.appendChild(bReplace);
    const bClear = el("button", "if-mini if-danger", T("移除"));
    bClear.onclick = () => setMediaValue(null);
    opsRow.appendChild(bClear);
    meta.appendChild(opsRow);
    top.appendChild(meta);
    box.appendChild(top);

    const desc = el("textarea", "if-in if-desc");
    /* 描述框：1 行文字只占 1 行，最多 3 行（.if-desc 的 field-sizing: content） */
    desc.rows = 1;
    desc.placeholder = T("内容描述（可点「识图补充」自动填；每次 @引用 时 Agent 都会看到）");
    desc.value = media.desc || "";
    desc.oninput = () => {
      media.desc = desc.value;
      touch(node);
    };
    desc.onchange = () => writeFile(node, { silent: true });
    box.appendChild(desc);

    const tags = el("input", "if-in");
    tags.placeholder = T("标签，逗号分隔");
    tags.value = (media.tags || []).join(",");
    tags.onchange = () => {
      media.tags = String(tags.value || "")
        .split(/[,，]/)
        .map((x) => x.trim())
        .filter(Boolean);
      touch(node);
      writeFile(node, { silent: true });
    };
    box.appendChild(tags);

    if ((type === "image" || type === "video") && media.marks && media.marks.length) {
      const list = el("div", "if-marks");
      for (const m of media.marks) {
        const line = el("div", "if-mark-line");
        const where =
          m.start != null || m.end != null
            ? "[" + num(m.start, 0) + "s~" + (m.end != null ? num(m.end, 0) + "s" : "…") + "]"
            : Number.isFinite(m.x)
              ? "[" + Math.round(m.x * 100) + "%," + Math.round(m.y * 100) + "%]"
              : "";
        line.appendChild(el("span", "if-mark-where", where));
        line.appendChild(el("span", "if-mark-text", m.text || T("（无文字）")));
        list.appendChild(line);
      }
      box.appendChild(list);
    }
    return box;
  }

  /* 标注浮层（图像矩形框 / 视频时间点与起止段） */
  function maybeAnnotate(node, host) {
    const st = IF.ui.annotate;
    if (!st || !host) return;
    const f = (node.fields || []).find((x) => x.id === st.fieldId);
    if (!f) {
      IF.ui.annotate = null;
      return;
    }
    const row = st.rowId ? (node.values[f.id] || []).find((r) => r.id === st.rowId) : null;
    /* 列表行里的素材挂在某个媒体子字段上（f 本身是列表字段），先把它找出来 */
    const target =
      f.type === "list"
        ? (f.children || []).find((c) => MEDIA_TYPES[c.type] === 1 && row && row.values[c.id] && row.values[c.id].path) ||
          (f.children || []).find((c) => MEDIA_TYPES[c.type] === 1)
        : f;
    if (!target) {
      IF.ui.annotate = null;
      return;
    }
    const media = normMedia(row ? row.values[target.id] : node.values[target.id]);
    if (!media) {
      IF.ui.annotate = null;
      return;
    }
    const mask = el("div", "if-mask");
    const box = el("div", "if-anno");
    const head = el("div", "if-anno-head");
    head.appendChild(el("b", "", T("标注 · ") + (media.name || "")));
    const x = el("button", "mini", "✕");
    x.onclick = () => {
      IF.ui.annotate = null;
      paintPanel();
    };
    head.appendChild(x);
    box.appendChild(head);

    if (target.type === "image") {
      const stage = el("div", "if-anno-stage");
      const img = el("img");
      img.src = typeof thumbUrlWithBust === "function" ? thumbUrlWithBust(media.path, undefined, 1280) : media.path;
      img.draggable = false;
      stage.appendChild(img);
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("class", "if-anno-svg");
      svg.setAttribute("viewBox", "0 0 100 100");
      svg.setAttribute("preserveAspectRatio", "none");
      stage.appendChild(svg);
      /* 拖出来的框先「挂在」pending 上：文字在下方输入框里写，点「＋ 加注释」才落成一条注释。
         不用 window.prompt —— Electron 的渲染层不支持 prompt（会直接抛错），
         而且原生输入框也没法跟着主题走。 */
      let pending = null;
      const draw = () => {
        while (svg.firstChild) svg.removeChild(svg.firstChild);
        for (const m of media.marks || []) {
          if (!Number.isFinite(m.x)) continue;
          const r = document.createElementNS("http://www.w3.org/2000/svg", "rect");
          r.setAttribute("x", String(m.x * 100));
          r.setAttribute("y", String(m.y * 100));
          r.setAttribute("width", String(m.w * 100));
          r.setAttribute("height", String(m.h * 100));
          r.setAttribute("class", "if-anno-rect");
          svg.appendChild(r);
        }
        if (pending) {
          const r = document.createElementNS("http://www.w3.org/2000/svg", "rect");
          r.setAttribute("x", String(pending.x * 100));
          r.setAttribute("y", String(pending.y * 100));
          r.setAttribute("width", String(pending.w * 100));
          r.setAttribute("height", String(pending.h * 100));
          r.setAttribute("class", "if-anno-rect if-anno-pending");
          svg.appendChild(r);
        }
      };
      draw();
      let sx = 0;
      let sy = 0;
      let drawing = false;
      const rectOf = (ev) => {
        const b = img.getBoundingClientRect();
        return {
          x: Math.max(0, Math.min(1, (ev.clientX - b.left) / b.width)),
          y: Math.max(0, Math.min(1, (ev.clientY - b.top) / b.height)),
        };
      };
      stage.onmousedown = (ev) => {
        if (ev.button !== 0) return;
        const p = rectOf(ev);
        sx = p.x;
        sy = p.y;
        drawing = true;
      };
      stage.onmouseup = (ev) => {
        if (!drawing) return;
        drawing = false;
        const p = rectOf(ev);
        const x0 = Math.min(sx, p.x);
        const y0 = Math.min(sy, p.y);
        const w = Math.abs(p.x - sx);
        const h = Math.abs(p.y - sy);
        if (w < 0.01 || h < 0.01) return;
        pending = { x: x0, y: y0, w, h };
        draw();
        box.classList.add("if-anno-haspick");
        if (textIn) textIn.focus();
      };
      box.appendChild(stage);

      const bar = el("div", "if-anno-bar");
      const textIn = el("input", "if-in");
      textIn.placeholder = T("这块区域是什么？（注释文字）");
      bar.appendChild(textIn);
      const bAdd = el("button", "if-mini", T("＋ 加注释"));
      bAdd.onclick = () => {
        if (!pending) {
          if (typeof toast === "function") toast(T("先在图上拖一个框"), "warn");
          return;
        }
        const text = String(textIn.value || "").trim();
        if (!text) {
          textIn.focus();
          return;
        }
        media.marks.push({
          id: fid("mk"),
          text,
          x: pending.x,
          y: pending.y,
          w: pending.w,
          h: pending.h,
          start: null,
          end: null,
        });
        pending = null;
        textIn.value = "";
        box.classList.remove("if-anno-haspick");
        touch(node);
        writeFile(node, { silent: true });
        paintPanel();
      };
      bar.appendChild(bAdd);
      const bCancel = el("button", "if-mini", T("取消框选"));
      bCancel.onclick = () => {
        pending = null;
        draw();
        box.classList.remove("if-anno-haspick");
      };
      bar.appendChild(bCancel);
      box.appendChild(bar);
      box.appendChild(el("div", "if-anno-tip", T("在图片上按住拖出矩形 → 在下面写注释文字 → 点「＋ 加注释」。坐标按 0~1 归一化保存，缩放不会偏。")));
    } else {
      const v = el("video", "if-anno-video");
      v.controls = true;
      v.preload = "metadata";
      v.src = window.api && window.api.toFileUrl ? window.api.toFileUrl(media.path) : media.path;
      box.appendChild(v);
      const bar = el("div", "if-anno-bar");
      const textIn = el("input", "if-in");
      textIn.placeholder = T("这一段的注释（如：主角转身）");
      bar.appendChild(textIn);
      const startIn = el("input", "if-in if-in-sm");
      startIn.type = "number";
      startIn.step = "0.1";
      startIn.placeholder = T("起（秒）");
      bar.appendChild(startIn);
      const endIn = el("input", "if-in if-in-sm");
      endIn.type = "number";
      endIn.step = "0.1";
      endIn.placeholder = T("止（秒，可空）");
      bar.appendChild(endIn);
      const bNow = el("button", "if-mini", T("取当前时间"));
      bNow.onclick = () => {
        startIn.value = String(Math.round((v.currentTime || 0) * 10) / 10);
      };
      bar.appendChild(bNow);
      const bAdd = el("button", "if-mini", T("＋ 加注释"));
      bAdd.onclick = () => {
        const text = String(textIn.value || "").trim();
        if (!text) return;
        media.marks.push({
          id: fid("mk"),
          text,
          x: NaN,
          y: NaN,
          w: NaN,
          h: NaN,
          start: startIn.value === "" ? Math.round((v.currentTime || 0) * 10) / 10 : Number(startIn.value),
          end: endIn.value === "" ? null : Number(endIn.value),
        });
        touch(node);
        writeFile(node, { silent: true });
        paintPanel();
      };
      bar.appendChild(bAdd);
      box.appendChild(bar);
      box.appendChild(el("div", "if-anno-tip", T("按时间点 / 起止段记注释：先播放到位置再「取当前时间」。")));
    }

    const list = el("div", "if-anno-list");
    (media.marks || []).forEach((m, i) => {
      const line = el("div", "if-anno-line");
      const where =
        m.start != null || m.end != null
          ? "[" + num(m.start, 0) + "s~" + (m.end != null ? num(m.end, 0) + "s" : "…") + "]"
          : "[" + Math.round(m.x * 100) + "%," + Math.round(m.y * 100) + "%]";
      line.appendChild(el("span", "if-mark-where", where));
      line.appendChild(el("span", "if-mark-text", m.text || ""));
      const del = el("button", "if-mini if-danger", "✕");
      del.onclick = () => {
        media.marks.splice(i, 1);
        touch(node);
        writeFile(node, { silent: true });
        paintPanel();
      };
      line.appendChild(del);
      list.appendChild(line);
    });
    box.appendChild(list);
    mask.appendChild(box);
    host.appendChild(mask);
  }

  /* ---------------- 节点头部的小 icon 按钮 ----------------
   * 用户共识：折叠 / 展开 / 刷新 都挂在节点顶端（与其他节点的头部小按钮同一口径），
   * body 里不再作为按钮出现。接入点：renderer/app-canvas.js 的 nodeElement（head）。 */
  function allCollapsedNow(node) {
    const vis = visibleMap(node);
    const shown = (node.fields || []).filter((f) => vis[f.id]);
    if (!shown.length) return false;
    const col = collapsedSet(node);
    return shown.every((f) => col.has(f.id));
  }
  function headIconBtn(cls, svg, title, onclick) {
    const b = el("button", "n-play n-if-tool " + cls);
    b.type = "button";
    b.innerHTML = svg;
    b.title = title;
    if (typeof b.setAttribute === "function") b.setAttribute("aria-label", title);
    b.onclick = (ev) => {
      ev.stopPropagation();
      onclick(ev);
    };
    return b;
  }
  const IF_ICON_FOLD =
    '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 6.1l4-3.3 4 3.3M4 9.9l4 3.3 4-3.3" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const IF_ICON_EXPAND =
    '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 3.2H3.2V6M10 3.2h2.8V6M3.2 10v2.8H6M12.8 10v2.8H10" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const IF_ICON_SYNC =
    '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M12.7 8a4.7 4.7 0 1 1-1.6-3.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><path d="M13 2.5v2.7h-2.7" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  function headButtons(node) {
    if (!node || (node.kind && node.kind !== "input_form")) return [];
    const fold = headIconBtn("n-if-fold", IF_ICON_FOLD, "", () => {
      const on = !allCollapsedNow(node);
      setBoardAllCollapsed(node, on);
      const tip = on ? T("展开全部") : T("全部折叠");
      fold.title = tip;
      if (typeof fold.setAttribute === "function") fold.setAttribute("aria-label", tip);
    });
    const foldTip = allCollapsedNow(node) ? T("展开全部") : T("全部折叠");
    fold.title = foldTip;
    if (typeof fold.setAttribute === "function") fold.setAttribute("aria-label", foldTip);
    const open = headIconBtn("n-if-expand", IF_ICON_EXPAND, T("展开（占满画布）"), () => {
      openPanel(node.id);
    });
    const sync = headIconBtn("n-if-sync", IF_ICON_SYNC, T("刷新（按磁盘上的 .json 回读）"), async () => {
      const r = await readBack(node);
      const body = boardBodyOf(node);
      if (body && body.isConnected) paintBoard(node, body);
      try {
        if (typeof toast === "function")
          toast(
            r && r.took ? T("已按磁盘上的 .json 更新") : r && r.ok ? T("磁盘上没有更新的内容") : T("没有可回读的文件"),
            r && r.took ? "ok" : "warn",
          );
      } catch (_) {}
    });
    return [fold, open, sync];
  }

  /* ---------------- 对外 ---------------- */

  const API = {
    FIELD_TYPES,
    MEDIA_TYPES,
    blankField,
    normalize,
    templates: allTemplates,
    builtinTemplates,
    myTemplates,
    saveAsMyTemplate,
    applyTemplate,
    payload,
    summary,
    textOf,
    refText,
    visibleMap,
    missingRequired,
    applyDefaultsAndCalc,
    evalExpr,
    filePathOf,
    readBack,
    writeFile,
    describeMedia,
    autoDescribe,
    acceptPaths,
    appendToMaterialList,
    absorbWire,
    /* 上游暂时没值时线留在端子上：板身重绘时来看一眼它有没有值了（见 maybeAbsorbPending） */
    maybeAbsorbPending,
    /* 拖入路径解析（系统文件 / x-mtnode-files / 多行 text-plain）：回归直接测这一份口径 */
    pathsFromDrop,
    renderBody,
    /* 点卡打开 / 关闭条目浮层（节点旁就地编辑；回归直接测这一份） */
    openItem,
    closeItemPop,
    _item: ITEM,
    openPanel,
    closePanel,
    /* 节点头部的折叠 / 展开 / 刷新三颗小 icon（由 app-canvas.js 的 nodeElement 挂上去） */
    headButtons,
    repaint: paintPanel,
    _paintPanel: paintPanel,
  };
  window.IF = API;
})();
