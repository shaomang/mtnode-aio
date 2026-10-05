"use strict";
/* 隐私政策页（web/privacy/）与它的云端部署链 —— 冒烟回归（纯 Node，不联网、不碰生产 nginx）
 *   node test/smoke-privacy-page.js
 * 背景：Microsoft Store 提审要求一个公开可访问的隐私政策 URL（http://mt-agent.com/mtnode/privacy/）。
 * 政策页正文的每一条断言都必须以 docs/privacy-data-inventory.md（代码与服务器实测清单）为唯一依据，
 * 所以这里守的是三件事：**页面无占位残渣**、**页面说法在清单里有对应行**、**页面/文档/脚本三处的 URL 与
 * nginx 路由是同一个真源**。第 [8] 节把 scripts/patch-nginx-privacy.py 拷进临时目录、
 * 只覆盖它的两个路径常量后跑真实 main()，验证幂等 —— 不发 SSH、不改服务器配置。
 *
 * 覆盖：
 *   [1] 中英两页存在、非空、单文件自包含（零脚本 / 零 src / 零站外资源）
 *   [2] 章节骨架：各 15 节，section id 与 h2 编号逐位对齐，页内锚点都有落点
 *   [3] 两页互链与回下载页的相对链接
 *   [4] 无 TODO / 待填 / example.com / 占位邮箱；联系渠道只有 GitHub Issues
 *   [5] 必备章节关键词（中 / EN 各自齐全）
 *   [6] 政策口径三条红线（清单 §7 的禁用语一个都不许出现）
 *   [7] 页面声明的数据去向逐条能在清单里找到锚点 + 页面上每个主机名反查清单
 *   [8] patch-nginx-privacy.py 幂等（临时 conf 跑两遍只有一条 privacy location）
 *   [9] 部署链常量一致：alias / REMOTE / PATHS / location 与文档 URL 同源
 *  [10] 文档与 README 的 URL 和页面相对链接解析结果一致（真源唯一） */
const fs = require("fs");
const os = require("os");
const path = require("path");
const cp = require("child_process");

let fails = 0;
let checks = 0;
function ok(cond, msg) {
  checks++;
  if (cond) console.log("  ok    " + msg);
  else {
    fails++;
    console.log("FAIL  " + msg);
  }
}
const read = (rel) =>
  fs.readFileSync(path.join(__dirname, "..", rel.split("/").join(path.sep)), "utf8");
const show = (v) => JSON.stringify(v);
const eqNum = (a, b, msg) => ok(a === b, msg + "（得到 " + a + "，期望 " + b + "）");
const eqArr = (a, b, msg) => ok(show(a) === show(b), msg + "（得到 " + show(a) + "）");
const has = (text, needle) => text.indexOf(needle) >= 0;
const countOf = (text, needle) => text.split(needle).length - 1;
const absent = (text, needle) => !has(text, needle);

/* ===================== [1] 两页存在且自包含 ===================== */
console.log("\n[1] 中英两页存在、非空、单文件自包含");
const ZH_REL = "web/privacy/index.html";
const EN_REL = "web/privacy/en/index.html";
for (const rel of [ZH_REL, EN_REL]) {
  ok(fs.existsSync(path.join(__dirname, "..", rel.split("/").join(path.sep))), rel + " 存在");
}
const ZH = read(ZH_REL);
const EN = read(EN_REL);
ok(ZH.length > 8000, "中文页非空（" + ZH.length + " 字符）");
ok(EN.length > 8000, "英文页非空（" + EN.length + " 字符）");
ok(/<html lang="zh-CN">/.test(ZH), "中文页 lang=zh-CN");
ok(/<html lang="en">/.test(EN), "英文页 lang=en");
for (const [label, t] of [["中文页", ZH], ["英文页", EN]]) {
  ok(has(t, "<meta charset=\"UTF-8\">"), label + "：声明 UTF-8 字符集");
  ok(has(t, '<meta name="viewport"'), label + "：有 viewport（手机审核员也打得开）");
  ok(/<title>[^<]{6,}<\/title>/.test(t), label + "：<title> 非空");
  ok(has(t, '<meta name="description"'), label + "：有 meta description");
  ok(has(t, '<meta name="robots" content="index, follow"'), label + "：robots 允许收录（提审链接需可访问）");
  ok(!has(t, "<script"), label + "：零脚本（政策页不执行任何代码）");
  ok(!has(t, "src="), label + "：零 src（不加载任何外链资源）");
  ok(has(t, "</html>"), label + "：HTML 完整闭合");
}
/* 政策页自己的口径：这页不含脚本、不写 Cookie —— 与正文第 10 节的承诺对得上 */
ok(has(ZH, "本页是纯静态单文件") || has(ZH, "纯静态单文件"), "中文页声明自身为纯静态单文件");
ok(has(EN, "plain static single file"), "英文页声明自身为纯静态单文件");

/* ===================== [2] 章节骨架逐位对齐 ===================== */
console.log("\n[2] 章节骨架：15 节、id 与编号逐位对齐");
const idsOf = (t) => [...t.matchAll(/<section id="([a-z]+)"/g)].map((m) => m[1]);
const numsOf = (t) => [...t.matchAll(/<h2>(\d+)\./g)].map((m) => Number(m[1]));
const zhIds = idsOf(ZH);
const enIds = idsOf(EN);
eqNum(zhIds.length, 15, "中文页 15 个章节");
eqNum(enIds.length, 15, "英文页 15 个章节");
eqArr(enIds, zhIds, "中英 section id 与顺序完全一致（镜像页不额外发明章节）");
eqArr(
  numsOf(ZH),
  [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  "中文页 h2 编号连续 1..15（交叉引用依赖它）",
);
eqArr(numsOf(EN), numsOf(ZH), "英文页 h2 编号与中文版一致");
/* 交叉引用：正文里写的「第 N 节」必须落在 1..15 内 */
for (const [label, t] of [["中文页", ZH], ["英文页", EN]]) {
  const refs = [...t.matchAll(/第 (\d+) 节|section (\d+)\)/g)].map((m) => Number(m[1] || m[2]));
  eqArr(
    [...new Set(refs)].filter((n) => !(n >= 1 && n <= 15)).sort(),
    [],
    label + "：所有「第 N 节」交叉引用都在 1..15 内",
  );
}
/* 页内锚点必须有落点：#id 指向的 section 存在 */
for (const [label, t] of [["中文页", ZH], ["英文页", EN]]) {
  const anchors = [...t.matchAll(/href="#([a-z]+)"/g)].map((m) => m[1]);
  ok(anchors.length >= 5, label + "：顶部导航有锚点（" + anchors.length + " 个）");
  eqArr(
    [...new Set(anchors)].filter((a) => !idsOf(t).includes(a)),
    [],
    label + "：每个页内锚点都能跳到实际章节",
  );
}

/* ===================== [3] 两页互链 ===================== */
console.log("\n[3] 中英互链与回下载页");
ok(has(ZH, 'href="./en/"'), "中文页指向英文版 ./en/");
ok(has(EN, 'href="../"'), "英文页指回中文版 ../");
ok(has(ZH, 'href="../"'), "中文页指向下载页 ../");
ok(has(EN, 'href="../../"'), "英文页指向下载页 ../../");
for (const [label, t] of [["中文页", ZH], ["英文页", EN]]) {
  eqArr(
    [...new Set([...t.matchAll(/href="(https?:\/\/[^"]+)"/g)].map((m) => m[1]))].filter(
      (u) => !u.startsWith("https://github.com/shaomang/mtnode-aio/issues"),
    ),
    [],
    label + "：唯一的站外链接是 GitHub Issues（站内一律用相对路径）",
  );
}

/* ===================== [4] 无占位残渣 / 无邮箱 ===================== */
console.log("\n[4] 无占位残渣、无编造邮箱");
for (const [label, t] of [["中文页", ZH], ["英文页", EN]]) {
  for (const bad of ["TODO", "FIXME", "XXX", "PLACEHOLDER", "{{", "待填", "待补", "占位", "example.com", "yourdomain", "lorem"]) {
    ok(!new RegExp(bad, "i").test(t), label + "：无「" + bad + "」残留");
  }
  const emails = [...t.matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g)].map((m) => m[0]);
  eqArr(emails, [], label + "：没有任何邮箱地址（全仓不存在邮箱，不得编造）");
  ok(absent(t, "mailto:"), label + "：无 mailto: 链接");
  ok(has(t, "https://github.com/shaomang/mtnode-aio/issues"), label + "：联系渠道为 GitHub Issues");
  ok(/(未发布任何邮箱|no e-mail address)/i.test(t), label + "：明文说明本项目不提供邮箱");
}

/* ===================== [5] 必备章节关键词 ===================== */
console.log("\n[5] 必备要点关键词（中 / EN 各自齐全）");
const ZH_KW = [
  "隐私政策", "生效日期", "遥测", "埋点", "广告", "Cookie", "客户端 IP", "User-Agent",
  "API Key", "保留期", "删除", "未成年人", "政策变更", "联系方式", "创意工坊", "讨论区",
  "本地后端", "Agent 网关", "桌宠", "网络接收", "不出售", "明文", "80 端口", "访问日志",
  "阿里云", "MCP", "纯净模式", "第三方",
];
const EN_KW = [
  "privacy policy", "effective", "telemetry", "analytics", "advertis", "cookie",
  "ip address", "user-agent", "api key", "retention", "delet", "minor", "policy change",
  "contact", "workshop", "forum", "back-end", "agent gateway", "desktop-pet",
  "network receive", "no sale", "port 80", "access log", "alibaba", "mcp", "pure", "third-part",
];
for (const k of ZH_KW) ok(has(ZH, k), "中文页含要点「" + k + "」");
for (const k of EN_KW)
  ok(EN.toLowerCase().indexOf(k) >= 0, "英文页含要点 " + k);

/* ===================== [6] 政策口径三条红线 ===================== */
console.log("\n[6] 清单 §7 的三条禁用语不得出现在页面上");
for (const [label, t] of [["中文页", ZH], ["英文页", EN]]) {
  const low = t.toLowerCase();
  const banned = [
    "不收集任何个人信息",
    "不会收集任何个人信息",
    "绝不收集任何",
    "不采集任何数据",
    "无账号体系",
    "没有账号体系",
    "全程加密",
    "所有传输均加密",
    "does not collect any",
    "never collect any",
    "no data leaves",
    "there is no account",
    "end-to-end encrypt",
    "encrypted at all times",
  ];
  for (const b of banned) {
    ok(low.indexOf(b.toLowerCase()) < 0, label + "：未写「" + b + "」（与实际出网行为矛盾）");
  }
  /* 反过来：三处「敏感但真实」必须写 */
  ok(/只监听 80|port 80 only|listens on port 80/i.test(t), label + "：如实写出当前仅 HTTP、未开 443");
  ok(/无自助注销|no self-service|自助注销|self-service/i.test(t), label + "：如实写出账号无自助注销入口");
  ok(/有账号|需要账号|account is optional|only .*需要账号|only.*account/i.test(t), label + "：如实写出商店/讨论区有可选账号");
  ok(has(t, "0.0.0.0"), label + "：交代「网络接收」节点监听全部网卡");
  ok(/桌宠|desktop-pet/i.test(t), label + "：交代桌宠的全局输入监听");
  ok(/纯净模式|pure mode/i.test(t), label + "：交代 Agent 预设与纯净模式");
}

/* ===================== [7] 数据去向 ↔ 事实清单 ===================== */
console.log("\n[7] 页面每条数据去向都能在 docs/privacy-data-inventory.md 找到锚点");
const INV = read("docs/privacy-data-inventory.md");
/* c = 页面上的说法；inv = 清单里的对应锚点（省略即与 c 同字面）；where = 需要覆盖的页面 */
const CLAIMS = [
  /* 留在本机（政策页第 3 节表格） */
  { c: "%APPDATA%" },
  { c: "pipeline-console" },
  { c: "config.json" },
  { c: "save-backups" },
  { c: "config-backups" },
  { c: "trash/" },
  { c: "dsh-home/sessions" },
  /* 会话轮次回滚已移除：页面只在「旧版本残留副本」那句里提 rollback，清单同口径 */
  { c: "rollback/", inv: "rollback/" },
  { c: "dsh-home/attachments" },
  { c: "settings.yaml" },
  { c: "MTNODE_KEY_1", inv: "MTNODE_KEY_n" },
  { c: ".anonymous-user-id" },
  { c: "data-root.json" },
  { c: "IndexedDB" },
  { c: "error.log" },
  { c: "FTS5" },
  { c: "app-plugins/" },
  { c: "forum/" },
  { c: "store-cache/" },
  { c: "logs/crash-reports" },
  { c: "note: API keys and secrets are NOT included." },
  { c: "MachineGuid" },
  /* 出网到第三方服务商（第 4 节） */
  { c: "api.deepseek.com" },
  { c: "deepseek-harness/" },
  { c: "x-deepseek-harness-user-id" },
  { c: "x-deepseek-harness-session-id" },
  { c: "api.siliconflow.cn", where: "en" },
  /* 出网到 mt-agent.com（第 5、6 节） */
  { c: "mt-agent.com" },
  { c: "/mtnode/store-api" },
  { c: "/mtnode/updates" },
  { c: "/mtnode/plugins/catalog.json" },
  { c: "/mtnode/ext/catalog.json" },
  { c: "/mtnode/music3" },
  { c: "MTNodeAIO/1.1" },
  { c: "latest.yml" },
  { c: "scrypt" },
  { c: "Authorization: Bearer" },
  { c: "tzOffset" },
  { c: "X-Real-IP" },
  { c: "combined" },
  { c: "/api/logout" },
  { c: "oss-cn-beijing.aliyuncs.com" },
  /* 本地后端与在线源（第 7 节） */
  { c: "download.pytorch.org" },
  { c: "mirrors.aliyun.com" },
  { c: "modelscope.cn" },
  { c: "hf-mirror.com" },
  { c: "huggingface.co" },
  { c: "registry.npmmirror.com" },
  { c: "data.jsdelivr.com" },
  /* 保留期数字（第 12 节） */
  { c: "30 天", where: "zh" },
  { c: "约 14 天", where: "zh" },
  { c: "每 5 分钟", where: "zh" },
  { c: "72 份", where: "zh" },
  { c: "30 days", inv: "30 天", where: "en" },
  { c: "14 days", inv: "约 14 天", where: "en" },
  { c: "5 minutes", inv: "每 5 分钟", where: "en" },
  { c: "72 most recent", inv: "72", where: "en" },
];
const PAGES = { zh: ZH, en: EN };
for (const cl of CLAIMS) {
  const where = cl.where || "both";
  const pages = where === "both" ? ["zh", "en"] : [where];
  for (const p of pages) {
    ok(has(PAGES[p], cl.c), "[" + p + "] 页面写法「" + cl.c + "」存在");
  }
  ok(has(INV, cl.inv || cl.c), "清单里有锚点「" + (cl.inv || cl.c) + "」（正文不脱节于代码）");
}
/* 反向：页面上出现的每一个主机名都必须在清单里有一行，防止正文偷偷加目的地 */
const TLDS = ["com","cn","org","net","io","dev","ai","cc","co","me","us","uk","jp","info","xyz","top","one","app","tech","eu"];
for (const [label, t] of [["中文页", ZH], ["英文页", EN]]) {
  const hosts = new Set();
  for (const m of t.matchAll(/\b(?:https?:\/\/)?((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,})\b/gi)) {
    const h = m[1].toLowerCase();
    if (TLDS.includes(h.split(".").pop())) hosts.add(h);
  }
  const ungrounded = [...hosts].filter((h) => !INV.includes(h));
  ok(hosts.size >= 10, label + "：解析出主机名 " + hosts.size + " 个");
  eqArr(ungrounded, [], label + "：每个主机名都能在清单里找到（无未经核对的目的地）");
}
/* 清单的禁忌同样要求清单自己有依据：每节都要有「证据」列（文件:行号） */
ok(countOf(INV, ".js:") + countOf(INV, ".mjs:") + countOf(INV, ".py:") >= 20, "清单里带 file:line 证据 ≥20 处");

/* ===================== [8] patch-nginx-privacy.py 幂等（真实 main，临时 conf） ===================== */
console.log("\n[8] scripts/patch-nginx-privacy.py 幂等（离线，不碰生产配置）");
const PATCH_PY = "scripts/patch-nginx-privacy.py";
ok(fs.existsSync(path.join(__dirname, "..", PATCH_PY.split("/").join(path.sep))), PATCH_PY + " 存在");
const NEEDLE_LINE = "    # === MTNode AI编排器 下载页（带 Content-Disposition 隐藏头）===";
const CONF_BASE = [
  "http {",
  "  server {",
  "    listen 80;",
  "    server_name mt-agent.com;",
  "",
  "    location ^~ /mtnode/store-api/ { proxy_pass http://127.0.0.1:8788/; }",
  "",
  NEEDLE_LINE,
  "    location /mtnode/ {",
  "        alias /var/www/mtnode/;",
  "        add_header Content-Disposition 'attachment';",
  "    }",
  "",
  "    location ~ ^/mtnode/(.*)$ {",
  "        proxy_pass https://mtnode-download.oss-cn-beijing.aliyuncs.com/$1;",
  "    }",
  "  }",
  "}",
  "",
].join("\n");
const ALREADY = CONF_BASE.replace(
  NEEDLE_LINE,
  [
    "    location ^~ /mtnode/privacy/ {",
    "        alias /var/www/mtnode/privacy/;",
    "        default_type text/html;",
    "    }",
    "",
    NEEDLE_LINE,
  ].join("\n"),
);
const NO_NEEDLE = CONF_BASE.replace(NEEDLE_LINE, "    # === 别的站点 ===");

const DRIVER = String.raw`
import contextlib
import importlib.util
import io
import json
import shutil
import sys
import tempfile
from pathlib import Path

script, out_path = sys.argv[1], sys.argv[2]
sys.dont_write_bytecode = True  # 不把 __pycache__ 落到源文件旁边
cases = json.loads(Path(sys.argv[3]).read_text(encoding="utf-8"))
results = {}


def load():
    spec = importlib.util.spec_from_file_location("mtnode_patch_privacy", script)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


for name, case in cases.items():
    d = Path(tempfile.mkdtemp(prefix="mtnode-privacy-"))
    conf = d / "mt-ai-router.conf"
    original = Path(case["fixture"]).read_text(encoding="utf-8")
    conf.write_text(original, encoding="utf-8")
    mod = load()
    mod.CONF_PATHS = (str(conf),)
    mod.ENABLED = d / "sites-enabled" / "mt-ai-router.conf"  # 故意不存在
    runs = []
    for _ in range(int(case["runs"])):
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf), contextlib.redirect_stderr(buf):
            rc = mod.main()
        runs.append({"rc": rc, "out": buf.getvalue(), "text": conf.read_text(encoding="utf-8")})
    results[name] = {
        "runs": runs,
        "changed": bool(runs) and runs[-1]["text"] != original,
        "backups": sorted(p.name for p in d.iterdir() if ".bak-privacy" in p.name),
    }
    shutil.rmtree(d, ignore_errors=True)  # 用例临时目录用完即删，不在 TEMP 里堆垃圾

Path(out_path).write_text(json.dumps(results, sort_keys=True), encoding="utf-8")
print("driver ok")
`;

let pyResult = null;
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mtnode-privacy-smoke-"));
try {
  fs.writeFileSync(path.join(tmpDir, "fresh.conf"), CONF_BASE, "utf8");
  fs.writeFileSync(path.join(tmpDir, "already.conf"), ALREADY, "utf8");
  fs.writeFileSync(path.join(tmpDir, "noneedle.conf"), NO_NEEDLE, "utf8");
  fs.writeFileSync(path.join(tmpDir, "driver.py"), DRIVER, "utf8");
  const cases = {
    fresh: { fixture: path.join(tmpDir, "fresh.conf"), runs: 2 },
    already: { fixture: path.join(tmpDir, "already.conf"), runs: 1 },
    noneedle: { fixture: path.join(tmpDir, "noneedle.conf"), runs: 1 },
  };
  fs.writeFileSync(path.join(tmpDir, "cases.json"), JSON.stringify(cases), "utf8");
  cp.execFileSync(
    process.env.MTNODE_TEST_PYTHON || "python",
    [
      path.join(tmpDir, "driver.py"),
      path.join(__dirname, "..", "scripts", "patch-nginx-privacy.py"),
      path.join(tmpDir, "result.json"),
      path.join(tmpDir, "cases.json"),
    ],
    { encoding: "utf8" },
  );
  pyResult = JSON.parse(fs.readFileSync(path.join(tmpDir, "result.json"), "utf8"));
} catch (e) {
  ok(false, "跑 patch-nginx-privacy.py 失败（python 不可用？）：" + String(e.message).slice(0, 160));
}
if (pyResult) {
  const PRIV_LOC = "location ^~ /mtnode/privacy/";
  const SLASH_LOC = "location = /mtnode/privacy";
  const fresh = pyResult.fresh;
  eqNum(fresh.runs.length, 2, "fresh：真的跑了两次 main()");
  eqNum(fresh.runs[0].rc, 0, "fresh：第一次插入退出码 0");
  const t1 = fresh.runs[0].text;
  eqNum(countOf(t1, PRIV_LOC), 1, "fresh：第一次后 ^~ location 恰好一条");
  eqNum(countOf(t1, SLASH_LOC), 1, "fresh：第一次后无斜杠 302 恰好一条");
  ok(t1.indexOf(PRIV_LOC) < t1.indexOf(NEEDLE_LINE.trim()), "fresh：插在下载页注释之前（不被下载页的隐藏头段吞掉）");
  ok(t1.indexOf(SLASH_LOC) < t1.indexOf(NEEDLE_LINE.trim()), "fresh：302 那条也在下载页注释之前");
  ok(has(t1, "alias /var/www/mtnode/privacy/;"), "fresh：alias 指向 /var/www/mtnode/privacy/");
  eqArr(fresh.backups, ["mt-ai-router.conf.bak-privacy"], "fresh：写前生成且只生成一份 .bak-privacy");
  const t2 = fresh.runs[1].text;
  eqArr(t2, t1, "fresh：第二次跑对文件零改动（幂等）");
  eqNum(fresh.runs[1].rc, 0, "fresh：第二次跑退出码仍是 0（部署链可重复执行）");
  ok(/already present/i.test(fresh.runs[1].out), "fresh：第二次跑报告 already present");
  eqNum(countOf(t2, PRIV_LOC), 1, "fresh：两遍之后 ^~ location 仍只有一条（没有重复叠加）");
  eqNum(fresh.runs.length, 2, "fresh：未产生第三条 location 的第三次运行需求");
  const already = pyResult.already;
  eqNum(already.runs[0].rc, 0, "already：配置里已有该 location → 退出 0");
  ok(/already present/i.test(already.runs[0].out), "already：打印 already present");
  eqNum(already.changed ? 1 : 0, 0, "already：文件未被改写");
  eqArr(already.backups, [], "already：不改写就不留备份");
  const noneedle = pyResult.noneedle;
  eqNum(noneedle.runs[0].rc, 1, "noneedle：找不到下载页锚点 → 非零退出（不瞎插）");
  eqNum(noneedle.changed ? 1 : 0, 0, "noneedle：拒绝写入，配置文件原样");
  eqArr(noneedle.backups, [], "noneedle：没写入也就不产生备份");
  ok(/needle not found/i.test(noneedle.runs[0].out), "noneedle：错误信息说明锚点未找到");
}

/* ===================== [9] 部署链常量与 location 内容 ===================== */
console.log("\n[9] 部署链：patch 脚本 / 上传脚本 / npm script 同源");
const patchSrc = read(PATCH_PY);
ok(has(patchSrc, 'MARKER = "location ^~ /mtnode/privacy/"'), "patch：幂等判据就是 ^~ location 本身");
ok(has(patchSrc, 'NEEDLE = "# === MTNode AI编排器 下载页"'), "patch：锚点为服务器上的下载页注释");
ok(has(patchSrc, 'BACKUP_SUFFIX = ".bak-privacy"'), "patch：备份后缀 .bak-privacy");
ok(has(patchSrc, "default_type text/html;"), "patch：政策页显式 text/html");
/* 只查真正插进 nginx 的那两段（BLOCK 头部注释里出现「无 Content-Disposition」字样是说明，不是配置） */
const insertedLocs = ((patchSrc.match(/BLOCK = """([\s\S]*?)"""/) || [])[1] || "")
  .split("\n")
  .filter((l) => !/^\s*#/.test(l))
  .join("\n");
ok(insertedLocs.length > 40, "patch：取出真正插入 nginx 的配置体（" + insertedLocs.length + " 字符）");
ok(absent(insertedLocs, "Content-Disposition"), "patch：插入的配置不带 Content-Disposition（政策页不是下载附件）");
eqNum(countOf(insertedLocs, "add_header"), 1, "patch：插入的配置只有一个 add_header");
ok(has(insertedLocs, 'add_header Cache-Control "no-cache";'), "patch：唯一的 add_header 是 no-cache（改政策页即时生效）");
ok(has(patchSrc, 'return 302 /mtnode/privacy/;'), "patch：无斜杠路径 302 到有斜杠");

const upSrc = read("scripts/upload-privacy.py");
const alias = (patchSrc.match(/alias ([^;]+);/) || [])[1] || "";
const remote = (upSrc.match(/REMOTE = "([^"]+)"/) || [])[1] || "";
const norm = (p) => p.replace(/\/+$/, "");
eqNum(norm(alias), norm(remote), "上传目标目录与 nginx alias 同一个路径（拼错位就打不开）");
ok(alias.endsWith("/") && remote.startsWith(norm(alias)), "patch：alias 两端带斜杠（家族约定：location 与 alias 都要以 / 结尾）");
ok(has(upSrc, '"/mtnode/privacy/"') && has(upSrc, '"/mtnode/privacy"'), "上传脚本自检覆盖两个 URL（目录页 + 无斜杠 302）");
ok(has(upSrc, "Content-Disposition") && has(upSrc, "text/html"), "上传脚本验证 Content-Type 与无下载头");
ok(has(upSrc, "nginx -t") && has(upSrc, "systemctl reload nginx"), "上传脚本：nginx -t 通过才 reload");
ok(has(upSrc, "bak-privacy") && has(upSrc, "cp -a"), "上传脚本：nginx -t 失败用备份还原");
ok(has(upSrc, "AutoAddPolicy") && has(upSrc, "MTNODE_SFTP_JSON"), "上传脚本：凭据沿用家族约定（sftp.json / MTNODE_SSH_*）");
ok(has(upSrc, "--upload-only") && has(upSrc, "--patch-only"), "上传脚本：两阶段开关存在");

const pkg = JSON.parse(read("package.json"));
const deploy = (pkg.scripts && pkg.scripts["deploy:privacy"]) || "";
ok(has(deploy, "--upload-only"), "package.json：deploy:privacy 先上传");
ok(deploy.indexOf("--upload-only") < deploy.indexOf("--patch-only"), "package.json：deploy:privacy 顺序为上传 → patch");
eqArr(
  (deploy.match(/[\w./-]+\.py/g) || []).map((f) => path.basename(f)).filter((f) => f !== "upload-privacy.py"),
  [],
  "package.json：deploy:privacy 只调本家族的 scripts/upload-privacy.py（不自创发布流程）",
);
ok(/python scripts\/upload-privacy\.py --upload-only && python scripts\/upload-privacy\.py --patch-only/.test(deploy), "package.json：deploy:privacy 就是「上传 → patch」两步串联");

/* ===================== [10] URL 真源一致 ===================== */
console.log("\n[10] 文档 / README 的 URL 与页面相对链接解析一致");
const doc = read("docs/msix-store-publish.md");
const README = read("README.md");
const BASE_URL = "http://mt-agent.com/mtnode/privacy/";
const EN_URL = "http://mt-agent.com/mtnode/privacy/en/";
const baseIdx = doc.indexOf("## 3. 上传与版本规则");
const upgradeIdx = doc.indexOf("### 3.2");
ok(baseIdx > 0 && upgradeIdx > baseIdx, "文档：§3 与 §3.2（HTTPS 升级前置）都在");
ok(new RegExp("\\n" + BASE_URL.replace(/[./]/g, (c) => "\\" + c) + "\\n").test(doc), "文档：§3 把提审 URL 单列成一行（可直接复制进 Partner Center）");
ok(has(doc, EN_URL), "文档：登记英文版线上地址 " + EN_URL);
ok(has(doc, "deploy:privacy"), "文档：写明重跑方式 npm run deploy:privacy");
ok(has(doc, "location ^~ /mtnode/privacy/"), "文档：给出必须带 ^~ 的 location 片段");
ok(has(doc, "x-oss-request-id") || has(doc, "oss"), "文档：解释 ^~ 与 OSS 正则抢路由的关系");
const httpsInDoc = [...doc.matchAll(/https:\/\/mt-agent\.com\/mtnode\/privacy/g)].map((m) => m.index);
eqArr(
  httpsInDoc.filter((i) => i < upgradeIdx),
  [],
  "文档：https 写法只出现在 §3.2「升级后待办」里（不与现状口径矛盾）",
);
ok(has(README, BASE_URL), "README：数据与隐私小节链接到同一个 URL 真源");
ok(has(README, "web/privacy"), "README：指明政策正文源文件目录");
ok(absent(README, "https://mt-agent.com"), "README：不出现尚不存在的 https 链接");
const agents = read("AGENTS.md");
ok(has(agents, "/var/www/mtnode/privacy/"), "AGENTS.md：目录约定登记云端落盘路径");
ok(has(agents, "web/"), "AGENTS.md：云端服务一行含 web/");

/* 相对链接解析：页面自己写的相对路径，拼上部署基址必须正好等于文档登记的 URL */
function resolveHref(baseDir, href) {
  const parts = baseDir.split("/").filter(Boolean);
  for (const seg of href.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  return "/" + parts.join("/") + (href.endsWith("/") ? "/" : "");
}
const ZH_BASE = new URL(BASE_URL).pathname; /* /mtnode/privacy/ —— 提审 URL 的路径就是部署目录根 */
const EN_BASE = resolveHref(ZH_BASE, "./en/");
eqNum(ZH_BASE, "/mtnode/privacy/", "解析：中文页部署基址");
eqNum(EN_BASE, "/mtnode/privacy/en/", "解析：英文页部署基址");
eqNum("http://mt-agent.com" + resolveHref(ZH_BASE, "./en/"), EN_URL, "中文页 ./en/ 解析结果 == 文档登记的英文线上地址");
eqNum("http://mt-agent.com" + resolveHref(EN_BASE, "../"), BASE_URL, "英文页 ../ 解析结果 == 提审 URL 真源");
ok(
  ["http://mt-agent.com" + resolveHref(ZH_BASE, "../"), "http://mt-agent.com" + resolveHref(EN_BASE, "../../")].every(
    (u) => u === "http://mt-agent.com/mtnode/",
  ),
  "两页的回下载页相对链接都落在 http://mt-agent.com/mtnode/",
);
/* 提审 URL 的路径段与 nginx location、上传脚本 PATHS 完全一致 */
ok(has(patchSrc, "location ^~ " + ZH_BASE), "patch：location 路径 == 提审 URL 的路径");
ok(has(upSrc, '"/mtnode/privacy/"'), "上传脚本：自检路径 == 提审 URL 的路径");

/* ---------- 家族既有自检：六个 patch-nginx 脚本语法齐全（本任务新增的那个也不例外） ---------- */
console.log("\n[extra] patch-nginx 家族语法自检（只解析源码，不落 __pycache__、不执行脚本）");
const FAMILY = [
  "ext-repo/patch-nginx.py",
  "scripts/patch-nginx-h3.py",
  "scripts/patch-nginx-music3.py",
  "scripts/patch-nginx-privacy.py",
  "scripts/patch-nginx-updates.py",
  "store-saas/patch-nginx.py",
];
/* 用 compile() 而不是 py_compile：后者会在源文件旁生成 __pycache__（仓库未忽略它） */
const SYNTAX_CODE =
  "import sys; compile(open(sys.argv[1], encoding='utf-8').read(), sys.argv[1], 'exec')";
for (const rel of FAMILY) {
  let good = false;
  let why = "";
  try {
    cp.execFileSync(
      process.env.MTNODE_TEST_PYTHON || "python",
      ["-c", SYNTAX_CODE, path.join(__dirname, "..", rel.split("/").join(path.sep))],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    good = true;
  } catch (e) {
    why = String(e.message).slice(0, 120);
  }
  ok(good, rel + " 语法通过" + (why ? "（" + why + "）" : ""));
}

try {
  fs.rmSync(tmpDir, { recursive: true, force: true });
} catch (e) {
  /* 临时目录清不掉不影响结论 */
}

console.log("\n———— " + (checks - fails) + "/" + checks + " 通过 ————");
if (fails) {
  console.log(fails + " 项失败");
  process.exit(1);
}
console.log("全部通过");
