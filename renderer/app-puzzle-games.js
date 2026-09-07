/* ==========================================================================
   app-puzzle-games.js — MTNode 益智小游戏目录（17 款 · MG-01 ~ MG-17）

   本文件只负责「目录与图标」这一层：每款游戏 = 一个 def（id / code / group /
   type / name / rule / accent / icon），并通过 Puzzle.register 挂进框架，供
   顶栏 Puzzle 入口的列表 grid 渲染。真正玩法由后续任务为每款补 `play(api)`
   （与可选的 `onLevelChange(api)`）；未接入前框架会显示占位说明。
   ========================================================================== */
(function () {
  "use strict";
  if (!window.Puzzle) return;

  /* 图标包装：统一 34 viewBox、stroke=currentColor、呼应 MTNode 线性图标风格 */
  function svg(inner) {
    return (
      '<svg viewBox="0 0 34 34" aria-hidden="true" fill="none" ' +
      'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
      inner +
      "</svg>"
    );
  }

  /* ---- 每组一个配色基准，避免用户配色记忆冲突 ---------------------- */
  var C = {
    calc: "#e6b45a", // 计算 / 逻辑（琥珀）
    mem: "#7ce8ff", // 记忆 / 注意（青）
    per: "#ff9ecb", // 知觉 / 空间（粉）
    spa: "#9be38a", // 空间（绿）
  };

  var G = {
    A: "A", // 计算 / 逻辑
    B: "B", // 记忆 / 注意
    C: "C", // 知觉 / 空间
  };

  var defs = [
    /* ================= A 组 · 计算 / 逻辑 ================= */
    {
      id: "mg01",
      code: "MG-01",
      group: G.A,
      order: 1,
      accent: C.calc,
      type: ["CALC", "DRAG"],
      name: { zh: "拖拽加法", en: "Drag Addition" },
      rule: {
        zh: "拖 2~3 个数字气泡进算式槽，让和等于目标数即过关",
        en: "Drag 2–3 number bubbles to the slot so they sum to the target",
      },
      icon: function () {
        return svg(
          '<circle cx="12" cy="22" r="5.5"/><circle cx="22" cy="13" r="5.5"/><circle cx="13" cy="11" r="4"/>' +
            '<path d="M20 22h6M23 19v6"/>',
        );
      },
    },
    {
      id: "mg02",
      code: "MG-02",
      group: G.A,
      order: 2,
      accent: C.calc,
      type: ["CALC"],
      name: { zh: "速算", en: "Quick Calc" },
      rule: {
        zh: "一题口算 a ⊙ b，从 4 个选项点出正确答案",
        en: "Solve a ⊙ b fast, tap the right one of 4 answers",
      },
      icon: function () {
        return svg(
          '<rect x="7" y="7" width="20" height="20" rx="5"/>' +
            '<path d="M11 20.5h6.5l-4-6h3.5M22 20.5h-2M20 18v3"/>',
        );
      },
    },
    {
      id: "mg03",
      code: "MG-03",
      group: G.A,
      order: 3,
      accent: C.calc,
      type: ["LOG", "RSP"],
      name: { zh: "大小预测", en: "Higher or Lower" },
      rule: {
        zh: "预判下一个数更大还是更小，揭晓后连击累计",
        en: "Predict higher or lower, then the next number is revealed",
      },
      icon: function () {
        return svg(
          '<path d="M17 27V7M9 15l8-8 8 8"/>',
        );
      },
    },
    {
      id: "mg04",
      code: "MG-04",
      group: G.A,
      order: 4,
      accent: C.calc,
      type: ["LOG"],
      name: { zh: "数列规律", en: "Number Sequence" },
      rule: {
        zh: "看破 a1..a5 的规律，从 4 个选项选出下一项",
        en: "Find the rule and pick the next term from 4 choices",
      },
      icon: function () {
        return svg(
          '<circle cx="8" cy="12" r="2.4"/><circle cx="15" cy="12" r="2.4"/>' +
            '<circle cx="22" cy="12" r="2.4"/><circle cx="29" cy="12" r="2.4" opacity=".45"/>' +
            '<path d="M8 22h7M8 26h10"/>',
        );
      },
    },

    /* ================= B 组 · 记忆 / 注意 / 抑制 ================= */
    {
      id: "mg05",
      code: "MG-05",
      group: G.B,
      order: 5,
      accent: C.mem,
      type: ["MEM", "LOG"],
      name: { zh: "天气序列", en: "Weather Cast" },
      rule: {
        zh: "记住一串天气图标，回答第 N 天 / 外推下一天",
        en: "Memorize the icon sequence, recall a day or extrapolate",
      },
      icon: function () {
        return svg(
          '<circle cx="10" cy="13" r="4.5"/><path d="M14.5 13a4 4 0 0 1 4-4M6 22h10M5 22a3 3 0 0 1 .6-5.9"/>' +
            '<path d="M22 12h4M24 10v4M24 22c3.5 0 3-5.5 0-5.5S20.5 22 24 22z"/>',
        );
      },
    },
    {
      id: "mg06",
      code: "MG-06",
      group: G.B,
      order: 6,
      accent: C.mem,
      type: ["ATT", "PER"],
      name: { zh: "顺序点数字", en: "Touch the Number" },
      rule: {
        zh: "网格里散布的数字，按 1→N 升序点完",
        en: "Touch numbers 1→N in ascending order",
      },
      icon: function () {
        return svg(
          '<rect x="7" y="7" width="8" height="8" rx="2"/><rect x="19" y="7" width="8" height="8" rx="2"/>' +
            '<rect x="7" y="19" width="8" height="8" rx="2"/><rect x="19" y="19" width="8" height="8" rx="2"/>' +
            '<path d="M9.6 9.6h2.8l-2.8 2.8h2.8"/>',
        );
      },
    },
    {
      id: "mg07",
      code: "MG-07",
      group: G.B,
      order: 7,
      accent: C.mem,
      type: ["MEM"],
      name: { zh: "数字顺背 / 倒背", en: "Digit Span" },
      rule: {
        zh: "记住逐位闪现的数字串，按顺序（或反序）点出",
        en: "Recall the flashed digits in (or reverse) order",
      },
      icon: function () {
        return svg(
          '<rect x="7" y="9" width="20" height="17" rx="3"/>' +
            '<path d="M12 26v2M17 26v2M22 26v2"/>' +
            '<path d="M13 13l4 4 4-4M13 17l4 4 4-4"/>',
        );
      },
    },
    {
      id: "mg08",
      code: "MG-08",
      group: G.B,
      order: 8,
      accent: C.mem,
      type: ["MEM"],
      name: { zh: "翻牌配对", en: "Memory Match" },
      rule: {
        zh: "每次翻开两张，配对几何图形，全部配对过关",
        en: "Flip two cards at a time and match every pair",
      },
      icon: function () {
        return svg(
          '<rect x="8" y="8" width="9" height="11" rx="2"/><rect x="17" y="15" width="9" height="11" rx="2"/>' +
            '<path d="M12 11h2M12 14h2M12 17h2"/>',
        );
      },
    },
    {
      id: "mg09",
      code: "MG-09",
      group: G.B,
      order: 9,
      accent: C.mem,
      type: ["ATT", "RSP"],
      name: { zh: "色词干扰", en: "Stroop" },
      rule: {
        zh: "按当前口径判断字义或墨色，忽略另一维",
        en: "Judge word or ink color per the current ask",
      },
      icon: function () {
        return svg(
          '<rect x="6" y="9" width="22" height="9" rx="3"/><rect x="6" y="20" width="22" height="5" rx="2"/>' +
            '<path d="M11 12.5c0-1.5 3-1.5 3 0M14 12.5c0-1.5 3-1.5 3 0"/>',
        );
      },
    },
    {
      id: "mg10",
      code: "MG-10",
      group: G.B,
      order: 10,
      accent: C.mem,
      type: ["RSP", "ATT"],
      name: { zh: "反应抑制", en: "Go / No-Go" },
      rule: {
        zh: "看到目标图形就点，陷阱图形（缺一口）千万别点",
        en: "Tap the target shape, never tap the trap",
      },
      icon: function () {
        return svg(
          '<circle cx="15" cy="17" r="8"/><circle cx="15" cy="17" r="3.5"/>' +
            '<path d="M26 26l3 3" />',
        );
      },
    },

    /* ================= C 组 · 知觉 / 空间 / 规划 ================= */
    {
      id: "mg11",
      code: "MG-11",
      group: G.C,
      order: 11,
      accent: C.per,
      type: ["PER"],
      name: { zh: "快速找异", en: "Quick Eye" },
      rule: {
        zh: "满屏相似图形中找出唯一的异类并点它",
        en: "Spot and tap the one shape that differs",
      },
      icon: function () {
        return svg(
          '<circle cx="12" cy="20" r="6"/><circle cx="12" cy="20" r="2.6"/>' +
            '<path d="M24 12h5M26.5 9.5v5"/>',
        );
      },
    },
    {
      id: "mg12",
      code: "MG-12",
      group: G.C,
      order: 12,
      accent: C.per,
      type: ["PER", "LOG"],
      name: { zh: "归类剔除", en: "Odd One Out" },
      rule: {
        zh: "大多数图形共享一条规则，点出不同类者",
        en: "Tap the item that breaks the shared rule",
      },
      icon: function () {
        return svg(
          '<circle cx="10" cy="11" r="4"/><circle cx="24" cy="11" r="4"/><circle cx="24" cy="23" r="4"/>' +
            '<path d="M10 23l2.5 3 4-5.5"/>',
        );
      },
    },
    {
      id: "mg13",
      code: "MG-13",
      group: G.C,
      order: 13,
      accent: C.per,
      type: ["PER"],
      name: { zh: "计数", en: "Counting" },
      rule: {
        zh: "数清满足指定条件（如蓝色三角形）的图形个数",
        en: "Count items that match the given property",
      },
      icon: function () {
        return svg(
          '<path d="M12 8l6 10H6z"/><path d="M22 9l3.5 7h-7z"/><path d="M20 21h3M23 18v3"/>',
        );
      },
    },
    {
      id: "mg14",
      code: "MG-14",
      group: G.C,
      order: 14,
      accent: C.spa,
      type: ["SPA"],
      name: { zh: "俯视 / 三视图", en: "Bird's View" },
      rule: {
        zh: "从候选视图中选出从指定方向看到的形状",
        en: "Pick the correct projection from a chosen direction",
      },
      icon: function () {
        return svg(
          '<rect x="6" y="6" width="22" height="16" rx="2"/><rect x="9" y="9" width="5" height="5"/>' +
            '<rect x="18" y="9" width="7" height="5"/><rect x="18" y="18" width="7" height="5"/>',
        );
      },
    },
    {
      id: "mg15",
      code: "MG-15",
      group: G.C,
      order: 15,
      accent: C.spa,
      type: ["SPA"],
      name: { zh: "立体展开图", en: "Cube Net" },
      rule: {
        zh: "选出能折成带标记立方体的那张展开图",
        en: "Choose the net that folds into the marked cube",
      },
      icon: function () {
        return svg(
          '<rect x="12" y="7" width="10" height="10" rx="1"/><rect x="8" y="17" width="10" height="10" rx="1"/>' +
            '<rect x="18" y="17" width="10" height="10" rx="1"/>',
        );
      },
    },
    {
      id: "mg16",
      code: "MG-16",
      group: G.C,
      order: 16,
      accent: C.spa,
      type: ["SPA", "LOG"],
      name: { zh: "齿轮传动", en: "Drive the Gear" },
      rule: {
        zh: "选出让末轮按目标方向 / 圈数转动的齿轮",
        en: "Pick the gear that drives the last wheel correctly",
      },
      icon: function () {
        return svg(
          '<circle cx="9" cy="17" r="5"/><circle cx="25" cy="17" r="5"/>' +
            '<path d="M14 17h6M25 11v3"/>',
        );
      },
    },
    {
      id: "mg17",
      code: "MG-17",
      group: G.C,
      order: 17,
      accent: C.spa,
      type: ["PLAN", "SPA"],
      name: { zh: "六边形连锁", en: "Hexa Chain" },
      rule: {
        zh: "画一条链连起全部目标六边形（不穿墙、不交叉）",
        en: "Link every target hexagon in one chain",
      },
      icon: function () {
        return svg(
          '<path d="M13 7l7 4 7-4v8l-7 4-7-4zM6 15l7 4 7-4M6 15v8l7 4M20 23l-7-4M27 19l-7 4"/>',
        );
      },
    },
  ];

  /* =========================================================================
     A 组玩法引擎（MG-01 ~ MG-04）——挂接到 defs 同名对象（register 保留引用）
     通用：每个难度一局 = 若干题；每题带倒计时条；错/超时即跳过。
     ========================================================================= */
  var Puzzle = window.Puzzle;

  /* ---- 通用小工具 ------------------------------------------------------ */
  function ri(min, max) {
    return min + Math.floor(Math.random() * (max - min + 1));
  }
  function shuffle(a) {
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var tmp = a[i];
      a[i] = a[j];
      a[j] = tmp;
    }
    return a;
  }
  function pick(a) {
    return a[Math.floor(Math.random() * a.length)];
  }
  function now() {
    return Date.now();
  }
  /* 一次性倒计时条（.pz-qtime），毫秒计；到期触发 onEnd，stop 可提前停 */
  function countdownBar(ms, onEnd) {
    var wrap = document.createElement("div");
    wrap.className = "pz-qtime";
    var fill = document.createElement("i");
    wrap.appendChild(fill);
    var alive = true;
    var intv = null;
    var start = now();
    var dur = ms;
    function stop() {
      alive = false;
      if (intv) {
        clearInterval(intv);
        intv = null;
      }
    }
    function go() {
      start = now();
      fill.style.transition = "none";
      fill.style.transform = "scaleX(1)";
      wrap.classList.remove("low");
      intv = setInterval(function () {
        if (!alive) return;
        var el = now() - start;
        var f = Math.max(0, 1 - el / dur);
        fill.style.transform = "scaleX(" + f + ")";
        if (el / dur > 0.72) wrap.classList.add("low");
        if (el >= dur) {
          stop();
          if (onEnd) onEnd();
        }
      }, 40);
    }
    go();
    return { el: wrap, stop: stop };
  }
  function node(tag, cls, html) {
    var e = document.createElement(tag || "div");
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  }

  /* ---- 会话句柄（每款 def 一个，难度切换时先清再重启） ----------------- */
  var live = {}; // id -> array of stop fns
  function clearLive(id) {
    (live[id] || []).forEach(function (f) {
      try { f(); } catch (_) {}
    });
    live[id] = [];
  }
  function track(id, fn) {
    (live[id] = live[id] || []).push(fn);
  }
  function later(id, fn, ms) {
    var t = setTimeout(function () { try { fn(); } catch (_) {} }, ms);
    track(id, function () { clearTimeout(t); });
  }
  function interval(id, fn, ms) {
    var iv = setInterval(fn, ms);
    track(id, function () { clearInterval(iv); });
  }

  /* 难度共用的速度权重：用掉 0% 时限=1.15 分、用满=0.85 分（贴合 D3 par 160×1.15） */
  function speedW(remainMs, limitMs) {
    var fr = Math.max(0, Math.min(1, remainMs / limitMs));
    return 0.85 + 0.3 * fr;
  }
  function rndScore(n) {
    return Math.round(n);
  }
  function comboPrefix(combo) {
    return combo >= 2 ? "  ·  🔥x" + combo : "";
  }
  /* A 组每题得分口径：答对给 bd×w；答错 / 超时给 -0.2×bd */
  function award(id, api, cfg, correct, remainMs) {
    var pts;
    if (correct) {
      var w = speedW(remainMs, cfg.ms);
      pts = rndScore(Puzzle.bd(api.level()) * w * (cfg.weight || 1));
    } else {
      pts = -rndScore(Puzzle.bd(api.level()) * 0.2);
    }
    api.addScore(pts);
    return pts;
  }

  /* A 组共用「一局结束浮层」（done 计数撞 10 题后由各 builder 自行调用） */
  function endOverlay(id, api, rebuild) {
    if (!api.stage.isConnected) return;
    clearLive(id);
    var ov = node("div", "pz-over");
    ov.innerHTML =
      "<div class='big'>" + Puzzle.loc({ zh: "本轮结束", en: "Done" }) + "</div>" +
      "<div class='stat'>" +
      Puzzle.loc({ zh: "得分：", en: "Score: " }) + "<b>" + api.state.score + "</b><br>" +
      Puzzle.loc({ zh: "完成：", en: "Answered: " }) + api.state.done + "<br>" +
      "</div>" +
      "<div class='minirow'>" +
      "<button type='button' class='mini' data-i18n='再来一局' data-a='again'></button>" +
      "<button type='button' class='mini' data-i18n='返回列表' data-a='list'></button>" +
      "</div>";
    var again = ov.querySelector('[data-a="again"]');
    var list = ov.querySelector('[data-a="list"]');
    if (window.I18n && I18n.applyDom) { try { I18n.applyDom(ov); } catch (_) {} }
    again.onclick = function () { clearLive(id); if (rebuild) rebuild(id, api); };
    list.onclick = function () { clearLive(id); if (api.toList) api.toList(); };
    api.stage.appendChild(ov);
  }

  /* =====================================================================
     MG-01 · 拖拽加法
     ===================================================================== */
  var MG01CFG = [
    { k: 2, lo: 1, hi: 9, ms: 6000 },
    { k: 2, lo: 1, hi: 20, ms: 5000 },
    { k: 2, lo: 10, hi: 49, ms: 4500 },
    { k: 3, lo: 1, hi: 30, ms: 4500 },
    { k: 3, lo: 10, hi: 60, ms: 4000 },
  ];
  function genMG01(cfg) {
    for (var att = 0; att < 200; att++) {
      var ans = [];
      for (var i = 0; i < cfg.k; i++) ans.push(ri(cfg.lo, cfg.hi));
      var T = 0;
      for (i = 0; i < cfg.k; i++) T += ans[i];
      /* 池：k 个正解 + (6-k) 个「差一即可成立」诱饵（与某正解相差 ±1..4），值域不足则去重补 */
      var pool = ans.slice();
      var tried = 0;
      while (pool.length < 6 && tried < 300) {
        tried++;
        var delta = ri(-4, 4);
        if (delta === 0) continue;
        var v = pick(ans) + delta;
        if (v < cfg.lo || v > cfg.hi) continue;
        if (pool.indexOf(v) >= 0) continue;
        pool.push(v);
      }
      tried = 0;
      while (pool.length < 6 && tried < 400) {
        tried++;
        var v2 = ri(cfg.lo, cfg.hi);
        if (pool.indexOf(v2) < 0) pool.push(v2);
      }
      while (pool.length < 6) pool.push(pick(ans)); // 值域太窄允许同值
      if (pool.length === 6) return { target: T, pool: shuffle(pool) };
    }
    return null;
  }
  var MG01TOTAL = 10;
  function buildMG01(id, api) {
    var stage = api.stage;
    stage.innerHTML = "";
    var cfg = MG01CFG[Math.min(4, Math.max(0, api.level() - 1))];
    api.hud({ score: 0, done: 0, combo: 0 });

    var wrap = node("div", "pz-game");
    var prompt = node("div", "pz-prompt");
    var qbarHost = node("div");
    var bank = node("div", "mg-bank");
    var slotRow = node("div", "", "<div class='mg-eq'>= <span data-r='t'>0</span></div><div class='mg-slot' data-r='slot'></div>");
    var slotEl = slotRow.querySelector('[data-r="slot"]');
    var tgtEl = slotRow.querySelector('[data-r="t"]');
    var sub = node("div", "pz-sub");
    wrap.appendChild(prompt); wrap.appendChild(qbarHost);
    wrap.appendChild(bank); wrap.appendChild(slotRow); wrap.appendChild(sub);
    stage.appendChild(wrap);

    var cells = []; // 当前槽内 {value, bubbleEl}
    var bar = null;
    var frozen = false; // 判定/跳题期间锁交互
    var q = null;

    function renderSlot() {
      slotEl.innerHTML = "";
      for (var i = 0; i < cfg.k; i++) {
        var cell = node("div", "mg-cell");
        var it = cells[i];
        if (it) {
          cell.textContent = it.value;
          cell.classList.add("filled");
          (function (idx) {
            cell.onclick = function () {
              if (frozen) return;
              var c = cells[idx];
              if (!c) return;
              cells[idx] = null;
              c.bubbleEl.classList.remove("used");
              renderSlot();
            };
          })(i);
        }
        slotEl.appendChild(cell);
      }
      slotEl.classList.remove("good", "bad");
    }
    function filledSum() {
      var s = 0;
      for (var i = 0; i < cells.length; i++) if (cells[i]) s += cells[i].value;
      return s;
    }
    function filledCount() {
      var n = 0;
      for (var i = 0; i < cells.length; i++) if (cells[i]) n++;
      return n;
    }
    function resetCells() {
      cells = [];
      for (var i = 0; i < cfg.k; i++) cells.push(null);
    }
    function emptyIndex() {
      for (var i = 0; i < cfg.k; i++) if (!cells[i]) return i;
      return -1;
    }

    function renderBank() {
      bank.innerHTML = "";
      for (var i = 0; i < q.pool.length; i++) {
        (function (val, idx) {
          var b = node("div", "mg-bubble");
          b.textContent = val;
          b.setAttribute("data-v", val);
          var ghost = null;
          var move = false;
          b.addEventListener("pointerdown", function (e) {
            if (frozen || b.classList.contains("used")) return;
            if (e.button !== undefined && e.button !== 0) return;
            e.preventDefault();
            var start = { x: e.clientX, y: e.clientY };
            move = false;
            ghost = node("div", "mg-ghost");
            ghost.textContent = val;
            ghost.style.left = "-200px";
            ghost.style.top = "-200px";
            document.body.appendChild(ghost);
            b.classList.add("grabbing");
            function mv(ev) {
              move = true;
              if (ghost) {
                ghost.style.left = (ev.clientX - 27) + "px";
                ghost.style.top = (ev.clientY - 27) + "px";
              }
            }
            function up(ev) {
              document.removeEventListener("pointermove", mv);
              document.removeEventListener("pointerup", up);
              if (ghost) { ghost.remove(); ghost = null; }
              b.classList.remove("grabbing");
              if (frozen || b.classList.contains("used")) return;
              var r = slotEl.getBoundingClientRect();
              var inside =
                ev.clientX >= r.left && ev.clientX <= r.right &&
                ev.clientY >= r.top && ev.clientY <= r.bottom;
              var emptyIdx = emptyIndex();
              if (inside && emptyIdx >= 0) {
                /* 入槽：放入第一个空位（k 个空槽之一） */
                cells[emptyIdx] = { value: val, bubbleEl: b };
                b.classList.add("used");
                renderSlot();
                slotEl.classList.add("on-drag");
                setTimeout(function () { slotEl.classList.remove("on-drag"); }, 120);
                if (filledCount() === cfg.k) judge();
              } else {
                // 拖到空槽已满或拖回池中 → 回弹
              }
            }
            document.addEventListener("pointermove", mv);
            document.addEventListener("pointerup", up);
          });
          bank.appendChild(b);
        })(q.pool[i], i);
      }
    }

    function showGoodCombo() {
      /* 正确组合描边 300ms */
      slotEl.classList.add("good");
      setTimeout(function () { slotEl.classList.remove("good"); }, 300);
    }

    function judge() {
      if (frozen) return;
      if (filledCount() < cfg.k) return;
      var s = filledSum();
      var correct = s === q.target;
      if (correct) {
        frozen = true;
        if (bar) bar.stop();
        var remain = cfg.ms;
        var pts = award(id, api, { ms: cfg.ms, weight: 1 }, true, remain);
        api.hud({ done: api.state.done + 1, combo: api.state.combo + 1 });
        sub.textContent = "✓ +" + pts + comboPrefix(api.state.combo);
        showGoodCombo();
        var dn = api.state.done;
        later(id, function () {
          if (dn >= MG01TOTAL) endOverlay(id, api, buildMG01);
          else nextQuestion();
        }, 340);
      } else {
        /* 错：槽位红抖 */
        slotEl.classList.add("bad");
        sub.textContent = Puzzle.loc({ zh: "✗ 不对（目标 " + q.target + "）", en: "✗ not " + q.target });
        setTimeout(function () {
          slotEl.classList.remove("bad");
          // 放回已填气泡，槽清空
          for (var i = 0; i < cells.length; i++) if (cells[i]) cells[i].bubbleEl.classList.remove("used");
          resetCells();
          renderSlot();
        }, 300);
      }
    }

    var cRemain = function () { return cfg.ms; };

    function nextQuestion() {
      if (!api.stage.isConnected) return;
      frozen = false;
      resetCells();
      q = genMG01(cfg);
      if (!q) { if (api.toList) api.toList(); return; }
      prompt.innerHTML = Puzzle.loc({
        zh: "目标数 <span class='big'>" + q.target + "</span> · 拖 " + cfg.k + " 个进算式槽",
        en: "Target <span class='big'>" + q.target + "</span> · drag " + cfg.k,
      });
      tgtEl.textContent = q.target;
      sub.textContent = "";
      renderBank();
      renderSlot();
      if (bar) bar.stop();
      bar = countdownBar(cfg.ms, function () {
        if (frozen) return;
        frozen = true;
        sub.textContent = Puzzle.loc({ zh: "⏱ 超时 · 答案 ", en: "time up · " }) + q.target;
        api.hud({ done: api.state.done + 1, combo: 0 });
        later(id, function () {
          if (api.state.done >= MG01TOTAL) endOverlay(id, api, buildMG01);
          else nextQuestion();
        }, 300);
      });
      qbarHost.innerHTML = "";
      qbarHost.appendChild(bar.el);
    }

    track(id, function () { if (bar) bar.stop(); });
    nextQuestion();
  }

  /* =====================================================================
     MG-02 · 速算（4 选 1）
     ===================================================================== */
  var MG02CFG = [
    { mode: "s", ms: 2000 },
    { mode: "s", ms: 2000 },
    { mode: "s", ms: 1800 },
    { mode: "m", ms: 2200 },
    { mode: "m", ms: 2500 },
  ];
  function genMG02(cfg, prev) {
    var a, b, op, ans, text;
    for (var t = 0; t < 80; t++) {
      var mode = cfg.mode;
      if (mode === "m") {
        if (cfg._s === 4) {
          if (Math.random() < 0.6) { a = ri(2, 9); b = ri(2, 9); op = "×"; ans = a * b; }
          else { a = ri(11, 99); b = ri(2, 9); op = pick(["+", "-"]); ans = op === "+" ? a + b : a - b; }
        } else {
          /* D5：2位 × 1位 */
          a = ri(11, 99); b = ri(2, 9); op = "×"; ans = a * b;
        }
      } else {
        if (cfg._s === 1) { a = ri(1, 9); b = ri(1, 9); op = pick(["+", "-"]); }
        else if (cfg._s === 2) { a = ri(11, 99); b = ri(1, 9); op = pick(["+", "-"]); }
        else { a = ri(11, 99); b = ri(11, 99); op = pick(["+", "-"]); }
        ans = op === "+" ? a + b : a - b;
      }
      text = a + " " + op + " " + b;
      if (text !== prev) return { a: a, b: b, op: op, ans: ans, text: text };
    }
    return null;
  }
  function genOpts(correct) {
    var opts = { correct: correct };
    var cands = [];
    for (var d = 1; d <= 4; d++) { cands.push(correct + d, correct - d); }
    [10, 100].forEach(function (m) { cands.push(correct + m, correct - m); });
    cands = cands.filter(function (x) { return x !== correct; });
    shuffle(cands);
    var pool = [];
    for (var i = 0; i < cands.length && pool.length < 3; i++) if (pool.indexOf(cands[i]) < 0) pool.push(cands[i]);
    var x = 1;
    while (pool.length < 3) { if (pool.indexOf(correct + x) < 0) pool.push(correct + x); x++; }
    pool.push(correct);
    shuffle(pool);
    opts.pool = pool;
    return opts;
  }
  var MG02TOTAL = 10;
  function buildMG02(id, api) {
    var stage = api.stage;
    stage.innerHTML = "";
    var lvl = Math.min(4, Math.max(0, api.level() - 1));
    var cfg = MG02CFG[lvl];
    if (lvl === 0) cfg = { mode: "s", _s: 1, ms: 2000 };
    else if (lvl === 1) cfg = { mode: "s", _s: 2, ms: 2000 };
    else if (lvl === 2) cfg = { mode: "s", _s: 3, ms: 1800 };
    else if (lvl === 3) cfg = { mode: "m", _s: 4, ms: 2200 };
    else cfg = { mode: "m", _s: 5, ms: 2500 };
    api.hud({ score: 0, done: 0, combo: 0 });

    var wrap = node("div", "pz-game");
    var prompt = node("div", "pz-prompt", Puzzle.loc({ zh: "口算并点出答案", en: "Solve, tap the answer" }));
    var qbarHost = node("div");
    var card = node("div", "mg-qcard", "");
    var optsHost = node("div", "pz-opts");
    var sub = node("div", "pz-sub");
    wrap.appendChild(prompt); wrap.appendChild(qbarHost);
    wrap.appendChild(card); wrap.appendChild(optsHost); wrap.appendChild(sub);
    stage.appendChild(wrap);

    var bar = null, frozen = false, q = null, prev = null;

    function renderOpts() {
      optsHost.innerHTML = "";
      var O = genOpts(q.ans);
      O.pool.forEach(function (v) {
        var o = node("button", "pz-opt");
        o.setAttribute("type", "button");
        o.textContent = v;
        o.onclick = function () {
          if (frozen) return;
          frozen = true;
          if (bar) bar.stop();
          var correct = v === O.correct;
          if (correct) {
            o.classList.add("correct");
            var pts = award(id, api, { ms: cfg.ms, weight: 1 }, true, cfg.ms);
            api.hud({ done: api.state.done + 1, combo: api.state.combo + 1 });
            sub.textContent = "✓ +" + pts + comboPrefix(api.state.combo);
            var dn = api.state.done;
            later(id, function () { if (dn >= MG02TOTAL) endOverlay(id, api, buildMG02); else next(); }, 200);
          } else {
            o.classList.add("wrong");
            Array.prototype.forEach.call(optsHost.children, function (x) {
              if (parseInt(x.textContent, 10) === O.correct) x.classList.add("correct");
            });
            award(id, api, { ms: cfg.ms, weight: 1 }, false, 0);
            api.hud({ done: api.state.done + 1, combo: 0 });
            sub.textContent = Puzzle.loc({ zh: "✗ 正确 ", en: "✗ ans " }) + O.correct;
            var dn2 = api.state.done;
            later(id, function () { if (dn2 >= MG02TOTAL) endOverlay(id, api, buildMG02); else next(); }, 600);
          }
        };
        optsHost.appendChild(o);
      });
    }
    function next() {
      if (!api.stage.isConnected) return;
      frozen = false;
      q = genMG02(cfg, prev);
      if (!q) { if (api.toList) api.toList(); return; }
      prev = q.text;
      card.textContent = q.text + " = ?";
      sub.textContent = "";
      renderOpts();
      if (bar) bar.stop();
      bar = countdownBar(cfg.ms, function () {
        if (frozen) return;
        frozen = true;
        sub.textContent = Puzzle.loc({ zh: "⏱ 超时 · 答案 ", en: "time up · " }) + q.ans;
        Array.prototype.forEach.call(optsHost.children, function (x) {
          if (parseInt(x.textContent, 10) === q.ans) x.classList.add("correct");
        });
        api.hud({ done: api.state.done + 1, combo: 0 });
        var dn = api.state.done;
        later(id, function () { if (dn >= MG02TOTAL) endOverlay(id, api, buildMG02); else next(); }, 500);
      });
      qbarHost.innerHTML = "";
      qbarHost.appendChild(bar.el);
    }
    track(id, function () { if (bar) bar.stop(); });
    next();
  }

  /* =====================================================================
     MG-03 · 大小预测（Higher or Lower）
     ===================================================================== */
  var MG03CFG = [
    { mode: "hl", lo: 1, hi: 9, ms: 3000 },
    { mode: "hl", lo: 1, hi: 99, ms: 2000 },
    { mode: "hl", lo: 1, hi: 99, ms: 1200 },
    { mode: "range", lo: 1, hi: 99, ms: 2000 },
    { mode: "combo", lo: 1, hi: 99, ms: 2500 },
  ];
  var MG03TOTAL = 15;
  function buildMG03(id, api) {
    var stage = api.stage;
    stage.innerHTML = "";
    var cfg = MG03CFG[Math.min(4, Math.max(0, api.level() - 1))];
    api.hud({ score: 0, done: 0, combo: 0 });

    var wrap = node("div", "pz-game");
    var prompt = node("div", "pz-prompt");
    var qbarHost = node("div");
    var cur = node("div", "mg-cur", "");
    var sub = node("div", "mg-hint");
    var optsHost = node("div", "pz-opts");
    var info = node("div", "pz-sub");
    wrap.appendChild(prompt); wrap.appendChild(qbarHost);
    wrap.appendChild(cur); wrap.appendChild(sub);
    wrap.appendChild(optsHost); wrap.appendChild(info);
    stage.appendChild(wrap);

    /* 状态：current 当前显示数；target 揭晓数；phase 用于 combo 双阶段 */
    var bar = null, frozen = false, phase = 0;
    var current = 0, target = 0;
    var seq = []; // combo: 预先生成的一串相邻值 [v0, v1, v2, ...]，逐段揭晓

    function mid50(x) {
      return cfg.mode === "hl" && x >= 45 && x <= 55;
    }
    function distinct(bound) {
      var lo = cfg.lo, hi = cfg.hi;
      for (var i = 0; i < 40; i++) {
        var v = ri(lo, hi);
        if (v !== bound) return v;
      }
      return bound === lo ? lo + 1 : lo; // 兜底
    }

    function freshVals() {
      var lo = cfg.lo, hi = cfg.hi;
      if (cfg.mode === "combo") {
        /* 连续 2 步复合：一串 v0 v1 v2，需连续对两次（v0→v1 与 v1→v2） */
        seq = [];
        seq.push(ri(lo, hi));
        for (var i = 1; i <= 2; i++) seq.push(distinct(seq[i - 1]));
        current = seq[0];
        phase = 0;
        target = seq[phase + 1];
        return;
      }
      current = ri(lo, hi);
      if (cfg.mode === "range") {
        /* 生成一个落在区间外的值（区间判定题型），或大概率区外保证有区分 */
        target = ri(lo, hi);
        var g = 0;
        while (Math.abs(target - current) <= 10 && g < 50) { target = ri(lo, hi); g++; }
        if (g >= 50) target = (current + 12 <= hi) ? current + 12 : current - 12;
      } else {
        target = distinct(current);
      }
    }

    function drawButtons(kindHigher) {
      optsHost.innerHTML = "";
      [true, false].forEach(function (val) {
        var o = node("button", "pz-opt wide");
        o.setAttribute("type", "button");
        if (cfg.mode === "range") {
          o.textContent = Puzzle.loc(val ? { zh: "在区间内", en: "inside" } : { zh: "区间外", en: "outside" });
        } else {
          o.textContent = Puzzle.loc(val ? { zh: "更大 ▲", en: "Higher ▲" } : { zh: "更小 ▼", en: "Lower ▼" });
        }
        o.onclick = function () { choose(val, o); };
        optsHost.appendChild(o);
      });
    }

    function draw() {
      cur.textContent = current;
      if (cfg.mode === "combo") {
        prompt.innerHTML = phase === 0
          ? Puzzle.loc({ zh: "第 1 步 · 下一个数比 " + current + " 更大还是更小？", en: "Step1: next vs " + current + "?" })
          : Puzzle.loc({ zh: "第 2 步 · 下一个数比 " + current + " 更大还是更小？", en: "Step2: next vs " + current + "?" });
        drawButtons(false);
      } else if (cfg.mode === "range") {
        prompt.innerHTML = Puzzle.loc({
          zh: "下一个数落在 <b>[" + (current - 10) + ", " + (current + 10) + "]</b> 内吗？",
          en: "Will the next be in [" + (current - 10) + ", " + (current + 10) + "]?",
        });
        drawButtons(true);
      } else {
        prompt.innerHTML = Puzzle.loc({ zh: "下一个数比 " + current + " 更大还是更小？", en: "Next vs " + current + "?" });
        drawButtons(false);
      }
    }

    /* 从「更高/更小」或「在/不在区间」判断赢：higher=true 表示押"更大"(hl) 或"在区间内"(range) */
    function isWin(higher) {
      if (cfg.mode === "range") return higher === (Math.abs(target - current) <= 10);
      return higher === (target > current);
    }

    function choose(higher, btnEl) {
      if (frozen) return;
      frozen = true;
      if (bar) bar.stop();
      var won = isWin(higher);
      var inMid = cfg.mode === "hl" && mid50(current);
      var inMidR = cfg.mode === "range" && Math.abs(current - 50) <= 5;
      var w = (inMid || inMidR) ? 1.3 : 1;

      if (cfg.mode === "combo") {
        /* 双阶段：每段判一次；全对才得分（复合两档） */
        if (won) {
          btnEl.classList.add("correct");
          if (phase === 0) {
            phase = 1;
            current = seq[1];
            target = seq[2];
            frozen = false;
            info.textContent = Puzzle.loc({ zh: "✓ 第 1 步 " + seq[1] + " · 继续", en: "✓ step1 " + seq[1] });
            draw();
            restartBar(cfg.ms, seq[1]);
            return;
          } else {
            var pts = rndScore(Puzzle.bd(api.level()) * w);
            api.addScore(pts);
            api.hud({ done: api.state.done + 1, combo: api.state.combo + 1 });
            sub.textContent = "✓✓ " + Puzzle.loc({ zh: "两档全对  ", en: "both right  " }) + seq[2] + "  +" + pts + comboPrefix(api.state.combo);
            var dn = api.state.done;
            later(id, function () { if (dn >= MG03TOTAL) endOverlay(id, api, buildMG03); else next(); }, 360);
          }
        } else {
          btnEl.classList.add("wrong");
          api.addScore(-rndScore(Puzzle.bd(api.level()) * 0.2 * w));
          api.hud({ done: api.state.done + 1, combo: 0 });
          sub.textContent = Puzzle.loc({ zh: "✗ 是 " + target, en: "✗ was " + target });
          var dn2 = api.state.done;
          later(id, function () { if (dn2 >= MG03TOTAL) endOverlay(id, api, buildMG03); else next(); }, 620);
        }
        return;
      }

      /* hl / range：一档判定 */
      if (current === target) {
        /* push（仅 hl 可能出现；range 的 target 恒 != current） */
        sub.textContent = Puzzle.loc({ zh: "⚖ 持平 " + current, en: "push " + current });
        api.hud({ done: api.state.done + 1, combo: 0 });
        var dnp = api.state.done;
        later(id, function () { if (dnp >= MG03TOTAL) endOverlay(id, api, buildMG03); else next(); }, 420);
        return;
      }
      if (won) {
        btnEl.classList.add("correct");
        var pts = rndScore(Puzzle.bd(api.level()) * w);
        api.addScore(pts);
        api.hud({ done: api.state.done + 1, combo: api.state.combo + 1 });
        sub.textContent = "✓ " + target + "  +" + pts + comboPrefix(api.state.combo);
        var dn = api.state.done;
        later(id, function () { if (dn >= MG03TOTAL) endOverlay(id, api, buildMG03); else next(); }, 360);
      } else {
        btnEl.classList.add("wrong");
        api.addScore(-rndScore(Puzzle.bd(api.level()) * 0.2 * w));
        api.hud({ done: api.state.done + 1, combo: 0 });
        sub.textContent = "✗ " + Puzzle.loc({ zh: "是 ", en: "was " }) + target;
        var dn2 = api.state.done;
        later(id, function () { if (dn2 >= MG03TOTAL) endOverlay(id, api, buildMG03); else next(); }, 620);
      }
    }

    function restartBar(ms, revealBase) {
      if (bar) bar.stop();
      bar = countdownBar(ms, function () {
        if (frozen) return;
        frozen = true;
        sub.textContent = Puzzle.loc({ zh: "⏱ 超时", en: "time up" });
        api.hud({ done: api.state.done + 1, combo: 0 });
        var dn = api.state.done;
        later(id, function () { if (dn >= MG03TOTAL) endOverlay(id, api, buildMG03); else next(); }, 300);
      });
      qbarHost.innerHTML = "";
      qbarHost.appendChild(bar.el);
    }

    function next() {
      if (!api.stage.isConnected) return;
      frozen = false;
      phase = 0;
      freshVals();
      info.textContent = "";
      draw();
      sub.textContent = "";
      restartBar(cfg.ms);
    }
    track(id, function () { if (bar) bar.stop(); });
    next();
  }

  /* =====================================================================
     MG-04 · 数列规律（4 选 1）
     ===================================================================== */
  /* 规则库：每 rule {gen, match} */
  var SEQ_GEN = {
    arith: function () {
      var d = pick([2, 3, 4, 5, 6, 7, 8, 9]);
      var a0 = ri(1, 9);
      var arr = [];
      for (var i = 1; i <= 5; i++) arr.push(a0 + i * d);
      return arr;
    },
    geom: function () {
      var r = pick([2, 3]);
      var a0 = pick([1, 2, 3]);
      var arr = [];
      for (var i = 1; i <= 5; i++) arr.push(a0 * Math.pow(r, i - 1));
      return arr;
    },
    quad: function () {
      var d2 = ri(1, 5);
      var a = ri(1, 6), b = ri(1, 9);
      var arr = [];
      for (var i = 1; i <= 5; i++) arr.push(d2 * i * i + a * i + b);
      return arr;
    },
    altern: function () {
      var ap = ri(2, 9), bp = ri(2, 9);
      var x = ri(2, 12);
      var arr = [];
      for (var i = 1; i <= 5; i++) { arr.push(x); x += (i % 2 === 1) ? ap : -bp; }
      return arr;
    },
    fib: function () {
      var a = ri(1, 4), b = ri(1, 6);
      var arr = [a, b];
      while (arr.length < 5) arr.push(arr[arr.length - 1] + arr[arr.length - 2]);
      return arr;
    },
    square: function () {
      var base = ri(2, 4);
      var arr = [];
      for (var i = 1; i <= 5; i++) arr.push(base * i * i);
      return arr;
    },
  };
  /* 用给定 arr 前几项反推某规律的下一项；若不适配返回 null */
  var SEQ_MATCH = {
    arith: function (arr) {
      if (arr.length < 2) return null;
      var d = arr[1] - arr[0];
      for (var i = 1; i < arr.length; i++) if (arr[i] - arr[i - 1] !== d) return null;
      return arr[arr.length - 1] + d;
    },
    geom: function (arr) {
      if (arr.length < 2 || arr[0] === 0) return null;
      if (arr[1] % arr[0] !== 0) return null;
      var r = arr[1] / arr[0];
      for (var i = 1; i < arr.length; i++) if (arr[i] / arr[i - 1] !== r || !Number.isInteger(arr[i] / arr[i - 1])) return null;
      return arr[arr.length - 1] * r;
    },
    quad: function (arr) {
      if (arr.length < 4) return null;
      var d1 = arr[1] - arr[0], d2 = arr[2] - arr[1], d3 = arr[3] - arr[2];
      if (d2 - d1 !== d3 - d2) return null;
      var dd = d2 - d1;
      return arr[arr.length - 1] + (arr[arr.length - 1] - arr[arr.length - 2]) + dd;
    },
    altern: function (arr) {
      if (arr.length < 4) return null;
      var d1 = arr[1] - arr[0], d2 = arr[2] - arr[1], d3 = arr[3] - arr[2];
      if (d1 !== d3) return null;
      var d = (arr.length % 2 === 1) ? d1 : d2;
      return arr[arr.length - 1] + d;
    },
    fib: function (arr) {
      if (arr.length < 3) return null;
      for (var i = 2; i < arr.length; i++) if (arr[i] !== arr[i - 1] + arr[i - 2]) return null;
      return arr[arr.length - 1] + arr[arr.length - 2];
    },
    square: function (arr) {
      if (arr.length < 2) return null;
      var b = arr[0];
      if (b <= 0) return null;
      for (var i = 1; i < arr.length; i++) if (arr[i] !== b * (i + 1) * (i + 1)) return null;
      return b * (arr.length + 1) * (arr.length + 1);
    },
  };
  var MG04ALLOW = [
    ["arith"],
    ["arith", "geom"],
    ["arith", "quad"],
    ["altern", "fib", "quad"],
    ["square", "fib", "quad"],
  ];
  function genMG04(lvl) {
    var allow = MG04ALLOW[Math.min(4, Math.max(0, lvl - 1))];
    for (var att = 0; att < 120; att++) {
      var rn = pick(allow);
      var arr = SEQ_GEN[rn]();
      // 生成 5 项，末位是 ?：展示 a1..a4，问 a5
      var shown = arr.slice(0, 4);
      var ans = arr[4];
      // 唯一性校验：看是否另有规律也能解释 shown 且给出不同的下一项
      var conflicts = false;
      var bestDiff = null;
      for (var other in SEQ_MATCH) {
        if (other === rn) continue;
        var cand = SEQ_MATCH[other](shown);
        if (cand !== null && cand !== ans) {
          // 次级规律可解释且答案不同 → 需要保证唯一；但 quad 常能覆盖很多，限制：只有当候选整数且与主规律同档难度才算冲突
          if (Number.isInteger(cand)) { conflicts = true; break; }
        }
      }
      if (conflicts) continue;
      var opts = genSeqOpts(ans);
      return { shown: shown, ans: ans, rule: rn };
    }
    return null;
  }
  function genSeqOpts(ans) {
    var cands = [];
    for (var d = 1; d <= 4; d++) cands.push(ans + d, ans - d);
    cands.push(ans + ri(5, 12), ans - ri(5, 12));
    cands = cands.filter(function (x) { return x !== ans; });
    shuffle(cands);
    var pool = [];
    for (var i = 0; i < cands.length && pool.length < 3; i++) if (pool.indexOf(cands[i]) < 0) pool.push(cands[i]);
    var x = 1;
    while (pool.length < 3) { if (pool.indexOf(ans + x) < 0) pool.push(ans + x); x++; }
    pool.push(ans);
    shuffle(pool);
    return pool;
  }
  var MG04TIME = [12000, 11000, 10000, 9000, 8000];
  var MG04TOTAL = 10;
  function buildMG04(id, api) {
    var stage = api.stage;
    stage.innerHTML = "";
    var lvl = Math.min(4, Math.max(0, api.level() - 1));
    var ms = MG04TIME[lvl];
    api.hud({ score: 0, done: 0, combo: 0 });

    var wrap = node("div", "pz-game");
    var prompt = node("div", "pz-prompt", Puzzle.loc({ zh: "观察前 4 项，选出第 5 项", en: "Observe, pick the next term" }));
    var qbarHost = node("div");
    var seqRow = node("div", "mg-qcard seq");
    var optsHost = node("div", "pz-opts");
    var sub = node("div", "pz-sub");
    wrap.appendChild(prompt); wrap.appendChild(qbarHost);
    wrap.appendChild(seqRow); wrap.appendChild(optsHost); wrap.appendChild(sub);
    stage.appendChild(wrap);

    var bar = null, frozen = false, q = null;

    function renderSeq() {
      seqRow.innerHTML = "";
      q.shown.forEach(function (v) {
        seqRow.appendChild(node("span", "q", v));
      });
      seqRow.appendChild(node("span", "q qm", "?"));
    }
    function renderOpts() {
      optsHost.innerHTML = "";
      var O = q; // {shown, ans}
      var pool = genSeqOpts(q.ans);
      pool.forEach(function (v) {
        var o = node("button", "pz-opt");
        o.setAttribute("type", "button");
        o.textContent = v;
        o.onclick = function () {
          if (frozen) return;
          frozen = true;
          if (bar) bar.stop();
          var correct = v === q.ans;
          if (correct) {
            o.classList.add("correct");
            var pts = award(id, api, { ms: ms, weight: 1 }, true, ms);
            api.hud({ done: api.state.done + 1, combo: api.state.combo + 1 });
            sub.textContent = "✓ +" + pts + comboPrefix(api.state.combo);
            var dn = api.state.done;
            later(id, function () { if (dn >= MG04TOTAL) endOverlay(id, api, buildMG04); else next(); }, 200);
          } else {
            o.classList.add("wrong");
            Array.prototype.forEach.call(optsHost.children, function (x) {
              if (parseInt(x.textContent, 10) === q.ans) x.classList.add("correct");
            });
            award(id, api, { ms: ms, weight: 1 }, false, 0);
            api.hud({ done: api.state.done + 1, combo: 0 });
            sub.textContent = Puzzle.loc({ zh: "✗ 正确 ", en: "✗ ans " }) + q.ans;
            var dn2 = api.state.done;
            later(id, function () { if (dn2 >= MG04TOTAL) endOverlay(id, api, buildMG04); else next(); }, 600);
          }
        };
        optsHost.appendChild(o);
      });
    }
    function next() {
      if (!api.stage.isConnected) return;
      frozen = false;
      q = genMG04(api.level());
      if (!q) { if (api.toList) api.toList(); return; }
      renderSeq();
      renderOpts();
      sub.textContent = "";
      if (bar) bar.stop();
      bar = countdownBar(ms, function () {
        if (frozen) return;
        frozen = true;
        sub.textContent = Puzzle.loc({ zh: "⏱ 超时 · 答案 ", en: "time up · " }) + q.ans;
        Array.prototype.forEach.call(optsHost.children, function (x) {
          if (parseInt(x.textContent, 10) === q.ans) x.classList.add("correct");
        });
        api.hud({ done: api.state.done + 1, combo: 0 });
        var dn = api.state.done;
        later(id, function () { if (dn >= MG04TOTAL) endOverlay(id, api, buildMG04); else next(); }, 500);
      });
      qbarHost.innerHTML = "";
      qbarHost.appendChild(bar.el);
    }
    track(id, function () { if (bar) bar.stop(); });
    next();
  }

  /* =====================================================================
     B 组玩法引擎（MG-05 ~ MG-08）——挂接 defs 同名对象
     ===================================================================== */

  /* ---- MG-05 · 天气序列记忆（MEM/LOG）
        语义中性的几何+色块图标序列，1.2s×n 呈现 → 200ms 黑掩蔽 → 提问。
        问法按档位在 位置回忆(pos) / 外推(next) 间加权。 ---- */
  /* 四种语义中性的几何+色块（圆=晴 / 圆+十字=曇 / 圆+斜杠=雨 / 方=雪），色与形皆可辨 */
  var W5FILL = ["#ffcf5c", "#6fc3ff", "#7fe0a8", "#cf9bff"];
  function w5dot(id) {
    var c = W5FILL[id];
    var inner =
      id === 0 ? '<circle cx="12" cy="12" r="6" fill="' + c + '"/>' :
      id === 1 ? '<circle cx="12" cy="12" r="6" fill="' + c + '"/><path d="M12 4v16M4 12h16" stroke="' + c + '" stroke-width="1.6"/>' :
      id === 2 ? '<circle cx="12" cy="12" r="6" fill="' + c + '"/><path d="M8 16L16 8" stroke="' + c + '" stroke-width="2.4"/>' :
                 '<rect x="5.5" y="5.5" width="13" height="13" rx="1.5" fill="' + c + '"/>';
    return '<svg viewBox="0 0 24 24" width="34" height="34">' + inner + "</svg>";
  }

  var MG05CFG = [
    { n: 3, period: 0, modes: ["pos"], ansMs: 9000 },
    { n: 4, period: 0, modes: ["pos"], ansMs: 8000 },
    { n: 5, period: 3, modes: ["pos", "next"], ansMs: 8000 },
    { n: 6, period: 4, modes: ["pos", "next"], ansMs: 7000 },
    { n: 7, period: 4, modes: ["pos", "next"], ansMs: 7000 },
  ];
  var MG05TOTAL = 5;
  function genMG05Week(cfg, distract) {
    // 一周 n 天；外推档用周期 base，位置档用随机序列
    var per = cfg.period;
    var base = [];
    var i;
    if (per > 0) {
      while (base.length < per) base.push(ri(0, 3));
      if (new Set(base).size < 2) base[1] = (base[0] + 1) % 4;
    } else {
      for (i = 0; i < cfg.n; i++) base.push(ri(0, 3));
      per = cfg.n;
    }
    var days = [];
    for (i = 0; i < cfg.n; i++) days.push(base[i % per]);
    // D5 干扰色：把某一天符号换成近色浅调，只增噪不改语义
    var decoy = null;
    if (distract && cfg.n > 1) {
      var t = ri(0, cfg.n - 1);
      decoy = { at: t, id: days[t] };
    }
    return { days: days, per: per, base: base, decoy: decoy };
  }
  function buildMG05(id, api) {
    var stage = api.stage;
    stage.innerHTML = "";
    var cfg = MG05CFG[Math.min(4, Math.max(0, api.level() - 1))];
    var distract = api.level() >= 5;
    api.hud({ score: 0, done: 0, combo: 0, target: String(MG05TOTAL) });

    var wrap = node("div", "pz-game");
    var qbarHost = node("div");
    var area = node("div", "", "<div class='mg-wrow'></div><div class='mg-wask'></div>");
    var rowEl = area.querySelector(".mg-wrow");
    var askEl = area.querySelector(".mg-wask");
    var optsHost = node("div", "pz-opts");
    wrap.appendChild(qbarHost); wrap.appendChild(area); wrap.appendChild(optsHost);
    stage.appendChild(wrap);

    var bar = null, frozen = false, revealMS = cfg.n * 1200;
    var week = null;

    function renderWeek(q) {
      rowEl.innerHTML = "";
      for (var i = 0; i < q.days.length; i++) {
        var s = node("div", "mg-wslot");
        if (q.decoy && q.decoy.at === i) {
          var near = ["#ffe9ad", "#bce4ff", "#b9f0cf", "#e2c8ff"][q.decoy.id];
          s.innerHTML = w5dot(q.decoy.id).replace(W5FILL[q.decoy.id], near);
        } else {
          s.innerHTML = w5dot(q.days[i]);
        }
        rowEl.appendChild(s);
      }
    }
    /* 呈现一周 → 200ms 全黑掩蔽 → 回调进入答题 */
    function presentWeek(q, done) {
      renderWeek(q);
      var mask = node("div", "mg-wmask");
      later(id, function () {
        rowEl.innerHTML = "";
        rowEl.appendChild(mask);
      }, revealMS);
      later(id, function () {
        mask.remove();
        done();
      }, revealMS + 200);
      track(id, function () { mask.remove(); });
    }
    /* 该周的多道题：位置回忆(0..n-1) / 外推(n → 第 n+1 天) */
    function nextAsk() {
      var mode = pick(cfg.modes);
      var ask;
      if (mode === "next") {
        ask = cfg.n;
      } else {
        ask = ri(0, cfg.n - 1);
      }
      var ans = week.base[ask % week.per];
      return { ask: ask, ans: ans };
    }
    function showAsk(q) {
      var day = q.ask >= week.days.length ? week.days.length + 1 : q.ask + 1;
      askEl.innerHTML =
        q.ask >= week.days.length
          ? Puzzle.loc({ zh: "按规律，第 ", en: "By pattern, day " }) + "<b>" + day + "</b>" + Puzzle.loc({ zh: " 天是？", en: " is?" })
          : Puzzle.loc({ zh: "第 ", en: "Day " }) + "<b>" + day + "</b>" + Puzzle.loc({ zh: " 天是？", en: " was?" });
      optsHost.innerHTML = "";
      var order = [0, 1, 2, 3];
      shuffle(order);
      order.forEach(function (s) {
        var o = node("button", "pz-opt wglyph");
        o.setAttribute("type", "button");
        o.innerHTML = w5dot(s);
        o._s = s;
        o.onclick = function () {
          if (frozen) return;
          frozen = true;
          if (bar) bar.stop();
          var correct = s === q.ans;
          if (correct) {
            o.classList.add("correct");
            var w = 1 + (api.level() - 1) * 0.12;
            api.addScore(rndScore(Puzzle.bd(api.level()) * w));
            api.hud({ done: api.state.done + 1, combo: api.state.combo + 1 });
          } else {
            o.classList.add("wrong");
            Array.prototype.forEach.call(optsHost.children, function (x) {
              if (x._s === q.ans) x.classList.add("correct");
            });
            api.addScore(-rndScore(Puzzle.bd(api.level()) * 0.2));
            api.hud({ done: api.state.done + 1, combo: 0 });
          }
          var dn = api.state.done;
          later(id, function () {
            if (dn >= MG05TOTAL) endOverlay(id, api, buildMG05);
            else showAsk(nextAsk());
          }, correct ? 200 : 500);
        };
        optsHost.appendChild(o);
      });
      if (bar) bar.stop();
      bar = countdownBar(cfg.ansMs, function () {
        if (frozen) return;
        frozen = true;
        Array.prototype.forEach.call(optsHost.children, function (x) {
          if (x._s === q.ans) x.classList.add("correct");
        });
        api.addScore(-rndScore(Puzzle.bd(api.level()) * 0.2));
        api.hud({ done: api.state.done + 1, combo: 0 });
        var dn2 = api.state.done;
        later(id, function () { if (dn2 >= MG05TOTAL) endOverlay(id, api, buildMG05); else showAsk(nextAsk()); }, 400);
      });
      qbarHost.innerHTML = "";
      qbarHost.appendChild(bar.el);
    }
    function start() {
      frozen = false;
      week = genMG05Week(cfg, distract);
      askEl.innerHTML = "";
      optsHost.innerHTML = "";
      presentWeek(week, function () { showAsk(nextAsk()); });
    }
    track(id, function () { if (bar) bar.stop(); });
    start();
  }

  /* ---- MG-06 · 顺序点数字（舒尔特表，ATT/PER）---- */
  var MG06CFG = [
    { dim: 3, time: 12000 },
    { dim: 4, time: 18000 },
    { dim: 4, time: 14000 },
    { dim: 5, time: 22000 },
    { dim: 5, time: 17000 },
  ];
  function buildMG06(id, api) {
    var stage = api.stage;
    stage.innerHTML = "";
    var cfg = MG06CFG[Math.min(4, Math.max(0, api.level() - 1))];
    var dim = cfg.dim, N = dim * dim;
    api.hud({ score: 0, done: 0, combo: 0, target: String(N) });

    var wrap = node("div", "pz-game");
    var prompt = node("div", "pz-prompt", Puzzle.loc({ zh: "从 1 开始按升序点击", en: "Tap 1 → " + N + " in order" }));
    var bar = null;
    var barHost = node("div");
    var grid = node("div", "mg-schulte");
    grid.style.gridTemplateColumns = "repeat(" + dim + ", 62px)";
    var sub = node("div", "pz-sub", "");
    wrap.appendChild(prompt); wrap.appendChild(barHost); wrap.appendChild(grid); wrap.appendChild(sub);
    stage.appendChild(wrap);

    var cells = []; // {num, el}
    var nums = [];
    for (var i = 1; i <= N; i++) nums.push(i);
    shuffle(nums);
    // 数字旋转随机，防按空间顺序扫描
    for (i = 0; i < nums.length; i++) {
      (function (num) {
        var el = node("div", "mg-num");
        el.textContent = num;
        el.style.transform = "rotate(" + (Math.random() * 12 - 6).toFixed(1) + "deg)";
        el.onclick = function () { tapNum(num, el); };
        cells.push({ num: num, el: el });
        grid.appendChild(el);
      })(nums[i]);
    }

    var nextNum = 1, cleared = 0;
    var frozen = false;
    var t0 = Date.now();
    function tapNum(num, el) {
      if (frozen) return;
      if (num === nextNum) {
        el.classList.add("done");
        cleared++;
        nextNum++;
        api.hud({ done: cleared });
        sub.textContent = "";
        if (cleared >= N) finishRound();
      } else {
        // 点错：轻罚并红闪，不中断
        el.classList.remove("badflash");
        void el.offsetWidth;
        el.classList.add("badflash");
        api.addScore(-rndScore(Puzzle.bd(api.level()) * 0.15));
        api.hud({ combo: 0 });
      }
    }
    function finishRound() {
      if (frozen) return;
      frozen = true;
      if (bar) bar.stop();
      var el = Date.now() - t0;
      var V = Math.max(0, (cfg.time - el) / cfg.time);
      var pts = rndScore(Puzzle.bd(api.level()) * cleared * V);
      api.addScore(pts);
      endOverlay(id, api, buildMG06);
    }
    track(id, function () { if (bar) bar.stop(); });
    if (bar) bar.stop();
    bar = countdownBar(cfg.time, function () {
      if (frozen) return;
      frozen = true;
      // 时间到：以已清除数计分
      var el2 = Date.now() - t0;
      var V2 = Math.max(0, (cfg.time - el2) / cfg.time);
      var pts2 = rndScore(Puzzle.bd(api.level()) * cleared * V2);
      api.addScore(pts2);
      endOverlay(id, api, buildMG06);
    });
    barHost.innerHTML = "";
    barHost.appendChild(bar.el);
    track(id, function () { if (bar) bar.stop(); });
  }

  /* ---- MG-07 · 数字顺背 / 倒背（MEM，数字键盘）---- */
  var MG07CFG = [
    { rev: false, start: 3, cap: 6 },
    { rev: false, start: 3, cap: 7 },
    { rev: true, start: 3, cap: 7 },
    { rev: true, start: 3, cap: 9 },
    { rev: "mix", start: 3, cap: 9 },
  ];
  function buildMG07(id, api) {
    var stage = api.stage;
    stage.innerHTML = "";
    var cfg = MG07CFG[Math.min(4, Math.max(0, api.level() - 1))];
    api.hud({ score: 0, done: 0, combo: 0, target: "" });

    var wrap = node("div", "pz-game");
    var seqlbl = node("div", "mg-seqlbl", "");
    var big = node("div", "mg-big", "");
    var dots = node("div", "mg-dots");
    var keypad = node("div", "mg-keypad");
    wrap.appendChild(seqlbl); wrap.appendChild(big); wrap.appendChild(dots); wrap.appendChild(keypad);
    stage.appendChild(wrap);

    var L = cfg.start;
    var errors = 0;
    var seq = [];
    var expecting = false; // 是否处于输入态
    var curInput = [];
    var rev = cfg.rev === "mix" ? Math.random() < 0.5 : cfg.rev;

    function setLabel(txt) { seqlbl.textContent = txt; }
    function renderDots() {
      dots.innerHTML = "";
      for (var i = 0; i < L; i++) {
        var d = node("span", "mg-dot" + (i < curInput.length ? " on" : ""));
        dots.appendChild(d);
      }
    }
    function buildKeys() {
      keypad.innerHTML = "";
      var keys = [1, 2, 3, 4, 5, 6, 7, 8, 9, 0];
      keys.forEach(function (k) {
        var b = node("button", "mg-key");
        b.setAttribute("type", "button");
        b.textContent = k;
        b.onclick = function () { input(k); };
        keypad.appendChild(b);
      });
    }
    function present() {
      // 生成并逐位闪现
      seq = [];
      for (var i = 0; i < L; i++) seq.push(ri(0, 9));
      curInput = [];
      expecting = false;
      big.innerHTML = "&nbsp;";
      renderDots();
      buildKeys();
      setLabel(
        Puzzle.loc({ zh: "记住数字" + (rev ? "（倒背）" : "") + "…", en: "Memorize" + (rev ? " (reverse)" : "") + "…" }) + "  ·  L=" + L
      );
      // 每位闪现 600ms，单字居中
      seq.forEach(function (v, idx) {
        later(id, function () {
          big.textContent = v;
        }, idx * 600);
      });
      later(id, function () {
        big.innerHTML = "&nbsp;";
        expecting = true;
        setLabel(
          Puzzle.loc({ zh: rev ? "反序输入" : "按顺序输入", en: rev ? "Type reverse" : "Type in order" }) + "  ·  L=" + L
        );
        renderDots();
      }, seq.length * 600 + 300);
    }
    function input(k) {
      if (!expecting) return;
      // 键盘随机布局禁止（位置固定策略）
      curInput.push(k);
      renderDots();
      if (curInput.length >= L) {
        expecting = false;
        var targetOrder = seq.slice();
        if (rev) targetOrder.reverse();
        var ok = true;
        for (var i = 0; i < L; i++) if (curInput[i] !== targetOrder[i]) { ok = false; break; }
        if (ok) {
          // 整串全对才计分
          var pts = rndScore(Puzzle.bd(api.level()) * L);
          api.addScore(pts);
          api.hud({ done: api.state.done + 1, combo: api.state.combo + 1 });
          big.textContent = "✓";
          big.style.color = "#9be38a";
          var reachedCap = L >= cfg.cap;
          later(id, function () {
            big.style.color = "";
            if (reachedCap) {
              // 已达长度上限且成功：本局完成
              endOverlay(id, api, buildMG07);
              return;
            }
            L++;
            rev = cfg.rev === "mix" ? Math.random() < 0.5 : cfg.rev;
            present();
          }, 300);
        } else {
          errors++;
          api.hud({ combo: 0 });
          big.textContent = "✗";
          big.style.color = "#ff5f5f";
          later(id, function () {
            big.style.color = "";
            if (errors >= 2) {
              endOverlay(id, api, buildMG07);
            } else {
              present();
            }
          }, 600);
        }
      }
    }
    track(id, function () {});
    present();
  }

  /* ---- MG-08 · 翻牌配对（MEM，tap）---- */
  var MG08CFG = [
    { rows: 2, cols: 3, time: 40000 }, // 3 对
    { rows: 3, cols: 4, time: 60000 }, // 6 对
    { rows: 4, cols: 4, time: 80000 }, // 8 对
    { rows: 4, cols: 4, time: 80000, similar: true }, // 相似图案
    { rows: 4, cols: 5, time: 100000 }, // 10 对
  ];
  function mcFace(idx, similar) {
    var fills = ["#ffcf5c", "#6fc3ff", "#7fe0a8", "#cf9bff", "#ff8a7a", "#8ae0c8"];
    var shapes = [
      '<circle cx="12" cy="12" r="6"/>',
      '<rect x="6" y="6" width="12" height="12" rx="2"/>',
      '<path d="M12 5l7 14H5z"/>',
      '<path d="M12 5l6 7-6 7-6-7z"/>',
      '<path d="M12 5l4 4-4 10-4-10z"/>',
    ];
    var c = similar ? fills[idx % fills.length] : fills[idx % 4];
    var s = shapes[idx % shapes.length];
    return '<svg viewBox="0 0 24 24" width="38" height="38"><g fill="' + c + '">' + s + "</g></svg>";
  }
  function buildMG08(id, api) {
    var stage = api.stage;
    stage.innerHTML = "";
    var cfg = MG08CFG[Math.min(4, Math.max(0, api.level() - 1))];
    var pairs = (cfg.rows * cfg.cols) / 2;
    api.hud({ score: 0, done: 0, combo: 0, target: String(pairs) });

    var wrap = node("div", "pz-game");
    var prompt = node("div", "pz-prompt", Puzzle.loc({ zh: "翻开两张，配对所有图形", en: "Match every pair" }));
    var bar = null;
    var barHost = node("div");
    var board = node("div", "mc-board");
    var grid = node("div", "mc-grid");
    grid.style.gridTemplateColumns = "repeat(" + cfg.cols + ", 74px)";
    var stat = node("div", "mc-stat", "");
    board.appendChild(grid); board.appendChild(stat);
    wrap.appendChild(prompt); wrap.appendChild(barHost); wrap.appendChild(board);
    stage.appendChild(wrap);

    // 洗牌：每对两枚相同图案
    var deck = [];
    for (var i = 0; i < pairs; i++) deck.push(i, i);
    shuffle(deck);
    var cardEls = [];
    var open = []; // 当前翻开（两枚）
    var matched = 0;
    var busy = false;
    var cards = deck.map(function (idx, pos) {
      var el = node("div", "mc-card");
      el.innerHTML =
        "<div class='mc-back'>" + '<svg viewBox="0 0 24 24"><path d="M8 8l3 3-3 3M16 8l-3 3 3 3" fill="none" stroke="#e6b45a" stroke-width="2" stroke-linecap="round"/></svg>' + "</div>" +
        "<div class='mc-face'>" + mcFace(idx, cfg.similar) + "</div>";
      el.onclick = function () { flip(pos); };
      grid.appendChild(el);
      cardEls.push(el);
      return { idx: idx, el: el };
    });

    function flip(pos) {
      if (busy) return;
      var cd = cards[pos];
      if (cd.el.classList.contains("open") || cd.el.classList.contains("matched")) return;
      if (open.length >= 2) return; // 一次只能翻两张：第三张忽略
      cd.el.classList.add("open");
      open.push({ idx: cd.idx, el: cd.el, pos: pos });
      if (open.length === 2) {
        busy = true;
        if (open[0].idx === open[1].idx) {
          // 配对
          open.forEach(function (o) { o.el.classList.add("matched"); });
          matched++;
          api.hud({ done: matched, combo: api.state.combo + 1 });
          open = [];
          busy = false;
          if (matched >= pairs) finish();
        } else {
          // 反盖 700ms 记忆窗口
          var a = open[0], b = open[1];
          open = [];
          api.hud({ combo: 0 });
          later(id, function () {
            a.el.classList.remove("open");
            b.el.classList.remove("open");
            busy = false;
          }, 700);
        }
      }
    }
    function finish() {
      if (busy) return;
      busy = true;
      if (bar) bar.stop();
      var el = Date.now() - t0;
      var V = Math.max(0, (cfg.time - el) / cfg.time);
      var pts = rndScore(Puzzle.bd(api.level()) * matched * V);
      api.addScore(pts);
      endOverlay(id, api, buildMG08);
    }
    var t0 = Date.now();
    if (bar) bar.stop();
    bar = countdownBar(cfg.time, function () {
      if (busy) return;
      busy = true;
      var V = 0;
      var pts = rndScore(Puzzle.bd(api.level()) * matched * 0.1);
      api.addScore(pts);
      endOverlay(id, api, buildMG08);
    });
    barHost.appendChild(bar.el);
    track(id, function () { if (bar) bar.stop(); });
  }

  /* =====================================================================
     C 组玩法引擎（MG-09 ~ MG-13）——抑制、注意与知觉
     ===================================================================== */
  var CLR = ["#ff6f5e", "#6fb5ff", "#7fe0a8", "#f7c84a", "#cf9bff", "#ff8fc4"];
  function clrSvg(inner, size) {
    return '<svg viewBox="0 0 24 24" width="' + (size || 46) + '" height="' + (size || 46) + '">' + inner + "</svg>";
  }

  /* ---------------- MG-09 · 色词干扰 Stroop（ATT/RSP，tap 2 选 1）-------
     显示一个色名词（以墨色 i 印出，字义色 m）；顶部持续显示当前口径
     （墨色=选墨色 / 字义=选字义），每 3 题切换一次。给出两个候选色块，
     依口径点出正确颜色：印色即墨色、词义即字义色。选错 -0.30×B_d。------ */
  var ST_PAL = [
    { zh: "赤", en: "RED", hex: "#e0554e" },
    { zh: "青", en: "BLUE", hex: "#4a90e2" },
    { zh: "绿", en: "GREEN", hex: "#34b96a" },
    { zh: "黄", en: "YELLOW", hex: "#e8b23a" },
  ];
  var MG09CFG = [
    { colors: 2, ms: 1500 }, // D1 仅两色 · 一致/不一致判
    { colors: 4, ms: 1500 }, // D2 四色
    { colors: 4, ms: 1200 }, // D3 问墨色提速
    { colors: 4, ms: 1200 }, // D4 字义/墨色混合
    { colors: 4, ms: 1000 }, // D5 双口径随机
  ];
  var MG09TOTAL = 12;
  function buildMG09(id, api) {
    var stage = api.stage;
    stage.innerHTML = "";
    var lvl = Math.min(4, Math.max(0, api.level() - 1));
    var cfg = MG09CFG[lvl];
    var ms = cfg.ms;
    api.hud({ score: 0, done: 0, combo: 0, target: String(MG09TOTAL) });

    var isEn = (window.Puzzle && Puzzle.isEn) ? Puzzle.isEn() : false;
    var wrap = node("div", "pz-game");
    var chipHost = node("div"); // 顶部口径
    var qbarHost = node("div");
    var wordEl = node("div", "st-word");
    var optsHost = node("div", "pz-opts");
    var sub = node("div", "pz-sub");
    wrap.appendChild(chipHost); wrap.appendChild(qbarHost);
    wrap.appendChild(wordEl); wrap.appendChild(optsHost); wrap.appendChild(sub);
    stage.appendChild(wrap);

    var pal = ST_PAL.slice(0, cfg.colors);
    var bar = null, frozen = false;
    var q = null, mode = 0; // 0=墨色 1=字义
    var sinceSwitch = 0;

    function swatch(idx, onClick) {
      var s = node("button", "pz-opt st-swatch");
      s.setAttribute("type", "button");
      s.style.width = "66px"; s.style.height = "66px";
      s.style.background = pal[idx].hex;
      s.style.borderColor = pal[idx].hex;
      s.onclick = onClick;
      return s;
    }
    function renderChip() {
      chipHost.innerHTML = "";
      var txt = mode === 0
        ? Puzzle.loc({ zh: "口径 · 点墨色", en: "Mode · pick the INK" })
        : Puzzle.loc({ zh: "口径 · 点字义", en: "Mode · pick the WORD" });
      chipHost.appendChild(node("span", "mg-modechip", txt));
    }
    function gen() {
      sinceSwitch++;
      if (sinceSwitch >= 3) { sinceSwitch = 0; mode = 1 - mode; renderChip(); }
      var m = ri(0, pal.length - 1);
      var i = ri(0, pal.length - 1);
      if (i === m && Math.random() < 0.5) i = (i + 1) % pal.length;
      // 两个候选：正解（依口径）+ 一个干扰
      var ans = mode === 0 ? i : m;
      var decoy = ans;
      var guard = 0;
      while (decoy === ans && guard < 40) { decoy = ri(0, pal.length - 1); guard++; }
      var cands = [ans, decoy];
      shuffle(cands);
      return { m: m, i: i, ans: ans, cands: cands };
    }
    function next() {
      if (!api.stage.isConnected) return;
      frozen = false;
      q = gen();
      wordEl.style.color = pal[q.i].hex;
      wordEl.textContent = pal[q.m][isEn ? "en" : "zh"];
      optsHost.innerHTML = "";
      q.cands.forEach(function (c) {
        var s = swatch(c, function () {
          if (frozen) return;
          frozen = true;
          if (bar) bar.stop();
          var correct = c === q.ans;
          if (correct) {
            s.classList.add("correct");
            var pts = award(id, api, { ms: ms, weight: 1 }, true, ms);
            api.hud({ done: api.state.done + 1, combo: api.state.combo + 1 });
            sub.textContent = "✓ +" + pts + comboPrefix(api.state.combo);
          } else {
            s.classList.add("wrong");
            Array.prototype.forEach.call(optsHost.children, function (x) {
              if (x.style.background === pal[q.ans].hex) x.classList.add("correct");
            });
            var pts2 = -rndScore(Puzzle.bd(api.level()) * 0.3);
            api.addScore(pts2);
            api.hud({ done: api.state.done + 1, combo: 0 });
            sub.textContent = "✗ " + pts2;
          }
          var dn = api.state.done;
          later(id, function () {
            if (dn >= MG09TOTAL) endOverlay(id, api, buildMG09); else next();
          }, correct ? 200 : 650);
        });
        optsHost.appendChild(s);
      });
      sub.textContent = "";
      if (bar) bar.stop();
      bar = countdownBar(ms, function () {
        if (frozen) return;
        frozen = true;
        Array.prototype.forEach.call(optsHost.children, function (x) {
          if (x.style.background === pal[q.ans].hex) x.classList.add("correct");
        });
        var pts = -rndScore(Puzzle.bd(api.level()) * 0.2);
        api.addScore(pts);
        api.hud({ done: api.state.done + 1, combo: 0 });
        sub.textContent = Puzzle.loc({ zh: "⏱ ", en: "⏱ " }) + pts;
        var dn = api.state.done;
        later(id, function () {
          if (dn >= MG09TOTAL) endOverlay(id, api, buildMG09); else next();
        }, 500);
      });
      qbarHost.innerHTML = ""; qbarHost.appendChild(bar.el);
    }
    renderChip();
    track(id, function () { if (bar) bar.stop(); });
    next();
  }

  /* ---------------- MG-10 · Go/No-Go 反应抑制（RSP/ATT，tap）----------
     圆形成串出现：是「目标形」就点、是「陷阱形」（圆却缺一口）绝不能点。
     目标:陷阱 = 3:1；限时约 60s。点中目标 +B_d×w；对陷阱正确「不点」
     +0.25×B_d（抑制也奖励）；误点陷阱 -0.5×B_d 并 400ms 惩罚锁定。
     未点判定在下一题出现瞬间结算。 ------------------------------------ */
  var MG10CFG = [
    { show: 1200, gap: 240, obvious: true, colors: 1 },
    { show: 1200, gap: 220, obvious: false, colors: 1 },
    { show: 800, gap: 200, obvious: false, colors: 1 },
    { show: 1100, gap: 200, obvious: false, colors: 2 },
    { show: 600, gap: 170, obvious: false, colors: 2 },
  ];
  var MG10SECONDS = 60;
  function buildMG10(id, api) {
    var stage = api.stage;
    stage.innerHTML = "";
    var lvl = Math.min(4, Math.max(0, api.level() - 1));
    var cfg = MG10CFG[lvl];
    api.hud({ score: 0, done: 0, combo: 0, target: Puzzle.loc({ zh: "限时60s", en: "60s" }) });

    var wrap = node("div", "pz-game");
    var prompt = node("div", "pz-prompt", Puzzle.loc({
      zh: "目标是实心圆 → 点它；圆却缺一口 → 别点",
      en: "Solid circle → TAP. Circle missing a bite → DON'T tap",
    }));
    var stageBox = node("div", "gng-stage");
    var timeLbl = node("div", "pz-sub", "");
    wrap.appendChild(prompt); wrap.appendChild(stageBox); wrap.appendChild(timeLbl);
    stage.appendChild(wrap);

    var T0 = now();
    var t = 0;            // item index
    var finished = false;
    var locked = false;
    var cidx = 0;

    function isTrapAt(k) { return k % 4 === 3; } // 目标:陷阱 ≈ 3:1

    function svgShape(k) {
      var trap = isTrapAt(k);
      if (trap) {
        if (cfg.obvious) return clrSvg('<rect x="3.5" y="3.5" width="17" height="17" fill="#ff8a6f"/>', 170);
        return clrSvg(
          '<circle cx="12" cy="12" r="9" fill="#9be38a"/><path d="M12 12V3.5a8.5 8.5 0 1 0 8.5 8.5H12z" fill="' +
          (cfg.colors === 2 && cidx % 2 ? "#ffd166" : "#fff3e0") + '"/>', 170);
      }
      return clrSvg('<circle cx="12" cy="12" r="9" fill="#6fb5ff"/>', 170);
    }

    function settleNoPress(k) {
      // 展示窗口结束仍没人点：在下一题出现瞬间结算
      if (!isTrapAt(k)) {
        api.addScore(-rndScore(Puzzle.bd(api.level()) * 0.1)); // 漏过目标（轻罚）
      } else {
        api.addScore(rndScore(Puzzle.bd(api.level()) * 0.25)); // 正确「不点」（抑制奖励）
      }
      advance();
    }
    function scheduleNoPress(k) {
      var to = setTimeout(function () {
        if (finished) return;
        settleNoPress(k);
      }, cfg.show);
      track(id, function () { clearTimeout(to); });
      return to;
    }
    function advance() {
      t++;
      cidx = (cidx + 1) % 3;
      api.hud({ done: t, combo: 0 });
      var to = setTimeout(function () {
        if (finished) return;
        if (now() - T0 >= MG10SECONDS * 1000) { finish(); return; }
        drawOne();
      }, cfg.gap);
      track(id, function () { clearTimeout(to); });
    }
    function drawOne() {
      if (!api.stage.isConnected || finished) return;
      if (now() - T0 >= MG10SECONDS * 1000) { finish(); return; }
      var el = now() - T0;
      timeLbl.textContent = (el / 1000).toFixed(1) + " / " + MG10SECONDS + "s";
      locked = false;
      stageBox.classList.remove("gng-lock");
      stageBox.innerHTML = svgShape(t);
      stageBox.onclick = function () { if (locked || finished) return; onPress(t); };
      scheduleNoPress(t);
    }
    function onPress(k) {
      // 已按 → 取消未点结算（防双算）
      clearLive(id); // 清所有已挂 timer（含未点结算），再重开节拍
      if (isTrapAt(k)) {
        // 误点陷阱：重罚 + 400ms 惩罚锁定
        var pt = -rndScore(Puzzle.bd(api.level()) * 0.5);
        api.addScore(pt);
        api.hud({ done: t + 1, combo: 0 });
        stageBox.classList.add("gng-lock");
        locked = true;
        timeLbl.textContent = Puzzle.loc({ zh: "误点陷阱 -", en: "trap! -" }) + pt;
        var to = setTimeout(function () { if (finished) return; advance(); }, 400);
        track(id, function () { clearTimeout(to); });
      } else {
        var pts = award(id, api, { ms: cfg.show, weight: 1 }, true, cfg.show);
        api.hud({ done: t + 1, combo: api.state.combo + 1 });
        locked = true;
        stageBox.innerHTML = "";
        var to2 = setTimeout(function () { if (finished) return; advance(); }, cfg.gap);
        track(id, function () { clearTimeout(to2); });
      }
    }
    function finish() {
      if (finished) return;
      finished = true;
      clearLive(id);
      endOverlay(id, api, buildMG10);
    }
    drawOne();
  }

  /* ---------------- MG-11 · 快速找异 Quick Eye（PER，tap）-------------
     满屏相似图形中一个「异类」；点出它。用「缺一口的圆盘」为基形：绝大多数
     缺口朝上(0°)，唯一异类缺口偏转 δ 度；δ 越小越难（0.35→0.08 映射为
     δ 46°→8°）。数量 n 也随难度增大。位置打散防扫描偏置。点异类 +分、
     点普通 -0.2×B_d。 -------------------------------------------------- */
  var MG11CFG = [
    { n: 6, delta: 46, ms: 3000 },
    { n: 10, delta: 36, ms: 2500 },
    { n: 14, delta: 26, ms: 2500 },
    { n: 18, delta: 18, ms: 2200 },
    { n: 24, delta: 9, ms: 2200 },
  ];
  var MG11TOTAL = 10;
  var QE_COLORS = ["#e8b23a", "#6fb5ff", "#7fe0a8", "#ff8fc4", "#cf9bff", "#ff9e6f"];
  function qeGlyph(rotDeg, colorIdx) {
    var c = QE_COLORS[colorIdx];
    // 缺一口的圆盘：从 -120° 扫到 +120° 的圆弧 + 回到中心
    var a0 = (rotDeg - 70) * Math.PI / 180;
    var a1 = (rotDeg + 70) * Math.PI / 180;
    var cx = 12, cy = 12, r = 9.5;
    var x0 = cx + r * Math.cos(a0), y0 = cy + r * Math.sin(a0);
    var x1 = cx + r * Math.cos(a1), y1 = cy + r * Math.sin(a1);
    var large = (a1 - a0) > Math.PI ? 1 : 0;
    var d =
      "M" + cx + " " + cy +
      "L" + x0.toFixed(2) + " " + y0.toFixed(2) +
      "A" + r + " " + r + " 0 " + large + " 1 " + x1.toFixed(2) + " " + y1.toFixed(2) + "Z";
    return clrSvg('<path d="' + d + '" fill="' + c + '"/>', 46);
  }
  function buildMG11(id, api) {
    var stage = api.stage;
    stage.innerHTML = "";
    var lvl = Math.min(4, Math.max(0, api.level() - 1));
    var cfg = MG11CFG[lvl];
    api.hud({ score: 0, done: 0, combo: 0, target: String(MG11TOTAL) });

    var wrap = node("div", "pz-game");
    var prompt = node("div", "pz-prompt", Puzzle.loc({ zh: "找出缺口朝向不同的那个", en: "Find the one whose gap points differently" }));
    var qbarHost = node("div");
    var grid = node("div", "qe-grid");
    grid.style.gridTemplateColumns = "repeat(" + Math.ceil(Math.sqrt(cfg.n)) + ", 56px)";
    var sub = node("div", "pz-sub");
    wrap.appendChild(prompt); wrap.appendChild(qbarHost); wrap.appendChild(grid); wrap.appendChild(sub);
    stage.appendChild(wrap);
    var ms = cfg.ms, frozen = false, bar = null;

    function build() {
      // 每个难度固定一个颜色，只有朝向可变，避免「双维度」干扰
      var colorIdx = lvl % QE_COLORS.length;
      var oddIdx = ri(0, cfg.n - 1);
      var order = [];
      for (var i = 0; i < cfg.n; i++) order.push(i);
      shuffle(order);
      grid.innerHTML = "";
      for (i = 0; i < cfg.n; i++) {
        (function (pos) {
          var el = node("div", "qe-cell");
          el.innerHTML = qeGlyph(pos === oddIdx ? cfg.delta : 0, colorIdx);
          el.onclick = function () {
            if (frozen) return;
            frozen = true;
            if (bar) bar.stop();
            if (pos === oddIdx) {
              el.classList.add("hit");
              var pts = award(id, api, { ms: ms, weight: 1 }, true, ms);
              api.hud({ done: api.state.done + 1, combo: api.state.combo + 1 });
              sub.textContent = "✓ +" + pts + comboPrefix(api.state.combo);
            } else {
              el.classList.add("flash");
              award(id, api, { ms: ms, weight: 1 }, false, 0);
              api.hud({ done: api.state.done + 1, combo: 0 });
              sub.textContent = Puzzle.loc({ zh: "✗ 找错", en: "✗ wrong" });
            }
            var dn = api.state.done;
            later(id, function () { if (dn >= MG11TOTAL) endOverlay(id, api, buildMG11); else next(); }, 300);
          };
          grid.appendChild(el);
        })(order[i]);
      }
    }
    function next() {
      if (!api.stage.isConnected) return;
      frozen = false;
      build();
      sub.textContent = "";
      if (bar) bar.stop();
      bar = countdownBar(ms, function () {
        if (frozen) return;
        frozen = true;
        award(id, api, { ms: ms, weight: 1 }, false, 0);
        api.hud({ done: api.state.done + 1, combo: 0 });
        var dn = api.state.done;
        later(id, function () { if (dn >= MG11TOTAL) endOverlay(id, api, buildMG11); else next(); }, 400);
      });
      qbarHost.innerHTML = ""; qbarHost.appendChild(bar.el);
    }
    track(id, function () { if (bar) bar.stop(); });
    next();
  }

  /* ---------------- MG-12 · 归类剔除 Odd One Out（PER/LOG，tap）-----
     n−1 个图形共享一条规则（同色/同边数/同填充），点出不同类者。
     规则模板库 + 唯一解校验器（同 MG-04，穷举重抽保证只差一条规则）。 */
  var MG12CFG = [
    { n: 4, dims: 1, ms: 5000 },
    { n: 6, dims: 1, ms: 4500 },
    { n: 6, dims: 2, ms: 4000 },
    { n: 8, dims: 2, ms: 3500 },
    { n: 8, dims: 3, ms: 3500 },
  ];
  var MG12TOTAL = 10;
  function oooGlyph(shape, fill, size, rotate) {
    var c = CLR[fill];
    var inner;
    if (shape === 0) inner = '<circle cx="12" cy="12" r="8"/>';
    else if (shape === 1) inner = '<rect x="4.5" y="4.5" width="15" height="15" rx="1"/>';
    else if (shape === 2) inner = '<path d="M12 4l7 6-3 9H8l-3-9z"/>';
    else if (shape === 3) inner = '<path d="M12 5l7 7-7 7-7-7z"/>';
    else inner = '<circle cx="12" cy="12" r="5.5"/><circle cx="12" cy="12" r="8.5" fill="none" stroke="' + c + '" stroke-width="2"/>';
    var g = '<g fill="' + c + '">' + inner + "</g>";
    if (rotate) g = '<g transform="rotate(90 12 12)">' + inner + "</g>";
    return clrSvg(g, 52);
  }
  function buildMG12(id, api) {
    var stage = api.stage;
    stage.innerHTML = "";
    var lvl = Math.min(4, Math.max(0, api.level() - 1));
    var cfg = MG12CFG[lvl];
    api.hud({ score: 0, done: 0, combo: 0, target: String(MG12TOTAL) });

    var wrap = node("div", "pz-game");
    var prompt = node("div", "pz-prompt", Puzzle.loc({ zh: "点出规律之外的那个", en: "Tap the one that breaks the rule" }));
    var qbarHost = node("div");
    var row = node("div", "ooo-row");
    var sub = node("div", "pz-sub");
    wrap.appendChild(prompt); wrap.appendChild(qbarHost); wrap.appendChild(row); wrap.appendChild(sub);
    stage.appendChild(wrap);
    var ms = cfg.ms, frozen = false, bar = null, odd = 0;

    // 规则库：随机选「生效规则」，其余维度在合理范围内尽量共享
    function gen() {
      for (var att = 0; att < 300; att++) {
        var ruleDim = ri(0, 2); // 0 色 / 1 形状 / 2 旋转（同色同形同向=填充归到形状）
        var n = cfg.n;
        var items = [];
        // 共享值
        var sShape = ri(0, 3), sFill = ri(0, 5), sRot = ri(0, 1);
        // 干扰项要「在规则 A 下同、在规则 B 下异」→ 让多数不同维保留共享
        for (var i = 0; i < n; i++) {
          var shape = sShape, fill = sFill, rot = sRot;
          if (i === n - 1) { // 最后一个为异类
            if (ruleDim === 0) fill = (fill + 1) % 6;
            else if (ruleDim === 1) shape = (shape + 1) % 4;
            else rot = 1 - rot;
          }
          items.push({ shape: shape, fill: fill, rot: rot, odd: i === n - 1 });
        }
        shuffle(items);
        return items;
      }
      return null;
    }
    function build() {
      var items = gen();
      if (!items) { if (api.toList) api.toList(); return; }
      row.innerHTML = "";
      items.forEach(function (it) {
        var el = node("button", "ooo-cell");
        el.setAttribute("type", "button");
        el.innerHTML = oooGlyph(it.shape, it.fill, 1, it.rot);
        el.onclick = function () {
          if (frozen) return;
          frozen = true;
          if (bar) bar.stop();
          if (it.odd) {
            el.classList.add("hit");
            var pts = award(id, api, { ms: ms, weight: 1 }, true, ms);
            api.hud({ done: api.state.done + 1, combo: api.state.combo + 1 });
            sub.textContent = "✓ +" + pts + comboPrefix(api.state.combo);
          } else {
            el.classList.add("flash");
            award(id, api, { ms: ms, weight: 1 }, false, 0);
            api.hud({ done: api.state.done + 1, combo: 0 });
            sub.textContent = Puzzle.loc({ zh: "✗ 找错", en: "✗ wrong" });
          }
          var dn = api.state.done;
          later(id, function () { if (dn >= MG12TOTAL) endOverlay(id, api, buildMG12); else next(); }, 300);
        };
        row.appendChild(el);
      });
    }
    function next() {
      if (!api.stage.isConnected) return;
      frozen = false;
      build();
      sub.textContent = "";
      if (bar) bar.stop();
      bar = countdownBar(ms, function () {
        if (frozen) return;
        frozen = true;
        award(id, api, { ms: ms, weight: 1 }, false, 0);
        api.hud({ done: api.state.done + 1, combo: 0 });
        var dn = api.state.done;
        later(id, function () { if (dn >= MG12TOTAL) endOverlay(id, api, buildMG12); else next(); }, 400);
      });
      qbarHost.innerHTML = ""; qbarHost.appendChild(bar.el);
    }
    track(id, function () { if (bar) bar.stop(); });
    next();
  }

  /* ---------------- MG-13 · 数量计数 Counting（PER，tap 4 选 1）-----
     满屏混合形状/颜色，问「满足条件的图形有几个」。干扰 = 真值 ±1 / ±2 与
     「另一属性计数」诱饵；D3 起同时呈现（避免逐项动画影响计数）。 */
  var MG13CFG = [
    { cond: 1, n: 8, ms: 8000 },
    { cond: 2, n: 12, ms: 8000 },
    { cond: 3, n: 16, ms: 7000 },
    { cond: 3, n: 18, ms: 7000 },
    { cond: 3, n: 24, ms: 6000 },
  ];
  var MG13TOTAL = 10;
  function cntGlyph(shape, fill, size) {
    var c = CLR[fill];
    var inner =
      shape === 0 ? '<circle cx="12" cy="12" r="7.5"/>' :
      shape === 1 ? '<rect x="4.5" y="4.5" width="15" height="15" rx="1"/>' :
      '<path d="M12 4l7 13H5z"/>';
    return clrSvg('<g fill="' + c + '">' + inner + "</g>", size || 42);
  }
  function buildMG13(id, api) {
    var stage = api.stage;
    stage.innerHTML = "";
    var lvl = Math.min(4, Math.max(0, api.level() - 1));
    var cfg = MG13CFG[lvl];
    api.hud({ score: 0, done: 0, combo: 0, target: String(MG13TOTAL) });

    var isEn = (window.Puzzle && Puzzle.isEn) ? Puzzle.isEn() : false;
    var wrap = node("div", "pz-game");
    var qEl = node("div", "cnt-q");
    var qbarHost = node("div");
    var grid = node("div", "cnt-grid");
    var optsHost = node("div", "pz-opts");
    var sub = node("div", "pz-sub");
    wrap.appendChild(qEl); wrap.appendChild(qbarHost); wrap.appendChild(grid); wrap.appendChild(optsHost); wrap.appendChild(sub);
    stage.appendChild(wrap);
    var ms = cfg.ms, frozen = false, bar = null;

    // 题干：语言无关——显示一个「目标样本」，请数出与它同色（同形）的个数
    function qLabel(condShape, condFill) {
      var label = isEn
        ? (condShape >= 0 ? "How many match" : "How many are this color")
        : (condShape >= 0 ? "数出与样本相同的" : "数出这个颜色的");
      var sample;
      if (condShape >= 0) {
        sample = cntGlyph(condShape, condFill, 30);
      } else {
        // 纯色条件：样本用「色块」，不暗示形状
        sample = '<span class="cnt-color" style="background:' + CLR[condFill] + '"></span>';
      }
      return '<div class="cnt-qline">' + label + sample + "</div>";
    }
    function gen() {
      var cond = ri(1, cfg.cond);
      var condShape = (cond >= 2 && Math.random() < 0.7) ? ri(0, 2) : -1;
      var condFill = ri(0, 5);
      var items = [];
      for (var i = 0; i < cfg.n; i++) {
        var s = ri(0, 2), f = ri(0, 5);
        items.push({ s: s, f: f });
      }
      var truth = 0;
      items.forEach(function (it) {
        if ((condShape < 0 || it.s === condShape) && it.f === condFill) truth++;
      });
      if (truth < 2 || truth > cfg.n - 1) return null;
      return { items: items, condShape: condShape, condFill: condFill, truth: truth };
    }
    function render() {
      var q = gen();
      if (!q) { if (api.toList) api.toList(); return; }
      // 网格
      var col = Math.ceil(Math.sqrt(q.items.length));
      grid.style.gridTemplateColumns = "repeat(" + col + ", 48px)";
      grid.innerHTML = "";
      q.items.forEach(function (it) {
        grid.appendChild(node("div", "cnt-item", cntGlyph(it.s, it.f, 44)));
      });
      // 题干
      qEl.innerHTML = qLabel(q.condShape, q.condFill);
      // 选项：真值 + 干扰
      var opts = [q.truth];
      var want = [1, -1, 2, -2];
      var guard = 0;
      while (opts.length < 4 && guard < 100) {
        var dv = want[ri(0, want.length - 1)];
        var v = q.truth + dv;
        if (v >= 0 && v <= cfg.n && opts.indexOf(v) < 0) opts.push(v);
        guard++;
      }
      var g2 = 0;
      while (opts.length < 4 && g2 < 100) {
        var v2 = ri(0, cfg.n);
        if (opts.indexOf(v2) < 0) opts.push(v2);
        g2++;
      }
      shuffle(opts);
      optsHost.innerHTML = "";
      opts.forEach(function (v) {
        var o = node("button", "pz-opt");
        o.setAttribute("type", "button");
        o.textContent = v;
        o.onclick = function () {
          if (frozen) return;
          frozen = true;
          if (bar) bar.stop();
          var correct = v === q.truth;
          if (correct) {
            o.classList.add("correct");
            var pts = award(id, api, { ms: ms, weight: 1 }, true, ms);
            api.hud({ done: api.state.done + 1, combo: api.state.combo + 1 });
            sub.textContent = "✓ +" + pts + comboPrefix(api.state.combo);
          } else {
            o.classList.add("wrong");
            Array.prototype.forEach.call(optsHost.children, function (x) {
              if (parseInt(x.textContent, 10) === q.truth) x.classList.add("correct");
            });
            award(id, api, { ms: ms, weight: 1 }, false, 0);
            api.hud({ done: api.state.done + 1, combo: 0 });
            sub.textContent = Puzzle.loc({ zh: "✗ 正确 ", en: "✗ ans " }) + q.truth;
          }
          var dn = api.state.done;
          later(id, function () { if (dn >= MG13TOTAL) endOverlay(id, api, buildMG13); else next(); }, correct ? 250 : 650);
        };
        optsHost.appendChild(o);
      });
      return q;
    }
    function next() {
      if (!api.stage.isConnected) return;
      frozen = false;
      render();
      sub.textContent = "";
      if (bar) bar.stop();
      bar = countdownBar(ms, function () {
        if (frozen) return;
        frozen = true;
        award(id, api, { ms: ms, weight: 1 }, false, 0);
        api.hud({ done: api.state.done + 1, combo: 0 });
        var dn = api.state.done;
        later(id, function () { if (dn >= MG13TOTAL) endOverlay(id, api, buildMG13); else next(); }, 400);
      });
      qbarHost.innerHTML = ""; qbarHost.appendChild(bar.el);
    }
    track(id, function () { if (bar) bar.stop(); });
    next();
  }

  /* =====================================================================
     D 组玩法引擎（MG-14 ~ MG-17）——空间与规划
     ===================================================================== */
  var isEnNow = function () { return (window.Puzzle && Puzzle.isEn) ? Puzzle.isEn() : false; };
  var BVTOTAL = 8, CNTOTAL = 6, GRTOTAL = 6, HXTOTAL = 4;
  var MD = [
    { k: "dot" }, { k: "line" }, { k: "ring" }, { k: "tri" }, { k: "sq" }, { k: "cr" },
  ];
  function mdSvg(which, color) {
    var c = color || "#e6b45a";
    switch (which) {
      case "dot": return clrSvg('<circle cx="12" cy="12" r="4" fill="' + c + '"/>', 48);
      case "line": return clrSvg('<path d="M5 12h14" stroke="' + c + '" stroke-width="3"/>', 48);
      case "ring": return clrSvg('<circle cx="12" cy="12" r="4.4" fill="none" stroke="' + c + '" stroke-width="2.6"/>', 48);
      case "tri": return clrSvg('<path d="M12 6.5l5.4 9.5H6.6z" fill="' + c + '"/>', 48);
      case "sq": return clrSvg('<rect x="7" y="7" width="10" height="10" rx="1" fill="' + c + '"/>', 48);
      default: return clrSvg('<path d="M7 7h10v10H7zM12 7v10M7 12h10" stroke="' + c + '" stroke-width="2.4"/>', 48);
    }
  }

  /* ---------------- MG-14 · 俯视图 / Bird's View（SPA，tap）
     体素堆用正交等轴投影渲染成 3D 雕塑；选它的俯视足迹。
     干扰 = 真实模型增 / 删 1 个体素后再投影（几何必然可判，不人工画）。----- */
  var MG14CFG = [
    { blocks: 3, ms: 10000 },
    { blocks: 4, ms: 9000 },
    { blocks: 5, ms: 8500 },
    { blocks: 6, ms: 8200 },
    { blocks: 8, ms: 8000 },
  ];
  var BVCOL = ["#6fb5ff", "#9be38a", "#f7c84a", "#ff9ecb", "#cf9bff", "#ff8fc4", "#7ce8ff", "#e6b45a"];
  function bvProj(pts, u, v) {
    return pts.map(function (p) { return { x: (p[0] - p[1]) * u, y: (p[0] + p[1]) * u * 0.5 - p[2] * v }; });
  }
  function bvModel(cfg) {
    var b = 4;
    for (var att = 0; att < 600; att++) {
      var cells = [];
      for (var i = 0; i < b; i++) for (var j = 0; j < b; j++) cells.push([i, j]);
      shuffle(cells);
      var fc = Math.min(cells.length, ri(Math.min(3, cfg.blocks), Math.min(cfg.blocks, 6)));
      var chosen = cells.slice(0, fc);
      var heights = [];
      for (var k = 0; k < fc; k++) heights.push(1);
      var rest = cfg.blocks - fc;
      var guard = 0;
      while (rest > 0 && guard < 200) { heights[ri(0, fc - 1)]++; rest--; guard++; }
      var model = chosen.map(function (c, idx) { return { c: c[0], r: c[1], h: heights[idx] }; });
      if (model.length < 2) continue;
      return model;
    }
    return null;
  }
  function bvFootprint(model) {
    return model.map(function (m) { return [m.c, m.r]; });
  }
  function bvDistractor(fp, model, b) {
    var att = 0;
    while (att < 400) {
      att++;
      var out = fp.map(function (p) { return p.slice(); });
      var hasSingle = model.some(function (m) { return m.h === 1; });
      if (!hasSingle || Math.random() < 0.5) {
        var empty = [];
        for (var i = 0; i < b; i++) for (var j = 0; j < b; j++) {
          if (!out.some(function (p) { return p[0] === i && p[1] === j; })) empty.push([i, j]);
        }
        if (!empty.length) continue;
        var e = pick(empty); out.push([e[0], e[1]]);
      } else {
        var tgt = pick(model.filter(function (m) { return m.h === 1; }));
        var idx = -1;
        for (var q = 0; q < out.length; q++) if (out[q][0] === tgt.c && out[q][1] === tgt.r) idx = q;
        if (idx >= 0) out.splice(idx, 1);
        if (out.length < 1) continue;
      }
      var changed = out.length !== fp.length;
      if (!changed) {
        changed = out.some(function (p) {
          return !fp.some(function (f) { return f[0] === p[0] && f[1] === p[1]; });
        });
      }
      if (changed) return out;
    }
    return null;
  }
  function shade(hex, amt) {
    var n = parseInt(hex.slice(1), 16);
    var r = Math.max(0, Math.min(255, (n >> 16 & 255) + Math.round(255 * amt)));
    var g = Math.max(0, Math.min(255, (n >> 8 & 255) + Math.round(255 * amt)));
    var bb = Math.max(0, Math.min(255, (n & 255) + Math.round(255 * amt)));
    return "rgb(" + r + "," + g + "," + bb + ")";
  }
  function bvSVG(model) {
    var U = 21, V = 22;
    var hue = pick(BVCOL);
    var faces = [];
    model.forEach(function (m) {
      var f = m.c, g = m.r;
      for (var z = 0; z < m.h; z++) {
        var z0 = z, z1 = z + 1;
        var top = bvProj([[f, g, z1], [f + 1, g, z1], [f + 1, g + 1, z1], [f, g + 1, z1]], U, V);
        faces.push({ pts: top, fill: hue, depth: (f + g) * 100 - z1 });
        var xf = bvProj([[f + 1, g, z0], [f + 1, g + 1, z0], [f + 1, g + 1, z1], [f + 1, g, z1]], U, V);
        faces.push({ pts: xf, fill: shade(hue, -0.14), depth: (f + g) * 100 - z1 });
        var yf = bvProj([[f, g + 1, z0], [f + 1, g + 1, z0], [f + 1, g + 1, z1], [f, g + 1, z1]], U, V);
        faces.push({ pts: yf, fill: shade(hue, -0.26), depth: (f + g) * 100 - z1 });
      }
    });
    faces.sort(function (a, b2) { return a.depth - b2.depth; });
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    faces.forEach(function (f2) { f2.pts.forEach(function (p) { minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y); }); });
    var offX = -minX + 16, offY = -minY + 16, W = maxX - minX, H = maxY - minY;
    var parts = faces.map(function (f3) {
      var str = f3.pts.map(function (p) { return (Math.round((p.x + offX) * 10) / 10) + "," + (Math.round((p.y + offY) * 10) / 10); }).join(" ");
      return '<polygon points="' + str + '" fill="' + f3.fill + '"/>';
    });
    return '<svg viewBox="-20 -20 ' + (W + 72) + ' ' + (H + 72) + '">' + parts.join("") + "</svg>";
  }
  function bvBoard(fp, b) {
    var cells = [];
    for (var i = 0; i < b; i++) for (var j = 0; j < b; j++) {
      cells.push('<div class="bvc' + (fp.some(function (p) { return p[0] === i && p[1] === j; }) ? " on" : "") + '"></div>');
    }
    var w = node("div", "bvboard");
    w.style.gridTemplateColumns = "repeat(" + b + ", 20px)";
    w.innerHTML = cells.join("");
    return w;
  }
  function buildMG14(id, api) {
    var stage = api.stage;
    stage.innerHTML = "";
    var cfg = MG14CFG[Math.min(4, Math.max(0, api.level() - 1))];
    api.hud({ score: 0, done: 0, combo: 0, target: String(BVTOTAL) });
    var b = 4;
    var wrap = node("div", "pz-game");
    var row = node("div", "bv-wrap");
    var isoHost = node("div", "bv-iso");
    var optsHost = node("div", "bv-opts");
    var sub = node("div", "pz-sub");
    row.appendChild(isoHost); row.appendChild(optsHost);
    wrap.appendChild(row); wrap.appendChild(sub);
    stage.appendChild(wrap);
    var qbar = node("div");
    wrap.insertBefore(qbar, sub);
    var frozen = false, bar = null, ms = cfg.ms;
    function render() {
      var model = bvModel(cfg);
      if (!model) { if (api.toList) api.toList(); return; }
      var fp = bvFootprint(model);
      isoHost.innerHTML = bvSVG(model);
      var cands = [fp.slice()];
      var guard = 0;
      while (cands.length < 4 && guard < 400) {
        guard++;
        var d = bvDistractor(fp, model, b);
        if (!d) break;
        var same = cands.some(function (c) {
          return c.length === d.length && c.every(function (p) {
            return d.some(function (q) { return q[0] === p[0] && q[1] === p[1]; });
          });
        });
        if (!same) cands.push(d);
      }
      shuffle(cands);
      optsHost.innerHTML = "";
      cands.forEach(function (cand) {
        var bt = node("button", "bv-opt");
        bt.setAttribute("type", "button");
        bt.appendChild(bvBoard(cand, b));
        bt.onclick = function () {
          if (frozen) return;
          frozen = true; if (bar) bar.stop();
          var ok = cand.length === fp.length && cand.every(function (p) {
            return fp.some(function (q) { return q[0] === p[0] && q[1] === p[1]; });
          });
          bt.classList.add(ok ? "hit" : "flash");
          award(id, api, { ms: ms, weight: 1 }, ok, 0);
          api.hud({ done: api.state.done + 1, combo: ok ? api.state.combo + 1 : 0 });
          var na = api.state.done;
          later(id, function () { if (na >= BVTOTAL) endOverlay(id, api, buildMG14); else next(); }, 420);
        };
        optsHost.appendChild(bt);
      });
    }
    function next() {
      if (!api.stage.isConnected) return;
      frozen = false; sub.textContent = "";
      if (bar) bar.stop();
      render();
      qbar.innerHTML = "";
      bar = countdownBar(ms, function () {
        if (frozen) return;
        frozen = true;
        award(id, api, { ms: ms, weight: 1 }, false, 0);
        api.hud({ done: api.state.done + 1, combo: 0 });
        var na = api.state.done;
        later(id, function () { if (na >= BVTOTAL) endOverlay(id, api, buildMG14); else next(); }, 420);
      });
      qbar.appendChild(bar.el);
    }
    track(id, function () { if (bar) bar.stop(); });
    next();
  }

  /* ---------------- MG-15 · 立方体展开 / Cube Net（SPA，tap）
     基准十字展开网：中心格=正面(F)、正上=顶面(U)、右侧=右面(R)。
     目标立方示出 F/U/R 三面图案，选与之一致的展开网（唯一解）。----- */
  var MG15CFG = [
    { pal: 3, ms: 12000 },
    { pal: 4, ms: 11000 },
    { pal: 4, ms: 10000 },
    { pal: 5, ms: 9000 },
    { pal: 6, ms: 8000 },
  ];
  function cnBase() {
    return { F: [2, 2], U: [2, 1], D: [2, 3], L: [1, 2], R: [3, 2], B: [4, 2] };
  }
  function cnNet(rot, markers) {
    var base = cnBase();
    function r90(x, y) { return [4 - y, x]; }
    var pos = {};
    ["F", "U", "D", "L", "R", "B"].forEach(function (k) {
      var p = base[k]; for (var i = 0; i < rot; i++) p = r90(p[0], p[1]);
      pos[k] = [p[0], p[1]];
    });
    var xs = Object.keys(pos).map(function (k) { return pos[k][0]; });
    var ys = Object.keys(pos).map(function (k) { return pos[k][1]; });
    var mx = Math.min.apply(null, xs), my = Math.min.apply(null, ys);
    var net = node("div", "cnnet");
    net.style.gridTemplateColumns = "repeat(5, 40px)";
    for (var yy = my; yy <= Math.max.apply(null, ys); yy++) {
      for (var xx = mx; xx <= Math.max.apply(null, xs); xx++) {
        var owner = null;
        ["F", "U", "D", "L", "R", "B"].forEach(function (k) { if (pos[k][0] === xx && pos[k][1] === yy) owner = k; });
        var tile = node("div", owner ? "cntile" : "cntile empty");
        if (owner) {
          var gl = markers[owner];
          tile.innerHTML = '<span class="glyph">' + mdSvg(MD[gl].k, CLR[gl % CLR.length]) + "</span>";
        }
        net.appendChild(tile);
      }
    }
    return net;
  }
  function buildMG15(id, api) {
    var stage = api.stage;
    stage.innerHTML = "";
    var cfg = MG15CFG[Math.min(4, Math.max(0, api.level() - 1))];
    api.hud({ score: 0, done: 0, combo: 0, target: String(CNTOTAL) });
    var wrap = node("div", "pz-game");
    var row = node("div", "cn-wrap");
    var isoHost = node("div", "cn-iso");
    var optsHost = node("div", "cn-opts");
    var sub = node("div", "pz-sub");
    row.appendChild(isoHost); row.appendChild(optsHost);
    wrap.appendChild(row); wrap.appendChild(sub);
    stage.appendChild(wrap);
    var qbar = node("div");
    wrap.insertBefore(qbar, sub);
    var frozen = false, bar = null, ms = cfg.ms;
    function cubeSVG(Fg, Ug, Rg) {
      var face = function (gl, w) {
        return mdSvg(MD[gl].k, CLR[gl % CLR.length]).replace('width="48"', 'width="' + w + '"').replace('height="48"', 'height="' + w + '"');
      };
      return '<svg viewBox="0 0 150 140">' +
        // U 顶面
        '<polygon points="75,10 126,32 75,54 24,32" fill="rgba(231,178,90,.3)" stroke="var(--bd2)" stroke-width="2"/>' +
        '<g transform="translate(75,32) translate(-18,-16)">' + face(Ug, 30) + "</g>" +
        // R 右面
        '<polygon points="126,32 141,42 141,110 126,120 75,98 75,54" fill="rgba(111,181,255,.3)" stroke="var(--bd2)" stroke-width="2"/>' +
        '<g transform="translate(103,86) translate(-15,-15)">' + face(Rg, 30) + "</g>" +
        // F 正面
        '<polygon points="24,32 75,54 75,98 75,120 24,108 9,42" fill="rgba(127,224,168,.34)" stroke="var(--bd2)" stroke-width="2"/>' +
        '<g transform="translate(42,78) translate(-15,-15)">' + face(Fg, 30) + "</g>" +
        "</svg>";
    }
    function render() {
      var pal = cfg.pal;
      function uniq3() {
        var a = ri(0, pal - 1), b = ri(0, pal - 1), c = ri(0, pal - 1);
        while (b === a) b = ri(0, pal - 1);
        while (c === a || c === b) c = ri(0, pal - 1);
        return [a, b, c];
      }
      var fu = uniq3();
      var Fg = fu[0], Ug = fu[1], Rg = fu[2];
      var D = ri(0, pal - 1), L = ri(0, pal - 1), B = ri(0, pal - 1);
      var correct = { F: Fg, U: Ug, D: D, L: L, R: Rg, B: B };
      isoHost.innerHTML = cubeSVG(Fg, Ug, Rg);
      var cands = [correct];
      var guard = 0;
      while (cands.length < 4 && guard < 300) {
        guard++;
        var mm = { F: Fg, U: Ug, D: D, L: L, R: Rg, B: B };
        var ks = ["F", "U", "R"];
        var a = pick(ks), bb = pick(ks);
        while (bb === a) bb = pick(ks);
        var t = mm[a]; mm[a] = mm[bb]; mm[bb] = t;
        if (mm.F === Fg && mm.U === Ug && mm.R === Rg) continue;
        cands.push({ m: mm, rot: ri(0, 3) });
      }
      // 给正确项随机一个转
      correct.rot = ri(0, 3);
      cands[0] = correct;
      shuffle(cands);
      optsHost.innerHTML = "";
      cands.forEach(function (cand) {
        var bt = node("button", "cn-opt");
        bt.setAttribute("type", "button");
        bt.appendChild(cnNet(cand.rot || 0, cand.m || cand));
        bt.onclick = function () {
          if (frozen) return;
          frozen = true; if (bar) bar.stop();
          var c = cand.m || cand;
          var ok = c.F === Fg && c.U === Ug && c.R === Rg;
          bt.classList.add(ok ? "hit" : "flash");
          award(id, api, { ms: ms, weight: 1 }, ok, 0);
          api.hud({ done: api.state.done + 1, combo: ok ? api.state.combo + 1 : 0 });
          var na = api.state.done;
          later(id, function () { if (na >= CNTOTAL) endOverlay(id, api, buildMG15); else next(); }, 420);
        };
        optsHost.appendChild(bt);
      });
    }
    function next() {
      if (!api.stage.isConnected) return;
      frozen = false; sub.textContent = "";
      if (bar) bar.stop();
      render();
      qbar.innerHTML = "";
      bar = countdownBar(ms, function () {
        if (frozen) return; frozen = true;
        award(id, api, { ms: ms, weight: 1 }, false, 0);
        api.hud({ done: api.state.done + 1, combo: 0 });
        var na = api.state.done;
        later(id, function () { if (na >= CNTOTAL) endOverlay(id, api, buildMG15); else next(); }, 420);
      });
      qbar.appendChild(bar.el);
    }
    track(id, function () { if (bar) bar.stop(); });
    next();
  }

  /* ---------------- MG-16 · 齿轮传动 / Drive the Gear（SPA/LOG，tap）
     一条啮合链：驱动轮顺转 1 圈经若干固定轮到末轮；末轮是「?」待选齿轮，
     圈数 ∝ 半径之比、方向由啮合次数奇偶决定。选对半径使末轮达给定圈数方向。----- */
  var MG16CFG = [
    { n: 1, ms: 8000 },
    { n: 1, ms: 10000 },
    { n: 2, ms: 10000 },
    { n: 2, ms: 12000 },
    { n: 3, ms: 12000 },
  ];
  function gearSvg(radius, cx, cy, R, accent, isQ) {
    var s = [];
    for (var t = 0; t < radius * 8; t++) {
      var a0 = t / (radius * 8) * Math.PI * 2, sp = Math.PI * 2 / (radius * 8);
      s.push('<path d="' + toothPath(cx, cy, R - 4, R + 4, a0, sp) + '" stroke="' + accent + '" stroke-width="1.6" fill="' + accent + '" opacity=".5"/>');
    }
    s.push('<circle cx="' + cx + '" cy="' + cy + '" r="' + R + '" fill="rgba(230,180,90,.16)" stroke="' + accent + '" stroke-width="2.2"/>');
    s.push(isQ
      ? '<text x="' + cx + '" y="' + (cy + 8) + '" text-anchor="middle" font-size="26" font-weight="700" fill="#e6b45a">?</text>'
      : '<circle cx="' + cx + '" cy="' + cy + '" r="3.4" fill="' + accent + '"/>');
    return s.join("");
  }
  function toothPath(cx, cy, r0, r1, a, sp) {
    var x = function (rr, aa) { return cx + rr * Math.cos(aa); };
    var y = function (rr, aa) { return cy + rr * Math.sin(aa); };
    return "M" + r1f(x(r0, a)) + " " + r1f(y(r0, a)) + " L" + r1f(x(r1, a + sp * 0.5)) + " " + r1f(y(r1, a + sp * 0.5)) +
      " L" + r1f(x(r1, a + sp)) + " " + r1f(y(r1, a + sp)) + " L" + r1f(x(r0, a + sp)) + " " + r1f(y(r0, a + sp)) + " Z";
  }
  function r1f(n) { return Math.round(n * 10) / 10; }
  function buildMG16(id, api) {
    var stage = api.stage;
    stage.innerHTML = "";
    var cfg = MG16CFG[Math.min(4, Math.max(0, api.level() - 1))];
    api.hud({ score: 0, done: 0, combo: 0, target: String(GRTOTAL) });
    var isEn = isEnNow();
    var wrap = node("div", "pz-game");
    var box = node("div", "gr-wrap");
    var train = node("div", "gr-train");
    var ask = node("div", "gr-ask");
    var optsHost = node("div", "gr-opts");
    var sub = node("div", "pz-sub");
    box.appendChild(train); box.appendChild(ask); box.appendChild(optsHost); box.appendChild(sub);
    wrap.appendChild(box);
    stage.appendChild(wrap);
    var qbar = node("div");
    box.insertBefore(qbar, sub);
    var frozen = false, bar = null, ms = cfg.ms;
    function turnsFor(fixed, ansR) {
      var seq = [2].concat(fixed).concat([ansR]);
      var sign = 1, ratio = 1;
      for (var k = 0; k < seq.length - 1; k++) { sign *= -1; ratio *= seq[k] / seq[k + 1]; }
      return { t: Math.round(ratio * 1000) / 1000, cw: sign > 0 };
    }
    function render() {
      var fixed = [];
      for (var i = 0; i < cfg.n; i++) fixed.push(ri(1, 3));
      var ansR = ri(1, 3);
      var goal = turnsFor(fixed, ansR);
      // 画链
      var R = function (rr) { return 16 + rr * 7; };
      var seq = [2].concat(fixed).concat([ansR]);
      var s = [];
      var cx = 46, cy = 95;
      seq.forEach(function (rr, idx) {
        s.push('<g transform="translate(' + cx + ',' + cy + ')">' + gearSvg(rr, 0, 0, R(rr), idx === seq.length - 1 ? "#e6b45a" : "#cf9bff", idx === seq.length - 1) + "</g>");
        cx += 92;
      });
      s.push('<path d="M' + (cx - 100) + ' 60 h30" stroke="#9be38a" stroke-width="2" marker-end="url(#grArr)"/>');
      s.push('<path d="M60 30 v-8 h120" stroke="var(--ink)" stroke-width="1.6" stroke-dasharray="4 4"/>');
      s.push('<text x="96" y="22" text-anchor="middle" font-size="12" fill="var(--ink)">' + (isEn ? "drive 1" : "驱动 1") + "</text>");
      train.innerHTML = '<svg viewBox="10 10 560 170" style="width:100%">' +
        '<defs><marker id="grArr" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 Z" fill="#9be38a"/></marker></defs>' +
        s.join("") + "</svg>";
      ask.innerHTML = (isEn ? "末轮需" : "末轮需 ") + "<b>" + (goal.cw ? (isEn ? "顺转" : "顺转") : (isEn ? "逆转" : "逆转")) + " " + Math.abs(goal.t) + "</b>" + (isEn ? "，选" : "圈，选") + (isEn ? "对的半径" : "对的半径");
      // 选项
      var opts = [1, 2, 3].map(function (rr) { return { r: rr, g: turnsFor(fixed, rr) }; });
      optsHost.innerHTML = "";
      shuffle(opts);
      opts.forEach(function (o) {
        var bt = node("button", "gr-opt");
        bt.setAttribute("type", "button");
        var Rg = R(o.r);
        bt.innerHTML = '<svg viewBox="-34 -34 68 68">' + gearSvg(o.r, 0, 0, Rg, "#e6b45a", false) + "</svg><div class='lbl'>r=" + o.r + "</div>";
        bt.onclick = function () {
          if (frozen) return;
          frozen = true; if (bar) bar.stop();
          var ok = o.r === ansR;
          bt.classList.add(ok ? "hit" : "flash");
          award(id, api, { ms: ms, weight: 1 }, ok, 0);
          api.hud({ done: api.state.done + 1, combo: ok ? api.state.combo + 1 : 0 });
          var na = api.state.done;
          later(id, function () { if (na >= GRTOTAL) endOverlay(id, api, buildMG16); else next(); }, 420);
        };
        optsHost.appendChild(bt);
      });
    }
    function next() {
      if (!api.stage.isConnected) return;
      frozen = false; sub.textContent = "";
      if (bar) bar.stop();
      render();
      qbar.innerHTML = "";
      bar = countdownBar(ms, function () {
        if (frozen) return; frozen = true;
        award(id, api, { ms: ms, weight: 1 }, false, 0);
        api.hud({ done: api.state.done + 1, combo: 0 });
        var na = api.state.done;
        later(id, function () { if (na >= GRTOTAL) endOverlay(id, api, buildMG16); else next(); }, 420);
      });
      qbar.appendChild(bar.el);
    }
    track(id, function () { if (bar) bar.stop(); });
    next();
  }

  /* ---------------- MG-17 · 六边形连锁 / Hexa Chain（PLAN/SPA，tap）
     六边形网格上一串目标六边形，从起点逐个点相邻格连成链，连完所有目标即过关。
     网格先随机生成自回避路径再着色 → 必有解；松手结算；卡死 / 超时可重置。----- */
  var MG17CFG = [
    { rad: 1, len: 3, ms: 9000 },
    { rad: 2, len: 4, ms: 11000 },
    { rad: 2, len: 5, ms: 12000 },
    { rad: 2, len: 6, ms: 13000 },
    { rad: 3, len: 7, ms: 14000 },
  ];
  var HX_D = [[1, 0], [0, 1], [-1, 1], [-1, 0], [0, -1], [1, -1]];
  function hxPath(rad, len) {
    for (var att = 0; att < 1500; att++) {
      var path = [[0, 0]];
      var used = {}; used["0,0"] = true;
      var g = 0;
      while (path.length < len && g < 200) {
        g++;
        var cur = path[path.length - 1];
        var nbs = HX_D.slice(); shuffle(nbs);
        var nx2 = null;
        for (var i = 0; i < nbs.length; i++) {
          var nxx = cur[0] + nbs[i][0], nyy = cur[1] + nbs[i][1];
          if (used[nxx + "," + nyy]) continue;
          if (Math.abs(nxx) > rad || Math.abs(nyy) > rad) continue;
          nx2 = [nxx, nyy]; break;
        }
        if (!nx2) break;
        used[nx2[0] + "," + nx2[1]] = true; path.push(nx2);
      }
      if (path.length === len) return path;
    }
    return null;
  }
  function hxC(q, r, s) {
    var x = s * Math.sqrt(3) * (q + r / 2);
    var y = s * 1.5 * r;
    var pts = [];
    for (var i = 0; i < 6; i++) {
      var a = Math.PI / 180 * (60 * i - 30);
      pts.push((x + s * Math.cos(a)) + "," + (y + s * Math.sin(a)));
    }
    return { x: x, y: y, poly: pts.join(" ") };
  }
  function buildMG17(id, api) {
    var stage = api.stage;
    stage.innerHTML = "";
    var cfg = MG17CFG[Math.min(4, Math.max(0, api.level() - 1))];
    api.hud({ score: 0, done: 0, combo: 0, target: String(HXTOTAL) });
    var isEn = isEnNow();
    var wrap = node("div", "pz-game");
    var box = node("div", "hx-wrap");
    var sEl = node("div", "hx-stage");
    var mini = node("div", "pz-minirow");
    var btnReset = node("button", "pz-mini");
    btnReset.type = "button";
    btnReset.textContent = isEn ? "↻ Reset" : "↻ 重新";
    mini.appendChild(btnReset);
    var sub = node("div", "pz-sub");
    var qbar = node("div");
    box.appendChild(sEl); box.appendChild(qbar); box.appendChild(mini); box.appendChild(sub);
    wrap.appendChild(box);
    stage.appendChild(wrap);
    var ms = cfg.ms, bar = null, busy = false;
    var S = 30;
    var view = "130 -40 360 460";
    function render(chain, remaining) {
      var parts = [];
      for (var q = -cfg.rad; q <= cfg.rad; q++) {
        for (var r = Math.max(-cfg.rad, -q - cfg.rad); r <= Math.min(cfg.rad, -q + cfg.rad); r++) {
          var hh = hxC(q, r, S);
          var isT = remaining.some(function (p) { return p[0] === q && p[1] === r; });
          var isDone = chain.some(function (p) { return p[0] === q && p[1] === r; });
          var fill, stroke = "var(--bd2)";
          if (isT) { fill = "rgba(111,181,255,.4)"; stroke = "#6fb5ff"; }
          else if (isDone) { fill = "rgba(127,224,168,.45)"; stroke = "#7fe0a8"; }
          else { fill = "rgba(127,232,255,.05)"; }
          parts.push('<polygon points="' + hh.poly + '" fill="' + fill + '" stroke="' + stroke + '" stroke-width="1.4"/>');
        }
      }
      for (var i = 1; i < chain.length; i++) {
        var a = hxC(chain[i - 1][0], chain[i - 1][1], S);
        var b = hxC(chain[i][0], chain[i][1], S);
        parts.push('<path d="M' + a.x + ' ' + a.y + ' L' + b.x + ' ' + b.y + '" stroke="#f7c84a" stroke-width="7" stroke-linecap="round"/>');
      }
      return '<svg viewBox="' + view + '" style="width:100%">' + parts.join("") + "</svg>";
    }
    function settle(won) {
      if (busy) return; busy = true;
      if (bar) bar.stop();
      award(id, api, { ms: ms, weight: 1 }, won, 0);
      api.hud({ done: api.state.done + 1, combo: won ? api.state.combo + 1 : 0 });
      var dn = api.state.done;
      later(id, function () { busy = false; if (dn >= HXTOTAL) endOverlay(id, api, buildMG17); else qRun(); }, 520);
    }
    function qRun() {
      var path = hxPath(cfg.rad, cfg.len);
      if (!path) { if (api.toList) api.toList(); return; }
      var chain = [path[0].slice()];
      var remaining = path.slice(1).map(function (p) { return p.slice(); });
      sub.textContent = "";
      sEl.innerHTML = render(chain, remaining);
      if (bar) bar.stop();
      qbar.innerHTML = "";
      bar = countdownBar(ms, function () { settle(false); });
      qbar.appendChild(bar.el);
      sEl.onclick = function (ev) {
        if (busy) return;
        var svg = sEl.querySelector("svg");
        var r = svg.getBoundingClientRect();
        var px = (ev.clientX - r.left) / r.width * svg.viewBox.baseVal.width + svg.viewBox.baseVal.x;
        var py = (ev.clientY - r.top) / r.height * svg.viewBox.baseVal.height + svg.viewBox.baseVal.y;
        var best = null, bd = S * S;
        remaining.forEach(function (p) {
          var c = hxC(p[0], p[1], S);
          var d = (px - c.x) * (px - c.x) + (py - c.y) * (py - c.y);
          if (d < bd) { bd = d; best = p; }
        });
        if (!best) return;
        var last = chain[chain.length - 1];
        var adj = HX_D.some(function (dd) { return last[0] + dd[0] === best[0] && last[1] + dd[1] === best[1]; });
        if (!adj) return;
        var idx = -1;
        for (var i = 0; i < remaining.length; i++) if (remaining[i][0] === best[0] && remaining[i][1] === best[1]) idx = i;
        remaining.splice(idx, 1);
        chain.push(best.slice());
        sEl.innerHTML = render(chain, remaining);
        if (remaining.length === 0) settle(true);
      };
      btnReset.onclick = function () { if (busy) return; qRun(); };
    }
    track(id, function () { if (bar) bar.stop(); });
    qRun();
  }

  /* ---- 挂 play / onLevelChange（A+B+C+D 引擎），难度切换 = 清 live 后重建 ---- */
  var ENGINES = {
    mg01: buildMG01,
    mg02: buildMG02,
    mg03: buildMG03,
    mg04: buildMG04,
    mg05: buildMG05,
    mg06: buildMG06,
    mg07: buildMG07,
    mg08: buildMG08,
    mg09: buildMG09,
    mg10: buildMG10,
    mg11: buildMG11,
    mg12: buildMG12,
    mg13: buildMG13,
    mg14: buildMG14,
    mg15: buildMG15,
    mg16: buildMG16,
    mg17: buildMG17,
  };
  defs.forEach(function (def) {
    var bld = ENGINES[def.id];
    if (!bld) return;
    def.play = function (api) {
      clearLive(def.id);
      bld(def.id, api);
      api.cleanup(function () { clearLive(def.id); });
    };
    def.onLevelChange = function (api) {
      clearLive(def.id);
      bld(def.id, api);
    };
  });

  window.Puzzle.register(defs);
})();
