(() => {
  const api = window.h3Api;
  if (!api) {
    document.body.textContent = "h3Api missing";
    return;
  }

  const $ = (id) => document.getElementById(id);
  const installDirEl = $("installDir");
  const diskHint = $("diskHint");
  const installStep = $("installStep");
  const subStep = $("subStep");
  const installBar = $("installBar").querySelector("i");
  const subBar = $("subBar").querySelector("i");
  const consoleEl = $("console");
  const svcBadge = $("svcBadge");
  const gpuMemBar = $("gpuMemBar").querySelector("i");
  const gpuUtilBar = $("gpuUtilBar").querySelector("i");
  const gpuMemTxt = $("gpuMemTxt");
  const gpuUtilTxt = $("gpuUtilTxt");
  const modal = $("modal");
  const wfModal = $("wfModal");

  /* 弹窗显隐只靠 CSS 类太脆（.modal-bg 样式被误删过一次，两个弹窗直接常驻页面底部，
     点「取消」只是摘掉一个没人认的 class —— 看起来就是「关不掉的卸载窗口」）。
     这里同时用 hidden 属性 + 内联 display 兜底：样式表再怎么改都关得掉。 */
  function openModal(el) {
    if (!el) return;
    el.hidden = false;
    el.classList.add("show");
    el.style.display = "flex";
  }
  function closeModal(el) {
    if (!el) return;
    el.classList.remove("show");
    el.style.display = "none";
    el.hidden = true;
  }
  function modalIsOpen(el) {
    return !!el && !el.hidden;
  }
  /* 兜底关闭通道：Esc 关掉当前开着的弹窗；点遮罩空白处（不是弹窗本体）也关掉 */
  window.addEventListener("keydown", (ev) => {
    if (ev.key !== "Escape") return;
    if (modalIsOpen(wfModal)) closeModal(wfModal);
    else if (modalIsOpen(modal)) closeModal(modal);
  });
  for (const el of [modal, wfModal]) {
    if (!el) continue;
    el.addEventListener("pointerdown", (ev) => {
      if (ev.target === el) closeModal(el);
    });
  }

  function setBar(el, pct) {
    el.style.width = Math.max(0, Math.min(100, Number(pct) || 0)) + "%";
  }
  function logLine(s) {
    consoleEl.textContent += String(s || "") + "\n";
    consoleEl.scrollTop = consoleEl.scrollHeight;
  }

  async function refresh() {
    const st = await api.getStatus();
    installDirEl.textContent = st.installDir || "未设置";
    const proj = st.project || {};
    const bits = [];
    if (proj.scaffold) bits.push("脚手架✓");
    if (proj.venv) bits.push("venv✓");
    if (proj.models) bits.push("模型✓");
    if (proj.hasPost) bits.push("4K后处理✓");
    else if (proj.venv) bits.push("4K后处理待装");
    diskHint.textContent =
      `建议预留 ≥${st.diskHintGb || 70}GB。` +
      (bits.length ? " 当前：" + bits.join(" · ") : " 尚未检测到完整安装。");

    const running = !!st.running || !!st.comfyUp;
    svcBadge.textContent = running ? "服务运行中" : "服务关闭";
    svcBadge.className = "badge " + (running ? "on" : "off");

    $("btnInstall").disabled = !st.installDir || !!st.installing;
    if ($("btnSelfRepair")) $("btnSelfRepair").disabled = !st.installDir || !!st.installing;
    $("btnStart").disabled = !st.installDir || running;
    $("btnStop").disabled = !running;
    $("btnUninstall").disabled = !st.installDir || !!st.installing;

    if (st.gpu) applyGpu(st.gpu);
    syncLaunchOptsUi(st);
    return st;
  }

  function syncLaunchOptsUi(st) {
    const map = [
      ["optCpuVae", st.cpuVae !== false],
      ["optPinned", st.optDisablePinnedMemory !== false],
      ["optFp16", st.optFp16Intermediates !== false],
      ["optExpand", st.optExpandableSegments !== false],
    ];
    for (const [id, on] of map) {
      const el = $(id);
      if (el && !el._bound) {
        el._bound = true;
        el.addEventListener("change", async () => {
          if (!api.setLaunchOpts) return;
          const r = await api.setLaunchOpts({
            cpuVae: !!$("optCpuVae").checked,
            optDisablePinnedMemory: !!$("optPinned").checked,
            optFp16Intermediates: !!$("optFp16").checked,
            optExpandableSegments: !!$("optExpand").checked,
          });
          const note = $("launchOptsNote");
          if (note) note.textContent = (r && r.note) || "已保存";
          logLine("启动优化已保存（下次启动生效）");
        });
      }
      if (el) el.checked = !!on;
    }
  }

  function applyGpu(gpu) {
    if (!gpu) return;
    const fmt = (v, unit) => (v == null || !Number.isFinite(Number(v)) ? "—" : Number(v) + unit);
    const mem =
      gpu.memUsed != null || gpu.memTotal != null
        ? fmt(gpu.memUsed, "") + "/" + fmt(gpu.memTotal, "") + " MiB"
        : "—";
    const pct = gpu.memPct == null ? "" : " (" + gpu.memPct + "%)";
    gpuMemTxt.textContent = mem + pct + (gpu.name ? " · " + gpu.name : "");
    gpuUtilTxt.textContent = fmt(gpu.util, "%");
    setBar(gpuMemBar, gpu.memPct);
    setBar(gpuUtilBar, gpu.util);
  }

  $("btnDir").onclick = async () => {
    const r = await api.pickInstallDir();
    if (r && r.ok) {
      logLine("installDir=" + r.installDir);
      if (r.project && r.project.ready) logLine("发现已有完整项目，可直接点「手动启动」。");
    } else if (r && r.error) {
      logLine("目录无效: " + r.error);
      alert("目录无效：" + r.error + "\n请勿选择磁盘根目录或系统目录。");
    }
    refresh();
  };

  $("btnInstall").onclick = async () => {
    async function runInstall(opts) {
      logLine("开始 Agent 安装（脚手架仅作参考）…");
      const r = await api.install(opts || {});
      if (r && r.ok) {
        logLine(r.recoveredByAgent ? "Agent 保底安装完成" : "Agent 安装完成");
        return r;
      }
      const err = (r && (r.message || r.error)) || "未知错误";
      logLine("Agent 安装失败: " + err);
      if (!r || r.agentRecoverable === false || err === "cancelled" || err === "busy") return r;
      if (!api.agentRecoverInstall) return r;
      const ok = confirm(
        `Agent 安装失败：${err}\n\n是否再让 Agent 诊断并重试？\n（脚手架仅作参考；不会启动后端服务）`,
      );
      if (!ok) {
        logLine("已取消 Agent 再试");
        return r;
      }
      logLine("已确认：Agent 再试…");
      const r2 = await api.agentRecoverInstall({ error: err });
      if (r2 && r2.ok) logLine("Agent 保底安装完成");
      else logLine("Agent 再试仍失败: " + ((r2 && (r2.message || r2.error)) || ""));
      return r2;
    }

    const disk = await api.freeDisk();
    if (disk && disk.freeGb != null && disk.freeGb < (disk.needGb || 70)) {
      const ok = confirm(
        `磁盘剩余约 ${disk.freeGb}GB，建议预留 ≥${disk.needGb}GB。\n仍要继续安装吗？`,
      );
      if (!ok) return;
      await runInstall({ force: true });
    } else {
      await runInstall({});
    }
    refresh();
  };

  $("btnSelfRepair").onclick = async () => {
    if (!api.selfRepair) {
      logLine("当前版本不支持自我修复");
      return;
    }
    const ok = confirm(
      "自我修复会把最近的 console 日志交给 Agent（dsh）分析判断并动手修复。\n每人环境不同，由 Agent 根据日志自行决策。不会启动服务。\n继续？",
    );
    if (!ok) return;
    logLine("自我修复：提交 console → dsh…");
    const r = await api.selfRepair({});
    if (r && r.ok) {
      logLine("自我修复完成" + (r.message ? " — " + r.message : ""));
    } else
      logLine(
        "自我修复失败: " +
          ((r && (r.message || r.error)) || "未知错误") +
          (r && r.consoleBytes != null ? " · log≈" + r.consoleBytes + "B" : ""),
      );
    refresh();
  };

  $("btnStart").onclick = async () => {
    logLine("手动启动后端（调试）…");
    const r = await api.start();
    logLine(r && r.ok ? "服务已启动" + (r.port ? " :" + r.port : "") : "启动失败: " + ((r && r.error) || ""));
    refresh();
  };

  $("btnStop").onclick = async () => {
    const r = await api.stop();
    logLine(r && r.ok ? "服务已停止" : "关闭失败");
    refresh();
  };

  $("btnForceKill").onclick = async () => {
    if (!api.forceKillBackend) return;
    const ok = confirm(
      "强制结束后端并释放显存？\n适用于 GPU 跑满却永远不结束的情况。\n之后需重新点「手动启动」。",
    );
    if (!ok) return;
    logLine("强制释放显存…");
    const r = await api.forceKillBackend();
    logLine(r && r.ok ? "已结束后端，显存应已释放；请重新点「手动启动」" : "失败: " + ((r && r.error) || ""));
    refresh();
  };

  $("btnUninstall").onclick = async () => {
    const prev = await api.uninstallPreview();
    if (!prev || !prev.ok) {
      alert("无法卸载：" + ((prev && prev.error) || "未知错误"));
      return;
    }
    const ul = $("uninstallList");
    ul.innerHTML = "";
    for (const t of prev.targets || []) {
      const li = document.createElement("li");
      li.textContent = `${t.note || t.rel}: ${t.path}`;
      ul.appendChild(li);
    }
    $("delOutput").checked = false;
    openModal(modal);
  };

  $("btnCancelUn").onclick = () => closeModal(modal);
  $("btnConfirmUn").onclick = async () => {
    closeModal(modal);
    $("installStep").textContent = "正在卸载（大目录可能要几分钟）…";
    const r = await api.uninstall({
      confirm: true,
      deleteOutput: !!$("delOutput").checked,
    });
    logLine(r && r.ok ? "卸载完成（安装目录配置已保留，便于再次发现）" : "卸载失败: " + ((r && r.error) || ""));
    refresh();
  };

  $("btnClearLog").onclick = () => {
    consoleEl.textContent = "";
  };

  /* ───── 自建工作流库 ───── */
  const wfListEl = $("wfList");
  const wfStatsTxt = $("wfStatsTxt");
  if (!$("btnWfImport")) logLine("当前版本不支持自建工作流库（缺少控件）");

  function wfValBadge(v) {
    if (!v || !v.status || v.status === "unchecked")
      return { cls: "", text: "未校验" };
    if (v.status === "ok") return { cls: "ok", text: "校验通过" };
    if (v.status === "missing_nodes") {
      const m = Array.isArray(v.missing) ? v.missing : [];
      const names = m.slice(0, 3).map((x) => x.class_type).filter(Boolean).join("、");
      return {
        cls: "warn",
        text: "缺 " + m.length + " 个节点包" + (names ? "（" + names + (m.length > 3 ? "…" : "") + "）" : ""),
      };
    }
    if (v.status === "skipped") return { cls: "", text: "未校验（后端未运行）" };
    return { cls: "warn", text: (v.error || "校验异常") };
  }

  function renderWfItem(it) {
    const box = document.createElement("div");
    box.className = "wf-item";
    const head = document.createElement("div");
    head.className = "head";
    const title = document.createElement("span");
    title.className = "title";
    title.textContent = it.title || "未命名";
    head.appendChild(title);
    const fmt = document.createElement("span");
    fmt.className = "badge";
    fmt.textContent = it.format === "ui" ? "UI" : "API";
    fmt.title = it.source && it.source.template ? "内置模板" : "来源：" + ((it.source && it.source.name) || "");
    if (it.source && it.source.template) fmt.textContent += " 模板";
    head.appendChild(fmt);
    const vb = wfValBadge(it.validation);
    const badge = document.createElement("span");
    badge.className = "badge " + vb.cls;
    badge.textContent = vb.text;
    head.appendChild(badge);
    const src = document.createElement("span");
    src.className = "meta";
    src.style.marginLeft = "auto";
    src.textContent = "节点 " + (it.nodeCount || 0);
    head.appendChild(src);
    box.appendChild(head);

    const outs = Array.isArray(it.outputs) ? it.outputs : [];
    if (outs.length) {
      const meta = document.createElement("div");
      meta.className = "meta";
      meta.textContent =
        "输出：" +
        outs
          .slice(0, 3)
          .map((o) => (isVideoClass(o.classType) ? "🎬" : "📄") + " " + (o.classType || "?") + "(@" + o.nodeId + ")")
          .join("  ") +
        (outs.length > 3 ? " …" : "");
      box.appendChild(meta);
    }

    const ops = document.createElement("div");
    ops.className = "ops";
    const mkBtn = (label, fn, cls) => {
      const b = document.createElement("button");
      b.textContent = label;
      if (cls) b.className = cls;
      b.onclick = async (ev) => {
        ev.stopPropagation();
        await fn();
        refreshWf();
      };
      ops.appendChild(b);
      return b;
    };
    mkBtn("重新校验", async () => {
      const r = await api.wfValidate(it.id);
      logLine(r && r.message ? "[校验] " + r.message : "[校验] 失败: " + ((r && r.error) || ""));
    });
    mkBtn("导出 JSON", () => wfExport(it.id));
    mkBtn("复制 JSON", async () => {
      const r = await api.wfExport(it.id);
      if (!r || !r.ok) {
        alert("导出失败：" + ((r && r.error) || "未知错误"));
        return;
      }
      try {
        await navigator.clipboard.writeText(r.text);
        logLine("已复制 " + r.filename + " 到剪贴板");
      } catch (e) {
        alert("复制失败：" + String((e && e.message) || e));
      }
    });
    mkBtn("重命名", async () => {
      const next = prompt("新名称：", it.title || "");
      if (next == null || !String(next).trim()) return;
      const r = await api.wfRename(it.id, String(next).trim());
      if (!r || !r.ok) alert("重命名失败：" + ((r && r.error) || "未知错误"));
      else logLine("已重命名 → " + (r.title || ""));
    });
    mkBtn("删除", async () => {
      if (!confirm('删除工作流「' + (it.title || "") + '」？此操作不可恢复。')) return;
      const r = await api.wfDelete(it.id);
      if (r && r.ok) logLine("已删除 " + (r.title || it.title));
      else alert("删除失败：" + ((r && r.error) || "未知错误"));
    }, "danger");
    box.appendChild(ops);
    return box;
  }

  function isVideoClass(cls) {
    return /(SaveVideo|SaveWebM|SaveMP4|VideoCombine|SaveAnimated|VHS_VideoCombine|SaveVideoFFmpeg|StoreVideo)/i.test(String(cls || ""));
  }

  async function refreshWf() {
    try {
      const r = await api.wfList();
      if (!r || !r.ok) throw new Error((r && r.error) || "wfList failed");
      wfStatsTxt.textContent =
        r.stats ? "· 共 " + r.stats.count + " 条（校验通过 " + r.stats.validated + "，缺节点 " + r.stats.warn + "，未校验 " + r.stats.unchecked + "）" : "";
      wfListEl.innerHTML = "";
      const items = Array.isArray(r.items) ? r.items : [];
      if (!items.length) {
        const empty = document.createElement("div");
        empty.className = "wf-empty";
        empty.textContent = "还没有自定义工作流。导入 ComfyUI 导出的 JSON，或用「内置图另存」起步。";
        wfListEl.appendChild(empty);
        return;
      }
      for (const it of items) wfListEl.appendChild(renderWfItem(it));
    } catch (e) {
      logLine("[wf] 列表加载失败: " + String((e && e.message) || e));
    }
  }

  async function wfImportPayload(payload) {
    logLine("导入工作流…");
    const r = await api.wfImport(payload);
    if (r && r.ok) {
      logLine(
        "导入完成：" + (r.summary && r.summary.title) +
          (r.replaced ? "（已覆盖同名旧版本）" : "") +
          ((r.warnings && r.warnings.length) ? " · 提示：" + r.warnings.join("；") : ""),
      );
    } else {
      alert("导入失败：" + ((r && r.error) || "未知错误"));
    }
    refreshWf();
  }

  async function wfExport(id) {
    const r = await api.wfExport(id);
    if (!r || !r.ok) {
      alert("导出失败：" + ((r && r.error) || "未知错误"));
      return;
    }
    try {
      const blob = new Blob([r.text], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = r.filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
      logLine("已生成导出文件 " + r.filename + "（未弹出保存框可用「复制 JSON」）");
    } catch (e) {
      alert("下载失败，请用「复制 JSON」：\n" + String((e && e.message) || e));
    }
  }

  if ($("btnWfImport")) {
    $("btnWfImport").onclick = () => {
      const fi = $("wfFileInput");
      fi.value = "";
      fi.onchange = async () => {
        const f = fi.files && fi.files[0];
        if (!f) return;
        try {
          await wfImportPayload({ filePath: f.path || f.name, title: "" });
        } catch (e) {
          alert("读取文件失败：" + String((e && e.message) || e));
        }
      };
      fi.click();
    };
  }
  if ($("btnWfPaste")) {
    $("btnWfPaste").onclick = () => {
      $("wfPasteText").value = "";
      $("wfPasteTitle").value = "";
      openModal(wfModal);
      $("wfPasteText").focus();
    };
    $("btnWfPasteCancel").onclick = () => closeModal(wfModal);
    $("btnWfPasteOk").onclick = async () => {
      const text = String($("wfPasteText").value || "").trim();
      if (!text) {
        alert("请先粘贴 JSON 内容");
        return;
      }
      closeModal(wfModal);
      await wfImportPayload({ text, title: String($("wfPasteTitle").value || "").trim() });
    };
    $("wfPasteText").addEventListener("keydown", (ev) => {
      if ((ev.ctrlKey || ev.metaKey) && ev.key === "Enter") $("btnWfPasteOk").click();
    });
  }
  if ($("btnWfTemplate")) {
    $("btnWfTemplate").onclick = async () => {
      const doOne = async (mode) => {
        const label = mode === "r2v" ? "R2V（参考图/视频/音频）" : "FL2VA（首末帧）";
        if (!confirm("把内置 " + label + " 工作流另存为库里的自定义工作流？\n保存后可自由编辑与复制，内置链本身不受影响。")) return false;
        const r = await api.wfTemplateExport(mode);
        if (r && r.ok) {
          logLine("内置模板已入库：" + ((r.summary && r.summary.title) || ""));
          refreshWf();
          return true;
        }
        alert("另存失败：" + ((r && r.error) || "未知错误"));
        return false;
      };
      if (await doOne("fl2va")) await doOne("r2v");
    };
  }

  api.onProgress((ev) => {
    if (!ev) return;
    if (ev.phase === "install" || ev.phase === "dsh") {
      installStep.textContent =
        (ev.stepLabel || ev.step || "") + (ev.message ? " — " + ev.message : "");
      setBar(installBar, ev.pct);
      if (ev.subPct != null) {
        subStep.textContent = "子进度 " + Math.round(ev.subPct) + "%";
        setBar(subBar, ev.subPct);
      }
    }
    if (ev.phase === "generate") {
      installStep.textContent = "生成: " + (ev.message || "");
      setBar(installBar, ev.pct || 0);
    }
  });
  api.onConsole((ev) => {
    if (ev && ev.line) logLine(ev.line);
  });
  api.onGpu(applyGpu);

  (async () => {
    const tail = await api.consoleTail(48 * 1024);
    if (tail && tail.text) consoleEl.textContent = tail.text;
    consoleEl.scrollTop = consoleEl.scrollHeight;
    await refresh();
    refreshWf();
    setInterval(refresh, 4000);
  })();
})();

