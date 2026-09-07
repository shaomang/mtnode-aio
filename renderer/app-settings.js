"use strict";
/* ============ 设置（APIs/Config） ============ */

function mergePluginManagedProviders(targetCfg, sourceCfg) {
  if (!targetCfg || !sourceCfg) return;
  const incoming = Array.isArray(sourceCfg.providers) ? sourceCfg.providers : [];
  const managed = incoming.filter(
    (p) => p && (p.source === "llama-plugin" || p.id === "llama-local"),
  );
  if (!managed.length) return;
  const base = (Array.isArray(targetCfg.providers) ? targetCfg.providers : []).filter(
    (p) => p && p.source !== "llama-plugin" && p.id !== "llama-local",
  );
  targetCfg.providers = base.concat(managed);
}

/* 打开设置时仅合并插件托管服务商（llama 本地等），绝不整表覆盖：
   整表覆盖会把「添加服务商」弹窗刚 push 的内存项与用户在本页的
   增/删/排序全部丢弃 —— 手动添加服务商保存后不在列表中的根因。
   注意：此处不调用 ensureDefaultProviders()——默认服务商只在启动时播种
   （app-boot.js），若每次打开设置都补默认，被用户删除的 gpt_image_2 /
   deepseek 会在列表里立刻「复活」，删除与编辑永远无法保存。 */
async function reloadConfigProvidersFromDisk() {
  if (!window.api || !window.api.configLoad || !S.config) return;
  try {
    const fresh = await window.api.configLoad();
    if (fresh && Array.isArray(fresh.providers)) {
      mergePluginManagedProviders(S.config, fresh);
    }
  } catch {}
}

function openSettings() {
  reloadConfigProvidersFromDisk().then(() => {
    openSettingsBody();
  });
}

function openSettingsBody() {
  openOverlay(I18n.t("设置 · APIs/Config"));
  overlayPersistent = true; // 设置栏：点击外部不关闭，仅通过「取消 / 保存」关闭
  overlayKind = "settings";
  const body = $("#ovBody");
  let enterSelEl = null;

  const snapRow = document.createElement("label");
  snapRow.className = "n-field";
  snapRow.style.flexDirection = "row";
  snapRow.style.alignItems = "center";
  snapRow.appendChild(document.createTextNode(I18n.t("画布网格间距（px）：")));
  const snapInp = document.createElement("input");
  snapInp.type = "number";
  snapInp.min = 4;
  snapInp.max = 64;
  snapInp.step = 2;
  snapInp.value = S.config.snap || 24;
  snapInp.style.width = "80px";
  snapRow.appendChild(snapInp);
  body.appendChild(snapRow);

  /* 对话发送行为(迁移自 dsh 的 Enter 行为设置) */
  const enterRow = document.createElement("label");
  enterRow.className = "n-field";
  enterRow.style.flexDirection = "row";
  enterRow.style.alignItems = "center";
  enterRow.appendChild(document.createTextNode(I18n.t("对话节点发送行为：")));
  const enterSel = document.createElement("select");
  {
    const o1 = document.createElement("option");
    o1.value = "send";
    o1.textContent = I18n.t("Enter 发送 · Shift+Enter 换行");
    const o2 = document.createElement("option");
    o2.value = "newline";
    o2.textContent = I18n.t("Enter 换行 · Ctrl+Enter 发送");
    enterSel.appendChild(o1);
    enterSel.appendChild(o2);
    enterSel.value =
      S.config.dsh.chatEnter === "newline" ? "newline" : "send";
  }
  enterRow.appendChild(enterSel);
  body.appendChild(enterRow);
  enterSelEl = enterSel;

  /* 主题(2 款,默认 DSH;即时预览,保存后持久化) */
  const themeRow = document.createElement("label");
  themeRow.className = "n-field";
  themeRow.style.flexDirection = "row";
  themeRow.style.alignItems = "center";
  themeRow.appendChild(document.createTextNode(I18n.t("主题色：")));
  const themeSel = document.createElement("select");
  for (const [v, t] of Object.entries(THEMES)) {
    const o = document.createElement("option");
    o.value = v;
    o.textContent = I18n.t(t.name);
    themeSel.appendChild(o);
  }
  themeSel.value = (S.config && S.config.theme) || "dsh";
  themeSel.addEventListener("change", () => applyTheme(themeSel.value));
  themeRow.appendChild(themeSel);
  body.appendChild(themeRow);
  const themeSelEl = themeSel;

  /* ── 网络（Network）：所有网络节点共用的固定端口 ── */
  let netPortInp = null;
  {
    const sec = document.createElement("div");
    sec.className = "settings-sec";
    const secTitle = document.createElement("div");
    secTitle.className = "settings-sec-title";
    secTitle.textContent = I18n.t("网络（Network）");
    sec.appendChild(secTitle);
    const row = document.createElement("label");
    row.className = "n-field";
    row.style.flexDirection = "row";
    row.style.alignItems = "center";
    row.appendChild(document.createTextNode(I18n.t("网络端口（全局默认）：")));
    netPortInp = document.createElement("input");
    netPortInp.type = "number";
    netPortInp.min = "1";
    netPortInp.max = "65535";
    netPortInp.step = "1";
    netPortInp.style.width = "110px";
    netPortInp.value = String(
      Math.max(1, Math.min(65535, Number(S.config && S.config.netPort) || NET_DEFAULT_PORT)),
    );
    row.appendChild(netPortInp);
    sec.appendChild(row);
    const hint = document.createElement("div");
    hint.className = "n-field";
    hint.style.fontSize = "12px";
    hint.style.opacity = "0.9";
    hint.textContent = I18n.t(
      "网络节点各有独立端口：接收节点默认监听 40999，发送节点默认目标 41000，均可在节点体上单独修改；此处仅作为节点留空(0)时的回退默认。通道号(16bit)在端口内做逻辑分流。",
    );
    sec.appendChild(hint);
    body.appendChild(sec);
  }

  /* ── 配置数据目录（API Key / 工作流等；更改后需重启）── */
  {
    const sec = document.createElement("div");
    sec.className = "settings-sec";
    const secTitle = document.createElement("div");
    secTitle.className = "settings-sec-title";
    secTitle.textContent = I18n.t("配置数据目录");
    sec.appendChild(secTitle);

    const hint = document.createElement("div");
    hint.className = "n-field";
    hint.textContent = I18n.t(
      "存放 config.json（API Key 等）、画布存档与本地资产。更改后需重启应用生效。",
    );
    sec.appendChild(hint);

    const pathRow = document.createElement("div");
    pathRow.className = "n-field";
    pathRow.style.flexDirection = "row";
    pathRow.style.alignItems = "center";
    pathRow.style.gap = "8px";
    pathRow.style.flexWrap = "wrap";
    const pathLab = document.createElement("span");
    pathLab.textContent = I18n.t("当前路径：");
    const pathEl = document.createElement("code");
    pathEl.style.wordBreak = "break-all";
    pathEl.style.fontSize = "12px";
    pathEl.textContent = "…";
    pathRow.appendChild(pathLab);
    pathRow.appendChild(pathEl);
    sec.appendChild(pathRow);

    const btnRow = document.createElement("div");
    btnRow.className = "n-field";
    btnRow.style.flexDirection = "row";
    btnRow.style.gap = "8px";
    btnRow.style.flexWrap = "wrap";

    const changeBtn = document.createElement("button");
    changeBtn.className = "mini";
    changeBtn.textContent = I18n.t("更改目录…");
    changeBtn.title = I18n.t("选择新的配置数据目录，保存后需重启");

    const resetBtn = document.createElement("button");
    resetBtn.className = "mini";
    resetBtn.textContent = I18n.t("恢复默认");
    resetBtn.title = I18n.t("清除自定义路径，回到应用默认数据目录");

    const openBtn = document.createElement("button");
    openBtn.className = "mini";
    openBtn.textContent = I18n.t("打开目录");
    openBtn.title = I18n.t("在资源管理器中打开当前配置数据目录");

    let rootInfo = null;
    const refreshRoot = async () => {
      try {
        rootInfo = await window.api.dataGetRoot();
      } catch (e) {
        rootInfo = { ok: false, error: e.message || String(e) };
      }
      if (!rootInfo || !rootInfo.ok) {
        pathEl.textContent = (rootInfo && rootInfo.error) || I18n.t("未知错误");
        changeBtn.disabled = true;
        resetBtn.disabled = true;
        return;
      }
      pathEl.textContent = rootInfo.path || "";
      const locked = !!rootInfo.envLocked;
      changeBtn.disabled = locked;
      resetBtn.disabled = locked || !rootInfo.isCustom;
      if (locked) {
        changeBtn.title = I18n.t(
          "当前由环境变量 MTNODE_DATA_DIR 指定数据目录，无法在设置中更改",
        );
        resetBtn.title = changeBtn.title;
      }
    };
    refreshRoot();

    const relaunchAfter = async () => {
      toast(I18n.t("正在重启应用…"), "ok");
      try {
        await window.api.appRelaunch();
      } catch (e) {
        toast(I18n.t("重启失败：") + (e.message || String(e)), "err");
      }
    };

    changeBtn.onclick = async () => {
      if (
        !(await confirmDialog(
          I18n.t(
            "更改配置数据目录后需要重启应用才能生效。是否继续选择新目录？",
          ),
          { title: I18n.t("更改数据目录") },
        ))
      )
        return;
      const picked = await window.api.fileOpenDialog({
        title: I18n.t("选择配置数据目录"),
        directory: true,
      });
      const next = picked && picked.path;
      if (!next) return;
      const migrate = await confirmDialog(
        I18n.t("是否将现有配置（API Key、画布等）复制到新目录？") +
          "\n\n" +
          I18n.t("若新目录已有 config.json，则不会覆盖。"),
        { title: I18n.t("迁移配置"), okText: I18n.t("复制"), cancelText: I18n.t("不复制") },
      );
      try {
        const r = await window.api.dataSetRoot({ path: next, migrate });
        if (!r || !r.ok) {
          toast(
            I18n.t("更改失败：") +
              ((r && r.error) || I18n.t("未知错误")),
            "err",
          );
          return;
        }
        if (r.unchanged) {
          toast(I18n.t("目录未变化"), "ok");
          return;
        }
        if (
          !(await confirmDialog(
            I18n.t("配置数据目录已更新。需要立即重启应用才能生效，是否现在重启？"),
            { title: I18n.t("重启应用"), okText: I18n.t("立即重启") },
          ))
        ) {
          toast(I18n.t("已保存新路径，请手动重启应用后生效"), "ok");
          await refreshRoot();
          return;
        }
        await relaunchAfter();
      } catch (e) {
        toast(I18n.t("更改失败：") + (e.message || String(e)), "err");
      }
    };

    resetBtn.onclick = async () => {
      if (
        !(await confirmDialog(
          I18n.t(
            "恢复默认配置数据目录后需要重启应用才能生效。是否继续？",
          ),
          { title: I18n.t("恢复默认目录"), danger: true },
        ))
      )
        return;
      try {
        const r = await window.api.dataSetRoot({ path: null });
        if (!r || !r.ok) {
          toast(
            I18n.t("更改失败：") +
              ((r && r.error) || I18n.t("未知错误")),
            "err",
          );
          return;
        }
        if (
          !(await confirmDialog(
            I18n.t("已恢复默认目录。需要立即重启应用才能生效，是否现在重启？"),
            { title: I18n.t("重启应用"), okText: I18n.t("立即重启") },
          ))
        ) {
          toast(I18n.t("已恢复默认路径，请手动重启应用后生效"), "ok");
          await refreshRoot();
          return;
        }
        await relaunchAfter();
      } catch (e) {
        toast(I18n.t("更改失败：") + (e.message || String(e)), "err");
      }
    };

    openBtn.onclick = async () => {
      const r = await window.api.dataOpenRoot();
      if (!r || !r.ok)
        toast(
          I18n.t("无法打开目录：") +
            ((r && r.error) || I18n.t("未知错误")),
          "err",
        );
    };

    btnRow.appendChild(changeBtn);
    btnRow.appendChild(resetBtn);
    btnRow.appendChild(openBtn);
    sec.appendChild(btnRow);
    body.appendChild(sec);
  }

  /* ── 画布备份（每 5 分钟自动快照到独立备份文件夹）── */
  {
    const sec = document.createElement("div");
    sec.className = "settings-sec";
    const secTitle = document.createElement("div");
    secTitle.className = "settings-sec-title";
    secTitle.textContent = I18n.t("画布备份");
    sec.appendChild(secTitle);

    const hint = document.createElement("div");
    hint.className = "n-field";
    hint.textContent = I18n.t(
      "每 5 分钟自动把各工作流的最新状态另存一份快照，放在与自动保存分开的 save-backups 文件夹（内容无变化不重复存），每条工作流保留最近 72 份；误删或改坏时可从备份文件夹找回。",
    );
    sec.appendChild(hint);

    const statusEl = document.createElement("div");
    statusEl.className = "n-field";
    statusEl.style.fontSize = "12px";
    statusEl.style.opacity = "0.9";
    statusEl.textContent = I18n.t("正在读取备份状态…");
    sec.appendChild(statusEl);

    const btnRow = document.createElement("div");
    btnRow.className = "n-field";
    btnRow.style.flexDirection = "row";
    btnRow.style.gap = "8px";
    btnRow.style.flexWrap = "wrap";

    const openBakBtn = document.createElement("button");
    openBakBtn.className = "mini";
    openBakBtn.textContent = I18n.t("打开备份文件夹");
    openBakBtn.title = I18n.t("在资源管理器中打开工作流备份目录");
    openBakBtn.onclick = async () => {
      const r = await window.api.wfBackupOpen();
      if (!r || !r.ok)
        toast(
          I18n.t("无法打开目录：") +
            ((r && r.error) || I18n.t("未知错误")),
          "err",
        );
      refreshBak();
    };
    btnRow.appendChild(openBakBtn);
    sec.appendChild(btnRow);

    const refreshBak = async () => {
      try {
        const st = await window.api.wfBackupStatus();
        if (!st || !st.ok) {
          statusEl.textContent =
            I18n.t("无法读取：") + ((st && st.error) || I18n.t("未知错误"));
          return;
        }
        const bits = [
          I18n.t("备份目录：") + (st.dir || ""),
          (st.count || 0) + " " + I18n.t("份"),
        ];
        if (st.latest)
          bits.push(
            I18n.t("最近更新：") + new Date(st.latest).toLocaleString(),
          );
        statusEl.textContent = bits.join(" · ");
      } catch (e) {
        statusEl.textContent = I18n.t("无法读取：") + (e.message || String(e));
      }
    };
    refreshBak();
    body.appendChild(sec);
  }

  /* ── 错误与崩溃日志（自动保存，可导出提交给开发者）── */
  {
    const sec = document.createElement("div");
    sec.className = "settings-sec";
    const secTitle = document.createElement("div");
    secTitle.className = "settings-sec-title";
    secTitle.textContent = I18n.t("错误与崩溃日志");
    sec.appendChild(secTitle);

    const hint = document.createElement("div");
    hint.className = "n-field";
    hint.textContent = I18n.t(
      "应用内部错误与崩溃会自动写入本地诊断日志（不含 API Key）。导出后可发给开发者协助排查。",
    );
    sec.appendChild(hint);

    const statusEl = document.createElement("div");
    statusEl.className = "n-field";
    statusEl.style.fontSize = "12px";
    statusEl.style.opacity = "0.9";
    statusEl.textContent = I18n.t("正在读取日志状态…");
    sec.appendChild(statusEl);

    const btnRow = document.createElement("div");
    btnRow.className = "n-field";
    btnRow.style.flexDirection = "row";
    btnRow.style.gap = "8px";
    btnRow.style.flexWrap = "wrap";

    const exportBtn = document.createElement("button");
    exportBtn.className = "mini";
    exportBtn.textContent = I18n.t("导出诊断日志…");
    exportBtn.title = I18n.t("打包环境信息与近期错误日志为 .txt，便于提交");

    const openLogsBtn = document.createElement("button");
    openLogsBtn.className = "mini";
    openLogsBtn.textContent = I18n.t("打开日志文件夹");
    openLogsBtn.title = I18n.t("在资源管理器中打开自动保存的日志目录");

    const refreshStatus = async () => {
      try {
        const st = await window.api.crashStatus();
        if (!st || !st.ok) {
          statusEl.textContent =
            I18n.t("无法读取：") + ((st && st.error) || I18n.t("未知错误"));
          return;
        }
        const bits = [];
        bits.push(I18n.t("日志目录：") + (st.logsDir || ""));
        if (st.errorBytes)
          bits.push(
            I18n.t("error.log：") +
              Math.max(1, Math.round(st.errorBytes / 1024)) +
              " KB" +
              (st.errorMtime ? " · " + st.errorMtime : ""),
          );
        else bits.push(I18n.t("尚无 error.log"));
        if (st.latestReport)
          bits.push(
            I18n.t("最近崩溃报告：") +
              st.latestReport.name +
              (st.latestReport.mtime ? " · " + st.latestReport.mtime : ""),
          );
        else bits.push(I18n.t("尚无崩溃报告"));
        if (st.reportCount)
          bits.push(I18n.t("已保存报告数：") + st.reportCount);
        statusEl.textContent = bits.join("\n");
        statusEl.style.whiteSpace = "pre-wrap";
      } catch (e) {
        statusEl.textContent =
          I18n.t("无法读取：") + (e.message || String(e));
      }
    };
    refreshStatus();

    exportBtn.onclick = async () => {
      exportBtn.disabled = true;
      try {
        const r = await window.api.crashExport();
        if (r && r.canceled) return;
        if (!r || !r.ok) {
          toast(
            I18n.t("导出失败：") + ((r && r.error) || I18n.t("未知错误")),
            "err",
          );
          return;
        }
        toast(I18n.t("诊断日志已导出，请将该文件发送给开发者"), "ok");
        await refreshStatus();
      } catch (e) {
        toast(I18n.t("导出失败：") + (e.message || String(e)), "err");
      } finally {
        exportBtn.disabled = false;
      }
    };

    openLogsBtn.onclick = async () => {
      const r = await window.api.crashOpenLogs();
      if (!r || !r.ok)
        toast(
          I18n.t("无法打开目录：") +
            ((r && r.error) || I18n.t("未知错误")),
          "err",
        );
    };

    btnRow.appendChild(exportBtn);
    btnRow.appendChild(openLogsBtn);
    sec.appendChild(btnRow);
    body.appendChild(sec);
  }

  /* ── 智能能力（dsh）区块 ── */
  const dshEls = {};
  {
    const sec = document.createElement("div");
    sec.className = "settings-sec";
    const secTitle = document.createElement("div");
    secTitle.className = "settings-sec-title";
    secTitle.textContent = I18n.t("智能能力（DeepSeek Harness / dsh）");
    sec.appendChild(secTitle);

    const modelRow = document.createElement("label");
    modelRow.className = "n-field";
    modelRow.appendChild(document.createTextNode(I18n.t("默认模型（智能能力使用）")));
    const modelSel = document.createElement("select");
    {
      /* 默认模型下拉 = 全部文本服务商的模型（分组列出，与智能会话 / 全局助手同源）：
         旧实现只取第一个 DeepSeek 兼容服务商（dshProvider()），导致非 DeepSeek
         服务商用户的默认模型被强制指定成 deepseek 模型。 */
      const groups = [];
      const dp = dshProvider();
      if (dp && Array.isArray(dp.models) && dp.models.length)
        groups.push({
          label: (dp && dp.name) || I18n.t("DeepSeek 官方"),
          models: dp.models.map((m) => String(m)),
        });
      for (const p of mtnodePiProviders()) {
        const models = (p && p.models) || [];
        if (!models.length) continue;
        groups.push({ label: p.name, models: models.map((m) => String(m)) });
      }
      /* 当前值：已保存的 dsh.model 优先；从未保存则跟随实际生效的默认智能路由
         （preferredAgentProviderRoute 优先其它文本服务商），不再硬编码 deepseek */
      let cur = (S.config.dsh && S.config.dsh.model) || "";
      if (!cur) {
        try {
          cur =
            preferredAgentModelForRoute(preferredAgentProviderRoute()) || "";
        } catch (_) {}
      }
      const all = [];
      for (const g of groups) {
        const og = document.createElement("optgroup");
        og.label = g.label;
        for (const m of g.models) {
          all.push(m);
          const o = document.createElement("option");
          o.value = m;
          o.textContent = m;
          og.appendChild(o);
        }
        modelSel.appendChild(og);
      }
      /* 保底：老配置里保存过、但已不在任何服务商模型清单中的值，也要能显示出来 */
      if (cur && all.indexOf(cur) < 0) {
        all.push(cur);
        const o = document.createElement("option");
        o.value = cur;
        o.textContent = cur;
        modelSel.appendChild(o);
      }
      if (!all.length) {
        const o = document.createElement("option");
        o.value = "";
        o.textContent = I18n.t("（无可用模型）");
        modelSel.appendChild(o);
      }
      modelSel.value = cur;
    }
    modelRow.appendChild(modelSel);
    sec.appendChild(modelRow);
    dshEls.model = modelSel;

    /* agent 预设(迁移自 dsh 的 agent-presets) */
    const presetRow = document.createElement("label");
    presetRow.className = "n-field";
    presetRow.appendChild(
      document.createTextNode(I18n.t("Agent 预设（智能能力的角色与行为风格）")),
    );
    const presetSel = document.createElement("select");
    /* 档位真源：app.js 的 AGENT_PRESETS（与智能会话 / 智能节点面板同一张表），
       这里只用带说明的 settingsLabelKey */
    for (const p of AGENT_PRESETS) {
      const o = document.createElement("option");
      o.value = p.id;
      o.textContent = I18n.t(p.settingsLabelKey || p.labelKey);
      if (p.hint) o.title = I18n.t(p.hint);
      presetSel.appendChild(o);
    }
    presetSel.value = S.config.dsh.preset || AGENT_PRESET_DEFAULT;
    presetRow.appendChild(presetSel);
    sec.appendChild(presetRow);
    dshEls.preset = presetSel;

    /* Agent 语言口味：跟随顶栏「中 / EN」的语言选择（无独立开关，纯派生），
       这里只把「agent 会用哪种语言交流并期望被这样回答」摊开给用户看见 */
    const langTasteHint = document.createElement("div");
    langTasteHint.className = "settings-hint";
    langTasteHint.textContent =
      I18n.t("交流语言（Agent 口味）：") +
      (typeof I18n.agentLangLabel === "function"
        ? I18n.agentLangLabel()
        : I18n.getLocale && I18n.getLocale()) +
      I18n.t(
        " —— 智能会话、智能节点与全局助手都用该语言交流，并期望 agent 用该语言回答；顶栏「中 / EN」切换即生效。",
      );
    sec.appendChild(langTasteHint);

    /* 权限预设(dsh permission-presets:沙箱模式 + 审批策略,热重载生效) */
    const permRow = document.createElement("label");
    permRow.className = "n-field";
    permRow.appendChild(
      document.createTextNode(
        I18n.t("权限预设（沙箱模式 + 审批策略；“逐项审批”档位会在任务需要越权时弹窗询问）"),
      ),
    );
    const permSel = document.createElement("select");
    const PERM_OPTIONS = permissionPresetOptions();
    for (const [v, l] of PERM_OPTIONS) {
      const o = document.createElement("option");
      o.value = v;
      o.textContent = l;
      permSel.appendChild(o);
    }
    permSel.value = S.config.dsh.permissionPreset || "mtnode-unattended";
    permRow.appendChild(permSel);
    sec.appendChild(permRow);
    dshEls.permissionPreset = permSel;

    /* 防失控开关：节点跑完是否自动接力下游（默认关；连跑请用控制节点 ▶） */
    const cascRow = document.createElement("label");
    cascRow.className = "n-field";
    cascRow.style.flexDirection = "row";
    cascRow.style.alignItems = "center";
    const cascCb = document.createElement("input");
    cascCb.type = "checkbox";
    try {
      cascCb.checked = localStorage.getItem("mtnode.autoRunDownstream") === "1";
    } catch {
      cascCb.checked = false;
    }
    cascCb.onchange = () => setAutoRunDownstream(cascCb.checked);
    cascRow.appendChild(cascCb);
    cascRow.appendChild(
      document.createTextNode(
        I18n.t("节点完成后自动执行下游（默认关：连跑请用控制节点 ▶）"),
      ),
    );
    sec.appendChild(cascRow);

    /* 完成音效:长任务(超过 5 分钟)结束时短促提示;可替换音频文件并试听 */
    const sndRow = document.createElement("label");
    sndRow.className = "n-field";
    sndRow.style.flexDirection = "row";
    sndRow.style.alignItems = "center";
    const sndCb = document.createElement("input");
    sndCb.type = "checkbox";
    sndCb.checked = S.config.dsh.doneSound !== false;
    sndRow.appendChild(sndCb);
    sndRow.appendChild(
      document.createTextNode(
        I18n.t("任务完成音效（仅当智能任务运行超过 5 分钟后完成时触发）"),
      ),
    );
    sec.appendChild(sndRow);
    dshEls.doneSound = sndCb;
    const sndFileRow = document.createElement("div");
    sndFileRow.className = "dsh-btn-row";
    const sndFile = document.createElement("input");
    sndFile.type = "text";
    sndFile.placeholder = I18n.t("自定义音效文件（mp3 / wav / ogg，留空 = 内置提示音）");
    sndFile.value = S.config.dsh.doneSoundFile || "";
    sndFile.style.flex = "1";
    sndFile.readOnly = true;
    const sndPick = document.createElement("button");
    sndPick.className = "mini";
    sndPick.textContent = I18n.t("替换…");
    sndPick.onclick = async () => {
      const r = await window.api.fileOpenDialog({
        title: I18n.t("选择完成音效"),
        filters: [{ name: I18n.t("音频"), extensions: ["mp3", "wav", "ogg", "m4a"] }],
      });
      if (r && r.path) sndFile.value = r.path;
    };
    const sndPlay = document.createElement("button");
    sndPlay.className = "mini";
    sndPlay.textContent = I18n.t("试听");
    sndPlay.onclick = () => previewDoneSound(sndFile.value.trim() || (S.config.dsh && S.config.dsh.doneSoundFile) || "");
    const sndClear = document.createElement("button");
    sndClear.className = "mini";
    sndClear.textContent = I18n.t("清除");
    sndClear.onclick = () => { sndFile.value = ""; };
    sndFileRow.appendChild(sndFile);
    sndFileRow.appendChild(sndPick);
    sndFileRow.appendChild(sndPlay);
    sndFileRow.appendChild(sndClear);
    sec.appendChild(sndFileRow);
    dshEls.doneSoundFile = sndFile;

    /* 提问/审批提示音:模型请求等待回应时短促提示;可替换音频文件并试听 */
    const askRow = document.createElement("label");
    askRow.className = "n-field";
    askRow.style.flexDirection = "row";
    askRow.style.alignItems = "center";
    const askCb = document.createElement("input");
    askCb.type = "checkbox";
    askCb.checked = S.config.dsh.askSound !== false;
    askRow.appendChild(askCb);
    askRow.appendChild(document.createTextNode(I18n.t("提问/审批提示音（模型等待你回应时弹出并提示）")));
    sec.appendChild(askRow);
    dshEls.askSound = askCb;
    const askFileRow = document.createElement("div");
    askFileRow.className = "dsh-btn-row";
    const askFile = document.createElement("input");
    askFile.type = "text";
    askFile.placeholder = I18n.t("自定义提示音文件（mp3 / wav / ogg，留空 = 内置短促提示音）");
    askFile.value = S.config.dsh.askSoundFile || "";
    askFile.style.flex = "1";
    askFile.readOnly = true;
    const askPick = document.createElement("button");
    askPick.className = "mini";
    askPick.textContent = I18n.t("替换…");
    askPick.onclick = async () => {
      const r = await window.api.fileOpenDialog({
        title: I18n.t("选择提示音"),
        filters: [{ name: I18n.t("音频"), extensions: ["mp3", "wav", "ogg", "m4a"] }],
      });
      if (r && r.path) askFile.value = r.path;
    };
    const askPlay = document.createElement("button");
    askPlay.className = "mini";
    askPlay.textContent = I18n.t("试听");
    askPlay.onclick = () => {
      if (!playDoneSoundFile(askFile.value.trim() || (S.config.dsh && S.config.dsh.askSoundFile) || "")) builtinIxBeep();
    };
    const askClear = document.createElement("button");
    askClear.className = "mini";
    askClear.textContent = I18n.t("清除");
    askClear.onclick = () => { askFile.value = ""; };
    askFileRow.appendChild(askFile);
    askFileRow.appendChild(askPick);
    askFileRow.appendChild(askPlay);
    askFileRow.appendChild(askClear);
    sec.appendChild(askFileRow);
    dshEls.askSoundFile = askFile;

    /* 精简工具负载：本轮运行时干脆不注册「这次用不上」的可选工具（mtnode_app /
       mtnode_vision），每一次模型调用都少重发约 4.7K 字符的工具定义。默认关 =
       行为与此前逐字一致。画布智能节点另有一层裁剪（宿主本来就拒收画布工具，
       其定义一律不发），与本开关无关、始终生效。
       实测口径与取舍见 docs/codex-agent-benchmark.md「本轮落地：Token 开销」。 */
    const leanRow = document.createElement("label");
    leanRow.className = "n-field";
    leanRow.style.flexDirection = "row";
    leanRow.style.alignItems = "center";
    const leanCb = document.createElement("input");
    leanCb.type = "checkbox";
    leanCb.checked = S.config.dsh.leanToolPayload === true;
    leanRow.appendChild(leanCb);
    leanRow.appendChild(
      document.createTextNode(
        I18n.t(
          "精简工具负载（不注册「应用操作 / 识图子代理」等可选工具，每步少发约 4.7K 字符；下一轮运行生效）",
        ),
      ),
    );
    sec.appendChild(leanRow);
    dshEls.leanToolPayload = leanCb;

    /* ── 扩展能力（DSH 插件 / 技能 Skills / MCP 服务器）：设置里只留一个整合界面，
       真正的清单与增删改全部收进「管理」对话框（样式统一沿用 DSH 插件那套卡片）。── */
    const extTitle = document.createElement("div");
    extTitle.className = "settings-sec-title settings-sec-title-row";
    extTitle.style.marginTop = "8px";
    const extTitleSpan = document.createElement("span");
    extTitleSpan.textContent = I18n.t(
      "扩展能力（DSH 插件 · 技能 Skills · MCP 服务器）",
    );
    extTitle.appendChild(extTitleSpan);
    const extTitleBtns = document.createElement("div");
    extTitleBtns.className = "dsh-btn-row";
    const extBrowseBtn = document.createElement("button");
    extBrowseBtn.className = "mini";
    extBrowseBtn.textContent = I18n.t("🌐 在线浏览");
    extBrowseBtn.title = I18n.t(
      "在线浏览:线上目录(插件 / 技能 / MCP),可安装与卸载",
    );
    extBrowseBtn.onclick = () => {
      closeExtManagerDialog();
      openStoreDialog();
    };
    extTitleBtns.appendChild(extBrowseBtn);
    extTitle.appendChild(extTitleBtns);
    sec.appendChild(extTitle);

    const extHintRow = document.createElement("div");
    extHintRow.className = "dsh-plugin-manage-row";
    const extHint = document.createElement("div");
    extHint.className = "dsh-plugin-empty";
    extHint.textContent = I18n.t("（读取中…）");
    const extManage = document.createElement("button");
    extManage.className = "mini primary";
    extManage.textContent = I18n.t("管理…");
    extManage.onclick = () => openExtManagerDialog("dsh");
    extHintRow.appendChild(extHint);
    extHintRow.appendChild(extManage);
    sec.appendChild(extHintRow);
    EXT_UI.hintEl = extHint;
    refreshExtInventory();

    body.appendChild(sec);
  }
  dshEls.collect = () => ({
    model: dshEls.model.value.trim(),
    preset: dshEls.preset.value,
    chatEnter: enterSelEl ? enterSelEl.value : "send",
    permissionPreset: dshEls.permissionPreset.value,
    doneSound: dshEls.doneSound.checked,
    doneSoundFile: dshEls.doneSoundFile ? dshEls.doneSoundFile.value.trim() : (S.config.dsh && S.config.dsh.doneSoundFile) || "",
    askSound: dshEls.askSound ? dshEls.askSound.checked : (S.config.dsh && S.config.dsh.askSound) !== false,
    askSoundFile: dshEls.askSoundFile ? dshEls.askSoundFile.value.trim() : (S.config.dsh && S.config.dsh.askSoundFile) || "",
    leanToolPayload: dshEls.leanToolPayload
      ? !!dshEls.leanToolPayload.checked
      : !!(S.config.dsh && S.config.dsh.leanToolPayload),
    theme: themeSelEl ? themeSelEl.value : (S.config.dsh && S.config.dsh.theme) || "industrial",
  });

  /* ── 模型服务:标题 + 添加服务商按钮同行 ── */
  const provTitleRow = document.createElement("div");
  provTitleRow.className = "settings-sec-title settings-sec-title-row";
  const provTitleSpan = document.createElement("span");
  provTitleSpan.textContent = I18n.t("模型服务");
  const provHint = document.createElement("span");
  provHint.className = "settings-hint";
  provHint.style.cssText = "margin:0 0 0 10px; padding:2px 8px; border:0; display:inline";
  provHint.textContent = I18n.t("（供应商与模型均可排序，越靠前优先级越高）");
  provTitleRow.appendChild(provTitleSpan);
  provTitleRow.appendChild(provHint);
  const add = document.createElement("button");
  add.className = "mini";
  add.textContent = I18n.t("＋ 添加服务商");
  add.title = I18n.t("从服务商目录选择或手动配置");
  add.onclick = () => addProviderDialog();
  provTitleRow.appendChild(add);
  body.appendChild(provTitleRow);

  const list = document.createElement("div");
  list.style.marginTop = "10px";
  S.config.providers.forEach((p, i) => list.appendChild(provCard(p, i, list)));
  body.appendChild(list);

  const foot = $("#ovFoot");
  const save = document.createElement("button");
  save.className = "mini primary";
  save.textContent = I18n.t("保存设置");
  save.onclick = async () => {
    const snap = Math.max(4, Math.min(64, Number(snapInp.value) || 24));
    S.config.snap = snap;

    if (netPortInp) S.config.netPort = Math.max(1, Math.min(65535, Number(netPortInp.value) || NET_DEFAULT_PORT));
    for (const p of S.config.providers) {
      p.name = String(p.name || "").trim();
      p.baseUrl = String(p.baseUrl || "").trim();
      p.apiKey = String(p.apiKey || "").trim();
      if (Array.isArray(p.models)) {
        p.models = p.models.map((m) => String(m || "").trim()).filter(Boolean);
      } else {
        p.models = String(p.models || "")
          .split(",")
          .map((m) => m.trim())
          .filter(Boolean);
      }
    }
    S.config.providers = S.config.providers.filter((p) => p.name);
    S.config.dsh = Object.assign(
      {
        enabled: true,
        nodePath: "",
        model: "",
        preset: AGENT_PRESET_DEFAULT,
        chatEnter: "send",
        permissionPreset: "mtnode-unattended",
        doneSound: true,
        askSound: true,
        theme: "industrial",
      },
      S.config.dsh || {},
      dshEls.collect(),
    );
    await window.api.configSave(S.config);
    closeOverlay();
    renderCanvas();
    renderStatus();
    paintApprovalsBtn();

    toast(I18n.t("设置已保存（") + S.config.providers.length + I18n.t(" 个服务商）"), "ok");
  };
  const storageBtn = document.createElement("button");
  storageBtn.className = "mini";
  storageBtn.textContent = I18n.t("打开存档位置");
  storageBtn.title = I18n.t("打开画布保存的文件夹");
  storageBtn.onclick = async () => {
    const r = await window.api.storageOpen();
    if (!r || !r.ok)
      toast(
        I18n.t("无法打开存档位置：") + (r && r.error ? r.error : I18n.t("未知错误")),
        "err",
      );
  };
  const helpBtn = document.createElement("button");
  helpBtn.className = "mini";
  helpBtn.textContent = I18n.t("查看说明");
  helpBtn.title = I18n.t("打开使用说明");
  helpBtn.onclick = openHelp;
  const cancel = document.createElement("button");
  cancel.className = "mini";
  cancel.textContent = I18n.t("取消");
  cancel.onclick = closeOverlay;
  foot.appendChild(storageBtn);
  foot.appendChild(helpBtn);
  const spacer = document.createElement("span");
  spacer.style.flex = "1";
  foot.appendChild(spacer);
  foot.appendChild(cancel);
  foot.appendChild(save);
}

/* 目录中可添加的服务商(与 dsh 一致的全部内置服务商):
   每个服务商取其首选 api(优先 openai-completions,否则首个 api),
   baseUrl 取自同 api 的首个模型,模型列表 = 该 api 的模型。 */
function catalogAddableProviders() {
  const out = [];
  const c = S.providerCatalog || { deepseek: [], piai: [] };
  const official = c.deepseek || [];
  if (official.length)
    out.push({
      id: "deepseek-official",
      name: I18n.t("DeepSeek 官方"),
      api: "openai-completions",
      baseUrl: (official[0] && official[0].baseUrl) || "https://api.deepseek.com",
      models: official,
    });
  for (const p of c.piai || []) {
    const models = p.models || [];
    if (!models.length) continue;
    let api = "";
    for (const m of models) {
      if (m.api === "openai-completions") {
        api = m.api;
        break;
      }
    }
    if (!api) api = models[0].api || "openai-completions";
    const same = models.filter((m) => (m.api || "openai-completions") === api);
    const first = same[0];
    out.push({
      id: p.id,
      name: p.id,
      api,
      baseUrl: (first && first.baseUrl) || "",
      models: same,
    });
  }
  return out;
}

/* 粘贴导入:把剪贴板 / 粘贴的配置文字解析为服务商字段
   (名称 / 接口地址 / API Key / 模型 / 类型)。按优先级尝试三种格式:
   1) JSON 对象(含 name/baseUrl/apiKey/models 等字段,models 可为数组或逗号分隔字符串)
   2) 逐行「字段名: 值」或「字段名=值」(中英文键名均可;模型可多行,值可逗号/分号分隔)
   3) 纯逐行位置:第1行=名称,第2行=接口地址,第3行=API Key,其余行=模型(每行可再拆分) */
function parseProviderText(text) {
  const t = String(text || "").replace(/^\uFEFF/, "").trim();
  if (!t) return { ok: false, error: I18n.t("粘贴内容为空") };
  const clean = (v) =>
    String(v == null ? "" : v)
      .trim()
      .replace(/^["'“”‘’]+|["'“”‘’]+$/g, "")
      .trim();
  const normKey = (k) =>
    String(k || "").trim().toLowerCase().replace(/[\s_-]+/g, "").replace(/[：:]/g, "");
  const splitModels = (val) => {
    const out = [];
    for (const id of String(val).split(/[,，;；\n]+/)) {
      const x = clean(id);
      if (x) out.push(x);
    }
    return out;
  };

  /* 1) JSON */
  if (t[0] === "{" || t[0] === "[") {
    try {
      const obj = JSON.parse(t);
      const src = Array.isArray(obj) ? obj[0] : obj;
      if (src && typeof src === "object") {
        const data = {
          name: clean(src.name || src.title || src.provider || src.providerName),
          baseUrl: clean(
            src.baseUrl || src.base_url || src.url || src.endpoint || src.apiBase || src.api_base,
          ),
          apiKey: clean(
            src.apiKey || src.api_key || src.key || src.token || src.secret || src.secretKey,
          ),
          type: clean(src.type || src.api || src.kind),
          models: [],
        };
        if (Array.isArray(src.models)) {
          for (const m of src.models) {
            const id = clean(m && typeof m === "object" ? m.id || m.model || m.name : m);
            if (id) data.models.push(id);
          }
        } else if (typeof src.models === "string") {
          data.models = splitModels(src.models);
        }
        if (data.name || data.baseUrl || data.apiKey || data.type || data.models.length)
          return { ok: true, data };
      }
    } catch {}
    return { ok: false, error: I18n.t("JSON 解析失败：请确认内容为有效的 JSON 配置") };
  }

  /* 2) 逐行「字段名: 值」/「字段名=值」(中英文键名) */
  const KEY_MAP = [
    [
      "name",
      ["name", "title", "provider", "providername", "服务商名称", "服务商", "供应商", "名称", "名字"],
    ],
    [
      "baseUrl",
      [
        "baseurl",
        "baseurl地址",
        "base_url",
        "api_base",
        "apibase",
        "url",
        "接口地址",
        "接口",
        "地址",
        "endpoint",
        "api地址",
        "服务器地址",
      ],
    ],
    [
      "apiKey",
      ["apikey", "api_key", "api-key", "api密钥", "api key", "key", "密钥", "token", "secret", "sk", "授权码", "authorization"],
    ],
    ["models", ["models", "model", "模型列表", "模型id", "模型", "modelslist", "modelids"]],
    ["type", ["type", "类型", "api类型", "apitype", "kind", "api"]],
  ];
  const data = { name: "", baseUrl: "", apiKey: "", type: "", models: [] };
  let labeledHits = 0;
  const extra = [];
  const lines = t.split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim().replace(/^[-*•·#>\d.)、\s]+/, "");
    if (!line) continue;
    const m = line.match(/^([^=:：]+?)\s*[:=：]\s*(.*)$/);
    if (!m) {
      extra.push(line);
      continue;
    }
    const key = normKey(m[1]);
    const val = clean(m[2]);
    if (!key || !val) continue;
    let field = null;
    for (const [f, keys] of KEY_MAP) {
      if (keys.some((k) => normKey(k) === key)) {
        field = f;
        break;
      }
    }
    if (!field) continue;
    labeledHits++;
    if (field === "models") data.models = data.models.concat(splitModels(val));
    else if (!data[field]) data[field] = val;
  }
  if (labeledHits) {
    /* 无分隔符的整行并入模型(如「模型:」后另起一行的模型名);
       跳过疑似 Key / URL,避免把密钥误当模型 */
    for (const e of extra) {
      const x = clean(e);
      if (!x) continue;
      if (/^https?:\/\//i.test(x)) continue;
      if (/^sk[-_]?[a-z0-9]/i.test(x)) continue;
      if (!data.models.includes(x)) data.models.push(x);
    }
    return { ok: true, data };
  }

  /* 3) 纯逐行位置 */
  const pos = lines.map(clean).filter(Boolean);
  if (pos.length >= 2) {
    data.name = pos[0];
    data.baseUrl = pos[1];
    if (pos[2] && !/^https?:\/\//i.test(pos[2])) data.apiKey = pos[2];
    for (let i = 3; i < pos.length; i++) data.models = data.models.concat(splitModels(pos[i]));
    return { ok: true, data };
  }

  return {
    ok: false,
    error: I18n.t(
      "未能识别配置：请使用「字段名: 值」逐行、JSON 或「名称/接口地址/API Key/模型」顺序粘贴",
    ),
  };
}

/* 把粘贴 / JSON 里的类型写法归一为设置页类型值(text_openai 等) */
function normalizeProviderType(t) {
  const v = String(t || "").trim().toLowerCase();
  if (!v) return "text_openai";
  if (v.includes("stability") || v === "image_stability") return "image_stability";
  if (v.includes("midjourney") || v === "image_mj" || v === "mj") return "image_mj";
  if (v.includes("图像") || v.includes("image") || v.includes("images/generations"))
    return "image_openai";
  return "text_openai";
}

/* 添加服务商:从目录选择(选服务商 → 输 Key → 自动载入模型列表)、粘贴导入或手动配置 */
function addProviderDialog() {
  openOverlay(I18n.t("添加服务商"));
  overlayPersistent = true;
  const body = $("#ovBody");
  const srcRow = document.createElement("label");
  srcRow.className = "n-field";
  srcRow.style.flexDirection = "row";
  srcRow.style.alignItems = "center";
  srcRow.appendChild(document.createTextNode(I18n.t("来源：")));
  const srcSel = document.createElement("select");
  {
    const o1 = document.createElement("option");
    o1.value = "catalog";
    o1.textContent = I18n.t("从服务商目录选择（推荐）");
    const o2 = document.createElement("option");
    o2.value = "manual";
    o2.textContent = I18n.t("手动配置");
    srcSel.appendChild(o1);
    srcSel.appendChild(o2);
    const o3 = document.createElement("option");
    o3.value = "paste";
    o3.textContent = I18n.t("粘贴导入（一键解析）");
    srcSel.appendChild(o3);
  }
  srcRow.appendChild(srcSel);
  body.appendChild(srcRow);

  /* 目录模式容器 */
  const catBox = document.createElement("div");
  catBox.className = "store-form";
  const provRow = document.createElement("label");
  provRow.className = "n-field";
  provRow.appendChild(document.createTextNode(I18n.t("服务商")));
  const provSel = document.createElement("select");
  const provOpt = document.createElement("option");
  provOpt.value = "";
  provOpt.textContent = I18n.t("（读取目录中…）");
  provSel.appendChild(provOpt);
  provSel.disabled = true;
  provRow.appendChild(provSel);
  catBox.appendChild(provRow);
  const nameRow = document.createElement("label");
  nameRow.className = "n-field";
  nameRow.appendChild(document.createTextNode(I18n.t("名称")));
  const nameInp = document.createElement("input");
  nameInp.type = "text";
  nameRow.appendChild(nameInp);
  catBox.appendChild(nameRow);
  const keyRow = document.createElement("label");
  keyRow.className = "n-field";
  keyRow.appendChild(document.createTextNode("API Key"));
  const keyWrap = document.createElement("div");
  keyWrap.style.display = "flex";
  keyWrap.style.gap = "4px";
  const keyInp = document.createElement("input");
  keyInp.type = "password";
  keyInp.placeholder = I18n.t("输入 API Key（隐藏显示，仅存本机）");
  keyInp.style.flex = "1";
  const keyTest = document.createElement("button");
  keyTest.type = "button";
  keyTest.className = "mini";
  keyTest.textContent = I18n.t("验证");
  keyTest.title = I18n.t("向服务商发起无 Token 消耗的校验请求");
  keyTest.onclick = async (ev) => {
    ev.preventDefault();
    const p = catalogAddableProviders().find((x) => x.id === provSel.value);
    await validateProviderApiKey(
      {
        type: "text_openai",
        baseUrl: (p && p.baseUrl) || "",
        apiKey: keyInp.value,
      },
      keyTest,
    );
  };
  keyWrap.appendChild(keyInp);
  keyWrap.appendChild(keyTest);
  keyRow.appendChild(keyWrap);
  catBox.appendChild(keyRow);
  const infoRow = document.createElement("div");
  infoRow.className = "settings-hint";
  infoRow.textContent = I18n.t("选择服务商后自动载入其模型列表与接口地址。");
  catBox.appendChild(infoRow);
  body.appendChild(catBox);

  /* 手动模式容器 */
  const manBox = document.createElement("div");
  manBox.className = "store-form";
  manBox.style.display = "none";
  const mName = document.createElement("label");
  mName.className = "n-field";
  mName.appendChild(document.createTextNode(I18n.t("名称")));
  const mNameInp = document.createElement("input");
  mNameInp.type = "text";
  mName.appendChild(mNameInp);
  manBox.appendChild(mName);
  const mType = document.createElement("label");
  mType.className = "n-field";
  mType.appendChild(document.createTextNode(I18n.t("类型")));
  const mTypeSel = document.createElement("select");
  for (const [v, l] of PROVIDER_TYPE_LABELS) {
    const o = document.createElement("option");
    o.value = v;
    o.textContent = I18n.t(l);
    mTypeSel.appendChild(o);
  }
  mType.appendChild(mTypeSel);
  manBox.appendChild(mType);
  const mUrl = document.createElement("label");
  mUrl.className = "n-field";
  mUrl.appendChild(document.createTextNode(I18n.t("接口地址 Base URL")));
  const mUrlInp = document.createElement("input");
  mUrlInp.type = "text";
  mUrl.appendChild(mUrlInp);
  manBox.appendChild(mUrl);
  const mKey = document.createElement("label");
  mKey.className = "n-field";
  mKey.appendChild(document.createTextNode(I18n.t("API Key（隐藏显示）")));
  const mKeyWrap = document.createElement("div");
  mKeyWrap.style.display = "flex";
  mKeyWrap.style.gap = "4px";
  const mKeyInp = document.createElement("input");
  mKeyInp.type = "password";
  mKeyInp.style.flex = "1";
  const mKeyTest = document.createElement("button");
  mKeyTest.type = "button";
  mKeyTest.className = "mini";
  mKeyTest.textContent = I18n.t("验证");
  mKeyTest.title = I18n.t("向服务商发起无 Token 消耗的校验请求");
  mKeyTest.onclick = async (ev) => {
    ev.preventDefault();
    await validateProviderApiKey(
      {
        type: mTypeSel.value,
        baseUrl: mUrlInp.value,
        apiKey: mKeyInp.value,
      },
      mKeyTest,
    );
  };
  mKeyWrap.appendChild(mKeyInp);
  mKeyWrap.appendChild(mKeyTest);
  mKey.appendChild(mKeyWrap);
  manBox.appendChild(mKey);
  const mModels = document.createElement("label");
  mModels.className = "n-field";
  mModels.appendChild(document.createTextNode(I18n.t("模型（逗号分隔）")));
  const mModelsInp = document.createElement("input");
  mModelsInp.type = "text";
  mModels.appendChild(mModelsInp);
  manBox.appendChild(mModels);
  body.appendChild(manBox);

  /* 粘贴导入容器 */
  const pasteBox = document.createElement("div");
  pasteBox.className = "store-form";
  pasteBox.style.display = "none";
  const pasteHint = document.createElement("div");
  pasteHint.className = "settings-hint";
  pasteHint.textContent = I18n.t(
    "把服务商配置文字粘贴到下方（支持「字段名: 值」逐行、JSON，或按 名称/接口地址/API Key/模型 顺序逐行），点「解析并填入」自动识别。",
  );
  pasteBox.appendChild(pasteHint);
  const pasteInp = document.createElement("textarea");
  pasteInp.rows = 8;
  pasteInp.placeholder =
    "名称: SiliconFlow\n接口地址: https://api.siliconflow.cn/v1\nAPI Key: sk-xxxx\n模型: deepseek-ai/DeepSeek-V3, Qwen/Qwen2.5-7B-Instruct";
  pasteInp.style.cssText =
    "width:100%; box-sizing:border-box; font-family:monospace; margin-top:8px;";
  pasteBox.appendChild(pasteInp);
  const pasteBtns = document.createElement("div");
  pasteBtns.style.cssText = "display:flex; gap:8px; margin-top:8px;";
  const pasteClip = document.createElement("button");
  pasteClip.type = "button";
  pasteClip.className = "mini";
  pasteClip.textContent = I18n.t("读取剪贴板");
  pasteClip.title = I18n.t("从系统剪贴板读取文字并解析");
  pasteClip.onclick = async (ev) => {
    ev.preventDefault();
    let txt = "";
    try {
      if (window.api && window.api.clipboardReadText) txt = await window.api.clipboardReadText();
    } catch {}
    if (!txt || !txt.trim()) {
      toast(I18n.t("剪贴板为空：请先复制配置文字再点此按钮"), "warn");
      return;
    }
    pasteInp.value = txt;
    doParsePaste();
  };
  const pasteGo = document.createElement("button");
  pasteGo.type = "button";
  pasteGo.className = "mini primary";
  pasteGo.textContent = I18n.t("解析并填入");
  pasteGo.title = I18n.t("按行解析并填入下方表单，可再核对修改");
  pasteGo.onclick = (ev) => {
    ev.preventDefault();
    doParsePaste();
  };
  pasteBtns.appendChild(pasteClip);
  pasteBtns.appendChild(pasteGo);
  pasteBox.appendChild(pasteBtns);
  body.appendChild(pasteBox);

  /* 解析成功 → 填入手动表单并切到手动模式,用户核对后点「添加」 */
  const doParsePaste = () => {
    const r = parseProviderText(pasteInp.value);
    if (!r.ok) {
      toast(r.error, "warn");
      return;
    }
    const d = r.data;
    if (d.name) mNameInp.value = d.name;
    if (d.baseUrl) mUrlInp.value = d.baseUrl;
    if (d.apiKey) mKeyInp.value = d.apiKey;
    if (Array.isArray(d.models) && d.models.length) mModelsInp.value = d.models.join(", ");
    const t = normalizeProviderType(d.type);
    if (PROVIDER_TYPE_LABELS.some(([v]) => v === t)) mTypeSel.value = t;
    srcSel.value = "manual";
    catBox.style.display = "none";
    manBox.style.display = "";
    pasteBox.style.display = "none";
    const parts = [];
    if (d.name) parts.push(I18n.t("名称 ") + d.name);
    if (d.baseUrl) parts.push(I18n.t("接口 ") + d.baseUrl);
    if (d.apiKey) parts.push(I18n.t("API Key 已填入"));
    if (d.models.length) parts.push(d.models.length + I18n.t(" 个模型"));
    toast(I18n.t("已解析并填入（请核对后点「添加」）：") + parts.join(" · "), "ok");
  };

  srcSel.addEventListener("change", () => {
    const manual = srcSel.value === "manual";
    const paste = srcSel.value === "paste";
    catBox.style.display = paste ? "none" : "";
    manBox.style.display = manual ? "" : "none";
    pasteBox.style.display = paste ? "" : "none";
  });

  const renderCatalog = () => {
    const provs = catalogAddableProviders();
    provSel.innerHTML = "";
    if (!provs.length) {
      const o = document.createElement("option");
      o.value = "";
      o.textContent = I18n.t("目录暂不可用（引擎未连接）");
      provSel.appendChild(o);
      provSel.disabled = true;
      return;
    }
    provSel.disabled = false;
    const og1 = document.createElement("optgroup");
    og1.label = I18n.t("DeepSeek 官方");
    const og2 = document.createElement("optgroup");
    og2.label = I18n.t("pi-ai 目录");
    for (const p of provs) {
      const o = document.createElement("option");
      o.value = p.id;
      o.textContent =
        p.name +
        " · " +
        p.api +
        "（" +
        p.models.length +
        I18n.t(" 个模型）");
      (p.id === "deepseek-official" ? og1 : og2).appendChild(o);
    }
    provSel.appendChild(og1);
    provSel.appendChild(og2);
    provSel.value = "deepseek-official";
    updateInfo();
  };
  const updateInfo = () => {
    const p = catalogAddableProviders().find((x) => x.id === provSel.value);
    nameInp.value = p ? p.name : "";
    infoRow.textContent = p
      ? I18n.t("已载入 ") +
        p.models.length +
        I18n.t(" 个模型 · 接口地址 ") +
        (p.baseUrl || I18n.t("（待定）")) +
        I18n.t(" · API 类型 ") +
        p.api +
        I18n.t("。保存后自动生成模型列表。")
      : "";
  };
  provSel.addEventListener("change", updateInfo);
  ensureProviderCatalog().then(renderCatalog).catch(renderCatalog);

  const foot = $("#ovFoot");
  const cancel = document.createElement("button");
  cancel.className = "mini";
  cancel.textContent = "取消";
  cancel.onclick = closeOverlay;
  const ok = document.createElement("button");
  ok.className = "mini primary";
  ok.textContent = "添加";
  ok.onclick = () => {
    let prov = null;
    if (srcSel.value === "paste") {
      toast(I18n.t("请先粘贴配置文字并点「解析并填入」"), "warn");
      return;
    }
    if (srcSel.value === "catalog") {
      const p = catalogAddableProviders().find((x) => x.id === provSel.value);
      if (!p) {
        toast("请先选择服务商", "warn");
        return;
      }
      if (!keyInp.value.trim()) {
        toast("请填写 API Key", "warn");
        return;
      }
      prov = {
        id: uid("p"),
        name: (nameInp.value || p.name).trim() || p.id,
        type: "text_openai",
        baseUrl: p.baseUrl || "",
        api: p.api || "openai-completions",
        source: p.id,
        apiKey: keyInp.value.trim(),
        models: p.models.map((m) => m.id),
        vision: false,
      };
    } else {
      if (!mNameInp.value.trim()) {
        toast(I18n.t("请填写服务商名称"), "warn");
        return;
      }
      prov = {
        id: uid("p"),
        name: mNameInp.value.trim(),
        type: mTypeSel.value,
        baseUrl: mUrlInp.value.trim(),
        apiKey: mKeyInp.value.trim(),
        models: mModelsInp.value.split(",").map((m) => m.trim()).filter(Boolean),
        vision: false,
      };
    }
    S.config.providers.push(prov);
    closeOverlay();
    openSettings();
    toast(I18n.t("服务商已添加：") + prov.name, "ok");
  };
  foot.appendChild(cancel);
  foot.appendChild(ok);
}

/* ── 在线浏览(插件 / 技能 / MCP):经主进程代取线上目录(国内可达镜像源);
   支持用户自添加 repo,以 tabs 切换 ── */
async function netJson(url) {
  const r = await window.api.netFetch(url);
  if (!r || r.ok === false) throw new Error((r && r.error) || I18n.t("网络请求失败"));
  return JSON.parse(r.text);
}
async function netText(url) {
  const r = await window.api.netFetch(url);
  if (!r || r.ok === false) throw new Error((r && r.error) || I18n.t("网络请求失败"));
  return r.text;
}

const MTNODE_EXT_CATALOG = "http://mt-agent.com/mtnode/ext/catalog.json";

/* 内置 repo(默认标签,不可移除;用户源可移除) */
const DEFAULT_REPOS = [
  {
    id: "mtnode-official",
    label: "MTNode 官方",
    kind: "catalog",
    url: MTNODE_EXT_CATALOG,
  },
  {
    id: "npmmirror-dsh",
    label: "插件",
    kind: "plugins",
    url: "https://registry.npmmirror.com/-/v1/search?text=%40deepseek-ai%2Fdsh&size=50",
  },
  {
    id: "jsdelivr-skills",
    label: "技能",
    kind: "skills",
    url: "https://data.jsdelivr.com/v1/package/gh/anthropics/skills@main",
    path: "skills",
  },
  {
    id: "jsdelivr-mcp",
    label: "MCP",
    kind: "mcp",
    url: "https://data.jsdelivr.com/v1/package/gh/modelcontextprotocol/servers@main",
    path: "src",
  },
];
function storeRepos() {
  const user = (S.config.onlineRepos || []).filter(
    (r) => r && r.label && r.url,
  );
  return DEFAULT_REPOS.concat(user);
}
function storeKindLabel(kind) {
  if (kind === "plugins") return I18n.t("插件");
  if (kind === "skills") return I18n.t("技能");
  if (kind === "mcp") return I18n.t("MCP 服务器");
  if (kind === "catalog") return I18n.t("目录");
  return "";
}
function storeRepoHint(repo) {
  const url = String(repo.url || "");
  const src =
    url.includes("/mtnode/ext/") || repo.kind === "catalog"
      ? I18n.t("MTNode 官方源")
      : url.includes("registry.npmmirror.com")
        ? I18n.t("npm 镜像 registry.npmmirror.com")
        : url.includes("jsdelivr")
          ? "jsDelivr CDN"
          : I18n.t("自定义源");
  return I18n.t("来源:") + src;
}
function storeCdnUrl(dataUrl) {
  return String(dataUrl || "").replace(
    "data.jsdelivr.com/v1/package/gh/",
    "cdn.jsdelivr.net/gh/",
  );
}
function storeResolveUrl(baseUrl, rel) {
  const r = String(rel || "").trim();
  if (!r) return "";
  if (/^https?:\/\//i.test(r) || /^github:/i.test(r)) return r;
  const base = String(baseUrl || "").replace(/\/catalog\.json$/i, "").replace(/\/$/, "");
  return base + "/" + r.replace(/^\.\//, "").replace(/^\/+/, "");
}
function isMtnodeExtCatalog(j) {
  return !!(
    j &&
    (j.format === "mtnode-ext-v1" ||
      ((Array.isArray(j.plugins) || Array.isArray(j.skills) || Array.isArray(j.mcp)) &&
        !Array.isArray(j.objects) &&
        !Array.isArray(j.files)))
  );
}
function storeItemsFromExtCatalog(j, repo) {
  const kinds =
    repo.kind === "catalog" || !repo.kind
      ? ["plugins", "skills", "mcp"]
      : [repo.kind];
  const out = [];
  for (const kind of kinds) {
    const arr = Array.isArray(j[kind]) ? j[kind] : [];
    for (const raw of arr) {
      if (!raw || !raw.id) continue;
      const pathRel =
        raw.path ||
        (kind === "skills" ? "skills/" + raw.id + "/SKILL.md" : "");
      out.push({
        id: raw.id,
        name: raw.name || raw.id,
        desc: raw.description || "",
        version: raw.version || "",
        kind,
        install: storeResolveUrl(repo.url, raw.install || raw.tgz || ""),
        skillUrl: storeResolveUrl(repo.url, pathRel),
        transport: raw.transport || "stdio",
        command: raw.command || "npx.cmd",
        args: raw.args || "",
        mcpUrl: raw.url || "",
      });
    }
  }
  return out;
}
async function storeFetchItems(repo) {
  const j = await netJson(repo.url);
  if (isMtnodeExtCatalog(j) || repo.format === "mtnode-ext") {
    return storeItemsFromExtCatalog(j, repo);
  }
  if (repo.kind === "plugins") {
    return (j.objects || []).map((o) => ({
      id: o.package.name,
      name: o.package.name,
      desc: o.package.description || "",
      version: o.package.version,
      kind: "plugins",
    }));
  }
  /* skills / mcp:jsDelivr data 目录树 → 取子目录列表 */
  const files = Array.isArray(j.files) ? j.files : [];
  let dirs = files;
  if (repo.path) {
    const d = files.find((f) => f.name === repo.path && f.type === "directory");
    dirs = (d && d.files) || [];
  }
  return dirs
    .filter((f) => f.type === "directory")
    .map((f) => ({
      id: f.name,
      name: f.name,
      desc:
        repo.kind === "skills"
          ? I18n.t("技能（安装时从 CDN 拉取 SKILL.md）")
          : I18n.t("MCP 服务器（stdio，经 npx 运行）"),
      version: "",
      kind: repo.kind,
    }));
}

async function openStoreDialog() {
  openOverlay(I18n.t("在线浏览 · 插件 / 技能 / MCP"));
  overlayPersistent = true;
  const box = document.querySelector("#overlay .overlay-box");
  if (box) box.classList.add("wide");
  const body = $("#ovBody");
  const tabs = document.createElement("div");
  tabs.className = "store-tabs";
  body.appendChild(tabs);
  const manageRow = document.createElement("div");
  manageRow.className = "dsh-btn-row";
  manageRow.style.marginTop = "6px";
  const addSrcBtn = document.createElement("button");
  addSrcBtn.className = "mini";
  addSrcBtn.textContent = I18n.t("＋ 添加源");
  addSrcBtn.title = I18n.t("添加自定义在线源（MTNode catalog.json / npm search / jsDelivr），以标签切换");
  addSrcBtn.onclick = openAddStoreSource;
  manageRow.appendChild(addSrcBtn);
  body.appendChild(manageRow);
  const search = document.createElement("input");
  search.type = "text";
  search.className = "dsh-plugin-search";
  search.placeholder = I18n.t("筛选…");
  body.appendChild(search);
  const status = document.createElement("div");
  status.className = "settings-hint";
  body.appendChild(status);
  const grid = document.createElement("div");
  grid.className = "store-grid";
  body.appendChild(grid);
  const foot = $("#ovFoot");
  const closeBtn = document.createElement("button");
  closeBtn.className = "mini primary";
  closeBtn.textContent = I18n.t("关闭");
  closeBtn.onclick = closeOverlay;
  foot.appendChild(closeBtn);

  const repos = storeRepos();
  let active = (repos[0] && repos[0].id) || "mtnode-official";
  let activeRepo = () => storeRepos().find((r) => r.id === active) || storeRepos()[0];
  let items = [];
  const installed = { plugins: [], skills: [], mcp: [] };
  const refreshInstalled = async () => {
    try {
      const r = await window.api.dshPluginList();
      installed.plugins = (r && Array.isArray(r.plugins) && r.plugins) || [];
    } catch {}
    try {
      const r = await window.api.skillList();
      installed.skills = (r && r.skills) || [];
    } catch {}
    try {
      const r = await window.api.dshMcpList();
      installed.mcp = (r && r.servers) || [];
    } catch {}
  };
  const paintTabs = () => {
    tabs.innerHTML = "";
    for (const r of storeRepos()) {
      const b = document.createElement("button");
      b.className = "mini" + (active === r.id ? " on" : "");
      b.textContent =
        I18n.t(r.label) +
        (r.kind && r.kind !== "catalog" ? " · " + storeKindLabel(r.kind) : "");
      b.title = r.url;
      b.onclick = async () => {
        if (active === r.id) return;
        active = r.id;
        paintTabs();
        grid.innerHTML = "";
        items = [];
        await load();
        render();
      };
      tabs.appendChild(b);
      const isUser = !DEFAULT_REPOS.some((d) => d.id === r.id);
      if (isUser) {
        const x = document.createElement("button");
        x.className = "mini store-tab-x";
        x.textContent = "✕";
        x.title = I18n.t("移除该源");
        x.onclick = async (ev) => {
          ev.stopPropagation();
          if (!(await confirmDialog(I18n.t("移除在线源「{name}」？", { name: r.label }), { title: I18n.t("移除"), danger: true, okText: I18n.t("移除") }))) return;
          S.config.onlineRepos = (S.config.onlineRepos || []).filter(
            (u) => u.id !== r.id,
          );
          await window.api.configSave(S.config);
          openStoreDialog();
        };
        tabs.appendChild(x);
      }
    }
  };
  const load = async () => {
    const repo = activeRepo();
    if (!repo) return;
    status.textContent =
      I18n.t("读取线上目录中…（") + storeRepoHint(repo) + "：" + (repo.url || "") + "）";
    try {
      items = await storeFetchItems(repo);
      status.textContent =
        I18n.t("线上目录 ") +
        items.length +
        I18n.t(" 项 · ") +
        storeRepoHint(repo);
    } catch (e) {
      items = [];
      status.textContent =
        I18n.t("线上目录暂不可用（") + (e.message || String(e)) + I18n.t("）· 请检查网络或源地址后重试");
    }
  };
  const render = () => {
    const repo = activeRepo();
    const q = search.value.trim().toLowerCase();
    grid.innerHTML = "";
    const list = items.filter(
      (x) => !q || x.name.toLowerCase().includes(q) || (x.desc || "").toLowerCase().includes(q),
    );
    if (!list.length) {
      const em = document.createElement("div");
      em.className = "dsh-plugin-empty";
      em.textContent = q ? I18n.t("无匹配项") : I18n.t("暂无条目");
      grid.appendChild(em);
      return;
    }
    for (const it of list) {
      const itemKind = it.kind || (repo && repo.kind) || "plugins";
      const card = document.createElement("div");
      card.className = "store-card";
      const nm = document.createElement("div");
      nm.className = "store-name";
      nm.textContent = it.name;
      nm.title = it.id;
      const ds = document.createElement("div");
      ds.className = "store-desc";
      ds.textContent = it.desc || "";
      const meta = document.createElement("div");
      meta.className = "store-meta";
      meta.textContent = it.version ? "v" + it.version : it.id;
      const btns = document.createElement("div");
      btns.className = "store-btns";
      if (repo && repo.kind === "catalog") {
        const kindTag = document.createElement("span");
        kindTag.className = "store-kind";
        kindTag.textContent = storeKindLabel(itemKind);
        btns.appendChild(kindTag);
      }
      const skillRec = installed.skills.find((s) => s.name === it.id);
      const isInstalled = (() => {
        if (itemKind === "plugins") return installed.plugins.some((p) => p.name === it.id);
        if (itemKind === "skills") return !!skillRec;
        return installed.mcp.some((s) => s.serverName === it.id);
      })();
      const canUninstall = itemKind !== "skills" || !(skillRec && skillRec.builtin);
      if (isInstalled) {
        const tag = document.createElement("span");
        tag.className = "store-installed";
        tag.textContent = I18n.t("已安装");
        btns.appendChild(tag);
        if (canUninstall) {
          const rm = document.createElement("button");
          rm.className = "mini danger";
          rm.textContent = I18n.t("卸载");
          rm.onclick = async () => {
            try {
              let rr;
              if (itemKind === "plugins") {
                if (!(await confirmDialog(I18n.t("卸载插件 ") + it.id + I18n.t("？引擎将自动重启。"), { title: I18n.t("卸载插件"), danger: true, okText: I18n.t("卸载") }))) return;
                rr = await window.api.dshPluginRemove(it.id);
              } else if (itemKind === "skills") {
                if (!(await confirmDialog(I18n.t("移除技能 ") + it.id + I18n.t("？"), { title: I18n.t("移除技能"), danger: true, okText: I18n.t("移除") }))) return;
                rr = await window.api.skillRemove(it.id);
              } else {
                if (!(await confirmDialog(I18n.t("移除 MCP 服务器 ") + it.id + I18n.t("？引擎将自动重启。"), { title: I18n.t("移除 MCP"), danger: true, okText: I18n.t("移除") }))) return;
                rr = await window.api.dshMcpRemove(it.id);
              }
              if (rr && rr.ok === false) throw new Error(rr.error);
              toast(I18n.t("已卸载 ") + it.id, "ok");
            } catch (e) {
              toast(I18n.t("卸载失败：") + (e.message || String(e)), "err");
            }
            await refreshInstalled();
            render();
          };
          btns.appendChild(rm);
        }
      } else {
        const inBtn = document.createElement("button");
        inBtn.className = "mini primary";
        inBtn.textContent = I18n.t("安装");
        inBtn.onclick = async () => {
          try {
            let rr;
            if (itemKind === "plugins") {
              rr = await window.api.dshPluginAdd(it.install || it.id);
            } else if (itemKind === "skills") {
              let mdUrl = it.skillUrl;
              if (!mdUrl) {
                const cdn = storeCdnUrl(repo.url);
                if (!cdn || !String(cdn).includes("jsdelivr")) {
                  throw new Error(I18n.t("该源无法安装技能（需要 jsDelivr 或 MTNode catalog）"));
                }
                mdUrl =
                  cdn +
                  (repo.path ? "/" + repo.path : "") +
                  "/" +
                  it.id +
                  "/SKILL.md";
              }
              const md = await netText(mdUrl);
              let desc = it.desc || it.id;
              const m = md.match(/^---\s*\n([\s\S]*?)\n---/);
              if (m) {
                const dm = m[1].match(/^description:\s*(.+)$/m);
                if (dm) desc = dm[1].replace(/['"]/g, "").trim();
              }
              rr = await window.api.skillAdd({ name: it.id, description: desc, body: md });
            } else {
              rr = await window.api.dshMcpAdd({
                serverName: it.id,
                transport: it.transport || "stdio",
                command: it.command || "npx.cmd",
                args: it.args || "-y @modelcontextprotocol/server-" + it.id,
                url: it.mcpUrl || "",
              });
            }
            if (rr && rr.ok === false) throw new Error(rr.error);
            toast(I18n.t("已安装 ") + it.id, "ok");
          } catch (e) {
            toast(I18n.t("安装失败：") + (e.message || String(e)), "err");
          }
          await refreshInstalled();
          render();
        };
        btns.appendChild(inBtn);
      }
      card.appendChild(nm);
      card.appendChild(ds);
      card.appendChild(meta);
      card.appendChild(btns);
      grid.appendChild(card);
    }
  };
  search.addEventListener("input", render);
  paintTabs();
  await refreshInstalled();
  await load();
  render();
}

/* 添加自定义在线源:MTNode catalog.json / npm search / jsDelivr repo */
function openAddStoreSource() {
  openOverlay(I18n.t("添加在线源"));
  overlayPersistent = true;
  const body = $("#ovBody");
  const f1 = document.createElement("label");
  f1.className = "n-field";
  f1.appendChild(document.createTextNode(I18n.t("名称（显示为标签）")));
  const nameInp = document.createElement("input");
  nameInp.type = "text";
  nameInp.placeholder = I18n.t("如「团队插件源」");
  f1.appendChild(nameInp);
  body.appendChild(f1);
  const f2 = document.createElement("label");
  f2.className = "n-field";
  f2.appendChild(document.createTextNode(I18n.t("类型")));
  const kindSel = document.createElement("select");
  for (const [v, l] of [
    ["catalog", I18n.t("MTNode 目录（插件+技能+MCP）")],
    ["plugins", I18n.t("插件（npm search 或 MTNode catalog）")],
    ["skills", I18n.t("技能（jsDelivr 或 MTNode catalog）")],
    ["mcp", I18n.t("MCP（jsDelivr 或 MTNode catalog）")],
  ]) {
    const o = document.createElement("option");
    o.value = v;
    o.textContent = l;
    kindSel.appendChild(o);
  }
  f2.appendChild(kindSel);
  body.appendChild(f2);
  const f3 = document.createElement("label");
  f3.className = "n-field";
  f3.appendChild(document.createTextNode("URL"));
  const urlInp = document.createElement("input");
  urlInp.type = "text";
  urlInp.placeholder = I18n.t("MTNode 目录：http://mt-agent.com/mtnode/ext/catalog.json");
  kindSel.addEventListener("change", () => {
    if (kindSel.value === "catalog" && !urlInp.value.trim()) {
      urlInp.value = MTNODE_EXT_CATALOG;
    }
  });
  f3.appendChild(urlInp);
  body.appendChild(f3);
  const f4 = document.createElement("label");
  f4.className = "n-field";
  f4.appendChild(document.createTextNode(I18n.t("子目录（可选，技能/MCP 的列表所在目录）")));
  const pathInp = document.createElement("input");
  pathInp.type = "text";
  pathInp.placeholder = I18n.t("如 skills 或 src；留空 = 仓库根目录");
  f4.appendChild(pathInp);
  body.appendChild(f4);
  const hint = document.createElement("div");
  hint.className = "settings-hint";
  hint.textContent =
    I18n.t("MTNode 目录填 catalog.json 即可（官方源已预置）。也可填 npm search 或 jsDelivr repo；技能子目录含 SKILL.md。");
  body.appendChild(hint);
  const foot = $("#ovFoot");
  const cancel = document.createElement("button");
  cancel.className = "mini";
  cancel.textContent = I18n.t("取消");
  cancel.onclick = closeOverlay;
  const ok = document.createElement("button");
  ok.className = "mini primary";
  ok.textContent = I18n.t("添加");
  ok.onclick = async () => {
    const label = nameInp.value.trim();
    const url = urlInp.value.trim();
    if (!label || !url) {
      toast(I18n.t("请填写名称与 URL"), "warn");
      return;
    }
    if (!/^https?:\/\//.test(url)) {
      toast(I18n.t("URL 需以 http(s):// 开头"), "warn");
      return;
    }
    S.config.onlineRepos = S.config.onlineRepos || [];
    S.config.onlineRepos.push({
      id: "repo_" + Date.now().toString(36),
      label,
      kind: kindSel.value,
      url,
      path: pathInp.value.trim() || "",
      format: /\/catalog\.json$/i.test(url) || kindSel.value === "catalog" ? "mtnode-ext" : "",
    });
    await window.api.configSave(S.config);
    openStoreDialog();
    toast(I18n.t("已添加在线源：") + label, "ok");
  };
  foot.appendChild(cancel);
  foot.appendChild(ok);
}

/* 设置页：无 Token 消耗校验 API Key（主进程 GET /models 等） */
async function validateProviderApiKey(prov, btn) {
  const apiKey = String((prov && prov.apiKey) || "").trim();
  const baseUrl = String((prov && prov.baseUrl) || "").trim();
  if (!apiKey) {
    toast(I18n.t("请填写 API Key"), "warn");
    return false;
  }
  if (!baseUrl) {
    toast(I18n.t("未配置接口地址（设置 · API/配置）"), "warn");
    return false;
  }
  const label = btn ? btn.textContent : "";
  if (btn) {
    btn.disabled = true;
    btn.textContent = I18n.t("验证中…");
  }
  try {
    const r = await window.api.apiValidateKey({
      type: (prov && prov.type) || "text_openai",
      baseUrl,
      apiKey,
    });
    if (r && r.ok) {
      toast(I18n.t("API Key 验证成功（无 Token 消耗）"), "ok");
      return true;
    }
    const detail = r && r.error ? String(r.error) : "";
    toast(
      detail.indexOf(I18n.t("API Key 验证失败")) === 0
        ? detail
        : I18n.t("API Key 验证失败") + (detail ? "：" + detail : ""),
      "err",
    );
    return false;
  } catch (e) {
    toast(
      I18n.t("API Key 验证失败") + "：" + ((e && e.message) || String(e)),
      "err",
    );
    return false;
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = label || I18n.t("验证");
    }
  }
}

function provCard(prov, i, list) {
  const card = document.createElement("div");
  card.className = "prov-card";
  /* 列表就地重建：增/删/排序/改类型只刷新服务商卡片，不整页重开设置，
     也避免 openSettings() 重读磁盘把未保存的改动吞掉 */
  const rerender = () => {
    list.innerHTML = "";
    S.config.providers.forEach((p, j) => list.appendChild(provCard(p, j, list)));
  };
  const head = document.createElement("div");
  head.className = "prov-head";
  const idx = document.createElement("span");
  idx.className = "idx";
  idx.textContent = "#" + (i + 1);
  idx.title = i === 0 ? I18n.t("当前优先使用") : I18n.t("供应商使用优先级（越小越优先）");
  head.appendChild(idx);
  const nameSpan = document.createElement("span");
  nameSpan.className = "prov-name" + (i === 0 ? " pri" : "");
  nameSpan.textContent = prov.name || I18n.t("（未命名）");
  head.appendChild(nameSpan);
  const move = document.createElement("span");
  move.className = "prov-move";
  const up = document.createElement("button");
  up.type = "button";
  up.className = "mini";
  up.textContent = "↑";
  up.title = I18n.t("提高供应商优先级");
  up.disabled = i === 0;
  up.onclick = (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    if (i <= 0) return;
    const arr = S.config.providers;
    const t = arr[i - 1];
    arr[i - 1] = arr[i];
    arr[i] = t;
    rerender();
  };
  const down = document.createElement("button");
  down.type = "button";
  down.className = "mini";
  down.textContent = "↓";
  down.title = I18n.t("降低供应商优先级");
  down.disabled = i >= S.config.providers.length - 1;
  down.onclick = (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    if (i >= S.config.providers.length - 1) return;
    const arr = S.config.providers;
    const t = arr[i + 1];
    arr[i + 1] = arr[i];
    arr[i] = t;
    rerender();
  };
  move.appendChild(up);
  move.appendChild(down);
  head.appendChild(move);
  const del = document.createElement("span");
  del.className = "del";
  del.textContent = I18n.t("✕ 删除");
  del.title = I18n.t("删除该服务商");
  del.onclick = () => {
    const pid = prov && prov.id ? String(prov.id) : "";
    S.config.providers.splice(i, 1);
    if (pid) {
      /* 记入删除清单，随保存持久化：重启时 ensureDefaultProviders()
         不再把该默认项补回来 */
      S.config.removedProviders = Array.isArray(S.config.removedProviders)
        ? S.config.removedProviders.slice()
        : [];
      if (S.config.removedProviders.indexOf(pid) < 0)
        S.config.removedProviders.push(pid);
    }
    rerender();
  };
  head.appendChild(del);
  card.appendChild(head);

  const gridEl = document.createElement("div");
  gridEl.className = "prov-grid";

  const mkField = (label, ctrl, wide) => {
    const f = document.createElement("label");
    f.className = "pf" + (wide ? " pf-wide" : "");
    f.appendChild(document.createTextNode(label));
    f.appendChild(ctrl);
    gridEl.appendChild(f);
    return f;
  };

  const typeSel = document.createElement("select");
  for (const [v, l] of PROVIDER_TYPE_LABELS) {
    const o = document.createElement("option");
    o.value = v;
    o.textContent = I18n.t(l);
    typeSel.appendChild(o);
  }
  typeSel.value = prov.type;
  typeSel.onchange = () => {
    prov.type = typeSel.value;
    rerender();
  };
  mkField(I18n.t("类型"), typeSel);

  const nameInp = document.createElement("input");
  nameInp.type = "text";
  nameInp.value = prov.name || "";
  nameInp.placeholder = I18n.t("服务商名称");
  nameInp.oninput = () => {
    prov.name = nameInp.value;
    nameSpan.textContent = nameInp.value || I18n.t("（未命名）");
  };
  mkField(I18n.t("名称"), nameInp);

  const urlInp = document.createElement("input");
  urlInp.type = "text";
  urlInp.value = prov.baseUrl || "";
  urlInp.placeholder = "https://api.example.com/v1";
  urlInp.oninput = () => {
    prov.baseUrl = urlInp.value;
  };
  mkField(I18n.t("接口地址 Base URL"), urlInp, true);

  const keyRow = mkField("API Key", (() => {
    const wrap = document.createElement("div");
    wrap.style.display = "flex";
    wrap.style.gap = "4px";
    wrap.style.flex = "1";
    const inp = document.createElement("input");
    inp.type = "password";
    inp.value = prov.apiKey || "";
    inp.placeholder = "API Key";
    inp.style.flex = "1";
    inp.oninput = () => {
      prov.apiKey = inp.value;
    };
    const cp = document.createElement("button");
    cp.className = "mini";
    cp.textContent = I18n.t("复制");
    cp.title = I18n.t("复制 API Key 到剪贴板");
    cp.type = "button";
    cp.onclick = (ev) => {
      ev.preventDefault();
      const v = prov.apiKey || "";
      if (!v) {
        toast(I18n.t("暂无 API Key"), "warn");
        return;
      }
      navigator.clipboard
        .writeText(v)
        .then(() => toast(I18n.t("API Key 已复制到剪贴板"), "ok"))
        .catch(() => toast(I18n.t("复制失败"), "err"));
    };
    const testBtn = document.createElement("button");
    testBtn.className = "mini";
    testBtn.textContent = I18n.t("验证");
    testBtn.title = I18n.t("向服务商发起无 Token 消耗的校验请求");
    testBtn.type = "button";
    testBtn.onclick = (ev) => {
      ev.preventDefault();
      validateProviderApiKey(prov, testBtn);
    };
    wrap.appendChild(inp);
    wrap.appendChild(testBtn);
    wrap.appendChild(cp);
    return wrap;
  })(), true);

  const modelField = document.createElement("div");
  modelField.className = "pf pf-wide";
  modelField.appendChild(
    document.createTextNode(I18n.t("模型列表（从上到下为使用优先级）")),
  );
  const orderBox = document.createElement("div");
  orderBox.className = "model-order";
  /* 拖动整行调整优先级：dragFrom 记录本次拖拽的源下标，-1 = 无拖拽。
     orderBox 级监听只挂一次（拖到列表底部空白处 = 移到末尾），行级监听每次重绘重建 */
  let dragFrom = -1;
  const clearDragUI = () => {
    dragFrom = -1;
    orderBox
      .querySelectorAll(".mo-dragging,.mo-drop-before,.mo-drop-after")
      .forEach((el) =>
        el.classList.remove("mo-dragging", "mo-drop-before", "mo-drop-after"),
      );
  };
  orderBox.addEventListener("dragover", (ev) => {
    if (dragFrom < 0) return;
    ev.preventDefault();
    ev.dataTransfer.dropEffect = "move";
  });
  orderBox.addEventListener("drop", (ev) => {
    if (dragFrom < 0) return;
    const rowEl = ev.target && ev.target.closest
      ? ev.target.closest(".model-order-row")
      : null;
    if (rowEl) return; /* 行内 drop 由各行的处理器负责 */
    ev.preventDefault();
    const from = dragFrom;
    clearDragUI();
    const arr = prov.models;
    if (from >= 0 && from < arr.length) {
      arr.push(arr.splice(from, 1)[0]);
      paintModels();
    }
  });
  const paintModels = () => {
    if (!Array.isArray(prov.models)) prov.models = [];
    orderBox.innerHTML = "";
    prov.models.forEach((mid, mi) => {
      const row = document.createElement("div");
      row.className = "model-order-row";
      row.draggable = true;
      const idxEl = document.createElement("span");
      idxEl.className = "mo-idx";
      idxEl.textContent = String(mi + 1);
      const name = document.createElement("span");
      name.className = "mo-name" + (mi === 0 ? " pri" : "");
      name.textContent = mid;
      name.title =
        mi === 0
          ? I18n.t("当前优先使用") + " · " + mid
          : I18n.t("拖动或点击箭头调整优先级");
      const up = document.createElement("button");
      up.type = "button";
      up.className = "mini";
      up.textContent = "↑";
      up.title = I18n.t("提高优先级");
      up.disabled = mi === 0;
      up.onclick = (ev) => {
        ev.preventDefault();
        if (mi <= 0) return;
        const arr = prov.models;
        const t = arr[mi - 1];
        arr[mi - 1] = arr[mi];
        arr[mi] = t;
        paintModels();
      };
      const down = document.createElement("button");
      down.type = "button";
      down.className = "mini";
      down.textContent = "↓";
      down.title = I18n.t("降低优先级");
      down.disabled = mi >= prov.models.length - 1;
      down.onclick = (ev) => {
        ev.preventDefault();
        if (mi >= prov.models.length - 1) return;
        const arr = prov.models;
        const t = arr[mi + 1];
        arr[mi + 1] = arr[mi];
        arr[mi] = t;
        paintModels();
      };
      const rm = document.createElement("button");
      rm.type = "button";
      rm.className = "mini";
      rm.textContent = "✕";
      rm.title = I18n.t("移除该模型");
      rm.onclick = (ev) => {
        ev.preventDefault();
        prov.models.splice(mi, 1);
        paintModels();
      };
      const grip = document.createElement("span");
      grip.className = "mo-grip";
      grip.textContent = "⠿";
      grip.title = I18n.t("拖动或点击箭头调整优先级");
      row.appendChild(grip);
      row.appendChild(idxEl);
      row.appendChild(name);
      row.appendChild(up);
      row.appendChild(down);
      row.appendChild(rm);
      /* 拖动整行排序：从行身（含行名 / 抓手）拖起；按下按钮不算拖拽 */
      row.addEventListener("dragstart", (ev) => {
        if (ev.target && ev.target.closest && ev.target.closest("button")) {
          ev.preventDefault();
          return;
        }
        dragFrom = mi;
        row.classList.add("mo-dragging");
        if (ev.dataTransfer) {
          ev.dataTransfer.effectAllowed = "move";
          try {
            ev.dataTransfer.setData("text/plain", String(mi));
          } catch (e) {
            /* 个别平台不允许 setData 时仍可拖动，忽略 */
          }
        }
      });
      row.addEventListener("dragover", (ev) => {
        if (dragFrom < 0 || dragFrom === mi) return;
        ev.preventDefault();
        ev.dataTransfer.dropEffect = "move";
        const r = row.getBoundingClientRect();
        const before = ev.clientY < r.top + r.height / 2;
        orderBox
          .querySelectorAll(".mo-drop-before,.mo-drop-after")
          .forEach((el) =>
            el.classList.remove("mo-drop-before", "mo-drop-after"),
          );
        row.classList.add(before ? "mo-drop-before" : "mo-drop-after");
      });
      row.addEventListener("dragleave", () => {
        row.classList.remove("mo-drop-before", "mo-drop-after");
      });
      row.addEventListener("drop", (ev) => {
        if (dragFrom < 0) return;
        ev.preventDefault();
        ev.stopPropagation();
        const from = dragFrom;
        const arr = prov.models;
        if (from === mi || from < 0 || from >= arr.length || mi >= arr.length) {
          clearDragUI();
          return;
        }
        const r = row.getBoundingClientRect();
        const before = ev.clientY < r.top + r.height / 2;
        /* 以移动前数组语义计算落点：目标行前半 = 插到它前面，后半 = 插到它后面 */
        let to = mi;
        if (from < mi) to = before ? mi - 1 : mi;
        else to = before ? mi : mi + 1;
        clearDragUI();
        const item = arr.splice(from, 1)[0];
        arr.splice(to, 0, item);
        paintModels();
      });
      row.addEventListener("dragend", () => clearDragUI());
      orderBox.appendChild(row);
    });
    if (!prov.models.length) {
      const empty = document.createElement("div");
      empty.className = "settings-hint";
      empty.style.margin = "0";
      empty.textContent = I18n.t("暂无模型，请在下方添加");
      orderBox.appendChild(empty);
    }
  };
  paintModels();
  modelField.appendChild(orderBox);
  const addRow = document.createElement("div");
  addRow.className = "model-order-add";
  const addInp = document.createElement("input");
  addInp.type = "text";
  addInp.placeholder = I18n.t("添加模型 id，如 gpt-4o-mini");
  const addBtn = document.createElement("button");
  addBtn.type = "button";
  addBtn.className = "mini";
  addBtn.textContent = I18n.t("添加");
  const doAdd = () => {
    const id = String(addInp.value || "").trim();
    if (!id) return;
    if (!Array.isArray(prov.models)) prov.models = [];
    if (prov.models.includes(id)) {
      toast(I18n.t("模型已存在"), "warn");
      return;
    }
    prov.models.push(id);
    addInp.value = "";
    paintModels();
  };
  addBtn.onclick = (ev) => {
    ev.preventDefault();
    doAdd();
  };
  addInp.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") {
      ev.preventDefault();
      doAdd();
    }
  });
  addRow.appendChild(addInp);
  addRow.appendChild(addBtn);
  modelField.appendChild(addRow);
  gridEl.appendChild(modelField);

  if (prov.type === "text_openai") {
    const inline = document.createElement("label");
    inline.className = "pf pf-inline";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = !!prov.vision;
    cb.onchange = () => {
      prov.vision = cb.checked;
    };
    inline.appendChild(cb);
    inline.appendChild(
      document.createTextNode(I18n.t("支持视觉（图片输入转为多模态消息）")),
    );
    gridEl.appendChild(inline);
  }

  card.appendChild(gridEl);
  return card;
}

/* ============ 帮助 ============ */

function openHelp() {
  openAppDocs();
}

/* 作者弹窗：居中小窗口，显示 @ms2308 与 B 站主页超链接 */
function openAuthorPopup() {
  openOverlay("");
  $("#overlay").style.alignItems = "center";
  const box = $("#overlay .overlay-box");
  if (box)
    box.style.cssText =
      "width:min(340px,92%);max-height:none;border-top:3px solid var(--cyan)";
  const body = $("#ovBody");
  const pop = document.createElement("div");
  pop.className = "author-pop";
  const name = document.createElement("div");
  name.className = "author-name";
  name.textContent = "@ms2308";
  const ver = document.createElement("div");
  ver.className = "author-ver";
  ver.textContent = "v" + S.appVersion;
  const link = document.createElement("a");
  link.className = "author-link";
  link.textContent = "https://space.bilibili.com/16411347";
  link.href = "https://space.bilibili.com/16411347";
  link.title = I18n.t("在浏览器中打开");
  link.onclick = (ev) => {
    ev.preventDefault();
    window.api.openExternal(link.href);
  };
  pop.appendChild(name);
  pop.appendChild(ver);
  pop.appendChild(link);
  const home = document.createElement("a");
  home.className = "author-link";
  home.textContent = I18n.t("主页 · 下载 http://mt-agent.com/mtnode");
  home.href = "http://mt-agent.com/mtnode";
  home.title = I18n.t("在浏览器中打开主页与下载页");
  home.onclick = (ev) => {
    ev.preventDefault();
    window.api.openExternal(home.href);
  };
  pop.appendChild(home);
  body.appendChild(pop);
  const foot = $("#ovFoot");
  const ok = document.createElement("button");
  ok.className = "mini primary";
  ok.textContent = I18n.t("关闭");
  ok.onclick = closeOverlay;
  foot.appendChild(ok);
}

/* ============ 渲染外壳 ============ */

function renderTop() {
  $("#wfName").value = S.wf ? S.wf.name : "";
  refreshWfSelect();
  renderWfWorkspace();
}
function renderStatus() {
  if (!S.wf) return;
  const bcount = S.wf.nodes.filter((n) => isBatchInput(n)).length;
  $("#statWf").textContent = I18n.t("画布：") + S.wf.name;
  $("#statCounts").textContent =
    S.wf.nodes.length +
    I18n.t(" 节点 · ") +
    S.wf.wires.length +
    I18n.t(" 连线") +
    (bcount ? I18n.t(" · 批量 ") + bcount : "");
  $("#statProviders").textContent = I18n.t("服务商 ") + S.config.providers.length;
  $("#statGrid").textContent = I18n.t("网格 ") + grid() + "px";
  $("#statZoom").textContent = Math.round(S.cam.z * 100) + "%";
  const st = $("#saveState");
  if (S.saving) {
    st.textContent = I18n.t("保存中…");
    st.className = "warn";
  } else if (S.lastSaved) {
    st.textContent = I18n.t("已保存 ") + fmtTime(S.lastSaved);
    st.className = "ok";
  } else {
    st.textContent = I18n.t("就绪");
    st.className = "";
  }
  updateRunQueuePanel();
}
function renderAll() {
  renderTop();
  renderCanvas();
  renderStatus();
  renderAssistPanel();
}

