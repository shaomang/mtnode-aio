"use strict";
/**
 * Breeze TTS 2 控制台（无框架原生 JS）。
 * 同一份界面跑在两个宿主里：
 *   · MTNode 主进程开的控制台窗 —— breeze:xxx 全套能力
 *   · 托盘进程开的控制台窗   —— 只有状态 / 日志 / 音色浏览 / 试听（写类动作按能力探测降级）
 * 所以每个动作前都要先看 window.breezeApi 上有没有那个方法，不要假定存在。
 */
(() => {
  const api = window.breezeApi || {};
  const $ = (id) => document.getElementById(id);
  const has = (k) => typeof api[k] === "function";

  let status = null;
  let refPick = null; // {path,name,data}

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
    voice_audio_required: "音色缺少参考音频",
    voice_id_required: "音色名不能为空",
    voice_exists: "同名音色已存在",
    no_output_path: "未设置输出路径",
    write_failed: "音频写盘失败（请检查输出路径是否可写）",
    backend_down: "后端未能在规定时间内就绪",
    busy: "已有安装 / 修复任务在跑",
    cancelled: "已取消",
    refuse_root: "不能选磁盘根目录",
    refuse_system: "不能选系统目录",
    refuse_app_dir: "不能选应用自己的目录（升级 / 卸载会带走数据）",
    empty_dir: "未选择安装目录",
    weights_incomplete: "该目录不像 Breeze TTS 2 权重目录（要有 config.json 与 safetensors / pt / bin）",
    install_incomplete_after_script: "安装脚本跑完但要件不全（看 Console 日志）",
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
    const proj = st.project || {};
    const eng = (st.apiStatus && st.apiStatus.engine) || null;
    $("verBadge").textContent = "v" + (st.version || "1.0.0");
    $("installDir").textContent = st.installDir || "未选择安装目录";
    $("weightsDir").textContent = st.weightsDir
      ? "权重：" + st.weightsDir
      : "权重：" + (proj.weights ? "已就绪（随安装下载）" : "随安装下载（可指定已有目录）");

    const parts = [];
    if (proj.venv) parts.push("venv✓");
    if (proj.engine) parts.push("引擎✓");
    if (proj.weights) parts.push("权重✓");
    if (proj.installed) parts.push("已安装✓");
    $("installHint").textContent = parts.length
      ? "就绪：" + parts.join("  ")
      : "安装要装 torch（约 3GB）+ 引擎源码 + 权重（十几 GB）+ 便携 ffmpeg，磁盘请留 ≥20GB。";

    $("btnInstall").disabled = !st.installDir || !!st.installing;
    /* 自我修复：没有安装目录时没有可写工作区（Agent 没活干），安装中则防连点叠会话 */
    $("btnSelfRepair").disabled = !st.installDir || !!st.installing || !has("agentRecoverInstall");
    $("btnCancelInstall").classList.toggle("hide", !st.installing);
    $("btnPickDir").disabled = !!st.installing || !has("pickInstallDir");
    $("btnPickWeights").disabled = !!st.installing || !has("pickWeightsDir");
    $("btnClearWeights").disabled = !!st.installing || !has("setWeightsDir");

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

    /* 音色下拉与列表 */
    const vs = (st.apiStatus && st.apiStatus.voices) || [];
    renderVoices(vs);
    const sel = $("voiceSel");
    const keep = sel.value;
    sel.innerHTML = '<option value="">（不用音色库）</option>';
    for (const v of vs) {
      const o = document.createElement("option");
      o.value = v.id;
      o.textContent = v.id + (v.ready ? "" : "（缺" + (!v.hasAudio ? "音频" : "文稿") + "）");
      sel.appendChild(o);
    }
    if (keep && vs.some((v) => v.id === keep)) sel.value = keep;
  }

  function renderVoices(vs) {
    const host = $("voiceList");
    host.innerHTML = "";
    if (!vs.length) {
      const d = document.createElement("div");
      d.className = "empty";
      d.textContent = "还没有音色。音色 = 一段干净的参考音频 + 它的准确文稿。";
      host.appendChild(d);
      return;
    }
    for (const v of vs) {
      const row = document.createElement("div");
      row.className = "item";
      const name = document.createElement("span");
      name.className = "name";
      name.textContent = v.id;
      const sub = document.createElement("span");
      sub.className = "sub";
      sub.title = v.text || "";
      sub.textContent = (v.ready ? "" : "⚠ ") + (v.text || "（无文稿）");
      row.appendChild(name);
      row.appendChild(sub);

      const play = document.createElement("button");
      play.className = "mini";
      play.textContent = "试听";
      play.onclick = () => playVoice(v.id);
      row.appendChild(play);

      const use = document.createElement("button");
      use.className = "mini";
      use.textContent = "选用";
      use.onclick = () => {
        $("voiceSel").value = v.id;
        $("newVoiceId").value = v.id;
        $("newVoiceText").value = v.text || "";
        toast("已选用音色：" + v.id, "ok");
      };
      row.appendChild(use);

      if (has("voiceDelete")) {
        const del = document.createElement("button");
        del.className = "mini danger";
        del.textContent = "删除";
        del.onclick = async () => {
          if (!confirm("删除音色「" + v.id + "」？（只删参考片段，不影响已生成的音频）")) return;
          const r = await api.voiceDelete(v.id);
          if (!r || !r.ok) toast(t((r && (r.error || r.raw)) || "voice_not_found"), "err");
          refresh();
        };
        row.appendChild(del);
      }
      host.appendChild(row);
    }
  }

  async function playVoice(id) {
    if (!has("voiceAudio")) return;
    const r = await api.voiceAudio(id);
    if (!r || !r.ok || !r.base64) {
      toast("读不到参考音频：" + t((r && (r.error || r.raw)) || ""), "err");
      return;
    }
    const a = $("refAudio");
    a.classList.remove("hide");
    a.src = "data:" + (r.mime || "audio/wav") + ";base64," + r.base64;
    a.play().catch(() => {});
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

  /* ── 安装 / 启停 ──────────────────────────────────────────────────── */
  $("btnPickDir").onclick = async () => {
    const r = await api.pickInstallDir();
    if (r && r.cancelled) return;
    if (!r || !r.ok) return toast("目录不可用：" + t((r && r.error) || ""), "err");
    toast("安装目录：" + r.installDir, "ok");
    refresh();
  };
  $("btnPickWeights").onclick = async () => {
    const r = await api.pickWeightsDir();
    if (r && r.cancelled) return;
    if (!r || !r.ok) return toast(t((r && (r.error || "weights_incomplete")) || ""), "err");
    toast("已指定权重目录：" + r.weightsDir, "ok");
    refresh();
  };
  $("btnClearWeights").onclick = async () => {
    await api.setWeightsDir("");
    toast("已改回随安装下载的权重目录", "ok");
    refresh();
  };
  $("btnInstall").onclick = async () => {
    const r = await api.install({});
    if (!r || !r.ok) toast("安装失败：" + t((r && r.error) || ""), "err");
    else toast("安装完成", "ok");
    refresh();
  };
  $("btnCancelInstall").onclick = async () => {
    await api.cancelInstall();
    toast("已请求取消安装…", "warn");
  };
  /* 自我修复（与 music3 / h3 控制台同口径）：把最近 console 日志交给 Agent（dsh）自行分析并动手修。
     这座桥（preload 的 agentRecoverInstall）以前暴露了却没人调用 —— 安装 / 启用失败时，
     用户只能干看着日志，主窗也拿不到「一键修复」的入口。 */
  $("btnSelfRepair").onclick = async () => {
    if (!has("agentRecoverInstall")) return toast("当前版本不支持自我修复", "err");
    if (
      !confirm(
        "自我修复会把最近的 console 日志交给 Agent（dsh）分析判断并动手修复。\n" +
          "每人环境不同，由 Agent 根据日志自行决策。不会启动服务。\n继续？",
      )
    )
      return;
    toast("自我修复：提交 console → Agent…", "ok");
    const r = await api.agentRecoverInstall({});
    if (r && r.ok) toast("自我修复完成" + (r.consoleBytes != null ? "（日志 " + r.consoleBytes + "B）" : ""), "ok");
    else toast("自我修复失败：" + t((r && (r.error || r.message)) || ""), "err");
    refresh();
  };
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
  $("btnClearLog").onclick = () => {
    $("log").textContent = "";
  };

  /* ── 音色库写入 ───────────────────────────────────────────────────── */
  $("btnPickRef").onclick = async () => {
    if (!has("pickRefAudio")) return toast("托盘窗口里不能选文件：请在 MTNode 的控制台操作", "warn");
    const r = await api.pickRefAudio();
    if (!r || r.cancelled) return;
    if (!r.ok) return toast("读取失败：" + t((r && r.error) || ""), "err");
    refPick = { path: r.path, name: r.name, data: r.data };
    $("refAudioName").textContent = r.name + "（" + Math.round((r.data.length || 0) / 1024) + " KB）";
    if (!$("newVoiceId").value.trim()) $("newVoiceId").value = String(r.name).replace(/\.[^.]+$/, "");
  };
  $("btnVoiceAdd").onclick = async () => {
    if (!has("voiceAdd")) return toast("托盘窗口里不能保存音色：请在 MTNode 的控制台操作", "warn");
    const id = $("newVoiceId").value.trim();
    const text = $("newVoiceText").value.trim();
    if (!id) return toast("请填音色名", "warn");
    if (!refPick) return toast("请选择参考音频文件", "warn");
    if (!text) return toast("请填参考文稿：它必须与参考音频逐字一致", "warn");
    const r = await api.voiceAdd({ voiceId: id, refText: text, file: { name: refPick.name, data: refPick.data } });
    if (!r || !r.ok) return toast("保存失败：" + t((r && (r.raw || r.error || r.json)) || ""), "err");
    toast("已保存音色：" + id, "ok");
    refPick = null;
    $("refAudioName").textContent = "未选择文件";
    $("newVoiceText").value = "";
    refresh();
  };
  $("btnVoicePreview").onclick = async () => {
    if (refPick && refPick.path) {
      /* 本地文件：直接用 file:// 播（预览的是参考片段本身） */
      const a = $("refAudio");
      a.classList.remove("hide");
      a.src = "file:///" + String(refPick.path).replace(/\\/g, "/");
      a.play().catch(() => toast("本地预览失败，可直接用系统播放器打开该文件", "warn"));
      return;
    }
    const id = $("newVoiceId").value.trim() || $("voiceSel").value;
    if (!id) return toast("先选一个音色，或选一个参考音频文件", "warn");
    playVoice(id);
  };

  /* ── 试听合成 ─────────────────────────────────────────────────────── */
  $("btnSynth").onclick = async () => {
    const text = $("ttsText").value.trim();
    if (!text) return toast("请填待合成文本", "warn");
    const payload = {
      text,
      voice: $("voiceSel").value,
      mode: $("mode").value,
      instruction: $("ttsInstr").value.trim(),
      cfg_scale: Number($("cfgScale").value) || 1,
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
  if (has("onProgress")) {
    api.onProgress((d) => {
      if (!d || (d.id && d.id !== "breeze-tts-local")) return;
      const pct = Math.max(0, Math.min(100, Number(d.pct) || 0));
      $("installProgress").classList.remove("hide");
      $("installBar").style.width = pct + "%";
      $("installStepTxt").textContent = (d.stepLabel ? d.stepLabel + " · " : "") + (d.message || pct + "%");
      if (d.done) setTimeout(() => $("installProgress").classList.add("hide"), 2500);
    });
  }
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
