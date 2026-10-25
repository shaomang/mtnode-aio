#!/usr/bin/env node
/**
 * gen-changelog.mjs — 由仓库 changelog/*.md 生成官网更新日志页 web/changelog.html。
 *
 * 为什么生成而不是手写：changelog/ 是面向用户的版本记录唯一真源（发版链强制每版一份），
 * 官网若另抄一份，迟早漏版、对不上。这里只做「读 md → 排版成静态 HTML」，
 * 生成结果仍是单文件、零请求的静态页，与 index.html / tutorial.html 同栈（无构建、无运行时依赖）。
 *
 * 用法：
 *   node site-src/gen-changelog.mjs            # 写 web/changelog.html
 *   node site-src/gen-changelog.mjs --check    # 只校验不写盘（对比现有页面是否过期）
 *
 * 口径（与用户确认过的共识一致）：
 *   - 只做中文；英文界面下仍显示中文，标题用 Changelog。
 *   - 覆盖 v1.0 及更早 → 当前版本，按版本折叠，默认只展开最新一版。
 *   - 跳过「无用户可见变化」的版本（摘要为「内部维护与稳定性」的整版不列）。
 *   - 左侧按大版本（v1.5 … v1.0）分组的版本目录，右侧正文按大版本分段。
 */

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB_DIR = resolve(HERE, '..');
const ROOT = resolve(WEB_DIR, '..');
const CHANGELOG_DIR = join(ROOT, 'changelog');
const OUT = join(WEB_DIR, 'changelog.html');

/** 摘要为「内部维护与稳定性」的版本：用户确认过不列进页面。 */
const SKIP = new Set(['1.1.14', '1.1.18', '1.2.8']);

const CAT_LABEL = {
  '重大更新': '重大更新',
  '新增': '新增',
  '改进': '改进',
  '修复': '修复',
  '当时已有的能力': '当时已有的能力',
};

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 行内只认反引号代码（changelog 规范里几乎没有别的行内标记）。 */
function inline(s) {
  return esc(s).replace(/`([^`]+)`/g, '<code>$1</code>');
}

function parseVersionFile(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const h1 = lines.find(l => /^#\s+/.test(l));
  if (!h1) return null;
  const title = h1.replace(/^#\s+/, '').trim();
  const overview = /及更早/.test(title);
  const vm = title.match(/v(\d+(?:\.\d+)*)/);
  const dm = title.match(/(\d{4}-\d{2}-\d{2})/);

  const cats = [];
  let cur = null;
  let summary = '';
  let seenCat = false;
  let pending = null; // 上一个条目，用于挂嵌套子项

  for (const raw of lines.slice(lines.indexOf(h1) + 1)) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim()) continue;
    if (/^##\s+/.test(line)) {
      seenCat = true;
      const name = line.replace(/^##\s+/, '').trim();
      cur = { name: CAT_LABEL[name] || name, items: [] };
      cats.push(cur);
      pending = null;
      continue;
    }
    const bullet = line.match(/^\s*[-*+]\s+(.*)$/);
    if (bullet) {
      const text = bullet[1].trim();
      const nested = /^\s{2,}[-*+]\s/.test(line);
      if (nested && pending) {
        pending.children.push(text);
        continue;
      }
      if (cur) {
        pending = { text, children: [] };
        cur.items.push(pending);
      }
      continue;
    }
    if (!seenCat && !summary) summary = line.trim();
  }

  const version = vm ? vm[1] : overview ? '1.0' : null;
  if (!version) return null;
  return {
    version,
    date: dm ? dm[1] : '',
    summary,
    overview,
    cats,
    file: '',
  };
}

function semverParts(v) {
  return v.split('.').map(Number);
}
function cmpVerDesc(a, b) {
  const x = semverParts(a.version);
  const y = semverParts(b.version);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (y[i] || 0) - (x[i] || 0);
    if (d) return d;
  }
  return 0;
}

function loadVersions() {
  const files = readdirSync(CHANGELOG_DIR).filter(f => /^v[\d.]+\.md$/.test(f));
  const out = [];
  for (const f of files) {
    const parsed = parseVersionFile(readFileSync(join(CHANGELOG_DIR, f), 'utf8'));
    if (!parsed) continue;
    parsed.file = f;
    out.push(parsed);
  }
  const overview = out.filter(v => v.overview).sort((a, b) => cmpVerDesc(a, b));
  const normal = out.filter(v => !v.overview).sort(cmpVerDesc);
  return { normal, overview };
}

function majorOf(v) {
  const p = semverParts(v);
  return p.length >= 2 ? `${p[0]}.${p[1]}` : `${p[0]}.0`;
}

function renderItems(items) {
  if (!items.length) return '';
  const lis = items.map(it => {
    const kids = it.children && it.children.length
      ? `<ul>${it.children.map(c => `<li>${inline(c)}</li>`).join('')}</ul>`
      : '';
    return `<li>${inline(it.text)}${kids}</li>`;
  }).join('\n          ');
  return `<ul>\n          ${lis}\n        </ul>`;
}

function renderVersion(v, open) {
  const id = v.overview ? 'v1-0-earlier' : 'v' + v.version;
  const label = v.overview ? 'v1.0 及更早' : 'v' + v.version;
  const search = [
    label,
    v.date,
    v.summary,
    ...v.cats.flatMap(c => c.items.map(i => [i.text, ...(i.children || [])].join(' '))),
  ].join(' ').toLowerCase();

  const body = v.cats.map(c => `
        <h4>${esc(c.name)}</h4>
        ${renderItems(c.items)}`).join('');

  return `
    <section class="cl-ver" id="${id}" data-search="${esc(search)}">
      <details class="ver"${open ? ' open' : ''}>
        <summary>
          <span class="ver-no">${esc(label)}</span>
          ${v.date ? `<span class="ver-date">${esc(v.date)}</span>` : '<span class="ver-date">—</span>'}
          <span class="ver-sum">${v.summary ? esc(v.summary) : '（本版无一句话摘要）'}</span>
        </summary>
        <div class="ver-body">${body}
        </div>
      </details>
    </section>`;
}

function build() {
  const { normal, overview } = loadVersions();
  const listed = normal.filter(v => !SKIP.has(v.version));

  // 按大版本分组（降序）
  const majors = new Map();
  for (const v of listed) {
    const m = majorOf(v.version);
    if (!majors.has(m)) majors.set(m, []);
    majors.get(m).push(v);
  }
  const majorKeys = [...majors.keys()].sort((a, b) => {
    const x = semverParts(a + '.0');
    const y = semverParts(b + '.0');
    for (let i = 0; i < Math.max(x.length, y.length); i++) {
      const d = (y[i] || 0) - (x[i] || 0);
      if (d) return d;
    }
    return 0;
  });

  const latest = listed[0];
  const total = listed.length + (overview.length ? 1 : 0);

  // 左侧目录：大版本分组 → 版本链接
  const tree = majorKeys.map((m, mi) => {
    const vs = majors.get(m);
    const lis = vs.map(v =>
      `<li><a href="#v${esc(v.version)}" data-target="v${esc(v.version)}">v${esc(v.version)}${v.date ? `<span>${esc(v.date)}</span>` : ''}</a></li>`
    ).join('\n        ');
    const extra = m === '1.0' && overview.length
      ? `\n        <li><a href="#v1-0-earlier" data-target="v1-0-earlier">v1.0 及更早<span>概述</span></a></li>`
      : '';
    return `
      <details class="tut-ch"${mi === 0 ? ' open' : ''}>
        <summary>v${esc(m)} 系列</summary>
        <ul>
        ${lis}${extra}
        </ul>
      </details>`;
  }).join('');

  // 顶部大版本锚点
  const chips = majorKeys.map(m =>
    `<a href="#m${m.replace('.', '')}">v${esc(m)}</a>`
  ).join('');

  // 右侧正文：大版本分段
  const sections = majorKeys.map(m => {
    const vs = majors.get(m);
    const parts = vs.map((v, i) => renderVersion(v, m === majorKeys[0] && i === 0)).join('');
    const earlier = m === '1.0' && overview.length
      ? overview.map(v => renderVersion(v, false)).join('')
      : '';
    return `
    <section class="cl-major" id="m${m.replace('.', '')}">
      <h2>v${esc(m)} 系列</h2>${parts}${earlier}
    </section>`;
  }).join('');

  const doc = `<!DOCTYPE html>
<!--
  由 web/site-src/gen-changelog.mjs 生成，请勿手改。
  改内容：改仓库 changelog/v<版本>.md，然后重跑
    node web/site-src/gen-changelog.mjs
  上传：
    node web/site-src/publish.mjs upload web/changelog.html changelog.html
-->
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>更新日志 · MTNode AI工作站</title>
<meta name="description" content="MTNode AI工作站版本更新日志：从 v1.0 到 v${esc(latest.version)}，逐版说明新增、改进与修复。">
<meta name="theme-color" content="#161b25">
<style>
:root{
  --bg:#0d1016; --bg2:#12161f; --panel:#161b25; --panel2:#1b2230;
  --bd:#2a3342; --bd2:#39465c; --ink:#d8dee8; --muted:#7f8a9c;
  --orange:#ff8f2e; --orange2:#ffb066; --cyan:#38d6ff; --cyan2:#7ce8ff;
  --green:#5fd68a; --red:#ff5f56; --code:#0c0f15;
  --mono:'Consolas','Cascadia Code','JetBrains Mono',monospace;
  --sans:'Segoe UI','PingFang SC','Microsoft YaHei',system-ui,sans-serif;
}
*{box-sizing:border-box;margin:0;padding:0}
html{scroll-behavior:smooth}
body{background:var(--bg);color:var(--ink);font-family:var(--sans);font-size:14px;line-height:1.9}
::selection{background:rgba(255,143,46,.35)}
a{color:var(--cyan);text-decoration:none}
a:hover{color:#fff;text-decoration:underline}
button,input{font-family:var(--sans)}

.topbar{
  position:sticky;top:0;z-index:50;display:flex;align-items:center;gap:16px;
  padding:10px 20px;background:linear-gradient(180deg,var(--panel2),var(--panel));
  border-bottom:3px solid var(--bd);
}
.logo{display:block;line-height:1.25;flex:none}
.logo:hover{text-decoration:none}
.logo-txt{font-weight:800;letter-spacing:2px;font-size:15px;color:var(--orange)}
.logo-sub{display:block;font-size:10px;letter-spacing:3px;color:var(--muted);font-weight:400}
.top-nav{display:flex;flex-wrap:wrap;gap:4px 14px;flex:1;justify-content:center}
.top-nav a{color:var(--muted);font-size:12px;letter-spacing:1px;font-weight:600}
.top-nav a:hover{color:var(--orange2);text-decoration:none}
.top-nav a.on{color:var(--orange2)}
.top-right{display:flex;align-items:center;gap:12px;flex:none}
.ver-tag{font-size:11px;letter-spacing:1px;color:var(--muted);font-family:var(--mono)}
.btn-dl{
  display:inline-flex;align-items:center;gap:6px;border:1px solid var(--green);background:transparent;
  color:var(--green);border-radius:8px;padding:5px 10px;font-size:12px;cursor:pointer;
}
.btn-dl:hover{border-color:var(--green);background:rgba(95,214,138,.12);color:var(--green);text-decoration:none}

.cl-wrap{display:flex;gap:26px;align-items:flex-start;max-width:1240px;margin:0 auto;padding:18px 20px 90px}

/* ── 左侧版本目录 ── */
.cl-nav{
  flex:0 0 252px;width:252px;position:sticky;top:64px;max-height:calc(100vh - 84px);overflow:auto;
  border-right:1px solid var(--bd);padding:4px 14px 26px 0;
}
.cl-nav h2{font-size:12px;letter-spacing:2px;color:var(--muted);font-weight:400;margin:2px 0 10px}
#clFilter{
  width:100%;background:var(--code);border:1px solid var(--bd);color:var(--ink);border-radius:8px;
  padding:8px 10px;font-size:13px;margin-bottom:12px;
}
#clFilter:focus{outline:none;border-color:var(--cyan)}
#clFilter::placeholder{color:var(--muted)}
.tut-ch{border-bottom:1px dashed var(--bd);padding:2px 0}
.tut-ch>summary{
  cursor:pointer;list-style:none;padding:7px 2px;font-weight:700;font-size:13px;color:var(--ink);
  display:flex;align-items:center;gap:6px;
}
.tut-ch>summary::-webkit-details-marker{display:none}
.tut-ch>summary::before{content:"▸";color:var(--orange);font-size:11px;transition:transform .15s}
.tut-ch[open]>summary::before{transform:rotate(90deg)}
.tut-ch>summary:hover{color:var(--orange2)}
.tut-ch ul{list-style:none;margin:0 0 8px 14px}
.tut-ch li{margin:1px 0}
.tut-ch li a{
  display:flex;justify-content:space-between;gap:8px;font-size:12.5px;color:var(--muted);
  padding:4px 8px;border-radius:6px;border-left:2px solid transparent;
}
.tut-ch li a span{font-family:var(--mono);font-size:11px;color:#5d6879}
.tut-ch li a:hover{color:var(--ink);background:var(--panel2);text-decoration:none}
.tut-ch li a.active{color:var(--cyan2);background:var(--panel2);border-left-color:var(--cyan)}
.tut-ch li a.active span{color:var(--cyan)}
#clEmpty{color:var(--muted);font-size:12.5px;padding:10px 2px}

/* ── 右侧正文 ── */
.cl-body{flex:1;min-width:0;max-width:880px}
.cl-lead{color:var(--muted);font-size:13px;border-left:3px solid var(--orange);padding:2px 0 2px 12px;margin:6px 0 18px}
.cl-chips{display:flex;flex-wrap:wrap;gap:8px;margin:0 0 26px}
.cl-chips a{
  border:1px solid var(--bd2);border-radius:999px;padding:3px 11px;font-size:12px;
  color:var(--muted);font-family:var(--mono);letter-spacing:1px;
}
.cl-chips a:hover{border-color:var(--cyan);color:var(--cyan2);text-decoration:none}

.cl-major{padding:22px 0 4px;border-top:1px solid var(--bd)}
.cl-major:first-of-type{border-top:0;padding-top:6px}
.cl-major>h2{font-size:19px;letter-spacing:2px;margin:0 0 10px;scroll-margin-top:76px}
.cl-major>h2::before{content:"■ ";color:var(--orange);font-size:13px;vertical-align:2px}

.cl-ver{margin:0 0 10px;scroll-margin-top:76px}
.ver{border:1px solid var(--bd);border-radius:10px;background:var(--panel);overflow:hidden}
.ver[open]{border-color:var(--bd2);background:var(--panel2)}
.ver>summary{
  cursor:pointer;list-style:none;display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 12px;
  padding:10px 14px;
}
.ver>summary::-webkit-details-marker{display:none}
.ver>summary::before{content:"＋";color:var(--orange);font-size:12px;line-height:1}
.ver[open]>summary::before{content:"－"}
.ver>summary:hover .ver-no{color:var(--orange2)}
.ver-no{font-family:var(--mono);font-size:14px;color:var(--orange2);letter-spacing:1px}
.ver-date{font-family:var(--mono);font-size:11.5px;color:var(--muted)}
.ver-sum{flex:1 1 260px;font-size:12.5px;color:var(--ink);min-width:0}
.ver-body{padding:2px 16px 14px 16px;border-top:1px solid var(--bd)}
.ver-body h4{
  font-size:12px;letter-spacing:2px;color:var(--cyan2);font-weight:700;
  margin:14px 0 2px;
}
.ver-body h4::before{content:"· ";color:var(--muted)}
.ver-body ul{margin:2px 0 2px 20px}
.ver-body li{margin:5px 0;font-size:13.5px}
.ver-body ul ul{margin:4px 0 4px 18px}
.ver-body ul ul li{font-size:12.5px;color:var(--muted);list-style:circle}
.ver-body code{
  font-family:var(--mono);font-size:12.5px;background:var(--code);border:1px solid var(--bd);
  border-radius:5px;padding:1px 5px;color:var(--cyan2);
}

#toTop{
  position:fixed;right:22px;bottom:22px;z-index:60;display:none;
  border:1px solid var(--bd2);background:var(--panel2);color:var(--ink);border-radius:10px;
  padding:8px 12px;font-size:12px;cursor:pointer;
}
#toTop:hover{border-color:var(--orange);color:#fff}

@media (max-width:900px){
  .cl-wrap{flex-direction:column;gap:14px}
  .cl-nav{position:static;flex:none;width:100%;max-height:none;border-right:0;border-bottom:1px solid var(--bd);padding:0 0 14px}
  .cl-body{max-width:none}
  .top-nav{display:none}
}
</style>
</head>
<body>

<header class="topbar">
  <a class="logo" href="index.html" title="返回下载页">
    <span class="logo-txt">MTNode AI工作站</span>
    <span class="logo-sub">更 新 日 志</span>
  </a>
  <nav class="top-nav">
    <a href="index.html#download">下载</a>
    <a href="index.html#whatsnew">新能力</a>
    <a href="index.html#features">功能</a>
    <a href="tutorial.html">使用方法</a>
    <a href="changelog.html" class="on">更新日志</a>
    <a href="index.html#opensource">开源</a>
  </nav>
  <div class="top-right">
    <span class="ver-tag">v${esc(latest.version)}</span>
    <a class="btn-dl" href="index.html#download">下载 ↓</a>
  </div>
</header>

<div class="cl-wrap">

  <aside class="cl-nav">
    <h2>版 本</h2>
    <input id="clFilter" type="search" placeholder="搜索版本 / 功能关键词…" autocomplete="off">
    <nav id="clTree">${tree}
    </nav>
    <p id="clEmpty" hidden>无匹配项</p>
  </aside>

  <article class="cl-body" id="clBody">

    <p class="cl-lead">MTNode 每个版本的更新记录：v${esc(latest.version)} 为当前版本，共 ${total} 条（含 v1.0 概述）。只写用户能感知的变化；点版本号展开该版的新增、改进与修复。</p>

    <nav class="cl-chips">${chips}</nav>
${sections}
  </article>
</div>

<button id="toTop" type="button">↑ 回到顶部</button>

<script>
(function () {
  var body = document.getElementById("clBody");
  var tree = document.getElementById("clTree");
  var filter = document.getElementById("clFilter");
  var emptyEl = document.getElementById("clEmpty");
  var links = Array.prototype.slice.call(tree.querySelectorAll("a[data-target]"));
  var linkOf = {};
  links.forEach(function (a) { linkOf[a.dataset.target] = a; });
  var vers = Array.prototype.slice.call(body.querySelectorAll(".cl-ver"));

  function openVer(sec) {
    if (!sec) return;
    var d = sec.querySelector("details.ver");
    if (d) d.open = true;
  }

  function jump(id) {
    var sec = document.getElementById(id);
    if (!sec) return;
    openVer(sec);
    var top = sec.getBoundingClientRect().top + window.scrollY - 74;
    window.scrollTo({ top: top < 0 ? 0 : top, behavior: "smooth" });
    if (history.replaceState) history.replaceState(null, "", "#" + id);
  }

  links.forEach(function (a) {
    a.addEventListener("click", function (e) {
      e.preventDefault();
      jump(a.dataset.target);
    });
  });

  // 直达链接（#v1.5.6 等）：进来先展开该版
  if (location.hash) {
    var id = location.hash.slice(1);
    var sec = document.getElementById(id);
    if (sec && sec.classList.contains("cl-ver")) {
      openVer(sec);
      var top = sec.getBoundingClientRect().top + window.scrollY - 74;
      window.scrollTo({ top: top < 0 ? 0 : top });
    }
  }

  /* ── 搜索：版本号 / 日期 / 摘要 / 条目全文 ── */
  filter.addEventListener("input", function () {
    var q = filter.value.trim().toLowerCase();
    var visible = 0;
    vers.forEach(function (sec) {
      var hit = !q || (sec.dataset.search || "").indexOf(q) >= 0;
      sec.hidden = !hit;
      if (hit) visible++;
    });
    Array.prototype.forEach.call(tree.querySelectorAll(".tut-ch"), function (group) {
      var items = Array.prototype.slice.call(group.querySelectorAll("li"));
      var any = false;
      items.forEach(function (li) {
        var a = li.querySelector("a");
        var id = a && a.dataset.target;
        var sec = id && document.getElementById(id);
        var show = !q || (sec && !sec.hidden);
        li.hidden = !show;
        if (show) any = true;
      });
      group.hidden = !any;
      if (q) group.open = any;
    });
    emptyEl.hidden = visible > 0;
    if (q) {
      // 搜索时把命中的版本正文直接展开，省一次点击
      vers.forEach(function (sec) { if (!sec.hidden) openVer(sec); });
    }
  });

  /* ── 滚动高亮左侧目录 ── */
  var current = null;
  function setCurrent(id) {
    if (id === current) return;
    current = id;
    links.forEach(function (a) { a.classList.remove("active"); });
    var a = linkOf[id];
    if (!a) return;
    a.classList.add("active");
    var g = a.closest("details");
    if (g && !g.open) g.open = true;
  }
  var spy = new IntersectionObserver(function (entries) {
    var vis = entries.filter(function (e) { return e.isIntersecting; })
      .sort(function (a, b) { return a.boundingClientRect.top - b.boundingClientRect.top; });
    if (vis.length) setCurrent(vis[0].target.id);
  }, { rootMargin: "-74px 0px -68% 0px", threshold: 0 });
  vers.forEach(function (sec) { spy.observe(sec); });

  /* ── 回到顶部 ── */
  var toTop = document.getElementById("toTop");
  window.addEventListener("scroll", function () {
    toTop.style.display = window.scrollY > 600 ? "block" : "none";
  });
  toTop.addEventListener("click", function () { window.scrollTo({ top: 0, behavior: "smooth" }); });
})();
</script>
</body>
</html>
`;

  return doc;
}

const check = process.argv.includes('--check');
const html = build();
if (check) {
  let prev = '';
  try { prev = readFileSync(OUT, 'utf8'); } catch {}
  if (prev === html) {
    console.log('changelog.html 已是最新（' + Buffer.byteLength(html) + ' 字节）。');
    process.exit(0);
  }
  console.error('changelog.html 与 changelog/*.md 不一致，请重跑生成。');
  process.exit(1);
}
writeFileSync(OUT, html, 'utf8');
console.log('已生成 ' + OUT + '（' + Buffer.byteLength(html) + ' 字节）');
