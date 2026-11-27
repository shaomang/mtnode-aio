'use strict';
/* 主题首绘（renderer/theme-boot.js）—— 在 <body> 的第一个子元素处**同步**执行。
 *
 * 为什么有这个文件：主题类（body.ef-skin / theme-*）、<html data-theme> 与强调色 #themeStyle
 * 以前只在 app-boot.js 里调一次 applyTheme 落定，而那一句要等 config:load（主进程 IPC 读盘 +
 * parse）回来 —— 实测开机头一秒是「没挂 ef-skin」的旧样式（base.css 那套石墨底盘），
 * 然后才跳成新皮肤。本文件把这三样东西提前到正文还没解析完的时候写好，首帧起就只有一套样式。
 *
 * 取值顺序（谁最权威谁在前）：
 *   ① window.__MTNODE_BOOT_THEME__：主进程建主窗时用 additionalArguments 传的
 *      --mtnode-theme=<config.json 里的 theme>，preload.js 转成这个全局 —— 与磁盘配置同源；
 *   ② localStorage 的 mtnode.theme 镜像（下面 apply() 每次都写）：兜前者的窗口级页面；
 *   ③ industrial（默认 MTNode）。
 *
 * 真源唯一：THEMES 表只在这里。app-db.js 的 applyTheme 调 window.MTTheme.apply()，
 * 设置页的主题下拉（app-settings.js）读同一个全局 THEMES —— 要加 / 改主题先改这里。
 *
 * 纪律：本文件不许碰 S / window.api / 任何启动期状态，也不许做异步的事 ——
 * 它是首帧之前跑的，任何依赖都还不存在。 */
const THEMES = {
  dsh: {
    name: "DSH",
    cyan: "#5686fe", cyan2: "#7ca2fe", orange: "#ff8f2e", orange2: "#ffb066",
    green: "#5fd68a", red: "#ff5f56",
  },
  industrial: {
    name: "MTNode",
    cyan: "#38d6ff", cyan2: "#7ce8ff", orange: "#ff8f2e", orange2: "#ffb066",
    green: "#5fd68a", red: "#ff5f56",
  },
  endfield: {
    name: "终末地",
    cyan: "#e2dfd2", cyan2: "#f6f4ea", orange: "#fffa00", orange2: "#f2f27a",
    green: "#b6d94a", red: "#ff4a3d",
  },
  light: {
    /* 亮色：白底上的强调色按「白底 ≥4.5:1」各收深一档，别再往亮里调 */
    name: "亮色",
    cyan: "#0a7489", cyan2: "#08667a", orange: "#a94f08", orange2: "#8a3f03",
    green: "#0e5b33", red: "#96201a",
  },
};
/* localStorage 镜像键：apply() 写、boot() 读（见文件头取值顺序 ②） */
const MT_THEME_LS = "mtnode.theme";

/* 把一个主题名落到 DOM 上（不写盘、不碰配置）：
   <html data-theme>（亮色那套 :root[data-theme="light"] 规则认它）
   + body 的 ef-skin / theme-* 类（四档主题都挂共用皮肤，各主题只换强调色）
   + #themeStyle 里那一段 :root 强调色覆盖（首帧就要用到的几支颜色）。
   主题名不认识一律按 industrial 收口，返回真正落下去的那个名字。 */
function mtThemeApply(name) {
  const theme = THEMES[name] ? name : "industrial";
  const t = THEMES[theme];
  document.documentElement.dataset.theme = theme;
  const b = document.body;
  if (b) {
    /* 皮肤只管形状 / 纹理 / 动效 / 底盘，强调色由 body.theme-* 那几支覆盖决定 */
    b.classList.add("ef-skin");
    b.classList.toggle("theme-industrial", theme === "industrial");
    /* theme-dsh：DSH 档没有基础类，靠这个钩子让 body.ef-skin.theme-dsh 命中 */
    b.classList.toggle("theme-dsh", theme === "dsh");
    b.classList.toggle("theme-light", theme === "light");
    b.classList.toggle("theme-endfield", theme === "endfield");
  }
  let el = document.getElementById("themeStyle");
  if (!el) {
    el = document.createElement("style");
    el.id = "themeStyle";
    (document.head || document.documentElement).appendChild(el);
  }
  el.textContent =
    ":root{--cyan:" + t.cyan + ";--cyan2:" + t.cyan2 +
    ";--orange:" + t.orange + ";--orange2:" + t.orange2 +
    ";--green:" + t.green + ";--red:" + t.red + "}";
  try { localStorage.setItem(MT_THEME_LS, theme); } catch (_) {}
  return theme;
}

/* 首绘这一次：按文件头的三级顺序挑主题名，落 DOM 并把镜像对齐。 */
function mtThemeBoot() {
  let injected = "";
  try { injected = String(window.__MTNODE_BOOT_THEME__ || ""); } catch (_) {}
  let mirrored = "";
  try { mirrored = String(localStorage.getItem(MT_THEME_LS) || ""); } catch (_) {}
  return mtThemeApply(injected || mirrored || "");
}

window.MTTheme = { THEMES, apply: mtThemeApply, boot: mtThemeBoot, LS_KEY: MT_THEME_LS };
mtThemeBoot();
