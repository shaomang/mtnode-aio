"use strict";
/**
 * Breeze TTS 2 控制台（无框架原生 JS）。
 * 同一份界面跑在两个宿主里：
 *   · MTNode 主进程开的控制台窗 —— breeze:xxx 全套能力
 *   · 托盘进程开的控制台窗   —— 只有状态 / 日志 / 手写指令试听（写类动作按能力探测降级）
 * 角色（音色预设）的创建与编辑在画布节点里（👤 角色 → 三步向导），这里刻意不碰预设库。
 * 所以每个动作前都要先看 window.breezeApi 上有没有那个方法，不要假定存在。
 */
(() => {
  const api = window.breezeApi || {};
  const $ = (id) => document.getElementById(id);
  const has = (k) => typeof api[k] === "function";

  let status = null;
  /* ── 状态文案与错误码译法（与 breeze-pack 的错误码一一对应） ───────── */
  const ERR_TEXT = {
    text_required: "待合成文本为空",
    ref_text_required:
      "给了参考音频就必须同时给参考文稿（两者必须成对）：请填「参考文稿」端子，或在音色库里给该音色补上文稿",
    ref_audio_required: "缺少参考音频：请接「参考音频」端子，或选一个音色",
    mode_conflict: "「音色设计」不使用参考音频（音色来自 instruction）：请改用「音色导演」或清掉参考音频",
    instruction_required: "「音色导演」需要 instruction（描述语气、情绪、节奏）",
    bad_cfg_scale: "cfg_scale 必须大于 0",
    bad_speed: "speed 需在 0.25 ~ 4.0 之间",
    unsupported_format: "不支持的输出格式（可选 wav / flac / mp3）",
    missing_ffmpeg: "本机缺少 ffmpeg，无法转 mp3：请改用 wav / flac，或重装后端（安装脚本会下便携 ffmpeg）",
    transcode_failed: "音频转码失败：请改用 wav / flac，或重装后端",
    empty_audio: "后端返回空音频：可换一个参考片段，或调整 cfg_scale 后重试",
    busy_engine: "引擎正忙（同一时刻只跑一个合成请求），请稍后重试",
    engine_loading: "引擎还在加载权重（首次需数十秒到数分钟）：展开下面的「引擎日志」看进度，就绪后重试",
    engine_down: "无法连接推理引擎：引擎进程没起来 —— 再合成一次会自动重新拉起；仍不行请看「引擎日志」",
    engine_rejected: "引擎拒绝了这次请求（详情见 Console 日志）",
    not_installed: "后端尚未安装完成：请先安装（或缺 venv / 引擎源码 / 权重）",
    no_weights: "未找到 Breeze TTS 2 权重：请重新安装，或指定已有权重目录",
    bad_python: "需要 Python 3.10+",
    torch_missing: "虚拟环境缺少 torch：请重新安装",
    cuda_unavailable: "torch 看不到 CUDA（本后端需要 NVIDIA GPU，eager 约 7.7GB 显存）",
    engine_exited: "推理引擎启动后退出（详情见「引擎日志」/ Console 日志）",
    engine_start_timeout: "等待引擎就绪超时（详情见「引擎日志」）",
    engine_start_failed: "引擎拉起结束但没就绪（详情见「引擎日志」）",
    engine_spawn_failed: "引擎进程没能启动（详情见「引擎日志」）",
    no_api_key: "管理服务 API Key 缺失：请先在插件里「启用」一次",
    voice_not_found: "音色不存在（可能已被删除）",
    preset_missing: "角色预设不存在（可能已被删除）：请在画布节点里重新选一个角色",
    preset_group_missing: "这个角色里没有可用的样本组：请在管理台补一组（音频 + 样本文字）",
    preset_audio_missing: "角色样本缺音频：请在管理台给这一组选一段参考音频",
    voice_audio_required: "音色缺少参考音频",
    voice_id_required: "音色名不能为空",
    voice_exists: "同名音色已存在",
    no_output_path: "未设置输出路径",
    write_failed: "音频写盘失败（请检查输出路径是否可写）",
    backend_down: "后端未能在规定时间内就绪",
    dialog_failed: "文件对话框异常（看 Console 日志）",
  };

  const t = (codeOrText) => {
    const s = String(codeOrText == null ? "" : codeOrText).trim();
    if (!s) return "失败";
    let j = null;
    if (s.startsWith("{")) {
      try {
        j = JSON.parse(s);
      } catch {}
    }
    if (j) {
      const d = j.detail;
      if (d && typeof d === "object") return t(d.code) + (d.message ? "：" + d.message : "");
      if (typeof d === "string") return t(d);
    }
    const key = s.split(/[:\s]+/)[0];
    if (ERR_TEXT[s]) return ERR_TEXT[s];
    if (ERR_TEXT[key]) return ERR_TEXT[key] + (s.length > key.length ? "：" + s.slice(key.length + 1) : "");
    if (/econnrefused|enotfound|fetch failed|socket hang up|timed?\s*out|network/i.test(s))
      return "无法连接后端（后端可能已退出，请重新「启用」）";
    if (/^HTTP Error \d{3}|^http_\d{3}/i.test(s)) return "后端返回 HTTP 错误：" + s + "（详情见 Console 日志）";
    return s;
  };

  function toast(msg, kind) {
    const el = document.createElement("div");
    el.className = "toast " + (kind || "");
    el.textContent = String(msg);
    document.body.appendChild(el);
    setTimeout(() => el.remove(), kind === "err" ? 7000 : 3600);
  }

  function appendLog(line, cls) {
    const el = $("log");
    const d = document.createElement("div");
    d.textContent = line;
    if (cls) d.style.color = cls === "err" ? "#ef9f9d" : cls === "warn" ? "#e8cd93" : "#8fdcae";
    el.appendChild(d);
    while (el.childNodes.length > 3000) el.removeChild(el.firstChild);
    el.scrollTop = el.scrollHeight;
  }
  const logCls = (l) =>
    /\[err\]|error|failed|失败|Traceback/i.test(l) ? "err" : /WARN|warn|警告|提示/i.test(l) ? "warn" : /ready|complete|完成|就绪/i.test(l) ? "ok" : "";

  /* ── 状态渲染 ─────────────────────────────────────────────────────── */
  function fmtMb(mb) {
    const n = Number(mb) || 0;
    return n >= 1024 ? (n / 1024).toFixed(1) + " GB" : n + " MB";
  }

  function render() {
    const st = status || {};
    const eng = (st.apiStatus && st.apiStatus.engine) || null;
    $("verBadge").textContent = "v" + (st.version || "1.0.0");

    const badge = $("svcBadge");
    if (st.apiUp) {
      badge.className = "badge on";
      badge.textContent = "后端运行中";
    } else if (st.installing) {
      badge.className = "badge load";
      badge.textContent = "安装中";
    } else {
      badge.className = "badge off";
      badge.textContent = st.installed ? "已安装 · 未运行" : "未安装";
    }
    const eb = $("engBadge");
    /* 引擎不常驻（eager 约 7.7GB 显存）：「未加载」是空闲态而不是故障，
       文案要写清「用时自动加载」，否则用户看到的就是「装完用不了」。 */
    if (!st.apiUp) {
      eb.className = "badge";
      eb.textContent = "引擎未知";
      eb.title = "后端（管理服务）没在跑：先点「启用」";
    } else if (eng && eng.up) {
      eb.className = "badge on";
      eb.textContent = "引擎就绪";
      eb.title = "引擎已把权重载进显存，可以直接合成";
    } else if (eng && eng.loading) {
      eb.className = "badge load";
      eb.textContent = "引擎加载中…";
      eb.title = "正在加载约 7.7GB 权重（首次需数十秒到数分钟）：展开下面的「引擎日志」看进度";
    } else {
      eb.className = "badge off";
      eb.textContent = "引擎未加载 · 用时自动加载";
      eb.title = "引擎不常驻显存（约 7.7GB）：点「加载模型」，或直接合成 —— 第一次合成会自动拉起引擎";
    }

    $("btnStart").disabled = !st.installed || !!st.installing || !!st.apiUp || !has("start");
    $("btnStop").disabled = !st.apiUp || !has("stop");
    $("btnEngineStart").disabled = !st.apiUp || !!(eng && (eng.up || eng.loading)) || !has("engineStart");
    $("btnEngineStop").disabled = !st.apiUp || !(eng && (eng.up || eng.loading)) || !has("engineStop");

    $("apiBase").textContent = st.apiUp ? "http://127.0.0.1:" + st.port : "（未运行）";
    const key = (st.apiStatus && st.apiStatus.apiKey) || "";
    $("apiKey").textContent = key ? key : st.apiUp ? "（读不到：看安装目录 api-key.txt）" : "（未运行）";
    $("engineInfo").textContent = eng
      ? "127.0.0.1:" +
        eng.port +
        (eng.up
          ? " · 就绪 " + (eng.sampleRate || 24000) + "Hz"
          : eng.loading
            ? " · 加载权重中"
            : " · 未加载（首次合成自动拉起）") +
        (eng.pid ? " · pid " + eng.pid : "")
      : "—";
    const gpu = st.gpu || (st.apiStatus && st.apiStatus.gpu);
    $("gpuInfo").textContent = gpu
      ? gpu.name + " · " + fmtMb(gpu.memUsedMb) + " / " + fmtMb(gpu.memTotalMb) + " · " + gpu.utilPct + "%"
      : "（未检测到 nvidia-smi）";
    $("logPath").textContent = st.consolePath || "";

    if (has("setFastAll")) $("fastAll").checked = !!st.fastAll;
  }

  /* ── 刷新 ─────────────────────────────────────────────────────────── */
  let refreshing = false;
  async function refresh() {
    if (refreshing) return;
    refreshing = true;
    try {
      const st = has("getStatus") ? await api.getStatus() : null;
      if (st) {
        status = st;
        render();
      }
      /* 引擎日志面板开着就跟状态一起轮询：加载进度与报错现场能实时看到 */
      await loadEngineLog();
    } catch (e) {
      appendLog("[err] 状态读取失败: " + String((e && e.message) || e), "err");
    } finally {
      refreshing = false;
    }
  }

  /* ── 启停 ─────────────────────────────────────────────────────────── */
  $("btnStart").onclick = async () => {
    toast("正在启用后端…（首次会加载权重）", "ok");
    const r = await api.start();
    if (!r || !r.ok) toast("启用失败：" + t((r && r.error) || ""), "err");
    refresh();
  };
  $("btnStop").onclick = async () => {
    if (!confirm("停止后端？会同时卸载模型、释放显存。")) return;
    const r = await api.stop();
    if (!r || !r.ok) toast("停止失败：" + t((r && r.error) || ""), "err");
    else toast("后端已停止", "ok");
    refresh();
  };
  $("btnEngineStart").onclick = async () => {
    toast("正在加载模型（约 7.7GB 权重）…", "ok");
    const r = await api.engineStart();
    if (!r || !r.ok) toast("加载失败：" + t((r && (r.json || r.error)) || ""), "err");
    else toast("模型已就绪", "ok");
    refresh();
  };
  $("btnEngineStop").onclick = async () => {
    const r = await api.engineStop();
    if (!r || !r.ok) toast("卸载失败：" + t((r && r.error) || ""), "err");
    else toast("模型已卸载（显存已释放）", "ok");
    refresh();
  };
  $("fastAll").onchange = async () => {
    if (!has("setFastAll")) return;
    await api.setFastAll($("fastAll").checked);
    toast($("fastAll").checked ? "下次起后端将启用 fast 路径（冷启动更久）" : "已关闭 fast 路径", "warn");
  };
  $("btnRefresh").onclick = () => refresh();
  $("btnLogPanel").onclick = async () => {
    if (has("toggleLogPanel")) await api.toggleLogPanel();
    else toast("这个窗口里没有并排日志（在 MTNode 的控制台里可用）", "warn");
  };
  /* 清空 = 真清日志文件（truncate 到 0 字节），不是只清这块显示：
     关窗再开旧日志不该回来。写完文件后宿主广播 consoleCleared，打开的日志窗就地清空。 */
  const clearConsoleView = () => {
    $("log").textContent = "";
  };
  $("btnClearLog").onclick = async () => {
    let failed = "";
    if (has("consoleClear")) {
      try {
        const r = await api.consoleClear();
        if (!r || !r.ok) failed = String((r && r.error) || "clear_failed");
      } catch (e) {
        failed = String((e && e.message) || e);
      }
    }
    /* 即使清文件失败，界面至少也要清掉（用户点的是「清空」） */
    clearConsoleView();
    if (failed) toast("清空日志文件失败（已清显示）：" + failed, "warn");
  };

  /* ── 试听合成 ─────────────────────────────────────────────────────── */
  /* 控制台只做「音色设计」临时试听：手写指令 → 一段音频，不写进角色库。
     真正建角色 / 挑候选 / 加备选音色都在画布节点的三步向导里，那边才有预设库与候选池。 */
  $("btnSynth").onclick = async () => {
    const text = $("ttsText").value.trim();
    if (!text) return toast("请填待合成文本", "warn");
    const instruction = $("ttsInstr").value.trim();
    if (!instruction) return toast("请填指令：音色设计靠它描述音色（性别年龄 / 音色质感 / 语速 / 情绪 / 用途）", "warn");
    const payload = {
      text,
      voice: "",
      ref_audio_path: "",
      ref_text: "",
      mode: "design",
      instruction,
      cfg_scale: Number($("cfgScale").value) || 4,
      seed: Number($("seed").value) || 0,
      response_format: "wav",
    };
    $("btnSynth").disabled = true;
    /* 引擎没加载时：后端会自动拉起并等它就绪（首次要载约 7.7GB 权重），别让用户以为卡死了 */
    const eng0 = (status && status.apiStatus && status.apiStatus.engine) || null;
    $("synthInfo").textContent =
      eng0 && eng0.up
        ? "合成中…"
        : "引擎未加载：正在拉起并加载约 7.7GB 权重，就绪后自动合成（首次可能要几分钟）…";
    try {
      const r = await api.apiFetch({ path: "/api/preview", method: "POST", body: payload });
      const j = (r && r.json) || null;
      if (!r || !r.ok || !j || !j.ok) {
        $("synthInfo").textContent = "失败";
        toast("合成失败：" + t((r && (r.raw || r.error)) || ""), "err");
        return;
      }
      const a = $("outAudio");
      a.src = "data:audio/wav;base64," + j.wavBase64;
      a.play().catch(() => {});
      $("synthInfo").textContent =
        "完成 · 能力=" + (j.mode || "?") + " · " + (j.sampleRate || 24000) + "Hz · " + Number(j.durationSec || 0).toFixed(2) + "s";
      toast("合成完成", "ok");
    } finally {
      $("btnSynth").disabled = false;
      /* 合成过程可能刚把引擎拉起来：立刻刷一次，徽章当场变「引擎就绪」 */
      refresh();
    }
  };

  /* ── 引擎日志面板 ─────────────────────────────────────────────────── */
  /* 加载权重要几十秒到几分钟，以前界面上只有一个「引擎加载中…」的文字：
     卡在哪一步（下载 / 载权重 / CUDA 报错 / 进程退出）谁也看不出来，只能去翻 Console 日志。 */
  let engLogOpen = false;
  async function loadEngineLog() {
    if (!engLogOpen || !has("engineLog")) return;
    const r = await api.engineLog(200);
    const j = (r && r.json) || null;
    const tail = (j && j.tail) || [];
    const el = $("engLog");
    el.textContent = tail.length
      ? tail.join("\n")
      : "（引擎还没起过：点「加载模型」或直接合成，这里会出现权重加载与报错现场）";
    el.scrollTop = el.scrollHeight;
  }
  $("btnEngLog").onclick = () => {
    engLogOpen = !engLogOpen;
    $("engLogBox").classList.toggle("hide", !engLogOpen);
    $("btnEngLog").textContent = engLogOpen ? "收起引擎日志" : "引擎日志";
    if (engLogOpen) loadEngineLog();
  };

  /* ── 日志与轮询 ───────────────────────────────────────────────────── */
  if (has("onConsole")) {
    api.onConsole((d) => {
      const line = String((d && d.line) || "");
      for (const l of line.split(/\r?\n/)) if (l.trim()) appendLog(l, logCls(l));
    });
  }
  if (has("consoleTail")) {
    api.consoleTail(96 * 1024).then((r) => {
      const text = String((r && r.text) || "");
      for (const l of text.split(/\r?\n/)) if (l.trim()) appendLog(l, logCls(l));
    });
  }
  /* 别的窗口（并排日志窗 / 托盘进程）清了日志文件：这里也就地清空，别留着已删内容的残影 */
  if (has("onConsoleCleared")) api.onConsoleCleared(() => clearConsoleView());
  if (has("onGpu")) {
    api.onGpu((d) => {
      const g = d && d.gpu;
      if (!g) return;
      $("gpuInfo").textContent = g.name + " · " + fmtMb(g.memUsedMb) + " / " + fmtMb(g.memTotalMb) + " · " + g.utilPct + "%";
    });
  }
  if (has("onLogPanelChanged")) {
    api.onLogPanelChanged(() => refresh());
  }

  refresh();
  setInterval(refresh, 3000);
  /* 引擎加载是异步的（/api/engine/start 会阻塞到就绪），加载期间状态里是 loading —— 靠轮询把徽章刷成就绪 */
  setInterval(() => {
    if (status && status.apiUp) refresh();
  }, 8000);
})();
