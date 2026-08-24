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

function writeJson(p, v) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = p + ".tmp" + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(v, null, 2), "utf8");
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

/**
 * Insert or refresh a plugin-managed provider without touching any other
 * providers or user-edited fields (name, order, extra keys, extra models).
 */
function mergeManagedProvider(configPath, item) {
  if (!item || !item.id) return { ok: false, changed: false, providers: [] };
  const appCfg = readJson(configPath, { providers: [] }) || { providers: [] };
  const before = Array.isArray(appCfg.providers) ? appCfg.providers : [];
  const providers = before.slice();
  const idx = providers.findIndex(
    (p) =>
      p &&
      (String(p.id) === String(item.id) ||
        (item.source && p.source && String(p.source) === String(item.source))),
  );

  if (idx < 0) {
    providers.push(item);
  } else {
    const cur = providers[idx] && typeof providers[idx] === "object" ? providers[idx] : {};
    const next = Object.assign({}, cur);
    if (item.baseUrl) next.baseUrl = item.baseUrl;
    if (item.apiKey) next.apiKey = item.apiKey;
    if (item.type && !next.type) next.type = item.type;
    if (item.source && !next.source) next.source = item.source;
    if (item.name && !String(next.name || "").trim()) next.name = item.name;
    if (typeof item.vision === "boolean" && next.vision == null) next.vision = item.vision;
    if (Array.isArray(item.models) && item.models.length) {
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
