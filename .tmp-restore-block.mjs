/* 一次性收口脚本：把 app-agent.js 里那段（已含模块②并回的三处修复）原样搬回
 * renderer/app.js 原位，并把 app-agent.js 的行尾统一成 LF（本目录其余文件都是 LF，
 * test/smoke-workspace-project.js [7] 用「两份逐字一致」当闸门，行尾不一致永远红）。
 * 跑完即删。 */
import fs from "node:fs";

const AG = "renderer/app-agent.js";
const AP = "renderer/app.js";

let agent = fs.readFileSync(AG, "utf8").replace(/\r\n/g, "\n");
const al = agent.split("\n");

/* 块 = app-agent.js 从「agent 能力走 DeepSeek 路由」那行注释起，到 dshRunMaxTokens 收尾 */
const startIdx = al.findIndex((l) => l.startsWith("/* agent 能力走 DeepSeek 路由"));
if (startIdx < 0) throw new Error("找不到块首");
const endIdx = al.findIndex((l) => l.startsWith("function dshRunMaxTokens("));
if (endIdx < 0) throw new Error("找不到块尾");
let close = endIdx;
while (al[close] !== "}") close++;
const block = al.slice(startIdx, close + 1).join("\n");
const nFunc = (block.match(/^function /gm) || []).length;
console.log(`块：app-agent.js ${startIdx + 1}..${close + 1} 行，顶层 function ${nFunc} 个`);

/* app-agent.js 的文件头注释：改掉「单一真源在本文件」的口径 */
const oldHead = al
  .slice(1, al.findIndex((l, i) => i > 1 && l === ""))
  .join("\n");
const newHead = `/* ============ dsh agent 能力（契约见 dsh/DESIGN.md）============
   ⚠ 本段（dshProvider … dshRunMaxTokens 共 ${nFunc} 个全局函数）在 renderer/app.js 里
   有一份**逐字同步的第二份**，两份的唯一差别是加载次序：index.html 里 app.js 先加载、
   本文件后加载 → 运行期生效的是本文件这一份。改这里必须同步改 app.js 那一份。
   历史上两边漂移过一次（sensenova_gen 的图像输入、isSuperLikeNode 的 tool 变体、
   save_pdf 默认名三处只写在 app.js 侧 → 三个修复运行期完全没生效），修好后由
   test/smoke-workspace-project.js [7] 与 test/smoke-resume-on-retry.js [6c] 钉住「两份逐字一致」。
   行尾一律 LF（本目录其余渲染层文件都是 LF，行尾不同会让上面那条闸门恒红）。 */`;
agent = agent.replace(oldHead, newHead);
fs.writeFileSync(AG, agent, "utf8");
console.log("app-agent.js：行尾已统一为 LF + 文件头注释订正");

/* app.js：把模块②留下的指向注释换回真正的第二份副本 */
let app = fs.readFileSync(AP, "utf8");
const marker = "/* ============ dsh agent 能力（契约见 dsh/DESIGN.md）============";
const i0 = app.indexOf(marker);
if (i0 < 0) throw new Error("app.js 找不到块首注释");
const i1 = app.indexOf("/* ============ 撤销 / 重做 ============ */", i0);
if (i1 < 0) throw new Error("app.js 找不到下一节");
const head = `/* ============ dsh agent 能力（契约见 dsh/DESIGN.md）============
   ⚠ 本段（dshProvider … dshRunMaxTokens 共 ${nFunc} 个全局函数）在 renderer/app-agent.js
   里有一份**逐字同步的第二份**，且那一份才是运行期生效的：index.html 里 app.js 先加载、
   app-agent.js 后加载，同名 function 声明被后一份静默覆盖。
   为什么留两份：回归脚本按名字从本文件切出源码进 vm 真跑
   （test/smoke-save-name.js · smoke-workspace-project.js · smoke-file-node.js ·
   smoke-resume-on-retry.js [6c]），改这里必须同步改 app-agent.js 那一份 —— 两边内容
   必须逐字一致（含行尾 LF），否则 test/smoke-workspace-project.js [7] 的「两份逐字一致」判红。 */`;
app = app.slice(0, i0) + head + "\n\n" + block + "\n\n" + app.slice(i1);
fs.writeFileSync(AP, app, "utf8");
console.log("app.js：本段已按 app-agent.js 现文（含三处修复）原样补回");
