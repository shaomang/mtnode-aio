"use strict";
/* ══════════════════════════════════════════════════════════════════════
 * 长周期任务 · 可搜索下拉控件（自包含工厂 · window.LT.ui.ctl）
 * ----------------------------------------------------------------------
 * 长任务的设置项（正文文本框除外）统一走这里，治两种老毛病：
 *   · 裸文本框要求用户手打「状态键 / 模型 / 服务商 / 预设」——拼错一个字就静默不生效；
 *   · 裸数字框可以填任意值，越界后要到运行时才报错。
 * 本控件的规矩只有一条：**输入框只用来搜索，值只能从清单里点出来**。
 * 打字 = 过滤候选；清单外的字永远提交不进去（回车只选中当前高亮项），
 * 「误填」在交互层直接被挡住。
 *
 * 出口（挂 window.LT.ui.ctl）：
 *   ltSelField(parent, label, value, options, on, opt)       单选（可搜索下拉）
 *   ltMultiSelField(parent, label, values, options, on, opt) 多选（状态键用）
 *   ltAgentOpts()                                            模型选型清单（与会话同源）
 *   normOptions(options, opt)（别名 toOptions）              选项归一，供调用方复用
 * options 支持混排（三种写法可同数组共存）：
 *   1) "k"                                → { value:"k", label:"k" }
 *   2) { value, label, hint, disabled }   → 单条
 *   3) { group:"DeepSeek", items:[…] }    → 分组（模型按服务商分组就用它）
 * opt 常用键：
 *   hint（字段下方提示行）· placeholder（空值占位）· allowEmpty（清单顶部加「跟随默认」项）
 *   · emptyLabel / emptyHint（「跟随默认」项的文案）· emptyText（清单为空时的兜底文案）
 *   · searchPlaceholder / emptyLabel（多选的空态文案，如「留空 = 全部状态」）
 *   · allowNew（状态键这类「允许新造值」的字段：打字后多出一条显式「新建」项，
 *     仍要点它才落地；模型 / 服务商 / 预设一律不开，打字永远只是搜索）。
 * 返回句柄 { root, el, input, value(), setValue(v[, silent]), setOptions(raw), setHint(text),
 * open, close }，
 * 供调用方在数据变化后就地刷新，不必重建 DOM。
 *
 * 本文件只做控件：不认识任何长任务业务字段（模型 / 状态键 / 重试次数的语义全在
 * app-longtask-ui.js）。样式复用 css/longtask.css 的 .lt-f/.lt-fl/.lt-fh/.lt-in，
 * 新增的只有 .lt-sel-* 这一类。
 *
 * 加载顺序：本文件排在 app-longtask-ui.js **之前**（见 renderer/index.html）。
 * 而 app-longtask-ui.js 解析时用 Object.assign(window.LT, { ui: {…} }) 整块重建 ui，
 * 会把先前挂上的 ui.ctl 顶掉；所以这里把 window.LT 的 ui 装成一个「合并式」访问器：
 * 之后任何 window.LT.ui = {…} 只会并入新键，ctl 不会被抹掉。
 * ══════════════════════════════════════════════════════════════════════ */
(function () {
  /* 取词条；vars 走 {name} 占位（I18n.t 第二参），让「＋ 新建「x」」这类
     带变量的文案能整句翻译，不再靠前后片段拼接。 */
  function ltcT(s, vars) {
    let out = String(s);
    try {
      if (typeof ltT === "function") out = ltT(s, vars);
      else if (typeof I18n !== "undefined" && I18n && I18n.t) out = I18n.t(String(s), vars);
    } catch (_) {}
    if (vars && typeof vars === "object")
      out = String(out).replace(/\{(\w+)\}/g, (_, k) => (vars[k] == null ? "" : String(vars[k])));
    return out;
  }
  function ltcEl(tag, cls, txt) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (txt != null) e.textContent = String(txt);
    return e;
  }
  function ltcS(v) {
    return v == null ? "" : String(v);
  }

  /* ── 选项归一：字符串 / {value,label,hint,disabled} / {group,items} 三写法混排 ── */
  function ltcOne(it) {
    if (it == null) return null;
    if (typeof it === "string" || typeof it === "number") {
      const v = String(it);
      return { value: v, label: v, hint: "", disabled: false };
    }
    if (typeof it !== "object") return null;
    const raw = it.value != null ? it.value : it.v;
    if (raw == null) return null;
    const value = String(raw);
    const label = it.label != null ? String(it.label) : it.name != null ? String(it.name) : value;
    return {
      value,
      label,
      hint: it.hint != null ? String(it.hint) : it.desc != null ? String(it.desc) : "",
      disabled: !!it.disabled,
    };
  }
  function ltcIsGroup(it) {
    return (
      !!it &&
      typeof it === "object" &&
      it.value == null &&
      it.v == null &&
      (Array.isArray(it.items) || Array.isArray(it.options))
    );
  }
  function normOptions(raw, opt) {
    const o = opt || {};
    const groups = [];
    let plain = [];
    const flush = () => {
      if (plain.length) {
        groups.push({ label: "", items: plain });
        plain = [];
      }
    };
    for (const it of Array.isArray(raw) ? raw : []) {
      if (ltcIsGroup(it)) {
        flush();
        const items = (Array.isArray(it.items) ? it.items : it.options).map(ltcOne).filter(Boolean);
        if (items.length) groups.push({ label: ltcS(it.group != null ? it.group : it.label), items });
      } else {
        const one = ltcOne(it);
        if (one) plain.push(one);
      }
    }
    flush();
    const head = o.allowEmpty
      ? [
          {
            value: "",
            label: o.emptyLabel != null ? String(o.emptyLabel) : ltcT("跟随默认"),
            hint: o.emptyHint != null ? String(o.emptyHint) : "",
            empty: true,
            disabled: false,
          },
        ]
      : [];
    const flat = head.concat(groups.reduce((a, g) => a.concat(g.items), []));
    return { head, groups, flat };
  }

  /* ── 单选：输入框既显示当前值又当过滤器；值只能点选项改 ───────────── */
  function ltSelField(parent, label, value, options, on, opt) {
    const o = opt || {};
    let norm = normOptions(options, o);
    let cur = ltcS(value);

    const row = ltcEl("div", "lt-f");
    if (label != null) row.appendChild(ltcEl("label", "lt-fl", label));
    const box = ltcEl("div", "lt-sel");
    const inp = ltcEl("input", "lt-in lt-sel-in");
    inp.type = "text";
    inp.autocomplete = "off";
    inp.spellcheck = false;
    inp.setAttribute("role", "combobox");
    inp.setAttribute("aria-autocomplete", "list");
    inp.setAttribute("aria-expanded", "false");
    const pop = ltcEl("div", "lt-sel-pop");
    pop.hidden = true;
    box.appendChild(inp);
    box.appendChild(pop);
    row.appendChild(box);
    const hintEl = o.hint != null ? ltcEl("div", "lt-fh", String(o.hint)) : null;
    if (hintEl) row.appendChild(hintEl);
    parent.appendChild(row);

    let items = [];
    let act = -1;

    const found = (v) => norm.flat.find((x) => x.value === v) || null;
    const labelOf = (v) => {
      const f = found(v);
      return f ? f.label : ltcS(v);
    };
    function syncInput() {
      if (cur) {
        inp.value = labelOf(cur);
        inp.placeholder = "";
      } else {
        inp.value = "";
        const e = norm.head[0];
        inp.placeholder = e ? e.label : String(o.placeholder != null ? o.placeholder : ltcT("请选择"));
      }
      box.classList.toggle("lt-sel-unknown", !!cur && !found(cur));
    }
    function matches(it, q) {
      if (!q) return true;
      return (it.label + " " + it.value + " " + it.hint).toLowerCase().indexOf(q) >= 0;
    }
    function optionEl(it) {
      const el = ltcEl("div", "lt-sel-o" + (it.value === cur ? " on" : "") + (it.disabled ? " dis" : ""));
      el.setAttribute("role", "option");
      el.appendChild(ltcEl("span", "lt-sel-ol", it.label));
      if (it.hint) el.appendChild(ltcEl("span", "lt-sel-oh", it.hint));
      if (it.value === cur) el.appendChild(ltcEl("span", "lt-sel-ck", "✓"));
      if (!it.disabled) {
        el.addEventListener("mousedown", (ev) => ev.preventDefault());
        el.addEventListener("click", () => pick(it.value));
        items.push(el);
      }
      return el;
    }
    function render(q) {
      pop.textContent = "";
      items = [];
      act = -1;
      const raw = ltcS(q).trim();
      const query = raw.toLowerCase();
      let shown = 0;
      const addInto = (host, it) => {
        if (!matches(it, query)) return;
        host.appendChild(optionEl(it));
        shown++;
      };
      if (norm.head.length) {
        const h = ltcEl("div", "lt-sel-grp");
        for (const it of norm.head) addInto(h, it);
        if (h.childElementCount) pop.appendChild(h);
      }
      for (const g of norm.groups) {
        const hold = ltcEl("div", "lt-sel-grp");
        for (const it of g.items) addInto(hold, it);
        if (!hold.childElementCount) continue;
        if (g.label) pop.appendChild(ltcEl("div", "lt-sel-g", g.label));
        pop.appendChild(hold);
      }
      /* allowNew：状态键这类「允许新造」的字段，打字后给一条显式的新建项。
         仍要点它才落地（打字本身不提交），模型 / 服务商 / 预设不开这扇门。 */
      if (o.allowNew && raw && !norm.flat.some((x) => x.value.toLowerCase() === query)) {
        const g = ltcEl("div", "lt-sel-grp");
        const el = ltcEl("div", "lt-sel-o lt-sel-new");
        el.setAttribute("role", "option");
        el.appendChild(ltcEl("span", "lt-sel-ol", ltcT("＋ 新建「{name}」", { name: raw })));
        el.addEventListener("mousedown", (ev) => ev.preventDefault());
        el.addEventListener("click", () => pick(raw));
        g.appendChild(el);
        items.push(el);
        pop.appendChild(g);
        shown++;
      }
      if (!shown) pop.appendChild(ltcEl("div", "lt-sel-empty", String(o.emptyText != null ? o.emptyText : ltcT("没有候选项"))));
    }
    function setAct(i) {
      if (!items.length) {
        act = -1;
        return;
      }
      act = (i + items.length) % items.length;
      items.forEach((el, k) => el.classList.toggle("act", k === act));
      try {
        items[act].scrollIntoView({ block: "nearest" });
      } catch (_) {}
    }
    function open() {
      if (!pop.hidden) return;
      pop.hidden = false;
      box.classList.add("open");
      inp.setAttribute("aria-expanded", "true");
      render("");
      const at = items.findIndex((el) => el.classList.contains("on"));
      setAct(at >= 0 ? at : items.length ? 0 : -1);
      try {
        inp.select();
      } catch (_) {}
    }
    function close() {
      if (pop.hidden) return;
      pop.hidden = true;
      box.classList.remove("open");
      inp.setAttribute("aria-expanded", "false");
      act = -1;
    }
    function pick(v) {
      const nv = ltcS(v);
      close();
      if (nv === cur) {
        syncInput();
        return;
      }
      cur = nv;
      syncInput();
      if (typeof on === "function") on(cur, handle);
    }
    function setOptions(raw, extra) {
      norm = normOptions(raw, extra ? Object.assign({}, o, extra) : o);
      if (!pop.hidden) {
        render(inp.value);
        const at = items.findIndex((el) => el.classList.contains("on"));
        setAct(at >= 0 ? at : items.length ? 0 : -1);
      }
      syncInput();
    }

    inp.addEventListener("focus", open);
    inp.addEventListener("input", () => {
      if (pop.hidden) open();
      render(inp.value);
      setAct(items.length ? 0 : -1);
    });
    inp.addEventListener("keydown", (ev) => {
      if (ev.key === "ArrowDown") {
        ev.preventDefault();
        if (pop.hidden) open();
        else setAct(act + 1);
      } else if (ev.key === "ArrowUp") {
        ev.preventDefault();
        if (pop.hidden) open();
        else setAct(act - 1);
      } else if (ev.key === "Enter") {
        ev.preventDefault();
        if (pop.hidden) {
          open();
          return;
        }
        const el = items[act >= 0 ? act : 0];
        if (el) el.click();
      } else if (ev.key === "Escape") {
        ev.preventDefault();
        close();
        syncInput();
      } else if (ev.key === "Tab") {
        close();
        syncInput();
      }
    });
    inp.addEventListener("blur", () => {
      setTimeout(() => {
        if (box.contains(document.activeElement)) return;
        close();
        syncInput();
      }, 120);
    });

    const handle = {
      root: row,
      el: box,
      input: inp,
      value: () => cur,
      setValue(v, silent) {
        cur = ltcS(v);
        syncInput();
        if (!silent && typeof on === "function") on(cur, handle);
      },
      setOptions,
      open,
      close,
      /* 就地换提示行：调用方的「留空时真正生效的是什么」会随选择变化（如「跟随默认」
         指向的模型 / 预设 / 思考档），改完当场刷一次，不让提示停在旧值上骗人。
         本控件只做「换一行字」，不认识任何业务字段（模型语义仍在调用方）。 */
      setHint(text) {
        if (hintEl) hintEl.textContent = String(text == null ? "" : text);
      },
    };
    syncInput();
    return handle;
  }

  /* ── 多选（状态键）：芯片 + 过滤框；值只能点选项 / 芯片 × 增删 ──────── */
  function ltMultiSelField(parent, label, values, options, on, opt) {
    const o = opt || {};
    const baseOpt = Object.assign({}, o, { allowEmpty: false });
    let norm = normOptions(options, baseOpt);
    let cur = (Array.isArray(values) ? values : []).map(ltcS).filter(Boolean);

    const row = ltcEl("div", "lt-f");
    if (label != null) row.appendChild(ltcEl("label", "lt-fl", label));
    const box = ltcEl("div", "lt-sel lt-sel-multi");
    const tags = ltcEl("div", "lt-sel-tags");
    const inp = ltcEl("input", "lt-in lt-sel-in");
    inp.type = "text";
    inp.autocomplete = "off";
    inp.spellcheck = false;
    inp.setAttribute("role", "combobox");
    inp.setAttribute("aria-autocomplete", "list");
    inp.setAttribute("aria-expanded", "false");
    inp.placeholder = String(o.searchPlaceholder != null ? o.searchPlaceholder : ltcT("输入以搜索…"));
    const pop = ltcEl("div", "lt-sel-pop");
    pop.hidden = true;
    box.appendChild(tags);
    box.appendChild(inp);
    box.appendChild(pop);
    row.appendChild(box);
    const hintEl = o.hint != null ? ltcEl("div", "lt-fh", String(o.hint)) : null;
    if (hintEl) row.appendChild(hintEl);
    parent.appendChild(row);

    let items = [];
    let act = -1;

    const found = (v) => norm.flat.find((x) => x.value === v) || null;
    const labelOf = (v) => {
      const f = found(v);
      return f ? f.label : ltcS(v);
    };
    function syncTags() {
      tags.textContent = "";
      if (!cur.length) {
        tags.appendChild(ltcEl("span", "lt-sel-none", String(o.emptyLabel != null ? o.emptyLabel : ltcT("留空 = 全部"))));
        return;
      }
      for (const v of cur) {
        const tag = ltcEl("span", "lt-sel-tag");
        tag.appendChild(ltcEl("span", "lt-sel-tagn", labelOf(v)));
        const x = ltcEl("span", "lt-sel-tagx", "×");
        x.title = ltcT("移除");
        x.addEventListener("mousedown", (ev) => ev.preventDefault());
        x.addEventListener("click", () => toggle(v));
        tag.appendChild(x);
        tags.appendChild(tag);
      }
    }
    function matches(it, q) {
      if (!q) return true;
      return (it.label + " " + it.value + " " + it.hint).toLowerCase().indexOf(q) >= 0;
    }
    function optionEl(it) {
      const on = cur.indexOf(it.value) >= 0;
      const el = ltcEl("div", "lt-sel-o" + (on ? " on" : "") + (it.disabled ? " dis" : ""));
      el.setAttribute("role", "option");
      el.setAttribute("aria-selected", on ? "true" : "false");
      el.appendChild(ltcEl("span", "lt-sel-ck", on ? "✓" : "＋"));
      el.appendChild(ltcEl("span", "lt-sel-ol", it.label));
      if (it.hint) el.appendChild(ltcEl("span", "lt-sel-oh", it.hint));
      if (!it.disabled) {
        el.addEventListener("mousedown", (ev) => ev.preventDefault());
        el.addEventListener("click", () => toggle(it.value));
        items.push(el);
      }
      return el;
    }
    function render(q) {
      pop.textContent = "";
      items = [];
      act = -1;
      const raw = ltcS(q).trim();
      const query = raw.toLowerCase();
      let shown = 0;
      const addInto = (host, it) => {
        if (!matches(it, query)) return;
        host.appendChild(optionEl(it));
        shown++;
      };
      for (const g of norm.groups) {
        const hold = ltcEl("div", "lt-sel-grp");
        for (const it of g.items) addInto(hold, it);
        if (!hold.childElementCount) continue;
        if (g.label) pop.appendChild(ltcEl("div", "lt-sel-g", g.label));
        pop.appendChild(hold);
      }
      /* allowNew：输出状态键 / 回写键允许新造 —— 打字后给一条显式新建项，点它才落地 */
      if (o.allowNew && raw && !norm.flat.some((x) => x.value.toLowerCase() === query) && cur.indexOf(raw) < 0) {
        const g = ltcEl("div", "lt-sel-grp");
        const el = ltcEl("div", "lt-sel-o lt-sel-new");
        el.setAttribute("role", "option");
        el.appendChild(ltcEl("span", "lt-sel-ck", "＋"));
        el.appendChild(ltcEl("span", "lt-sel-ol", ltcT("新建「{name}」", { name: raw })));
        el.addEventListener("mousedown", (ev) => ev.preventDefault());
        el.addEventListener("click", () => toggle(raw));
        g.appendChild(el);
        items.push(el);
        pop.appendChild(g);
        shown++;
      }
      if (!shown) pop.appendChild(ltcEl("div", "lt-sel-empty", String(o.emptyText != null ? o.emptyText : ltcT("没有候选项"))));
    }
    function setAct(i) {
      if (!items.length) {
        act = -1;
        return;
      }
      act = (i + items.length) % items.length;
      items.forEach((el, k) => el.classList.toggle("act", k === act));
      try {
        items[act].scrollIntoView({ block: "nearest" });
      } catch (_) {}
    }
    function open() {
      if (!pop.hidden) return;
      pop.hidden = false;
      box.classList.add("open");
      inp.setAttribute("aria-expanded", "true");
      render(inp.value);
      setAct(items.length ? 0 : -1);
    }
    function close() {
      if (pop.hidden) return;
      pop.hidden = true;
      box.classList.remove("open");
      inp.setAttribute("aria-expanded", "false");
      inp.value = "";
      act = -1;
    }
    function toggle(v) {
      const i = cur.indexOf(v);
      if (i >= 0) cur.splice(i, 1);
      else cur.push(v);
      syncTags();
      if (!pop.hidden) {
        render(inp.value);
        setAct(items.length ? 0 : -1);
      }
      if (typeof on === "function") on(cur.slice(), handle);
    }
    function setOptions(raw, extra) {
      norm = normOptions(raw, extra ? Object.assign({}, baseOpt, extra) : baseOpt);
      tags.textContent = "";
      syncTags();
      if (!pop.hidden) {
        render(inp.value);
        setAct(items.length ? 0 : -1);
      }
    }

    tags.addEventListener("mousedown", (ev) => {
      if (ev.target === tags) ev.preventDefault();
    });
    tags.addEventListener("click", (ev) => {
      if (ev.target === tags) {
        try {
          inp.focus();
        } catch (_) {}
      }
    });
    inp.addEventListener("focus", open);
    inp.addEventListener("input", () => {
      if (pop.hidden) open();
      else render(inp.value);
      setAct(items.length ? 0 : -1);
    });
    inp.addEventListener("keydown", (ev) => {
      if (ev.key === "ArrowDown") {
        ev.preventDefault();
        if (pop.hidden) open();
        else setAct(act + 1);
      } else if (ev.key === "ArrowUp") {
        ev.preventDefault();
        if (pop.hidden) open();
        else setAct(act - 1);
      } else if (ev.key === "Enter") {
        ev.preventDefault();
        if (pop.hidden) {
          open();
          return;
        }
        const el = items[act >= 0 ? act : 0];
        if (el) el.click();
      } else if (ev.key === "Escape") {
        ev.preventDefault();
        close();
      }
    });
    inp.addEventListener("blur", () => {
      setTimeout(() => {
        if (box.contains(document.activeElement)) return;
        close();
      }, 120);
    });

    const handle = {
      root: row,
      el: box,
      input: inp,
      value: () => cur.slice(),
      setValue(list, silent) {
        cur = (Array.isArray(list) ? list : []).map(ltcS).filter(Boolean);
        syncTags();
        if (!silent && typeof on === "function") on(cur.slice(), handle);
      },
      setOptions,
      open,
      close,
    };
    syncTags();
    return handle;
  }

  /* ══ 模型选型：与会话（右侧助手栏 / 智能节点面板）用同一批真源 ═══════════
   * 会话里怎么选，长任务里就怎么选，避免出现第二套清单：
   *   · 服务商 / 路由 + 模型：devAgentModelGroups()（内部即 agentModelsForRoute()，
   *     与助手栏「供应商 / 模型」下拉同源；服务商名走 devAgentRouteName()）；
   *   · 预设：AGENT_PRESETS（表序 = 菜单序，与会话 / 设置同一张表）；
   *   · 思考强度：AGENT_EFFORT_UI_ORDER（会话同一张档位表）。
   * 一处例外：长任务引擎的思考档白名单是 AGENT_EFFORT_ORDER（low…max，不含 off），
   * 露出「无」却写不进盘等于再制造一次「误填」，所以按词汇表过滤一遍。
   * 全部取用都带 typeof 守卫：真源函数没加载也返回可用（可能更短的）清单，不抛错。
   * ═══════════════════════════════════════════════════════════════════════ */
  function ltaRoutes() {
    const out = [];
    try {
      if (typeof devAgentModelGroups === "function") {
        for (const g of devAgentModelGroups() || []) {
          if (!g || g.id == null) continue;
          out.push({
            id: ltcS(g.id),
            name: ltcS(g.name) || ltcS(g.id),
            models: (Array.isArray(g.models) ? g.models : []).map(ltcS).filter(Boolean),
          });
        }
      }
    } catch (_) {}
    return out;
  }
  /* 留空时真正生效的默认选型（路由 · 模型 · 预设 · 思考强度）
     = 全局助手 / 会话的当前选择（真源 preferredAgentProviderRoute /
     preferredAgentModelForRoute + S.assistPreset / S.assistEffort） */
  function ltaDefaults(routes) {
    const list = routes || ltaRoutes();
    let route = "";
    try {
      if (typeof preferredAgentProviderRoute === "function")
        route = ltcS(preferredAgentProviderRoute());
    } catch (_) {}
    if (!route) {
      try {
        if (typeof defaultAgentProviderRoute === "function")
          route = ltcS(defaultAgentProviderRoute());
      } catch (_) {}
    }
    if (!route) route = "deepseek-official";
    let model = "";
    try {
      if (typeof preferredAgentModelForRoute === "function")
        model = ltcS(preferredAgentModelForRoute(route));
    } catch (_) {}
    if (!model) {
      const g = list.filter((x) => x.id === route)[0];
      model = (g && g.models[0]) || "";
    }
    /* 预设 / 思考强度：留空时真正生效的那两档，与会话栏设置同源（S.assistPreset /
       S.assistEffort，见 app-boot.js 的落盘与读取）。UI 的「跟随默认」提示照抄这一份，
       不再自己编一套默认 —— 显示的就是实际下发的那一档。 */
    let preset = "";
    try {
      if (typeof S !== "undefined" && S) preset = ltcS(S.assistPreset).trim();
    } catch (_) {}
    if (!preset && typeof AGENT_PRESET_DEFAULT !== "undefined") preset = ltcS(AGENT_PRESET_DEFAULT);
    let effort = "";
    try {
      if (typeof S !== "undefined" && S) effort = ltcS(S.assistEffort).trim();
    } catch (_) {}
    if (!effort) effort = "high";
    /* 引擎落盘白名单不含 off（ltNormCfg 会把它洗成空）：那种档位留空，
       别在提示里承诺一个写不进盘的值。 */
    const ok =
      typeof AGENT_EFFORT_ORDER !== "undefined" && Array.isArray(AGENT_EFFORT_ORDER)
        ? AGENT_EFFORT_ORDER
        : ["low", "medium", "high", "xhigh", "max"];
    if (ok.indexOf(effort) < 0) effort = "";
    return { route: route, model: model, preset: preset, effort: effort };
  }
  /* 「路由|模型」成对编码：模型只在某个路由下才有意义，拆开只存裸 id 会丢服务商，
     跨服务商有同名模型时再反查就分辨不出来。分隔符与 app.js 的 wfBuildAgentPicker
     同口径（模型格的 value = 路由 + "|" + 模型），两处可以互认。 */
  function ltaKeyOf(provider, model) {
    const p = ltcS(provider).trim();
    const m = ltcS(model).trim();
    return p && m ? p + "|" + m : "";
  }
  function ltaSplitKey(key) {
    const s = ltcS(key);
    const at = s.indexOf("|");
    if (at < 0) return { provider: "", model: s.trim() }; /* 裸模型 id：路由留空，由调用方决定兜底 */
    return { provider: s.slice(0, at).trim(), model: s.slice(at + 1).trim() };
  }
  /* 长任务检查器用得上的全套模型选型清单 + 反查工具 */
  function ltAgentOpts() {
    const routes = ltaRoutes();
    const defaults = ltaDefaults(routes);
    const keyOf = ltaKeyOf; /* 成对编码：拼 / 拆「路由|模型」 */
    const splitKey = ltaSplitKey;
    const routeName = (r) => {
      const s = ltcS(r);
      const g = routes.filter((x) => x.id === s)[0];
      if (g) return g.name;
      try {
        if (typeof devAgentRouteName === "function") return ltcS(devAgentRouteName(s)) || s;
      } catch (_) {}
      return s;
    };
    const modelsOf = (r) => {
      const g = routes.filter((x) => x.id === ltcS(r))[0];
      return g ? g.models.slice() : [];
    };
    /* 某个路由下「模型留空时真正生效」的那一只：先问真源 preferredAgentModelForRoute
       （它认得用户当前选的模型 S.assistModel），真源没加载才退回该路由清单首个。
       UI 的「跟随默认」提示按它显示 —— 不再拿清单首项冒充默认模型：用户当前选的
       不是首项时，那种写法会把显示与生效拆成两回事（正是「误选」观感的来源）。 */
    const modelForRoute = (r) => {
      const s = ltcS(r).trim();
      if (!s) return "";
      try {
        if (typeof preferredAgentModelForRoute === "function") {
          const m = ltcS(preferredAgentModelForRoute(s)).trim();
          if (m) return m;
        }
      } catch (_) {}
      return modelsOf(s)[0] || "";
    };
    /* 反查模型属于哪个路由（跨服务商选模型时用它把 provider 一并拨正）。
       能拿到成对编码时优先用它：裸模型 id 跨服务商重名时反查只会命中第一组，
       把真源当它就会「选 B 家落到 A 家」。 */
    const routeOfModel = (m) => {
      const s = ltcS(m).trim();
      if (!s) return "";
      if (s.indexOf("|") >= 0) return splitKey(s).provider; /* 已是「路由|模型」→ 路由部分即答案 */
      try {
        if (typeof devRouteOfModel === "function") {
          const r = ltcS(devRouteOfModel(s));
          if (r) return r;
        }
      } catch (_) {}
      const low = s.toLowerCase();
      const g = routes.filter((x) => x.models.some((mm) => mm.toLowerCase() === low))[0];
      return g ? g.id : "";
    };
    const presetSrc =
      typeof AGENT_PRESETS !== "undefined" && Array.isArray(AGENT_PRESETS) ? AGENT_PRESETS : [];
    const effortSrc =
      typeof AGENT_EFFORT_UI_ORDER !== "undefined" && Array.isArray(AGENT_EFFORT_UI_ORDER)
        ? AGENT_EFFORT_UI_ORDER
        : [];
    const effortOk =
      typeof AGENT_EFFORT_ORDER !== "undefined" && Array.isArray(AGENT_EFFORT_ORDER)
        ? AGENT_EFFORT_ORDER
        : ["low", "medium", "high", "xhigh", "max"];
    const effortLabels =
      typeof AGENT_EFFORT_LABELS !== "undefined" && AGENT_EFFORT_LABELS ? AGENT_EFFORT_LABELS : {};
    return {
      routes: routes,
      defaults: defaults,
      providerOptions: routes.map((g) => ({ value: g.id, label: g.name, hint: g.id })),
      /* 模型按服务商分组（可搜索）：跨组选中即等于连服务商一起改，不会留下
         「A 家的模型配 B 家路由」这种只在运行时才炸的组合。
         每项 value = 「路由|模型」成对编码（与 app.js 的 wfBuildAgentPicker 同口径）：
         两家服务商有同名模型时裸模型 id 无法分辨，回显 / ✓ 必须按完整 key 命中，
         否则只会标在第一组、选第二家被静默拨到第一家路由。hint 带服务商名，
         下拉里一眼看得出归属，也能按服务商名搜索。 */
      modelGroups: routes
        .filter((g) => g.models.length)
        .map((g) => ({
          group: g.name,
          items: g.models.map((m) => ({ value: ltaKeyOf(g.id, m), label: m, hint: g.name })),
        })),
      presetOptions: presetSrc.map((p) => ({
        value: ltcS(p.id),
        label: p.labelKey ? ltcT(p.labelKey) : ltcS(p.id),
        hint: p.hint ? ltcT(p.hint) : "",
      })),
      effortOptions: effortSrc
        .filter((v) => effortOk.indexOf(ltcS(v)) >= 0)
        .map((v) => ({ value: ltcS(v), label: ltcT(effortLabels[v] || v) })),
      routeName: routeName,
      modelsOf: modelsOf,
      modelForRoute: modelForRoute,
      routeOfModel: routeOfModel,
      /* 成对编码工具：调用方用它拼 / 拆模型格的 value（「路由|模型」），
         不再各自维护一套裸 id 反查 */
      keyOf: keyOf,
      splitKey: splitKey,
      /* 提示行：留空时真正生效的默认路由 + 模型，让「不填」不再等于盲填 */
      defaultText: () => routeName(defaults.route) + " · " + (defaults.model || ltcT("默认模型")),
    };
  }

  const API = {
    ltSelField,
    ltMultiSelField,
    normOptions,
    toOptions: normOptions,
    agentOpts: ltAgentOpts,
  };

  /* ── 挂载：把 ui 装成合并式访问器，避免被 app-longtask-ui.js 的整块重建顶掉 ── */
  function mountCtl() {
    const LT = (window.LT = window.LT || {});
    const bag = Object.assign({}, LT.ui && typeof LT.ui === "object" ? LT.ui : {}, { ctl: API });
    try {
      Object.defineProperty(LT, "ui", {
        configurable: true,
        enumerable: true,
        get() {
          return bag;
        },
        set(next) {
          if (next && typeof next === "object") Object.assign(bag, next);
        },
      });
    } catch (_) {
      LT.ui = bag;
    }
  }
  mountCtl();
})();
