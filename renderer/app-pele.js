/* ===== Pele · 轻量图 DSL 渲染器（Mermaid 替代）=====
 *
 * 为什么自己写：本项目是「零依赖」口径（见 AGENTS 的打包白名单与安装包体积口径），
 * 不引 mermaid.js（约 1MB+ 且自带一套布局与主题）。Pele 只做研究笔记真正用到的三类图：
 *   · flowchart  —— 推理链、方法流程、因果图
 *   · sequence   —— 实验步骤 / 交互时序
 *   · mindmap    —— 脑暴发散
 * 输出是纯 SVG（无外部依赖、可进 md 代码块、可被 SVG 视图直接内联），配色沿用画布变量，
 * 布局是确定性分层布局（同输入同输出），与知识图谱的渲染手感一致。
 *
 * 用法：
 *   window.MTPele.render(code, { theme })  → { svg, width, height, kind }
 *   window.MTPele.renderInto(el, code)
 *   window.MTPele.kindOf(code)
 *
 * 支持语法（子集，解析失败不抛错，尽量出图并在结果里给 warning）：
 *   flowchart TD|LR
 *     A[方框] --> B(圆角) --> C{判断}
 *     B -->|是| D[(数据库)]
 *     A --- E[无箭头]
 *   sequenceDiagram
 *     参与者 A / participant B
 *     A->>B: 请求
 *     B-->>A: 响应
 *   mindmap
 *     根
 *       子1
 *         孙
 */
(function () {
  "use strict";

  const SVG_NS = "http://www.w3.org/2000/svg";

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }
  /* 粗略宽度估算：中文按 1em、ASCII 按 0.58em */
  function textWidth(s, size) {
    const t = String(s || "");
    let w = 0;
    for (const ch of t) w += /[\u3000-\u9fff\uff00-\uffef]/.test(ch) ? size : size * 0.58;
    return w;
  }
  function kindOf(code) {
    const first = String(code || "")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)[0] || "";
    if (/^sequenceDiagram\b/i.test(first)) return "sequence";
    if (/^mindmap\b/i.test(first)) return "mindmap";
    if (/^(flowchart|graph)\b/i.test(first)) return "flowchart";
    return "";
  }
  function themeOf(theme) {
    const t = theme || {};
    return {
      bg: t.bg || "transparent",
      ink: t.ink || "var(--fg, #e6edf6)",
      sub: t.sub || "var(--muted, #93a1b4)",
      node: t.node || "var(--panel2, #1b2330)",
      nodeStroke: t.nodeStroke || "var(--line, #33415a)",
      accent: t.accent || "var(--accent, #38d6ff)",
      edge: t.edge || "var(--line2, #46587a)",
      /* 边标签的底衬：压在线上会看不清文字，用面板色垫一层 */
      labelBg: t.labelBg || "var(--panel2, #1b2330)",
    };
  }

  /* ── flowchart ──
   * 节点形状由包裹符决定：[] 方框 / () 圆角 / {} 菱形 / [()] 圆柱 / (()) 圆。
   * 连线：--> 有箭头 / --- 无箭头 / -.-> 虚线；|标签| 放边中间。 */
  /* 解析一个节点记号：`A[方框]` / `B(圆角)` / `C{判断}` / `D[(库)]` / `E((圆))` / `F>旗标]`。
     为什么不用一条大正则：Mermaid 的包裹符里可以再出现任意字符（`{A > B?}`），
     正则里排除 `}` 会把菱形标签整段吃掉（曾经就是这么丢的：`B{判断}` 只剩 `B`）。
     这里按「先认 id，再看开符，最后找配对的闭符」手写，标签取两个定界之间的原文。 */
  const OPENERS = [
    ["((", "))"],
    ["[[", "]]"],
    ["[(", ")]"],
    ["{{", "}}"],
    ["[", "]"],
    ["(", ")"],
    ["{", "}"],
    [">", "]"],
  ];
  /* 标签清理：写进 SVG 的那一行字，先按「看得见的正文」归一。
     ① mermaid 的 `A["文本"]` 是带引号的写法，引号是包裹符不是正文 ——
        过去原样留下，方框里就显示成 `"Transformer"`（外面一对引号）；
     ② 研究笔记里术语按项目口径写成 `[[术语]]` / `[[术语|显示名]]`，但 SVG 里没有可点的双链，
        留着方括号就是没渲染完的源码 —— 只留显示名（图注 / 正文里那条双链照样能点）。 */
  function cleanLabel(s) {
    let v = String(s == null ? "" : s).trim();
    const q = /^"([\s\S]*)"$/.exec(v) || /^'([\s\S]*)'$/.exec(v);
    if (q) v = q[1].trim();
    v = v.replace(/\[\[([^[\]|\n]+)(?:\|([^[\]\n]+))?\]\]/g, (all, target, shown) =>
      String(shown || target).trim(),
    );
    return v.trim();
  }
  function parseNodeToken(tok) {
    const s = String(tok == null ? "" : tok).trim();
    const idm = /^([A-Za-z0-9_\u4e00-\u9fa5.-]+)\s*/.exec(s);
    if (!idm) return null;
    const id = idm[1];
    let rest = s.slice(idm[0].length);
    if (!rest) return { id, label: id, shape: "box" };
    let open = "";
    let close = "";
    for (const [o, c] of OPENERS) {
      if (rest.startsWith(o)) {
        open = o;
        close = c;
        break;
      }
    }
    if (!open) return { id, label: id, shape: "box" };
    const inner = rest.slice(open.length);
    let label;
    if (inner.endsWith(close)) label = inner.slice(0, -close.length);
    else {
      const at = inner.lastIndexOf(close);
      label = at >= 0 ? inner.slice(0, at) : inner;
    }
    label = label.trim();
    return {
      id,
      label: cleanLabel(label) || id,
      explicit: true,
      shape: shapeOfToken(open, inner.endsWith(close) ? close : ""),
    };
  }
  function shapeOfToken(open, close) {
    const pair = (open || "") + (close || "");
    if (open === "{" || open === "{{") return "diamond";
    if (open === "((") return "circle";
    if (open === "[(" || open === "([") return "cylinder";
    if (open === "(") return "round";
    if (open === ">") return "flag";
    return "box";
  }
  function parseFlow(code) {
    const lines = String(code || "").split(/\r?\n/);
    let dir = "TD";
    const nodes = new Map();
    const edges = [];
    const warnings = [];

    const ensure = (id, label, shape, explicit) => {
      const cur = nodes.get(id);
      if (!cur) {
        nodes.set(id, { id, label: label || id, shape: shape || "box" });
        return nodes.get(id);
      }
      /* 只有**带包裹符**的写法才覆盖已有标签：`B{判断}` 之后再出现裸 `B`（`B --> C`）
         不能把「判断」打回「B」—— 这是曾经把菱形标签吃掉一半的第二个坑。 */
      if (explicit && label) cur.label = label;
      if (shape && shape !== "box") cur.shape = shape;
      return cur;
    };
    const takeNode = (tok) => {
      const n = parseNodeToken(tok);
      if (!n) return null;
      ensure(n.id, n.label, n.shape, n.explicit);
      return n.id;
    };
    for (let raw of lines) {
      const line = raw.trim();
      if (!line || line.startsWith("%%")) continue;
      const dm = /^(flowchart|graph)\s+(TD|TB|LR|RL|BT)$/i.exec(line);
      if (dm) {
        dir = dm[2].toUpperCase();
        continue;
      }
      if (/^(subgraph|end|classDef|class|style|linkStyle|click)\b/.test(line)) continue;
      /* 一条声明里可能串多个连线：A --> B --> C */
      const parts = line.split(/\s*(-->|---|-\.->|==>|-->)\s*/);
      if (parts.length === 1) {
        takeNode(line);
        continue;
      }
      for (let i = 0; i < parts.length; i += 2) {
        const seg = parts[i];
        const arrow = parts[i + 1] || "";
        if (!seg) continue;
        /* 带标签的边：A -->|是| B —— 标签落在箭头**后面**那一段的开头 */
        let label = "";
        let segClean = seg;
        const lm = /^\s*\|([^|]*)\|\s*([\s\S]*)$/.exec(seg);
        if (lm) {
          label = cleanLabel(lm[1]);
          segClean = lm[2] || "";
          if (!segClean.trim()) continue;
        }
        const nodeId = takeNode(segClean);
        if (!nodeId) continue;
        if (i > 0) {
          const prevRaw = String(parts[i - 2] || "");
          const prevStripped = prevRaw.replace(/^\s*\|[^|]*\|\s*/, "");
          const prevId = takeNode(prevStripped);
          if (prevId) {
            edges.push({
              from: prevId,
              to: nodeId,
              label,
              dashed: /-\.->/.test(arrow),
              arrow: !/^---$/.test(arrow),
            });
          }
        }
      }
    }
    if (!nodes.size) warnings.push("没有解析到节点");
    return { kind: "flowchart", dir, nodes: [...nodes.values()], edges, warnings };
  }
  function flowLayout(g) {
    const horizontal = g.dir === "LR" || g.dir === "RL";
    const level = new Map();
    const indeg = new Map(g.nodes.map((n) => [n.id, 0]));
    for (const e of g.edges) if (indeg.has(e.to)) indeg.set(e.to, (indeg.get(e.to) || 0) + 1);
    const roots = g.nodes.filter((n) => !indeg.get(n.id)).map((n) => n.id);
    const q = (roots.length ? roots : [g.nodes[0] && g.nodes[0].id]).filter(Boolean);
    for (const r of q) level.set(r, 0);
    let guard = 0;
    while (q.length && guard++ < 5000) {
      const cur = q.shift();
      for (const e of g.edges) {
        if (e.from !== cur) continue;
        const next = (level.get(cur) || 0) + 1;
        if (!level.has(e.to) || level.get(e.to) < next) {
          level.set(e.to, next);
          q.push(e.to);
        }
      }
    }
    for (const n of g.nodes) if (!level.has(n.id)) level.set(n.id, 0);
    const groups = new Map();
    for (const n of g.nodes) {
      const l = level.get(n.id);
      if (!groups.has(l)) groups.set(l, []);
      groups.get(l).push(n);
    }
    const pad = 28;
    const gapMain = 120;
    const gapCross = 58;
    const size = new Map();
    for (const n of g.nodes) {
      const w = Math.max(84, Math.min(300, textWidth(n.label, 14) + 28));
      const h = n.shape === "diamond" ? 62 : 44;
      size.set(n.id, { w, h });
    }
    const crossTotal = (arr) =>
      arr.reduce((s, n) => s + size.get(n.id).h, 0) + gapCross * Math.max(0, arr.length - 1);
    const maxCross = Math.max(...[...groups.values()].map(crossTotal), 0);
    const pos = new Map();
    let mainCursor = pad;
    for (const [l, arr] of [...groups.entries()].sort((a, b) => a[0] - b[0])) {
      const mainSize = Math.max(...arr.map((n) => size.get(n.id).w));
      const total = crossTotal(arr);
      let start = pad + (maxCross - total) / 2;
      for (const n of arr) {
        const s = size.get(n.id);
        if (horizontal) pos.set(n.id, { x: mainCursor, y: start, w: s.w, h: s.h });
        else pos.set(n.id, { x: start, y: mainCursor, w: s.w, h: s.h });
        start += s.h + gapCross;
      }
      mainCursor += mainSize + gapMain;
    }
    let width = 0;
    let height = 0;
    for (const p of pos.values()) {
      width = Math.max(width, p.x + p.w);
      height = Math.max(height, p.y + p.h);
    }
    return { pos, width: width + pad, height: height + pad, horizontal };
  }
  function shapePath(p, shape) {
    const cx = p.x + p.w / 2;
    const cy = p.y + p.h / 2;
    if (shape === "diamond") {
      const pts = [
        [cx, p.y],
        [p.x + p.w, cy],
        [cx, p.y + p.h],
        [p.x, cy],
      ];
      return { tag: "polygon", attrs: { points: pts.map((q) => q.join(",")).join(" ") } };
    }
    if (shape === "circle") {
      const r = Math.min(p.w, p.h) / 2;
      return { tag: "circle", attrs: { cx, cy, r } };
    }
    const rx = shape === "round" ? 18 : shape === "cylinder" ? 8 : 6;
    return { tag: "rect", attrs: { x: p.x, y: p.y, width: p.w, height: p.h, rx } };
  }
  function renderFlow(g, th) {
    const lay = flowLayout(g);
    const out = [];
    const segs = [];
    for (const e of g.edges) {
      const a = lay.pos.get(e.from);
      const b = lay.pos.get(e.to);
      if (!a || !b) continue;
      const ax = a.x + a.w / 2;
      const ay = a.y + a.h / 2;
      const bx = b.x + b.w / 2;
      const by = b.y + b.h / 2;
      let x1, y1, x2, y2;
      if (lay.horizontal) {
        const right = bx >= ax;
        x1 = right ? a.x + a.w : a.x;
        y1 = ay;
        x2 = right ? b.x : b.x + b.w;
        y2 = by;
      } else {
        const down = by >= ay;
        x1 = ax;
        y1 = down ? a.y + a.h : a.y;
        x2 = bx;
        y2 = down ? b.y : b.y + b.h;
      }
      const midX = (x1 + x2) / 2;
      const midY = (y1 + y2) / 2;
      const d = lay.horizontal
        ? `M${x1},${y1} C${midX},${y1} ${midX},${y2} ${x2},${y2}`
        : `M${x1},${y1} C${x1},${midY} ${x2},${midY} ${x2},${y2}`;
      segs.push(
        `<path d="${d}" fill="none" stroke="${esc(th.edge)}" stroke-width="1.4"${
          e.dashed ? ' stroke-dasharray="5 4"' : ""
        }${e.arrow ? ' marker-end="url(#pele-arrow)"' : ""}/>`,
      );
      if (e.label)
        segs.push(
          `<rect x="${midX - textWidth(e.label, 12) / 2 - 5}" y="${midY - 10}" width="${
            textWidth(e.label, 12) + 10
          }" height="18" rx="4" fill="${esc(th.labelBg)}" opacity="0.85"/>` +
            `<text x="${midX}" y="${midY + 4}" font-size="12" text-anchor="middle" fill="${esc(
              th.sub,
            )}">${esc(e.label)}</text>`,
        );
    }
    const boxes = [];
    for (const n of g.nodes) {
      const p = lay.pos.get(n.id);
      if (!p) continue;
      const sh = shapePath(p, n.shape);
      boxes.push(
        `<${sh.tag} ${Object.entries(sh.attrs)
          .map(([k, v]) => `${k}="${v}"`)
          .join(" ")} fill="${esc(th.node)}" stroke="${esc(th.nodeStroke)}" stroke-width="1.3"/>`,
      );
      const lines = String(n.label).split(/\\n|\n/);
      const lh = 17;
      const startY = p.y + p.h / 2 - ((lines.length - 1) * lh) / 2 + 5;
      lines.forEach((ln, i) => {
        boxes.push(
          `<text x="${p.x + p.w / 2}" y="${startY + i * lh}" font-size="14" text-anchor="middle" fill="${esc(
            th.ink,
          )}" font-family="var(--ui-font, system-ui)">${esc(ln)}</text>`,
        );
      });
    }
    out.push(...segs, ...boxes);
    return {
      body: out.join(""),
      width: Math.round(lay.width),
      height: Math.round(lay.height),
    };
  }

  /* ── sequence ── */
  function parseSequence(code) {
    const lines = String(code || "").split(/\r?\n/).slice(1);
    const actors = [];
    const msgs = [];
    const addActor = (name) => {
      const n = String(name || "").trim();
      if (n && !actors.includes(n)) actors.push(n);
      return n;
    };
    for (let raw of lines) {
      const line = raw.trim();
      if (!line || line.startsWith("%%")) continue;
      const pm = /^(participant|actor)\s+(.+)$/i.exec(line);
      if (pm) {
        addActor(pm[2].split(/\s+as\s+/)[0]);
        continue;
      }
      if (/^(Note|loop|alt|else|opt|end|activate|deactivate)\b/i.test(line)) continue;
      const mm = /^(.+?)\s*(-{1,2}>>|-->>|->>|->|-->|--x|-x)\s*(.+?)\s*:\s*(.*)$/.exec(line);
      if (!mm) continue;
      const a = addActor(mm[1]);
      const b = addActor(mm[3]);
      const dashed = /-->>|-->/.test(mm[2]);
      msgs.push({ from: a, to: b, text: mm[4], dashed, order: msgs.length });
    }
    return { kind: "sequence", actors, msgs, warnings: actors.length ? [] : ["没有解析到参与者"] };
  }
  function renderSequence(g, th) {
    const pad = 30;
    const colW = 170;
    const headH = 40;
    const rowH = 42;
    const width = Math.max(320, pad * 2 + Math.max(1, g.actors.length) * colW);
    const height = pad * 2 + headH + Math.max(1, g.msgs.length) * rowH + 20;
    const xOf = (name) => {
      const i = Math.max(0, g.actors.indexOf(name));
      return pad + colW / 2 + i * colW;
    };
    const out = [];
    for (const a of g.actors) {
      const x = xOf(a);
      out.push(
        `<rect x="${x - colW / 2 + 12}" y="${pad}" width="${colW - 24}" height="30" rx="6" fill="${esc(
          th.node,
        )}" stroke="${esc(th.nodeStroke)}"/>`,
        `<text x="${x}" y="${pad + 20}" font-size="13" text-anchor="middle" fill="${esc(
          th.ink,
        )}">${esc(a)}</text>`,
        `<line x1="${x}" y1="${pad + 34}" x2="${x}" y2="${height - pad}" stroke="${esc(
          th.nodeStroke,
        )}" stroke-dasharray="4 5"/>`,
      );
    }
    g.msgs.forEach((m, i) => {
      const y = pad + headH + 24 + i * rowH;
      const x1 = xOf(m.from);
      const x2 = xOf(m.to);
      const dir = x2 >= x1 ? 1 : -1;
      out.push(
        `<line x1="${x1}" y1="${y}" x2="${x2}" y2="${y}" stroke="${esc(th.edge)}" stroke-width="1.4"${
          m.dashed ? ' stroke-dasharray="5 4"' : ""
        } marker-end="url(#pele-arrow)"/>`,
        `<text x="${(x1 + x2) / 2}" y="${y - 7}" font-size="12" text-anchor="middle" fill="${esc(
          th.sub,
        )}">${esc(m.text)}</text>`,
      );
      if (dir > 0) out.push(`<circle cx="${x2 - 6}" cy="${y}" r="0" fill="none"/>`);
    });
    return { body: out.join(""), width, height };
  }

  /* ── mindmap ── */
  function parseMindmap(code) {
    const lines = String(code || "").split(/\r?\n/).slice(1);
    const roots = [];
    const stack = [];
    const warnings = [];
    for (const raw of lines) {
      if (!raw.trim() || /^\s*%%/.test(raw)) continue;
      const indent = (/^\s*/.exec(raw)[0] || "").replace(/\t/g, "  ").length;
      const text = cleanLabel(raw.trim().replace(/^[-*+]\s+/, "")) || raw.trim();
      const node = { text, children: [], level: 0 };
      while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
      if (!stack.length) {
        node.level = 0;
        roots.push(node);
      } else {
        const parent = stack[stack.length - 1];
        node.level = parent.node.level + 1;
        parent.node.children.push(node);
      }
      stack.push({ indent, node });
    }
    if (!roots.length) warnings.push("没有解析到节点");
    return { kind: "mindmap", roots, warnings };
  }
  function renderMindmap(g, th) {
    const pad = 24;
    const rowH = 34;
    const colW = 190;
    let maxLevel = 0;
    let rows = 0;
    const walk = (n, depth, cb) => {
      maxLevel = Math.max(maxLevel, depth);
      cb(n, depth, rows++);
      for (const c of n.children) walk(c, depth + 1, cb);
    };
    for (const r of g.roots) walk(r, 0, () => {});
    const width = Math.max(360, pad * 2 + (maxLevel + 1) * colW);
    const height = Math.max(120, pad * 2 + Math.max(1, rows) * rowH);
    const out = [];
    const draw = (n, depth, y, parentPt) => {
      const x = pad + depth * colW;
      const w = Math.max(80, Math.min(colW - 30, textWidth(n.text, 13) + 24));
      const h = 26;
      const pt = { x, y };
      if (parentPt) {
        const mx = (parentPt.x + parentPt.y === 0 ? x : x) - 0;
        const px = parentPt.x + parentPt.w;
        const py = parentPt.y + h / 2;
        const cx1 = px + (x - px) / 2;
        const cy1 = py;
        const cx2 = px + (x - px) / 2;
        const cy2 = y + h / 2;
        out.push(
          `<path d="M${px},${py} C${cx1},${cy1} ${cx2},${cy2} ${x},${y + h / 2}" fill="none" stroke="${esc(
            th.edge,
          )}" stroke-width="1.3"/>`,
        );
      }
      out.push(
        `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="13" fill="${esc(
          depth === 0 ? th.node : th.node,
        )}" stroke="${esc(depth === 0 ? th.accent : th.nodeStroke)}" stroke-width="1.3"/>`,
        `<text x="${x + w / 2}" y="${y + h / 2 + 4.5}" font-size="13" text-anchor="middle" fill="${esc(
          th.ink,
        )}">${esc(n.text)}</text>`,
      );
      for (const c of n.children) draw(c, depth + 1, y, { x, y, w });
    };
    let cursor = pad;
    for (const r of g.roots) {
      const before = cursor;
      const countRows = (n) => 1 + n.children.reduce((s, c) => s + countRows(c), 0);
      const rh = countRows(r) * rowH;
      draw(r, 0, before);
      cursor += rh;
    }
    return { body: out.join(""), width, height };
  }

  function svgWrap(width, height, body, th) {
    return (
      `<svg class="pele-svg" xmlns="${SVG_NS}" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" ` +
      `role="img" style="max-width:100%;height:auto">` +
      `<defs><marker id="pele-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">` +
      `<path d="M0,0 L10,5 L0,10 z" fill="${esc(th.edge)}"/></marker></defs>` +
      body +
      `</svg>`
    );
  }

  function render(code, opts) {
    const th = themeOf(opts && opts.theme);
    const kind = kindOf(code);
    try {
      if (kind === "sequence") {
        const g = parseSequence(code);
        const r = renderSequence(g, th);
        return { kind, svg: svgWrap(r.width, r.height, r.body, th), width: r.width, height: r.height, warnings: g.warnings };
      }
      if (kind === "mindmap") {
        const g = parseMindmap(code);
        const r = renderMindmap(g, th);
        return { kind, svg: svgWrap(r.width, r.height, r.body, th), width: r.width, height: r.height, warnings: g.warnings };
      }
      if (kind === "flowchart") {
        const g = parseFlow(code);
        const r = renderFlow(g, th);
        return { kind, svg: svgWrap(r.width, r.height, r.body, th), width: r.width, height: r.height, warnings: g.warnings };
      }
      return {
        kind: "",
        svg: "",
        width: 0,
        height: 0,
        warnings: ["不是 Pele 图（需以 flowchart / sequenceDiagram / mindmap 开头）"],
      };
    } catch (e) {
      return { kind, svg: "", width: 0, height: 0, warnings: [String((e && e.message) || e)] };
    }
  }
  function renderInto(el, code, opts) {
    if (!el) return null;
    const r = render(code, opts);
    el.innerHTML = r.svg || `<div class="pele-err">${esc((r.warnings || []).join("；"))}</div>`;
    return r;
  }

  window.MTPele = { render, renderInto, kindOf };
})();
