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
 * 三、图标（本轮需求：界面上把「币」字换成鲸圆币 icon）
 *   · 图形 = 金色圆环（径向渐变 + 内描边 + 高光）+ 里面的 **DeepSeek 官方 logo**
 *     （官方 24×24 图形、官方品牌蓝 #4D6BFE，内联 SVG path，无外部图片依赖）：
 *     圆环与原来那枚金环一脉相承，所以「20 ⟶图标」读起来还是币数；
 *     **圆内不是自绘的鱼 / 鲸剪影** —— 用户口径：里面必须是 DeepSeek 官方 logo。
 *   · **全应用统一**：余额 / 档位 / 计费 / 打赏 / 钱包里原先把「币」写成文字的 20 来处，
 *     一律换成「数字 + 这枚图标」（tip 提示里仍写「鲸圆币」四个字，不丢语义）。
 *
 * 四、依赖：无（只碰 window / document）。i18n 走可选的 window.I18n。
 */
(function () {
  "use strict";

  /* ── 汇率 ───────────────────────────────────────────────────── */
  var YUAN_PER_COIN = 0.02; /* 1 币 = ¥0.02（¥1 = 50 币） */
  var COIN_PER_YUAN = 1 / YUAN_PER_COIN; /* 50 */

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
    if (c > 0 && c < 0.5) return { whole: true, text: "<1", yuan: n, dust: true };
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

  /* 简短币名（**只给英文界面**用；中文界面单位一律是图标，不写「币」字） */
  function shortName() {
    return T("币");
  }

  /* 通用悬停提示：**只给币名，不带汇率** —— 需求口径「账户里不提示 1￥=50 币，
     只在充值界面提示」；全应用唯一那行汇率写在充值窗（renderer/app-wallet.js 的 #wlRate）。 */
  function tooltipText() {
    return T("鲸圆币");
  }

  /* ── 图标（自绘 SVG：金色圆环 + DeepSeek 官方 logo）────────────── */

  var SVG_NS = "http://www.w3.org/2000/svg";
  /* DeepSeek 官方 logo 路径（官方 24×24 品牌图形，唯一真源；换版只改这一行）。
     官方来源 @lobehub/icons-static-svg 的 deepseek-color.svg
     （unpkg.com/@lobehub/icons-static-svg@latest/icons/deepseek-color.svg），
     官方品牌色 #4D6BFE 由下面的 fill 给出。**不要改成自绘的鲸鱼 / 鱼剪影** ——
     用户口径：鲸圆币里必须是 DeepSeek 官方 logo。 */
  var DS_LOGO_D =
    "M23.748 4.482c-.254-.124-.364.113-.512.234-.051.039-.094.09-.137.136-.372.397-.806.657-1.373.626-.829-.046-1.537.214-2.163.848-.133-.782-.575-1.248-1.247-1.548-.352-.156-.708-.311-.955-.65-.172-.241-.219-.51-.305-.774-.055-.16-.11-.323-.293-.35-.2-.031-.278.136-.356.276-.313.572-.434 1.202-.422 1.84.027 1.436.633 2.58 1.838 3.393.137.093.172.187.129.323-.082.28-.18.552-.266.833-.055.179-.137.217-.329.14a5.526 5.526 0 01-1.736-1.18c-.857-.828-1.631-1.742-2.597-2.458a11.365 11.365 0 00-.689-.471c-.985-.957.13-1.743.388-1.836.27-.098.093-.432-.779-.428-.872.004-1.67.295-2.687.684a3.055 3.055 0 01-.465.137 9.597 9.597 0 00-2.883-.102c-1.885.21-3.39 1.102-4.497 2.623C.082 8.606-.231 10.684.152 12.85c.403 2.284 1.569 4.175 3.36 5.653 1.858 1.533 3.997 2.284 6.438 2.14 1.482-.085 3.133-.284 4.994-1.86.47.234.962.327 1.78.397.63.059 1.236-.03 1.705-.128.735-.156.684-.837.419-.961-2.155-1.004-1.682-.595-2.113-.926 1.096-1.296 2.746-2.642 3.392-7.003.05-.347.007-.565 0-.845-.004-.17.035-.237.23-.256a4.173 4.173 0 001.545-.475c1.396-.763 1.96-2.015 2.093-3.517.02-.23-.004-.467-.247-.588zM11.581 18c-2.089-1.642-3.102-2.183-3.52-2.16-.392.024-.321.471-.235.763.09.288.207.486.371.739.114.167.192.416-.113.603-.673.416-1.842-.14-1.897-.167-1.361-.802-2.5-1.86-3.301-3.307-.774-1.393-1.224-2.887-1.298-4.482-.02-.386.093-.522.477-.592a4.696 4.696 0 011.529-.039c2.132.312 3.946 1.265 5.468 2.774.868.86 1.525 1.887 2.202 2.891.72 1.066 1.494 2.082 2.48 2.914.348.292.625.514.891.677-.802.09-2.14.11-3.054-.614zm1-6.44a.306.306 0 01.415-.287.302.302 0 01.2.288.306.306 0 01-.31.307.303.303 0 01-.304-.308zm3.11 1.596c-.2.081-.399.151-.59.16a1.245 1.245 0 01-.798-.254c-.274-.23-.47-.358-.552-.758a1.73 1.73 0 01.016-.588c.07-.327-.008-.537-.239-.727-.187-.156-.426-.199-.688-.199a.559.559 0 01-.254-.078c-.11-.054-.2-.19-.114-.358.028-.054.16-.186.192-.21.356-.202.767-.136 1.146.016.352.144.618.408 1.001.782.391.451.462.576.685.914.176.265.336.537.445.848.067.195-.019.354-.25.452z";
  /* 官方品牌蓝（深蓝，白底亮色主题下也压得住） */
  var DS_LOGO_COLOR = "#4D6BFE";
  /* logo 在 24×24 里的落位：官方图形四周留白多，缩到 68% 居中后视觉大小与金环相称 */
  var DS_LOGO_SCALE = 0.68;

  var uidSeq = 0;
  /* 渐变 id 必须全页唯一：同一页里几十枚图标共用同一个 id 在部分渲染路径下会串色 */
  function uid() {
    uidSeq++;
    return "mcoin-g" + uidSeq;
  }

  /* 金币图标（SVG，尺寸由 CSS 的 font-size 驱动 1em）。size:"sm" 给表格与按钮里的紧凑位。
     - 外圈：金色径向渐变 + 深色描边（与原先那枚金环同一观感）；
     - 内里：DeepSeek 官方 logo（内联 SVG path + 官方品牌蓝，没有外部图片依赖，
       缺图 / 打包漏文件这种坑不再存在）。 */
  function coinIcon(size) {
    var span = document.createElement("span");
    span.className = "coin-ico" + (size === "sm" ? " sm" : "");
    span.setAttribute("aria-hidden", "true");
    span.title = tooltipText();
    var gid = uid();
    var svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("focusable", "false");
    var defs = document.createElementNS(SVG_NS, "defs");
    var grad = document.createElementNS(SVG_NS, "radialGradient");
    grad.setAttribute("id", gid);
    grad.setAttribute("cx", "38%");
    grad.setAttribute("cy", "30%");
    grad.setAttribute("r", "78%");
    [
      ["0%", "#ffe9a8"],
      ["45%", "#f5c542"],
      ["100%", "#c8912a"],
    ].forEach(function (stop) {
      var s = document.createElementNS(SVG_NS, "stop");
      s.setAttribute("offset", stop[0]);
      s.setAttribute("stop-color", stop[1]);
      grad.appendChild(s);
    });
    defs.appendChild(grad);
    svg.appendChild(defs);
    var ring = document.createElementNS(SVG_NS, "circle");
    ring.setAttribute("cx", "12");
    ring.setAttribute("cy", "12");
    ring.setAttribute("r", "10.6");
    ring.setAttribute("fill", "url(#" + gid + ")");
    ring.setAttribute("stroke", "#8a5f16");
    ring.setAttribute("stroke-width", "1.3");
    svg.appendChild(ring);
    var glint = document.createElementNS(SVG_NS, "path");
    glint.setAttribute("d", "M5.2 7.4A8.6 8.6 0 0 1 14.6 4.1");
    glint.setAttribute("fill", "none");
    glint.setAttribute("stroke", "#fff7dc");
    glint.setAttribute("stroke-width", "1.4");
    glint.setAttribute("stroke-linecap", "round");
    glint.setAttribute("opacity", "0.75");
    svg.appendChild(glint);
    /* DeepSeek 官方 logo：缩到圆内居中（官方图形 → 官方品牌蓝） */
    var logoSize = 24 * DS_LOGO_SCALE;
    var logoOffset = (24 - logoSize) / 2;
    var logo = document.createElementNS(SVG_NS, "path");
    logo.setAttribute("d", DS_LOGO_D);
    logo.setAttribute("fill", DS_LOGO_COLOR);
    logo.setAttribute(
      "transform",
      "translate(" + logoOffset.toFixed(2) + " " + logoOffset.toFixed(2) + ") scale(" + DS_LOGO_SCALE + ")",
    );
    svg.appendChild(logo);
    span.appendChild(svg);
    return span;
  }

  /* ── DOM：币数元件（数字 + 鲸圆币图标；**中文界面不再写「币」字**）────
   * 用户口径：全应用统一把「币」字换成鲸圆币 icon —— 数字后直接跟图标；
   * 单位语义收进图标的 tooltip（「鲸圆币」四个字仍然在）。英文界面保留 "W coins" 文本单位，
   * 否则纯图标在英文排版里读不出单位。 */

  /** 中文界面不带文字单位（单位就是图标）；英文界面保留短名（W coins）。 */
  function unitText() {
    return window.I18n && window.I18n.getLocale && window.I18n.getLocale() === "en" ? " " + shortName() : "";
  }

  /** 往容器里补「数字 + 单位 + 图标」这一组（各处元件共用，口径只写一次）。 */
  function appendCoinParts(host, text, size) {
    host.appendChild(document.createTextNode(String(text)));
    var unit = unitText();
    if (unit) host.appendChild(document.createTextNode(unit));
    host.appendChild(coinIcon(size));
  }

  /* 「金币 + 数量」内联元件：数字在前、币图标在后（紧凑），币名靠悬停 tooltip。
     opts: { size:"sm"|"", text:覆盖数字文案, title:覆盖 tooltip, unit:是否带单位文字（英文才生效） } */
  function coinEl(value, opts) {
    var o = opts || {};
    var span = document.createElement("span");
    span.className = "coin-amt" + (o.size === "sm" ? " sm" : "");
    span.title = o.title || tooltipText();
    var txt = o.text != null ? String(o.text) : coinNumText(value);
    span.appendChild(document.createTextNode(txt));
    var unit = o.unit === false ? "" : unitText();
    if (unit) span.appendChild(document.createTextNode(unit));
    span.appendChild(coinIcon(o.size));
    return span;
  }

  /* 余额元件：金额大字号 + 币图标（零头走「<1」文案） */
  function balanceEl(yuan) {
    var p = balancePartsOfYuan(yuan);
    var span = document.createElement("span");
    span.className = "coin-bal";
    span.title = tooltipText();
    span.appendChild(document.createTextNode(p.text));
    span.appendChild(coinIcon(""));
    return span;
  }

  /* 「+500 币」这类纯文本串（提示、失败原因里用；符号在货币名外面才读得顺）：
     **中文界面不带「币」字**（要图标的地方请用 coinEl / appendCoinParts）。 */
  function coinText(value, opts) {
    var o = opts || {};
    return coinNumText(value) + (o.unit === false ? "" : unitText());
  }

  window.MtCoin = {
    YUAN_PER_COIN: YUAN_PER_COIN,
    COIN_PER_YUAN: COIN_PER_YUAN,
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
    appendCoinParts: appendCoinParts,
    unitText: unitText,
    balanceEl: balanceEl,
    shortName: shortName,
    tooltip: tooltipText,
  };
})();
