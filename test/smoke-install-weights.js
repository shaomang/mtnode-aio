"use strict";
/* 权重「指路 → 移动就位」行为回归（真正建文件搬一遍，不靠正则猜）
 *   node test/smoke-install-weights.js
 *
 * 锁住本轮共识（plugins/install-weights.js + 安装窗的「指定权重位置…」）：
 *   [1] 目标目录表：6 个插件各自的槽位与相对路径（按插件 + 安装目录推导，不自选）
 *   [2] 自动匹配：目录名命中（accepts / keepAccepts）、单槽位兜底、落单文件名命中、认不出的留在原地
 *   [3] 真移动不是复制：源文件消失、目标出现、内容逐字节一致；同名冲突用源覆盖
 *   [4] 取消：已搬完的留在目标目录，取消后不再往下搬（不回搬）
 *   [5] 空目录回收：搬空的源目录被清掉，非空目录保留
 *   [6] 入参纪律：没安装目录 / 没指定源目录 / 没认出任何文件 → 明确报错，不动盘
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

const W = require("../plugins/install-weights.js");

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
function eq(a, b, msg) {
  ok(a === b, msg + "（得到 " + JSON.stringify(a) + "，期望 " + JSON.stringify(b) + "）");
}
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mtnode-install-weights-"));
function mkdirp(p) {
  fs.mkdirSync(p, { recursive: true });
  return p;
}
function write(p, text) {
  mkdirp(path.dirname(p));
  fs.writeFileSync(p, text);
  return p;
}
function rmrf(p) {
  try {
    fs.rmSync(p, { recursive: true, force: true });
  } catch {}
}
function exists(p) {
  return fs.existsSync(p);
}

console.log("[1] 目标目录表：6 个插件，路径按安装目录推导");
const IDS = ["minimax-h3", "minimax-music3", "yue2-local", "sensenova-local", "tts-local", "breeze-tts-local"];
for (const id of IDS) {
  ok(W.supports(id) === true, id + " 支持权重指路");
  const info = W.weightsInfo(id, "D:\\install\\" + id);
  ok(!!info && info.slots.length > 0, id + " 有槽位表");
  ok(
    info.slots.every((s) => s.dir.startsWith("D:\\install\\" + id)),
    id + " 每个槽位目标都在安装目录下",
  );
}
eq(W.supports("llama-local"), false, "llama 不参与权重指路（GGUF 是运行期在控制台里下的）");
eq(W.supports("remotion"), false, "remotion 不参与（没有权重）");
const im = W.weightsInfo("minimax-h3", "C:\\x");
eq(im.slots.length, 3, "h3 三个槽位（diffusion_models / text_encoders / vae）");
ok(im.slots[0].dir.endsWith(path.join("ComfyUI", "models", "diffusion_models")), "h3 扩散模型目标 = ComfyUI\\models\\diffusion_models");
ok(
  W.weightsInfo("tts-local", "C:\\x").slots[0].dir.endsWith(path.join("engine", "GPT_SoVITS", "pretrained_models")),
  "tts 目标 = engine\\GPT_SoVITS\\pretrained_models",
);
ok(
  W.weightsInfo("breeze-tts-local", "C:\\x").slots[0].dir.endsWith(path.join("checkpoints", "breeze-tts-2")),
  "breeze 目标 = checkpoints\\breeze-tts-2",
);
eq(W.weightsInfo("llama-local", "C:\\x"), null, "没有表的插件回 null（安装窗据此整块不显示入口）");
eq(W.fmtBytes(0), "0 B", "体积文案：0");
eq(W.fmtBytes(3 * 1024 ** 3), "3.00 GB", "体积文案：GB");

console.log("\n[2] 自动匹配：目录名 / 单槽位兜底 / 落单文件 / 认不出的留下来");
/* h3：一个「Comfy-Org__MiniMax-H3」仓库根，里面正是三个同名目录 */
const h3src = path.join(tmpRoot, "h3dl", "Comfy-Org__MiniMax-H3");
write(path.join(h3src, "diffusion_models", "minimax_h3_fl2va_pruned_int8_convrot.safetensors"), "A1");
write(path.join(h3src, "diffusion_models", "minimax_h3_ref2va_pruned_int8_convrot.safetensors"), "A2");
write(path.join(h3src, "text_encoders", "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors"), "B1");
write(path.join(h3src, "vae", "minimax_h3_video_vae_fp16.safetensors"), "C1");
write(path.join(h3src, "README.md"), "docs");
const h3inst = mkdirp(path.join(tmpRoot, "h3inst"));
let plan = W.planMove({ pluginId: "minimax-h3", installDir: h3inst, sources: [path.join(tmpRoot, "h3dl")] });
ok(plan.ok === true, "h3：扫描成功");
eq(plan.total.count, 4, "h3：认出 4 个权重文件（README 不算）");
eq(plan.slots.find((s) => s.id === "diffusion_models").count, 2, "h3：diffusion_models 2 个");
eq(plan.slots.find((s) => s.id === "text_encoders").count, 1, "h3：text_encoders 1 个");
eq(plan.slots.find((s) => s.id === "vae").count, 1, "h3：vae 1 个");
ok(
  plan.unmatched.some((u) => u.path.endsWith("README.md")),
  "h3：README 被列进「未识别（留在原地）」",
);
ok(
  plan.moves.every((m) => path.dirname(m.dst).includes(path.join("ComfyUI", "models"))),
  "h3：目标全部落在 ComfyUI\\models 下",
);

/* music3：单槽位兜底（用户把仓库下成了别的目录名，里面有 model_index.json） */
const m3src = path.join(tmpRoot, "m3dl", "随便起的名字");
write(path.join(m3src, "model_index.json"), "{}");
write(path.join(m3src, "transformer", "diffusion_pytorch_model.safetensors"), "M1");
const m3inst = mkdirp(path.join(tmpRoot, "m3inst"));
plan = W.planMove({ pluginId: "minimax-music3", installDir: m3inst, sources: [m3src] });
eq(plan.total.count, 2, "music3：单槽位兜底认出 2 个文件");
ok(
  plan.moves.some((m) => m.dst.endsWith(path.join("models", "MiniMax-Music3", "transformer", "diffusion_pytorch_model.safetensors"))),
  "music3：子目录结构照原样保留（transformer\\…safetensors）",
);

/* tts：keepAccepts（chinese-hubert-base 要连名字一起搬）+ 落单文件名命中 */
const ttssrc = path.join(tmpRoot, "ttsdl");
write(path.join(ttssrc, "s2G488k.pth"), "T1");
write(path.join(ttssrc, "s2G2333k.pth"), "T1b");
write(path.join(ttssrc, "s1bert25hz-2kh-longer-epoch=68e-step=50232.ckpt"), "T2");
write(path.join(ttssrc, "chinese-hubert-base", "config.json"), "{}");
write(path.join(ttssrc, "chinese-hubert-base", "pytorch_model.bin"), "T3");
const ttsinst = mkdirp(path.join(tmpRoot, "ttsinst"));
plan = W.planMove({ pluginId: "tts-local", installDir: ttsinst, sources: [ttssrc] });
eq(plan.total.count, 5, "tts：认出 5 个文件（2 个落单 SoVITS 底模 + 1 个 GPT 底模 + hubert 两个）");
ok(
  plan.moves.some((m) => m.dst.endsWith(path.join("pretrained_models", "chinese-hubert-base", "config.json"))),
  "tts：chinese-hubert-base 连目录名一起搬进 pretrained_models",
);
ok(
  plan.moves.some((m) => m.dst.endsWith(path.join("pretrained_models", "s2G488k.pth"))),
  "tts：落单的 v1 底模 s2G488k.pth 落到 pretrained_models 根部",
);
ok(
  plan.moves.some((m) => m.dst.endsWith(path.join("pretrained_models", "s2G2333k.pth"))),
  "tts：落单的 v2 底模 s2G2333k.pth 也认（旧代码只认写错的 s2G233k）",
);

/* yue：两个槽位靠目录名区分 */
const yuesrc = path.join(tmpRoot, "yuedl");
write(path.join(yuesrc, "YuE2-3B", "model.safetensors"), "Y1");
write(path.join(yuesrc, "YuE2-Vae", "vae.safetensors"), "Y2");
const yueinst = mkdirp(path.join(tmpRoot, "yueinst"));
plan = W.planMove({ pluginId: "yue2-local", installDir: yueinst, sources: [yuesrc] });
eq(plan.total.count, 2, "yue：两个仓库各认一个文件");
ok(
  plan.moves.some((m) => m.dst.includes(path.join("models", "m-a-p__YuE2-3B"))),
  "yue：YuE2-3B → models\\m-a-p__YuE2-3B",
);
ok(
  plan.moves.some((m) => m.dst.includes(path.join("models", "m-a-p__YuE2-Vae"))),
  "yue：YuE2-Vae → models\\m-a-p__YuE2-Vae",
);

/* 认不出来：一个只有图片的目录 */
const junk = path.join(tmpRoot, "junk");
write(path.join(junk, "cover.png"), "img");
plan = W.planMove({ pluginId: "breeze-tts-local", installDir: mkdirp(path.join(tmpRoot, "binst")), sources: [junk] });
eq(plan.total.count, 0, "认不出：没有可搬的文件");
ok(plan.unmatched.length >= 1, "认不出：列进 unmatched（留在原地）");

console.log("\n[3] 真移动不是复制：源消失、目标出现、内容一致；同名冲突用源覆盖");
plan = W.planMove({ pluginId: "minimax-h3", installDir: h3inst, sources: [path.join(tmpRoot, "h3dl")] });
const target = path.join(h3inst, "ComfyUI", "models", "diffusion_models", "minimax_h3_fl2va_pruned_int8_convrot.safetensors");
/* 目标先放一份旧的同名文件（模拟上次下到一半），移动后必须被源覆盖 */
write(target, "OLD");
const r = W.movePlan(plan, {});
eq(r.ok, true, "移动成功");
eq(r.moved, 4, "移动了 4 个文件");
eq(fs.readFileSync(target, "utf8"), "A1", "同名冲突：目标被**源文件**覆盖（不是保留旧的）");
eq(exists(path.join(h3src, "diffusion_models", "minimax_h3_fl2va_pruned_int8_convrot.safetensors")), false, "源文件已消失（是移动，不是复制）");
eq(exists(path.join(h3src, "README.md")), true, "未识别的 README 留在原地");
eq(exists(path.join(h3src, "diffusion_models")), false, "搬空的源子目录被回收");
eq(exists(path.join(h3src, "text_encoders")), false, "另一个搬空的源子目录也被回收");
eq(r.unmatched.length, 1, "结果里如实带回未识别清单（1 项）");

console.log("\n[4] 取消：已搬完的留在目标目录，不再往下搬");
const csrc = path.join(tmpRoot, "cancel");
for (let i = 0; i < 6; i++) write(path.join(csrc, "diffusion_models", "minimax_h3_f" + i + ".safetensors"), "F" + i);
const cinst = mkdirp(path.join(tmpRoot, "cinst"));
const cplan = W.planMove({ pluginId: "minimax-h3", installDir: cinst, sources: [csrc] });
eq(cplan.total.count, 6, "取消用例：6 个文件待搬");
let seen = 0;
const rc = W.movePlan(cplan, {
  isCancelled: () => seen >= 2,
  onProgress: () => {
    seen++;
  },
});
eq(rc.cancelled, true, "取消标记如实回传");
eq(rc.moved, 2, "取消时只搬了 2 个（不继续往下）");
eq(
  fs.readdirSync(path.join(cinst, "ComfyUI", "models", "diffusion_models")).length,
  2,
  "已搬完的 2 个留在目标目录（不回搬）",
);
eq(
  fs.readdirSync(path.join(csrc, "diffusion_models")).length,
  4,
  "没轮到的 4 个留在源目录（下次再点「移动并就位」接着搬）",
);

console.log("\n[5] 入参纪律：错就明确报错，不动盘");
let bad = W.planMove({ pluginId: "llama-local", installDir: "C:\\x", sources: ["C:\\y"] });
eq(bad.ok, false, "没有表的插件：planMove 直接拒");
eq(bad.error, "no_weights_spec", "错误码 no_weights_spec");
bad = W.planMove({ pluginId: "minimax-h3", installDir: "", sources: ["C:\\y"] });
eq(bad.error, "no_install_dir", "没安装目录：no_install_dir");
bad = W.planMove({ pluginId: "minimax-h3", installDir: "C:\\x", sources: [] });
eq(bad.error, "no_source", "没指定源目录：no_source");
bad = W.movePlan({ ok: false }, {});
eq(bad.ok, false, "movePlan 不接受坏 plan");

/* 清场 */
rmrf(tmpRoot);

console.log("\n" + (fails ? "FAILED " + fails + " / " + checks : "ALL PASS " + checks) + " checks");
process.exit(fails ? 1 : 0);
