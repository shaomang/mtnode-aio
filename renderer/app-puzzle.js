/* ==========================================================================
   app-puzzle.js — MTNode 益智小游戏框架（顶栏 #btnPuzzle 入口）

   职责：
     · 顶栏第一行 .tb-end 加入/接管 #btnPuzzle，点击打开全屏益智宿主。
     · 宿主 = persistent 全屏浮层（复用 .mt-dialog 蒙层，独占 z 层）：
       关闭只走显式路径（标题栏 ✕ / Esc / 返回列表），绝不「点外部即关」。
     · 互斥：打开时先收掉其它 #overlay 浮层与内置使用手册窗，避免两层叠屏。
     · 主视图 = 游戏列表 grid（按 A/B/C 分组，每款一张 SVG 图标 + 标题 +
       类型/组/难度标签 + 一行规则）。
     · 单局视图 = 统一 HUD（难度 1-5 / 得分 / 计时）+ 玩法 stage，供各游戏挂接。
     · 钉定统一 B_d 标准表（各游戏共用），并给出 Par / 期望公式口径。

   挂全局 window.Puzzle = { open, close, isOpen, registry, register,
     bd, loc, el, esc }。真正的 17 款游戏在 app-puzzle-games.js 注册。
   加载顺序（renderer/index.html 尾部）：app-puzzle.js → app-puzzle-games.js。
   ========================================================================== */
(function () {
  "use strict";

  function t(key, vars) {
    try {
      return window.I18n ? window.I18n.t(key, vars) : String(key);
    } catch (_) {
      return String(key);
    }
  }

  function isEn() {
    try {
      return window.I18n && window.I18n.getLocale
        ? window.I18n.getLocale() === "en"
        : false;
    } catch (_) {
      return false;
    }
  }

  /* 语言展示值：名字/规则多为「中 / 英」对象（每次实时取当前 locale） */
  function pick(v, fallback) {
    if (v == null) return fallback || "";
    if (typeof v === "string") return v;
    return v[isEn() ? "en" : "zh"] || v.zh || v.en || fallback || "";
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(
      /[&<>"']/g,
      function (c) {
        return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
      },
    );
  }

  /* ── 统一 B_d 标准表（各游戏共用 · 按 Par 样例反推钉定）────────────
     MG-01 D3 约 160×10×1.15、MG-06 D3(N=16) 约 160×10×0.9 —— 两者都落在
     D3 的每题基础分 ≈160，故把 D1..D5 定为等差 +20：
        D1=120 · D2=140 · D3=160 · D4=180 · D5=200
     公式口径（各游戏在其实现中套用）：
       总分 P = Σ_题 ( bd(level) × 题重 w ) × 速度因子 V
       速度因子 V = 用时在 par 之内的剩余比（整轮/单题两类，由游戏自定口径）
       期望 S ≈ 对题型标准化的答对得分（用于验收对照，如 MG-01 D3 10 题 ≈ 2120）
       每题基础 bd 见下表；题重 w 与 V 由每款游戏的规格决定。
  */
  var BD_TABLE = [120, 140, 160, 180, 200];
  function bd(level) {
    var l = Math.max(1, Math.min(5, Math.floor(+level || 3)));
    return BD_TABLE[l - 1];
  }

  /* ── 内部状态 ─────────────────────────────────────────────── */
  var registry = []; // {id, code, group, groupZh, type[], name, rule, accent, icon(), play}
  var host = null;
  var current = null; // { def, level, api, cleanup }
  var activeTimer = null; // { id } 当前一局的 HUD 计时器句柄

  /* ── 小工具：生成宿主 DOM ─────────────────────────────────── */
  var PUZZLE_SVG =
    '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 12.5V4.6h3.1V2.4h2.8v2.2h3.1v3.1h-1.6a1.4 1.4 0 0 0 0 2.8h1.6v1.2H9.4v1.8H6.6V12.5H3.5z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>';

  function ensureHost() {
    if (host) return host;
    host = document.createElement("div");
    host.id = "puzzleDlg";
    host.className = "mt-dialog pz-dlg";
    host.innerHTML =
      '<div class="pz-box" role="dialog" aria-modal="true">' +
      '<div class="pz-head">' +
      '<div class="pz-head-title"><span class="pz-ico">' +
      PUZZLE_SVG +
      "</span><span data-role='title'></span>" +
      '<span class="pz-head-sub" data-role="subtitle"></span></div>' +
      '<div class="pz-head-actions">' +
      '<button type="button" class="mini primary" data-role="toList" data-i18n="返回列表" data-i18n-title="返回列表"></button>' +
      '<button type="button" class="mini pz-x" data-role="close">✕</button>' +
      "</div></div>" +
      '<div class="pz-body" data-role="body"></div>' +
      "</div>";
    document.body.appendChild(host);

    host.querySelector('[data-role="close"]').title = t("关闭");
    host.querySelector('[data-role="close"]').onclick = function () {
      Puzzle.close();
    };
    host.querySelector('[data-role="toList"]').onclick = function () {
      renderGrid();
    };
    // persistent：点蒙层 / 点空白一律不关，只走 ✕ / Esc / 返回列表 / 顶部开关
    // （无任何 backdrop 关闭监听，符合 AGENTS.md「协作约定」与持久化冒烟）

    // Esc：窗口级捕获，宿主打开时拦截并独占（避免落到 app.js 的画布快捷键）
    window.addEventListener(
      "keydown",
      function (ev) {
        if (host.classList.contains("on") && ev.key === "Escape") {
          ev.preventDefault();
          ev.stopImmediatePropagation();
          Puzzle.close();
        }
      },
      true,
    );
    return host;
  }

  /* ── 顶部入口按钮 + Ctrl+Alt+G 快捷键 ─────────────────────────
     按钮已临时隐藏（css/puzzle.css #btnPuzzle {display:none}），仍保留逻辑，
     用户用快捷键 Ctrl+Alt+G 呼出 / 收起益智窗口。 */
  function bindButton() {
    var btn = document.getElementById("btnPuzzle");
    if (btn) {
      btn.onclick = function (ev) {
        ev.preventDefault();
        Puzzle.open();
      };
    }
    // Ctrl+Alt+G：应用内热键切换益智窗（按钮隐藏时的唯一入口）
    window.addEventListener("keydown", function (ev) {
      if (ev.ctrlKey && ev.altKey && !ev.shiftKey && !ev.metaKey) {
        var key = String(ev.key).toLowerCase();
        if (key === "g") {
          ev.preventDefault();
          ev.stopPropagation();
          if (Puzzle.isOpen()) Puzzle.close();
          else Puzzle.open();
        }
      }
    });
  }

  /* ── 互斥：打开时收掉其它全屏浮层 ─────────────────────────── */
  function closeRivals() {
    var ov = document.getElementById("overlay");
    if (ov && ov.style && ov.style.display !== "none") {
      try {
        if (typeof closeOverlay === "function") closeOverlay();
      } catch (_) {}
    }
    var docs = document.getElementById("appDocsDlg");
    if (docs && docs.classList && docs.classList.contains("on")) {
      try {
        if (typeof closeAppDocs === "function") closeAppDocs();
        else docs.classList.remove("on");
      } catch (_) {
        docs.classList.remove("on");
      }
      var db = document.getElementById("btnDocs");
      if (db) db.classList.remove("on");
    }
  }

  /* ── grid 主视图 ─────────────────────────────────────────── */
  function groupLabelOf(g) {
    return {
      A: t("A · 计算 / 逻辑"),
      B: t("B · 记忆 / 注意"),
      C: t("C · 知觉 / 空间"),
    }[g] || g || "—";
  }

  function cardHtml(def) {
    var typeChips = (def.type || [])
      .map(function (x) {
        return '<span class="pz-chip type">' + esc(x) + "</span>";
      })
      .join("");
    var accent = def.accent || "#e6b45a";
    return (
      '<div class="pz-card" data-id="' +
      esc(def.id) +
      '" style="--pz-c:' +
      accent +
      '">' +
      '<div class="pz-card-top"><span class="pz-card-ico">' +
      (def.icon ? def.icon() : "") +
      "</span><span class='pz-card-info'><span class='pz-card-code'>" +
      esc(def.code || def.id) +
      "</span><span class='pz-card-name'>" +
      esc(pick(def.name)) +
      "</span></span></div>" +
      '<div class="pz-card-meta">' +
      typeChips +
      '<span class="pz-chip group">' +
      esc(groupLabelOf(def.group)) +
      "</span><span class='pz-chip diff'>" +
      esc("1–5") +
      "</span></div>" +
      '<div class="pz-card-rule">' +
      esc(pick(def.rule)) +
      "</div>" +
      '<div class="pz-card-play">▶ ' +
      esc(t("开始")) +
      "</div></div>"
    );
  }

  /* 结束当前一局：停掉 HUD 计时器并跑一遍游戏的 cleanup（可安全多次调用） */
  function killSession() {
    if (activeTimer) {
      clearInterval(activeTimer.id);
      activeTimer = null;
    }
    if (current) {
      try {
        if (current.cleanup) current.cleanup();
      } catch (_) {}
      current = null;
    }
  }

  function renderGrid() {
    ensureHost();
    killSession();
    var body = host.querySelector('[data-role="body"]');
    host.querySelector('[data-role="toList"]').style.display = "none";
    host.querySelector('[data-role="title"]').textContent = t("益智小游戏");
    host.querySelector('[data-role="subtitle"]').textContent = t(
      "选择一款小游戏打发时间",
    );
    if (typeof I18n !== "undefined" && I18n && I18n.applyDom) {
      try {
        I18n.applyDom(host);
      } catch (_) {}
    }

    var groups = ["A", "B", "C"].filter(function (g) {
      return registry.some(function (d) {
        return d.group === g;
      });
    });
    var html = '<div class="pz-grid-wrap">';
    if (!registry.length) {
      html += '<div class="pz-empty">' + esc(t("没有可玩的小游戏")) + "</div>";
    }
    groups.forEach(function (g) {
      var defs = registry
        .filter(function (d) {
          return d.group === g;
        })
        .sort(function (a, b) {
          return (a.order || 0) - (b.order || 0);
        });
      if (!defs.length) return;
      var labelMap = {
        A: t("A · 计算 / 逻辑"),
        B: t("B · 记忆 / 注意"),
        C: t("C · 知觉 / 空间"),
      };
      var hintMap = {
        A: "CALC · LOG",
        B: "MEM · ATT · RSP",
        C: "PER · SPA · PLAN",
      };
      html +=
        '<div class="pz-group-title">' +
        esc(labelMap[g] || g) +
        " <small>" +
        esc(hintMap[g] || "") +
        "</small></div>";
      html += '<div class="pz-grid">';
      defs.forEach(function (d) {
        html += cardHtml(d);
      });
      html += "</div>";
    });
    html += "</div>";
    body.innerHTML = html;

    Array.prototype.forEach.call(
      body.querySelectorAll(".pz-card"),
      function (card) {
        var id = card.getAttribute("data-id");
        card.onclick = function () {
          var def = registry.find(function (d) {
            return d.id === id;
          });
          if (def) openGame(def);
        };
      },
    );
    if (!host.classList.contains("on")) host.classList.add("on");
    var b = document.getElementById("btnPuzzle");
    if (b) b.classList.add("on");
  }

  /* ── 单局视图 ───────────────────────────────────────────── */
  function openGame(def) {
    ensureHost();
    renderGridHostKeep(def); // 复用宿主，仅切 body 为游戏视图
  }

  function renderGridHostKeep(def) {
    ensureHost();
    killSession(); // 结束上一局（若有）并清理计时器，避免切换残留
    var body = host.querySelector('[data-role="body"]');
    host.querySelector('[data-role="title"]').textContent =
      (def.code ? def.code + " · " : "") + pick(def.name);
    host.querySelector('[data-role="subtitle"]').textContent = pick(def.rule);
    host.querySelector('[data-role="toList"]').style.display = "";
    if (typeof I18n !== "undefined" && I18n && I18n.applyDom) {
      try {
        I18n.applyDom(host);
      } catch (_) {}
    }

    var level = 3;
    var startTs = 0;
    var cleanup = null;
    var state = {
      score: 0,
      done: 0,
      combo: 0,
      target: "",
      timeMs: 0,
    };

    var wrap = document.createElement("div");
    wrap.className = "pz-play-wrap";
    wrap.innerHTML =
      '<div class="pz-hud">' +
      '<div class="pz-hud-item"><span class="pz-hud-label">' +
      esc(t("难度")) +
      '</span><span class="pz-diff-picker" data-role="diff"></span></div>' +
      '<div class="pz-hud-item"><span class="pz-hud-label">' +
      esc(t("得分")) +
      '</span><span class="pz-hud-value" data-role="score">0</span></div>' +
      '<div class="pz-hud-item"><span class="pz-hud-label">' +
      esc(t("目标")) +
      '</span><span class="pz-hud-value dim" data-role="goal">—</span></div>' +
      '<div class="pz-hud-item"><span class="pz-hud-label">' +
      esc(t("已答")) +
      '</span><span class="pz-hud-value dim" data-role="done">0</span></div>' +
      '<div class="pz-hud-item"><span class="pz-hud-label">' +
      esc(t("连击")) +
      '</span><span class="pz-hud-value dim" data-role="combo">0</span></div>' +
      '<div class="pz-hud-item"><span class="pz-hud-label">' +
      esc(t("计时")) +
      '</span><span class="pz-hud-value dim" data-role="time">0.0s</span></div>' +
      '<div class="pz-hud-spacer"></div>' +
      '<button type="button" class="mini" data-role="end">' +
      esc(t("结束")) +
      "</button></div>" +
      '<div class="pz-stage" data-role="stage"></div>';
    body.innerHTML = "";
    body.appendChild(wrap);

    var els = {
      score: wrap.querySelector('[data-role="score"]'),
      goal: wrap.querySelector('[data-role="goal"]'),
      done: wrap.querySelector('[data-role="done"]'),
      combo: wrap.querySelector('[data-role="combo"]'),
      time: wrap.querySelector('[data-role="time"]'),
    };
    var stage = wrap.querySelector('[data-role="stage"]');

    function renderDiff() {
      var holder = wrap.querySelector('[data-role="diff"]');
      var h = '<span class="pz-diff-lbl"></span>';
      for (var i = 1; i <= 5; i++) {
        h +=
          '<button type="button" class="mini pz-diff-btn' +
          (i === level ? " on" : "") +
          '" data-l="' +
          i +
          '">' +
          i +
          "</button>";
      }
      holder.innerHTML = h;
      Array.prototype.forEach.call(
        holder.querySelectorAll(".pz-diff-btn"),
        function (b) {
          b.onclick = function (ev) {
            ev.stopPropagation();
            setLevel(parseInt(b.getAttribute("data-l"), 10));
          };
        },
      );
    }

    function setLevel(l) {
      if (l === level) return;
      level = l;
      renderDiff();
      if (def.onLevelChange) {
        try {
          def.onLevelChange(api);
        } catch (_) {}
      }
    }

    function paintHud() {
      if (els.score) els.score.textContent = String(state.score);
      if (els.goal) els.goal.textContent = state.target || "—";
      if (els.done) els.done.textContent = String(state.done);
      if (els.combo) els.combo.textContent = String(state.combo);
      if (els.time)
        els.time.textContent =
          state.timeMs >= 0 ? (state.timeMs / 1000).toFixed(1) + "s" : "—";
    }

    var api = {
      level: function () {
        return level;
      },
      state: state,
      stage: stage,
      bd: bd,
      setLevel: setLevel,
      hud: function (patch) {
        for (var k in patch) {
          if (Object.prototype.hasOwnProperty.call(patch, k)) state[k] = patch[k];
        }
        paintHud();
      },
      addScore: function (n) {
        state.score += n;
        paintHud();
      },
      setTime: function (ms) {
        state.timeMs = ms;
        paintHud();
      },
      cleanup: function (fn) {
        cleanup = fn || null;
      },
      /* 离开当前局回到列表 */
      toList: function () {
        renderGrid();
      },
    };

    function tick() {
      if (!current || current.def !== def) return;
      state.timeMs = Date.now() - startTs;
      paintHud();
    }

    function startTimer() {
      if (activeTimer) {
        clearInterval(activeTimer.id);
        activeTimer = null;
      }
      startTs = Date.now();
      activeTimer = { id: setInterval(tick, 100), start: startTs };
    }

    function stopTimer() {
      if (activeTimer) {
        clearInterval(activeTimer.id);
        activeTimer = null;
      }
      if (startTs) {
        state.timeMs = Date.now() - startTs;
        paintHud();
      }
    }

    current = {
      def: def,
      level: level,
      api: api,
      startTimer: startTimer,
      stopTimer: stopTimer,
      cleanup: null,
    };

    wrap.querySelector('[data-role="end"]').onclick = function () {
      renderGrid();
    };

    renderDiff();
    paintHud();

    if (!host.classList.contains("on")) host.classList.add("on");
    var b = document.getElementById("btnPuzzle");
    if (b) b.classList.add("on");

    startTimer();
    if (typeof def.play === "function") {
      try {
        var ret = def.play(api);
        if (ret && typeof ret === "function") cleanup = ret;
        current.cleanup = cleanup;
      } catch (err) {
        stage.innerHTML =
          '<div class="pz-placeholder">' +
          esc(err && err.message ? err.message : String(err)) +
          "</div>";
      }
    } else {
      stage.innerHTML =
        '<div class="pz-placeholder">' +
        esc(t("未实现 · 玩法将在后续接入")) +
        "</div>";
    }
  }

  /* ── 公开 API ───────────────────────────────────────────── */
  var Puzzle = {
    open: function (gameId) {
      ensureHost();
      closeRivals();
      var def =
        (gameId && registry.find(function (d) { return d.id === gameId; })) ||
        null;
      if (def) renderGridHostKeep(def);
      else renderGrid();
    },
    close: function () {
      ensureHost();
      killSession();
      host.classList.remove("on");
      var b = document.getElementById("btnPuzzle");
      if (b) b.classList.remove("on");
    },
    isOpen: function () {
      return host ? host.classList.contains("on") : false;
    },
    registry: function () {
      return registry;
    },
    register: function (defs) {
      if (!Array.isArray(defs)) defs = [defs];
      var exist = {};
      registry.forEach(function (d) {
        exist[d.id] = 1;
      });
      defs.forEach(function (d) {
        if (!d || !d.id) return;
        d.order = d.order == null ? 0 : d.order;
        if (!exist[d.id]) {
          registry.push(d);
          exist[d.id] = 1;
        } else {
          // 同名 id：整条替换（供后续任务逐款补全逻辑）
          var i = registry.findIndex(function (x) {
            return x.id === d.id;
          });
          if (i >= 0) registry[i] = d;
        }
      });
    },
    /* 框架共享工具（各游戏实现可引用） */
    bd: bd,
    t: t,
    loc: pick,
    el: function (id) {
      return document.getElementById(id);
    },
    esc: esc,
    isEn: isEn,
  };
  window.Puzzle = Puzzle;

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bindButton);
  } else {
    bindButton();
  }
})();
