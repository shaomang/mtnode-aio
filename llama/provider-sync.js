"use strict";
/**
 * llama.cpp「登记进 MTNode 模型列表」的单一真源（零依赖 CommonJS）。
 *
 * 谁在用：`llama/main-llama.js`（MTNode 主进程里的插件宿主）与 `llama/tray-main.js`
 * （托盘进程，MTNode 没开着时它自己开控制台）。两条路之前各写各的：主进程那条走
 * `/api/status` 的 `deployedModels`（**只含 running**），托盘那条的 `syncProvider` 干脆是
 * 空实现 —— 于是「部署了模型，MTNode 列表里却没有它」。
 *
 * 本模块统一三件事（口径见本轮共识）：
 *   ① **清单来源**：不只 running。本机已下载的模型（管理服务的 `/api/models`，离线时读
 *      `<installDir>/.registry.json`）也登记，状态逐条给出：
 *        running（运行中）/ starting（加载中）/ failed（加载失败）/ downloaded（未部署）。
 *   ② **模型 id**：MTNode 下发给 OpenAI 兼容端点的 `model` 一律取 servedName
 *      （与 `llama-pack/app/models.py` 的 `model_id.split("/")[-1].replace(".", "-")` 同一规则，
 *      管理服务的 `_instance_for_model` 也认它），所以运行中的实例一定能被路由到。
 *   ③ **清单的增与删**：交给 `config-providers.js` 的 `mergeManagedProvider(..., {managedModels})`
 *      —— 插件托管的那份由插件增删，用户手加的额外模型与手排序保留。
 *
 * 这里只做纯计算与文件 / HTTP 读写，不 require electron：托盘进程与主进程都能用同一份。
 */
const fs = require("fs");
const path = require("path");
const http = require("http");

/* 与 llama/main-llama.js 的常量同源（那边从这里取，避免两处各写一份） */
const PROVIDER_ID = "llama-local";
const PROVIDER_SOURCE = "llama-plugin";
const PROVIDER_NAME = "llama.cpp 本地";
/* 上一轮托管清单记在服务商条目的这个字段里（mergeManagedProvider 的 managedField） */
const MANAGED_FIELD = "llamaManagedModels";
/* 「托盘进程改过配置」的信号文件名（放在 MTNode 数据目录根下） */
const DIRTY_FILE = ".provider-dirty.json";

/* 逐条状态：running / starting / failed / downloaded（未部署） */
const ST_DOWNLOADED = "downloaded";
const ST_RUNNING = "running";
const ST_STARTING = "starting";
const ST_FAILED = "failed";

/** servedName：与 llama-pack/app/models.py 的 deploy_model 同一规则
 *  （最后一节 + 点换横线）。MTNode 选择器里的模型 id 就是它。 */
function servedNameOf(modelId) {
  const s = String(modelId || "").trim();
  if (!s) return "";
  const last = s.split("/").filter(Boolean).pop() || s;
  return last.replace(/\./g, "-");
}

/** 目录比较用的归一化（Windows 大小写不敏感、去掉尾部分隔符） */
function normRoot(p) {
  const s = String(p || "").trim();
  if (!s) return "";
  let out = path.resolve(s).replace(/[/\\]+$/, "");
  if (process.platform === "win32") out = out.toLowerCase();
  return out;
}

function readJson(p, fb) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return fb;
  }
}

function writeJson(p, v) {
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const tmp = p + ".tmp" + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(v), "utf8");
    fs.renameSync(tmp, p);
    return true;
  } catch {
    return false;
  }
}

/** 管理服务的只读 / 轻写入 HTTP 调用（本机回环；timeout 兜底，绝不让登记链卡住界面）。
 *  body 给对象即按 JSON 下发（POST /api/models/deploy 与 /stop 要用）。 */
function httpJson(port, apiPath, opts) {
  const o = opts || {};
  const p = Number(port) || 0;
  if (!p) return Promise.resolve({ ok: false, error: "no_port" });
  const method = String(o.method || "GET").toUpperCase();
  const hasBody = o.body != null && method !== "GET" && method !== "HEAD";
  const payload = hasBody ? Buffer.from(JSON.stringify(o.body), "utf8") : null;
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (!done) {
        done = true;
        resolve(v);
      }
    };
    let req = null;
    try {
      req = http.request(
        {
          hostname: "127.0.0.1",
          port: p,
          path: apiPath,
          method,
          headers: Object.assign(
            {},
            o.apiKey ? { Authorization: "Bearer " + o.apiKey } : {},
            payload
              ? { "Content-Type": "application/json", "Content-Length": payload.length }
              : {},
          ),
          timeout: Number(o.timeoutMs) > 0 ? Number(o.timeoutMs) : 6000,
        },
        (res) => {
          let buf = "";
          res.on("data", (c) => (buf += c));
          res.on("end", () => {
            let json = null;
            try {
              json = buf ? JSON.parse(buf) : null;
            } catch {}
            finish({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, json });
          });
        },
      );
    } catch (e) {
      return finish({ ok: false, error: String((e && e.message) || e) });
    }
    req.on("error", (e) => finish({ ok: false, error: String((e && e.message) || e) }));
    req.on("timeout", () => {
      try {
        req.destroy();
      } catch {}
      finish({ ok: false, error: "timeout" });
    });
    if (payload) req.write(payload);
    req.end();
  });
}

/** 管理服务 `/api/status`（不带 key 也能读；读不到返回 null） */
async function liveStatus(port, timeoutMs) {
  const r = await httpJson(port, "/api/status", { timeoutMs: timeoutMs || 4000 });
  return r && r.ok && r.json ? r.json : null;
}

/** 管理服务 `/api/models`（本机注册表；需要 key，401 时返回 null 由调用方回退读文件） */
async function liveModels(port, apiKey, timeoutMs) {
  const r = await httpJson(port, "/api/models", {
    apiKey,
    timeoutMs: timeoutMs || 6000,
  });
  const items = r && r.ok && r.json && Array.isArray(r.json.items) ? r.json.items : null;
  return items;
}

/** 安装目录里的本机状态（离线也能读：登记链不依赖后端在线） */
function readInstallState(installDir) {
  const root = String(installDir || "").trim();
  if (!root) return { registry: [], deployed: [] };
  const reg = readJson(path.join(root, ".registry.json"), { models: [] }) || { models: [] };
  const dep = readJson(path.join(root, ".deployed.json"), { instances: [] }) || { instances: [] };
  return {
    registry: Array.isArray(reg.models) ? reg.models : [],
    deployed: Array.isArray(dep.instances) ? dep.instances : [],
  };
}

/** 安装目录里的 api key（离线回退用；与服务端 server.py 的 API_KEY_PATH 同路径） */
function readInstallApiKey(installDir) {
  const root = String(installDir || "").trim();
  if (!root) return "";
  try {
    const p = path.join(root, ".api-key");
    if (!fs.existsSync(p)) return "";
    return String(fs.readFileSync(p, "utf8") || "").trim();
  } catch {
    return "";
  }
}

/**
 * 逐条模型行（登记进 MTNode 的唯一数据源）。
 * 输入两路数据，任一缺失都能兜住：
 *   · 在线：管理服务的 `/api/models`（含 scan 出来的、注册表文件里没有的条目）
 *   · 离线：`<installDir>/.registry.json` + `.deployed.json`
 * 输出行：{ modelId, id(servedName), status, port, error, quant, sizeGb, deployed }
 */
function modelRows(opts) {
  const o = opts || {};
  const state = readInstallState(o.installDir);
  const deployedList = Array.isArray(o.deployed)
    ? o.deployed
    : state.deployed;
  const byModel = new Map();
  for (const inst of deployedList) {
    if (inst && inst.modelId) byModel.set(String(inst.modelId), inst);
  }
  const rows = [];
  const seen = new Set();
  const push = (entry) => {
    const modelId = String((entry && entry.id) || "").trim();
    if (!modelId || seen.has(modelId)) return;
    seen.add(modelId);
    const inst = byModel.get(modelId) || null;
    const raw = String((entry && entry.status) || "").trim();
    let status = ST_DOWNLOADED;
    if (inst) {
      const s = String(inst.status || "").trim();
      if (s === ST_RUNNING || s === ST_STARTING || s === ST_FAILED) status = s;
      else status = ST_DOWNLOADED;
    } else if (raw === ST_STARTING || raw === ST_FAILED || raw === ST_RUNNING) {
      status = ST_DOWNLOADED; /* 注册表里写的运行态不算数：以实例为准 */
    }
    const id = servedNameOf(modelId);
    rows.push({
      modelId,
      id,
      status,
      deployed: status === ST_RUNNING || status === ST_STARTING,
      port: inst && inst.port ? inst.port : null,
      error: inst && inst.error ? String(inst.error) : "",
      quant: String((entry && (entry.quant || entry.ggufQuant)) || ""),
      sizeGb: Number((entry && entry.sizeGb) || 0) || 0,
      vramGb: Number((entry && entry.vramGb) || (inst && inst.vramGb) || 0) || 0,
    });
  };
  if (Array.isArray(o.apiModels) && o.apiModels.length) o.apiModels.forEach(push);
  state.registry.forEach(push);
  /* 只在实例里出现、注册表里没有的（手工放进 models/ 的那种）：也要登记得上 */
  for (const inst of deployedList) {
    if (inst && inst.modelId && !seen.has(String(inst.modelId))) {
      push({ id: String(inst.modelId), status: inst.status });
    }
  }
  /* 排序：运行中 → 加载中 → 未部署 → 加载失败（越靠前越"现在就能用"，也是 MTNode 列表的优先级序） */
  const rank = { [ST_RUNNING]: 0, [ST_STARTING]: 1, [ST_DOWNLOADED]: 2, [ST_FAILED]: 3 };
  rows.sort((a, b) => {
    const d = (rank[a.status] == null ? 9 : rank[a.status]) - (rank[b.status] == null ? 9 : rank[b.status]);
    if (d) return d;
    return String(a.modelId).localeCompare(String(b.modelId));
  });
  return rows;
}

/** 模型行的状态徽标文案（渲染层按 I18n 翻；这里只给 key，避免中英混写死在一处） */
function statusKeyOf(status) {
  if (status === ST_RUNNING) return "运行中";
  if (status === ST_STARTING) return "加载中";
  if (status === ST_FAILED) return "加载失败";
  return "未部署";
}

/**
 * 组装要写进 config.json 的服务商条目。
 *   mode: "own"（以插件配置的 installDir 为准）| "external"（用户选定：接着用端口上那份）
 *   apiKey：在线时来自 /api/status（权威）；离线回退一律走调用方给的 fallbackKey，
 *           两者都空 → 不传 apiKey（mergeManagedProvider 于是保留盘上那份，绝不拿可疑旧票覆盖）。
 */
function buildProviderItem(opts) {
  const o = opts || {};
  const rows = Array.isArray(o.rows) ? o.rows : [];
  const models = [];
  const llamaModels = [];
  for (const r of rows) {
    if (!r || !r.id) continue;
    if (!models.includes(r.id)) models.push(r.id);
    llamaModels.push({
      id: r.id,
      modelId: r.modelId,
      status: r.status,
      statusKey: statusKeyOf(r.status),
      port: r.port || null,
      error: r.error || "",
      quant: r.quant || "",
      sizeGb: r.sizeGb || 0,
    });
  }
  const item = {
    id: PROVIDER_ID,
    name: PROVIDER_NAME,
    type: "text_openai",
    baseUrl: "http://127.0.0.1:" + (Number(o.port) || 0) + "/v1",
    vision: false,
    source: PROVIDER_SOURCE,
    managedModels: models,
    /* models 与 managedModels 同值但**各自一份数组**：managedModels 说明「这份清单由插件增删」，
       models 是 MTNode 各选择器直接读的字段。绝不能共用同一个数组引用 ——
       mergeManagedProvider 新建条目时会做 managedModels.concat(models)，同引用就会写出重复项。 */
    models: models.slice(),
    managedField: MANAGED_FIELD,
    fields: {
      llamaModels,
      llamaSync: {
        at: Date.now(),
        port: Number(o.port) || 0,
        mode: o.mode === "external" ? "external" : "own",
        online: !!o.online,
        installDir: String(o.installDir || ""),
        liveRoot: String(o.liveRoot || ""),
        /* mismatch = 两份目录事实不同；conflict = 这个差异**还没被用户裁决**
           （用户选过「继续用这份」之后仍 mismatch，但 conflict 已解除：界面不再报警） */
        mismatch: !!o.mismatch,
        conflict: o.conflict == null ? !!o.mismatch && o.mode !== "external" : !!o.conflict,
      },
    },
  };
  const key = String(o.apiKey || "").trim();
  if (key) item.apiKey = key;
  return item;
}

/** 服务商条目里那条模型（给运行前自动部署用：servedName 或 modelId 都能查到行） */
function findRow(rows, modelId) {
  const m = String(modelId || "").trim();
  if (!m) return null;
  const list = Array.isArray(rows) ? rows : [];
  return (
    list.find((r) => r && (String(r.id) === m || String(r.modelId) === m)) || null
  );
}

/** 模型列表行（statusForUi / 控制台用；不写盘） */
async function collectRows(opts) {
  const o = opts || {};
  const port = Number(o.port) || 0;
  const status = o.status || (await liveStatus(port));
  const apiKey = String((status && status.apiKey) || o.apiKey || "").trim();
  let apiModels = null;
  if (status) apiModels = await liveModels(port, apiKey);
  return modelRows({
    installDir: o.installDir,
    deployed: status && Array.isArray(status.deployed) ? status.deployed : undefined,
    apiModels,
  });
}

/* ── 托盘 → MTNode 的「配置已改」信号（托盘进程也能写盘，MTNode 运行时由它即时刷新） ── */

function dirtyPath(dataDir) {
  return path.join(String(dataDir || ""), DIRTY_FILE);
}

function markDirty(dataDir, info) {
  const p = dirtyPath(dataDir);
  if (!String(dataDir || "").trim()) return false;
  return writeJson(p, Object.assign({ at: Date.now(), by: "tray" }, info || {}));
}

function consumeDirty(dataDir) {
  const p = dirtyPath(dataDir);
  const j = readJson(p, null);
  if (!j) return null;
  try {
    fs.unlinkSync(p);
  } catch {}
  return j;
}

/**
 * 「把当前模型登记进 MTNode 配置」的完整实现（托盘进程与自验脚本共用，`llama/tray-main.js`
 * 里的 IPC 只是它的薄壳）：
 *   opts = { port, installDir, configPath, dataDir, mode? }
 *   · 清单来自管理服务（/api/status + /api/models），离线退回安装目录的注册表文件；
 *   · apiKey 在线以 /api/status 为准，否则读 <installDir>/.api-key，都拿不到就不覆盖旧值；
 *   · 直接合并写进 config.json（MTNode 关着也落盘），再留一个脏信号给正开着的 MTNode。
 * 返回 { ok, changed, models, rows }。
 */
async function syncProviderToConfig(opts) {
  const o = opts || {};
  const port = Number(o.port) || 0;
  const installDir = String(o.installDir || "").trim();
  const configPath = String(o.configPath || "").trim();
  if (!port || !configPath) return { ok: false, error: "bad_args" };
  try {
    const st = await liveStatus(port);
    const key = String((st && st.apiKey) || "").trim() || readInstallApiKey(installDir);
    /* 后端在线时，清单以它自己的 root 为准（托盘接的往往就是端口上那份，可能与插件配置的
       installDir 不是同一个目录）：这样两份目录的模型绝不会混进同一张列表 */
    const rows = modelRows({
      installDir: st && st.installRoot ? String(st.installRoot) : installDir,
      deployed: st && Array.isArray(st.deployed) ? st.deployed : undefined,
      apiModels: st ? await liveModels(port, key) : null,
    });
    const item = buildProviderItem({
      port,
      rows,
      apiKey: key,
      mode: o.mode === "external" ? "external" : "own",
      online: !!st,
      installDir,
      liveRoot: st && st.installRoot ? String(st.installRoot) : "",
      mismatch:
        !!(st && st.installRoot && installDir) &&
        normRoot(st.installRoot) !== normRoot(installDir),
    });
    /* 延迟 require：本模块的纯函数部分（模型行 / 清单）不依赖 config-providers，
       验证脚本与托盘都能单独用；写盘那一支才需要它 */
    const { mergeManagedProvider } = require("../config-providers.js");
    const r = mergeManagedProvider(configPath, item, { pruneUnknown: true });
    if (String(o.dataDir || "").trim()) {
      markDirty(o.dataDir, {
        models: Array.isArray(item.models) ? item.models : [],
        rows: rows.length,
        liveRoot: item.fields.llamaSync.liveRoot,
        installDir,
      });
    }
    return { ok: true, changed: !!r.changed, models: item.models.length, rows };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

module.exports = {
  PROVIDER_ID,
  PROVIDER_SOURCE,
  PROVIDER_NAME,
  MANAGED_FIELD,
  DIRTY_FILE,
  ST_DOWNLOADED,
  ST_RUNNING,
  ST_STARTING,
  ST_FAILED,
  servedNameOf,
  normRoot,
  readJson,
  writeJson,
  httpJson,
  liveStatus,
  liveModels,
  readInstallState,
  readInstallApiKey,
  modelRows,
  statusKeyOf,
  buildProviderItem,
  findRow,
  collectRows,
  syncProviderToConfig,
  dirtyPath,
  markDirty,
  consumeDirty,
};
