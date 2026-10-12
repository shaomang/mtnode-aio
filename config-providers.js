"use strict";

const fs = require("fs");
const path = require("path");

function readJson(p, fb = null) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return fb;
  }
}

/* 落盘一律**紧凑序列化**（不再 pretty-print）：
 *   · 体积差 40–60%（2 空格缩进在大对象上等于把每个键再加两个字符 + 换行）；
 *   · 真事故是「大对象 + 每次交互都写」：实测 2MB 的对象 writeJson 要 ~45ms，8MB 要 ~240ms，
 *     全在**主进程同步**做 —— 应用每点一格就卡一下就是这么来的。
 *     紧凑化把这份开销按体积直接砍掉一半上下。
 *   · 机器可读就是它的用途（读回来的只有 JSON.parse），人要看就自己格式化；
 *     别再改回 null, 2。 */
function writeJson(p, v) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = p + ".tmp" + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(v), "utf8");
  fs.renameSync(tmp, p);
}

function backupConfigFile(configPath) {
  try {
    if (!fs.existsSync(configPath)) return;
    const bakDir = path.join(path.dirname(configPath), "config-backups");
    fs.mkdirSync(bakDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    fs.copyFileSync(configPath, path.join(bakDir, "config-" + stamp + ".json"));
    const files = fs
      .readdirSync(bakDir)
      .filter((f) => f.startsWith("config-") && f.endsWith(".json"))
      .map((f) => ({ f, t: fs.statSync(path.join(bakDir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    for (const old of files.slice(30)) {
      try {
        fs.unlinkSync(path.join(bakDir, old.f));
      } catch {}
    }
  } catch {}
}

/**
 * Atomically patch only the providers array in config.json.
 * Must be called synchronously after any async preparation.
 */
function patchProviders(configPath, opts) {
  opts = opts || {};
  const removeIds = new Set((opts.removeIds || []).map(String));
  const removeSources = new Set((opts.removeSources || []).map(String));
  const upsert = Array.isArray(opts.upsert) ? opts.upsert : [];

  const appCfg = readJson(configPath, { providers: [] }) || { providers: [] };
  const before = Array.isArray(appCfg.providers) ? appCfg.providers : [];
  let providers = before.filter((p) => {
    if (!p || typeof p !== "object") return false;
    if (removeIds.has(String(p.id || ""))) return false;
    if (p.source && removeSources.has(String(p.source))) return false;
    return true;
  });

  for (const item of upsert) {
    if (!item || !item.id) continue;
    const idx = providers.findIndex((p) => String(p.id) === String(item.id));
    if (idx >= 0) providers[idx] = item;
    else providers.push(item);
  }

  const changed = JSON.stringify(before) !== JSON.stringify(providers);
  if (changed) {
    backupConfigFile(configPath);
    writeJson(configPath, Object.assign({}, appCfg, { providers }));
  }
  return { ok: true, changed, providers };
}

/* 去重 + 去空（保持书写顺序） */
function uniqIds(list) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(list) ? list : []) {
    const id = String(raw == null ? "" : raw).trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * Insert or refresh a plugin-managed provider without touching any other
 * providers or user-edited fields (name, order, extra keys, extra models).
 *
 * 托管模型清单（可选，item.managedModels）—— 本轮 llama.cpp 登记链加的：
 *   · 插件声明「这一份模型清单由我维护」，于是它既能**增**也能**删**（停止 / 删除的模型
 *     会从列表里消失），不再是只追加、旧条目永远留着的旧口径；
 *   · 用户在设置里手加 / 手排序的那部分一律保留：判据 = 不在上一轮托管清单里、
 *     也不在本轮托管清单里的条目算用户的（插在托管清单之后，保持原有相对顺序）；
 *   · 上一轮托管清单记在服务商条目的 item.managedField（缺省 llamaManagedModels）字段里；
 *     第一次同步（老配置没有这个字段）时 prev 未知 —— 这时只有显式传 pruneUnknown:true
 *     才把「当前列表整份当作插件托管的」来收敛（否则维持旧的只追加语义，绝不误删用户的手工条目）。
 *   · item.fields = 由插件逐字写入的字段表（值给 null 表示删掉该字段）。
 *   · apiKey 只在插件拿到非空值时才覆盖（离线时读不到就保留盘上那一份，绝不拿可疑旧票覆盖）。
 */
function mergeManagedProvider(configPath, item, opts) {
  if (!item || !item.id) return { ok: false, changed: false, providers: [] };
  const o = opts || {};
  const appCfg = readJson(configPath, { providers: [] }) || { providers: [] };
  const before = Array.isArray(appCfg.providers) ? appCfg.providers : [];
  const providers = before.slice();
  const managedModels = Array.isArray(item.managedModels) ? uniqIds(item.managedModels) : null;
  const idx = providers.findIndex(
    (p) =>
      p &&
      (String(p.id) === String(item.id) ||
        (item.source && p.source && String(p.source) === String(item.source))),
  );

  if (idx < 0) {
    const fresh = Object.assign({}, item);
    if (managedModels) {
      /* 新条目也走同一份去重：调用方若把 managedModels 与 models 传成同一个数组/同值，
         concat 会写出重复项（真机自验里在设置页看到过同名两行） */
      fresh.models = uniqIds(managedModels.concat(uniqIds(fresh.models)));
      fresh[String(item.managedField || o.managedField || "llamaManagedModels")] = managedModels;
    }
    providers.push(fresh);
  } else {
    const cur = providers[idx] && typeof providers[idx] === "object" ? providers[idx] : {};
    const next = Object.assign({}, cur);
    if (item.baseUrl) next.baseUrl = item.baseUrl;
    if (item.apiKey) next.apiKey = item.apiKey;
    if (item.type && !next.type) next.type = item.type;
    if (item.source && !next.source) next.source = item.source;
    if (item.name && !String(next.name || "").trim()) next.name = item.name;
    if (typeof item.vision === "boolean" && next.vision == null) next.vision = item.vision;
    if (managedModels) {
      const field = String(item.managedField || o.managedField || "llamaManagedModels");
      const curModels = cur.models;
      const prevRaw = Array.isArray(cur[field]) ? cur[field] : null;
      const prev = prevRaw
        ? uniqIds(prevRaw)
        : o.pruneUnknown === true
          ? uniqIds(curModels)
          : null;
      const extra = prev
        ? uniqIds(curModels).filter((m) => !prev.includes(m) && !managedModels.includes(m))
        : uniqIds(curModels).filter((m) => !managedModels.includes(m));
      next.models = managedModels.concat(extra);
      next[field] = managedModels;
    } else if (Array.isArray(item.models) && item.models.length) {
      const have = new Set((Array.isArray(cur.models) ? cur.models : []).map((m) => String(m)));
      const models = (Array.isArray(cur.models) ? cur.models.slice() : []).map((m) => String(m));
      for (const m of item.models) {
        const id = String(m || "").trim();
        if (id && !have.has(id)) {
          models.push(id);
          have.add(id);
        }
      }
      next.models = models;
    }
    if (item.fields && typeof item.fields === "object") {
      for (const k of Object.keys(item.fields)) {
        const v = item.fields[k];
        if (v === null || v === undefined) delete next[k];
        else next[k] = v;
      }
    }
    next.id = cur.id || item.id;
    providers[idx] = next;
  }

  const changed = JSON.stringify(before) !== JSON.stringify(providers);
  if (changed) {
    backupConfigFile(configPath);
    writeJson(configPath, Object.assign({}, appCfg, { providers }));
  }
  return { ok: true, changed, providers };
}

module.exports = { patchProviders, mergeManagedProvider, readJson, writeJson };
