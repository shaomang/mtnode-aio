"use strict";
const {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  shell,
  clipboard,
  Menu,
  nativeImage,
} = require("electron");
const path = require("path");
const fs = require("fs");
const http = require("http");
const https = require("https");
/* gifenc 延迟加载：模块缺失时仅影响 GIF 生成，不会导致启动崩溃 */
let _gifenc = null;
function gifenc() {
  if (!_gifenc) _gifenc = require("gifenc");
  return _gifenc;
}

const DATA = () => path.join(app.getPath("userData"), "pipeline-console");
const mk = (p) => {
  fs.mkdirSync(p, { recursive: true });
  return p;
};
const join = (...a) => path.join(...a);

let mainWin = null;
function win() {
  return mainWin;
}

app.setPath(
  "userData",
  process.env.MTNODE_DATA_DIR ||
    path.join(app.getPath("appData"), "pipeline-console"),
);

/* 错误自诊断：未捕获异常写入日志 + 弹窗显示，避免静默崩溃 */
function errLog(p) {
  try {
    fs.appendFileSync(
      join(DATA(), "error.log"),
      "[" + new Date().toISOString() + "] " + p + "\n",
    );
  } catch {}
}
process.on("uncaughtException", (err) => {
  errLog("main uncaught: " + (err && err.stack ? err.stack : err));
  if (mainWin && !mainWin.isDestroyed()) {
    dialog.showErrorBox(
      "MTNode AI编排器 发生错误",
      String(err && err.message ? err.message : err) +
        "\n\n详细信息已写入：" +
        join(DATA(), "error.log"),
    );
  }
});
process.on("unhandledRejection", (reason) => {
  errLog(
    "main unhandledRejection: " +
      (reason && reason.stack ? reason.stack : reason),
  );
});

/* ---------------- 磁盘工具 ---------------- */

function readJson(p, fb = null) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return fb;
  }
}
function writeJson(p, v) {
  mk(path.dirname(p));
  const tmp = p + ".tmp" + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(v, null, 2), "utf8");
  fs.renameSync(tmp, p);
}
const wfIdOk = (id) => /^[A-Za-z0-9_-]{4,120}$/.test(String(id || ""));
const wfPath = (id) => join(DATA(), "save", String(id) + ".json");
const assetDir = (wfId) => mk(join(DATA(), "assets", String(wfId)));

/* 一次性迁移：旧版本工作流在 workflows/ 下，新版本统一存到 save/ */
function migrateLegacyWorkflows() {
  const oldDir = join(DATA(), "workflows");
  const newDir = join(DATA(), "save");
  try {
    if (!fs.existsSync(newDir)) return;
    if (fs.readdirSync(newDir).some((f) => f.endsWith(".json"))) return;
    if (fs.existsSync(oldDir)) {
      for (const f of fs.readdirSync(oldDir)) {
        if (f.endsWith(".json"))
          fs.renameSync(join(oldDir, f), join(newDir, f));
      }
    }
  } catch {
    /* 迁移失败不影响启动 */
  }
}

/* ---------------- IPC：配置 / 工作流 ---------------- */

/* 从源码目录读取 version 文件（打包后随 asar 携带，与构建时引用同一份） */
function appVersion() {
  try {
    const v = fs.readFileSync(join(__dirname, "version"), "utf8").trim();
    return /^[0-9]+\.[0-9]+\.[0-9]+$/.test(v) ? v : "0.0.0";
  } catch {
    return "0.0.0";
  }
}
ipcMain.handle("app:version", () => ({ ok: true, version: appVersion() }));

ipcMain.handle("config:load", () =>
  readJson(join(DATA(), "config.json"), {
    version: 1,
    snap: 24,
    activeWorkflowId: "default",
    providers: [
      {
        id: "deepseek",
        name: "DeepSeek",
        type: "text_openai",
        baseUrl: "https://api.deepseek.com",
        apiKey: "",
        models: ["deepseek-v4-flash", "deepseek-v4-pro"],
        vision: false,
      },
      {
        id: "gpt_image_2",
        name: "GPT Image 2",
        type: "image_openai",
        baseUrl: "",
        apiKey: "",
        models: ["gpt-image-2-vip"],
      },
    ],
  }),
);
ipcMain.handle("config:save", (e, cfg) => {
  writeJson(join(DATA(), "config.json"), cfg);
  return { ok: true };
});

ipcMain.handle("workflow:list", () => {
  const d = mk(join(DATA(), "save"));
  return fs
    .readdirSync(d)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      const j = readJson(join(d, f), {});
      const id = j.id || f.slice(0, -5);
      let mtime = 0;
      try {
        mtime = fs.statSync(join(d, f)).mtimeMs;
      } catch {}
      return { id, name: j.name || id, mtime, nodes: (j.nodes || []).length };
    })
    .sort((a, b) => b.mtime - a.mtime);
});
ipcMain.handle("workflow:load", (e, id) => {
  if (!wfIdOk(id)) return { ok: false, error: "非法工作流 id" };
  const j = readJson(wfPath(id));
  return j ? { ok: true, data: j } : { ok: false, error: "工作流不存在" };
});
ipcMain.handle("workflow:save", (e, { id, data }) => {
  if (!wfIdOk(id)) return { ok: false, error: "非法工作流 id" };
  writeJson(wfPath(id), data);
  return { ok: true, mtime: Date.now() };
});
ipcMain.handle("workflow:delete", (e, id) => {
  if (!wfIdOk(id)) return { ok: false };
  try {
    fs.rmSync(wfPath(id));
  } catch {}
  try {
    fs.rmSync(assetDir(id), { recursive: true, force: true });
  } catch {}
  return { ok: true };
});

/* ---------------- IPC：资产 / 文件 ---------------- */

ipcMain.handle("asset:copy", (e, { srcPath, wfId, name }) => {
  const ext = path.extname(String(srcPath || "")).toLowerCase() || ".png";
  const dest = join(
    assetDir(wfId),
    String(name).replace(/[^\w.-]/g, "_") + ext,
  );
  fs.copyFileSync(srcPath, dest);
  return { ok: true, path: dest };
});
ipcMain.handle("asset:writeBase64", (e, { wfId, name, base64, ext }) => {
  const dest = join(
    assetDir(wfId),
    String(name).replace(/[^\w.-]/g, "_") + "." + (ext || "png"),
  );
  fs.writeFileSync(dest, Buffer.from(String(base64), "base64"));
  return { ok: true, path: dest };
});
ipcMain.handle("asset:readDataUrl", (e, p) => {
  const buf = fs.readFileSync(p);
  const ext = path.extname(p).slice(1).toLowerCase();
  const mime =
    ext === "png"
      ? "image/png"
      : ext === "jpg" || ext === "jpeg"
        ? "image/jpeg"
        : ext === "webp"
          ? "image/webp"
          : ext === "gif"
            ? "image/gif"
            : "image/png";
  return {
    ok: true,
    dataUrl: "data:" + mime + ";base64," + buf.toString("base64"),
  };
});

ipcMain.handle("file:readText", (e, p) => {
  try {
    return { ok: true, exists: true, content: fs.readFileSync(p, "utf8") };
  } catch {
    return { ok: true, exists: false, content: "" };
  }
});
ipcMain.handle("file:writeText", (e, { path: p, content }) => {
  mk(path.dirname(p));
  fs.writeFileSync(p, content, "utf8");
  return { ok: true };
});
ipcMain.handle("file:copyAssetTo", (e, { assetPath, destPath }) => {
  mk(path.dirname(destPath));
  fs.copyFileSync(assetPath, destPath);
  return { ok: true };
});
ipcMain.handle("file:exists", (e, p) => {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
});
ipcMain.handle(
  "file:saveDialog",
  async (e, { title, defaultName, filters }) => {
    const r = await dialog.showSaveDialog(win(), {
      title: title || "选择保存位置",
      defaultPath: defaultName || "output.yaml",
      filters: filters || [{ name: "全部文件", extensions: ["*"] }],
    });
    return r.canceled ? { path: null } : { path: r.filePath };
  },
);
ipcMain.handle("file:openDialog", async (e, { title, filters, multi }) => {
  const r = await dialog.showOpenDialog(win(), {
    title: title || "选择文件",
    properties: multi ? ["openFile", "multiSelections"] : ["openFile"],
    filters: filters || [{ name: "全部文件", extensions: ["*"] }],
  });
  return r.canceled
    ? { path: null, paths: [] }
    : { path: r.filePaths[0] || null, paths: r.filePaths };
});
ipcMain.handle("shell:showItem", (e, p) => shell.showItemInFolder(p));
ipcMain.handle("shell:openExternal", (e, url) => {
  if (typeof url === "string" && /^https?:\/\//.test(url))
    shell.openExternal(url);
});
ipcMain.handle("clipboard:readText", () => clipboard.readText());
/* 打开存档目录（工作流 save 文件夹） */
ipcMain.handle("storage:open", () => {
  try {
    const dir = mk(join(DATA(), "save"));
    shell.openPath(dir);
    return { ok: true, path: dir };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
});

/* GIF 帧动画编码：frames = [{data: ArrayBuffer(RGBA), w, h}]；alpha=0 像素透明 */
ipcMain.handle("gif:make", (e, { wfId, name, frames, delay }) => {
  try {
    const { GIFEncoder, quantize, applyPalette } = gifenc();
    const encoder = GIFEncoder();
    for (const f of frames || []) {
      const data = new Uint8ClampedArray(f.data);
      const palette = quantize(data, 255, {
        format: "rgba4444",
        oneBitAlpha: true,
      });
      const index = applyPalette(data, palette, "rgba4444");
      let transp = -1;
      for (let i = 0; i < palette.length; i++) {
        if (palette[i][3] === 0) {
          transp = i;
          break;
        }
      }
      if (transp >= 0) {
        for (let p = 0; p < index.length; p++) {
          if (data[p * 4 + 3] === 0) index[p] = transp;
        }
        encoder.writeFrame(index, f.w, f.h, {
          palette,
          delay: delay || 160,
          transparent: true,
          transparentIndex: transp,
        });
      } else {
        encoder.writeFrame(index, f.w, f.h, { palette, delay: delay || 160 });
      }
    }
    encoder.finish();
    const gif = encoder.bytes();
    const dest = join(
      assetDir(wfId),
      String(name).replace(/[^\w.-]/g, "_") + ".gif",
    );
    fs.writeFileSync(dest, Buffer.from(gif));
    return { ok: true, path: dest, frames: (frames || []).length };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
});

/* ---------------- IPC：AI 接口调用（主进程发起，无 CORS 限制） ---------------- */

function apiErr(status, j, text) {
  const msg = j && j.error && (j.error.message || String(j.error));
  if (msg) return `HTTP ${status}：${String(msg).slice(0, 300)}`;
  const t = String(text || "").slice(0, 300);
  return `HTTP ${status}${t ? "：" + t : ""}`;
}

/* 运行中请求的中止：key -> Set<request> */
const activeRequests = new Map();
function registerRequest(key, req) {
  if (!key) return;
  let s = activeRequests.get(key);
  if (!s) {
    s = new Set();
    activeRequests.set(key, s);
  }
  s.add(req);
  req.on("close", () => {
    s.delete(req);
    if (!s.size) activeRequests.delete(key);
  });
}
ipcMain.handle("api:abort", (e, key) => {
  if (key) {
    const s = activeRequests.get(key);
    if (s) for (const req of [...s]) req.destroy(new Error("请求已中止"));
  }
  return { ok: true };
});

/* 使用 http/https 直接发请求：每次新建连接（Connection: close），
   避免 keep-alive 池中半开连接导致的下一次请求长时间挂起；
   超时覆盖整个请求（含响应体读取）。 */
async function fetchJson(url, opts, timeoutMs = 180000, reqKey) {
  const u = new URL(url);
  const lib = u.protocol === "https:" ? https : http;
  const headers = Object.assign({ Connection: "close" }, opts.headers || {});
  let payload = null;
  if (opts.body instanceof FormData) {
    const boundary =
      "----MTNode" +
      Date.now().toString(36) +
      Math.random().toString(36).slice(2, 8);
    const parts = [];
    for (const [k, v] of opts.body.entries()) {
      if (typeof v === "string") {
        parts.push(
          Buffer.from(
            `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`,
          ),
        );
      } else if (v && typeof v.arrayBuffer === "function") {
        const buf = Buffer.from(await v.arrayBuffer());
        parts.push(
          Buffer.from(
            `--${boundary}\r\nContent-Disposition: form-data; name="${k}"; filename="${v.name || "file"}"\r\nContent-Type: ${v.type || "application/octet-stream"}\r\n\r\n`,
          ),
        );
        parts.push(buf);
        parts.push(Buffer.from("\r\n"));
      }
    }
    parts.push(Buffer.from(`--${boundary}--\r\n`));
    payload = Buffer.concat(parts);
    headers["Content-Type"] = "multipart/form-data; boundary=" + boundary;
    headers["Content-Length"] = payload.length;
  } else if (opts.body !== undefined && opts.body !== null) {
    payload = Buffer.from(
      typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body),
      "utf8",
    );
    headers["Content-Length"] = payload.length;
  }
  return new Promise((resolve, reject) => {
    const req = lib.request(
      u,
      { method: opts.method || "GET", headers },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let j = null;
          try {
            j = JSON.parse(text);
          } catch {}
          resolve({ status: res.statusCode, j, text });
        });
        res.on("error", (e) => reject(e));
      },
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error("请求超时")));
    req.on("error", (e) => reject(e));
    if (reqKey) registerRequest(reqKey, req);
    if (payload) req.write(payload);
    req.end();
  });
}

async function fetchRaw(url, timeoutMs = 60000, reqKey) {
  const u = new URL(url);
  const lib = u.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const req = lib.request(
      u,
      { method: "GET", headers: { Connection: "close" } },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({ status: res.statusCode, buf: Buffer.concat(chunks) }),
        );
        res.on("error", (e) => reject(e));
      },
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error("下载图像超时")));
    req.on("error", (e) => reject(e));
    if (reqKey) registerRequest(reqKey, req);
    req.end();
  });
}

/* gpt-image-2-vip 支持的全部 size 档位（含 auto） */
const GPT_IMAGE_SIZES = [
  "auto",
  "1280x1280",
  "848x1280",
  "1280x848",
  "960x1280",
  "1280x960",
  "1024x1280",
  "1280x1024",
  "720x1280",
  "1280x720",
  "1280x544",
  "2048x2048",
  "1360x2048",
  "2048x1360",
  "1536x2048",
  "2048x1536",
  "1632x2048",
  "2048x1632",
  "1152x2048",
  "2048x1152",
  "2048x864",
  "2880x2880",
  "2336x3520",
  "3520x2336",
  "2480x3312",
  "3312x2480",
  "2560x3216",
  "3216x2560",
  "2160x3840",
  "3840x2160",
  "3840x1632",
];

/* 兼容 base64 带/不带 data: 前缀 */
function normB64(v) {
  if (typeof v !== "string") return null;
  if (v.startsWith("data:")) {
    const i = v.indexOf(",");
    return i >= 0 ? v.slice(i + 1) : v;
  }
  return v;
}

/* 图像输入上限：长/宽任一超过 720px（720p）时等比缩小后再发送，
   避免大图 base64 占用过多输入 token 与上传体积 */
const IMAGE_MAX_DIM = 720;

/* 读取图像并缩放到不超过 720x720（等比）。无法解码或已达标时原样返回。
   返回 {buf, ext}；重编码规则：jpg/jpeg → JPEG(85)，其余 → PNG */
function shrinkImageForApi(p) {
  const raw = fs.readFileSync(p);
  const ext = String(path.extname(p)).slice(1).toLowerCase();
  const img = nativeImage.createFromBuffer(raw);
  if (img.isEmpty()) return { buf: raw, ext: ext || "png" };
  const { width: w, height: h } = img.getSize();
  if (w <= IMAGE_MAX_DIM && h <= IMAGE_MAX_DIM)
    return { buf: raw, ext: ext || "png" };
  const scale = Math.min(IMAGE_MAX_DIM / w, IMAGE_MAX_DIM / h);
  const resized = img.resize({
    width: Math.max(1, Math.round(w * scale)),
    height: Math.max(1, Math.round(h * scale)),
  });
  const isJpeg = ext === "jpg" || ext === "jpeg";
  return {
    buf: isJpeg ? resized.toJPEG(85) : resized.toPNG(),
    ext: isJpeg ? "jpeg" : "png",
  };
}

/* 构建完整请求描述（预览与真实调用共用，保证一致） */
function buildRequestSpec(
  provider,
  kind,
  model,
  prompt,
  texts,
  images,
  refImage,
  temperature,
  size,
  chatMessages,
) {
  const base = String(provider.baseUrl).trim().replace(/\/+$/, "");
  const auth = {
    Authorization: "Bearer " + provider.apiKey,
    "Content-Type": "application/json",
  };
  if (kind === "text") {
    const parts = [];
    const vision = !!provider.vision;
    if (vision && images && images.length) {
      parts.push({ type: "text", text: prompt });
      for (const p of images) {
        const { buf, ext } = shrinkImageForApi(p);
        const mime =
          ext === "jpeg"
            ? "image/jpeg"
            : ext === "webp"
              ? "image/webp"
              : "image/png";
        parts.push({
          type: "image_url",
          image_url: {
            url: "data:" + mime + ";base64," + buf.toString("base64"),
          },
        });
      }
    } else {
      parts.push({ type: "text", text: prompt });
    }
    const messages =
      chatMessages && chatMessages.length
        ? chatMessages
        : [{ role: "user", content: parts }];
    return {
      method: "POST",
      url: base + "/chat/completions",
      headers: auth,
      body: {
        model,
        messages,
        temperature: temperature == null ? 0.7 : temperature,
      },
    };
  }
  if (provider.type === "image_openai") {
    const sz = GPT_IMAGE_SIZES.includes(size) ? size : "2048x1360";
    if (images && images.length) {
      /* 带参考图：/images/edits multipart，多图按顺序 = prompt 中的图1/图2/… */
      return {
        method: "POST",
        url: base + "/images/edits",
        headers: { Authorization: auth.Authorization },
        body: {
          __multipart: {
            model: model || "gpt-image-2-vip",
            prompt,
            size: sz,
            image: images.slice(),
          },
        },
      };
    }
    /* 文生图：/images/generations，不支持 n/quality/aspect_ratio */
    return {
      method: "POST",
      url: base + "/images/generations",
      headers: auth,
      body: {
        model: model || "gpt-image-2-vip",
        prompt,
        size: sz,
        response_format: "b64_json",
      },
    };
  }
  if (provider.type === "image_stability") {
    const form = { prompt, output_format: "png", aspect_ratio: "1:1" };
    if (model && model !== "core") form.model = model;
    if (refImage) form.image = refImage;
    return {
      method: "POST",
      url: base + "/v2beta/stable-image/generate/core",
      headers: {
        Authorization: auth.Authorization,
        Accept: "application/json",
      },
      body: { __multipart: form },
    };
  }
  if (provider.type === "image_mj") {
    return {
      method: "POST",
      url: base,
      headers: auth,
      body: { prompt, api_key: provider.apiKey, model: model || "imagine" },
    };
  }
  throw new Error("未知服务商类型：" + provider.type);
}

/* multipart 表单请求：image 字段支持字符串（单张）或数组（多张参考图，顺序=图1/图2/…） */
async function sendMultipart(url, headers, form, timeoutMs = 180000, reqKey) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(form || {})) {
    if (Array.isArray(v)) {
      let i = 1;
      for (const p of v) {
        if (!p) continue;
        const { buf, ext } = shrinkImageForApi(p);
        fd.append(k, new Blob([buf]), "ref" + i + "." + ext);
        i++;
      }
    } else if (k === "image" && typeof v === "string" && v) {
      const { buf, ext } = shrinkImageForApi(v);
      fd.append("image", new Blob([buf]), "ref." + ext);
    } else {
      fd.append(k, v);
    }
  }
  return fetchJson(
    url,
    { method: "POST", headers, body: fd },
    timeoutMs,
    reqKey,
  );
}

function checkProvider(provider) {
  if (!provider) throw new Error("未配置服务商");
  if (!String(provider.baseUrl || "").trim())
    throw new Error("未配置接口地址（设置 · API/配置）");
  if (!String(provider.apiKey || "").trim())
    throw new Error("未配置 API Key（请在「设置 · API/配置」中填写）");
}

async function apiCall({
  provider,
  kind,
  model,
  prompt,
  texts,
  images,
  refImage,
  temperature,
  size,
  chatMessages,
  abKey,
}) {
  checkProvider(provider);
  const req = buildRequestSpec(
    provider,
    kind,
    model,
    prompt,
    texts,
    images,
    refImage,
    temperature,
    size,
    chatMessages,
  );

  if (kind === "text" || provider.type === "image_mj") {
    const { status, j, text } = await fetchJson(
      req.url,
      {
        method: req.method,
        headers: req.headers,
        body: JSON.stringify(req.body),
      },
      undefined,
      abKey,
    );
    if (status >= 400) throw new Error(apiErr(status, j, text));
    if (kind === "text") {
      const content =
        j &&
        j.choices &&
        j.choices[0] &&
        j.choices[0].message &&
        j.choices[0].message.content;
      if (content == null) throw new Error("响应无文本内容");
      return { ok: true, text: String(content) };
    }
    let b64 = null,
      url = null;
    const take = (v) => {
      if (!v) return;
      if (typeof v === "string") {
        if (v.startsWith("data:")) b64 = v.split(",")[1] || null;
        else if (/^https?:\/\//.test(v)) url = v;
        else if (!b64) b64 = v;
      }
    };
    if (j) {
      take(j.image);
      if (j.images && j.images.length) j.images.forEach(take);
      if (j.data && j.data[0]) {
        take(j.data[0].url);
        take(j.data[0].b64_json);
        take(j.data[0].image);
      }
      take(j.url);
    }
    if (!b64 && !url)
      throw new Error(
        "响应无图像数据（请检查自定义接口返回格式：{image: url|base64}）",
      );
    if (url) {
      const r = await fetchRaw(url, 60000, abKey);
      if (r.status >= 400) throw new Error("下载图像失败 HTTP " + r.status);
      b64 = r.buf.toString("base64");
    }
    return { ok: true, base64: b64, ext: "png" };
  }

  if (provider.type === "image_openai") {
    let status, j, text;
    if (req.body && req.body.__multipart) {
      ({ status, j, text } = await sendMultipart(
        req.url,
        req.headers,
        req.body.__multipart,
        180000,
        abKey,
      ));
    } else {
      ({ status, j, text } = await fetchJson(
        req.url,
        {
          method: "POST",
          headers: req.headers,
          body: JSON.stringify(req.body),
        },
        undefined,
        abKey,
      ));
    }
    if (status >= 400) throw new Error(apiErr(status, j, text));
    const b64 = normB64(j && j.data && j.data[0] && j.data[0].b64_json);
    if (!b64) throw new Error("响应无图像数据");
    return { ok: true, base64: b64, ext: "png" };
  }

  if (provider.type === "image_stability") {
    const { status, j, text } = await sendMultipart(
      req.url,
      req.headers,
      req.body.__multipart,
      180000,
      abKey,
    );
    if (status >= 400) throw new Error(apiErr(status, j, text));
    const b64 = normB64(
      (j && j.image) ||
        (j && j.artifacts && j.artifacts[0] && j.artifacts[0].base64),
    );
    if (!b64) throw new Error("响应无图像数据");
    return { ok: true, base64: b64, ext: "png" };
  }

  throw new Error("未知服务商类型：" + provider.type);
}
ipcMain.handle("api:call", async (e, spec) => {
  try {
    return await apiCall(spec);
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
});

/* ---------------- 文本流式调用（SSE，支持思考内容 reasoning_content） ---------------- */

/* 普通 JSON 响应中提取内容（非流式回退 / 服务端忽略 stream 参数时用） */
function extractChatContent(j) {
  const c = j && j.choices && j.choices[0];
  if (!c) return { text: "", reasoning: "" };
  const m = c.message || {};
  return {
    text: m.content == null ? "" : String(m.content),
    reasoning: m.reasoning_content == null ? "" : String(m.reasoning_content),
  };
}

/* 发起流式 chat/completions 请求：
   - body 自动加 stream:true；
   - 服务端按 SSE（data: 行）返回 → 逐行解析 delta：
       delta.reasoning_content / delta.reasoning → 思考内容（emit('reasoning')）
       delta.content → 正文（emit('delta')）
     [DONE] 或流结束 → resolve({text, reasoning})；
   - 服务端忽略 stream 参数返回普通 JSON → 单次解析 message.content / reasoning_content；
   - HTTP ≥400 → reject（带 httpStatus，由调用方回退非流式）。 */
function streamTextChat(req, emit) {
  const u = new URL(req.url);
  const lib = u.protocol === "https:" ? https : http;
  const body = Object.assign({}, req.body, { stream: true });
  const payload = Buffer.from(JSON.stringify(body), "utf8");
  const headers = Object.assign({}, req.headers, {
    "Content-Length": payload.length,
    Connection: "close",
  });
  return new Promise((resolve, reject) => {
    const rq = lib.request(
      u,
      { method: req.method || "POST", headers },
      (res) => {
        let buf = "";
        let sse = false;
        let text = "";
        let reasoning = "";
        let finished = false;
        const finish = (t, r) => {
          if (!finished) {
            finished = true;
            resolve({ text: t, reasoning: r });
          }
        };
        if (res.statusCode >= 400) {
          res.on("data", (c) => {
            buf += c.toString("utf8");
          });
          res.on("end", () => {
            let j = null;
            try {
              j = JSON.parse(buf);
            } catch {}
            const e = new Error(apiErr(res.statusCode, j, buf));
            e.httpStatus = res.statusCode;
            reject(e);
          });
          return;
        }
        res.on("data", (c) => {
          buf += c.toString("utf8");
          let i;
          while ((i = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, i).trim();
            buf = buf.slice(i + 1);
            if (!line.startsWith("data:")) continue;
            sse = true;
            const data = line.slice(5).trim();
            if (data === "[DONE]") {
              finish(text, reasoning);
              return;
            }
            let j = null;
            try {
              j = JSON.parse(data);
            } catch {}
            if (!j || !j.choices || !j.choices[0]) continue;
            const d = j.choices[0].delta || {};
            if (d.reasoning_content != null && d.reasoning_content !== "") {
              reasoning += d.reasoning_content;
              emit("reasoning", { text: d.reasoning_content });
            }
            if (d.reasoning != null && d.reasoning !== "") {
              reasoning += d.reasoning;
              emit("reasoning", { text: d.reasoning });
            }
            if (d.content != null && d.content !== "") {
              text += d.content;
              emit("delta", { text: d.content });
            }
          }
        });
        res.on("end", () => {
          if (sse) {
            finish(text, reasoning);
            return;
          }
          let j = null;
          try {
            j = JSON.parse(buf);
          } catch {}
          const c = extractChatContent(j);
          if (c.reasoning) emit("reasoning", { text: c.reasoning });
          finish(c.text || text, c.reasoning || reasoning);
        });
        res.on("error", (e) => reject(e));
      },
    );
    rq.setTimeout(180000, () => rq.destroy(new Error("请求超时")));
    rq.on("error", (e) => reject(e));
    if (req.abKey) registerRequest(req.abKey, rq);
    rq.write(payload);
    rq.end();
  });
}

/* 流式调用 IPC：事件经 webContents.send('api:streamEvent', {reqId, type, ...}) 推送。
   类型：reasoning（思考增量）| delta（正文增量）| done（{text}）| error（{error}）。
   兼容性：接口不支持 stream 时（HTTP 4xx）自动回退为非流式单次请求（无思考内容）。 */
ipcMain.handle("api:callStream", async (e, spec) => {
  const wc = e.sender;
  const reqId = spec && spec.reqId;
  const emit = (type, data) => {
    try {
      if (!wc.isDestroyed())
        wc.send("api:streamEvent", Object.assign({ reqId, type }, data || {}));
    } catch {}
  };
  try {
    checkProvider(spec.provider);
    if (spec.kind !== "text") {
      const r = await apiCall(spec);
      emit("done", { text: r.text || "" });
      return { ok: true };
    }
    const req = buildRequestSpec(
      spec.provider,
      spec.kind,
      spec.model,
      spec.prompt,
      spec.texts,
      spec.images,
      spec.refImage,
      spec.temperature,
      spec.size,
      spec.chatMessages,
    );
    if (spec.abKey) req.abKey = spec.abKey;
    const { text, reasoning } = await streamTextChat(req, emit);
    emit("done", { text, reasoning });
    return { ok: true };
  } catch (err) {
    if (err && err.httpStatus >= 400 && spec.kind === "text") {
      try {
        const r = await apiCall(spec);
        emit("done", { text: r.text || "" });
        return { ok: true };
      } catch (err2) {
        const m = err2.message || String(err2);
        emit("error", { error: m });
        return { ok: false, error: m };
      }
    }
    const m = err.message || String(err);
    emit("error", { error: m });
    return { ok: false, error: m };
  }
});
ipcMain.handle("api:preview", async (e, spec) => {
  try {
    checkProvider(spec.provider);
    const req = buildRequestSpec(
      spec.provider,
      spec.kind,
      spec.model,
      spec.prompt,
      spec.texts,
      spec.images,
      spec.refImage,
      spec.temperature,
      spec.size,
      spec.chatMessages,
    );
    const readable = JSON.parse(
      JSON.stringify(req.body, (k, v) => {
        if (k === "image" && Array.isArray(v))
          return v.map((x) => "<参考图: " + x + ">");
        if (k === "image" && typeof v === "string" && v && !v.startsWith("<"))
          return "<参考图: " + v + ">";
        return v;
      }),
    );
    return {
      ok: true,
      request: {
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: readable,
      },
    };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
});

/* ---------------- 窗口 ---------------- */

app.whenReady().then(() => {
  /* 隐藏原生窗口菜单栏（File/Edit/View/Window/Help），按键快捷方式由渲染层自行处理 */
  Menu.setApplicationMenu(null);
  migrateLegacyWorkflows();
  mainWin = new BrowserWindow({
    width: 1500,
    height: 940,
    minWidth: 1000,
    minHeight: 640,
    title: "MTNode AI编排器 · MTNode AI Orchestrator",
    icon: join(__dirname, "build", "icon.png"),
    backgroundColor: "#0d1016",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      preload: join(__dirname, "preload.js"),
    },
  });
  mainWin.loadFile(join(__dirname, "renderer", "index.html"));
  mainWin.on("closed", () => {
    mainWin = null;
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    app.emit("ready");
  }
});
