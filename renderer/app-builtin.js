"use strict";
/* ============ 设置 →「内置能力」：Agent 指示 + 内置技能的统一管理页 ============
 *
 * 用户需求：mtnode 的设置里要有一处统一管理「整个应用的内置 skill 和 agent 指示」的地方；
 * 这些内容要能统一查看与修改；作者账号（ms2308）还要能**覆盖到源码**，
 * 覆盖之后这一条就变成默认（全应用、所有会话都按它走），而不是又一份「本机覆盖」。
 *
 * 数据从哪来：
 *   · Agent 指示清单 = agent-prompts/index.json（主进程 agent-prompts-lib 读）
 *     每一项的「出厂默认」由渲染层 PS(id, def) 在运行时登记（window.AgentPrompts.state.defaults），
 *     所以设置页能原样载入「当前代码里那一份」，作者写回源码时写的就是它。
 *   · 内置技能清单 = mtnodeAgentSkillIndex()（内置技能库的索引）。
 *
 * 三层优先级（lib 里实现）：覆盖层 > agent-prompts/<id>.md（技能是 SKILL.md 本身）> 代码内联默认。
 *   · 未改        ○ 出厂默认（代码内联 / 随包 SKILL.md）
 *   · 已覆盖到源码 ◐ 源码默认 —— 这一条就是默认了
 *   · 用户改过    ● 已覆盖（本机，只影响这台机器）
 * 保存后立刻 window.AgentPrompts.load() 刷新客户端缓存 —— 下一次会话 / 下一次读技能即生效，
 * 不需要重启应用；作者写回源码后同样立刻刷新，并重新拉一遍清单（该项状态变成「源码默认」）。
 */

(function () {
  const T = (s) => (typeof I18n !== "undefined" && I18n.t ? I18n.t(s) : String(s));
  const api = () => (typeof window !== "undefined" && window.api) || null;

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function btn(label, cls, onclick) {
    const b = el("button", "mini" + (cls ? " " + cls : ""), label);
    b.onclick = onclick;
    return b;
  }

  function toast2(msg, kind) {
    try {
      if (typeof toast === "function") toast(msg, kind || "ok");
    } catch {}
  }

  /* 简单行级差异：把 a（当前 / 默认）与 b 逐行比，返回两个高亮片段 */
  function paintDiff(host, aText, bText, aLabel, bLabel) {
    host.innerHTML = "";
    const a = String(aText || "").split("\n");
    const b = String(bText || "").split("\n");
    const n = Math.max(a.length, b.length);
    const wrap = el("div", null);
    wrap.style.cssText = "display:flex;gap:10px;align-items:flex-start";
    const mk = (label, lines, other) => {
      const col = el("div");
      col.style.cssText = "flex:1;min-width:0";
      const h = el("div", "settings-hint", label);
      col.appendChild(h);
      const pre = el("pre");
      pre.style.cssText =
        "max-height:280px;overflow:auto;white-space:pre-wrap;word-break:break-word;font-size:11px;line-height:1.5;margin:0;padding:8px;border:1px solid rgba(127,127,127,.28);border-radius:6px";
      for (let i = 0; i < n; i++) {
        const line = document.createElement("div");
        line.textContent = lines[i] == null ? "" : lines[i];
        if ((lines[i] || "") !== (other[i] || "")) {
          line.style.background = "rgba(255,170,0,.22)";
        }
        pre.appendChild(line);
      }
      col.appendChild(pre);
      return col;
    };
    wrap.appendChild(mk(aLabel, a, b));
    wrap.appendChild(mk(bLabel, b, a));
    host.appendChild(wrap);
  }

  /* ── 设置页里的小节 ─────────────────────────────────────────────── */
  function settingsSection() {
    const sec = el("div", "settings-sec");
    const title = el("div", "settings-sec-title settings-sec-title-row");
    title.appendChild(el("span", null, T("内置能力（Agent 指示 · 内置技能）")));
    sec.appendChild(title);

    const row = el("div", "dsh-plugin-manage-row");
    const hint = el("div", "dsh-plugin-empty");
    hint.textContent = T(
      "统一管理注入给模型的固定提示词与内置 SKILL.md：可改、可恢复默认、可与默认比差异；作者账号（ms2308）在能找到源码树时可「覆盖到源码」—— 覆盖后这一条就变成默认。",
    );
    const manage = btn(T("管理…"), "primary", open);
    row.appendChild(hint);
    row.appendChild(manage);
    sec.appendChild(row);
    return sec;
  }

  /* ── 主对话框 ───────────────────────────────────────────────────── */
  let UI = null;

  function state0() {
    return {
      tab: "prompts", // prompts | skills
      query: "",
      selected: "", // prompt id 或技能 name
      prompts: [], // 清单条目
      groups: [],
      author: null,
      defaultRoot: "", // 默认层（源码 / 随包）所在目录
      defaults: {}, // 代码内联默认（PS 的 def）
      skills: [], // {name,title,description,category}
      skillBodies: {}, // name → 生效正文（点开才拉）
      skillSource: {}, // name → 源码默认正文（点开才拉）
      skillOverride: {}, // name → true
      dirty: false,
      /* 左侧列表的滚动位置与搜索框光标：paint() 会整块重建，不记住就会「点一下跳回顶端」 */
      listScroll: 0,
      searchCaret: 0,
    };
  }

  async function loadAll() {
    const a = api();
    UI.loading = true;
    paint();
    let p = null;
    try {
      p = await a.agentPrompts();
    } catch (e) {
      p = { ok: false, error: String((e && e.message) || e) };
    }
    if (!p || !p.ok) {
      UI.error = (p && p.error) || "UNAVAILABLE";
      UI.prompts = [];
      UI.loading = false;
      paint();
      return;
    }
    UI.error = "";
    UI.prompts = Array.isArray(p.items) ? p.items : [];
    UI.groups = Array.isArray(p.groups) ? p.groups : [];
    UI.author = p.author || null;
    UI.texts = p.texts || {};
    UI.defaultRoot = p.defaultRoot || "";
    /* 运行期登记的代码内联默认（PS 的 def）：没有源码默认时它就是「出厂默认」 */
    UI.defaults =
      (typeof window !== "undefined" &&
        window.AgentPrompts &&
        window.AgentPrompts.state &&
        window.AgentPrompts.state.defaults) ||
      {};
    /* 清单里没有正文的（既没覆盖也没源码默认）用本窗口已登记的代码默认补上，
       否则设置页大部分条目会是空白框 —— 改不了、也没法「覆盖到源码」。 */
    UI.prompts = fillFromRuntimeDefaults(UI.prompts);
    try {
      const idx = await a.mtnodeAgentSkillIndex();
      const cats = (idx && idx.ok && idx.index && idx.index.categories) || [];
      const out = [];
      for (const c of cats) {
        for (const s of c.skills || [])
          out.push({
            name: s.name,
            title: s.title || s.name,
            description: s.description || "",
            category: c.title || c.id,
            menu: s.menu || "",
          });
      }
      UI.skills = out;
      const ov = await a.builtinSkillOverrides();
      UI.skillOverride = {};
      for (const nm of (ov && ov.names) || []) UI.skillOverride[nm] = true;
    } catch (e) {
      UI.skills = [];
    }
    UI.loading = false;
    paint();
  }

  function currentItem() {
    if (UI.tab === "prompts") return UI.prompts.find((x) => x.id === UI.selected) || null;
    return UI.skills.find((x) => x.name === UI.selected) || null;
  }

  /* 一项的当前状态：已覆盖到源码 / 已覆盖（本机）/ 出厂默认 */
  function srcBadge(it) {
    if (!it) return "";
    if (it.hasOverride)
      return (
        T("已覆盖（本机）") +
        (it.hasSource ? (it.text === it.sourceText ? " · " + T("与源码一致") : " · " + T("与源码不同")) : "")
      );
    if (it.hasSource) return T("源码默认");
    if (it.defaultText) return T("出厂默认（源码）");
    return T("出厂默认（运行时按档位拼装）");
  }

  function skillBadge(it) {
    if (!it) return "";
    if (UI.skillOverride[it.name]) return T("已覆盖（本机）");
    return T("源码默认（SKILL.md）");
  }

  /* 选中项当前应当显示的正文：覆盖 / 源码默认 / 代码内联默认 */
  function editTextOf(it) {
    if (!it) return "";
    if (it.text) return it.text;
    if (UI.tab === "prompts") return String(UI.defaults[it.id] || it.defaultText || "");
    return String(UI.skillBodies[it.name] || "");
  }

  /* 「默认」正文：源码默认优先（作者覆盖到源码后它就是默认），其次代码内联 / 随包 SKILL.md */
  function defaultTextOf(it, isPrompt) {
    if (isPrompt)
      return String(it.sourceText || UI.defaults[it.id] || it.defaultText || "");
    const src = UI.skillSource[it.name];
    return src != null ? String(src) : String(UI.skillBodies[it.name] || "");
  }

  function defaultLabelOf(it, isPrompt) {
    if (isPrompt) return it.sourceText ? T("默认（源码）") : T("默认（出厂）");
    return String(UI.skillSource[it.name] || "").trim() ? T("默认（源码 SKILL.md）") : T("默认（随包）");
  }

  /* 作者态不可用的原因（设置页要说得清「为什么没有那个按钮」） */
  function authorReasonText(who) {
    const r = String((who && who.reason) || "");
    if (r === "NOT_AUTHOR")
      return T("当前登录账号不是 ms2308") + (who && who.account ? "（" + who.account + "）" : "");
    if (r === "NO_SOURCE_ROOT")
      return T("上层目录里找不到含 main.js 与 mtnode-agent-skills/ 的源码树（打包版装到别处就是这个原因）");
    if (r === "SOURCE_READONLY") return T("找到了源码树但不可写");
    return T("未知原因");
  }

  /* 清单里没正文的条目：依次用「本窗口 PS 登记过的默认」→「主进程从源码里抽出的出厂默认」补上，
     都没有才留空（界面显示「取不到」的说明）。这样设置页不再是一大片空框。 */
  function fillFromRuntimeDefaults(items) {
    const defs = UI.defaults || {};
    return (items || []).map((it) => {
      if (it.text) return it;
      const runtime = String(defs[it.id] || "");
      const src = String(it.defaultText || "");
      if (!runtime && !src) return it;
      return Object.assign({}, it, { text: runtime || src });
    });
  }

  /* 写回失败的代码 → 人话（别把 EMPTY_TEXT 这种直接摆到用户脸上） */
  function writeErrText(code) {
    const m = {
      NOT_AUTHOR: T("当前登录账号不是 ms2308"),
      NO_SOURCE_ROOT: T("找不到可写的源码树"),
      SOURCE_READONLY: T("源码目录不可写"),
      EMPTY_TEXT: T("正文是空的，没有东西可写"),
      BAD_ID: T("id 不合法"),
      SKILL_NOT_IN_SOURCE: T("源码树里没有这本技能"),
      WRITE_FAILED: T("写文件失败"),
    };
    return m[code] || String(code || "?");
  }

  function paint() {
    const body = document.querySelector("#ovBody");
    if (!body || !UI) return;
    /* 整块重建会把这些位置清零：不清掉就会「点一下左侧项，页面跳回顶端」。
       先记住（页面滚动 / 左侧列表滚动 / 搜索框焦点与光标），重建后再放回去。 */
    const keepBodyTop = body.scrollTop || 0;
    const keepListTop = UI.listScroll || 0;
    const keepCaret = UI.searchCaret || 0;
    const keepSearchFocus =
      typeof document !== "undefined" &&
      document.activeElement &&
      document.activeElement.classList &&
      document.activeElement.classList.contains("dsh-plugin-search");
    body.innerHTML = "";

    /* 重建之后把「视图位置」放回去：左侧列表滚动、页面滚动、搜索框焦点与光标。
       任何出口（错误 / 读取中 / 正常）都要走一次 —— 否则点一下左侧项就跳回顶端。 */
    let search = null;
    const restoreView = () => {
      const listEl = body.querySelector(".builtin-list");
      if (listEl) {
        listEl.onscroll = () => {
          UI.listScroll = listEl.scrollTop;
        };
        if (keepListTop) listEl.scrollTop = keepListTop;
      }
      if (keepBodyTop) body.scrollTop = keepBodyTop;
      if (keepSearchFocus && search) {
        search.focus();
        try {
          search.setSelectionRange(keepCaret, keepCaret);
        } catch {}
      }
    };

    /* 顶部：页签 + 搜索 + 作者态 */
    const head = el("div", "dsh-btn-row");
    const tabP = btn(T("Agent 指示"), UI.tab === "prompts" ? "primary" : "", () => {
      UI.tab = "prompts";
      UI.selected = "";
      UI.dirty = false;
      UI.listScroll = 0;
      paint();
    });
    const tabS = btn(T("内置技能"), UI.tab === "skills" ? "primary" : "", () => {
      UI.tab = "skills";
      UI.selected = "";
      UI.dirty = false;
      UI.listScroll = 0;
      paint();
    });
    head.appendChild(tabP);
    head.appendChild(tabS);
    search = document.createElement("input");
    search.type = "text";
    search.className = "dsh-plugin-search";
    search.placeholder = T("筛选…");
    search.value = UI.query;
    search.oninput = () => {
      UI.query = search.value;
      UI.searchCaret = search.selectionStart || 0;
      const pos = UI.searchCaret;
      paint();
      const again = document.querySelector("#ovBody .dsh-plugin-search");
      if (again) {
        again.focus();
        try {
          again.setSelectionRange(pos, pos);
        } catch {}
      }
    };
    head.appendChild(search);
    body.appendChild(head);

    const who = UI.author || {};
    const authLine = el("div", "settings-hint");
    authLine.textContent = who.canWrite
      ? T("作者态：可覆盖到源码 → ") + String(who.sourceRoot || "") + T("（写回即成为默认，先自动备份）")
      : T("作者写回不可用（") +
        authorReasonText(who) +
        T("）；普通用户改动仍会保存到覆盖层（") +
        T("这台机器生效，升级不丢") +
        T("）。");
    body.appendChild(authLine);

    /* 一眼能看出「哪些条目已经有默认正文」：剩下的不是坏了，而是源码里按档位拼装 */
    if (UI.tab === "prompts" && UI.prompts.length) {
      const loaded = UI.prompts.filter((x) => String(x.text || "").trim()).length;
      body.appendChild(
        el(
          "div",
          "settings-hint",
          T("默认正文已载入 ") +
            loaded +
            " / " +
            UI.prompts.length +
            T(" 条（其余在源码里按运行档位拼装，真跑过一次对应功能后自动出现）"),
        ),
      );
    }

    if (UI.error) {
      const e = el("div", "dsh-plugin-empty", T("读取失败：") + UI.error);
      body.appendChild(e);
      restoreView();
      return;
    }
    if (UI.loading) {
      body.appendChild(el("div", "dsh-plugin-empty", T("（读取中…）")));
      restoreView();
      return;
    }

    /* 主体：左列表 + 右编辑 */
    const main = el("div");
    main.style.cssText = "display:flex;gap:12px;align-items:flex-start;margin-top:8px";
    const left = el("div", "builtin-list");
    left.style.cssText =
      "width:260px;flex:none;max-height:min(60vh,520px);overflow:auto;border:1px solid rgba(127,127,127,.22);border-radius:8px;padding:6px";
    const right = el("div");
    right.style.cssText = "flex:1;min-width:0";

    const q = String(UI.query || "").trim().toLowerCase();
    if (UI.tab === "prompts") {
      const groups = UI.groups.length
        ? UI.groups
        : [{ id: "session", title: T("会话") }];
      for (const g of groups) {
        const list = UI.prompts.filter((x) => x.group === g.id);
        if (!list.length) continue;
        const shown = list.filter(
          (x) =>
            !q ||
            String(x.title).toLowerCase().includes(q) ||
            String(x.id).toLowerCase().includes(q) ||
            String(x.desc).toLowerCase().includes(q),
        );
        if (!shown.length) continue;
        left.appendChild(el("div", "settings-hint", String(g.title || g.id)));
        for (const it of shown) {
          const row = el("div");
          row.style.cssText =
            "padding:5px 7px;border-radius:6px;cursor:pointer;" +
            (UI.selected === it.id ? "background:rgba(90,150,255,.22)" : "");
          const dot = it.hasOverride ? "● " : it.hasSource ? "◐ " : "○ ";
          row.textContent = dot + String(it.title || it.id);
          row.title = it.id + (it.hasSource ? T("　源码默认") : T("　出厂默认"));
          row.onclick = () => {
            UI.selected = it.id;
            UI.dirty = false;
            paint();
          };
          left.appendChild(row);
        }
      }
    } else {
      const shown = UI.skills.filter(
        (x) =>
          !q ||
          String(x.name).toLowerCase().includes(q) ||
          String(x.title).toLowerCase().includes(q),
      );
      for (const it of shown) {
        const row = el("div");
        row.style.cssText =
          "padding:5px 7px;border-radius:6px;cursor:pointer;" +
          (UI.selected === it.name ? "background:rgba(90,150,255,.22)" : "");
        row.textContent = (UI.skillOverride[it.name] ? "● " : "◐ ") + it.title;
        row.title = it.name + " · " + it.category;
        row.onclick = () => selectSkill(it.name);
        left.appendChild(row);
      }
    }
    main.appendChild(left);
    main.appendChild(right);
    body.appendChild(main);

    /* 右侧：编辑区 */
    const it = currentItem();
    if (!it) {
      right.appendChild(
        el("div", "dsh-plugin-empty", T("左侧选一项开始编辑（○ 出厂默认 / ◐ 源码默认 / ● 已覆盖）")),
      );
      restoreView();
      return;
    }
    paintEditor(right, it);
    /* 内容都铺完了再放回滚动位置（此时页高才定得下来） */
    restoreView();
  }

  async function selectSkill(name) {
    UI.selected = name;
    UI.dirty = false;
    paint();
    try {
      if (!UI.skillBodies[name]) {
        const g = await api().mtnodeAgentSkillGet(name);
        UI.skillBodies[name] = (g && g.ok && g.body) || "";
      }
      if (UI.skillSource[name] == null) {
        const s = await api().builtinSkillSource({ name });
        UI.skillSource[name] = (s && s.ok && s.body) || "";
      }
    } catch (e) {
      if (UI.skillBodies[name] == null) UI.skillBodies[name] = "";
      if (UI.skillSource[name] == null) UI.skillSource[name] = "";
    }
    paint();
  }

  /* 写回源码之后：客户端缓存、清单、技能正文全部重新拉一遍 —— 这一条现在就是默认 */
  async function afterWriteBack(skillNames) {
    const a = api();
    try {
      if (window.AgentPrompts && typeof window.AgentPrompts.load === "function")
        await window.AgentPrompts.load();
    } catch {}
    try {
      for (const nm of skillNames || []) {
        delete UI.skillSource[nm];
        delete UI.skillBodies[nm];
        const g = await a.mtnodeAgentSkillGet(nm);
        UI.skillBodies[nm] = (g && g.ok && g.body) || "";
        const s = await a.builtinSkillSource({ name: nm });
        UI.skillSource[nm] = (s && s.ok && s.body) || "";
      }
      if (skillNames && skillNames.length) await a.mtnodeAgentSkillIndex();
    } catch {}
    await loadAll();
  }

  function paintEditor(host, it) {
    const isPrompt = UI.tab === "prompts";
    const id = isPrompt ? it.id : it.name;

    host.appendChild(el("div", "settings-sec-title", String(it.title || id)));
    const meta = el("div", "settings-hint");
    meta.textContent = isPrompt
      ? id + "　" + srcBadge(it) + (it.where ? "　· " + it.where : "")
      : id + "　" + (it.category || "") + "　·　" + skillBadge(it);
    host.appendChild(meta);

    /* 默认层落在哪（这条看不见的话，「写了没生效」永远说不清） */
    const where = el("div", "settings-hint");
    if (isPrompt && it.sourcePath) where.textContent = T("源码默认：") + it.sourcePath;
    else if (isPrompt && it.hasSource === false)
      where.textContent = T("默认层：") + (UI.defaultRoot || "?") + T("（尚无源码默认，改动保存到覆盖层）");
    else if (!isPrompt && UI.skillSource[id])
      where.textContent = T("源码默认：SKILL.md（已在源码树内）");
    else if (!isPrompt)
      where.textContent = T("源码树里没有这本技能的 SKILL.md：默认取随包那份，改动只进覆盖层");
    if (where.textContent) host.appendChild(where);

    if (isPrompt && Array.isArray(it.vars) && it.vars.length) {
      host.appendChild(
        el(
          "div",
          "settings-hint",
          T("可用占位符：") + it.vars.map((v) => "{{" + v + "}}").join("  "),
        ),
      );
    }
    if (isPrompt && it.desc) host.appendChild(el("div", "settings-hint", String(it.desc)));

    const ta = document.createElement("textarea");
    ta.value = editTextOf(it);
    ta.spellcheck = false;
    ta.style.cssText =
      "width:100%;height:min(40vh,340px);font-size:12px;line-height:1.6;font-family:var(--mono,monospace);margin-top:6px";
    ta.oninput = () => {
      UI.dirty = true;
    };
    host.appendChild(ta);
    if (!String(ta.value || "").trim()) {
      host.appendChild(
        el(
          "div",
          "settings-hint",
          isPrompt
            ? T(
                "这一段取不到唯一的出厂默认：源码里同一个 id 会按运行档位拼出不同文本（或由多段运行时变量组成），只有真跑过一次才定稿。位置：",
              ) +
                (it.where || "agent-prompts/index.json") +
                T("。可以直接在这里写正文保存到本机覆盖层。")
            : T("源码树里没找到这本技能的正文（随包技能）：改动会保存到本机覆盖层。"),
        ),
      );
    }

    const bar = el("div", "dsh-btn-row");
    bar.style.marginTop = "8px";

    bar.appendChild(
      btn(T("保存（本机覆盖）"), "primary", async () => {
        const text = ta.value;
        const a = api();
        const r = isPrompt
          ? await a.agentPromptsSave({ id, text })
          : await a.builtinSkillSave({ name: id, text });
        if (!r || !r.ok) {
          toast2(T("保存失败：") + ((r && (r.error || r.detail)) || "?"), "warn");
          return;
        }
        if (isPrompt) {
          if (window.AgentPrompts) await window.AgentPrompts.load();
          const p = await a.agentPrompts();
          if (p && p.ok) {
            UI.prompts = fillFromRuntimeDefaults(p.items || []);
            UI.texts = p.texts || {};
          }
        } else {
          UI.skillBodies[id] = text;
          UI.skillOverride[id] = !!String(text || "").trim();
          /* 覆盖一变就要让同步链重跑（下次 index / skillList 会把覆盖写进 dsh-home/skills） */
          try {
            await a.mtnodeAgentSkillIndex();
          } catch {}
        }
        UI.dirty = false;
        toast2(T("已保存（下次会话 / 下次读技能生效）"), "ok");
        paint();
      }),
    );

    bar.appendChild(
      btn(T("恢复默认"), "", async () => {
        const a = api();
        const r = isPrompt
          ? await a.agentPromptsReset({ id })
          : await a.builtinSkillReset({ name: id });
        if (!r || !r.ok) {
          toast2(T("恢复失败：") + ((r && r.error) || "?"), "warn");
          return;
        }
        if (isPrompt) {
          if (window.AgentPrompts) await window.AgentPrompts.load();
          const p = await a.agentPrompts();
          if (p && p.ok) UI.prompts = fillFromRuntimeDefaults(p.items || []);
        } else {
          delete UI.skillOverride[id];
          try {
            const g = await a.mtnodeAgentSkillGet(id);
            UI.skillBodies[id] = (g && g.ok && g.body) || "";
            const s = await a.builtinSkillSource({ name: id });
            UI.skillSource[id] = (s && s.ok && s.body) || "";
            await a.mtnodeAgentSkillIndex();
          } catch {}
        }
        UI.dirty = false;
        toast2(T("已恢复默认"), "ok");
        paint();
      }),
    );

    bar.appendChild(
      btn(T("与默认比差异"), "", async () => {
        const box = host.querySelector(".builtin-diff");
        if (!box) return;
        const def = defaultTextOf(it, isPrompt);
        if (!String(def || "").trim()) {
          /* 默认正文取不到（本窗口还没注入过 / 源码树里没这本技能）：别画成「整篇都被改了」 */
          toast2(T("这一条还没有可比的默认正文"), "warn");
          return;
        }
        paintDiff(box, ta.value, def, T("当前（生效）"), defaultLabelOf(it, isPrompt));
      }),
    );

    const author = UI.author || {};
    if (author.canWrite) {
      const srcBtn = btn(T("覆盖到源码（成为默认）"), "", async () => {
        const a = api();
        const text = ta.value;
        const r = isPrompt
          ? await a.agentPromptsWriteSource({ id, text })
          : await a.builtinSkillWriteSource({ name: id, text });
        if (!r || !r.ok) {
          toast2(T("写回失败：") + writeErrText(r && (r.error || r.detail)), "warn");
          return;
        }
        toast2(
          T("已覆盖到源码，这一条现在是默认") +
            (r.backup ? T("（原文件已备份）") : "") +
            (r.path ? "\n" + String(r.path) : ""),
          "ok",
        );
        await afterWriteBack(isPrompt ? [] : [id]);
      });
      srcBtn.title = T("写进源码树（agent-prompts/<id>.md 或 SKILL.md），写前自动备份，写后成为默认");
      bar.appendChild(srcBtn);
    }
    host.appendChild(bar);

    if (author.canWrite) {
      const allBar = el("div", "dsh-btn-row");
      allBar.style.marginTop = "4px";
      allBar.appendChild(
        btn(T("全部覆盖到源码（已覆盖的项）"), "", async () => {
          const a = api();
          const texts = {};
          for (const p of UI.prompts) {
            if (p.hasOverride && String(p.text || "").trim()) texts[p.id] = p.text;
          }
          const skillNames = Object.keys(UI.skillOverride || {});
          if (!Object.keys(texts).length && !skillNames.length) {
            toast2(T("没有已覆盖的条目可写回"), "warn");
            return;
          }
          let written = 0;
          let failed = 0;
          if (Object.keys(texts).length) {
            const r = await a.agentPromptsWriteSource({ all: true, texts });
            if (!r || !r.ok) {
              toast2(T("写回失败：") + writeErrText(r && r.error), "warn");
              return;
            }
            written += (r.written || []).length;
            failed += (r.failed || []).length;
          }
          for (const nm of skillNames) {
            let body = UI.skillBodies[nm];
            if (body == null) {
              try {
                const g = await a.mtnodeAgentSkillGet(nm);
                body = (g && g.ok && g.body) || "";
              } catch {
                body = "";
              }
            }
            if (!String(body || "").trim()) continue;
            const r = await a.builtinSkillWriteSource({ name: nm, text: body });
            if (r && r.ok) written++;
            else failed++;
          }
          toast2(
            T("已覆盖到源码 ") + written + T(" 项") + (failed ? T("，失败 ") + failed + T(" 项") : ""),
            "ok",
          );
          await afterWriteBack(skillNames);
        }),
      );
      host.appendChild(allBar);
    }

    const diff = el("div", "builtin-diff");
    diff.style.marginTop = "8px";
    host.appendChild(diff);
  }

  /* ── 打开对话框 ─────────────────────────────────────────────────── */
  async function open() {
    if (typeof openOverlay !== "function") return;
    /* persistent：带编辑框的浮层一律不点外关（AGENTS.md 的浮层约定）；
       宽身只用 openOverlay 认得的 wide 类 + 内联宽度，两者都由 closeOverlay 收掉，
       不会残留到下一个弹窗（.overlay-box 是全应用共用的一只壳）。 */
    openOverlay(T("内置能力 · Agent 指示 / 内置技能"), { persistent: true });
    const box = document.querySelector("#overlay .overlay-box");
    if (box) {
      box.classList.add("wide");
      box.style.width = "min(1080px, 94vw)";
    }
    const foot = document.querySelector("#ovFoot");
    if (foot) {
      foot.innerHTML = "";
      const close = btn(T("关闭"), "primary", () => {
        UI = null;
        if (typeof closeOverlay === "function") closeOverlay();
      });
      foot.appendChild(close);
    }
    UI = state0();
    UI.loading = true;
    UI.error = "";
    paint();
    await loadAll();
  }

  window.BuiltinCap = { settingsSection, open };
})();
