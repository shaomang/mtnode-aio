/* 服务端「PATCH /api/apps/:id 编辑截图」冒烟 —— 零依赖，`node store-saas/smoke-app-edit-shots.mjs`
 *
 * 真起一个 server.mjs（临时 DATA_DIR / 端口，绝不动仓库里的 data/ 与 apps/），用真 HTTP 走一遍：
 *   [0] 夹具自检：PNG 夹具真被服务端认图（长边 2800 → 2560，APP_SHOT_MAX_EDGE），否则下面全是假绿
 *   [1] 未传 shotsBase64 → 截图完全不动（只改标题也不该把截图弄丢）
 *   [2] shotsBase64 = [] → 清空这一分支的全部截图
 *   [3] 非空数组 → 整批替换，顺序 = 数组顺序（拖拽排序靠它）
 *   [4] 不合格整批 400：>8 张 / 非图格式 / 空串 / 非数组 / 元素为 null|数字 → 且**不改库**
 *   [5] 混合形态 { keep: n }：保留旧图 + 增删 + 重排；未被 keep 的旧图被删；越界 / 非整数整批 400 且旧图一张没动
 *   [6] 多分支：只改自己那条分支的截图，别人的不受影响；回执 item.shots = 我这条分支的
 *   [7] acceptDeclaration 前置：没勾选声明时截图一个字节都不动（与其它字段同一条纪律）
 *   [8] publishStaticApps：静态目录 shots/ 与 catalog.json 都带上新截图
 *   [9] 源码级卡口：shots 按 a.userId 取（不是主干）、校验先于落盘、先读齐旧图再整目录重写
 *
 * 为什么需要一个真服务：这三态 + keep 的语义全在路由的编排层（校验顺序 / 落盘时机 / 分支归属），
 * 纯函数切片测不出「路由有没有把 shotsGiven 接上」「keep 读的是不是落盘前那批文件」。
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const PORT = 18987 + (process.pid % 200);
const BASE = "http://127.0.0.1:" + PORT;

let pass = 0;
let fail = 0;
function ok(cond, label) {
  if (cond) {
    pass++;
    console.log("  ✓ " + label);
  } else {
    fail++;
    console.log("  ✗ " + label);
  }
}
function section(t) {
  console.log("\n" + t);
}

/* ── 临时数据目录（跑完就删；绝不碰仓库里的 data/ 与 apps/） ── */
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "mtnode-smoke-edit-shots-"));
const DATA_DIR = path.join(TMP, "data");
const WEB_DIR = path.join(TMP, "web");
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(WEB_DIR, { recursive: true });

/** 与 server.mjs 的 hashPass 同一口径（scrypt 32 字节 hex）。 */
function hashPass(password, salt) {
  return crypto.scryptSync(String(password), salt, 32).toString("hex");
}
function user(id, username, pass) {
  const salt = crypto.randomBytes(8).toString("hex");
  return {
    id,
    username,
    nickname: username + "（昵称）",
    avatar: "",
    salt,
    pass: hashPass(pass, salt),
    phone: "",
    phoneVerifiedAt: 0,
    wechatOpenId: "",
    wechatUnionId: "",
    wechatBoundAt: 0,
    passwordChangedAt: 0,
    createdAt: Date.now(),
    downloadsReceived: 0,
    likesReceived: 0,
    balanceCents: 0,
  };
}
const U = {
  a: user("u_aaaaaaaaaaaaaaa1", "shot-a", "pass-a-123"),
  b: user("u_bbbbbbbbbbbbbbb2", "shot-b", "pass-b-123"),
};
fs.writeFileSync(
  path.join(DATA_DIR, "db.json"),
  JSON.stringify(
    {
      users: [U.a, U.b],
      sessions: [],
      identities: [],
      templates: [],
      skills: [],
      apps: [],
      appDeclarations: [],
      likes: [],
      skillLikes: [],
      forumTopics: [],
      forumReplies: [],
      tips: [],
      comments: [],
      notifications: [],
      rechargeOrders: [],
      rechargeLedger: [],
      adminSessions: [],
      relayUsage: [],
      relayConfig: null,
      relayAudit: [],
      contentAudit: [],
    },
    null,
    0,
  ),
  "utf8",
);

/* ── 一个合法的应用 zip（顶层 index.html） ── */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
/** 极简 store 模式 zip：只放一个 index.html（服务端只校验顶层有入口页）。 */
function makeZip(html) {
  const name = Buffer.from("index.html", "utf8");
  const body = Buffer.from(html, "utf8");
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
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(body.length, 20);
  central.writeUInt32LE(body.length, 24);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt32LE(0, 42);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + name.length, 12);
  end.writeUInt32LE(local.length + name.length + body.length, 16);
  return Buffer.concat([local, name, body, central, name, end]);
}
const ZIP_B64 = makeZip("<!doctype html><html><body>smoke</body></html>").toString("base64");

/* ── 真 PNG 夹具（8 位 RGB，逐行 filter 0 + zlib）—— 服务端 thumb.mjs 认得这种图，
 *    所以 decodeAppShots 的压缩分支真的会跑起来（长边 > 2560 → changed=true）。 ── */
function pngOf(w, h, rgb) {
  const stride = w * 3 + 1;
  const raw = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) {
    const o = y * stride;
    raw[o] = 0;
    for (let x = 0; x < w; x++) {
      raw[o + 1 + x * 3] = rgb[0];
      raw[o + 2 + x * 3] = rgb[1];
      raw[o + 3 + x * 3] = rgb[2];
    }
  }
  const chunk = (type, data) => {
    const out = Buffer.alloc(8 + data.length + 4);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, "latin1");
    data.copy(out, 8);
    out.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, "latin1"), data])), 8 + data.length);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; /* 位深 */
  ihdr[9] = 2; /* colorType = RGB */
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
/** 一张夹具截图（base64）。长边 2800 > 2560（APP_SHOT_MAX_EDGE），逼服务端走「压缩」那一支。 */
function shotB64(w, h, rgb) {
  return pngOf(w, h, rgb).toString("base64");
}
const SHOT = {
  s1: shotB64(2800, 1600, [220, 30, 30]), /* 红，压后 2560×1463 */
  s2: shotB64(2800, 2000, [30, 200, 60]), /* 绿，压后 2560×1829（用尺寸区分是哪一张） */
  s3: shotB64(2800, 1600, [40, 60, 230]), /* 蓝 */
  s4: shotB64(2800, 2000, [240, 220, 20]), /* 黄 */
};
const SIZE = { s1: "2560x1463", s2: "2560x1829", s3: "2560x1463", s4: "2560x1829" };
/** 读盘上某个文件的 PNG 尺寸（服务端压缩的产物，用来认出「这一张是谁」） */
function dimsOf(file) {
  const b = fs.readFileSync(file);
  return b.readUInt32BE(16) + "x" + b.readUInt32BE(20);
}
/** 某分支当前 第 1..n 张 的尺寸串（例如 "2560x1829|2560x1463" = [s2, s1]） */
function diskDims(id, ownerId) {
  const dir = path.join(DATA_DIR, "app-shots", id + "__" + ownerId);
  return diskShots(id, ownerId).map((n) => dimsOf(path.join(dir, n)));
}

/* ── 服务端进程 ── */
const srv = spawn(process.execPath, [path.join(HERE, "server.mjs")], {
  cwd: ROOT,
  env: Object.assign({}, process.env, {
    PORT: String(PORT),
    DATA_DIR,
    MTNODE_APPS_WEB_DIR: WEB_DIR,
    MTNODE_ACCOUNT_STORE: "json",
    MTNODE_APP_VERSIONS: "1",
    MTNODE_RECHARGE_CLOSED: "",
  }),
  stdio: ["ignore", "pipe", "pipe"],
});
let srvLog = "";
srv.stdout.on("data", (d) => (srvLog += String(d)));
srv.stderr.on("data", (d) => (srvLog += String(d)));

async function waitUp(ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const r = await fetch(BASE + "/api/apps");
      if (r.status) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

async function req(method, p, body, token) {
  const headers = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (token) headers.authorization = "Bearer " + token;
  const r = await fetch(BASE + p, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try {
    data = await r.json();
  } catch {}
  return { status: r.status, data: data || {} };
}
async function login(name, pass) {
  const r = await req("POST", "/api/login", { username: name, password: pass });
  if (r.status !== 200 || !r.data.token) throw new Error("登录失败：" + name + " " + JSON.stringify(r.data));
  return r.data.token;
}
/** 上架：带 shotsBase64（可空数组） */
function upload(token, id, title, shots) {
  const body = { acceptDeclaration: true, zipBase64: ZIP_B64, entry: "index.html", title, version: "1.0.0" };
  if (shots !== undefined) body.shotsBase64 = shots;
  return req("POST", "/api/apps", Object.assign({ id }, body), token);
}
/** PATCH 更新（shots 三态：undefined = 键都不传） */
function patch(token, id, body, owner) {
  const q = owner ? "?owner=" + encodeURIComponent(owner) : "";
  return req("PATCH", "/api/apps/" + id + q, Object.assign({ acceptDeclaration: true }, body), token);
}
function shotsOf(res) {
  return (res.data && res.data.item && res.data.item.shots) || null;
}
function names(res) {
  return (shotsOf(res) || []).map((x) => String(x).split("/").pop()).join(",");
}
/** 目录里某作者那条分支的 shots */
async function catalogShots(id, ownerId) {
  const cat = await req("GET", "/api/apps");
  const rows = (cat.data.items || cat.data.apps || []).filter(
    (x) => x.id === id && String(x.ownerId) === String(ownerId),
  );
  return rows.length === 1 ? rows[0].shots || [] : null;
}
/** 某分支截图目录里真实落了几个文件（服务端落盘口径，独立于接口回执） */
function diskShots(id, ownerId) {
  const dir = path.join(DATA_DIR, "app-shots", id + "__" + ownerId);
  try {
    return fs.readdirSync(dir).filter((n) => /^\d+\.(png|jpe?g|webp)$/i.test(n)).sort();
  } catch {
    return [];
  }
}

async function main() {
  const up = await waitUp(20000);
  if (!up) throw new Error("服务端没起来：\n" + srvLog.slice(-2000));

  const ta = await login("shot-a", "pass-a-123");
  const tb = await login("shot-b", "pass-b-123");

  /* ── [0] 夹具自检：两张 PNG 必须真能被服务端认成图（否则下面全是假绿） ── */
  section("[0] 夹具自检：上传 3 张 → 服务端真压缩 + 真落盘");
  const upA = await upload(ta, "shotapp", "截图演示", [SHOT.s1, SHOT.s2, SHOT.s3]);
  ok(upA.status === 200 && upA.data.ok === true, "A 上架 shotapp（带 3 张截图）成功");
  ok(
    Array.isArray(shotsOf(upA)) && shotsOf(upA).length === 3 && shotsOf(upA).every((r) => String(r).indexOf("/shotapp__" + U.a.id + "/") > 0),
    "回执 item.shots = 3 张本条分支的地址（顺序 = 上传顺序），实得 " + names(upA),
  );
  ok(diskShots("shotapp", U.a.id).join(",") === "1.png,2.png,3.png", "磁盘上确实落了 3 个文件（app-shots/<主干>/）");
  const onDisk = fs.readFileSync(path.join(DATA_DIR, "app-shots", "shotapp__" + U.a.id, "1.png"));
  ok(onDisk.length > 0 && onDisk[0] === 0x89 && onDisk[1] === 0x50, "落盘的是真 PNG（服务端认图成功，不是原样兜底）");
  ok(
    dimsOf(path.join(DATA_DIR, "app-shots", "shotapp__" + U.a.id, "1.png")) === SIZE.s1,
    "服务端真压过：1400×800 原图 → " + SIZE.s1 + "（长边收到 1280）",
  );
  ok(
    diskDims("shotapp", U.a.id).join("|") === [SIZE.s1, SIZE.s2, SIZE.s3].join("|"),
    "磁盘上的顺序 = 上传顺序（" + diskDims("shotapp", U.a.id).join("|") + "）",
  );

  /* ── [1] 未传 shotsBase64：截图完全不动 ── */
  section("[1] 未传 shotsBase64 → 截图完全不动");
  const p1 = await patch(ta, "shotapp", { title: "只改标题" });
  ok(p1.status === 200 && p1.data.ok === true, "只改标题的 PATCH 成功");
  ok(p1.data.item && p1.data.item.title === "只改标题", "标题确实改了");
  ok(names(p1) === "1.png,2.png,3.png", "未传 shotsBase64：item.shots 原样 3 张，实得 " + names(p1));
  ok(diskShots("shotapp", U.a.id).join(",") === "1.png,2.png,3.png", "磁盘上也是原样 3 个文件（没被清掉）");
  const p1b = await patch(ta, "shotapp", { shotsBase64: null });
  ok(names(p1b) === "1.png,2.png,3.png", "显式传 null（= 未传）同样不动截图，实得 " + names(p1b));

  /* ── [2] 空数组：清空 ── */
  section("[2] shotsBase64 = [] → 清空这一分支的全部截图");
  const p2 = await patch(ta, "shotapp", { shotsBase64: [] });
  ok(p2.status === 200 && p2.data.ok === true, "空数组 PATCH 成功");
  ok(Array.isArray(shotsOf(p2)) && shotsOf(p2).length === 0, "回执 item.shots = []（实得 " + names(p2) + "）");
  ok(diskShots("shotapp", U.a.id).length === 0, "磁盘上截图目录已清空");

  /* ── [3] 非空数组：整批替换 + 顺序 ── */
  section("[3] 非空数组 → 整批替换，顺序 = 数组顺序");
  const p3 = await patch(ta, "shotapp", { shotsBase64: [SHOT.s4, SHOT.s1] });
  ok(p3.status === 200 && p3.data.ok === true, "整批替换 PATCH 成功");
  ok(names(p3) === "1.png,2.png", "回执 2 张（旧的 3 张被整批替掉），实得 " + names(p3));
  ok(diskShots("shotapp", U.a.id).join(",") === "1.png,2.png", "磁盘只剩 2 个文件（无残留第 3 张）");
  const before = fs.readFileSync(path.join(DATA_DIR, "app-shots", "shotapp__" + U.a.id, "1.png"));
  const p3b = await patch(ta, "shotapp", { shotsBase64: [SHOT.s1, SHOT.s4] });
  const after = fs.readFileSync(path.join(DATA_DIR, "app-shots", "shotapp__" + U.a.id, "1.png"));
  ok(
    p3b.status === 200 && !before.equals(after),
    "对调两张顺序再 PATCH：第 1 张的字节真的换了（顺序 = 数组顺序，拖拽排序可用）",
  );

  /* ── [4] 不合格整批 400，且不改库 ── */
  section("[4] 不合格 → 整批 400 且不改库（校验先于落盘）");
  const snapShots = names(p3b);
  const snapDisk = diskShots("shotapp", U.a.id).join(",");
  const bad = [
    ["9 张（>8）", new Array(9).fill(SHOT.s1), /最多 8 张/],
    ["非图格式（纯文本）", ["aGVsbG8gd29ybGQ="], /截图无效|格式/],
    ["空字符串", [""], /为空|格式/],
    ["data: 前缀但内容不是图", ["data:image/png;base64,aGVsbG8="], /截图无效|格式/],
    ["非数组（字符串）", "not-an-array", /必须是数组/],
    ["非数组（对象）", { keep: 0 }, /必须是数组/],
    ["元素是 null", [null], /为空|格式/],
    ["元素是数字", [123], /截图无效|格式/],
  ];
  for (const [label, val, re] of bad) {
    const r = await patch(ta, "shotapp", { shotsBase64: val });
    ok(r.status === 400 && r.data.ok === false, label + " → 400（实得 " + r.status + " " + JSON.stringify(r.data.error || "") + "）");
    ok(re.test(String(r.data.error || "")), label + " → 错误文案沿用 POST 那条口径：" + JSON.stringify(r.data.error || ""));
    ok(Array.isArray(r.data.errors) && r.data.errors.length > 0, label + " → 回执带 errors[] 明细");
  }
  const p4 = await patch(ta, "shotapp", { title: "被拒的那次别改我", shotsBase64: [SHOT.s2, "bad", SHOT.s3] });
  ok(p4.status === 400, "混合批次（第 2 张坏）→ 整批 400（不落一半）");
  ok(
    /第 2 张/.test(String(p4.data.error || "")),
    "报错下标按客户端看到的项号（第 2 张），实得 " + JSON.stringify(p4.data.error || ""),
  );
  const after4 = await req("GET", "/api/apps/shotapp", undefined, ta);
  ok(
    names(after4) === snapShots && String(after4.data.item.title) === "只改标题",
    "被拒的那次：截图与标题都没改（库与内存都无半成品），实得 " + names(after4) + " / " + after4.data.item.title,
  );
  ok(diskShots("shotapp", U.a.id).join(",") === snapDisk, "被拒的那次：磁盘上的截图原样（" + snapDisk + "）");
  const p4b = await patch(ta, "shotapp", { shotsBase64: new Array(8).fill(SHOT.s1) });
  ok(p4b.status === 200 && shotsOf(p4b).length === 8, "边界：正好 8 张 = 合格（实得 " + p4b.status + "）");
  const p4c = await patch(ta, "shotapp", { shotsBase64: [SHOT.s1, SHOT.s3] });
  ok(p4c.status === 200 && shotsOf(p4c).length === 2, "回到 2 张，准备多分支断言");

  /* ── [5] 混合形态 { keep: n }：保留旧图 + 增删 + 拖拽排序 ── */
  section("[5] 混合数组（新图 + {keep:n}）：顺序、残留、越界");
  const p5 = await patch(ta, "shotapp", { shotsBase64: [SHOT.s2, { keep: 0 }, SHOT.s4] });
  ok(p5.status === 200 && p5.data.ok === true, "[新,keep0,新] PATCH 成功（实得 " + p5.status + " " + JSON.stringify(p5.data.error || "") + "）");
  ok(
    diskDims("shotapp", U.a.id).join("|") === [SIZE.s2, SIZE.s1, SIZE.s4].join("|"),
    "最终顺序 = 数组顺序：新图/沿用图各回原位（" + diskDims("shotapp", U.a.id).join("|") +
      "，期望 " + [SIZE.s2, SIZE.s1, SIZE.s4].join("|") + "）",
  );
  ok(
    diskShots("shotapp", U.a.id).join(",") === "1.png,2.png,3.png",
    "旧图里没被 keep 的（原来的第 2 张 s3）已被删掉，无残留（" + diskShots("shotapp", U.a.id).join(",") + "）",
  );
  const p5b = await patch(ta, "shotapp", { shotsBase64: [{ keep: 1 }, { keep: 0 }] });
  ok(p5b.status === 200 && shotsOf(p5b).length === 2, "[keep1,keep0] 纯沿用 + 对调顺序成功");
  ok(
    diskDims("shotapp", U.a.id).join("|") === [SIZE.s1, SIZE.s2].join("|"),
    "纯沿用也能重排（" + diskDims("shotapp", U.a.id).join("|") + "，期望 " + [SIZE.s1, SIZE.s2].join("|") + "）",
  );
  /* 边界：旧图正好 8 张时 keep 1 张 + 7 张新图 = 8 张（不得被「8 张上限」误伤） */
  const p5c = await patch(ta, "shotapp", { shotsBase64: new Array(8).fill(SHOT.s3) });
  ok(p5c.status === 200, "先铺 8 张（旧图 8 张）");
  const p5d = await patch(ta, "shotapp", {
    shotsBase64: [{ keep: 7 }].concat(new Array(7).fill(SHOT.s1)),
  });
  ok(p5d.status === 200 && shotsOf(p5d).length === 8, "keep 1 张 + 7 张新图 = 8 张（上限按最终张数算），实得 " + p5d.status);
  const p5e = await patch(ta, "shotapp", {
    shotsBase64: [{ keep: 0 }].concat(new Array(8).fill(SHOT.s1)),
  });
  ok(p5e.status === 400, "keep 1 张 + 8 张新图 = 9 张 → 400（不能靠 keep 绕过上限）");
  ok(diskShots("shotapp", U.a.id).length === 8, "被拒的那次：磁盘仍是 8 张");
  /* 越界 / 非整数：整批 400，且旧图一张没动 */
  const keepSnap = diskDims("shotapp", U.a.id).join("|");
  const keepBad = [
    ["越界 keep:8（旧图 8 张，可用 0..7）", [{ keep: 8 }], /越界/],
    ["越界 keep:99", [SHOT.s1, { keep: 99 }], /越界/],
    ["负数 keep:-1", [{ keep: -1 }], /整数/],
    ["非整数 keep:1.5", [{ keep: 1.5 }], /整数/],
    ["缺 keep 键", [{ n: 0 }], /整数/],
    ["keep 是字符串", [{ keep: "0" }], /整数/],
    ["越界在新图之后（第 2 项）", [SHOT.s1, { keep: 8 }], /第 2 张/],
  ];
  for (const [label, val, re] of keepBad) {
    const r = await patch(ta, "shotapp", { shotsBase64: val });
    ok(r.status === 400 && re.test(String(r.data.error || "")), label + " → 400 且文案点名：" + JSON.stringify(r.data.error || ""));
    ok(Array.isArray(r.data.errors) && r.data.errors.length > 0, label + " → 回执带 errors[] 明细");
  }
  ok(
    diskDims("shotapp", U.a.id).join("|") === keepSnap && diskShots("shotapp", U.a.id).length === 8,
    "keep 各种不合格时：旧图一张没动、一个字节没变（" + keepSnap + "）",
  );

  /* ── [6] 多分支：只改自己那条分支 ── */
  section("[6] 同 id 多分支：只改自己分支的截图，别人的不受影响");
  const pA0 = await patch(ta, "shotapp", { shotsBase64: [SHOT.s1, SHOT.s3] });
  ok(pA0.status === 200 && shotsOf(pA0).length === 2, "A 收回到 2 张（s1,s3）准备多分支断言");
  const upB = await upload(tb, "shotapp", "截图演示（B 分支）", [SHOT.s2]);
  ok(upB.status === 200 && upB.data.ok === true, "B 用同一个 id 上架（自动成为分支）成功");
  const bBefore = await catalogShots("shotapp", U.b.id);
  const aBefore = await catalogShots("shotapp", U.a.id);
  ok(JSON.stringify(bBefore) === JSON.stringify(["shots/shotapp__" + U.b.id + "/1.png"]), "B 分支目录里 1 张（" + JSON.stringify(bBefore) + "）");
  ok(aBefore.length === 2, "A 分支目录里 2 张（" + JSON.stringify(aBefore) + "）");

  const pA = await patch(ta, "shotapp", { shotsBase64: [SHOT.s1, SHOT.s2, SHOT.s3, SHOT.s4] });
  ok(pA.status === 200 && pA.data.item.shots.length === 4, "A 改成 4 张成功");
  ok(
    pA.data.item.shots.every((r) => String(r).indexOf("shotapp__" + U.a.id + "/") > 0),
    "回执 item.shots 是**我这条分支**的地址（不是主干 / 别人的），实得 " + JSON.stringify(pA.data.item.shots),
  );
  const bAfter = await catalogShots("shotapp", U.b.id);
  ok(JSON.stringify(bAfter) === JSON.stringify(bBefore), "B 分支截图完全没动（" + JSON.stringify(bAfter) + "）");
  ok(
    diskShots("shotapp", U.b.id).join(",") === "1.png" && diskShots("shotapp", U.a.id).length === 4,
    "磁盘：B 的 1 个文件仍在，A 的 4 个（各自目录互不干扰）",
  );
  /* keep 的下标只认自己分支：B 有 1 张，keep:1 在 B 上是越界 */
  const crossKeep = await patch(tb, "shotapp", { shotsBase64: [{ keep: 1 }] });
  ok(crossKeep.status === 400, "B 只 1 张截图时 keep:1 → 400（keep 下标按本条分支算，不借用别人的图）");
  ok(diskShots("shotapp", U.a.id).length === 4 && diskShots("shotapp", U.b.id).length === 1, "那次 400 后两条分支的截图都没动");
  const bKeep = await patch(tb, "shotapp", { shotsBase64: [{ keep: 0 }, SHOT.s4] });
  ok(bKeep.status === 200 && diskDims("shotapp", U.b.id).join("|") === [SIZE.s2, SIZE.s4].join("|"), "B 用自己那张 keep:0 + 1 张新图 → " + diskDims("shotapp", U.b.id).join("|"));
  ok(diskDims("shotapp", U.a.id).length === 4, "B 的操作没有碰 A 的 4 张");
  const pBclear = await patch(tb, "shotapp", { shotsBase64: [] });
  ok(pBclear.status === 200 && shotsOf(pBclear).length === 0, "B 清空自己的截图成功");
  ok(
    (await catalogShots("shotapp", U.a.id)).length === 4 && diskShots("shotapp", U.b.id).length === 0,
    "B 清空后 A 的 4 张毫发无损（清空只作用于本条分支）",
  );
  const cross = await patch(tb, "shotapp", { shotsBase64: [SHOT.s1] }, U.a.id);
  ok(cross.status === 403, "B 想改 A 的分支（?owner=A）→ 403（实得 " + cross.status + "）");
  ok(diskShots("shotapp", U.a.id).length === 4, "那次 403 之后 A 的截图仍是 4 张");

  /* ── [7] 声明前置：没勾选就不动截图 ── */
  section("[7] acceptDeclaration 前置校验（与其它字段同一条纪律）");
  const decl = await req("PATCH", "/api/apps/shotapp", { shotsBase64: [] }, ta);
  ok(decl.status === 400 && decl.data.ok === false, "不勾声明传 [] → 拒绝（实得 " + decl.status + " " + JSON.stringify(decl.data.code || decl.data.error || "") + "）");
  ok(diskShots("shotapp", U.a.id).length === 4, "截图一个字节都没动（仍 4 张）");
  const anon = await req("PATCH", "/api/apps/shotapp", { acceptDeclaration: true, shotsBase64: [] });
  ok(anon.status === 401, "未登录改截图 → 401（实得 " + anon.status + "）");

  /* ── [8] 静态目录同步 ── */
  section("[8] publishStaticApps：静态目录带上新截图");
  const webShotDir = path.join(WEB_DIR, "shots", "shotapp__" + U.a.id);
  const webShotAll = [];
  try {
    webShotAll.push(...fs.readdirSync(webShotDir));
  } catch {}
  /* 静态目录里除原图还会同步列表小图（<n>.list.<ext>，派生物）：对账只看原图 */
  let webFiles = webShotAll.filter((n) => !/\.list\./.test(n)).sort();
  ok(webFiles.length === 4, "静态目录 shots/shotapp__<A>/ 有 4 张原图（实得 " + webFiles.join(",") + "）");
  ok(
    webShotAll.filter((n) => /\.list\./.test(n)).length === 4,
    "静态目录里 4 张的列表小图也都在（实得 " + webShotAll.filter((n) => /\.list\./.test(n)).join(",") + "）",
  );
  const catDoc = JSON.parse(fs.readFileSync(path.join(WEB_DIR, "catalog.json"), "utf8"));
  const docRow = (catDoc.items || catDoc.apps || []).find(
    (x) => x.id === "shotapp" && String(x.ownerId) === String(U.a.id),
  );
  ok(docRow && (docRow.shots || []).length === 4, "静态 catalog.json 里 A 分支也带 4 张 shots");

  /* ── [9] 源码级卡口（纯函数层面看不见的接线） ── */
  section("[9] 源码级卡口：分支归属 + 校验先于落盘 + 先读后写");
  const src = fs.readFileSync(path.join(HERE, "server.mjs"), "utf8");
  const i0 = src.indexOf('if (appOne && method === "PATCH")');
  const i1 = src.indexOf('if (appOne && method === "DELETE")', i0);
  const block = i0 >= 0 && i1 > i0 ? src.slice(i0, i1) : "";
  ok(block.length > 0, "找到 PATCH /api/apps/:id 路由块（" + block.length + " 字符）");
  ok(/const shotsGiven = b\.shotsBase64 != null;/.test(block), "路由里有 shotsGiven 三态判据（键没传 = 不动）");
  ok(/resolveAppShotsEdit\(b\.shotsBase64, appShotFiles\(a\.id, a\.userId\)/.test(block), "路由用 resolveAppShotsEdit 解析混合数组，旧图按本条分支取");
  ok(
    block.indexOf("resolveAppShotsEdit(") < block.indexOf("storeShots("),
    "校验/解析出现在 storeShots / clearAppShots 之前（先全部校验、再落盘）",
  );
  ok(/storeShots\(a\.id, a\.userId, shotsNext\)/.test(block), "落盘用的是本条分支的 a.userId（不是 user.id / 主干）");
  ok(/clearAppShots\(a\.id, a\.userId\)/.test(block), "空数组走 clearAppShots（本条分支）");
  /* 函数体切片按**函数边界**取（原来是「切到下一个已知函数名」，中间新增函数就会把别人的代码
     算进这一段 —— 本轮就在 resolveAppShotsEdit 与 appShotsDiag 之间插了 appendAppShots）。 */
  const bodyOf = (name) => {
    const i = src.indexOf("function " + name + "(");
    if (i < 0) return "";
    let d = 0, str = "", started = false;
    for (let k = i; k < src.length; k++) {
      const c = src[k];
      if (str) { if (c === "\\") { k++; continue; } if (c === str) str = ""; continue; }
      if (c === '"' || c === "'" || c === "`") { str = c; continue; }
      if (c === "{") { d++; started = true; continue; }
      if (c === "}") { d--; if (started && d === 0) return src.slice(i, k + 1); }
    }
    return "";
  };
  const resBlock = bodyOf("resolveAppShotsEdit");
  ok(resBlock.length > 0, "找到 resolveAppShotsEdit 函数体（" + resBlock.length + " 字符）");
  ok(
    resBlock.indexOf("imgObjHoldAnyExt(k.sha)") > 0 && resBlock.indexOf("objPath: have.hold.path") > 0,
    "resolveAppShotsEdit 的旧图按内容指纹指回对象库里那一份（读发生在返回结果之前，整目录重写时旧内容已在对象库）",
  );
  ok(
    resBlock.indexOf("return { ok: false") > 0 && /Number\.isInteger\(n\)/.test(resBlock),
    "keep 的整数 / 越界判据在函数里（不合格回 ok:false 整批拒绝）",
  );
  ok(
    /list\.length > MAX_APP_SHOTS/.test(resBlock),
    "上限按最终张数算（keep + 新图混着数，不能靠 keep 绕过 8 张）",
  );
  ok(!/writeAppShots|fs\.writeFileSync/.test(resBlock), "resolveAppShotsEdit 只读不写（落盘仍归路由，失败绝不落一半）");
  /* 版本追加那条路（带 zip 的 PATCH / POST /versions）走 appendAppShots：**保留旧图 + 内容去重追加**。
     用户报障「上传截图后再更新，截图上那张就没了」的根因就是这里原来用整批替换。 */
  ok(
    block.indexOf("appendVersion") >= 0 && block.indexOf("appendAppShots(a.id, a.userId, dec.shots, a)") >= 0 &&
      /if \(appendVersion\)[\s\S]{0,400}appendAppShots/.test(block),
    "带 zip 的 PATCH（追加一版）走 appendAppShots：截图保留旧图，不再整批替换",
  );
  ok(
    !/if \(appendVersion\)[\s\S]{0,400}storeShots\(/.test(block),
    "追加一版那条分支里没有 storeShots 整批替换（整批替换只留给编辑窗那些带 keep 指代的请求）",
  );
  const apBlock = bodyOf("appendAppShots");
  ok(apBlock.length > 0, "找到 appendAppShots 函数体（" + apBlock.length + " 字符）");
  ok(
    /appShotEntriesOf\(id, ownerId, a\)/.test(apBlock) && /have\.has\(h\)/.test(apBlock),
    "appendAppShots 按内容 sha256 去重（同一张图重复上传不会变成两张）",
  );
  ok(
    apBlock.indexOf("appShotEntriesOf(") < apBlock.indexOf("writeShotAliases("),
    "appendAppShots 先读旧图算哈希、再写新图（不覆盖、不重排：第 1 张仍是封面）",
  );
  ok(
    /entries\.length \+ add\.length > MAX_APP_SHOTS/.test(apBlock) && /ok: false/.test(apBlock),
    "appendAppShots 按**追加后的总数**卡 8 张上限（满了如实报错，绝不静默丢图）",
  );
  const catBlock = src.slice(src.indexOf("function appCatalogEntry(a)"), src.indexOf("function publicApp(a, viewer, en)"));
  ok(
    /shots: appShotRelsOf\(a\.id, a\.userId\)/.test(catBlock),
    "appCatalogEntry 的 shots 按 a.userId 取（多分支下 = 我这条分支，不是主干）",
  );
  ok(/publishStaticApps\(/.test(block), "PATCH 成功后照旧 publishStaticApps（静态目录带新截图）");

  console.log("\n" + (fail ? "✗ 失败 " + fail + " 项" : "✓ 全部通过") + "（通过 " + pass + " / 失败 " + fail + "）");
  return fail ? 1 : 0;
}

let code = 1;
try {
  code = await main();
} catch (e) {
  console.error("冒烟异常：" + (e && e.stack ? e.stack : e));
  console.error("服务端日志尾部：\n" + srvLog.slice(-3000));
  code = 1;
} finally {
  try {
    srv.kill();
  } catch {}
  await new Promise((r) => setTimeout(r, 300));
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {}
}
process.exit(code);
