/* test/smoke-account-store.mjs — 账户存储抽象层（json / 阿里云表格存储）零依赖回归
 * ============================================================================
 * 运行：node test/smoke-account-store.mjs
 *
 * 覆盖：
 *   [1] 后端解析 / 表格存储配置解析（resolveAccountStoreBackend / resolveOtsConfig）
 *   [2] 表格存储后端（mock OTS HTTP 服务，零依赖，仅替换 https.request）：
 *       · 每个请求的 SignV2 签名串与 x-ots-contentmd5 都按官方口径独立复算比对
 *       · 三张表 users / sessions / identities 的 CRUD、身份认领冲突、会话清理
 *       · GetRange 分批分页（next_start_primary_key 续读）
 *       · 写操作有限重试与最终上抛（5xx 重试、403 立即失败、data 非 JSON 上抛）
 *   [3] json 后端行为不变：同一套 CRUD 脚本在两种后端下产出逐字一致的日志；
 *       db.json 只接管 users / sessions / identities，其它键原样保留
 *   [4] server.mjs 接线（in-process，表格存储后端 + mock）：
 *       · 启动从云库载入账户缓存（种子用户 / 会话可直接 /api/me）
 *       · 短信登录建号「缓存写穿」：users / identities 真落到 mock 表
 *       · 多端并存：同账号二次登录不踢掉旧会话，两个 token 同时有效
 *       · 滑动续期：鉴权请求把剩余不足一半的会话推到 now + SESSION_MS 并写穿云库
 *       · 登出写穿删除会话
 *       · 云库报错时登录失败上抛，不出现「登录成功但没落库」
 *
 * 说明：mock 服务用测试自带的 PlainBuffer / protobuf 编解码（独立于 account-store.mjs
 * 的实现），只通过替换 https.request 接入，不监听真实端口、不联网、不产生费用。
 * ============================================================================
 */
"use strict";

import http from "node:http";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import https from "node:https";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  createAccountStore,
  resolveAccountStoreBackend,
  resolveOtsConfig,
  ACCOUNT_STORE_BACKENDS,
  SESSION_MS,
  INF_MIN,
  INF_MAX,
} from "../store-saas/account-store.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SERVER_MJS = path.join(ROOT, "store-saas", "server.mjs");

let checks = 0;
let fails = 0;
function ok(cond, msg) {
  checks++;
  if (cond) console.log("  ok  " + msg);
  else {
    fails++;
    console.log("FAIL  " + msg);
  }
}
function eq(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  ok(a === b, msg + (a === b ? "" : "\n        实际 " + a + "\n        期望 " + b));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function tmpDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mtnode-acct-" + tag + "-"));
}
function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const port = s.address().port;
      s.close(() => resolve(port));
    });
  });
}
function httpReq(port, method, p, { token, json } = {}) {
  return new Promise((resolve, reject) => {
    const body = json == null ? null : Buffer.from(JSON.stringify(json));
    const headers = { Accept: "*/*" };
    if (body) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = body.length;
    }
    if (token) headers.Authorization = "Bearer " + token;
    const req = http.request({ host: "127.0.0.1", port, method, path: p, headers }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let data = null;
        try {
          data = JSON.parse(text);
        } catch {
          data = null;
        }
        resolve({ status: res.statusCode, data, text });
      });
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

/* ========================================================================== *
 * 测试自带的 PlainBuffer / protobuf 最小实现（与 account-store.mjs 的实现相互独立）
 * ========================================================================== */

const PB = Object.freeze({
  HEADER: 0x75,
  TAG_ROW_PK: 0x01,
  TAG_ROW_DATA: 0x02,
  TAG_CELL: 0x03,
  TAG_CELL_NAME: 0x04,
  TAG_CELL_VALUE: 0x05,
  TAG_CELL_CHECKSUM: 0x0a,
  TAG_ROW_CHECKSUM: 0x09,
  TAG_DELETE_ROW_MARKER: 0x08,
  VT_INTEGER: 0x00,
  VT_DOUBLE: 0x01,
  VT_BOOLEAN: 0x02,
  VT_STRING: 0x03,
  VT_INF_MIN: 0x09,
  VT_INF_MAX: 0x0a,
});

function encodeVariant(value) {
  if (value === INF_MIN) return { vt: PB.VT_INF_MIN, payload: Buffer.alloc(0) };
  if (value === INF_MAX) return { vt: PB.VT_INF_MAX, payload: Buffer.alloc(0) };
  if (typeof value === "string") {
    const b = Buffer.from(value, "utf8");
    const len = Buffer.alloc(4);
    len.writeUInt32LE(b.length, 0);
    return { vt: PB.VT_STRING, payload: Buffer.concat([len, b]) };
  }
  if (typeof value === "boolean") return { vt: PB.VT_BOOLEAN, payload: Buffer.from([value ? 1 : 0]) };
  if (typeof value === "number") {
    const b = Buffer.alloc(8);
    const isInt = Number.isInteger(value) && Math.abs(value) < Number.MAX_SAFE_INTEGER;
    if (isInt) b.writeBigInt64LE(BigInt(value), 0);
    else b.writeDoubleLE(value, 0);
    return { vt: isInt ? PB.VT_INTEGER : PB.VT_DOUBLE, payload: b };
  }
  throw new Error("mock: 不支持的列类型 " + typeof value);
}

/** 写一个 cell（校验位固定 0：被测解码器只跳过校验字节，不做校验）。 */
function cellBytes(name, value) {
  const nb = Buffer.from(String(name), "utf8");
  const nLen = Buffer.alloc(4);
  nLen.writeUInt32LE(nb.length, 0);
  const enc = encodeVariant(value);
  const vLen = Buffer.alloc(4);
  vLen.writeUInt32LE(enc.payload.length + 1, 0);
  return Buffer.concat([
    Buffer.from([PB.TAG_CELL, PB.TAG_CELL_NAME]),
    nLen,
    nb,
    Buffer.from([PB.TAG_CELL_VALUE]),
    vLen,
    Buffer.from([enc.vt]),
    enc.payload,
    Buffer.from([PB.TAG_CELL_CHECKSUM, 0]),
  ]);
}

/** 编码一行的 PlainBuffer 行体（不含 4 字节 header）。 */
function encodeRowBody(pkName, pkValue, columns) {
  const out = [Buffer.from([PB.TAG_ROW_PK]), cellBytes(pkName, pkValue)];
  const cols = Object.entries(columns || {}).filter(([, v]) => v !== undefined);
  if (cols.length) {
    out.push(Buffer.from([PB.TAG_ROW_DATA]));
    for (const [n, v] of cols) out.push(cellBytes(n, v));
  }
  out.push(Buffer.from([PB.TAG_ROW_CHECKSUM, 0]));
  return Buffer.concat(out);
}

const PB_HEADER = (() => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(PB.HEADER, 0);
  return b;
})();

/** 编码一行 PlainBuffer（响应方向，含 header）。 */
function encodeRow(pkName, pkValue, columns) {
  return Buffer.concat([PB_HEADER, encodeRowBody(pkName, pkValue, columns)]);
}

/** 编码多行 PlainBuffer（GetRange 响应：整段只带一个 header）。 */
function encodeRows(pkName, rows) {
  return Buffer.concat([PB_HEADER, ...rows.map((r) => encodeRowBody(pkName, r.id, r.columns))]);
}

function readVariant(buf, pos) {
  const size = buf.readInt32LE(pos);
  pos += 4;
  const end = pos + size;
  const vt = buf[pos++];
  let value;
  if (vt === PB.VT_STRING) {
    const n = buf.readInt32LE(pos);
    pos += 4;
    value = buf.toString("utf8", pos, pos + n);
    pos += n;
  } else if (vt === PB.VT_INTEGER) {
    value = Number(buf.readBigInt64LE(pos));
    pos += 8;
  } else if (vt === PB.VT_DOUBLE) {
    value = buf.readDoubleLE(pos);
    pos += 8;
  } else if (vt === PB.VT_BOOLEAN) {
    value = buf[pos++] !== 0;
  } else if (vt === PB.VT_INF_MIN) {
    value = INF_MIN;
  } else if (vt === PB.VT_INF_MAX) {
    value = INF_MAX;
  } else {
    throw new Error("mock: 未知 variant 类型 " + vt);
  }
  return { value, pos: Math.max(pos, end) };
}

function readCell(buf, pos) {
  if (buf[pos++] !== PB.TAG_CELL_NAME) throw new Error("mock: cell 缺少 TAG_CELL_NAME");
  const n = buf.readInt32LE(pos);
  pos += 4;
  const name = buf.toString("utf8", pos, pos + n);
  pos += n;
  if (buf[pos++] !== PB.TAG_CELL_VALUE) throw new Error("mock: cell 缺少 TAG_CELL_VALUE");
  const v = readVariant(buf, pos);
  pos = v.pos;
  if (buf[pos] !== PB.TAG_CELL_CHECKSUM) throw new Error("mock: cell 缺少 TAG_CELL_CHECKSUM");
  pos += 2;
  return { name, value: v.value, pos };
}

/** 解码一行 PlainBuffer（请求方向），返回 { pk:{}, attrs:{} }。 */
function decodeRow(buf) {
  let pos = 0;
  if (buf.readUInt32LE(pos) !== PB.HEADER) throw new Error("mock: PlainBuffer header 非法");
  pos += 4;
  let tag = buf[pos++];
  const pk = {};
  const attrs = {};
  if (tag === PB.TAG_ROW_PK) {
    tag = buf[pos++];
    while (tag === PB.TAG_CELL) {
      const c = readCell(buf, pos);
      pk[c.name] = c.value;
      pos = c.pos;
      tag = buf[pos++];
    }
  }
  if (tag === PB.TAG_ROW_DATA) {
    tag = buf[pos++];
    while (tag === PB.TAG_CELL) {
      const c = readCell(buf, pos);
      attrs[c.name] = c.value;
      pos = c.pos;
      tag = buf[pos++];
    }
  }
  if (tag === PB.TAG_DELETE_ROW_MARKER) tag = buf[pos++];
  if (tag === PB.TAG_ROW_CHECKSUM) pos += 1;
  return { pk, attrs };
}

/* ---------- protobuf 信封 ---------- */

function pbVarint(n) {
  const out = [];
  let v = BigInt(n);
  while (v >= 0x80n) {
    out.push(Number(v & 0x7fn) | 0x80);
    v >>= 7n;
  }
  out.push(Number(v));
  return Buffer.from(out);
}
function pbBytesField(field, buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  return Buffer.concat([pbVarint((field << 3) | 2), pbVarint(b.length), b]);
}
function pbStringField(field, s) {
  return pbBytesField(field, Buffer.from(String(s), "utf8"));
}
function pbVarintField(field, n) {
  return Buffer.concat([pbVarint((field << 3) | 0), pbVarint(n)]);
}
function pbParse(buf) {
  const out = [];
  let pos = 0;
  const readVarint = () => {
    let shift = 0n;
    let result = 0n;
    for (;;) {
      const b = buf[pos++];
      result |= BigInt(b & 0x7f) << shift;
      if (!(b & 0x80)) break;
      shift += 7n;
    }
    return result;
  };
  while (pos < buf.length) {
    const key = readVarint();
    const field = Number(key >> 3n);
    const wire = Number(key & 7n);
    if (wire === 0) out.push({ field, wire, varint: readVarint() });
    else if (wire === 2) {
      const len = Number(readVarint());
      out.push({ field, wire, bytes: Buffer.from(buf.subarray(pos, pos + len)) });
      pos += len;
    } else throw new Error("mock: 不支持的 protobuf wire " + wire);
  }
  return out;
}
const pbFieldBytes = (fields, n) => {
  const hit = fields.find((f) => f.field === n && f.wire === 2);
  return hit ? hit.bytes : null;
};
const pbFieldVarint = (fields, n) => {
  const hit = fields.find((f) => f.field === n && f.wire === 0);
  return hit ? Number(hit.varint) : 0;
};

/* ========================================================================== *
 * mock 表格存储服务：内存三表 + 签名校验 + https.request 替换
 * ========================================================================== */

function createMockOts({ accessKeySecret = "SECRET_mock", instance = "mockinst", pkName = "id" } = {}) {
  const tables = new Map();
  const requests = [];
  let failure = null; // { spec, once }

  function table(name) {
    if (!tables.has(name)) tables.set(name, new Map());
    return tables.get(name);
  }

  function errXml(code, message) {
    return Buffer.from(
      '<?xml version="1.0" encoding="UTF-8"?><Error><Code>' +
        code +
        "</Code><Message>" +
        message +
        "</Message><RequestId>mock-req</RequestId></Error>",
      "utf8",
    );
  }

  function dispatch(options, body) {
    const operation = String(options.path || "/").replace(/^\/+/, "");
    const headers = Object.assign({}, options.headers);

    // 独立复算 SignV2 签名串与 Content-MD5（签名头自身不参与规范化头列表）
    const canonical = Object.keys(headers)
      .filter((k) => k.toLowerCase().startsWith("x-ots-") && k.toLowerCase() !== "x-ots-signature")
      .map((k) => k.toLowerCase())
      .sort()
      .map((k) => k + ":" + headers[Object.keys(headers).find((h) => h.toLowerCase() === k)])
      .join("\n");
    const stringToSign = "/" + operation + "\nPOST\n\n" + canonical + "\n";
    const rec = {
      operation,
      headers,
      body,
      stringToSign,
      sigOk:
        headers["x-ots-signature"] ===
        crypto.createHmac("sha1", accessKeySecret).update(stringToSign).digest("base64"),
      md5Ok: headers["x-ots-contentmd5"] === crypto.createHash("md5").update(body).digest("base64"),
    };
    requests.push(rec);

    const fields = pbParse(body);
    const tableName = pbFieldBytes(fields, 1) ? pbFieldBytes(fields, 1).toString("utf8") : "";
    rec.table = tableName;

    if (
      failure &&
      (!failure.spec.operation || failure.spec.operation === operation) &&
      (!failure.spec.table || failure.spec.table === tableName)
    ) {
      const f = failure.spec;
      if (failure.once) failure = null;
      return { status: f.status, headers: { "x-ots-request-id": "mock-fail" }, body: errXml(f.code, f.message || "mock failure") };
    }

    if (operation === "GetRow") {
      const row = decodeRow(pbFieldBytes(fields, 2));
      const hit = table(tableName).get(row.pk[pkName]);
      return { status: 200, headers: {}, body: hit ? pbBytesField(2, encodeRow(pkName, hit[pkName], hit.columns)) : Buffer.alloc(0) };
    }

    if (operation === "PutRow") {
      const row = decodeRow(pbFieldBytes(fields, 2));
      const id = row.pk[pkName];
      table(tableName).set(id, Object.assign({ [pkName]: id }, { columns: row.attrs }));
      return { status: 200, headers: {}, body: Buffer.alloc(0) };
    }

    if (operation === "DeleteRow") {
      const row = decodeRow(pbFieldBytes(fields, 2));
      table(tableName).delete(row.pk[pkName]);
      return { status: 200, headers: {}, body: Buffer.alloc(0) };
    }

    if (operation === "GetRange") {
      const startRow = decodeRow(pbFieldBytes(fields, 7));
      const start = startRow.pk[pkName];
      const limit = pbFieldVarint(fields, 6) || 500;
      let keys = [...table(tableName).keys()].sort();
      if (typeof start === "string") keys = keys.filter((k) => k >= start);
      const page = keys.slice(0, limit);
      const rowsBuf = page.length
        ? encodeRows(
            pkName,
            page.map((k) => ({ id: k, columns: table(tableName).get(k).columns })),
          )
        : Buffer.alloc(0);
      const out = [pbBytesField(2, rowsBuf)];
      if (keys.length > limit) out.push(pbBytesField(3, encodeRow(pkName, keys[limit], {})));
      return { status: 200, headers: {}, body: Buffer.concat(out) };
    }

    return { status: 400, headers: {}, body: errXml("InvalidOperation", "unknown " + operation) };
  }

  function fakeRequest(options, cb) {
    let body = Buffer.alloc(0);
    const handlers = {};
    const req = {
      on(ev, fn) {
        (handlers[ev] = handlers[ev] || []).push(fn);
        return req;
      },
      once(ev, fn) {
        return req.on(ev, fn);
      },
      setTimeout() {
        return req;
      },
      destroy(err) {
        setImmediate(() => (handlers.error || []).forEach((f) => f(err)));
        return req;
      },
      end(chunk) {
        if (chunk) body = Buffer.concat([body, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
        setImmediate(() => {
          let resp;
          try {
            resp = dispatch(options, body);
          } catch (e) {
            (handlers.error || []).forEach((f) => f(e));
            return;
          }
          const resHandlers = {};
          const res = { statusCode: resp.status, headers: resp.headers || {} };
          res.on = (ev, fn) => {
            (resHandlers[ev] = resHandlers[ev] || []).push(fn);
            return res;
          };
          cb(res);
          setImmediate(() => {
            if (resp.body && resp.body.length) (resHandlers.data || []).forEach((f) => f(resp.body));
            (resHandlers.end || []).forEach((f) => f());
          });
        });
        return req;
      },
    };
    return req;
  }

  return {
    tables,
    requests,
    request: fakeRequest,
    putRaw(tableName, id, columns) {
      table(tableName).set(id, Object.assign({ [pkName]: id }, { columns }));
    },
    size(tableName) {
      return table(tableName).size;
    },
    keys(tableName) {
      return [...table(tableName).keys()];
    },
    getRaw(tableName, id) {
      return table(tableName).get(id) || null;
    },
    failNext(spec) {
      failure = { spec, once: true };
    },
    failAlways(spec) {
      failure = { spec, once: false };
    },
    clearFailure() {
      failure = null;
    },
    ops(name) {
      return requests.filter((r) => r.operation === name).length;
    },
  };
}

const REAL_HTTPS_REQUEST = https.request;
function installMock(mock) {
  https.request = mock.request;
}
function restoreHttps() {
  https.request = REAL_HTTPS_REQUEST;
}

const OTS_CONFIG = (over = {}) =>
  Object.assign(
    {
      endpoint: "https://mock.ots.local",
      instance: "mockinst",
      accessKeyId: "AKID_mock",
      accessKeySecret: "SECRET_mock",
      tablePrefix: "mtnode_",
    },
    over,
  );

/* ========================================================================== *
 * [1] 后端 / 配置解析
 * ========================================================================== */

console.log("\n[1] 后端解析与表格存储配置");
eq(ACCOUNT_STORE_BACKENDS, ["json", "aliyun-tablestore"], "支持的后端集合固定");
eq(resolveAccountStoreBackend(""), "json", "空值默认 json");
eq(resolveAccountStoreBackend("json"), "json", "json 显式");
eq(resolveAccountStoreBackend("file"), "json", "file 别名 → json");
eq(resolveAccountStoreBackend("TABLESTORE"), "aliyun-tablestore", "别名 tablestore → aliyun-tablestore");
eq(resolveAccountStoreBackend("ots"), "aliyun-tablestore", "别名 ots → aliyun-tablestore");
let threw = "";
try {
  resolveAccountStoreBackend("redis");
} catch (e) {
  threw = e.message;
}
ok(/未知的 MTNODE_ACCOUNT_STORE/.test(threw), "未知后端直接抛错：" + threw);

threw = "";
try {
  resolveOtsConfig({});
} catch (e) {
  threw = e.message;
}
ok(/缺少配置/.test(threw) && /MTNODE_OTS_ENDPOINT/.test(threw), "缺配置抛错且列出缺失项：" + threw);

const cfgComposed = resolveOtsConfig({
  MTNODE_OTS_INSTANCE: "inst1",
  MTNODE_OTS_REGION: "cn-qingdao",
  MTNODE_OTS_ACCESS_KEY_ID: "ak",
  MTNODE_OTS_ACCESS_KEY_SECRET: "sk",
});
eq(cfgComposed.endpoint, "https://inst1.cn-qingdao.ots.aliyuncs.com", "instance + region 拼出 endpoint");
eq(cfgComposed.tablePrefix, "mtnode_", "默认表名前缀 mtnode_");
const cfgTrim = resolveOtsConfig({
  MTNODE_OTS_ENDPOINT: "https://x.ots.aliyuncs.com/",
  MTNODE_OTS_INSTANCE: "x",
  MTNODE_OTS_ACCESS_KEY_ID: "ak",
  MTNODE_OTS_ACCESS_KEY_SECRET: "sk",
  MTNODE_OTS_TABLE_PREFIX: "acct_",
});
eq(cfgTrim.endpoint, "https://x.ots.aliyuncs.com", "endpoint 末尾斜杠被去掉");
eq(cfgTrim.tablePrefix, "acct_", "自定义表名前缀生效");
threw = "";
try {
  createAccountStore({ backend: "bogus" });
} catch (e) {
  threw = e.message;
}
ok(/未知的 MTNODE_ACCOUNT_STORE/.test(threw), "createAccountStore 未知后端抛错");

/* ========================================================================== *
 * [2] 表格存储后端（mock）
 * ========================================================================== */

const stable = (v) => JSON.stringify(v, (k, val) => (k === "createdAt" ? "<ts>" : val));

async function runCrud(store) {
  const log = [];
  const rec = async (name, fn) => {
    try {
      const v = await fn();
      // 深拷贝快照：json 后端返回的是活引用，后续写会就地改掉它
      log.push([name, v === undefined ? v : JSON.parse(JSON.stringify(v))]);
    } catch (e) {
      log.push([name, "ERR:" + (e.code || e.message)]);
    }
  };
  const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

  await rec("create:u1", () => store.createUser({ id: "u1", username: "alice", nickname: "Alice", createdAt: 1000 }));
  await rec("create:u2", () => store.createUser({ id: "u2", username: "bob", createdAt: 1001 }));
  await rec("create:u3", () => store.createUser({ id: "u3", username: "carol", createdAt: 1002 }));
  await rec("get:u1", () => store.getUser("u1"));
  await rec("get:missing", () => store.getUser("nope"));
  await rec("byUsername:ALICE", () => store.getUserByUsername("ALICE"));
  await rec("update:u1", () => store.updateUser("u1", { nickname: "Alice2", downloadsReceived: 7 }));
  await rec("update:missing", () => store.updateUser("nope", { nickname: "x" }));
  await rec("listUsers", async () => (await store.listUsers()).slice().sort(byId));

  await rec("claim:phone1:u1", () => store.claimIdentity("phone", "+8613800000001", "u1"));
  await rec("claim:phone1:u1-again", () => store.claimIdentity("phone", "+8613800000001", "u1"));
  await rec("claim:phone1:conflict", () => store.claimIdentity("phone", "+8613800000001", "u2"));
  await rec("claim:phone2:u2", () => store.claimIdentity("phone", "+8613800000002", "u2"));
  await rec("claim:empty", () => store.claimIdentity("phone", "", "u1"));
  await rec("getIdentity", async () => {
    const e = await store.getIdentity("phone", "+8613800000001");
    return e && { kind: e.kind, value: e.value, userId: e.userId };
  });
  await rec("getUserByIdentity", async () => {
    const u = await store.getUserByIdentity("phone", "+8613800000002");
    return u && u.username;
  });
  await rec("listIdentities", async () =>
    (await store.listIdentities()).map((e) => e.kind + ":" + e.value + "->" + e.userId).sort(),
  );
  await rec("release:wrong-owner", () => store.releaseIdentity("phone", "+8613800000001", "u2"));
  await rec("release:u1", () => store.releaseIdentity("phone", "+8613800000001", "u1"));
  await rec("getIdentity:released", () => store.getIdentity("phone", "+8613800000001"));
  await rec("replaceIdentities", () =>
    store.replaceIdentities([{ kind: "phone", value: "+8613800000009", userId: "u3", createdAt: 5 }]),
  );
  await rec("listIdentities:afterReplace", async () =>
    (await store.listIdentities()).map((e) => e.kind + ":" + e.value + "->" + e.userId).sort(),
  );

  await rec("createSession:h1", () => store.createSession({ tokenHash: "h1", userId: "u1", expiresAt: 5000 }));
  await rec("createSession:h2", () => store.createSession({ tokenHash: "h2", userId: "u2", expiresAt: 4000 }));
  await rec("createSession:h3", () => store.createSession({ tokenHash: "h3", userId: "u1", expiresAt: 2 }));
  await rec("getSession", async () => {
    const s = await store.getSession("h1");
    return s && { tokenHash: s.tokenHash, userId: s.userId, expiresAt: s.expiresAt };
  });
  await rec("listSessions", async () => (await store.listSessions()).map((s) => s.tokenHash).sort());
  await rec("deleteSession:h1", () => store.deleteSession("h1"));
  await rec("deleteSession:h1-again", () => store.deleteSession("h1"));
  await rec("deleteSessionsByUser:u2", () => store.deleteSessionsByUser("u2"));
  await rec("pruneSessions", () => store.pruneSessions(6000));
  await rec("listSessions:end", async () => (await store.listSessions()).map((s) => s.tokenHash).sort());
  await rec("deleteUser:u3", () => store.deleteUser("u3"));
  await rec("deleteUser:u3-again", () => store.deleteUser("u3"));
  return log;
}

console.log("\n[2] 表格存储后端（mock OTS HTTP）");
{
  const mock = createMockOts();
  installMock(mock);
  const store = createAccountStore({ backend: "aliyun-tablestore", config: OTS_CONFIG() });
  await store.ready();
  const log = await runCrud(store);
  restoreHttps();

  ok(mock.requests.length > 0, "mock 收到了表格存储请求：" + mock.requests.length + " 次");
  ok(
    mock.requests.every((r) => r.sigOk),
    "每个请求的 x-ots-signature 都等于按官方 SignV2 复算的 HMAC-SHA1 签名",
  );
  ok(
    mock.requests.every((r) => r.md5Ok),
    "每个请求的 x-ots-contentmd5 都等于请求体 MD5（Base64）",
  );
  const r0 = mock.requests[0];
  eq(r0.headers["x-ots-apiversion"], "2015-12-31", "x-ots-apiversion 正确");
  eq(r0.headers["x-ots-instancename"], "mockinst", "x-ots-instancename 正确");
  ok(
    r0.stringToSign.startsWith("/" + r0.operation + "\nPOST\n\n") &&
      r0.stringToSign.includes("x-ots-apiversion:2015-12-31") &&
      !r0.stringToSign.includes("x-ots-signature"),
    "签名串格式正确且签名头自身不参与：" + JSON.stringify(r0.stringToSign),
  );
  ok(mock.ops("GetRow") > 0 && mock.ops("PutRow") > 0 && mock.ops("DeleteRow") > 0 && mock.ops("GetRange") > 0,
    "四种操作都被覆盖 GetRow=" + mock.ops("GetRow") + " PutRow=" + mock.ops("PutRow") +
      " DeleteRow=" + mock.ops("DeleteRow") + " GetRange=" + mock.ops("GetRange"));
  const usedTables = new Set(mock.requests.map((r) => r.table));
  ok(usedTables.has("mtnode_users") && usedTables.has("mtnode_sessions") && usedTables.has("mtnode_identities"),
    "只读写三张账户表：" + [...usedTables].sort().join(","));

  const find = (n) => log.find((x) => x[0] === n)[1];
  eq(find("get:missing"), null, "getUser 未命中返回 null");
  eq(find("update:missing"), null, "updateUser 未命中返回 null");
  eq(find("byUsername:ALICE"), find("get:u1"), "getUserByUsername 大小写不敏感");
  eq(find("claim:phone1:u1"), true, "首次认领身份成功");
  eq(find("claim:phone1:u1-again"), true, "本人重复认领视为成功");
  eq(find("claim:phone1:conflict"), false, "被他人占用的身份认领失败");
  eq(find("claim:empty"), false, "空身份值认领失败");
  eq(find("getUserByIdentity"), "bob", "按身份反查用户");
  eq(find("release:wrong-owner"), false, "非归属者解绑失败");
  eq(find("release:u1"), true, "归属者解绑成功");
  eq(find("getIdentity:released"), null, "解绑后身份不存在");
  eq(find("deleteSession:h1-again"), false, "重复删除会话返回 false");
  eq(find("deleteSessionsByUser:u2"), 1, "按用户删除会话计数正确");
  eq(find("pruneSessions"), 1, "清理过期会话计数正确");
  eq(find("deleteUser:u3-again"), false, "重复删号返回 false");
  eq(store.backend, "aliyun-tablestore", "backend 标识正确");
  eq(store.describe().tables, {
    users: "mtnode_users",
    sessions: "mtnode_sessions",
    identities: "mtnode_identities",
  }, "describe() 表名映射正确");
  ok(!JSON.stringify(store.describe()).includes("SECRET_mock"), "describe() 不含凭据");
}

console.log("\n[2b] 表名前缀与 GetRange 分页");
{
  const mock = createMockOts();
  installMock(mock);
  const store = createAccountStore({
    backend: "aliyun-tablestore",
    config: OTS_CONFIG({ tablePrefix: "acct_" }),
    scanLimit: 2,
  });
  for (let i = 1; i <= 5; i++) await store.createUser({ id: "u" + i, username: "user" + i, createdAt: 1000 + i });
  const users = await store.listUsers();
  restoreHttps();
  eq(users.length, 5, "5 条用户全部读回（跨多页 GetRange）");
  ok(mock.ops("GetRange") >= 3, "scanLimit=2 时触发续读（GetRange " + mock.ops("GetRange") + " 次）");
  ok(mock.requests.every((r) => r.table.startsWith("acct_")), "自定义前缀生效：" + [...new Set(mock.requests.map((r) => r.table))].join(","));
}

console.log("\n[2c] 写失败重试与错误上抛");
{
  // 5xx：可重试，最终上抛
  let mock = createMockOts();
  installMock(mock);
  let store = createAccountStore({ backend: "aliyun-tablestore", config: OTS_CONFIG(), retries: 2 });
  let err = null;
  mock.failAlways({ operation: "GetRow", status: 500, code: "InternalError", message: "boom" });
  try {
    await store.getUser("u1");
  } catch (e) {
    err = e;
  }
  ok(!!err && err.status === 500 && err.code === "InternalError", "5xx 最终上抛 OtsError：" + (err && err.message));
  ok(mock.ops("GetRow") === 3, "5xx 按 retries=2 重试 3 次（实际 " + mock.ops("GetRow") + " 次）");
  restoreHttps();

  // 4xx：不可重试，立即失败
  mock = createMockOts();
  installMock(mock);
  store = createAccountStore({ backend: "aliyun-tablestore", config: OTS_CONFIG(), retries: 2 });
  mock.failNext({ operation: "GetRow", status: 403, code: "OTSAuthFailed", message: "signature mismatch" });
  err = null;
  try {
    await store.getUser("u1");
  } catch (e) {
    err = e;
  }
  ok(!!err && err.code === "OTSAuthFailed" && err.retryable === false, "4xx 上抛且标记不可重试：" + (err && err.message));
  ok(mock.ops("GetRow") === 1, "4xx 不重试（实际 " + mock.ops("GetRow") + " 次）");
  restoreHttps();

  // data 列非 JSON：上抛而不是静默返回 null
  mock = createMockOts();
  installMock(mock);
  store = createAccountStore({ backend: "aliyun-tablestore", config: OTS_CONFIG() });
  mock.putRaw("mtnode_users", "bad", { data: "not-json" });
  err = null;
  try {
    await store.getUser("bad");
  } catch (e) {
    err = e;
  }
  ok(!!err && /不是合法 JSON/.test(err.message), "data 非 JSON 上抛：" + (err && err.message));
  restoreHttps();
}

/* ========================================================================== *
 * [3] json 后端行为不变
 * ========================================================================== */

console.log("\n[3] json 后端行为不变（与表格存储逐字一致）");
{
  const dir = tmpDir("json");
  const dbPath = path.join(dir, "db.json");
  // 预置其它集合，验证只接管账户三键
  fs.writeFileSync(
    dbPath,
    JSON.stringify({ templates: [{ id: "t1" }], skills: [{ id: "s1" }], forumMessages: [{ id: "f1" }] }),
  );
  const store = createAccountStore({ backend: "json", dataDir: dir, dbPath });
  await store.ready();
  const jsonLog = await runCrud(store);
  const onDisk = JSON.parse(fs.readFileSync(dbPath, "utf8"));
  ok(Array.isArray(onDisk.templates) && onDisk.templates[0].id === "t1", "db.json 其它键（templates）原样保留");
  ok(Array.isArray(onDisk.skills) && Array.isArray(onDisk.forumMessages), "db.json 其它键（skills / forumMessages）原样保留");
  ok(Array.isArray(onDisk.users) && Array.isArray(onDisk.sessions) && Array.isArray(onDisk.identities),
    "db.json 账户三键已落盘");

  const mock = createMockOts();
  installMock(mock);
  const tsStore = createAccountStore({ backend: "aliyun-tablestore", config: OTS_CONFIG() });
  const tsLog = await runCrud(tsStore);
  restoreHttps();

  const same = stable(jsonLog) === stable(tsLog);
  ok(same, "同一套 CRUD 在 json 与表格存储后端下产出完全一致的日志");
  if (!same) {
    for (let i = 0; i < Math.max(jsonLog.length, tsLog.length); i++) {
      const a = stable(jsonLog[i]);
      const b = stable(tsLog[i]);
      if (a !== b) console.log("        差异 " + (jsonLog[i] || [])[0] + "\n          json " + a + "\n          ots  " + b);
    }
  }
}

/* ========================================================================== *
 * [4] server.mjs 接线：启动载入 + 缓存写穿 + 失败上抛
 * ========================================================================== */

console.log("\n[4] server.mjs 账户接线（表格存储后端 + mock）");
{
  const mock = createMockOts();
  const dataDir = tmpDir("server");
  const port = await freePort();

  const seedToken = "seed-token-0123456789abcdef";
  const seedHash = crypto.createHash("sha256").update(seedToken).digest("hex");
  const seedUser = {
    id: "u_seed",
    username: "seeduser",
    nickname: "Seed",
    avatar: "",
    salt: "s",
    pass: "",
    phone: "+8613900000001",
    phoneVerifiedAt: 111,
    wechatOpenId: "",
    wechatUnionId: "",
    wechatBoundAt: 0,
    passwordChangedAt: 0,
    createdAt: 1000,
    downloadsReceived: 0,
    likesReceived: 0,
  };
  const expiresAt = Date.now() + 3600 * 1000;
  mock.putRaw("mtnode_users", "u_seed", { data: JSON.stringify(seedUser) });
  mock.putRaw("mtnode_sessions", seedHash, {
    data: JSON.stringify({ tokenHash: seedHash, userId: "u_seed", expiresAt }),
    userId: "u_seed",
    expiresAt: String(expiresAt),
  });

  // 环境：账户走表格存储（mock），短信走 console，数据目录用临时目录
  process.env.MTNODE_ACCOUNT_STORE = "aliyun-tablestore";
  process.env.MTNODE_OTS_ENDPOINT = "https://mock.ots.local";
  process.env.MTNODE_OTS_INSTANCE = "mockinst";
  process.env.MTNODE_OTS_ACCESS_KEY_ID = "AKID_mock";
  process.env.MTNODE_OTS_ACCESS_KEY_SECRET = "SECRET_mock";
  delete process.env.MTNODE_OTS_TABLE_PREFIX;
  process.env.PORT = String(port);
  process.env.HOST = "127.0.0.1";
  process.env.DATA_DIR = dataDir;
  process.env.MTNODE_SMS_PROVIDER = "console";
  process.env.MTNODE_WECHAT_APPID = "";
  process.env.MTNODE_WECHAT_SECRET = "";
  process.env.MTNODE_WECHAT_REDIRECT = "";

  const captured = [];
  const realWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk, ...rest) => {
    captured.push(String(chunk));
    return realWrite(chunk, ...rest);
  };

  installMock(mock);
  await import(pathToFileURL(SERVER_MJS).href);
  await sleep(50); // 等 listen 回调把启动日志打出来（stdout 仍处于捕获态）

  const logText = captured.join("");
  ok(/account store: aliyun-tablestore/.test(logText), "启动日志显示 account store: aliyun-tablestore");

  let up = false;
  for (let i = 0; i < 100; i++) {
    try {
      const r = await httpReq(port, "GET", "/api/health");
      if (r.data && r.data.ok) {
        up = true;
        break;
      }
    } catch {}
    await sleep(100);
  }
  ok(up, "服务端在 15s 内就绪（端口 " + port + "）");

  // (a) 启动从云库载入：种子用户 + 种子会话可直接 /api/me
  //     同时验证滑动续期：种子会话仅剩 1 小时（< SESSION_MS/2），首个鉴权请求应把它推到约 30 天后并写穿云库
  const seedBefore = JSON.parse(mock.getRaw("mtnode_sessions", seedHash).columns.data).expiresAt;
  await sleep(5);
  const me = await httpReq(port, "GET", "/api/me", { token: seedToken });
  ok(me.status === 200 && me.data && me.data.user && me.data.user.username === "seeduser",
    "/api/me 用云库种子会话登录成功（启动已从表格存储载入缓存）");
  ok(mock.keys("mtnode_identities").includes("username:seeduser"), "启动重建身份索引并写回云库（username:seeduser）");
  const seedAfter = JSON.parse(mock.getRaw("mtnode_sessions", seedHash).columns.data).expiresAt;
  ok(seedAfter > seedBefore, "鉴权请求触发滑动续期并写穿云库（" + seedBefore + " -> " + seedAfter + "）");
  ok(seedAfter - Date.now() > SESSION_MS / 2, "续期后有效期被推到约 30 天后");

  // (b) 短信登录建号：缓存写穿到云库
  const phone = "13800000002";
  const send = await httpReq(port, "POST", "/api/auth/sms/send", { json: { phone } });
  ok(send.status === 200, "短信发码成功（console provider）");
  await sleep(80);
  const code = (captured.join("").match(/->\s*(\d{6})/g) || []).pop();
  const codeVal = code ? code.replace(/\D/g, "") : "";
  ok(/^\d{6}$/.test(codeVal), "从服务端日志解析到 6 位验证码");

  const login = await httpReq(port, "POST", "/api/auth/sms/login", { json: { phone, code: codeVal } });
  ok(login.status === 200 && login.data && login.data.ok && login.data.created === true,
    "短信登录自动建号成功（created=true）");
  const newToken = login.data ? login.data.token : "";
  ok(mock.size("mtnode_users") === 2, "新账号已写穿到云库 users 表（共 " + mock.size("mtnode_users") + " 条）");
  const newUserId = login.data && login.data.user ? login.data.user.id : "";
  const storedUser = mock.getRaw("mtnode_users", newUserId);
  const storedUserObj = storedUser ? JSON.parse(storedUser.columns.data) : null;
  ok(!!storedUserObj && storedUserObj.phone === "+8613800000002", "云库里的用户记录手机号正确：" + (storedUserObj && storedUserObj.phone));
  ok(mock.keys("mtnode_identities").includes("phone:+8613800000002"), "手机号身份已写穿到云库 identities 表");
  ok(mock.keys("mtnode_sessions").length === 2, "会话已写穿到云库 sessions 表（共 " + mock.keys("mtnode_sessions").length + " 条）");

  const me2 = await httpReq(port, "GET", "/api/me", { token: newToken });
  ok(me2.status === 200 && me2.data.user.id === newUserId, "新账号 /api/me 正常");

  // (b2) 多端并存：用种子账号的手机号再登录一次（同一账号的第二台设备）
  //      修复前 issueSession 会 deleteSessionsByUser 踢掉 seedToken，这里应两个 token 同时有效
  const phone2 = "13900000001";
  const send2 = await httpReq(port, "POST", "/api/auth/sms/send", { json: { phone: phone2 } });
  ok(send2.status === 200, "同账号二次发码成功（多端并存场景）");
  await sleep(80);
  const code2 = ((captured.join("").match(/->\s*(\d{6})/g) || []).pop() || "").replace(/\D/g, "");
  const login2 = await httpReq(port, "POST", "/api/auth/sms/login", { json: { phone: phone2, code: code2 } });
  ok(login2.status === 200 && login2.data && login2.data.created === false,
    "同账号二次登录成功（created=false，命中已有账号）");
  const token2 = login2.data ? login2.data.token : "";
  const meA = await httpReq(port, "GET", "/api/me", { token: seedToken });
  const meB = await httpReq(port, "GET", "/api/me", { token: token2 });
  ok(meA.status === 200 && meB.status === 200 && meA.data.user.id === "u_seed" && meB.data.user.id === "u_seed",
    "多端并存：同账号旧 token 与新 token 同时有效（登录不再删旧会话）");
  ok(mock.keys("mtnode_sessions").length === 3,
    "同账号两台设备的会话都写穿云库（共 " + mock.keys("mtnode_sessions").length + " 条）");

  // (c) 登出写穿删除会话
  const out = await httpReq(port, "POST", "/api/logout", { token: newToken });
  ok(out.status === 200, "登出成功");
  const newHash = crypto.createHash("sha256").update(newToken).digest("hex");
  ok(!mock.keys("mtnode_sessions").includes(newHash), "会话已从云库删除");
  const me3 = await httpReq(port, "GET", "/api/me", { token: newToken });
  ok(me3.status === 401, "登出后 /api/me 返回 401");

  // (d) 云库写失败必须上抛，不能出现「登录成功但没落库」
  mock.failNext({ operation: "PutRow", table: "mtnode_identities", status: 403, code: "OTSAuthFailed", message: "denied" });
  const phone3 = "13800000003";
  await httpReq(port, "POST", "/api/auth/sms/send", { json: { phone: phone3 } });
  await sleep(80);
  const code3 = ((captured.join("").match(/->\s*(\d{6})/g) || []).pop() || "").replace(/\D/g, "");
  const login3 = await httpReq(port, "POST", "/api/auth/sms/login", { json: { phone: phone3, code: code3 } });
  ok(login3.status >= 400 && !(login3.data && login3.data.ok),
    "云库写失败时登录整体失败（HTTP " + login3.status + "），不返回 token");
  ok(!login3.data || !login3.data.token, "失败响应里没有 token");
  ok(JSON.stringify(login3.data || {}).includes("OTSAuthFailed"), "错误信息透出云库失败原因");

  process.stdout.write = realWrite;
  restoreHttps();
}

console.log("\n账户存储回归：" + checks + " 项，" + (fails ? fails + " 项失败" : "全部通过"));
process.exit(fails ? 1 : 0);
