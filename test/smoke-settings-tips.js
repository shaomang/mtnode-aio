/* test/smoke-settings-tips.js — 设置里的说明文字改成「悬停标题即出」（本轮需求）
 * 运行：node test/smoke-settings-tips.js
 *
 * 钉住三件事：
 *  [1] 机制：界面上没有「?」图标了 —— settingsTip(宿主, 文案) 把文案挂到小节标题 /
 *      字段标签**本身**（data-tip + has-tip 类），提示走 body 级浮层 #setQTip
 *      （fixed 定位：设置正文 .overlay-body 有 overflow-y:auto，伪元素提示会被裁掉）；
 *  [2] 行为：hover / focus 显示并按视口夹紧、离开与滚动收起、指向宿主里的按钮 / 输入框时不弹；
 *  [3] 落地：小节导语与字段口径都已从界面搬进标题提示，语音小节同口径，i18n 有英文词条。
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

let fails = 0;
let checks = 0;
const ok = (cond, msg) => {
  checks++;
  if (cond) console.log("  ok  " + msg);
  else {
    fails++;
    console.log("FAIL  " + msg);
  }
};

/* ── 最小 DOM 影子：够跑 settingsTip / setQTipShow / setQTipHide ── */
function makeDom() {
  const mkEl = (tag) => {
    const el = {
      tagName: String(tag).toUpperCase(),
      children: [],
      childNodes: [],
      attrs: {},
      style: {},
      dataset: {},
      className: "",
      textContent: "",
      hidden: false,
      tabIndex: 0,
      ev: {},
      isConnected: true,
      classList: {
        _s: new Set(),
        add(c) {
          this._s.add(c);
        },
        remove(c) {
          this._s.delete(c);
        },
        contains(c) {
          return this._s.has(c);
        },
      },
      appendChild(c) {
        this.childNodes.push(c);
        this.children.push(c);
        c.parentElement = this;
        return c;
      },
      insertBefore(c, ref) {
        const i = this.childNodes.indexOf(ref);
        this.childNodes.splice(i < 0 ? this.childNodes.length : i, 0, c);
        this.children = this.childNodes;
        c.parentElement = this;
        return c;
      },
      contains(c) {
        if (c === el) return true;
        return el.children.some((x) => x === c || (x.contains && x.contains(c)));
      },
      setAttribute(k, v) {
        this.attrs[k] = String(v);
      },
      getAttribute(k) {
        return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null;
      },
      hasAttribute(k) {
        return Object.prototype.hasOwnProperty.call(this.attrs, k);
      },
      removeAttribute(k) {
        delete this.attrs[k];
      },
      addEventListener(t, f) {
        this.ev[t] = f;
      },
      querySelector() {
        return null;
      },
      getBoundingClientRect() {
        return { left: 600, top: 300, width: 160, height: 18, right: 760, bottom: 318 };
      },
      get offsetWidth() {
        return 320;
      },
      get offsetHeight() {
        return 90;
      },
    };
    return el;
  };
  const doc = {
    createElement: mkEl,
    createTextNode: (t) => ({ nodeType: 3, textContent: t }),
    body: mkEl("body"),
    documentElement: { clientWidth: 1200, clientHeight: 800 },
    addEventListener() {},
  };
  doc.documentElement.appendChild = () => {};
  return { doc, mkEl };
}

const { doc } = makeDom();
const sandbox = {
  document: doc,
  window: { addEventListener() {}, innerWidth: 1200, innerHeight: 800 },
  I18n: { t: (s) => s },
  console,
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(read("renderer/app-settings.js"), sandbox, {
  filename: "renderer/app-settings.js",
});

console.log("\n[1] 机制：说明挂在标题 / 标签本身，「?」图标已移除");
{
  const host = doc.createElement("div");
  const back = sandbox.settingsTip(host, "这是一段很长的设置说明", "测试说明");
  ok(back === host, "settingsTip 返回宿主本身（不再另造节点）");
  ok(
    host.getAttribute("data-tip") === "这是一段很长的设置说明",
    "说明全文进宿主的 data-tip（悬停即出，不占界面）",
  );
  ok(host.getAttribute("data-tip-label") === "测试说明", "无障碍短名进 data-tip-label");
  ok(host.classList.contains("has-tip"), "宿主带上 .has-tip（hover 暗示 + 焦点样式靠它）");
  ok(host.getAttribute("aria-describedby") === "setQTip", "宿主 aria-describedby 指向浮层（读屏可达）");
  ok(host.getAttribute("tabindex") === "0", "不可聚焦的标题补 tabindex=0（键盘 focus 也能出提示）");
  ok(host.textContent === "", "宿主正文没有被塞进「?」之类的字符（界面上什么都没有）");

  const src = read("renderer/app-settings.js");
  const voice = read("renderer/app-voice.js");
  ok(src.indexOf('className = "set-q"') < 0, "设置里不再造 .set-q 图标");
  ok(src.indexOf('textContent = "?"') < 0, "设置里不再写一个「?」字符");
  ok(voice.indexOf('"set-q"') < 0, "语音小节也不再造「?」图标");

  const css = read("renderer/css/components.css");
  ok(!/\.set-q\s*\{/.test(css), "旧 .set-q 图标样式已删");
  ok(/\.has-tip\s*\{[\s\S]{0,200}?cursor:\s*help/.test(css), ".has-tip 给 help 光标（提示这里能看说明）");
  ok(/\.has-tip:hover\s*\{[\s\S]{0,200}?underline dotted/.test(css), "hover 时虚线下划线（轻量暗示，不占版面）");
  ok(/\.set-tip-pop\s*\{[\s\S]{0,800}?max-width:\s*400px/.test(css), "提示浮层限宽 400px（共识 320–420px）");
  ok(/\.set-tip-pop\s*\{[\s\S]{0,400}?position:\s*fixed/.test(css), "浮层 position:fixed（不受滚动容器裁剪）");
  ok(/\.set-tip-pop\s*\{[\s\S]{0,600}?white-space:\s*normal/.test(css), "浮层自动换行、显示全文");
}

console.log("\n[2] 行为：显示 / 夹紧 / 收起 / 指向控件时不弹");
{
  const h = doc.createElement("div");
  sandbox.settingsTip(h, "第三段说明", "测试说明");
  h.ev.mouseover({ target: h });
  const layer = doc.body.children.find((c) => c && c.className === "set-tip-pop");
  ok(!!layer, "mouseover 后在 body 上建出 #setQTip 浮层（body 级：不被 .overlay-body 裁掉）");
  ok(!!layer && layer.hidden === false, "悬停标题后浮层可见");
  ok(!!layer && layer.textContent === "第三段说明", "浮层正文 = 该标题的说明全文");
  const left = layer ? parseFloat(layer.style.left) : NaN;
  const top = layer ? parseFloat(layer.style.top) : NaN;
  ok(left >= 8 && left <= 1200 - 320 - 8, "横向按视口夹紧（left = " + left + "）");
  ok(top >= 8 && top <= 800 - 8, "纵向不出视口（top = " + top + "）");
  h.ev.mouseout({ relatedTarget: null });
  ok(!!layer && layer.hidden === true, "移开鼠标即收起");
  h.ev.focusin({ target: h });
  ok(!!layer && layer.hidden === false, "键盘 focus 同样出提示");
  h.ev.focusout({ target: h });
  ok(!!layer && layer.hidden === true, "失焦收起");

  /* 宿主里的真控件不弹提示：悬停按钮 / 往输入框打字时不冒说明 */
  const inp = doc.createElement("input");
  inp.setAttribute("type", "text");
  h.ev.mouseover({ target: inp });
  ok(!!layer && layer.hidden === true, "悬停宿主里的输入框不弹提示（打字时别挡路）");
  const btn = doc.createElement("button");
  h.ev.mouseover({ target: btn });
  ok(!!layer && layer.hidden === true, "悬停宿主里的按钮不弹提示（按钮有自己的 tooltip）");
  const cb = doc.createElement("input");
  cb.setAttribute("type", "checkbox");
  h.ev.mouseover({ target: cb });
  ok(!!layer && layer.hidden === false, "悬停勾选框仍出提示（它没有输入内容，说明正该看）");

  const src = read("renderer/app-settings.js");
  ok(
    /window\.addEventListener\("scroll", setQTipHide, true\)/.test(src),
    "滚动时收提示（浮层是 fixed，不跟着滚会飘错位置）",
  );
  ok(
    /document\.addEventListener\("pointerdown", setQTipHide, true\)/.test(src),
    "点到别处收提示（关设置窗也不留残影）",
  );
  sandbox.setQTipHide();
}

console.log("\n[3] 落地：说明不再平铺，全部挂进标题 / 标签的悬停提示");
{
  const settings = read("renderer/app-settings.js");
  const voice = read("renderer/app-voice.js");
  const i18n = read("renderer/i18n.js");

  ok(
    /function settingsTipBeside\(anchor, text, label\)/.test(settings),
    "有 settingsTipBeside（旧调用名保留，行为 = 挂到标题 / 标签本身）",
  );
  ok(
    settings.indexOf("anchor.appendChild(q)") < 0 &&
      settings.indexOf("anchor.insertBefore(q, ctrl)") < 0,
    "不再往标题里插「?」节点（旧实现已删干净）",
  );

  /* 三段小节导语（存储占用 / 错误与崩溃日志 / 手动更新）——原先各是一整段灰字 */
  const introKeys = [
    "统计数据目录里各类冗余的占用",
    "应用内部错误与崩溃会自动写入本地诊断日志",
    "普通更新只在线上版本号更高时才可用",
  ];
  for (const k of introKeys) {
    const i = settings.indexOf(k);
    const near = i >= 0 ? settings.slice(Math.max(0, i - 400), i) : "";
    ok(
      i >= 0 && /settingsTipBeside\(\s*secTitle/.test(near),
      "小节导语挂在标题本身（悬停标题才出）：" + k.slice(0, 12) + "…",
    );
  }
  ok(
    settings.indexOf('hint.className = "n-field"') < 0,
    "设置里不再有「整段 n-field 说明块」的写法",
  );

  /* 字段级说明 */
  const fieldKeys = [
    ["价目由云端随账号下发", "价目口径"],
    ["留空 = 不限制；支持 * 与 ? 通配", "白名单通配"],
    ["三档都是毫秒，缺省 300000", "三档超时"],
    ["徽标 = 模型类型（点一下可改）", "模型类型徽标"],
    ["停用后不出现在模型选择器里", "停用说明"],
    ["把服务商配置文字粘贴到下方", "粘贴导入"],
    ["MTNode 目录填 catalog.json 即可", "在线源"],
    ["已从服务商接口读取到可用模型", "获取模型列表"],
    ["可直接用于 Codex 等 OpenAI 兼容客户端", "中转 Key 用法"],
  ];
  for (const [k, label] of fieldKeys) {
    ok(settings.indexOf(k) >= 0, "字段口径仍在（挂进悬停提示）：" + label);
  }
  ok(
    settings.indexOf('policyHint.textContent') < 0 &&
      settings.indexOf('tmoHint.textContent') < 0 &&
      settings.indexOf('kindNote.textContent') < 0,
    "三处字段说明的「平铺灰字」写法已删干净（policyHint / tmoHint / kindNote）",
  );
  /* 完成音效音量：括注挂在右侧百分比读数上（那一行没有文字标题） */
  ok(
    /settingsTip\(\s*sndVolLabel/.test(settings),
    "完成音效音量的括注挂在百分比读数上（悬停「35%」即出）",
  );

  /* 语音输入小节 */
  ok(voice.indexOf("function settingsSection()") >= 0, "语音小节仍在");
  ok(
    /const tip = \(host, text, label\) => \{[\s\S]{0,240}?settingsTip\(host, text, label\)/.test(voice),
    "语音小节的说明复用 settingsTip（同机制：挂到标题 / 标签本身）",
  );
  ok(
    /if \(tipText\) tip\(l, tipText, tipLabel\)/.test(voice),
    "语音小节的字段说明挂在该行标签上（不是另造图标）",
  );
  ok(
    voice.indexOf('segHint.textContent') < 0 && voice.indexOf('hint.className = "settings-hint"') < 0,
    "语音小节两段长说明已从界面搬走（话筒用法 / 分段口径）",
  );
  ok(
    voice.indexOf("当前默认文本模型：") >= 0,
    "「当前默认文本模型」回显仍常显（共识：回显不藏）",
  );

  /* 常显项没有被误搬走 */
  for (const k of [
    "正在统计存储占用…",
    "还没有取到中转 Key：请先登录 MTNode 账号（登录后会自动拉取）",
    "账号当前没有可用模型：充值后会自动刷新",
    "暂无模型，请在下方添加",
  ]) {
    ok(settings.indexOf(k) >= 0, "状态 / 引导 / 空态仍常显：" + k.slice(0, 12) + "…");
  }

  /* i18n：说明短名 / 可见标签必须有非空英文译文 */
  const EN_KEYS = [
    "节点「?」说明按钮",
    "粘贴剪贴板图像时先询问",
    "子代理嵌套深度",
    "允许子代理委派",
    "允许后台并行委派",
    "允许 fork 型子代理",
    "节点完成后自动执行下游",
    "提问/审批提示音",
    "精简工具负载",
    "开发者工具",
    "工作步骤展示",
    "任务完成音效",
    "存储占用与清理说明",
    "语音输入说明",
    "完成音效音量说明",
  ];
  const enBlock = (() => {
    const s = i18n.indexOf("var EN = {");
    const e = i18n.indexOf("\n      };", s);
    return s >= 0 && e > s ? i18n.slice(s, e) : i18n;
  })();
  for (const k of EN_KEYS) {
    const i = enBlock.indexOf('"' + k + '":');
    const after = i >= 0 ? enBlock.slice(i + k.length + 3) : "";
    const m = /^\s*"((?:[^"\\]|\\.)*)"/.exec(after);
    ok(i >= 0 && m && m[1] && !/[\u4e00-\u9fff]/.test(m[1]), "词条有英文译文：" + k);
  }
}

console.log("\n" + (fails ? "✗ " + fails + " / " + checks + " 项失败" : "✓ 全部 " + checks + " 项通过"));
process.exitCode = fails ? 1 : 0;
