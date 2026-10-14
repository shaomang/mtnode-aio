/* paseo/qr.js — 自研零依赖 QR Code 编码器（ISO/IEC 18004）
 *
 * 职责：把一段文本编成二维码矩阵 / SVG / PNG data URL，给「Paseo 配对」控制台窗
 * 渲染那条约 243 字符的 https 配对链接用（手机扫码 → 配对）。
 *
 * 为什么自己写、不装 `qrcode` 之类的包：
 *   · 本项目**不引入第三方代码**（许可面与「零依赖」是本项目反复重申的约束）；
 *   · 二维码是**标准算术**（GF(256) 上的 Reed–Solomon + 位填充），不是需要库才能做的事，
 *     自己实现反而能把「为什么」写清楚、把变量钉在 ISO 条款上。
 *   · 所以本文件每一行都是照 ISO/IEC 18004 的标准规则写的，**没有一行抄自任何第三方库**。
 *
 * 为什么一个文件要同时给浏览器和 Node 用（IIFE + 双挂载）：
 *   · 渲染层（Electron renderer）是 <script> 直挂，没有打包器，用 import/export 会当场语法报错；
 *   · 主进程（CJS）又要 require 同一份口径（例如落一张 PNG 进数据目录）。
 *   两边各抄一份必然漂移 —— 那就一份代码，末尾按 `module` 存不存在决定挂 window 还是 module.exports。
 *
 * 为什么默认纠错等级是 M：Paseo 官方 CLI 打印配对码时用的就是 M，比对与扫码体验要一致。
 *
 * 为什么 mask 必须按罚分选：八个 mask 都能扫，但「与官方 CLI 逐位相同」只有一个答案 ——
 *   必须把 N1/N2/N3/N4 四条罚分规则全实现，取罚分最低的那个（同分取序号小的）。
 *
 * 自检（Node）：
 *   node -e "const q=require('./paseo/qr.js'); const m=q.qrMatrix('https://app.paseo.sh/#offer=xxx',{ecl:'M'}); console.log(m.version, m.ecl, m.mask, m.size)"
 *   node -e "const q=require('./paseo/qr.js'); console.log(q.qrSvg('https://app.paseo.sh/#offer=xxx').slice(0,120))"
 *   node -e "const q=require('./paseo/qr.js'); console.log(q.qrDataUrl('hi').slice(0,40))"
 * 渲染层：<script src="paseo/qr.js"></script> 之后用 window.MTNodeQR.qrSvg(text)
 */
"use strict";

(function (root, factory) {
  var api = factory();
  // 浏览器 / 渲染层：挂全局（Electron 渲染层与普通 <script> 都是这条路）。
  if (root && typeof root === "object") root.MTNodeQR = api;
  // Node（CJS）：主进程 require 走这条路。
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : typeof window !== "undefined" ? window : this, function () {
  /* ------------------------------------------------------------------ *
   * 一、标准常量（全部出自 ISO/IEC 18004；这些数是标准的定义，不是某库的实现细节）
   * ------------------------------------------------------------------ */

  /** 四个纠错等级 → 格式信息里的 2 位标识（ISO/IEC 18004 表 25）。
   *  注意 L=01、M=00、Q=11、H=10 —— 不是二进制顺序，写错会直接被扫码器判成别的等级。 */
  var ECL_BITS = { L: 1, M: 0, Q: 3, H: 2 };

  /** 纠错等级自愈力（用于纠错容量表，本文件只在「选版本」时看数据码字数，故保留为可读名）。 */
  var ECL_ORDER = ["L", "M", "Q", "H"];

  /** 模式指示符（ISO/IEC 18004 表 2）：本文件只用字节模式。 */
  var MODE_BYTE = 4; // 0100

  /** 字符计数指示符位宽（ISO/IEC 18004 表 3）：
   *  字节模式下版本 1–9 是 8 位，版本 10–40 是 16 位。
   *  这是最容易在「10 字符与 11 字符之间」出错的一处 —— 版本跳变会导致位宽跳变。 */
  function charCountBits(version) {
    return version <= 9 ? 8 : 16;
  }

  /** 各版本符号的**数据码字**总数（ISO/IEC 18004 表 1「数据容量」列，与纠错等级有关）。
   *  行 = 版本 1..40，列 = L / M / Q / H。
   *  注意：这里是**数据**码字（不含纠错），版本 1 分别是 19/16/13/9 —— 不是同一个数。
   *  它与 TOTAL_CODEWORDS、ECC_PER_BLOCK、ECC_BLOCKS 三者恒等：
   *  data = total - eccPerBlock × blocks（验证脚本会对 160 个组合逐条校验这条恒等式）。 */
  var DATA_CODEWORDS = [
    // L    M    Q    H
    [19, 16, 13, 9], // 1
    [34, 28, 22, 16], // 2
    [55, 44, 34, 26], // 3
    [80, 64, 48, 36], // 4
    [108, 86, 62, 46], // 5
    [136, 108, 76, 60], // 6
    [156, 124, 88, 66], // 7
    [194, 154, 110, 86], // 8
    [232, 182, 132, 100], // 9
    [274, 216, 154, 122], // 10
    [324, 254, 180, 140], // 11
    [370, 290, 206, 158], // 12
    [428, 334, 244, 180], // 13
    [461, 365, 261, 197], // 14
    [523, 415, 295, 223], // 15
    [589, 453, 325, 253], // 16
    [647, 507, 367, 283], // 17
    [721, 563, 397, 313], // 18
    [795, 627, 445, 341], // 19
    [861, 669, 485, 385], // 20
    [932, 714, 512, 406], // 21
    [1006, 782, 568, 442], // 22
    [1094, 860, 614, 464], // 23
    [1174, 914, 664, 514], // 24
    [1276, 1000, 718, 538], // 25
    [1370, 1062, 754, 596], // 26
    [1468, 1128, 808, 628], // 27
    [1531, 1193, 871, 661], // 28
    [1631, 1267, 911, 701], // 29
    [1735, 1373, 985, 745], // 30
    [1843, 1455, 1033, 793], // 31
    [1955, 1541, 1115, 845], // 32
    [2071, 1631, 1171, 901], // 33
    [2191, 1725, 1231, 961], // 34
    [2306, 1812, 1286, 986], // 35
    [2434, 1914, 1354, 1054], // 36
    [2566, 1992, 1426, 1096], // 37
    [2702, 2102, 1502, 1142], // 38
    [2812, 2216, 1582, 1222], // 39
    [2956, 2334, 1666, 1276], // 40
  ];

  /** 各版本符号的码字总数（ISO/IEC 18004 表 1「总码字数」列 = 数据 + 纠错，与等级无关）。
   *  索引 0 占位。DATA_CODEWORDS 是它的子集（等级不同、纠错量不同），两张表相互校验。 */
  var TOTAL_CODEWORDS = [
    0, 26, 44, 70, 100, 134, 172, 196, 242, 292, 346, 404, 466, 532, 581, 655, 733, 815, 901, 991, 1085, 1156, 1258,
    1364, 1474, 1588, 1706, 1828, 1921, 2051, 2185, 2323, 2465, 2611, 2761, 2876, 3034, 3196, 3362, 3532, 3706,
  ];

  /** 各版本每块纠错码字数（ISO/IEC 18004 表 13–22 的「纠错码字/块」列）。
   *  行 = 版本 1..40，列 = L / M / Q / H。 */
  var ECC_PER_BLOCK = [
    // L   M   Q   H
    [7, 10, 13, 17], // 1
    [10, 16, 22, 28], // 2
    [15, 26, 18, 22], // 3
    [20, 18, 26, 16], // 4
    [26, 24, 18, 22], // 5
    [18, 16, 24, 28], // 6
    [20, 18, 18, 26], // 7
    [24, 22, 22, 26], // 8
    [30, 22, 20, 24], // 9
    [18, 26, 24, 28], // 10
    [20, 30, 28, 24], // 11
    [24, 22, 26, 28], // 12
    [26, 22, 24, 22], // 13
    [30, 24, 20, 24], // 14
    [22, 24, 30, 24], // 15
    [24, 28, 24, 30], // 16
    [28, 28, 28, 28], // 17
    [30, 26, 28, 28], // 18
    [28, 26, 26, 26], // 19
    [28, 26, 30, 28], // 20
    [28, 26, 28, 30], // 21
    [28, 28, 30, 24], // 22
    [30, 28, 30, 30], // 23
    [30, 28, 30, 30], // 24
    [26, 28, 30, 30], // 25
    [28, 28, 28, 30], // 26
    [30, 28, 30, 30], // 27
    [30, 28, 30, 30], // 28
    [30, 28, 30, 30], // 29
    [30, 28, 30, 30], // 30
    [30, 28, 30, 30], // 31
    [30, 28, 30, 30], // 32
    [30, 28, 30, 30], // 33
    [30, 28, 30, 30], // 34
    [30, 28, 30, 30], // 35
    [30, 28, 30, 30], // 36
    [30, 28, 30, 30], // 37
    [30, 28, 30, 30], // 38
    [30, 28, 30, 30], // 39
    [30, 28, 30, 30], // 40
  ];

  /** 各版本纠错块总数（ISO/IEC 18004 表 13–22 的「块数」列）。
   *  行 = 版本 1..40，列 = L / M / Q / H。 */
  var ECC_BLOCKS = [
    // L  M  Q  H
    [1, 1, 1, 1], // 1
    [1, 1, 1, 1], // 2
    [1, 1, 2, 2], // 3
    [1, 2, 2, 4], // 4
    [1, 2, 4, 4], // 5
    [2, 4, 4, 4], // 6
    [2, 4, 6, 5], // 7
    [2, 4, 6, 6], // 8
    [2, 5, 8, 8], // 9
    [4, 5, 8, 8], // 10
    [4, 5, 8, 11], // 11
    [4, 8, 10, 11], // 12
    [4, 9, 12, 16], // 13
    [4, 9, 16, 16], // 14
    [6, 10, 12, 18], // 15
    [6, 10, 17, 16], // 16
    [6, 11, 16, 19], // 17
    [6, 13, 18, 21], // 18
    [7, 14, 21, 25], // 19
    [8, 16, 20, 25], // 20
    [8, 17, 23, 25], // 21
    [9, 17, 23, 34], // 22
    [9, 18, 25, 30], // 23
    [10, 20, 27, 32], // 24
    [12, 21, 29, 35], // 25
    [12, 23, 34, 37], // 26
    [12, 25, 34, 40], // 27
    [13, 26, 35, 42], // 28
    [14, 28, 38, 45], // 29
    [15, 29, 40, 48], // 30
    [16, 31, 43, 51], // 31
    [17, 33, 45, 54], // 32
    [18, 35, 48, 57], // 33
    [19, 37, 51, 60], // 34
    [19, 38, 53, 63], // 35
    [20, 40, 56, 66], // 36
    [21, 43, 59, 70], // 37
    [22, 45, 62, 74], // 38
    [24, 47, 65, 77], // 39
    [25, 49, 68, 81], // 40
  ];

  /** 对齐图形中心的坐标表（ISO/IEC 18004 附录 E）。坐标是**成对笛卡尔积**（含首尾两端），
   *  即每个对齐图形落在 center[i] × center[j] 上，但会避开三个定位图形所在的角落。 */
  var ALIGN_POS = [
    [], // 1：无对齐图形
    [6, 18],
    [6, 22],
    [6, 26],
    [6, 30],
    [6, 34],
    [6, 22, 38],
    [6, 24, 42],
    [6, 26, 46],
    [6, 28, 50],
    [6, 30, 54],
    [6, 32, 58],
    [6, 34, 62],
    [6, 26, 46, 66],
    [6, 26, 48, 70],
    [6, 26, 50, 74],
    [6, 30, 54, 78],
    [6, 30, 56, 82],
    [6, 30, 58, 86],
    [6, 34, 62, 90],
    [6, 28, 50, 72, 94],
    [6, 26, 50, 74, 98],
    [6, 30, 54, 78, 102],
    [6, 28, 54, 80, 106],
    [6, 32, 58, 84, 110],
    [6, 30, 58, 86, 114],
    [6, 34, 62, 90, 118],
    [6, 26, 50, 74, 98, 122],
    [6, 30, 54, 78, 102, 126],
    [6, 26, 52, 78, 104, 130],
    [6, 30, 56, 82, 108, 134],
    [6, 34, 60, 86, 112, 138],
    [6, 30, 58, 86, 114, 142],
    [6, 34, 62, 90, 118, 146],
    [6, 30, 54, 78, 102, 126, 150],
    [6, 24, 50, 76, 102, 128, 154],
    [6, 28, 54, 80, 106, 132, 158],
    [6, 32, 58, 84, 110, 136, 162],
    [6, 26, 54, 82, 110, 138, 166],
    [6, 30, 58, 86, 114, 142, 170],
  ];

  /* ------------------------------------------------------------------ *
   * 二、位缓冲与 GF(256) / Reed–Solomon
   * ------------------------------------------------------------------ */

  /** 位缓冲：先攒比特、最后按码字吐出。二维码的位序是**高位在前**（MSB first），
   *  所以这里用「每次左移一位再 or」而不是字节数组拼接 —— 与标准里的位流写法一一对应。 */
  function BitBuffer() {
    this.bytes = [];
    this.length = 0;
  }
  BitBuffer.prototype.put = function (value, bits) {
    for (var i = bits - 1; i >= 0; i--) this.putBit(((value >>> i) & 1) === 1);
  };
  BitBuffer.prototype.putBit = function (bit) {
    var idx = this.length >>> 3;
    if (this.bytes.length <= idx) this.bytes.push(0);
    if (bit) this.bytes[idx] |= 1 << (7 - (this.length & 7));
    this.length++;
  };

  /** GF(256) 的两张表（本原多项式 0x11D，即 x^8+x^4+x^3+x^2+1，ISO/IEC 18004 6.5.2 指定）。
   *  为什么用查表：纠错要对每个码字做一次乘法，而 RS 生成多项式是固定的 ——
   *  一次建表、之后全是 O(1)，比每次移位相加快一个量级，且代码更短。 */
  var GF_EXP = new Uint8Array(512); // 指数 → 值（长一倍，省掉 mod 255）
  var GF_LOG = new Int16Array(256); // 值 → 指数（0 无对数，留 -1）
  (function buildGaloisTables() {
    var x = 1;
    for (var i = 0; i < 255; i++) {
      GF_EXP[i] = x;
      GF_LOG[x] = i;
      x <<= 1;
      if (x & 0x100) x ^= 0x11d; // 本原多项式归约：越过 8 位的部分按 0x11D 折回
    }
    for (var j = 255; j < 512; j++) GF_EXP[j] = GF_EXP[j - 255];
  })();

  /** GF(256) 乘法（0 吸收）。 */
  function gfMul(a, b) {
    if (a === 0 || b === 0) return 0;
    return GF_EXP[GF_LOG[a] + GF_LOG[b]];
  }

  /** 生成多项式 g(x) = ∏(x - α^i), i = 0..degree-1（ISO/IEC 18004 6.5.2）。
   *  系数按**升幂**排列（gen[0] 是最低次项/常数项，gen[degree] 恒为 1 即最高次项）。
   *  为什么强调序：下面的长除法循环按「当前被除式最高次项」对齐逐项异或，
   *  生成多项式存反了会得到完全另一组纠错码字 —— 矩阵照样生成得出来、扫码器却读不出来。
   *  （这版第一稿把升幂数组在除法里按下标取反了，ECC 整段错；只有对着官方包逐字节
   *   比对才看得出来，因为「错的 ECC + 正确的数据 + 正确掩码」听起来同样合理。） */
  function rsGeneratorPoly(degree) {
    var poly = [1];
    for (var i = 0; i < degree; i++) {
      var next = new Array(poly.length + 1);
      for (var k = 0; k < next.length; k++) next[k] = 0;
      for (var j = 0; j < poly.length; j++) {
        next[j] ^= poly[j]; // 乘 1
        next[j + 1] ^= gfMul(poly[j], GF_EXP[i]); // 乘 α^i
      }
      poly = next;
    }
    return poly;
  }

  /** 对一个数据块算 eccLen 个纠错码字（多项式长除法取余）。
   *  返回的数组顺序与标准要求一致：**第一个纠错码字是余式最高次项**。
   *  gen 用升幂存，所以「当前项乘 gen[j]」贡献到 res[d + j] —— 幂次刚好对上。 */
  function rsEncode(data, eccLen) {
    var gen = rsGeneratorPoly(eccLen); // 长度 eccLen + 1，gen[eccLen] === 1
    var res = data.slice();
    for (var i = 0; i < eccLen; i++) res.push(0); // 右移 eccLen 位，等价于乘以 x^eccLen
    for (var d = 0; d < data.length; d++) {
      var factor = res[d];
      if (factor === 0) continue;
      for (var j = 0; j < gen.length; j++) res[d + j] ^= gfMul(gen[j], factor);
    }
    return res.slice(data.length);
  }

  /** 对一个数据块算 eccLen 个纠错码字（多项式长除法取余）。
   *  返回的数组顺序与标准要求一致：**第一个纠错码字是余式最高次项**。 */
  function rsEncode(data, eccLen) {
    var gen = rsGeneratorPoly(eccLen); // gen[0] === 1（最高次项），长度 eccLen + 1
    var res = data.slice();
    for (var i = 0; i < eccLen; i++) res.push(0); // 右移 eccLen 位，等价于乘以 x^eccLen
    for (var d = 0; d < data.length; d++) {
      var factor = res[d];
      if (factor === 0) continue;
      for (var j = 0; j < gen.length; j++) res[d + j] ^= gfMul(gen[j], factor);
    }
    return res.slice(data.length);
  }

  /* ------------------------------------------------------------------ *
   * 三、BCH 校验（格式信息 15 位 / 版本信息 18 位）
   * ------------------------------------------------------------------ */

  /** 通用 BCH 余式（生成多项式按位给出的移位除法）。
   *  标准给的 0x537（格式）与 0x1F25（版本）都是这个形状。 */
  function bchRemainder(data, generator, generatorBits) {
    var rem = data;
    var genTopBit = 1 << (generatorBits - 1);
    while (bitLength(rem) >= generatorBits) {
      rem ^= generator << (bitLength(rem) - generatorBits);
    }
    return rem & (genTopBit - 1);
  }

  function bitLength(v) {
    var n = 0;
    while (v !== 0) {
      n++;
      v >>>= 1;
    }
    return n;
  }

  /** 格式信息（ISO/IEC 18004 表 25）：5 位数据（2 位纠错等级 + 3 位 mask）→
   *  10 位 BCH 校验，再整体异或 0x5412（标准规定的「不许全 0」掩码）。 */
  function formatBits(ecl, maskPattern) {
    var data = (ECL_BITS[ecl] << 3) | maskPattern;
    var rem = bchRemainder(data << 10, 0x537, 11); // 生成多项式 x^10+x^8+x^5+x^4+x^2+x+1
    return ((data << 10) | rem) ^ 0x5412;
  }

  /** 版本信息（ISO/IEC 18004 表 26，仅版本 ≥ 7 需要）：6 位版本号 + 12 位 BCH 校验。
   *  ★ 这里**不再异或任何掩码**。0x1F25 是**生成多项式**（x^12+x^11+x^10+x^9+x^8+x^5+x^2+1），
   *    不是格式信息那种「算完再整体异或」的掩码。第一版照格式信息的写法又 XOR 了一次 0x1F25，
   *    等于把 18 位版本信息写错：症状是 **v7 起整张符号成片错**（每个 2 列组从版本信息块
   *    之后全部错位），而 v1–v6 全对 —— 极易误判成分块交织或掩码的锅。
   *    标准给出的 v7 = 000111110010010100（0x7C94）就是「未异或」的那个值。 */
  function versionBits(version) {
    if (version < 7) return null;
    var data = version << 12;
    var rem = bchRemainder(data, 0x1f25, 13);
    return data | rem;
  }

  /** 排障用：把 BCH 中间量摊开（版本信息那份）。 */
  function versionBitsTrace(version) {
    var data = version << 12;
    var rem = bchRemainder(data, 0x1f25, 13);
    return { data: data, rem: rem, unmasked: data | rem, masked: (data | rem) ^ 0x1f25, bitLengthData: bitLength(data), bitLengthGen: bitLength(0x1f25) };
  }

  /* ------------------------------------------------------------------ *
   * 四、符号结构计算（尺寸、分块、数据容量）
   * ------------------------------------------------------------------ */

  function sizeOf(version) {
    return version * 4 + 17;
  }

  /** 本版本**实际要画**的对齐图形中心点（坐标对），ISO/IEC 18004 附录 E 的摆放规则：
   *  坐标表两两组合，落在三个定位图形角落里的那三个（v2–6 是 (6,6)；v≥7 是
   *  (6,6)/(6,末)/(末,6)）不画。矩阵铺设与「功能图形计数」都走这一个函数 ——
   *  两处各写一遍就会像最早那版一样，在 v1（坐标表为空、角落数算法不适用）上算错。 */
  function alignmentCenters(version) {
    var coords = ALIGN_POS[version - 1];
    var n = coords.length;
    var out = [];
    for (var i = 0; i < n; i++) {
      for (var j = 0; j < n; j++) {
        // 三个定位图形占据的角落：左上 (6,6)、右上 (6,末)、左下 (末,6)
        var corner = (i === 0 && j === 0) || (i === 0 && j === n - 1) || (i === n - 1 && j === 0);
        if (corner) continue;
        out.push([coords[i], coords[j]]);
      }
    }
    return out;
  }

  /** 功能图形占用的模块数（**并集**计数，用于反推余数位，ISO/IEC 18004 表 1 备注）。
   *  为什么要按并集数、而不是「各部件相加」：对齐图形压在定时线（第 6 行/列）上的那几格
   *  只能算一次。这版最早写成 `(size-16)*2` 定时线 + 31 格格式信息 + 1 格暗模块直接相加，
   *  v1 上算出负余数位；改成 `(size-8)*2` 又在 v7+ 上差 10 格。
   *  现在这四个常量 + 重叠修正，已对着官方 `qrcode` 包的 BitMatrix.reservedBit
   *  （就是「功能图形 + 格式信息」的并集）在 40 个版本上逐个核过，全等；
   *  并且余数位在 40 个版本上都落在标准允许的 {0,3,4,7} 内（验证脚本会复跑）。 */
  function functionModuleCount(version) {
    var size = sizeOf(version);
    var n = 3 * 64; // 三个定位图形：7×7 本体 + 1 格宽分隔符（仅在符号内）= 8×8
    n += (size - 16) * 2; // 定时图形：第 6 行 / 第 6 列各从 8 数到 size-9
    n += 31; // 格式信息：两份 15 位（左上那份 15 格 + 左下/右上那份 16 格，含固定暗模块）

    var centers = alignmentCenters(version);
    n += centers.length * 25; // 对齐图形 5×5
    for (var i = 0; i < centers.length; i++) {
      // 对齐图形与定时线重叠的格子：中心落在第 6 行/列时，各有 5 格已计入定时图形
      if (centers[i][0] === 6) n -= 5;
      if (centers[i][1] === 6) n -= 5;
    }

    if (version >= 7) n += 36; // 版本信息：两份 18 位（右上 3×6 + 左下 6×3）
    return n;
  }

  /** 符号里的码字总数（与纠错等级无关，ISO/IEC 18004 表 1「总码字数」列）。 */
  function totalCodewords(version) {
    return TOTAL_CODEWORDS[version];
  }

  /** 余数位（remainder bits）：塞完最后一个码字后剩下的空位，标准规定填 0。
   *  由「总面积 - 功能图形 - 8×码字数」反推，比抄表更不容易错 ——
   *  而且它顺带成了「功能图形计数」与「码字表」之间的一致性校验（验证脚本会跑）。 */
  function remainderBits(version) {
    var total = sizeOf(version) * sizeOf(version);
    return total - functionModuleCount(version) - 8 * totalCodewords(version);
  }

  /** 指定版本 + 等级的**数据码字**总量（ISO/IEC 18004 表 1 的「数据容量」列）。
   *  三条口径互为校验：数据 + 纠错 = 总码字（验证脚本会对 160 个组合逐条核这条恒等式）。 */
  function dataCodewordsFor(version, ecl) {
    return DATA_CODEWORDS[version - 1][ECL_ORDER.indexOf(ecl)];
  }

  /** 指定版本 + 等级的纠错码字总量（= 每块纠错数 × 块数）。 */
  function eccTotalFor(version, ecl) {
    var col = ECL_ORDER.indexOf(ecl);
    return ECC_PER_BLOCK[version - 1][col] * ECC_BLOCKS[version - 1][col];
  }

  /** 按标准分块（ISO/IEC 18004 表 13–22 的 (c, k, r) 三元组展开）。
   *  ★ 分组顺序：数据码字先均分，多出来的 r 个给**靠后**的 r 块。
   *    也就是「前面若干块是短块、后面 r 块各多 1 个数据码字」——
   *    标准表里写成 group1 = c-k 个块、group2 = k 个块，group2 在后。
   *    第一版把长块放在前面（直觉上「余数给前几块」），于是 v9-M 这类
   *    「数据码字不能被块数整除」的版本整段交织错位：数据码字本身完全正确、
   *    版本/掩码/对齐/定时也都对，只有交织顺序错 —— 逐位比对才会暴露。 */
  function splitBlocks(version, ecl) {
    var col = ECL_ORDER.indexOf(ecl);
    var eccLen = ECC_PER_BLOCK[version - 1][col];
    var blockCount = ECC_BLOCKS[version - 1][col];
    var dataCw = dataCodewordsFor(version, ecl);
    var shortLen = Math.floor(dataCw / blockCount);
    var longCount = dataCw % blockCount; // 最后 longCount 块各多 1 个数据码字
    var firstLong = blockCount - longCount;
    var blocks = [];
    for (var i = 0; i < blockCount; i++) {
      blocks.push({ dataLength: i < firstLong ? shortLen : shortLen + 1, eccLength: eccLen });
    }
    return blocks;
  }

  /* ------------------------------------------------------------------ *
   * 五、编码主流程
   * ------------------------------------------------------------------ */

  function normalizeEcl(ecl) {
    var e = String(ecl == null ? "M" : ecl).toUpperCase();
    if (!(e in ECL_BITS)) throw new Error("qr: 纠错等级只能是 L/M/Q/H，收到 " + JSON.stringify(ecl));
    return e;
  }

  /** UTF-8 编码。优先用平台的 TextEncoder（浏览器 / Node ≥ 11 都有），
   *  没有时退回手写实现 —— 手写值只在极端环境用，逻辑与标准 RFC 3629 一致。 */
  function utf8Bytes(text) {
    var s = String(text);
    if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(s);
    var out = [];
    for (var i = 0; i < s.length; i++) {
      var code = s.charCodeAt(i);
      if (code < 0x80) out.push(code);
      else if (code < 0x800) out.push(0xc0 | (code >> 6), 0x80 | (code & 63));
      else if (code >= 0xd800 && code <= 0xdbff) {
        // 代理对：合成后按 4 字节编码
        var hi = code,
          lo = s.charCodeAt(++i);
        var cp = 0x10000 + ((hi - 0xd800) << 10) + (lo - 0xdc00);
        out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
      } else out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63));
    }
    return new Uint8Array(out);
  }

  /** 选版本：从 1 往上找第一个「数据位装得下」的版本。
   *  注意位宽随版本变（v10 起字符计数指示符从 8 位跳到 16 位），所以容量判定必须
   *  逐版本、用该版本自己的位宽算，不能用 v1 的宽度一把梭。 */
  function chooseVersion(byteLen, ecl) {
    for (var v = 1; v <= 40; v++) {
      var capacityBits = dataCodewordsFor(v, ecl) * 8;
      var needBits = 4 + charCountBits(v) + byteLen * 8;
      if (needBits <= capacityBits) return v;
    }
    throw new Error(
      "qr: 内容太长，" + byteLen + " 字节在纠错等级 " + ecl + " 下放不进版本 40（上限 " +
        Math.floor((dataCodewordsFor(40, ecl) * 8 - 4 - 16) / 8) + " 字节）",
    );
  }

  /** 按模式/长度/内容填数据位：模式指示符 → 字符计数 → 数据 → 终止符 → 补位 → 填充码字。
   *  这里每一步都是 ISO/IEC 18004 6.4.10 的顺序，错一步整码就扫不出来。 */
  function buildDataCodewords(bytes, version, ecl) {
    var capacityBits = dataCodewordsFor(version, ecl) * 8;
    var buffer = new BitBuffer();
    buffer.put(MODE_BYTE, 4);
    buffer.put(bytes.length, charCountBits(version));
    for (var i = 0; i < bytes.length; i++) buffer.put(bytes[i], 8);
    // 终止符：最多 4 个 0，但容量不足 4 位时只补到满
    var remaining = capacityBits - buffer.length;
    buffer.put(0, Math.min(4, Math.max(0, remaining)));
    // 补到字节边界
    if (buffer.length % 8 !== 0) buffer.put(0, 8 - (buffer.length % 8));
    // 交替填充码字 0xEC / 0x11（标准规定的「假数据」，让符号不至于大片同色）
    var padToggle = true;
    while (buffer.length < capacityBits) {
      buffer.put(padToggle ? 0xec : 0x11, 8);
      padToggle = !padToggle;
    }
    return buffer.bytes.slice(0, capacityBits / 8);
  }

  /** 分块 → 逐块算 RS 纠错 → 按标准交织（ISO/IEC 18004 6.6）。
   *  交织顺序：先按列取各块的第 i 个数据码字，再按列取各块的第 i 个纠错码字。 */
  function interleaveWithEcc(dataCodewords, version, ecl) {
    var blocks = splitBlocks(version, ecl);
    var offset = 0;
    var dataBlocks = [];
    var eccBlocks = [];
    for (var b = 0; b < blocks.length; b++) {
      var info = blocks[b];
      var chunk = dataCodewords.slice(offset, offset + info.dataLength);
      offset += info.dataLength;
      dataBlocks.push(chunk);
      eccBlocks.push(rsEncode(chunk, info.eccLength));
    }
    var out = [];
    var maxData = 0;
    for (var i = 0; i < dataBlocks.length; i++) maxData = Math.max(maxData, dataBlocks[i].length);
    for (var d = 0; d < maxData; d++) {
      for (var j = 0; j < dataBlocks.length; j++) if (d < dataBlocks[j].length) out.push(dataBlocks[j][d]);
    }
    for (var e = 0; e < blocks[0].eccLength; e++) {
      for (var k = 0; k < eccBlocks.length; k++) out.push(eccBlocks[k][e]);
    }
    return out;
  }

  /* ------------------------------------------------------------------ *
   * 六、矩阵铺设
   * ------------------------------------------------------------------ */

  /** 建矩阵骨架：先摆功能图形（定位 / 分隔符 / 定时 / 对齐 / 暗模块 / 版本信息），
   *  功能图形占的位置记在 reserved 里 —— 数据只能填进「非 reserved」的格子。 */
  function buildBaseMatrix(version) {
    var size = sizeOf(version);
    var modules = [];
    var reserved = [];
    for (var r = 0; r < size; r++) {
      modules.push(new Array(size).fill(false));
      reserved.push(new Array(size).fill(false));
    }

    function setFunction(row, col, dark) {
      modules[row][col] = !!dark;
      reserved[row][col] = true;
    }

    // 三个定位图形（含 1 模块宽的分隔符）：7×7 回字 + 中心 3×3 实心
    function placeFinder(row, col) {
      for (var r = -1; r <= 7; r++) {
        for (var c = -1; c <= 7; c++) {
          var rr = row + r,
            cc = col + c;
          if (rr < 0 || rr >= size || cc < 0 || cc >= size) continue;
          var onRing = (r >= 0 && r <= 6 && (c === 0 || c === 6)) || (c >= 0 && c <= 6 && (r === 0 || r === 6));
          var inCore = r >= 2 && r <= 4 && c >= 2 && c <= 4;
          setFunction(rr, cc, onRing || inCore);
        }
      }
    }
    placeFinder(0, 0);
    placeFinder(0, size - 7);
    placeFinder(size - 7, 0);

    // 定时图形：第 6 行 / 第 6 列交替，从 8 到 size-9
    for (var t = 8; t < size - 8; t++) {
      setFunction(6, t, t % 2 === 0);
      setFunction(t, 6, t % 2 === 0);
    }

    // 对齐图形：坐标笛卡尔积，跳过与定位图形重叠的 3 个角（与计数共用 alignmentCenters）
    var centers = alignmentCenters(version);
    for (var a = 0; a < centers.length; a++) {
      var cr = centers[a][0],
        cc2 = centers[a][1];
      for (var dr = -2; dr <= 2; dr++) {
        for (var dc = -2; dc <= 2; dc++) {
          var ar = cr + dr,
            ac = cc2 + dc;
          // ★ 与定时线交叠的格子**保持定时图形**，不能被对齐图形改写：
          //   定时线是第 6 行/列上从 8 到 size-9 的交替序列。中心落在第 6 行/列的对齐图形
          //   （如 v≥7 的 (6, 中间列)、(中间行, 6)）必然与它交叠，标准规定以定时图形为准。
          //   第一版无脑覆盖，把这 5 格（每处）写成了对齐图形自己的环形值，
          //   症状是「v1–v6 全对、v7 起每条与定时线相交的对齐图形附近成片错」。
          var onTiming = (ar === 6 && ac >= 8 && ac <= size - 9) || (ac === 6 && ar >= 8 && ar <= size - 9);
          if (onTiming) continue;
          var isDark = Math.max(Math.abs(dr), Math.abs(dc)) !== 1; // 5×5 环 + 中心点
          setFunction(ar, ac, isDark);
        }
      }
    }

    // 固定暗模块（标准规定的「always dark」格子，位于左下角定位图形上方第 8 列）
    setFunction(size - 8, 8, true);

    // ★ 格式信息那 31 格必须**在铺数据之前**就标成保留：
    //   它们不属于数据区，铺数据时必须跳过（否则数据会写进格式条里，
    //   位序整段后移 —— 症状是「码字/版本/掩码都对、矩阵却成片不同」）。
    //   这里只标保留、不写具体值：具体值要等掩码定下来才写（placeFormatBits）。
    //   两份 15 位：左上（竖条 + 横条）与 右上横条 + 左下竖条。
    for (var fi = 0; fi <= 5; fi++) reserved[fi][8] = true; // 左上竖条上半
    reserved[7][8] = true; // 跳过第 6 行（定时行）
    reserved[8][8] = true; // 纵横交汇
    for (var fj = 9; fj <= 14; fj++) reserved[14 - fj][8] = true; // 左上竖条下半 → (5,8)…(0,8)
    for (var fk = 0; fk <= 5; fk++) reserved[8][fk] = true; // 左上横条
    reserved[8][7] = true;
    for (var fm = 0; fm <= 7; fm++) reserved[8][size - 1 - fm] = true; // 右上横条（含固定暗模块）
    for (var fn = 8; fn <= 14; fn++) reserved[size - 15 + fn][8] = true; // 左下竖条

    // 版本信息（版本 ≥ 7）：右上 3×6 与左下 6×3 两块
    var vBits = versionBits(version);
    if (vBits !== null) {
      for (var b = 0; b < 18; b++) {
        var bit = ((vBits >> b) & 1) === 1;
        setFunction(Math.floor(b / 3), size - 11 + (b % 3), bit); // 右上
        setFunction(size - 11 + (b % 3), Math.floor(b / 3), bit); // 左下
      }
    }
    return { size: size, modules: modules, reserved: reserved };
  }

  /** 数据铺放：从右下角开始，两列一组向上蛇形，跳过第 6 列定时线。
   *  ★ 组内的走法必须是「右格 → 左格 → 上一行右格 → 上一行左格 ……」，
   *    即**每走一格就换列、每走完两格才上移一行**（横向蛇形）。
   *    第一版写成「先整列向上、再换到左列整列向上」（纵向蛇形）——
   *    同一个 2 列组里的格子集合完全一样、只是顺序不同，于是版本/掩码/罚分/码字
   *    全都对得上，矩阵却错一半，且错的位置恰好在每个 2 列组的后半段。
   *    这类错误只有逐格比位序才能发现。 */
  function placeDataBits(modules, reserved, codewords, version) {
    var size = sizeOf(version);
    var totalBits = codewords.length * 8 + remainderBits(version);
    var bitIndex = 0;

    function bitAt(i) {
      if (i >= codewords.length * 8) return false; // 余数位固定为 0
      return ((codewords[i >>> 3] >>> (7 - (i & 7))) & 1) === 1;
    }

    var upward = true;
    for (var col = size - 1; col > 0; col -= 2) {
      if (col === 6) col--; // 第 6 列是垂直定时图形，跳过
      var row = upward ? size - 1 : 0;
      for (;;) {
        for (var c = 0; c < 2; c++) {
          var cc = col - c;
          if (reserved[row][cc]) continue; // 功能图形占位：不消费比特、也不写
          if (bitIndex < totalBits) modules[row][cc] = bitAt(bitIndex);
          bitIndex++;
        }
        row += upward ? -1 : 1;
        if (row < 0 || row >= size) {
          row -= upward ? -1 : 1;
          upward = !upward;
          break;
        }
      }
    }
    return bitIndex;
  }

  /** 写入格式信息两份（ISO/IEC 18004 6.9）：15 位 = 5 位数据 + 10 位 BCH，再异或 0x5412。
   *  两份副本各 15 格：
   *    · 副本一：第 8 行 x=0..8（跳过定时列 x=6）＋ 第 8 列 y=0..8（跳过定时行 y=6）；
   *    · 副本二：第 8 行 x=size-1..size-8（bit0 落在最右，即固定暗模块那一格）
   *              ＋ 第 8 列 y=size-1..size-7。
   *  ★ 必须写成**一个**按 i 递增的循环。第一版把它拆成「横条一个循环 + 竖条另一个循环」，
   *    而 JS 的 `var` 是函数级作用域、循环变量互相覆盖，结果两个循环都从 (8,0) 起写、
   *    后写的盖掉先写的 —— 格式信息只写对了一半（bit0..2 与 bit9..14 错位），
   *    症状是「数据区逐位全对、只有格式条上 6 格不对」。改用 let 或单个循环都能避免。 */
  function placeFormatBits(modules, reserved, ecl, maskPattern) {
    var size = modules.length;
    var bits = formatBits(ecl, maskPattern);

    for (var i = 0; i < 15; i++) {
      var on = ((bits >> i) & 1) === 1;

      // 竖条：bit0..5 → (0..5, 8)；bit6..7 → (7..8, 8)；bit8..14 → (size-7..size-1, 8)
      if (i < 6) modules[i][8] = on;
      else if (i < 8) modules[i + 1][8] = on;
      else modules[size - 15 + i][8] = on;

      // 横条：bit0..7 → 第 8 行最右 8 格（含固定暗模块）；bit8 → (8,7)；bit9..14 → (8,5..0)
      if (i < 8) modules[8][size - 1 - i] = on;
      else if (i < 9) modules[8][7] = on;
      else modules[8][14 - i] = on;
    }

    // 固定暗模块：已由 i=7 那一步写入（(8, size-8)），这里再钉一次，避免将来改动漏掉
    modules[size - 8][8] = true;

    // 格式信息区域同样是「功能图形」，掩码评估时必须排除在外
    for (var a = 0; a <= 5; a++) reserved[a][8] = true;
    reserved[7][8] = reserved[8][8] = reserved[8][7] = true;
    for (var b = 8; b <= 14; b++) reserved[size - 15 + b][8] = true;
    for (var c = 0; c <= 7; c++) reserved[8][size - 1 - c] = true;
    reserved[8][0] = reserved[8][1] = reserved[8][2] = reserved[8][3] = reserved[8][4] = reserved[8][5] = true;
    reserved[8][5] = reserved[8][4] = reserved[8][3] = reserved[8][2] = reserved[8][1] = reserved[8][0] = true;
  }

  /** 八个掩码（ISO/IEC 18004 表 10）。i = 行，j = 列。 */
  var MASK_FUNCS = [
    function (i, j) {
      return (i + j) % 2 === 0;
    },
    function (i) {
      return i % 2 === 0;
    },
    function (i, j) {
      return j % 3 === 0;
    },
    function (i, j) {
      return (i + j) % 3 === 0;
    },
    function (i, j) {
      return (Math.floor(i / 2) + Math.floor(j / 3)) % 2 === 0;
    },
    function (i, j) {
      return ((i * j) % 2) + ((i * j) % 3) === 0;
    },
    function (i, j) {
      return (((i * j) % 2) + ((i * j) % 3)) % 2 === 0;
    },
    function (i, j) {
      return (((i + j) % 2) + ((i * j) % 3)) % 2 === 0;
    },
  ];

  function applyMask(modules, reserved, maskPattern) {
    var size = modules.length;
    var fn = MASK_FUNCS[maskPattern];
    for (var r = 0; r < size; r++) {
      for (var c = 0; c < size; c++) {
        if (reserved[r][c]) continue;
        if (fn(r, c)) modules[r][c] = !modules[r][c];
      }
    }
  }

  /* ------------------------------------------------------------------ *
   * 七、掩码罚分（ISO/IEC 18004 6.10.3 的 N1/N2/N3/N4 四条规则）
   * ------------------------------------------------------------------ */

  /** N1：同色连续 ≥5 的行程，罚 3 + (长度 - 5)。行列都要算。 */
  var N1 = 3;
  /** N2：同色 2×2 块，每块罚 3（重叠计数，不是「不重叠的块数」）。 */
  var N2 = 3;
  /** N3：出现 1011101 且一侧带 4 个浅色（即 1:1:3:1:1 比例的定位图形样式），每次罚 40。
   *  实现在于「怎么扫」。本条按与官方 `qrcode` 包逐值对齐的口径写：
   *  逐行/列维护一个 11 位滑动窗口，**只在扫描下标 ≥ 10 时**比对，
   *  比对的是「以当前位置结尾」的那个 11 位窗口（即窗口整体左移了一位）。
   *  换句话说窗口尾部可以越出符号边界，而最后一次「补 0 也凑不出完整窗口」的位置不判。
   *  为什么不去追更「教科书」的写法：我们的验收口径就是**与官方 CLI 输出逐位一致**，
   *  罚分口径必须跟它完全一样，否则掩码会选到另一个（虽然同样扫得出来）。 */
  var N3 = 40;
  /** N4：深色占比偏离 50%，按 5% 台阶计。台阶数用**向上取整**的偏离比：
   *  k = |ceil(占比 / 5) - 10|（与官方 qrcode 一致，而不是 |占比-50|/5 取整 ——
   *  两者在占比整除 5 的那一档会差 10 分，足以翻转某些版本的掩码选择）。 */
  var N4 = 10;

  /** 11 位窗口比对：10111010000 / 00001011101（N3 的两个方向）。 */
  var N3_WINDOW_A = 0x5d0; // 10111010000
  var N3_WINDOW_B = 0x05d; // 00001011101

  /** 单条线（一行或一列）的 N3 命中次数：与官方同一套滑动窗口口径。 */
  function lineFinderLikeCount(at, length) {
    var hits = 0;
    var window = 0;
    for (var i = 0; i < length; i++) {
      window = ((window << 1) & 0x7ff) | (at(i) ? 1 : 0);
      if (i >= 10 && (window === N3_WINDOW_A || window === N3_WINDOW_B)) hits++;
    }
    return hits;
  }

  /** 单条线的 N1：连续同色行程 ≥5 时累加 3 + (len - 5)。 */
  function lineRunPenalty(values) {
    var penalty = 0;
    var runLen = 1;
    for (var i = 1; i < values.length; i++) {
      if (values[i] === values[i - 1]) {
        runLen++;
        if (runLen === 5) penalty += N1; // 正好到 5 时先记 3
        else if (runLen > 5) penalty += 1; // 之后每多一个 +1
      } else runLen = 1;
    }
    return penalty;
  }

  /** 四条规则的**分项**罚分（total 才是选掩码用的那个数）。
   *  单独拆出来是为了排障：掩码选错时，一眼能看出是哪条规则算岔了
   *  （N1 行程 / N2 块 / N3 定位图形样式 / N4 深色占比）。 */
  function penaltyBreakdown(modules) {
    var size = modules.length;
    var n1 = 0;
    var n3 = 0;
    var darkCount = 0;

    // N1 + N3：逐行、逐列
    for (var i = 0; i < size; i++) {
      var rowValues = [];
      var colValues = [];
      for (var j = 0; j < size; j++) {
        rowValues.push(modules[i][j]);
        colValues.push(modules[j][i]);
        if (modules[i][j]) darkCount++;
      }
      n1 += lineRunPenalty(rowValues);
      n1 += lineRunPenalty(colValues);
      n3 += lineFinderLikeCount(function (k) { return rowValues[k]; }, size) * N3;
      n3 += lineFinderLikeCount(function (k) { return colValues[k]; }, size) * N3;
    }

    // N2：2×2 同色块（重叠计数）
    var n2 = 0;
    for (var r = 0; r < size - 1; r++) {
      for (var c = 0; c < size - 1; c++) {
        var v = modules[r][c];
        if (v === modules[r][c + 1] && v === modules[r + 1][c] && v === modules[r + 1][c + 1]) n2 += N2;
      }
    }

    // N4：深色占比偏离 50%，每 5% 台阶罚 10（台阶数口径见 N4 注释）
    var steps = Math.abs(Math.ceil((darkCount * 100) / (size * size) / 5) - 10);
    var n4 = steps * N4;

    return { n1: n1, n2: n2, n3: n3, n4: n4, total: n1 + n2 + n3 + n4 };
  }

  /** 整张矩阵的罚分（四条规则合计）。 */
  function maskPenalty(modules) {
    return penaltyBreakdown(modules).total;
  }

  /* ------------------------------------------------------------------ *
   * 八、对外 API
   * ------------------------------------------------------------------ */

  function num(v, dflt) {
    var n = Number(v);
    return isFinite(n) ? n : dflt;
  }

  /** 编码主入口：文本 → { version, ecl, mask, size, modules }。
   *  modules 是 boolean[][]（true = 深色），不含 quiet zone。
   *  opts.forceMask（0..7）只给验证脚本用：跳过罚分选优、钉死某个掩码，
   *  这样能逐掩码与对照实现比矩阵，从而把「掩码选错」与「矩阵铺错」分开定位。 */
  function qrMatrix(text, opts) {
    var o = opts || {};
    var ecl = normalizeEcl(o.ecl);
    var bytes = utf8Bytes(text == null ? "" : text);
    var version = o.version ? Math.max(1, Math.min(40, Math.round(num(o.version, 1)))) : chooseVersion(bytes.length, ecl);
    if (o.version && bytes.length * 8 + 4 + charCountBits(version) > dataCodewordsFor(version, ecl) * 8) {
      throw new Error("qr: 指定版本 " + version + " 装不下 " + bytes.length + " 字节（等级 " + ecl + "）");
    }

    var dataCodewords = buildDataCodewords(bytes, version, ecl);
    var codewords = interleaveWithEcc(dataCodewords, version, ecl);

    function buildWithMask(mask) {
      var base = buildBaseMatrix(version);
      placeDataBits(base.modules, base.reserved, codewords, version);
      placeFormatBits(base.modules, base.reserved, ecl, mask);
      applyMask(base.modules, base.reserved, mask);
      return base.modules;
    }

    if (o.forceMask != null) {
      var forced = Math.max(0, Math.min(7, Math.round(num(o.forceMask, 0))));
      var forcedModules = buildWithMask(forced);
      return {
        version: version,
        ecl: ecl,
        mask: forced,
        size: forcedModules.length,
        modules: forcedModules,
        penalty: maskPenalty(forcedModules),
      };
    }

    /* 八个掩码各铺一遍，取罚分最低的那个。
     * 同分时取序号小的 —— 标准对并列没有规定，取最小序号才是与官方 qrcode 逐位一致的那种。
     * 罚分对象是「数据 + 真格式信息 + 掩码」的完整符号（官方 getBestMask 也是先把该掩码的
     * 格式信息写进矩阵再评估，所以格式条会随掩码变化，不能用占位值评估）。 */
    var best = null;
    for (var mask = 0; mask < 8; mask++) {
      var modules = buildWithMask(mask);
      var penalty = maskPenalty(modules);
      if (best === null || penalty < best.penalty) best = { mask: mask, penalty: penalty, modules: modules };
    }

    return {
      version: version,
      ecl: ecl,
      mask: best.mask,
      size: best.modules.length,
      modules: best.modules,
      penalty: best.penalty,
    };
  }

  function escapeAttr(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  /** SVG 输出：默认 scale=8（模块边长的像素数）、margin=4（quiet zone 模块数，标准要求 ≥4）。
   *  用 shape-rendering="crispEdges" 让缩放后不出现半透明接缝 —— 扫码器对灰缝很敏感。
   *  路径用一个 <path> 拼所有深色方块，DOM 里只有一个节点，插进控制台窗很轻。 */
  function qrSvg(text, opts) {
    var o = opts || {};
    var m = qrMatrix(text, { ecl: o.ecl, version: o.version });
    var scale = Math.max(1, Math.round(num(o.scale, 8)));
    var margin = o.margin == null ? 4 : Math.max(0, Math.round(num(o.margin, 4)));
    var dark = o.dark == null ? "#000" : String(o.dark);
    var light = o.light == null ? "#fff" : String(o.light);
    var dim = (m.size + margin * 2) * scale;

    var path = [];
    for (var r = 0; r < m.size; r++) {
      for (var c = 0; c < m.size; c++) {
        if (!m.modules[r][c]) continue;
        path.push("M" + ((c + margin) * scale) + " " + ((r + margin) * scale) + "h" + scale + "v" + scale + "h-" + scale + "z");
      }
    }
    return (
      '<svg xmlns="http://www.w3.org/2000/svg" width="' + dim + '" height="' + dim + '" viewBox="0 0 ' + dim + " " + dim +
      '" shape-rendering="crispEdges" role="img" aria-label="QR">' +
      (light === "transparent" ? "" : '<rect width="' + dim + '" height="' + dim + '" fill="' + escapeAttr(light) + '"/>') +
      '<path fill="' + escapeAttr(dark) + '" d="' + path.join("") + '"/></svg>'
    );
  }

  /* ---- PNG 编码（手写，用于 qrDataUrl；不依赖 canvas，Node 里也能跑） ---- */

  var CRC_TABLE = (function () {
    var table = new Int32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
    return table;
  })();

  function crc32(bytes) {
    var c = 0xffffffff;
    for (var i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  function u32be(v) {
    return [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];
  }

  /** PNG 数据块（长度 + 类型 + 数据 + CRC32，CRC 覆盖类型与数据）。 */
  function pngChunk(type, data) {
    var typeBytes = [type.charCodeAt(0), type.charCodeAt(1), type.charCodeAt(2), type.charCodeAt(3)];
    var body = typeBytes.concat(data);
    return u32be(data.length).concat(body, u32be(crc32(body)));
  }

  /**
   * zlib 容器 + **固定 Huffman（BTYPE=01）DEFLATE**，只做游程匹配。
   * 为什么不用「存储型块」（最省事的那种）：二维码位图是大片同色，存储型的
   * 232×232 图要 ~160KB（base64 后 ~215KB），塞进控制台窗的 <img> 太浪费；
   * 固定 Huffman 码表写死在标准里（RFC 1951 §3.2.6），配上一个「往前找同一像素」
   * 的简单匹配就能把这种图压到几 KB，而仍然**零依赖、零第三方代码**。
   * 不追求最优压缩率：二维码图小、只用来显示，够小就行。
   */
  var LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
  var LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
  var DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
  var DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];

  /** 位写入器：DEFLATE 的位序是**低位在前**（与二维码位流相反，别搞混）。 */
  function DeflateBitWriter() {
    this.bytes = [];
    this.bitBuf = 0;
    this.bitCount = 0;
  }
  DeflateBitWriter.prototype.putBits = function (value, count) {
    for (var i = 0; i < count; i++) {
      this.bitBuf |= ((value >>> i) & 1) << this.bitCount;
      if (++this.bitCount === 8) {
        this.bytes.push(this.bitBuf & 0xff);
        this.bitBuf = 0;
        this.bitCount = 0;
      }
    }
  };
  DeflateBitWriter.prototype.flushByte = function () {
    if (this.bitCount > 0) {
      this.bytes.push(this.bitBuf & 0xff);
      this.bitBuf = 0;
      this.bitCount = 0;
    }
  };

  /** 固定 Huffman 字面/长度码（RFC 1951 §3.2.6）：按 MSB-first 的规范码表发，
   *  但写进流里要翻成 LSB-first，所以这里用「反向后的码字 + 码长」直接下发。 */
  var FIXED_LIT = (function () {
    var table = [];
    for (var s = 0; s <= 287; s++) {
      var code, bits;
      if (s <= 143) { code = 0x30 + s; bits = 8; }
      else if (s <= 255) { code = 0x190 + (s - 144); bits = 9; }
      else if (s <= 279) { code = (s - 256); bits = 7; }
      else { code = 0xc0 + (s - 280); bits = 8; }
      table.push({ code: reverseBits(code, bits), bits: bits });
    }
    return table;
  })();

  function reverseBits(value, count) {
    var out = 0;
    for (var i = 0; i < count; i++) out = (out << 1) | ((value >>> i) & 1);
    return out;
  }

  /** 固定 Huffman deflate：先整体写一个 BTYPE=01 的块，再用「同色游程」做匹配。
   *  QR 位图是 8 像素一格的色块，用「距离=1 的短匹配」就能吃掉大片重复，
   *  所以这里把匹配搜索限制在「向前最多 32KB、长度 3..258」的朴素窗口内。 */
  function deflateFixed(raw) {
    var w = new DeflateBitWriter();
    w.putBits(1, 1); // BFINAL = 1
    w.putBits(1, 2); // BTYPE = 01（固定 Huffman）

    var i = 0;
    var n = raw.length;
    while (i < n) {
      // 朴素匹配：只在「同一字节重复」或「与前一像素相同」时找最长游程（够用且快）
      var bestLen = 0, bestDist = 0;
      var maxLen = Math.min(258, n - i);
      if (maxLen >= 3) {
        var limit = Math.min(i, 32768);
        // 先试距离 1..8 的短距匹配（二维码位图绝大多数重复都在这范围内）
        for (var dist = 1; dist <= 8 && dist <= limit; dist++) {
          var len = 0;
          while (len < maxLen && raw[i + len] === raw[i + len - dist]) len++;
          if (len > bestLen) { bestLen = len; bestDist = dist; }
        }
      }
      if (bestLen >= 3) {
        emitLength(w, bestLen);
        emitDistance(w, bestDist);
        i += bestLen;
      } else {
        w.putBits(FIXED_LIT[raw[i]].code, FIXED_LIT[raw[i]].bits);
        i++;
      }
    }
    // 行尾符号 256
    w.putBits(FIXED_LIT[256].code, FIXED_LIT[256].bits);
    w.flushByte();
    return w.bytes;
  }

  function emitLength(w, len) {
    var idx = 28;
    while (idx > 0 && LEN_BASE[idx] > len) idx--;
    w.putBits(FIXED_LIT[257 + idx].code, FIXED_LIT[257 + idx].bits);
    if (LEN_EXTRA[idx]) w.putBits(len - LEN_BASE[idx], LEN_EXTRA[idx]);
  }

  function emitDistance(w, dist) {
    var idx = 29;
    while (idx > 0 && DIST_BASE[idx] > dist) idx--;
    // 距离码是 5 位固定码（同样要按 LSB-first 下发）
    w.putBits(reverseBits(idx, 5), 5);
    if (DIST_EXTRA[idx]) w.putBits(dist - DIST_BASE[idx], DIST_EXTRA[idx]);
  }

  function zlibDeflate(raw) {
    var body = deflateFixed(raw);
    var out = [0x78, 0x01]; // zlib 头：deflate / 32K 窗口 / 无预设字典
    for (var i = 0; i < body.length; i++) out.push(body[i]);
    // Adler-32 校验
    var a = 1, b = 0;
    for (var j = 0; j < raw.length; j++) {
      a = (a + raw[j]) % 65521;
      b = (b + a) % 65521;
    }
    out.push((b >>> 8) & 0xff, b & 0xff, (a >>> 8) & 0xff, a & 0xff);
    return out;
  }

  function hexToRgb(hex, fallback) {
    var s = String(hex == null ? fallback : hex).trim();
    var m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(s);
    if (!m) return fallback;
    var h = m[1];
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }

  var B64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

  /** base64（手写，避免依赖 btoa/Buffer —— 两处环境各有一个、手写则两边同一份口径）。 */
  function base64Encode(bytes) {
    var out = "";
    for (var i = 0; i < bytes.length; i += 3) {
      var b0 = bytes[i],
        b1 = bytes[i + 1],
        b2 = bytes[i + 2];
      out += B64_ALPHABET[b0 >> 2];
      out += B64_ALPHABET[((b0 & 3) << 4) | ((b1 === undefined ? 0 : b1) >> 4)];
      out += b1 === undefined ? "=" : B64_ALPHABET[((b1 & 15) << 2) | ((b2 === undefined ? 0 : b2) >> 6)];
      out += b2 === undefined ? "=" : B64_ALPHABET[b2 & 63];
    }
    return out;
  }

  /** PNG 字节（RGB、无滤波、每行 filter=0）。 */
  function qrPngBytes(text, opts) {
    var o = opts || {};
    var m = qrMatrix(text, { ecl: o.ecl, version: o.version });
    var scale = Math.max(1, Math.round(num(o.scale, 8)));
    var margin = o.margin == null ? 4 : Math.max(0, Math.round(num(o.margin, 4)));
    var dark = hexToRgb(o.dark, [0, 0, 0]);
    var light = hexToRgb(o.light, [255, 255, 255]);
    var modules = m.size + margin * 2;
    var dim = modules * scale;

    var raw = [];
    for (var y = 0; y < dim; y++) {
      raw.push(0); // 行滤波类型 None
      var row = Math.floor(y / scale) - margin;
      for (var x = 0; x < dim; x++) {
        var col = Math.floor(x / scale) - margin;
        var isDark = row >= 0 && col >= 0 && row < m.size && col < m.size && m.modules[row][col];
        var px = isDark ? dark : light;
        raw.push(px[0], px[1], px[2]);
      }
    }

    var ihdr = u32be(dim).concat(u32be(dim), [8, 2, 0, 0, 0]); // 8 位/通道、颜色类型 2（真彩 RGB）
    var png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    return new Uint8Array(
      png.concat(pngChunk("IHDR", ihdr), pngChunk("IDAT", zlibDeflate(raw)), pngChunk("IEND", [])),
    );
  }

  /** PNG data URL：可直接塞进 <img src>。走自研 PNG 编码（不走 canvas），
   *  于是主进程 Node 里也能拿到同一份字节（例如落一张到数据目录）。 */
  function qrDataUrl(text, opts) {
    return "data:image/png;base64," + base64Encode(qrPngBytes(text, opts));
  }

  var api = {
    qrMatrix: qrMatrix,
    qrSvg: qrSvg,
    qrDataUrl: qrDataUrl,
    qrPngBytes: qrPngBytes,
    ECL_LEVELS: ECL_ORDER.slice(),
    /* 以下是标准算术的**内部构件**，只为「逐位比对官方实现 / 排障」而导出，
     * 不是给业务代码用的 API（业务只用上面四个 + ECL_LEVELS）。留着它们的原因：
     * 这张表的质量史就是一部「掩码错 / 位序错 / 交织错」的排障史 ——
     * 有了这些钩子，下次不一致时能一眼定位到「哪一段算错了」，而不是对着矩阵干瞪眼。 */
    _internals: {
      utf8Bytes: utf8Bytes,
      charCountBits: charCountBits,
      chooseVersion: chooseVersion,
      dataCodewordsFor: dataCodewordsFor,
      eccTotalFor: eccTotalFor,
      splitBlocks: splitBlocks,
      buildDataCodewords: buildDataCodewords,
      interleaveWithEcc: interleaveWithEcc,
      rsEncode: rsEncode,
      formatBits: formatBits,
      versionBits: versionBits,
      maskPenalty: maskPenalty,
      penaltyBreakdown: penaltyBreakdown,
      remainderBits: remainderBits,
      functionModuleCount: functionModuleCount,
      /** 钉死某个掩码取矩阵（跳过罚分选优）：用来分离「掩码选错」与「矩阵铺错」。 */
      matrixWithMask: function (text, ecl, version, mask) {
        return qrMatrix(text, { ecl: ecl, version: version, forceMask: mask });
      },
      /** 连 reserved（功能图形 + 格式信息）一起给：核对「该保留的格子有没有保留」。 */
      matrixWithReserved: function (text, ecl, version, mask) {
        var data = buildDataCodewords(utf8Bytes(text), version, ecl);
        var cw = interleaveWithEcc(data, version, ecl);
        var base = buildBaseMatrix(version);
        placeDataBits(base.modules, base.reserved, cw, version);
        placeFormatBits(base.modules, base.reserved, ecl, mask);
        applyMask(base.modules, base.reserved, mask);
        return { modules: base.modules, reserved: base.reserved, codewords: cw };
      },
    },
  };
  return api;
});
