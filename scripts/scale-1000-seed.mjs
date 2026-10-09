/* scripts/scale-1000-seed.mjs — 给「1000 条目录」验证造数据（本地沙箱 / 生产隔离实例）
 * ============================================================================
 * 用法（Node ≥18，零依赖）：
 *   node scripts/scale-1000-seed.mjs --base http://127.0.0.1:18790 --user ms2308 --pass xxx
 *   node scripts/scale-1000-seed.mjs --base ... --apps 1000 --versions 3 --branches 200 --shots 100
 *   node scripts/scale-1000-seed.mjs --base ... --clean          # 先删自己名下的应用再重造
 *   node scripts/scale-1000-seed.mjs --dry-run                   # 只打印要发的请求
 *
 * 形状（默认，与 docs/reports/scale-1000-verification.md 的口径一致）：
 *   · apps 1000 条，每条 3 个版本（多版本模式）；
 *   · 其中 branches 条（默认 200）额外用**另一个账号**同 id 上架一次 = 同 id 多作者分支（family）；
 *   · 其中 shots 条（默认 100）带 2 张上架截图；
 *   · 应用包是**内置最小 zip**（entry=index.html，约 300B），不占磁盘 —— 这轮验的是
 *     「1000 条目录下的列表 / 发布 / 存储路径」，不是包体积（包体积由 MAX_ACCOUNT_APP_BYTES 管）。
 *
 * 为什么批量造：1000 个包真走 24MB 上传在生产机（剩 5G 盘）上不可行，真机全流程由
 *   scripts/scale-1000-load.mjs 之外的「真机发布 1~2 个」环节单独验证（见报告）。
 * 配额提醒：服务端每账号 MAX_ACCOUNT_APPS=5 / 50MB。所以批量造数要求：
 *   · 每账号最多 5 条 → 脚本自动把 --apps 摊到多个账号上（默认每账号 5 条）；
 *   · 账号不存在时用 --register 让脚本先注册（沙箱里短信是假的，注册不花钱）。
 * ========================================================================== */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

/* ---------- 命令行 ---------- */
function arg(name, dflt) {
  const i = process.argv.indexOf("--" + name);
  if (i < 0) return dflt;
  const v = process.argv[i + 1];
  return v && !v.startsWith("--") ? v : true;
}
const BASE = String(arg("base", process.env.MTNODE_STORE_URL || "http://127.0.0.1:18790")).replace(/\/+$/, "");
const APPS = Number(arg("apps", 1000)) || 1000;
const VERSIONS = Math.max(1, Number(arg("versions", 3)) || 3);
const BRANCHES = Math.max(0, Number(arg("branches", 200)) || 0);
const SHOTS = Math.max(0, Number(arg("shots", 100)) || 0);
const PER_ACCOUNT = Math.max(1, Number(arg("per-account", 5)) || 5);
const USER = String(arg("user", process.env.MTNODE_STORE_USER || ""));
const PASS = String(arg("pass", process.env.MTNODE_STORE_PASS || ""));
const DRY = !!arg("dry-run", false);
const CLEAN = !!arg("clean", false);
const TAG = String(arg("tag", "scale1000") || "scale1000");

/* ---------- 最小 zip（单条 entry=index.html） ---------- */
function crc32(buf) {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}
function makeZip(html) {
  const body = Buffer.from(String(html), "utf8");
  const name = Buffer.from("index.html", "utf8");
  const crc = crc32(body);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0, 6);
  local.writeUInt16LE(0, 8);
  local.writeUInt16LE(0, 10);
  local.writeUInt16LE(0, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(body.length, 18);
  local.writeUInt32LE(body.length, 22);
  local.writeUInt16LE(name.length, 26);
  local.writeUInt16LE(0, 28);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0, 8);
  central.writeUInt16LE(0, 10);
  central.writeUInt16LE(0, 12);
  central.writeUInt16LE(0, 14);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(body.length, 20);
  central.writeUInt32LE(body.length, 24);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt32LE(0, 42 - 4);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + name.length, 12);
  end.writeUInt32LE(local.length + name.length + body.length, 16);
  return Buffer.concat([local, name, body, central, name, end]);
}
const ZIP_B64 = makeZip(
  '<!doctype html><html><head><meta charset="utf-8"><title>scale probe</title></head><body><h1>scale probe</h1></body></html>',
).toString("base64");

async function apiBase() {
  if (!DRY) {
    try {
      const r = await fetch(BASE + "/api/apps/pub");
      if (r.status) return BASE;
    } catch (_) {}
    /* 生产：nginx 前缀 /mtnode/store-api */
    for (const b of [BASE + "/mtnode/store-api"]) {
      try {
        const r = await fetch(b + "/api/apps/pub");
        if (r.status) return b;
      } catch (_) {}
    }
  }
  return BASE;
}

async function api(base, method, p, body, token) {
  const headers = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (token) headers.authorization = "Bearer " + token;
  if (DRY) {
    console.log("[dry] " + method + " " + p + (body ? " body=" + JSON.stringify(body).slice(0, 120) : ""));
    return { status: 200, data: { ok: true } };
  }
  const r = await fetch(base + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  let data = null;
  try {
    data = await r.json();
  } catch (_) {}
  return { status: r.status, data: data || {} };
}

async function main() {
  const base = await apiBase();
  console.log("[seed] 基址 " + base + " · apps=" + APPS + " versions=" + VERSIONS + " branches=" + BRANCHES + " shots=" + SHOTS);

  /* 账号池：每账号最多 PER_ACCOUNT 条（服务端 MAX_ACCOUNT_APPS 的硬上限） */
  const authorsNeeded = Math.max(1, Math.ceil(APPS / PER_ACCOUNT));
  const authors = [];
  if (USER && PASS) authors.push({ user: USER, pass: PASS });
  console.log("[seed] 需要作者账号 " + authorsNeeded + " 个（每账号最多 " + PER_ACCOUNT + " 条）");
  if (authors.length < authorsNeeded) {
    console.log(
      "[seed] 注意：只给了 " + authors.length + " 个账号，也只能造 " + authors.length * PER_ACCOUNT +
        " 条。要造满请用 --per-account 提高上限（需服务端同步放开 MAX_ACCOUNT_APPS），" +
        "或在沙箱里预置多个作者账号（脚本读 --author user:pass 多次传入）。",
    );
  }
  /* --authors-file：每行 user:pass 或 user（后者按 --author-pass-template 生成密码）。
     1000 条目录要 260 个账号，命令行塞 520 个参数不现实，所以给一个文件入口。 */
  const authorsFile = String(arg("authors-file", "") || "");
  const passTpl = String(arg("author-pass-template", "") || "");
  if (authorsFile && fs.existsSync(authorsFile)) {
    const lines = fs.readFileSync(authorsFile, "utf8").split("\n").map((x) => x.trim()).filter(Boolean);
    for (const line of lines) {
      if (line.indexOf(":") > 0) {
        const [u, pw] = line.split(":");
        if (u && pw && !authors.some((a) => a.user === u)) authors.push({ user: u, pass: pw });
        continue;
      }
      if (!passTpl) continue;
      const pw = passTpl.indexOf("{n}") >= 0 ? passTpl.replace("{n}", String(Number(String(line).split("-").pop()) || 0)) : passTpl;
      if (line && pw && !authors.some((a) => a.user === line)) authors.push({ user: line, pass: pw });
    }
    console.log("[seed] --authors-file 读了 " + lines.length + " 行，可用账号 " + authors.length + " 个");
  }

  /* --author user:pass 可重复传入 */
  for (let i = 0; i < process.argv.length; i++) {
    if (process.argv[i] === "--author" && process.argv[i + 1]) {
      const [u, p] = String(process.argv[i + 1]).split(":");
      if (u && p && !authors.some((a) => a.user === u)) authors.push({ user: u, pass: p });
    }
  }

  /* --tokens-file：直接给票（跳过密码登录）。每行 "user token" 或只给 token。 */
  const tokensFile = String(arg("tokens-file", "") || "");
  const givenTokens = [];
  if (tokensFile && fs.existsSync(tokensFile)) {
    for (const line of fs.readFileSync(tokensFile, "utf8").split("\n")) {
      const t = line.trim();
      if (!t) continue;
      const parts = t.split(/\s+/);
      if (parts.length >= 2) givenTokens.push({ user: parts[0], token: parts[1] });
      else givenTokens.push({ user: "", token: parts[0] });
    }
    console.log("[seed] --tokens-file 读了 " + givenTokens.length + " 张票");
  }

  const tokens = givenTokens.length ? givenTokens.slice() : [];
  for (const a of givenTokens.length ? [] : authors) {
    if (DRY) {
      tokens.push({ user: a.user, token: "dry", uid: "dry-uid-" + a.user });
      continue;
    }
    const r = await api(base, "POST", "/api/login", { username: a.user, password: a.pass });
    if (r.status !== 200 || !r.data.token) {
      console.error("[seed] 登录失败：" + a.user + " " + JSON.stringify(r.data).slice(0, 200));
      process.exit(2);
    }
    tokens.push({ user: a.user, token: r.data.token, uid: (r.data.user && (r.data.user.id || r.data.user.userId)) || "" });
    /* 注：tokens-file 模式下 uid 为空 —— 分支声明的 forkOf.ownerId 会被服务端按主干兜底（见 server.mjs
       的「id 已被别人占用时自动落分支」），不影响「同 id 多作者分支」这件事本身。 */
  }
  console.log("[seed] 已登录作者 " + tokens.length + " 个");

  if (CLEAN && !DRY) {
    let removed = 0;
    for (const t of tokens) {
      /* 本轮两态口径（在线上 / 彻底删除）：没有「下架」这条可见性参数了 ——
         作者看自己名下那几条只靠 owner 过滤；上一次被删干净的 id 这里自然查不到，
         下面按同一个 id 重新上架即可（服务端把它当全新应用建起来）。 */
      const r = await api(base, "GET", "/api/apps?owner=" + encodeURIComponent(t.user) + "&pageSize=50", undefined, t.token);
      for (const it of r.data.items || []) {
        if (!String(it.id || "").startsWith(TAG)) continue;
        await api(base, "DELETE", "/api/apps/" + encodeURIComponent(it.id), undefined, t.token);
        removed++;
      }
    }
    console.log("[seed] 清理旧数据 " + removed + " 条");
  }

  /* 顺序：主作者轮流写；分支用下一个作者同 id 上架 */
  /* 每位作者最多 PER_ACCOUNT 条：主干与分支各要一个槽位，所以能造的上限 = 账号数 × PER_ACCOUNT */
  const capacity = tokens.length * PER_ACCOUNT;
  if (capacity < APPS + BRANCHES) {
    console.log(
      "[seed] 提示：账号容量 " + capacity + " 条 < 需要 " + (APPS + BRANCHES) + " 条（主干 " + APPS +
        " + 分支 " + BRANCHES + "）。请补 --author user:pass 或让沙箱多造账号（scripts/scale-1000-sandbox.mjs --authors）。",
    );
  }
  let made = 0;
  let branches = 0;
  let shots = 0;
  let fails = 0;
  let versionFails = 0;
  const t0 = Date.now();
  for (let i = 0; i < APPS; i++) {
    /* 账号槽位规划：主干占槽位 2*k，分支占槽位 2*k+1（第 k 个应用）。
       每个账号最多 PER_ACCOUNT 条 → 主干用 slot 0，分支用 slot 1，各自按 PER_ACCOUNT 分组。 */
    const slot = i % Math.max(1, tokens.length);
    const owner = tokens[slot];
    if (!owner) break;
    const id = TAG + "-" + String(i).padStart(4, "0");
    const title = "压测应用 " + i;
    const shotsList = i < SHOTS ? [mkShot(i, 1), mkShot(i, 2)] : [];
    let r = await api(
      base,
      "POST",
      "/api/apps",
      {
        id,
        title,
        description: "1000 条目录验证用的合成应用（无真实功能，只占目录条目）。",
        version: "1.0.0",
        entry: "index.html",
        tags: ["压测", i % 2 ? "离线" : "工具"],
        zipBase64: ZIP_B64,
        acceptDeclaration: true,
        /* 服务端口径：body.shotsBase64 = ["<base64 或 data:image/…;base64,…>", ...]，最多 8 张 */
        shotsBase64: shotsList,
      },
      owner.token,
    );
    if (r.status !== 200 && r.status !== 201) {
      /* BRANCH_EXISTS = 我名下已经有这个 id（上一次造过）→ 当作已造，不当失败 */
      if (r.data && r.data.code === "BRANCH_EXISTS") {
        made++;
      } else {
        fails++;
        if (fails <= 3) console.error("[seed] 上架失败 " + id + "：" + r.status + " " + JSON.stringify(r.data).slice(0, 200));
        continue;
      }
    } else {
      made++;
    }
    if (shotsList.length && (r.status === 200 || r.status === 201)) shots++;
    /* 追加版本 */
    for (let v = 2; v <= VERSIONS; v++) {
      const vr = await api(
        base,
        "POST",
        "/api/apps/" + encodeURIComponent(id) + "/versions",
        { version: "1.0." + (v - 1), zipBase64: ZIP_B64, acceptDeclaration: true },
        owner.token,
      );
      if (vr.status !== 200 && vr.status !== 201) {
        versionFails++;
        if (versionFails <= 3) console.error("[seed] 追加版本失败 " + id + " v1.0." + (v - 1) + "：" + vr.status + " " + JSON.stringify(vr.data).slice(0, 160));
      }
    }
    /* 同 id 多作者分支：换一个作者用同一个 id 再上架（服务端会归到同一家族） */
    if (i < BRANCHES && tokens.length > 1) {
      /* 分支换一位作者：优先取下一个账号，且不能和主干同账号（同 id 同作者 = 追加版本，不是分支） */
      const other =
        (tokens.length > 1 ? tokens[(slot + 1) % tokens.length] : null) ||
        (owner && String(owner.user) !== String(branchFallback.user) ? branchFallback : null);
      const rb = await api(
        base,
        "POST",
        "/api/apps",
        {
          id,
          title: title + "（分支）",
          description: "同 id 的另一位作者分支（家族 / fork 场景）。",
          version: "1.0.0",
          entry: "index.html",
          zipBase64: ZIP_B64,
          acceptDeclaration: true,
          forkOf: { id: id, ownerId: owner.uid || "" },
        },
        other.token,
      );
      if (rb.status === 200 || rb.status === 201) branches++;
      else if (branches + fails <= 3) console.error("[seed] 分支失败 " + id + "：" + rb.status + " " + JSON.stringify(rb.data).slice(0, 160));
    }
    if ((i + 1) % 100 === 0) {
      const sec = ((Date.now() - t0) / 1000).toFixed(1);
      console.log("[seed] 进度 " + (i + 1) + "/" + APPS + " · 应用 " + made + " · 分支 " + branches + " · 截图 " + shots + " · " + sec + "s");
    }
  }
  const sec = ((Date.now() - t0) / 1000).toFixed(1);
  console.log("[seed] 完成：应用 " + made + " · 分支 " + branches + " · 带截图 " + shots + " · 失败 " + fails + " · 用时 " + sec + "s");
  if (!DRY) {
    const r = await fetch(base + "/api/apps/catalog");
    const txt = await r.text();
    console.log("[seed] 目录条目数 " + (JSON.parse(txt).apps || []).length + " · 字节 " + Buffer.byteLength(txt) + " · 用时 " + sec + "s");
    /* 造数阶段静态目录是「攒着」的（MTNODE_APPS_PUBLISH=manual）：这里调一次全量重发，
       把「1000 条目录下一次完整发布要多久」这个数字量出来（= 单次应用变更 P95 的分母）。 */
    /** 管理台票：直接给（沙箱注入的 adm_ 票）或账号密码换（换不到就跳过重发）。 */
    const adminToken = String(arg("admin-token", "") || "");
    const admin = { user: String(arg("admin", "") || ""), pass: String(arg("admin-pass", "") || "") };
    let admTok = adminToken;
    if (!admTok && admin.user && admin.pass) {
      const lr = await api(base, "POST", "/api/login", { username: admin.user, password: admin.pass });
      if (lr.status === 200 && lr.data.token) admTok = "SID:" + lr.data.token;
      else console.error("[seed] 管理员登录失败（普通会话换不到管理台票，跳过全量重发）：" + JSON.stringify(lr.data).slice(0, 160));
    }
    if (admTok) {
      {
        /* 普通会话票（SID: 前缀）走不了 /api/admin/*（那只认 adm_ 票）—— 明确说清而不是静默失败 */
        if (admTok.indexOf("SID:") === 0) {
          console.error("[seed] 只有普通会话票、没有管理台 adm_ 票：跳过全量重发（请用 --admin-token 传沙箱注入的 adm_ 票）");
          admTok = "";
        }
      }
      if (admTok) {
        const t0p = Date.now();
        const pr = await api(base, "POST", "/api/admin/content/republish", {}, admTok);
        const ms = Date.now() - t0p;
        const res = pr.data && pr.data.result;
        console.log(
          "[seed] 静态目录全量发布：" + (pr.status === 200 ? "成功" : "失败 " + pr.status) + " · " + ms + "ms · 应用 " +
            ((res && res.apps) != null ? res.apps : "?") + " · 文件 " + ((res && res.files) != null ? res.files : "?") +
            " · 清理 " + ((res && res.removed && res.removed.length) || 0),
        );
        const pub = await api(base, "GET", "/api/apps/pub", undefined, undefined);
        if (pub.data && pub.data.gzip) {
          console.log(
            "[seed] 静态目录体积：catalog.json " + pub.data.gzip.catalogBytes + "B · gzip " + pub.data.gzip.catalogGzBytes +
              "B（比 " + pub.data.gzip.ratio + "） · staticGzipReady=" + pub.data.gzip.staticGzipReady,
          );
        }
      }
    }
  }
}

function mkShot(i, n) {
  /* 1×1 PNG（上架截图，只验静态落盘与目录字段，不验画质） */
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
    "base64",
  );
  return png.toString("base64");
}

main().catch((e) => {
  console.error("[seed] 失败：" + ((e && e.stack) || e));
  process.exit(1);
});
