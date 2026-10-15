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

print(json.dumps(out, ensure_ascii=False))
`;

let out = null;
let pyErr = "";
try {
  const r = cp.spawnSync("python", ["-c", PY], {
    cwd: abs("llama-pack"),
    encoding: "utf8",
    timeout: 120000,
  });
  if (r.status !== 0) pyErr = "python 退出码 " + r.status + "：" + String(r.stderr || "").slice(0, 800);
  else out = JSON.parse(r.stdout);
} catch (e) {
  pyErr = String((e && e.message) || e);
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

  console.log("\n[2] API 登录与模型目录：列表只认 llm / embedding");
  eq(out.filter.all, ["a", "b"], "all 档只留 llm + embedding（vl / other 不进列表）");
  eq(out.filter.llm, ["a"], "llm 档只留 llm");
  eq(out.filter.embedding, ["b"], "embedding 档只留 embedding");
  eq(out.filter.weird, ["a", "b"], "档位值异常时按 all 处理（不空列表）");
  eq(
    out.built.map((x) => x[1]),
    ["vl", "llm", "embedding", "llm", "other"],
    "搜索结果逐条归类（VL 不再冒充 LLM，无标签的按 llm 收进来）",
  );
  eq(out.built[3].slice(2), ["unknown", true], "无标签条目：pipelineTag=unknown 且标 kindGuessed");
  eq(
    out.built_all,
    ["unsloth/Qwen2.5-7B-Instruct-GGUF", "BAAI/bge-m3-GGUF", "no/tag-gguf"],
    "all 档：VL / 重排被挡掉，无标签的留下",
  );
  hasnt(out.merge_all.join(","), "Qwen2.5-VL", "合并结果里没有 VL 仓库");
  hasnt(out.merge_all.join(","), "reranker", "合并结果里没有重排仓库");
  hasnt(out.merge_llm.join(","), "bge-m3-GGUF", "llm 档里没有 embedding 仓库");
  hasnt(out.merge_emb.join(","), "unsloth/Qwen2.5-7B-Instruct-GGUF", "embedding 档里没有 llm 仓库");

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

console.log("\n[4] 搜索词拼装与口径常量（源码 grep）");
{
  const cat = read("llama-pack/app/catalog.py");
  has(cat, "_CATALOG_KINDS = (\"llm\", \"embedding\")", "列表口径常量就位");
  has(cat, 'if kind == "embedding":', "embedding 档把关键词补成 embedding gguf");
  has(cat, 'tag.endswith("/text-generation")', "带前缀的同族标签也认 llm");
  has(cat, "_SIZE_CONCURRENCY", "体积解析并发上限就位");
  has(cat, "_SIZE_TOTAL_BUDGET", "体积解析有整段预算");
  has(cat, "_SIZE_CACHE", "体积解析有 TTL 缓存");
  has(cat, "await asyncio.wait(tasks, timeout=_SIZE_TOTAL_BUDGET)", "整段预算用 asyncio.wait（已拿到的体积保住）");
  hasnt(cat, "raw.get(\"usedStorage\")", "catalog.py 不再用 usedStorage 当体积（搜索响应里没有这个字段）");
  has(cat, "from app.models import _quant_rank", "挑件口径复用下载侧真源，没有第二份偏好表");
  has(cat, "kindGuessed", "无标签条目的「猜的」标记给到界面");
  const ui = read("llama/ui/app.js");
  has(ui, 'm.sizeUnknown ? "未知" : fmtSizeCompact(m.totalSizeGb)', "体积未知的行在界面上写明「未知」");
  has(ui, 'if ($("kindFilter"))', "类型下拉挂上 change 监听（改选即重搜）");
  has(ui, 'addDetailField(form, "下载大小"', "详情页体积口径与列表同源（不再拿整仓占用冒充）");
  const panel = read("llama/ui/console-panel.js");
  has(panel, "t.text === lastText", "控制台轮询比较正文本身（日志超过 128KB 后不再停止刷新）");
}

console.log(fails ? "\nFAILED  " + fails + " / " + checks : "\nALL PASS " + checks + " checks");
process.exit(fails ? 1 : 0);
