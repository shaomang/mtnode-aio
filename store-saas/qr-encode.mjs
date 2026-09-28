"use strict";
/**
 * MTNode 创意工坊 — 零依赖 QR Code 编码器（仅 node:Buffer）。
 *
 * 为什么自己写：`store-saas` 全链路零依赖（见 account-store.mjs / sms-provider.mjs 的口径），
 * 支付宝当面付只回一个 `qr_code` 字符串（如 `https://qr.alipay.com/bax…`），必须自己画成
 * 可扫的二维码；引 npm 依赖会给服务端加上运行时安装步骤，得不偿失。
 *
 * 覆盖范围（够用即止，刻意不做全版本）：
 *   · 编码模式：Byte（0100），按 UTF-8 取字节 —— 支付宝 / 微信的付款串都是 ASCII URL。
 *   · 纠错等级：M（约 15% 恢复能力，付款码在屏幕上扫描，M 是通用默认）。
 *   · 版本：1–10（M 级数据容量 16…216 码字，即最长 213 字节的 URL）。
 *     超出容量直接抛错，不做静默降级 —— 付款串超长属于上游配置错误，必须显式失败。
 *
 * 实现依据 ISO/IEC 18004：Reed-Solomon（GF(2^8)，生成多项式根 α^0…α^(n-1)）、
 * 块内交织、功能图形（定位/分隔/定时/校正/暗模块）、格式信息 BCH(15,5) ^ 0x5412、
 * 版本信息 BCH(18,6)（v≥7）、8 种掩码与 4 条罚分规则。
 *
 * 出口：
 *   qrEncode(text, opts)     -> { version, size, mask, modules }  modules 为 Uint8Array(size*size)，1 = 深色
 *   qrSvg(text, opts)        -> "<svg …>" 字符串（含 4 模块静区，行游程合并成 rect）
 *   qrDataUrl(text, opts)    -> "data:image/svg+xml;base64,…"（客户端 / 管理页直接塞 <img src>）
 */

/* ========================================================================== *
 * 版本表（纠错等级 M）
 *   total   = 该版本总码字数（数据 + 纠错）
 *   data    = 数据码字总数
 *   blocks  = 各块的数据码字数（块数 = 数组长度；每块纠错码字数相同 = (total-data)/块数）
 *   align   = 校正图形中心坐标表（空 = 无校正图形）
 *   remBits = 交织后需补的 0 位数（v1 = 0，v2–6 = 7，v7–13 = 0）
 * ========================================================================== */
const VERSIONS_M = [
  null, // 版本从 1 开始，占位
  { total: 26, data: 16, blocks: [16], align: [], remBits: 0 },
  { total: 44, data: 28, blocks: [28], align: [6, 18], remBits: 7 },
  { total: 70, data: 44, blocks: [44], align: [6, 22], remBits: 7 },
  { total: 100, data: 64, blocks: [32, 32], align: [6, 26], remBits: 7 },
  { total: 134, data: 86, blocks: [43, 43], align: [6, 30], remBits: 7 },
  { total: 172, data: 108, blocks: [27, 27, 27, 27], align: [6, 34], remBits: 7 },
  { total: 196, data: 124, blocks: [31, 31, 31, 31], align: [6, 22, 38], remBits: 0 },
  { total: 242, data: 154, blocks: [38, 38, 39, 39], align: [6, 24, 42], remBits: 0 },
  { total: 292, data: 182, blocks: [36, 36, 36, 37, 37], align: [6, 26, 46], remBits: 0 },
  { total: 346, data: 216, blocks: [43, 43, 43, 43, 44], align: [6, 28, 50], remBits: 0 },
];

const MAX_VERSION = VERSIONS_M.length - 1;
const QUIET_ZONE = 4; // 规范要求的静区模块数
const PENALTY_N1 = 3;
const PENALTY_N2 = 3;
const PENALTY_N3 = 40;
const PENALTY_N4 = 10;

/* ========================================================================== *
 * GF(2^8) 运算（本原多项式 0x11D）
 * ========================================================================== */
const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
(function initGalois() {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
})();

function gfMul(a, b) {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

function polyMul(a, b) {
  const out = new Array(a.length + b.length - 1).fill(0);
  for (let i = 0; i < a.length; i++) {
    for (let j = 0; j < b.length; j++) out[i + j] ^= gfMul(a[i], b[j]);
  }
  return out;
}

/** 生成多项式 g(x) = Π (x + α^i)，i = 0…degree-1；系数高位在前，首项恒为 1。 */
function rsGeneratorPoly(degree) {
  let g = [1];
  for (let i = 0; i < degree; i++) g = polyMul(g, [1, GF_EXP[i]]);
  return g;
}

/** Reed-Solomon 余式（= 纠错码字）：LFSR 长除法，返回 eccLen 个字节。 */
function rsRemainder(data, eccLen) {
  const gen = rsGeneratorPoly(eccLen);
  const res = new Array(eccLen).fill(0);
  for (let i = 0; i < data.length; i++) {
    const factor = (data[i] ^ res[0]) & 0xff;
    res.shift();
    res.push(0);
    for (let j = 0; j < eccLen; j++) res[j] = (res[j] ^ gfMul(gen[j + 1], factor)) & 0xff;
  }
  return res;
}

/* ========================================================================== *
 * 位流 → 码字
 * ========================================================================== */

function bitWriter() {
  const bits = [];
  return {
    append(value, len) {
      for (let i = len - 1; i >= 0; i--) bits.push((value >>> i) & 1);
    },
    appendBytes(buf) {
      for (let i = 0; i < buf.length; i++) this.append(buf[i], 8);
    },
    get length() {
      return bits.length;
    },
    toCodewords(totalDataCw) {
      // 终止符（最多 4 个 0）→ 补零到字节边界 → 交替填充 0xEC / 0x11
      const capBits = totalDataCw * 8;
      const term = Math.min(4, capBits - bits.length);
      for (let i = 0; i < term; i++) bits.push(0);
      while (bits.length % 8 !== 0) bits.push(0);
      const out = [];
      for (let i = 0; i < bits.length; i += 8) {
        let b = 0;
        for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j];
        out.push(b);
      }
      let pad = 0xec;
      while (out.length < totalDataCw) {
        out.push(pad);
        pad = pad === 0xec ? 0x11 : 0xec;
      }
      return out;
    },
  };
}

/** 选版本：Byte 模式下能装下 len 字节的最小版本（M 级），装不下抛错。 */
function pickVersion(byteLen) {
  for (let v = 1; v <= MAX_VERSION; v++) {
    const countBits = v <= 9 ? 8 : 16;
    if (4 + countBits + byteLen * 8 <= VERSIONS_M[v].data * 8) return v;
  }
  throw new Error("qr: 内容超出 QR 版本 1-" + MAX_VERSION + "（M 级）容量：" + byteLen + " 字节");
}

/** 数据码字 → 分块纠错 → 交织（含版本余位）。 */
function interleave(dataCw, version) {
  const spec = VERSIONS_M[version];
  const blocks = spec.blocks;
  const eccLen = (spec.total - spec.data) / blocks.length;
  const dataBlocks = [];
  const eccBlocks = [];
  let off = 0;
  for (let i = 0; i < blocks.length; i++) {
    const d = dataCw.slice(off, off + blocks[i]);
    off += blocks[i];
    dataBlocks.push(d);
    eccBlocks.push(rsRemainder(d, eccLen));
  }
  const out = [];
  const maxData = Math.max(...blocks);
  for (let i = 0; i < maxData; i++) {
    for (let b = 0; b < dataBlocks.length; b++) {
      if (i < dataBlocks[b].length) out.push(dataBlocks[b][i]);
    }
  }
  for (let i = 0; i < eccLen; i++) {
    for (let b = 0; b < eccBlocks.length; b++) out.push(eccBlocks[b][i]);
  }
  // 余位：按 bit 展开成 0/1 序列（后面逐位摆放时消费）
  const bits = [];
  for (const cw of out) for (let i = 7; i >= 0; i--) bits.push((cw >>> i) & 1);
  for (let i = 0; i < spec.remBits; i++) bits.push(0);
  return bits;
}

/* ========================================================================== *
 * 矩阵搭建
 * ========================================================================== */

function makeMatrix(version) {
  const size = version * 4 + 17;
  return {
    size,
    mod: new Uint8Array(size * size), // 0 = 浅色，1 = 深色
    fn: new Uint8Array(size * size), // 1 = 功能图形（不参与掩码 / 不摆数据）
    get(x, y) {
      return this.mod[y * size + x];
    },
    set(x, y, dark) {
      this.mod[y * size + x] = dark ? 1 : 0;
    },
    setFn(x, y, dark) {
      this.mod[y * size + x] = dark ? 1 : 0;
      this.fn[y * size + x] = 1;
    },
    isFn(x, y) {
      return this.fn[y * size + x] === 1;
    },
  };
}

/** 定位图形 + 分隔符：以 (cx,cy) 为中心画 9×9（距离 2 / 4 为浅色，其余深色）。 */
function drawFinder(m, cx, cy) {
  for (let dy = -4; dy <= 4; dy++) {
    for (let dx = -4; dx <= 4; dx++) {
      const x = cx + dx;
      const y = cy + dy;
      if (x < 0 || y < 0 || x >= m.size || y >= m.size) continue;
      const dist = Math.max(Math.abs(dx), Math.abs(dy));
      m.setFn(x, y, dist !== 2 && dist !== 4);
    }
  }
}

/** 校正图形：5×5，最外圈与中心深色，第二圈浅色。 */
function drawAlignment(m, cx, cy) {
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      m.setFn(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
  }
}

function drawFunctionPatterns(m, version) {
  const size = m.size;
  // 定时图形（行 6 / 列 6，交替深浅）
  for (let i = 0; i < size; i++) {
    m.setFn(6, i, i % 2 === 0);
    m.setFn(i, 6, i % 2 === 0);
  }
  drawFinder(m, 3, 3);
  drawFinder(m, size - 4, 3);
  drawFinder(m, 3, size - 4);
  // 校正图形：坐标两两组合，跳过与三个定位图形重叠的角
  const coords = VERSIONS_M[version].align;
  if (coords.length) {
    const last = coords.length - 1;
    for (let i = 0; i <= last; i++) {
      for (let j = 0; j <= last; j++) {
        if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) continue;
        drawAlignment(m, coords[j], coords[i]);
      }
    }
  }
  // 格式信息与版本信息区先占位（掩码定下后再写真值）
  drawFormatBits(m, 0);
  if (version >= 7) drawVersionBits(m, version);
}

function getBit(x, i) {
  return ((x >>> i) & 1) !== 0;
}

/** 格式信息：5 位数据（2 位纠错等级 + 3 位掩码）→ BCH(15,5) → ^ 0x5412，写两份。 */
function drawFormatBits(m, mask) {
  const size = m.size;
  const ECC_FORMAT_BITS = 0; // M 级 = 00（L=01, Q=11, H=10）
  const data = (ECC_FORMAT_BITS << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  const bits = ((data << 10) | rem) ^ 0x5412; // 15 位

  // 第一份：左上（列 8 竖排 + 行 8 横排，跳过定时图形所在格）
  for (let i = 0; i <= 5; i++) m.setFn(8, i, getBit(bits, i));
  m.setFn(8, 7, getBit(bits, 6));
  m.setFn(8, 8, getBit(bits, 7));
  m.setFn(7, 8, getBit(bits, 8));
  for (let i = 9; i < 15; i++) m.setFn(14 - i, 8, getBit(bits, i));

  // 第二份：右上横排 + 左下竖排
  for (let i = 0; i < 8; i++) m.setFn(size - 1 - i, 8, getBit(bits, i));
  for (let i = 8; i < 15; i++) m.setFn(8, size - 15 + i, getBit(bits, i));

  // 暗模块（恒为深色）
  m.setFn(8, size - 8, true);
}

/** 版本信息（v≥7）：18 位 BCH，写在右上与左下两块 3×6 区域。 */
function drawVersionBits(m, version) {
  const size = m.size;
  let rem = version;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  const bits = (version << 12) | rem;
  for (let i = 0; i < 18; i++) {
    const bit = getBit(bits, i);
    const a = size - 11 + (i % 3);
    const b = Math.floor(i / 3);
    m.setFn(a, b, bit);
    m.setFn(b, a, bit);
  }
}

/** 数据位按「两列一组、自下而上/自上而下交替」的之字形摆放，跳过功能图形。 */
function drawCodewords(m, bits) {
  const size = m.size;
  let i = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5; // 跳过竖直定时图形列
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (m.isFn(x, y) || i >= bits.length) continue;
        m.set(x, y, bits[i] === 1);
        i++;
      }
    }
  }
}

function maskInvert(mask, x, y) {
  switch (mask) {
    case 0:
      return (x + y) % 2 === 0;
    case 1:
      return y % 2 === 0;
    case 2:
      return x % 3 === 0;
    case 3:
      return (x + y) % 3 === 0;
    case 4:
      return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
    case 5:
      return ((x * y) % 2) + ((x * y) % 3) === 0;
    case 6:
      return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
    default:
      return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
  }
}

function applyMask(m, mask) {
  for (let y = 0; y < m.size; y++) {
    for (let x = 0; x < m.size; x++) {
      if (m.isFn(x, y)) continue;
      if (maskInvert(mask, x, y)) m.set(x, y, m.get(x, y) === 0);
    }
  }
}

/* ---------- 罚分（规范四条规则） ----------
 * 规则 1：同色游程 ≥5 → N1 + (游程长 - 5)，行列各算。
 * 规则 2：2×2 同色块 → 每块 N2。
 * 规则 3：11 位滑窗命中 10111010000(0x5D0) / 00001011101(0x05D) → 每处 N3
 *         （规范字面口径：1:1:3:1:1 深-浅模式且一侧有 4 个浅色模块）。
 * 规则 4：深色占比偏离 50%，每偏 5% 记 N4（k = |ceil(pct/5) - 10|）。
 * 掩码只影响观感与稳健度，不影响可解码性（格式信息里记着实际用的掩码）；
 * 这里取「罚分最低、并列取编号小者」，与主流实现一致。 */

function penaltyScore(m) {
  const size = m.size;
  let result = 0;

  // 规则 1：逐行
  for (let y = 0; y < size; y++) {
    let run = 1;
    for (let x = 1; x < size; x++) {
      if (m.get(x, y) === m.get(x - 1, y)) run++;
      else {
        if (run >= 5) result += PENALTY_N1 + (run - 5);
        run = 1;
      }
    }
    if (run >= 5) result += PENALTY_N1 + (run - 5);
  }
  // 规则 1：逐列
  for (let x = 0; x < size; x++) {
    let run = 1;
    for (let y = 1; y < size; y++) {
      if (m.get(x, y) === m.get(x, y - 1)) run++;
      else {
        if (run >= 5) result += PENALTY_N1 + (run - 5);
        run = 1;
      }
    }
    if (run >= 5) result += PENALTY_N1 + (run - 5);
  }

  // 规则 2：2×2 同色块
  for (let y = 0; y < size - 1; y++) {
    for (let x = 0; x < size - 1; x++) {
      const c = m.get(x, y);
      if (c === m.get(x + 1, y) && c === m.get(x, y + 1) && c === m.get(x + 1, y + 1)) {
        result += PENALTY_N2;
      }
    }
  }

  // 规则 3：11 位滑窗（行与列各扫一遍）
  for (let y = 0; y < size; y++) {
    let bitsRow = 0;
    let bitsCol = 0;
    for (let x = 0; x < size; x++) {
      bitsRow = ((bitsRow << 1) & 0x7ff) | m.get(x, y); // 第 y 行：从左到右
      if (x >= 10 && (bitsRow === 0x5d0 || bitsRow === 0x05d)) result += PENALTY_N3;
      bitsCol = ((bitsCol << 1) & 0x7ff) | m.get(y, x); // 第 y 列：从上到下
      if (x >= 10 && (bitsCol === 0x5d0 || bitsCol === 0x05d)) result += PENALTY_N3;
    }
  }

  // 规则 4：深色占比
  let dark = 0;
  for (let i = 0; i < m.mod.length; i++) if (m.mod[i]) dark++;
  const pct = (dark * 100) / (size * size);
  result += Math.abs(Math.ceil(pct / 5) - 10) * PENALTY_N4;

  return result;
}

/* ========================================================================== *
 * 对外出口
 * ========================================================================== */

/**
 * 编码文本为 QR 矩阵。
 * @param {string} text
 * @param {{margin?:number, mask?:number}} [opts] margin 只影响 SVG；mask（0–7）= 强制掩码，
 *        缺省按罚分最低自动选（并列取编号小者）。强制掩码只用于测试 / 对照。
 * @returns {{version:number,size:number,mask:number,modules:Uint8Array}}
 */
export function qrEncode(text, opts) {
  const bytes = Buffer.from(String(text == null ? "" : text), "utf8");
  if (!bytes.length) throw new Error("qr: 内容为空");
  const version = pickVersion(bytes.length);
  const spec = VERSIONS_M[version];

  const w = bitWriter();
  w.append(0b0100, 4); // Byte 模式
  w.append(bytes.length, version <= 9 ? 8 : 16); // 字符计数指示
  w.appendBytes(bytes);
  const dataCw = w.toCodewords(spec.data);
  const bits = interleave(dataCw, version);

  const build = (mask) => {
    const m = makeMatrix(version);
    drawFunctionPatterns(m, version);
    drawCodewords(m, bits);
    applyMask(m, mask);
    drawFormatBits(m, mask);
    return m;
  };

  const forced = opts && Number.isInteger(opts.mask) ? opts.mask : -1;
  if (forced >= 0 && forced <= 7) {
    const m = build(forced);
    return { version, size: m.size, mask: forced, modules: m.mod };
  }

  // 8 种掩码各试一遍，取罚分最低（并列取编号小者，与主流实现一致）
  let best = null;
  for (let mask = 0; mask < 8; mask++) {
    const m = build(mask);
    const score = penaltyScore(m);
    if (!best || score < best.score) best = { mask, score, m };
  }
  return { version, size: best.m.size, mask: best.mask, modules: best.m.mod };
}

/** 罚分（规则 1–4 之和）：暴露给测试用，可对任意矩阵复算。 */
export function qrPenaltyScore(modules, size) {
  return penaltyScore({
    size,
    mod: modules,
    get(x, y) {
      return modules[y * size + x];
    },
  });
}

/**
 * 输出 SVG 字符串（含静区）。深色模块按行游程合并成 rect，体积小、缩放不糊。
 * @param {string} text
 * @param {{margin?:number, dark?:string, light?:string, title?:string}} [opts]
 */
export function qrSvg(text, opts) {
  const o = opts || {};
  const { size, modules } = qrEncode(text, o);
  const margin = Number.isFinite(o.margin) ? Math.max(0, Math.floor(o.margin)) : QUIET_ZONE;
  const dark = o.dark || "#000000";
  const light = o.light || "#ffffff";
  const total = size + margin * 2;
  const parts = [];
  for (let y = 0; y < size; y++) {
    let x = 0;
    while (x < size) {
      if (!modules[y * size + x]) {
        x++;
        continue;
      }
      let run = 1;
      while (x + run < size && modules[y * size + (x + run)]) run++;
      parts.push(
        "M" + (x + margin) + " " + (y + margin) + "h" + run + "v1h-" + run + "z",
      );
      x += run;
    }
  }
  const title = o.title ? "<title>" + escapeXml(String(o.title)) + "</title>" : "";
  return (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + total + " " + total +
    '" width="' + total + '" height="' + total + '" shape-rendering="crispEdges" role="img">' +
    title +
    '<rect width="' + total + '" height="' + total + '" fill="' + light + '"/>' +
    '<path d="' + parts.join("") + '" fill="' + dark + '"/>' +
    "</svg>"
  );
}

/** 输出可直接塞 <img src> 的 data URL（base64，免客户端再做 URI 转义）。 */
export function qrDataUrl(text, opts) {
  const svg = qrSvg(text, opts);
  return "data:image/svg+xml;base64," + Buffer.from(svg, "utf8").toString("base64");
}

function escapeXml(s) {
  return String(s).replace(/[<>&"']/g, (c) => ({
    "<": "&lt;",
    ">": "&gt;",
    "&": "&amp;",
    '"': "&quot;",
    "'": "&apos;",
  }[c]));
}

export default { qrEncode, qrSvg, qrDataUrl, qrPenaltyScore };
