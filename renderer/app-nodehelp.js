"use strict";
/* renderer/app-nodehelp.js — 节点「?」说明按钮（自包含模块，window 暴露）
 * ============================================================================
 * 需求：
 *   · 每个节点头部都有一个方形「?」按钮（放在 ✕ 删除键左边，位置固定、最好找）。
 *   · 点击打开一个 tooltip 小窗，用**最简单的语言**讲清这个节点是干什么的；
 *     鼠标移开（按钮与小窗都离开）1 秒后自动消失，回到按钮上可取消这次关闭。
 *   · 该按钮可在「设置」里隐藏，默认打开（S.config.showNodeHelp !== false）。
 *
 * 约定：
 *   · 本模块不参与持久化面板体系（不是带输入的对话框，按瞬态 tooltip 处理）：
 *     点画布空白处 / Esc / 平移缩放（repositionNodePops 调用点）都会直接收掉。
 *   · 说明文案走 I18n.t（中文原文 → renderer/i18n.js 的 EN 词典），本文件不存英文。
 *   · 脚本排在 app-canvas.js 之后：头部按钮在 renderCanvas 里按调用期取它。
 * ============================================================================
 */
(function () {
  const HIDE_DELAY_MS = 1000; /* 鼠标移开 1 秒后消失 */

  /* ── 说明文案（最简单的话）──────────────────────────────────────────────
     键 = 节点 kind；带变体的（智能文本 / 工具节点 / 开发节点 / 数据库副本 /
     控制三态）在 nodeHelpText 里先行判定。 */
  const KIND_HELP = {
    input_text: "写文字的地方：在这里打字或粘贴，内容会顺着连线传给后面的节点。",
    input_image: "放图片的地方：选一张本机图片或拖进来，供后面的节点当参考图。",
    input_audio: "放音频的地方：选一个本机音频文件，把它交给后面做声音的节点。",
    input_video: "放视频的地方：选一个本机视频文件，把它交给后面做视频的节点。",
    input_any: "文件节点：上传任意文件，按类型自动转成对应的输入节点。",
    input_file: "文件节点：一次导入多个文件，当成一批内容交给后面的节点。",
    deliver:
      "交付节点：长周期任务要你交东西时的落点，每个待交文件 = 一个输入端子（连入或点「⬆ 上传」即算已交），交齐还要到条带点「确认交付完成」。",
    ltout: "产出节点：长周期任务跑出来的信息与文件写在这里，你可以直接改，后续环节用改后的内容。",
    ltart:
      "产物节点：长任务把每件关键产物（图片缩略图 / 文本摘要）摆到这里，点 ⇢ 用系统程序打开、点 📁 打开所在文件夹。",
    asset: "素材节点：把素材库里存好的内容取出来用，一条内容 = 一个端口。",
    db_table: "数据表：读一个表格文件，或让智能体帮你建一张表。",
    proc_text: "让 AI 处理文字：把要求写进提示词，点 ▶ 得到结果。",
    proc_image: "让 AI 画图：把想要的画面写成提示词，点 ▶ 生成一张图。",
    sensenova_gen: "本机 AI 画图：点 ▶ 用本机 SenseNova 生成图片（不联网），连一张图进去就是图像编辑。",
    music_gen: "生成音乐：写风格提示词（可加歌词），点 ▶ 得到一段音乐。",
    video_gen: "生成视频：用文字或图片描述画面，点 ▶ 得到一段视频。",
    tts_gen: "文字转语音：点 ▶ 把文字读成一段配音。",
    breeze_gen:
      "Breeze 语音：用 Breeze TTS 2 读出文字（音色可克隆 / 设计 / 导演）。卡片上有「输入文本（需要念的）」与「参考文本（参考音频对应的文字）」两个文本框：端口接了输入就只读回显，端口空着就可以直接在这里写。",
    remotion: "动效视频：用代码模板渲染出一段 mp4。",
    net_recv: "收网络消息：守住一个通道，收到文字就往后传。",
    net_send: "发网络消息：把文字发到这个通道的另一端。",
    execute: "启动程序：点一下，就打开这个节点绑定的程序。",
    function: "小计算器：写一小段 JS 做计算，输入进去、结果出来。",
    save: "保存结果：把上一步存成文件，文字存 .md，图片 / 声音 / 视频存对应格式。",
    save_pdf: "生成 PDF：把上一步的文字排成一份 PDF（标题、表格、列表、公式都会排版）。",
    save_text: "保存结果：把上一步的内容存成 .md 文件。",
    save_image: "保存图片：把上一步生成的图片存成图片文件。",
    split: "取出其中一项：从一整批内容里单独挑出一条，方便逐条处理。",
    merge: "合成一批：把多个节点的结果合成一整批，供后面按批处理。",
    agent_task: "让 AI 自己干活：它能读文件、上网、执行命令，独立把这件事做完。",
    task: "任务：把复杂的事拆成小步骤按顺序做完，成功或失败都有终点。",
    super: "收纳盒：把一堆节点装进一个壳里，展开看里面，收起让画布清爽。",
    wait_file: "等文件：等到指定文件出现才往下走。",
    timer: "定时器：到点或每隔一段时间自动触发一次。",
    delayer: "等一会儿：先等几秒再往下走。",
    sequencer: "按顺序：把一次触发放成好几路，一个接一个依次发出。",
    gate: "凑齐才走：所有上一环都到了才放行。",
    splitter: "分发：把一次触发同时发给好几路。",
    counter: "数数：每来 N 次才放行一次。",
    mutex: "排队：多路同时进来时只放一路过去，避免几件事撞在一起。",
    judge: "判断：按条件选「是」或「否」两条路走。",
    global: "全局节点：把内容广播给需要它的节点，用 @ 标题 引用。",
    control: "控制按钮：点一下就跑这一串流程（起点 / 成功 / 失败三种）。",
    db_replica: "数据库副本：里面是这台机器上存好的真实资料，智能体能查。",
  };

  const HELP_CONTROL = {
    start: "开始按钮 ▶：点它就从这里往下跑整条流程。",
    endSuccess: "成功终点：流程顺利走到这里就算成功结束。",
    endFail: "失败终点：流程走不通时会到这里，算失败结束。",
  };

  /* 兜底：kind 不在表里也用最简单的说法讲清「节点是什么」 */
  const HELP_FALLBACK = "画布上的一个节点：把上游内容按它的规则处理后交给下游。";

  function nodeHelpText(node) {
    if (!node) return "";
    if (node.kind === "proc_text" && node.agent)
      return I18n.t("让 AI 自己干活：还能读文件、上网、执行命令，把这件事做完。");
    if (typeof isToolNode === "function" && isToolNode(node))
      return I18n.t("工具节点：一个能重复使用的小工具，参数就是它的接口，智能体也能调用。");
    if (node.kind === "super" && node.db)
      return I18n.t("数据库副本：这台机器上存好的真实资料放在这里，可以查、可以算。");
    if (node.kind === "super" && node.dev)
      return I18n.t("开发节点：代表项目里的一个功能块，展开能看到里面的结构和代码文件。");
    if (node.kind === "control") {
      const t = HELP_CONTROL[node.ctrlRole || ""];
      return I18n.t(t || KIND_HELP.control);
    }
    const key = KIND_HELP[node.kind];
    if (key) return I18n.t(key);
    /* 未知 kind：退回既有的节点类型一句话说明（仍是人话），再兜底 */
    const purpose =
      typeof nodeKindPurpose === "function" ? nodeKindPurpose(node) : "";
    return purpose || I18n.t(HELP_FALLBACK);
  }

  /* 「?」按钮是否显示：设置里可关，默认打开 */
  function nodeHelpEnabled() {
    try {
      return !(typeof S !== "undefined" && S && S.config && S.config.showNodeHelp === false);
    } catch (_) {
      return true;
    }
  }

  /* ── tooltip 小窗（单例，body 级 fixed）──────────────────────────────── */
  let _helpTimer = null;
  let _helpNid = "";

  function helpTipEl() {
    let el = document.getElementById("nodeHelpTip");
    if (el) return el;
    el = document.createElement("div");
    el.id = "nodeHelpTip";
    el.className = "node-help-tip";
    el.setAttribute("role", "tooltip");
    el.hidden = true;
    /* 鼠标进到小窗里 = 还在看，取消这次自动关闭；离开则重新计时 */
    el.addEventListener("mouseenter", cancelNodeHelpHide);
    el.addEventListener("mouseleave", scheduleNodeHelpHide);
    document.body.appendChild(el);
    return el;
  }

  function placeNodeHelpTip(el, anchor) {
    if (!anchor || !anchor.getBoundingClientRect) return;
    const r = anchor.getBoundingClientRect();
    const pad = 6;
    /* 先摊开量尺寸，再定坐标（与页面其它浮层同一套路） */
    el.style.left = "0px";
    el.style.top = "0px";
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    let left = r.left;
    let top = r.bottom + 6;
    if (left + w > window.innerWidth - pad) left = window.innerWidth - w - pad;
    if (left < pad) left = pad;
    if (top + h > window.innerHeight - pad) top = Math.max(pad, r.top - h - 6);
    el.style.left = left + "px";
    el.style.top = top + "px";
  }

  function cancelNodeHelpHide() {
    if (_helpTimer) {
      clearTimeout(_helpTimer);
      _helpTimer = null;
    }
  }

  /* 鼠标移开 1 秒后消失 */
  function scheduleNodeHelpHide() {
    cancelNodeHelpHide();
    _helpTimer = setTimeout(() => {
      _helpTimer = null;
      hideNodeHelpTip();
    }, HIDE_DELAY_MS);
  }

  function hideNodeHelpTip() {
    cancelNodeHelpHide();
    const el = document.getElementById("nodeHelpTip");
    if (el) el.hidden = true;
    _helpNid = "";
  }

  function openNodeHelp(node, anchor) {
    if (!node) return;
    cancelNodeHelpHide();
    const el = helpTipEl();
    el.innerHTML = "";
    const title = document.createElement("div");
    title.className = "node-help-tip-title";
    title.textContent = node.title || I18n.t("（未命名）");
    const body = document.createElement("div");
    body.className = "node-help-tip-body";
    body.textContent = nodeHelpText(node);
    el.appendChild(title);
    el.appendChild(body);
    el.hidden = false;
    el._helpAnchor = anchor || null;
    _helpNid = node.id || "";
    placeNodeHelpTip(el, anchor);
  }

  function toggleNodeHelp(node, anchor) {
    if (!node) return;
    const el = document.getElementById("nodeHelpTip");
    if (el && !el.hidden && _helpNid === (node.id || "")) {
      hideNodeHelpTip();
      return;
    }
    openNodeHelp(node, anchor);
  }

  /* 节点头部按钮：设置里关掉时返回 null（调用方按返回值决定是否挂上） */
  function nodeHelpButtonEl(node) {
    if (!nodeHelpEnabled()) return null;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "n-play n-help-btn";
    btn.textContent = "?";
    btn.title = I18n.t("节点说明：点击查看这个节点是干什么的");
    btn.setAttribute("aria-label", I18n.t("节点说明"));
    btn.onclick = (ev) => {
      ev.stopPropagation();
      toggleNodeHelp(node, btn);
    };
    btn.addEventListener("mouseleave", scheduleNodeHelpHide);
    btn.addEventListener("mouseenter", cancelNodeHelpHide);
    return btn;
  }

  /* 瞬态收尾：点别处 / Esc 直接收掉（小窗没有待保存的输入，允许点外关闭） */
  document.addEventListener("mousedown", (ev) => {
    const el = document.getElementById("nodeHelpTip");
    if (!el || el.hidden) return;
    const t = ev.target;
    if (el.contains(t)) return;
    if (t && t.closest && t.closest(".n-help-btn")) return;
    hideNodeHelpTip();
  });
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") hideNodeHelpTip();
  });

  window.nodeHelpEnabled = nodeHelpEnabled;
  window.nodeHelpText = nodeHelpText;
  window.nodeHelpButtonEl = nodeHelpButtonEl;
  window.openNodeHelp = openNodeHelp;
  window.toggleNodeHelp = toggleNodeHelp;
  window.hideNodeHelpTip = hideNodeHelpTip;
})();
