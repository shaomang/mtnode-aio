"use strict";
/* llama.cpp 在线模型列表的「白名单 kind」与「体积口径」——冒烟测试
 *   node test/smoke-llama-catalog.js
 *
 * 为什么要有这只用例（用户报障）：
 *   ① 列表把「非 embedding 即 llm」当兜底：VL 多模态（image-text-to-text）、重排、分类、
 *      甚至语音 / 音乐 / 检测类仓库全被当 LLM 摆出来，装完 llama-server 根本拉不起来；
 *   ② 体积只依赖 `usedStorage`（搜索响应里根本没有这个字段）⇒ 体积档位筛不动，
 *      「已安装」页与目录页的体积格永远是「—」。
 *
 * 口径（本轮）：
 *   · `_kind_of` 白名单：text-generation / conversational（含 xxx/text-generation）= llm；
 *     feature-extraction / sentence-similarity / text-embedding = embedding；
 *     image-text-to-text / visual-question-answering = vl；其余 = other（绝不默认成 llm）；
 *     标签为空时按名字别名兜底，认不出才当 llm 且标 kindGuessed（无标签的文本模型也搜得到）；
 *   · 列表只认 llm / embedding 两类（all 也只留这两类）；
 *   · 体积 = 仓库里「这次会下载的那一份」GGUF 的真实字节数（挑法与下载侧同源）；
 *     解析不到就是未知：带体积档位时排除，全部档位照旧展示。
 *
 * 覆盖（本文件用真 Python 跑 llama-pack/app/catalog.py 的纯函数，不联网、不碰用户机器）：
 *   [1] kind 白名单逐条判据（llm / embedding / vl / other / 无标签兜底）
 *   [2] 列表过滤：all / llm / embedding 三档 + 条目构造 + 合并去重
 *   [3] 体积口径：真实字节数、未知处理、档位筛选、体积挑件与下载侧同源
 *   [4] 搜索词拼装（grep 源码：kind / 体积并发常量就位，防止口径被改回旧写法）
 *   [5] 架构收窄（本轮用户报障）：GGUF 文件头解析、引擎认不认架构的三态判定、
 *       「探到非对话架构 → 改判 other 丢掉」「引擎不支持 → 不收进列表」
 */
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
const eq = (a, b, msg) =>
  ok(JSON.stringify(a) === JSON.stringify(b), msg + "（得到 " + JSON.stringify(a) + "）");

const ROOT = path.join(__dirname, "..");
const abs = (rel) => path.join(ROOT, rel.split("/").join(path.sep));
const read = (rel) => fs.readFileSync(abs(rel), "utf8").replace(/\r\n/g, "\n");
const has = (text, needle, msg) => ok(text.indexOf(needle) >= 0, msg + "  [" + needle + "]");
const hasnt = (text, needle, msg) => ok(text.indexOf(needle) < 0, msg + "  [无 " + needle + "]");

/* ── 真跑 Python 纯函数 ──────────────────────────────────────────────────────
   catalog.py 里「怎么挑那一份 GGUF」「量化偏好」都复用 app/models.py 的真源，
   所以这里直接在 llama-pack 目录下 import app.catalog 跑真代码（只调纯函数，不发请求）。 */
const PY = `
import json
from app import catalog as C
from app.models import _quant_rank

out = {}

# [1] kind 白名单
out["kinds"] = [
    [tag, mid, C._kind_of(tag, mid)]
    for tag, mid in [
        ("text-generation", "Qwen/Qwen2.5-7B-Instruct"),
        ("conversational", "meta-llama/Llama-3-8B"),
        ("any/text-generation", "x/y"),
        ("feature-extraction", "BAAI/bge-m3"),
        ("sentence-similarity", "sentence-transformers/all-MiniLM-L6-v2"),
        ("text-embedding", "x/y"),
        ("image-text-to-text", "Qwen/Qwen2.5-VL-7B-Instruct"),
        ("visual-question-answering", "x/y"),
        ("text-ranking", "BAAI/bge-reranker-v2-m3"),
        ("text-classification", "x/y"),
        ("automatic-speech-recognition", "openai/whisper-tiny"),
        ("text-to-speech", "audio-cpp/audio.cpp-gguf"),
        ("object-detection", "mudler/locate-anything.cpp-gguf"),
        ("", "Qwen/Qwen2.5-VL-7B-Instruct-GGUF"),
        ("", "BAAI/bge-large-zh-v1.5"),
        ("", "unsloth/Qwen3.8-27B-GGUF"),
        ("", "Serveurperso/YuE2-GGUF"),
        ("", ""),
    ]
]

# [2] 列表过滤 + 条目构造 + 合并
items = [
    {"id": "a", "kind": "llm"},
    {"id": "b", "kind": "embedding"},
    {"id": "c", "kind": "vl"},
    {"id": "d", "kind": "other"},
]
out["filter"] = {k: [x["id"] for x in C._filter_kind(items, k)] for k in ("all", "llm", "embedding", "weird")}
raw = [
    {"id": "Qwen/Qwen2.5-VL-7B-Instruct-GGUF", "pipeline_tag": "image-text-to-text", "downloads": 9},
    {"id": "unsloth/Qwen2.5-7B-Instruct-GGUF", "pipeline_tag": "text-generation", "downloads": 8},
    {"id": "BAAI/bge-m3-GGUF", "pipeline_tag": "feature-extraction", "downloads": 7},
    {"id": "no/tag-gguf", "downloads": 6},
    {"id": "x/reranker-GGUF", "pipeline_tag": "text-ranking", "downloads": 5},
]
built = [C._from_hf_item(x) for x in raw]
out["built"] = [[x["id"], x["kind"], x["pipelineTag"], x["kindGuessed"]] for x in built]
out["built_all"] = [x["id"] for x in C._filter_kind(built, "all")]
out["merge_all"] = [x["id"] for x in C._merge_curated(built, "", "all")]
out["merge_llm"] = [x["id"] for x in C._merge_curated(built, "", "llm")]
out["merge_emb"] = [x["id"] for x in C._merge_curated(built, "", "embedding")]

# [3] 体积口径
repo = {
    "siblings": [
        {"rfilename": "model-Q4_K_M.gguf", "size": 4_400_000_000},
        {"rfilename": "model-Q8_0.gguf", "size": 8_200_000_000},
        {"rfilename": "model-Q4_K_M-of-00002.gguf", "size": 2_200_000_000},
        {"rfilename": "model-split-00001-of-00002.gguf", "size": 2_200_000_000},
        {"rfilename": "README.md", "size": 100},
    ]
}
pick = C._download_file_of(repo)
out["pick"] = pick
picked_bytes = C._file_bytes(repo, pick)
out["picked_bytes"] = picked_bytes
out["picked_rank_matches"] = _quant_rank(pick) <= _quant_rank("model-Q8_0.gguf")
out["smallest_not_chosen"] = pick != "model-Q4_K_M-of-00002.gguf" and "split" not in pick

item = C._from_hf_item({"id": "x/y", "pipeline_tag": "text-generation"})
C._set_size(item, picked_bytes)
out["set_size"] = [item["sizeGb"], item["sizeUnknown"], item["totalSizeGb"]]
C._set_size(item, None)
out["set_size_none"] = [item["sizeGb"], item["sizeUnknown"], item["totalSizeGb"]]

b16 = [C._from_hf_item({"id": "a"}), C._from_hf_item({"id": "b"}), C._from_hf_item({"id": "c"})]
for it, gb in zip(b16, [8.0, 70.0, None]):
    it["sizeGb"] = gb
    it["sizeUnknown"] = gb is None
out["band_lt32"] = [x["id"] for x in C._filter_size(b16, "lt32")]
out["band_gt64"] = [x["id"] for x in C._filter_size(b16, "gt64")]
out["band_all"] = [x["id"] for x in C._filter_size(b16, "")]
out["bands_drop_unknown"] = "c" not in out["band_lt32"] and "c" not in out["band_gt64"]

# 聚合推荐（CURATED）自带的体积不能被「网上没解析到」盖成未知
cur = list(C.CURATED)
out["curated_has_size"] = all(isinstance(x.get("sizeGb"), (int, float)) for x in cur)

# [5] 架构收窄
import struct, tempfile, os as _os
from app import models as M

def mk_gguf(arch=None, extra_after=0):
    """最小 GGUF：magic + ver3 + 0 tensors + KV( general.architecture ) [+ 若干填充 KV ]"""
    kvs = []
    if arch is not None:
        kvs.append(("general.architecture", arch))
    kvs.append(("general.name", "t"))
    for i in range(extra_after):
        kvs.append(("x.pad%d" % i, i))
    b = b"GGUF" + struct.pack("<I", 3) + struct.pack("<Q", 0) + struct.pack("<Q", len(kvs))
    for k, v in kvs:
        kb = k.encode()
        if isinstance(v, int):
            b += struct.pack("<Q", len(kb)) + kb + struct.pack("<I", 4) + struct.pack("<I", v)
        else:
            b += struct.pack("<Q", len(kb)) + kb + struct.pack("<I", 8) + struct.pack("<Q", len(v)) + v.encode()
    return b

out["head"] = {
    "qwen2": C._gguf_arch_from_head(mk_gguf("qwen2")),
    "bad": C._gguf_arch_from_head(mk_gguf("deepseek4_mtp_support")),
    "late_key": C._gguf_arch_from_head(mk_gguf("gemma4", extra_after=40)),
    "no_key": C._gguf_arch_from_head(mk_gguf(None)),
    "garbage": C._gguf_arch_from_head(b"not a gguf" + bytes(64)),
    "badver": C._gguf_arch_from_head(b"GGUF" + struct.pack("<I", 99) + bytes(64)),
    "empty": C._gguf_arch_from_head(b""),
}
with tempfile.TemporaryDirectory() as td:
    p = _os.path.join(td, "a.gguf")
    with open(p, "wb") as f:
        f.write(mk_gguf("qwen2"))
    out["local_head_file"] = M.local_gguf_arch(__import__("pathlib").Path(p))
    p2 = _os.path.join(td, "b.gguf")
    with open(p2, "wb") as f:
        f.write(mk_gguf("deepseek4_mtp_support"))
    # 引擎二进制是**用户机器**上的东西（源码目录里没有 bin/）：这里把「引擎认哪些架构」
    # 这一个变量钉住，让「支持 → 放行 / 不支持 → 挡下」两条都可复现。
    M._engine_arch_cache = {"qwen2", "llama", "gemma4"}
    out["local_check_bad"] = list(M.check_local_arch(__import__("pathlib").Path(p2)))
    out["local_check_good"] = list(M.check_local_arch(__import__("pathlib").Path(p)))
    p3 = _os.path.join(td, "c.bin")
    with open(p3, "wb") as f:
        f.write(b"not a gguf")
    out["local_check_notgguf"] = list(M.check_local_arch(__import__("pathlib").Path(p3)))

out["probe_repo"] = [
    C._probe_repo({"id": "google/gemma-4-E4B-it", "ggufRepo": "unsloth/gemma-4-E4B-it-GGUF"}),
    C._probe_repo({"id": "Qwen/Qwen2.5-0.5B-Instruct-GGUF"}),
    C._probe_repo({"id": "", "ggufRepo": ""}),
]
bad_items = [
    {"id": "a", "kind": "llm", "arch": "clip", "archStatus": "confirmed"},
    {"id": "b", "kind": "llm", "arch": "bert", "archStatus": "confirmed"},
    {"id": "c", "kind": "llm", "arch": "qwen2", "archStatus": "confirmed"},
    {"id": "d", "kind": "llm", "arch": "", "archStatus": "unsupported"},
    {"id": "e", "kind": "llm", "arch": "", "archStatus": "unconfirmed"},
]
for x in bad_items:
    C._apply_arch_kind(x)
out["arch_kind"] = [[x["id"], x["kind"]] for x in bad_items]
out["arch_kept"] = [x["id"] for x in C._filter_arch(bad_items)]
out["non_llm_arches"] = list(C._NON_LLM_ARCHES)
out["kinds_whitelist"] = list(C._CATALOG_KINDS)
out["filter_kind_embed"] = [x["id"] for x in C._filter_kind(
    [{"id": "a", "kind": "llm"}, {"id": "b", "kind": "embedding"}], "embedding")]

print(json.dumps(out, ensure_ascii=False))
`;

let out = null;
let pyErr = "";
/* 真 Python 优先用当前工程/后端自带的 venv（[5] 的假镜像那半边需要 httpx）；
   都没有就退回系统 python（[1]~[4] 是纯标准库，照样跑）。 */
function pickPython() {
  const cands = [
    process.env.MTNODE_LLAMA_PY,
    abs("llama-pack/.venv/Scripts/python.exe"),
    "python",
  ].filter(Boolean);
  for (const p of cands) {
    try {
      if (p === "python" || fs.existsSync(p)) return p;
    } catch {}
  }
  return "python";
}
const PYEXE = pickPython();
try {
  const r = cp.spawnSync(PYEXE, ["-c", PY], {
    cwd: abs("llama-pack"),
    encoding: "utf8",
    timeout: 120000,
  });
  if (r.status !== 0) pyErr = "python 退出码 " + r.status + "：" + String(r.stderr || "").slice(0, 800);
  else out = JSON.parse(r.stdout);
} catch (e) {
  pyErr = String((e && e.message) || e);
}

/* ── [5] 的联网那半边：本地假 hf-mirror ────────────────────────────────────
   架构探测要读「仓库元数据 + GGUF 文件头」，这两步都要发 HTTP。这里在同一个 Python 进程里
   起一只标准库 ThreadingHTTPServer 假装 hf-mirror（/api/models/<repo> 与
   /<repo>/resolve/main/<file>），于是能真跑 _repo_arch 的三态判定与 TTL 缓存，
   不联网、不碰用户机器，也没有跨进程假服务的 keep-alive 麻烦。 */
const STUB_ARCH_PROBE = `
import json, asyncio, struct, threading, http.server, httpx
from app import catalog as C, models as M

FILES = {
    "ok/repo": "ok.gguf",
    "bad/repo": "bad.gguf",
    "unsup/repo": "unsup.gguf",
    "nohead/repo": "nohead.gguf",
    "nofile/repo": "only-00001-of-00002.gguf",
}
ARCHES = {"ok/repo": "qwen2", "bad/repo": "clip", "unsup/repo": "t5"}

def mk_gguf(arch):
    kv = [("general.architecture", arch), ("general.name", "stub")]
    b = b"GGUF" + struct.pack("<I", 3) + struct.pack("<Q", 0) + struct.pack("<Q", len(kv))
    for k, v in kv:
        kb, vb = k.encode(), v.encode()
        b += struct.pack("<Q", len(kb)) + kb + struct.pack("<I", 8) + struct.pack("<Q", len(vb)) + vb
    return b

class H(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.0"   # 每条请求一条连接，别让池子里留死连接
    def _send(self, code, body, ctype):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
    def do_GET(self):
        u = self.path
        if u.startswith("/api/models/"):
            repo = u[len("/api/models/"):]
            f = FILES.get(repo)
            if not f:
                self._send(404, b"{}", "application/json"); return
            self._send(200, json.dumps({"id": repo, "siblings": [{"rfilename": f}]}).encode(), "application/json")
            return
        if "/resolve/main/" in u:
            repo = u[1:].split("/resolve/main/")[0]
            if repo == "nohead/repo":
                self._send(206, b"not a gguf at all", "application/octet-stream"); return
            self._send(206, mk_gguf(ARCHES.get(repo, "qwen2")), "application/octet-stream")
            return
        self._send(404, b"", "text/plain")
    def log_message(self, *a):
        pass

srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), H)
port = srv.server_address[1]
threading.Thread(target=srv.serve_forever, daemon=True).start()

out = {}
# 引擎二进制是用户机器上的东西：这里钉住「引擎认哪些架构」这一个变量，
# 让三态判定可复现（真引擎的判据由 [5] 上半段那几条覆盖）。
# clip 故意留在「引擎认」里：它就是「引擎能加载、但不是可对话 LLM」那一类。
M._engine_arch_cache = {"qwen2", "llama", "gemma4", "clip"}
out["engine_cache_patched"] = bool(M.engine_supports_arch("qwen2")) and not M.engine_supports_arch("deepseek4_mtp_support")
C.HF_MIRROR = "http://127.0.0.1:%d" % port
C.HF_API = C.HF_MIRROR + "/api"

async def main():
    async with httpx.AsyncClient(timeout=8.0, follow_redirects=True) as c:
        out["ok"] = list(await C._repo_arch(c, "ok/repo"))
        out["nonllm"] = list(await C._repo_arch(c, "bad/repo"))
        out["unsup"] = list(await C._repo_arch(c, "unsup/repo"))
        out["nohead"] = list(await C._repo_arch(c, "nohead/repo"))
        out["nofile"] = list(await C._repo_arch(c, "nofile/repo"))
        out["missing_repo"] = list(await C._repo_arch(c, "ghost/repo"))
        # 三态 + 收窄：引擎不支持 / 非对话架构 → 不进列表；未确认 → 保留
        items = [
            {"id": "ok/repo", "kind": "llm", "arch": None, "archStatus": "unconfirmed", "ggufRepo": "ok/repo", "sizeGb": 1},
            {"id": "bad/repo", "kind": "llm", "arch": None, "archStatus": "unconfirmed", "ggufRepo": "bad/repo", "sizeGb": 1},
            {"id": "unsup/repo", "kind": "llm", "arch": None, "archStatus": "unconfirmed", "ggufRepo": "unsup/repo", "sizeGb": 1},
            {"id": "nohead/repo", "kind": "llm", "arch": None, "archStatus": "unconfirmed", "ggufRepo": "nohead/repo", "sizeGb": 1},
        ]
        await C._attach_arch(items)
        out["statuses"] = [[x["id"], x["arch"], x["archStatus"]] for x in items]
        out["after_filter"] = [x["id"] for x in C._filter_arch(items)]
        # 真实搜索里的顺序：探架构 → _apply_arch_kind 把非对话架构改判 other → 再按 kind 收口
        for x in items:
            C._apply_arch_kind(x)
        out["after_kind"] = [x["id"] for x in C._filter_kind(C._filter_arch(items), "all")]
    # TTL 缓存：命中后不再发请求（镜像指向不存在的主机也照样返回）
    C._ARCH_CACHE.clear()
    C._arch_cache_put("cached/repo", ("llama", "confirmed"))
    C.HF_MIRROR = "http://127.0.0.1:1"
    C.HF_API = C.HF_MIRROR + "/api"
    async with httpx.AsyncClient(timeout=3.0, follow_redirects=True) as c2:
        out["cache_hit"] = list(await C._repo_arch(c2, "cached/repo"))
    out["cache_ttl_hit"] = C._arch_cache_get("cached/repo")

asyncio.run(main())
srv.shutdown()
print(json.dumps(out, ensure_ascii=False))
`;

function runRepoArchProbe() {
  const r = cp.spawnSync(PYEXE, ["-c", STUB_ARCH_PROBE], {
    cwd: abs("llama-pack"),
    encoding: "utf8",
    timeout: 120000,
  });
  if (r.status !== 0) throw new Error("python 退出码 " + r.status + "：" + String(r.stderr || "").slice(0, 800));
  return JSON.parse(r.stdout);
}

console.log("\n[1] API 登录与模型目录：kind 白名单");
if (!out) {
  ok(false, "真跑 llama-pack/app/catalog.py 失败 —— " + pyErr);
} else {
  const want = [
    ["text-generation", "llm"],
    ["conversational", "llm"],
    ["any/text-generation", "llm"],
    ["feature-extraction", "embedding"],
    ["sentence-similarity", "embedding"],
    ["text-embedding", "embedding"],
    ["image-text-to-text", "vl"],
    ["visual-question-answering", "vl"],
    ["text-ranking", "other"],
    ["text-classification", "other"],
    ["automatic-speech-recognition", "other"],
    ["text-to-speech", "other"],
    ["object-detection", "other"],
    ["", "vl"],
    ["", "embedding"],
    ["", "llm"],
    ["", "other"],
    ["", "other"],
  ];
  out.kinds.forEach((k, i) => {
    eq(k[2], want[i][1], "kind 判据 [" + i + "] tag=" + JSON.stringify(k[0]) + " id=" + k[1]);
  });
  const ids = out.kinds.map((k) => k[1]);
  eq(ids[13], "Qwen/Qwen2.5-VL-7B-Instruct-GGUF", "无标签的 VL 仓库按别名认出来（不当 LLM）");
  eq(ids[16], "Serveurperso/YuE2-GGUF", "无标签的音乐仓库不当 LLM");
  eq(ids[15], "unsloth/Qwen3.8-27B-GGUF", "无标签的文本仓库归 llm（否则用户搜不到它）");

  console.log("\n[2] API 登录与模型目录：列表只认 llm 一类");
  eq(out.filter.all, ["a"], "all 档只留 llm（embedding 不进列表）");
  eq(out.filter.llm, ["a"], "llm 档只留 llm");
  eq(out.filter.embedding, [], "embedding 档已不在口径里：查它得到空（绝不被当成 all 又放回来）");
  eq(out.filter.weird, ["a"], "档位值异常时按 all 处理（不空列表）");
  eq(
    out.built.map((x) => x[1]),
    ["vl", "llm", "embedding", "llm", "other"],
    "搜索结果逐条归类（VL 不再冒充 LLM，无标签的按 llm 收进来）",
  );
  eq(out.built[3].slice(2), ["unknown", true], "无标签条目：pipelineTag=unknown 且标 kindGuessed");
  eq(
    out.built_all,
    ["unsloth/Qwen2.5-7B-Instruct-GGUF", "no/tag-gguf"],
    "all 档：VL / 重排 / 向量模型被挡掉，无标签的文本仓库留下",
  );
  hasnt(out.merge_all.join(","), "Qwen2.5-VL", "合并结果里没有 VL 仓库");
  hasnt(out.merge_all.join(","), "reranker", "合并结果里没有重排仓库");
  hasnt(out.merge_llm.join(","), "bge-m3-GGUF", "llm 档里没有 embedding 仓库");
  eq(out.merge_emb, [], "embedding 档查不到东西（口径只剩 llm）");

  console.log("\n[3] API 登录与模型目录：体积按真实 GGUF 字节数");
  eq(out.pick, "model-Q4_K_M.gguf", "挑的是量化偏好最高的一份（不是最小的分片）");
  eq(out.picked_bytes, 4400000000, "取到的是那一份的真实字节数");
  ok(out.picked_rank_matches, "挑件的量化偏好与 app/models.py 的 _quant_rank 同源");
  ok(out.smallest_not_chosen, "*-of-* 分片与 split 件被跳过（不会按 2.2GB 的分片算体积）");
  eq(out.set_size, [4.1, false, 4.1], "sizeGb / sizeUnknown / totalSizeGb 三格都按真实体积写");
  eq(out.set_size_none, [null, true, null], "解析不到 → 体积未知（三格同为未知）");
  eq(out.band_lt32, ["a"], "<32GB 档只留 8GB 那条");
  eq(out.band_gt64, ["b"], ">64GB 档只留 70GB 那条");
  eq(out.band_all, ["a", "b", "c"], "全部档照旧展示（含体积未知的那条）");
  ok(out.bands_drop_unknown, "带体积档位时体积未知的条目被排除（旧口径会把它放进 <16GB 里）");
  ok(out.curated_has_size, "聚合推荐条目自带体积（不会被「解析不到」盖成未知）");
}

console.log("\n[5] 架构收窄：GGUF 文件头 + 引擎判据 + 假镜像三态");
{
  if (!out) {
    ok(false, "真跑 llama-pack 的架构解析失败 —— " + pyErr);
  } else {
    eq(out.head.qwen2, "qwen2", "GGUF 文件头能读到 general.architecture");
    eq(out.head.bad, "deepseek4_mtp_support", "用户现场炸掉的那个架构名照样读得出");
    eq(out.head.late_key, "gemma4", "架构键排在其他键之后也读得到（逐键跳值，不是瞎找）");
    eq(out.head.no_key, "", "没有架构键 → 空串（未确认，不是「不支持」）");
    eq(out.head.garbage, "", "非 GGUF 文件 → 空串（不误判）");
    eq(out.head.badver, "", "GGUF 版本号异常 → 空串（不硬解析）");
    eq(out.head.empty, "", "空文件 → 空串（不抛异常）");
    eq(out.local_head_file, "qwen2", "本地 GGUF 文件头读架构（与远程探测同一格式口径）");
    eq(out.local_check_good, [true, "qwen2", ""], "本地文件：引擎支持的架构 → 放行");
    eq(
      out.local_check_bad,
      [false, "deepseek4_mtp_support", "architecture_not_supported"],
      "本地文件：引擎不支持的架构 → 部署前就挡下并给出错误码",
    );
    eq(out.local_check_notgguf, [true, "", ""], "读不出架构的本地文件放行（交给引擎自己报错，本闸只挡已证实的）");
    eq(
      out.probe_repo,
      ["unsloth/gemma-4-E4B-it-GGUF", "Qwen/Qwen2.5-0.5B-Instruct-GGUF", ""],
      "聚合推荐条目按 ggufRepo 探架构（探原始权重仓库会得出假结论）",
    );
    eq(
      out.arch_kind,
      [["a", "other"], ["b", "other"], ["c", "llm"], ["d", "llm"], ["e", "llm"]],
      "探到 clip / bert 这类非对话架构 → 改判 other（列表收掉）；对话架构保持 llm",
    );
    eq(out.arch_kept, ["a", "b", "c", "e"], "收窄只丢「引擎不支持」那条（未确认的保留）");
    ok(out.non_llm_arches.includes("clip") && out.non_llm_arches.includes("bert"), "非对话架构名单含实测样本 clip / bert");
    eq(out.kinds_whitelist, ["llm"], "列表口径只剩 llm");
    eq(out.filter_kind_embed, [], "embedding 档在服务端就查不到（老界面/老缓存也绕不过去）");
  }
}

console.log("\n[6] 架构探测的联网那半边：本地假 hf-mirror 三态 + 缓存");
(async () => {
  try {
    const p = await runRepoArchProbe();
    ok(p.engine_cache_patched, "钉住「引擎认哪些架构」这一个变量（qwen2 认、t5 不认）");
    eq(p.ok, ["qwen2", "confirmed"], "探到 + 引擎认 + 可对话 → confirmed");
    eq(p.nonllm, ["clip", "non-llm"], "探到 + 引擎认 + 不是可对话 LLM（clip 文本编码器）→ non-llm");
    eq(p.unsup, ["", "unsupported"], "探到但引擎不认（t5 不在本机引擎里）→ unsupported");
    eq(p.nohead, ["", "unconfirmed"], "HTTP 206 但头部不是 GGUF → unconfirmed");
    eq(p.nofile, ["", "unconfirmed"], "仓库里只有分片、没有可下单文件 → unconfirmed");
    eq(p.missing_repo, ["", "unconfirmed"], "仓库元数据 404 → unconfirmed（不当成「不支持」）");
    eq(
      p.statuses,
      [
        ["ok/repo", "qwen2", "confirmed"],
        ["bad/repo", "clip", "non-llm"],
        ["unsup/repo", "", "unsupported"],
        ["nohead/repo", "", "unconfirmed"],
      ],
      "四种状态各自落到条目上",
    );
    eq(p.after_filter, ["ok/repo", "bad/repo", "nohead/repo"], "架构收窄：引擎不支持的踢掉，其余留下");
    eq(p.after_kind, ["ok/repo", "nohead/repo"], "再按 kind 收口：非对话架构（clip）也不进列表");
    eq(p.cache_hit, ["llama", "confirmed"], "命中缓存的仓库不再发请求（镜像已指向不存在的主机也不失败）");
    ok(p.cache_ttl_hit && p.cache_ttl_hit[0], "缓存写入带 TTL（不是永久记忆）");
  } catch (e) {
    ok(false, "假镜像那半边跑不起来（需要 httpx 的 venv python）—— " + ((e && e.message) || e));
  }
  summary();
})();

console.log("\n[4] 搜索词拼装与口径常量（源码 grep）");
{
  const cat = read("llama-pack/app/catalog.py");
  has(cat, "_CATALOG_KINDS = (\"llm\",)", "列表口径常量收敛为只认 llm");
  hasnt(cat, 'if kind == "embedding":', "embedding 档的关键词拼装分支已移除（口径只剩 llm）");
  has(cat, 'tag.endswith("/text-generation")', "带前缀的同族标签也认 llm");
  has(cat, "_SIZE_CONCURRENCY", "体积解析并发上限就位");
  has(cat, "_SIZE_TOTAL_BUDGET", "体积解析有整段预算");
  has(cat, "_SIZE_CACHE", "体积解析有 TTL 缓存");
  has(cat, "await asyncio.wait(tasks, timeout=_SIZE_TOTAL_BUDGET)", "整段预算用 asyncio.wait（已拿到的体积保住）");
  hasnt(cat, "raw.get(\"usedStorage\")", "catalog.py 不再用 usedStorage 当体积（搜索响应里没有这个字段）");
  has(cat, "from app.models import _quant_rank", "挑件口径复用下载侧真源，没有第二份偏好表");
  has(cat, "kindGuessed", "无标签条目的「猜的」标记给到界面");
  has(cat, "_ARCH_PROBE_RANGE = 256 * 1024", "架构探测起始只取 256KB（Range 请求）");
  has(cat, "_ARCH_PROBE_RANGE_MAX = 2 * 1024 * 1024", "头部没读到架构键时扩到 2MB 再读一次");
  has(cat, "_ARCH_PROBE_TOTAL_BUDGET = 75.0", "架构探测整段预算 75s");
  has(cat, "await asyncio.wait(tasks, timeout=_ARCH_PROBE_TOTAL_BUDGET)", "架构探测整段预算同用 asyncio.wait");
  has(cat, "from app.models import engine_supports_arch as _engine_supports_arch", "架构判据复用后端引擎自述，不另抄白名单");
  has(cat, "return [x for x in items if x.get(\"archStatus\") != \"unsupported\"]", "收窄只丢「已确认不支持」，未确认保留");
  has(cat, "_NON_LLM_ARCHES", "非对话架构（clip / bert 家族 / t5encoder …）名单就位");
  has(cat, "item[\"kind\"] = \"other\"", "探到非对话架构的条目改判 other（列表收掉）");
  const ui = read("llama/ui/app.js");
  has(ui, 'm.sizeUnknown ? "未知" : fmtSizeCompact(m.totalSizeGb)', "体积未知的行在界面上写明「未知」");
  has(ui, 'if ($("kindFilter"))', "类型下拉挂上 change 监听（改选即重搜）");
  has(ui, 'addDetailField(form, "下载大小"', "详情页体积口径与列表同源（不再拿整仓占用冒充）");
  has(ui, "架构未确认", "列表把「架构未确认」标出来（不静默保留）");
  has(ui, "架构不支持", "列表把「架构不支持」标出来");
  has(ui, 'm.archStatus === "unsupported"', "已确认不支持的条目禁用下载按钮（老缓存兜底）");
  const html = read("llama/ui/index.html");
  hasnt(html, 'value="embedding"', "类型下拉不再列 Embedding");
  has(html, ".arch-tag", "架构状态小标样式就位");
  const panel = read("llama/ui/console-panel.js");
  has(panel, "t.text === lastText", "控制台轮询比较正文本身（日志超过 128KB 后不再停止刷新）");
  const models = read("llama-pack/app/models.py");
  has(models, "def engine_supports_arch", "后端有「引擎认不认这个架构」的判据");
  has(models, "def local_gguf_arch", "后端会读本地 GGUF 文件头的架构");
  has(models, "def check_local_arch", "部署前有架构校验入口");
  has(models, '"architecture_not_supported"', "不支持的架构有明确的错误码（界面/日志可辨）");
  has(models, 'os.environ.get("MTNODE_LLAMA_INSTALL")', "引擎二进制目录认插件下发的安装目录（否则扫不到架构）");
  has(models, "unsupported architecture {arch} in {sub.name}", "手工放进 models/ 的不支持模型在日志里点名");
  hasnt(models, "_ARCH_SNAPSHOT", "不再手抄一份「支持清单」当真理（引擎升版只会变成新的谎）");
}

function summary() {
  console.log(fails ? "\nFAILED  " + fails + " / " + checks : "\nALL PASS " + checks + " checks");
  process.exit(fails ? 1 : 0);
}
