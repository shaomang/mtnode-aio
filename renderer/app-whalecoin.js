/* 鲸圆币（自包含新模块，挂 window.MtCoin）
 *
 * 一、它是什么
 *   MTNode 自己的计量单位：**只用于账户钱包与 MTNode 中转服务**，
 *   1 鲸圆币 = ¥0.02（即 ¥1 = 50 币）。
 *   官方 DeepSeek 余额、官方路由的 token 费用估算、DeepSeek 单价表一律保持 ¥，
 *   本模块不参与它们的计算（改口径前先读任务书：鲸圆币仅用于 MTNode 中转计费）。
 *
 * 二、口径（三项约定，改动前先看这里）
 *   · 存储不动：云端字段（balanceYuan / amountYuan / deltaYuan / totalYuan）与
 *     本机 config.json / 账号快照仍旧一律「元」。本模块只做显示格式化与用户输入
 *     的换算 —— 界面上给币，提交给云端的仍是元。
 *   · 余额四舍五入取整（<0.5 币显示「<1 币」）；**可用性判定仍按真实元值**
 *     （不因为显示成 0 币就把还有零头的账号判成「余额不足」）。
 *   · 支付/退款按元写（支付宝实际收付的是元）。
 *
 * 三、图标
 *   金币 = 金色圆环（径向渐变 + 内描边 + 高光）+ 内部 DeepSeek logo
 *   （renderer/deepseek-logo.png，取自 lobe-icons 的 deepseek-color.png，
 *   640×640 / 6.5KB）。图挂了也不空着：css 里有 .coin-ico.ico-miss 兜底。
 *   图标尺寸由 CSS 的 font-size 驱动（1em），所以对话框大余额与表格小格子共用一套。
 *
 * 依赖：无（只碰 window / document）。i18n 走可选的 window.I18n。
 */
(function () {
  "use strict";

  /* ── 汇率与素材路径 ─────────────────────────────────────────── */
  var YUAN_PER_COIN = 0.02; /* 1 币 = ¥0.02（¥1 = 50 币） */
  var COIN_PER_YUAN = 1 / YUAN_PER_COIN; /* 50 */
  var LOGO_FILE = "deepseek-logo.png";
  /* logo 与脚本同目录：按**本脚本的 URL** 解析，不按文档（应用里文档就在 renderer/ 下，
     但夹具 / 预览页可能在别处 —— 那种页面里相对路径会指错目录，图标静默显示不出来）。
     解析不出来（老引擎 / 内联脚本）时退回相对路径，至少应用本身仍能用。 */
  var LOGO_SRC = LOGO_FILE;
  try {
    if (typeof document !== "undefined" && document.currentScript && document.currentScript.src)
      LOGO_SRC = new URL(LOGO_FILE, document.currentScript.src).href;
  } catch (e) { /* 保持相对路径 */ }

  function T(s, vars) {
    return window.I18n && window.I18n.t ? window.I18n.t(s, vars) : s;
  }

  /* ── 换算（纯函数，可被 test/ 切片真跑） ─────────────────────── */

  /* 四舍五入到 4 位小数：消除浮点噪声（0.02 × 50 不再变成 1.0000000000000002） */
  function coinRound4(n) {
    return Math.round(Number(n) * 1e4) / 1e4;
  }

  /* 元 → 币（用户输入与余额显示都走它） */
  function coinsOfYuan(yuan) {
    var n = Number(yuan);
    if (!isFinite(n)) return 0;
    return coinRound4(n * COIN_PER_YUAN);
  }

  /* 币 → 元（提交云端前用；保留 2 位小数 = 分位，云侧本来就是分） */
  function yuanOfCoins(coins) {
    var n = Number(coins);
    if (!isFinite(n)) return 0;
    return Math.round(n * YUAN_PER_COIN * 100) / 100;
  }

  /* 余额：四舍五入取整；<0.5 币的零头给专门文案（判定仍按真实值，见文件头第二条） */
  function balancePartsOfYuan(yuan) {
    var n = Number(yuan);
    if (!isFinite(n) || n <= 0) return { whole: true, text: "0", yuan: isFinite(n) ? n : 0 };
    var c = coinsOfYuan(n);
    if (c > 0 && c < 0.5)
      return { whole: true, text: T("<1 币"), yuan: n, dust: true };
    var w = Math.round(c);
    return { whole: true, text: w.toLocaleString("en-US"), yuan: n, coins: w };
  }

  function balanceTextOfYuan(yuan) {
    return balancePartsOfYuan(yuan).text;
  }

  /* 币数整数串（档位、充值金额用）：千分位，不带单位 */
  function coinNumText(coins) {
    var n = Number(coins);
    if (!isFinite(n)) return "0";
    return Math.round(n).toLocaleString("en-US");
  }

  /* 费用等小额：最多 2 位小数，无小数就不带小数点（0.05 / 1 → "0.05" / "1"） */
  function coinCostText(coins) {
    var n = Number(coins);
    if (!isFinite(n)) return "0";
    var v = Math.round(n * 100) / 100;
    return v.toFixed(2).replace(/\.?0+$/, "");
  }

  /* 简短币名（tooltip 用） */
  function shortName() {
    return T("币");
  }

  function tooltipText() {
    return T("鲸圆币 · 1 币 = ¥0.02（¥1 = 50 币）");
  }

  /* ── DOM：金币图标 / 数量 / 金额元件 ───────────────────────── */

  /* 金币图标（纯 span + img，尺寸交给 CSS）。size:"sm" 给表格与按钮里的紧凑位。
     图挂了（打包漏文件 / 路径变动）标 ico-miss 由 CSS 兜底，不留空格。 */
  function coinIcon(size) {
    var span = document.createElement("span");
    span.className = "coin-ico" + (size === "sm" ? " sm" : "");
    span.setAttribute("aria-hidden", "true");
    var img = document.createElement("img");
    img.alt = "";
    img.decoding = "async";
    img.src = LOGO_SRC;
    img.addEventListener("error", function () {
      span.classList.add("ico-miss");
    });
    span.appendChild(img);
    return span;
  }

  /* 「金币 + 数量」内联元件：数字在前、币图标在后（紧凑），币名靠悬停 tooltip。
     opts: { size:"sm"|"", text:覆盖数字文案, title:覆盖 tooltip, unit:是否带「币」字 } */
  function coinEl(value, opts) {
    var o = opts || {};
    var span = document.createElement("span");
    span.className = "coin-amt" + (o.size === "sm" ? " sm" : "");
    span.title = o.title || tooltipText();
    var txt = o.text != null ? String(o.text) : coinNumText(value);
    span.appendChild(document.createTextNode(txt));
    if (o.unit) span.appendChild(document.createTextNode(" " + shortName()));
    span.appendChild(coinIcon(o.size));
    return span;
  }

  /* 余额元件：金额大字号 + 币图标；零头走「<1 币」文案 */
  function balanceEl(yuan) {
    var p = balancePartsOfYuan(yuan);
    var span = document.createElement("span");
    span.className = "coin-bal";
    span.title = tooltipText();
    span.appendChild(document.createTextNode(p.text));
    span.appendChild(coinIcon(""));
    return span;
  }

  /* 「+500 币」这类纯文本串（提示、失败原因里用；符号在货币名外面才读得顺） */
  function coinText(value, opts) {
    var o = opts || {};
    return coinNumText(value) + " " + shortName();
  }

  window.MtCoin = {
    YUAN_PER_COIN: YUAN_PER_COIN,
    COIN_PER_YUAN: COIN_PER_YUAN,
    LOGO_SRC: LOGO_SRC,
    coinsOfYuan: coinsOfYuan,
    yuanOfCoins: yuanOfCoins,
    coinRound4: coinRound4,
    balancePartsOfYuan: balancePartsOfYuan,
    balanceTextOfYuan: balanceTextOfYuan,
    coinNumText: coinNumText,
    coinCostText: coinCostText,
    coinText: coinText,
    coinIcon: coinIcon,
    coinEl: coinEl,
    balanceEl: balanceEl,
    shortName: shortName,
    tooltip: tooltipText,
  };
})();
