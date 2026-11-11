"use strict";
/* ============ 内置 Agent 指示 · 渲染层取文本口（PS） ============
 *
 * 一切「注入给模型的固定提示词」都写成 PS(id, 默认文本, 变量表)：
 *   · 没有覆盖时原样返回默认文本 —— 与拆分前逐字节一致（这是硬要求，冒烟会逐字对账）；
 *   · 用户在设置 →「内置能力」里改过 → 返回用户那份；
 *   · 作者「覆盖到源码」后 → 返回 agent-prompts/<id>.md 那份。
 *
 * 覆盖文本里可用 {{name}} 占位符，变量表里给了就替换、没给就原样保留 ——
 * 于是含运行时变量（画布名 / 账号 / 工具清单…）的段落也能整段交给用户改，
 * 而默认路径仍然是代码里拼好的那一份（默认值里不含占位符）。
 *
 * 加载时机：本文件在 <head> 之后很早就发起拉取（异步），而 PS 只在真正发消息时被调用，
 * 那时早已就绪；万一还没回来（冷启动立刻发消息），PS 返回默认文本 —— 退化成今天的行为，
 * 不会因为存储慢而少一段提示。
 */

(function () {
  const state = {
    loaded: false,
    failed: "",
    map: Object.create(null), // id → 覆盖 / 源码默认文本
    items: [], // 清单（设置页用）
    groups: [],
    seen: Object.create(null), // 运行时真正被调用的 id → 次数
    defaults: Object.create(null), // id → 代码内联默认（首次调用时的 def，供设置页「载入当前默认」）
  };

  function api() {
    try {
      return (typeof window !== "undefined" && window.api) || null;
    } catch {
      return null;
    }
  }

  function applyPayload(p) {
    state.map = Object.create(null);
    state.items = [];
    state.groups = [];
    if (!p || !p.ok) {
      state.failed = (p && p.error) || "UNAVAILABLE";
      state.loaded = true;
      return;
    }
    const list = Array.isArray(p.items) ? p.items : [];
    for (const it of list) {
      if (!it || !it.id) continue;
      state.items.push(it);
      if (typeof it.text === "string" && it.text) state.map[it.id] = it.text;
    }
    state.groups = Array.isArray(p.groups) ? p.groups : [];
    state.failed = "";
    state.loaded = true;
  }

  async function load() {
    const a = api();
    if (!a || typeof a.agentPrompts !== "function") {
      state.failed = "NO_API";
      state.loaded = true;
      return state;
    }
    try {
      const p = await a.agentPrompts();
      applyPayload(p);
    } catch (e) {
      state.failed = String((e && e.message) || e);
      state.loaded = true;
    }
    return state;
  }

  /* 变量替换：{{k}} → vars[k]（未提供则保留占位符原样，方便作者看出漏了什么） */
  function fillVars(text, vars) {
    if (!vars || typeof vars !== "object") return text;
    return String(text).replace(/\{\{\s*([a-zA-Z0-9_$.-]+)\s*\}\}/g, (m, k) => {
      if (!Object.prototype.hasOwnProperty.call(vars, k)) return m;
      const v = vars[k];
      return v == null ? "" : String(v);
    });
  }

  /* 核心：取一段提示词。def 是代码内联默认（未覆盖时逐字返回）。 */
  function PS(id, def, vars) {
    const key = String(id || "");
    if (!key) return def == null ? "" : String(def);
    state.seen[key] = (state.seen[key] || 0) + 1;
    let text = def == null ? "" : String(def);
    if (!Object.prototype.hasOwnProperty.call(state.defaults, key)) state.defaults[key] = text;
    if (Object.prototype.hasOwnProperty.call(state.map, key)) text = String(state.map[key]);
    return fillVars(text, vars);
  }

  /* 已经以别的形式算好的段（比如三元表达式结果），只想套覆盖、不想再写一遍默认值时用 */
  function psText(id, text, vars) {
    return PS(id, text, vars);
  }

  function hasOverride(id) {
    return Object.prototype.hasOwnProperty.call(state.map, String(id || ""));
  }

  function catalog() {
    return {
      loaded: state.loaded,
      failed: state.failed,
      items: state.items.slice(),
      groups: state.groups.slice(),
      seen: Object.assign({}, state.seen),
      defaults: Object.assign({}, state.defaults),
    };
  }

  window.AgentPrompts = {
    load,
    state,
    PS,
    psText,
    hasOverride,
    catalog,
    fillVars,
  };
  /* 调用点短名：PS("session.persona.canvas", "…") */
  window.PS = PS;

  /* 启动即预取（不阻塞任何东西；失败就静默走默认） */
  try {
    load();
  } catch {}
})();
