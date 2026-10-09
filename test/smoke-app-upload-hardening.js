"use strict";
/* 应用上传加固 —— 三条线上需求的回归卡口（纯源码断言，零依赖，不起服务）
 *   node test/smoke-app-upload-hardening.js
 *
 * 钉住三件事（都是 2026-10-09 用户报障后定下的口径）：
 *   [1] 删掉最后一个版本 = **云端彻底删除**：记录 / 包 / 图标 / 截图 / 封面缩略图 / 静态目录
 *       （含空目录）/ 无主图片对象一次清完，且三处删除入口共用同一份实现（不再各写一份漂移）。
 *   [2] 截图**本机按内容保存**（压缩后那一份 / sha 寻址 / 跨应用共用），下次更新自动带上且只发引用。
 *   [3] 「上传中卡住」的三条真因都有卡口：
 *       · 线上 nginx 的 client_max_body_size / proxy_read_timeout / proxy_send_timeout
 *         必须与服务端常量同口径（补丁脚本会**就地改**已存在的 location，不是只在缺失时插入）；
 *       · 服务端读体超限必须回 413 JSON，绝不静默断连；
 *       · 客户端上传前预检体积、失败保留已打包 zip 与已压缩截图、重试不重来。
 *
 * 为什么用源码断言而不是跑一遍：这三条里的两条（nginx 限位、客户端交互）需要真实服务器配置与
 * Electron 窗口；能真跑的服务端行为在 test/smoke-app-publish.js（链路级）与
 * store-saas/smoke-app-edit-shots.mjs（截图编辑）里已经真跑过了，这里只补「配置漂移」这类
 * 单测抓不到的卡口 —— 本次事故的根因正是配置漂移。
 */
const fs = require("fs");
const path = require("path");

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
function section(t) {
  console.log("\n" + t);
}
const ROOT = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel.split("/").join(path.sep)), "utf8");
const exists = (rel) => fs.existsSync(path.join(ROOT, rel.split("/").join(path.sep)));

const SRV = read("store-saas/server.mjs");
const NGX = read("store-saas/patch-nginx.py");
const PUB = read("renderer/app-publish.js");
const APPS = read("renderer/app-apps.js");
const MAIN = read("main.js");
const CACHE = read("shots-cache.js");
const PRELOAD = read("preload.js");

/* ───────── [1] 删掉最后一版 = 云端彻底删除 ───────── */
section("[1] 需求一：删最后一个版本 = 云端不留痕迹（彻底删除）");

ok(/async function deleteAppBranch\(a, meta\)/.test(SRV), "服务端有唯一的删除实现 deleteAppBranch");
{
  const at = SRV.indexOf("async function deleteAppBranch(a, meta)");
  const body = at >= 0 ? SRV.slice(at, at + 4200) : "";
  ok(/db\.apps\.splice\(idx, 1\)/.test(body), "deleteAppBranch：记录从 db.apps 里真删掉（不是置一个可见性位）");
  ok(!/a\.unpublished = true/.test(body), "deleteAppBranch：**不再**把分支置成「软删除 / 下架」态");
  ok(/appOwnerZipPath\(id, ownerId\)/.test(body), "deleteAppBranch：分支镜像 <id>__<uid>.zip 一起删");
  ok(/appVersionZipPath\(id, v\)/.test(body), "deleteAppBranch：老落点的版本包按「没有别的分支在用」才删（别人的包一个都不动）");
  ok(/clearAppIcon\(id, ownerId\)/.test(body), "deleteAppBranch：图标一起删");
  ok(/clearAppThumb\(id, ownerId\)/.test(body), "deleteAppBranch：封面缩略图一起删");
  ok(/clearAppShots\(id, ownerId\)/.test(body), "deleteAppBranch：截性别名目录一起删");
  ok(/cleanAppBranchStatic\(id, ownerId\)/.test(body), "deleteAppBranch：静态目录（含空目录）一起清");
  ok(/imgObjectsGc\(\)/.test(body), "deleteAppBranch：收尾回收「没有任何应用记录认领」的图片对象");
  ok(/await applyUserPatch\(ownerId/.test(body), "deleteAppBranch：下载量计数回退只算这一条自己的贡献");
}
{
  const at = SRV.indexOf("function cleanAppBranchStatic(");
  const body = at >= 0 ? SRV.slice(at, at + 3200) : "";
  ok(/stillUsed/.test(body) && /db\.apps \|\| \[\]\)\.some/.test(body), "静态清理按「db 里还有没有这个 id 的记录」判老共用名能不能删（fail-closed）");
  ok(/fs\.rmSync\(idDir, \{ recursive: true, force: true \}\)/.test(body), "静态清理：<id>/ 子目录整棵删（含空目录）");
  ok(/fs\.rmSync\(sd, \{ recursive: true, force: true \}\)/.test(body), "静态清理：shots/<主干>/ 整棵删");
  ok(/APPS_WEB_ICONS_DIR, "shots"/.test(body), "静态清理覆盖 icons/ 与 shots/ 两处散件");
}
{
  const at = SRV.indexOf('if (appVersionOneR && method === "DELETE")');
  const body = at >= 0 ? SRV.slice(at, at + 7000) : "";
  const branchAt = body.indexOf("if (!recs.length) {");
  const branch = branchAt >= 0 ? body.slice(branchAt, branchAt + 2600) : "";
  /* 顺序即语义（现实现逐字核过）：元信息快照在 `recs.splice` **之前**取，否则留痕里的版本列表恒为空；
     删到零版本那条路把快照交给 deleteAppBranch（a, delMeta），彻底删除后由它写已删除留痕。 */
  ok(/const delMeta = appBranchDeleteMeta\(a\);/.test(body) && /recs\.splice\(vi, 1\)/.test(body) &&
     body.indexOf("appBranchDeleteMeta(a)") < body.indexOf("recs.splice(vi, 1)") &&
     /if \(!recs\.length\) \{/.test(branch) && /const del = await deleteAppBranch\(a, delMeta\);/.test(branch) &&
     /appDeletedLedgerPush\(/.test(SRV),
    "删光版本那条分支走 deleteAppBranch（与「删除应用」同一份实现）；删前的版本快照在清空版本之前取（否则留痕里的版本列表恒为空）");
  ok(/const del = await deleteAppBranch\(a, delMeta\);/.test(branch), "删光版本：deleteAppBranch(a, delMeta) 真跑，回执带 deleted:true");
  ok(/deleted: true/.test(branch), "删光版本的 200 回执带 deleted:true（客户端据此说「云端已彻底删除」）");
  ok(!/a\.unpublished = true/.test(branch), "删光版本那条分支不再置可见性位（旧口径已下线，直接彻底删除）");
}
ok(
  (SRV.match(/await deleteAppBranch\(/g) || []).length >= 4,
  "四处删除入口（作者删最后一版 / 作者删分支 / 管理台删分支 / 管理台删最后一版）都收口到 deleteAppBranch，实得 " +
    (SRV.match(/await deleteAppBranch\(/g) || []).length + " 处",
);
ok(/deleted: true, branches: appBranchViewOf/.test(SRV), "作者侧删除分支的回执也带 deleted:true");
ok(/deleted: true, counts: adminContentCounts\(\)/.test(SRV), "管理台删除分支的回执也带 deleted:true");

/* 客户端：两处入口的文案与收尾 */
ok(/彻底不存在了/.test(PUB), "上架窗：删最后一版的确认文案改成「云端彻底不存在了（不可恢复）」");
ok(/pubClearLocalTrace/.test(PUB), "客户端有 pubClearLocalTrace（清 app.json 的 cloud 留痕 + 回收本地截图缓存）");
ok(/await pubClearLocalTrace\(\)/.test(PUB), "删掉最后一版成功后就地清本机留痕（下次开窗不再以为「还能更新」）");
ok(/appsT\("这个应用在云端只有你这一条分支：删除后它就是彻底消失了。"\)/.test(APPS),
  "应用中心：删除对话框仍如实说明「彻底消失」");
/* 本轮口径变更：上下架整体移除（客户端按钮 + 服务端两条路由 + 这段指引一起删），
   删除框文案整段重写成一句「云端彻底删除，不可恢复。」 */
ok(!/请用下架/.test(APPS) && !/请用下架/.test(PUB),
  "「想留退路就用下架」的指引已随上下架一起删除（不再指引一个不存在的按钮）");
ok(/appsT\("云端彻底删除，不可恢复。"\)/.test(APPS), "删除框改说「云端彻底删除，不可恢复。」");

/* ───────── [2] 截图本地保存 + 云端只引用 ───────── */
section("[2] 需求二：截图本地保存（内容寻址）→ 下次更新自动带上、云端只引用不复制");

ok(/store:shotsPut|store:shotsList|store:shotsClear/.test(MAIN), "main.js 把截图缓存的三个动作挂到 IPC（put / list / clear）");
ok(/createShotsCache\(\{ dataDir: DATA\(\) \}\)/.test(MAIN), "main.js 用根目录 shots-cache.js 建实例（dataDir = 数据目录）");
ok(/shots-cache/.test(CACHE), "本地截图落 <数据目录>/shots-cache/（不落应用文件夹）");
ok(
  /function fileNameOf\(sha, ext\)/.test(CACHE) && /String\(sha\) \+ "\." \+ safe/.test(CACHE),
  "本地缓存**按内容寻址**：文件名就是 sha256（同图跨应用只存一份）",
);
ok(/MAX_BYTES/.test(CACHE) && /lastUsedAt/.test(CACHE), "本地缓存有总上限 + 最久未用先淘汰");
ok(/same = fs\.statSync\(abs\)\.size === dec\.buf\.length/.test(CACHE), "同名文件已在盘上就不重写（重复上传一个字节都不动）");
ok(CACHE.indexOf("kill = apps.filter((x) => x !== id).length === 0") > 0,
  "回收时只删「只属于这个应用」的图，被别的应用共用的留着（与云端对象库同口径）");
ok(/fs\.unlinkSync\(path\.join\(dirOf\(\), String\(it\.file \|\| ""\)\)\)/.test(CACHE), "回收真删文件（不只是从索引里抹掉）");
ok(/storeShotsPut: \(opts\)/.test(PRELOAD) && /storeShotsList: \(opts\)/.test(PRELOAD) && /storeShotsClear: \(opts\)/.test(PRELOAD),
  "preload.js 暴露三个桥（shotsPut / shotsList / shotsClear）");
ok(/async function pubShotsLocalLoad\(\)/.test(PUB), "渲染层有 pubShotsLocalLoad（开窗读本机那份字节）");
ok(/async function pubShotsLocalSave\(appId, list\)/.test(PUB), "渲染层有 pubShotsLocalSave（上传成功后存这一批）");
ok(/async function pubShotsLocalDropApp\(appId\)/.test(PUB), "渲染层有 pubShotsLocalDropApp（彻底删除时回收）");
ok(/const local = await pubShotsLocalLoad\(\);/.test(PUB), "开窗预填时把本机字节一起带出来");
ok(/function pubCloudShotsOf\(item, stay, local\)/.test(PUB), "pubCloudShotsOf 接本机缓存（第三参）");
ok(/if \(hit\) \{/.test(PUB) && /from: "local"/.test(PUB), "命中本机缓存的张标记 from:'local' 并带上 dataUrl");
ok(/const saved = await pubShotsLocalSave\(/.test(PUB), "上传成功后把这一批（压缩后的字节）存进本机缓存");
ok(
  /PUB\.shots\[i\] && PUB\.shots\[i\]\.from === "cloud" && !pubStr\(PUB\.shots\[i\]\.dataUrl\)/.test(PUB),
  "只有「云端带出来且本机没字节」的才直接发引用；本机有字节的照常算 sha（算出来一致 → 也只发引用）",
);
/* 服务端「同一张图只落一份、后续只发引用」的实现仍在（本轮未改，属回归） */
ok(/function imgObjPut\(buf, ext, suffix\)/.test(SRV) && /if \(!hold\) \{/.test(SRV), "服务端对象库：同内容重复写入直接命中、不重写盘");
ok(/function shotFromSha\(sha\)/.test(SRV) && /reused: true/.test(SRV), "服务端认得 { sha } 引用并复用对象库那一份（reused）");
ok(/function appendAppShots\(id, ownerId, shots, a\)/.test(SRV), "追加一版时截图按内容去重（同一张图不会变成两张）");

/* ───────── [3] 上传卡住：配置漂移 + 静默断连 + 客户端可观测 ───────── */
section("[3] 需求三：修「上传中卡住」（配置漂移 / 静默断连 / 客户端可观测）");

/* 3.1 防再犯卡口：nginx 补丁脚本与服务端常量同口径 */
{
  /* 本轮的补丁脚本改成了「**逐行只改指令**」的口径（上一版整块替换会把 location 复制成三份），
     所以这里钉的是 TARGETS 表里的目标值 —— 它们必须与 store-saas/server.mjs 的常量一一对应，
     任何一边改了另一边没跟上就是本次事故（40m vs 96MB）的翻版。 */
  const t = NGX.indexOf("TARGETS = [");
  const table = t >= 0 ? NGX.slice(t, NGX.indexOf("]", t)) : "";
  ok(/\("client_max_body_size", "96m"\)/.test(table), "补丁脚本 TARGETS：client_max_body_size → 96m（= MAX_BODY_APP_UPLOAD）");
  ok(/\("proxy_read_timeout", "600s"\)/.test(table), "补丁脚本 TARGETS：proxy_read_timeout → 600s（= 客户端上架超时）");
  ok(/\("proxy_send_timeout", "600s"\)/.test(table), "补丁脚本 TARGETS：proxy_send_timeout → 600s");
  ok(/\("client_body_timeout", "300s"\)/.test(table), "补丁脚本 TARGETS：client_body_timeout → 300s（慢网上行不再被默认 60s 掐）");
  ok(/\("proxy_request_buffering", "off"\)/.test(table), "补丁脚本 TARGETS：proxy_request_buffering → off（边收边转，不落磁盘中转）");
  ok(!/40m|120s/.test(table), "TARGETS 表里没有老的 40m / 120s（旧口径已清掉）");
  ok(/SCOPE_HEAD = "location \^~ \/mtnode\/store-api\/ \{"/.test(NGX), "补丁脚本只作用于 store-api 这一段（SCOPE_HEAD 精确到整行）");
  ok(/def find_scope\(lines, head\)/.test(NGX) && /缩进/.test(NGX), "块范围按**缩进**判定（不靠全局花括号计数 —— 一行写完的 location 会让计数错位）");
  ok(/if line\.strip\(\) != want:/.test(NGX), "候选必须**整行**等于 header（`location = /mtnode/admin {` 这种前缀陷阱靠它挡住）");
  ok(/out\.insert\(at, inner_indent \+ key/.test(NGX), "缺失的指令插在块内最后一条指令之后（配置读起来不乱）");
  ok(!/text \+ insert|insert \+ needle/.test(NGX), "补丁脚本不再整块插入 / 重写（上一版就是这么把 location 复制成三份的）");
}
ok(/def nginxLimitAudit|function nginxLimitAudit\(\)/.test(SRV), "服务端启动时对账 nginx 限位（nginxLimitAudit）");
ok(/nginxLimitAudit\(\);/.test(SRV), "nginxLimitAudit 在 listen 回调里被调用");
ok(/nginx 限位与服务端不一致/.test(SRV), "不一致时大声告警（含可照抄的修法命令）");
ok(/uploadLimitBytes: MAX_BODY_APP_UPLOAD/.test(SRV) && /appZipLimitBytes: MAX_APP_ZIP/.test(SRV),
  "服务端把两个真上限下发给客户端（storage.uploadLimitBytes / appZipLimitBytes）");
ok(/function nginxLimitAudit\(\)/.test(SRV), "服务端启动时对账 nginx 限位（nginxLimitAudit）");
ok(/nginxLimitAudit\(\);/.test(SRV), "nginxLimitAudit 在 listen 回调里被调用");
ok(/nginx 限位与服务端不一致/.test(SRV), "不一致时大声告警（含可照抄的修法命令）");
ok(/uploadLimitBytes: MAX_BODY_APP_UPLOAD/.test(SRV) && /appZipLimitBytes: MAX_APP_ZIP/.test(SRV),
  "服务端把两个真上限下发给客户端（storage.uploadLimitBytes / appZipLimitBytes）");

/* 3.2 服务端不再静默断连 */
{
  const at = SRV.indexOf("function readBody(req, maxBytes)");
  const body = at >= 0 ? SRV.slice(at, at + 1800) : "";
  ok(!/req\.destroy\(\)/.test(body), "readBody 不再 req.destroy()（原来那样客户端拿不到任何状态码）");
  ok(/err\.status = 413/.test(body), "超限回 413（带 status，顶层 catch 据此回 JSON）");
  ok(/err\.code = "BODY_TOO_LARGE"/.test(body), "超限带 code=BODY_TOO_LARGE（客户端据此给可执行提示）");
  ok(/req\.resume\(\)/.test(body), "丢弃但不掐连接：等客户端传完再把 413 发出去");
  ok(/请求体超过上限/.test(body) && /已收到/.test(body), "错误文本写清「上限多少 / 收到多少」");
}

/* 3.3 客户端：预检 / 重试保留 / 可观测 */
ok(/const PUB_UPLOAD_LIMIT_FALLBACK = 96 \* 1024 \* 1024;/.test(PUB), "客户端有上架体量兜底常量（真源仍是服务端回执）");
ok(/function pubPreflightSize\(shotBytes, iconBytes\)/.test(PUB), "上传前预检 pubPreflightSize");
ok(/const pre = pubPreflightSize\(shotEstimate, Number\(plan\.bytes\) \|\| 0\);/.test(PUB), "打包之前就跑预检（不等压缩 / 算指纹全做完）");
ok(/超过上架链路的上限/.test(PUB), "预检命中时给出可执行文案（删截图 / 压素材 + 上限）");
ok(/PUB\.packRetry/.test(PUB) && /PUB\.shotPrepRetry/.test(PUB), "失败后保留「已打包 zip」与「已压缩截图」缓存");
ok(/if \(PUB\.packRetry && PUB\.packRetry\.sig === zipSig && PUB\.packRetry\.pack && PUB\.packRetry\.read\)/.test(PUB),
  "重试直接复用上一轮打好的包（不重打包、不重读）");
ok(/const cachedPrep = PUB\.shotPrepRetry && PUB\.shotPrepRetry\.round === PUB\.roundId/.test(PUB),
  "重试直接复用每张截图的压缩结果与指纹");
ok(/function pubDropRetryCaches\(\)/.test(PUB) && /pubDropRetryCaches\(\);\n/.test(PUB.replace(/\r\n/g, "\n")),
  "表单 / 截图一变就丢缓存（绝不拿旧内容重试）");
ok(/pubT\("重试上传"\)/.test(PUB), "页脚主按钮在失败后变成「重试上传」");
ok(/已保留这一轮打好的包与压缩结果/.test(PUB), "失败文案明说缓存已保留（作者知道重试不用重来）");
ok(/out\.uploadLimitBytes = Number\(st\.uploadLimitBytes\) \|\| 0;/.test(PUB), "配额读取接住服务端下发的 uploadLimitBytes");
ok(/q\.appZipLimitBytes = Number\(st\.appZipLimitBytes\)/.test(PUB), "上传回执里的上限也接住");
ok(/const timeoutMs = Math\.min\(600000, Math\.max\(10000, Number\(o\.timeoutMs\) \|\| 120000\)\);/.test(MAIN),
  "主进程仍按调用方的 timeoutMs（上架 600s）算空闲超时");
ok(/code: "TIMEOUT"/.test(MAIN) && /没有任何响应（连接可能被中断）/.test(MAIN), "空闲超时自断并回一条说清缘由的错误");
ok(/armIdle\(\)/.test(MAIN) && /reader\.read\(\)/.test(MAIN), "读回执期间每来一块数据就重置空闲计时（有数据在传就不算超时）");
ok(MAIN.indexOf("signal: ctl.signal") > 0 && /readBody|idleTimer/.test(MAIN), "老的「整请求硬上限」已换成空闲口径（fetch 用 ctl.signal）");

ok(exists("store-saas/patch-nginx.py") && exists("store-saas/server.mjs"), "被测文件都在（store-saas 源码随包）");
ok(exists("shots-cache.js"), "截图缓存模块在仓库根目录（AGENTS.md 的目录约定）");
ok(
  read("build.json").indexOf('"shots-cache.js"') > 0,
  "shots-cache.js 进了 build.json 的 files 白名单（main.js require 它，漏了就 Cannot find module）",
);

console.log("\n" + (fails ? "FAIL " + fails + " / " + checks + " 项断言" : "✓ 全部通过（通过 " + checks + " / 失败 0）"));
process.exit(fails ? 1 : 0);
