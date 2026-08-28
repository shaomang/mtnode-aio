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
   增/删/排序全部丢弃 —— 手动添加服务商保存后不在列表中的根因。 */
async function reloadConfigProvidersFromDisk() {
  if (!window.api || !window.api.configLoad || !S.config) return;
  try {
    const fresh = await window.api.configLoad();
    if (fresh && Array.isArray(fresh.providers)) {
      mergePluginManagedProviders(S.config, fresh);
      ensureDefaultProviders();
    }
  } catch {}
}

/* 测试版本（Beta）UI：把仍在调试的功能按开关显隐。
   当前：顶栏「提问式」入口（仅 Beta 开启时显示）。 */
function applyBetaUI() {
  const zen = $("#btnZen");
  if (zen) zen.style.display = S.config.beta ? "" : "none";
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

  /* ── 测试版本（Beta）── */
  const betaSec = document.createElement("div");
  betaSec.className = "settings-sec";
  const betaTitle = document.createElement("div");
  betaTitle.className = "settings-sec-title";
  betaTitle.textContent = I18n.t("测试版本（Beta）");
  betaSec.appendChild(betaTitle);
  const betaRow = document.createElement("label");
  betaRow.className = "n-field";
  betaRow.style.flexDirection = "row";
  betaRow.style.alignItems = "center";
  const betaCb = document.createElement("input");
  betaCb.type = "checkbox";
  betaCb.checked = !!S.config.beta;
  betaRow.appendChild(betaCb);
  betaRow.appendChild(
    document.createTextNode(I18n.t("启用测试版本（显示仍在调试的功能：提问式、数据库节点）")),
  );
  betaSec.appendChild(betaRow);
  const betaHint = document.createElement("div");
  betaHint.className = "n-field";
  betaHint.style.fontSize = "12px";
  betaHint.style.opacity = "0.9";
  betaHint.textContent = I18n.t(
    "默认关闭。开启后顶栏显示「提问式」入口，并在添加节点菜单中提供「数据库」节点。",
  );
  betaSec.appendChild(betaHint);
  body.appendChild(betaSec);

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
      const dp = dshProvider();
      const models = dp && dp.models ? dp.models.slice() : [];
      const cur = S.config.dsh.model || "deepseek-v4-flash";
      if (cur && !models.includes(cur)) models.unshift(cur);
      for (const m of models) {
        const o = document.createElement("option");
        o.value = m;
        o.textContent = m;
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
    const PRESET_OPTIONS = [
      ["standard", I18n.t("标准模式（默认）")],
      ["minimal", I18n.t("极简模式（直奔结果，少解释）")],
      ["code", I18n.t("PTC 模式（写代码 / 改文件 / 跑命令）")],
      ["cordis", I18n.t("创造模式（自定义 Preset）")],
    ];
    for (const [v, l] of PRESET_OPTIONS) {
      const o = document.createElement("option");
      o.value = v;
      o.textContent = l;
      presetSel.appendChild(o);
    }
    presetSel.value = S.config.dsh.preset || "standard";
    presetRow.appendChild(presetSel);
    sec.appendChild(presetRow);
    dshEls.preset = presetSel;

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

    /* ── 插件:安装按钮与商店入口在标题行最右,已装列表默认收纳 ── */
    const plTitle = document.createElement("div");
    plTitle.className = "settings-sec-title settings-sec-title-row";
    plTitle.style.marginTop = "8px";
    const plTitleSpan = document.createElement("span");
    plTitleSpan.textContent = I18n.t("DSH 插件（扩展 agent 能力；安装到配置目录，升级后保留；安装后自动重启引擎）");
    plTitle.appendChild(plTitleSpan);
    const plRow = document.createElement("div");
    plRow.className = "dsh-btn-row";
    const plInp = document.createElement("input");
    plInp.type = "text";
    plInp.placeholder = I18n.t("npm 包名或 GitHub 地址，例如 @scope/pkg");
    plInp.style.flex = "1";
    const plAdd = document.createElement("button");
    plAdd.className = "mini primary";
    plAdd.textContent = I18n.t("＋ 安装 DSH 插件");
    const storeBtn = document.createElement("button");
    storeBtn.className = "mini";
    storeBtn.textContent = I18n.t("🌐 在线浏览");
    storeBtn.title = I18n.t("在线浏览:线上目录(插件 / 技能 / MCP),可安装与卸载");
    storeBtn.onclick = () => {
      closeDshPluginsDialog();
      openStoreDialog();
    };
    plRow.appendChild(plInp);
    plRow.appendChild(plAdd);
    plRow.appendChild(storeBtn);
    plTitle.appendChild(plRow);
    sec.appendChild(plTitle);
    const plHintRow = document.createElement("div");
    plHintRow.className = "dsh-plugin-manage-row";
    const plHint = document.createElement("div");
    plHint.className = "dsh-plugin-empty";
    plHint.textContent = I18n.t("（读取中…）");
    const plManage = document.createElement("button");
    plManage.className = "mini primary";
    plManage.textContent = I18n.t("管理已装插件…");
    plManage.onclick = () => openDshPluginsDialog();
    plHintRow.appendChild(plHint);
    plHintRow.appendChild(plManage);
    sec.appendChild(plHintRow);
    DSH_PLUGINS_UI.hintEl = plHint;
    const refreshPlugins = () => refreshDshPluginInventory();

    /* ── 技能 Skills(文件系统技能,$DSH_HOME/skills,安装后智能节点可直接调用) ── */
    const skTitleRow = document.createElement("div");
    skTitleRow.className = "settings-sec-title settings-sec-title-row";
    const skTitleSpan = document.createElement("span");
    skTitleSpan.textContent = I18n.t("技能 Skills（安装后智能节点可自动发现并使用）");
    skTitleRow.appendChild(skTitleSpan);
    const skAdd = document.createElement("button");
    skAdd.className = "mini primary";
    skAdd.textContent = I18n.t("＋ 创建技能");
    skTitleRow.appendChild(skAdd);
    sec.appendChild(skTitleRow);
    const skList = document.createElement("div");
    skList.className = "dsh-plugin-list";
    skList.textContent = I18n.t("（读取中…）");
    sec.appendChild(skList);
    const skForm = document.createElement("div");
    skForm.className = "dsh-skill-form";
    const skName = document.createElement("input");
    skName.type = "text";
    skName.placeholder = I18n.t("技能名（kebab-case，如 pdf-summary）");
    const skDesc = document.createElement("input");
    skDesc.type = "text";
    skDesc.placeholder = I18n.t("一句话描述（模型据此判断何时使用）");
    const skBody = document.createElement("textarea");
    skBody.rows = 3;
    skBody.placeholder = I18n.t("技能内容（Markdown，模型按此执行）…");
    skForm.appendChild(skName);
    skForm.appendChild(skDesc);
    skForm.appendChild(skBody);
    sec.appendChild(skForm);
    const refreshSkills = async () => {
      try {
        const r = await window.api.skillList();
        if (r && r.ok === false) throw new Error(r.error);
        const skills = (r && r.skills) || [];
        skList.innerHTML = "";
        const visible = skills.filter((s) => !isInstallOnlySkillName(s.name));
        if (!visible.length) {
          const em = document.createElement("div");
          em.className = "dsh-plugin-empty";
          em.textContent = I18n.t("暂无技能（在上方表单创建）");
          skList.appendChild(em);
        }
        for (const s of visible) {
          const row = document.createElement("div");
          row.className = "dsh-plugin-row";
          const nm = document.createElement("span");
          nm.textContent = (s.title ? s.title + "  " : "") + s.name;
          nm.title = s.description || s.name;
          if (s.builtin) {
            const tag = document.createElement("span");
            tag.className = "dsh-plugin-tag builtin";
            tag.textContent = I18n.t("内置");
            tag.style.marginLeft = "6px";
            nm.appendChild(tag);
          }
          const desc = document.createElement("span");
          desc.className = "dsh-skill-desc";
          desc.textContent = s.description || "";
          desc.title = s.description || "";
          row.appendChild(nm);
          row.appendChild(desc);
          if (s.builtin) {
            const locked = document.createElement("span");
            locked.className = "dsh-skill-locked";
            locked.textContent = I18n.t("不可卸载");
            locked.title = I18n.t("内置技能不可卸载");
            row.appendChild(locked);
          } else {
            const edit = document.createElement("button");
            edit.className = "mini";
            edit.textContent = I18n.t("编辑");
            edit.onclick = async () => {
              try {
                const g = await window.api.skillGet(s.name);
                if (!g || !g.ok) throw new Error((g && g.error) || I18n.t("未知错误"));
                skName.value = s.name;
                skName.disabled = true;
                skDesc.value = s.description || "";
                skBody.value = g.body || "";
                skBody.rows = 12;
                skAdd.textContent = I18n.t("保存本机修改");
                skAdd.dataset.editing = s.name;
                toast(I18n.t("已载入本机技能，修改后点「保存本机修改」"), "ok");
              } catch (e) {
                toast(I18n.t("加载失败：") + (e.message || String(e)), "err");
              }
            };
            row.appendChild(edit);
            const rm = document.createElement("button");
            rm.className = "mini";
            rm.textContent = I18n.t("移除");
            rm.onclick = async () => {
              if (!(await confirmDialog(I18n.t("移除技能 ") + s.name + I18n.t("？"), { title: I18n.t("移除技能"), danger: true, okText: I18n.t("移除") }))) return;
              try {
                const rr = await window.api.skillRemove(s.name);
                if (rr && rr.ok === false) throw new Error(rr.error);
                toast(I18n.t("已移除技能 ") + s.name, "ok");
              } catch (e) {
                toast(I18n.t("移除失败：") + (e.message || String(e)), "err");
              }
              refreshSkills();
            };
            row.appendChild(rm);
          }
          skList.appendChild(row);
        }
      } catch (e) {
        skList.textContent = I18n.t("技能列表不可用（") + (e.message || String(e)) + "）";
      }
    };
    skAdd.onclick = async () => {
      try {
        const editing = skAdd.dataset.editing || "";
        const rr = await window.api.skillAdd({
          name: (editing || skName.value).trim(),
          description: skDesc.value.trim(),
          body: skBody.value,
          overwrite: !!editing,
        });
        if (rr && rr.ok === false) throw new Error(rr.error);
        skName.value = "";
        skName.disabled = false;
        skDesc.value = "";
        skBody.value = "";
        skBody.rows = 3;
        skAdd.textContent = I18n.t("＋ 创建技能");
        delete skAdd.dataset.editing;
        toast(
          editing
            ? I18n.t("本机技能已保存（未自动同步工坊）")
            : I18n.t("技能已创建，智能节点可立即使用"),
          "ok",
        );
      } catch (e) {
        toast(I18n.t("创建失败：") + (e.message || String(e)), "err");
      }
      refreshSkills();
    };

    /* ── MCP 服务器(每个服务器为 agent 提供 mcp__<名>__<工具> 工具) ── */
    const mcTitleRow = document.createElement("div");
    mcTitleRow.className = "settings-sec-title settings-sec-title-row";
    const mcTitleSpan = document.createElement("span");
    mcTitleSpan.textContent = I18n.t("MCP 服务器（连接后智能节点自动获得该服务器的工具）");
    mcTitleRow.appendChild(mcTitleSpan);
    const mcAdd = document.createElement("button");
    mcAdd.className = "mini primary";
    mcAdd.textContent = I18n.t("＋ 添加服务器");
    mcTitleRow.appendChild(mcAdd);
    sec.appendChild(mcTitleRow);
    const mcList = document.createElement("div");
    mcList.className = "dsh-plugin-list";
    mcList.textContent = I18n.t("（读取中…）");
    sec.appendChild(mcList);
    const mcForm = document.createElement("div");
    mcForm.className = "dsh-skill-form";
    const mcName = document.createElement("input");
    mcName.type = "text";
    mcName.placeholder = I18n.t("服务器名（1-32 位字母/数字/_/-）");
    const mcTransport = document.createElement("select");
    {
      const o1 = document.createElement("option");
      o1.value = "stdio";
      o1.textContent = I18n.t("stdio（本地命令）");
      const o2 = document.createElement("option");
      o2.value = "streamable-http";
      o2.textContent = I18n.t("streamable-http（远程 URL）");
      mcTransport.appendChild(o1);
      mcTransport.appendChild(o2);
    }
    const mcCommand = document.createElement("input");
    mcCommand.type = "text";
    mcCommand.placeholder = I18n.t("命令（如 npx.cmd 或 node 完整路径）");
    const mcArgs = document.createElement("input");
    mcArgs.type = "text";
    mcArgs.placeholder = I18n.t("参数（空格分隔，如 -y @modelcontextprotocol/server-filesystem）");
    const mcUrl = document.createElement("input");
    mcUrl.type = "text";
    mcUrl.placeholder = "http(s)://host/mcp";
    mcUrl.style.display = "none";
    mcTransport.addEventListener("change", () => {
      const http = mcTransport.value !== "stdio";
      mcCommand.style.display = http ? "none" : "";
      mcArgs.style.display = http ? "none" : "";
      mcUrl.style.display = http ? "" : "none";
    });
    mcForm.appendChild(mcName);
    mcForm.appendChild(mcTransport);
    mcForm.appendChild(mcCommand);
    mcForm.appendChild(mcArgs);
    mcForm.appendChild(mcUrl);
    sec.appendChild(mcForm);
    const refreshMcp = async (attempt) => {
      attempt = attempt || 0;
      let r = null;
      try {
        r = await window.api.dshMcpList();
      } catch (e) {
        r = { ok: false, error: e.message || String(e) };
      }
      if (!r || r.ok === false || !Array.isArray(r.servers)) {
        if (attempt < 2) {
          setTimeout(() => refreshMcp(attempt + 1), 1500);
          return;
        }
        mcList.textContent =
          I18n.t("MCP 列表不可用（") + ((r && r.error) || I18n.t("引擎未连接")) + I18n.t("）· 重新打开设置重试");
        return;
      }
      mcList.innerHTML = "";
      if (!r.servers.length) {
        const em = document.createElement("div");
        em.className = "dsh-plugin-empty";
        em.textContent = I18n.t("暂无 MCP 服务器（在上方表单添加）");
        mcList.appendChild(em);
      }
      for (const s of r.servers) {
        const row = document.createElement("div");
        row.className = "dsh-plugin-row" + (s.disabled ? " off" : "");
        const nm = document.createElement("span");
        nm.textContent =
          s.serverName +
          (s.disabled ? I18n.t("（已停用）") : "") +
          " · " +
          (s.transport === "stdio" ? s.command : s.url);
        nm.title =
          "transport: " +
          s.transport +
          "\ncommand: " +
          (s.command || "") +
          "\nargs: " +
          (s.args || "") +
          "\nurl: " +
          (s.url || "");
        const btns = document.createElement("div");
        btns.className = "dsh-plugin-btns";
        const tg = document.createElement("button");
        tg.className = "mini";
        tg.textContent = s.disabled ? I18n.t("启用") : I18n.t("停用");
        tg.onclick = async () => {
          try {
            const rr = await window.api.dshMcpSetEnabled(s.serverName, !!s.disabled);
            if (rr && rr.ok === false) throw new Error(rr.error);
            toast((s.disabled ? I18n.t("已启用 ") : I18n.t("已停用 ")) + s.serverName, "ok");
          } catch (e) {
            toast(I18n.t("操作失败：") + (e.message || String(e)), "err");
          }
          refreshMcp();
          refreshStatus();
        };
        const rm = document.createElement("button");
        rm.className = "mini";
        rm.textContent = I18n.t("移除");
        rm.onclick = async () => {
          if (!(await confirmDialog(I18n.t("移除 MCP 服务器 ") + s.serverName + I18n.t("？引擎将自动重启。"), { title: I18n.t("移除 MCP"), danger: true, okText: I18n.t("移除") }))) return;
          try {
            const rr = await window.api.dshMcpRemove(s.serverName);
            if (rr && rr.ok === false) throw new Error(rr.error);
            toast(I18n.t("已移除 ") + s.serverName, "ok");
          } catch (e) {
            toast(I18n.t("移除失败：") + (e.message || String(e)), "err");
          }
          refreshMcp();
          refreshStatus();
        };
        btns.appendChild(tg);
        btns.appendChild(rm);
        row.appendChild(nm);
        row.appendChild(btns);
        mcList.appendChild(row);
      }
    };
    mcAdd.onclick = async () => {
      const transport = mcTransport.value;
      try {
        const rr = await window.api.dshMcpAdd({
          serverName: mcName.value.trim(),
          transport,
          command: mcCommand.value.trim(),
          args: mcArgs.value.trim(),
          url: mcUrl.value.trim(),
        });
        if (rr && rr.ok === false) throw new Error(rr.error);
        mcName.value = "";
        mcCommand.value = "";
        mcArgs.value = "";
        mcUrl.value = "";
        toast(I18n.t("MCP 服务器已添加，引擎重启后生效"), "ok");
      } catch (e) {
        toast(I18n.t("添加失败：") + (e.message || String(e)), "err");
      }
      refreshMcp();
      refreshStatus();
    };

    const refreshStatus = async () => {};
    plAdd.onclick = async () => {
      const pkg = plInp.value.trim();
      if (!pkg) return;
      plInp.value = "";
      plHint.textContent = I18n.t("安装中（需要联网，可能需要几分钟）…");
      try {
        const rr = await window.api.dshPluginAdd(pkg);
        if (rr && rr.ok === false) throw new Error(rr.error);
        toast((rr && rr.message) || (I18n.t("DSH 插件已安装：") + pkg), "ok");
      } catch (e) {
        toast(I18n.t("安装失败：") + (e.message || String(e)), "err");
      }
      refreshPlugins();
      refreshStatus();
    };
    refreshStatus();
    refreshPlugins();
    refreshSkills();
    refreshMcp();

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
    S.config.beta = !!betaCb.checked;
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
        preset: "standard",
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
    applyBetaUI();
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

/* 添加服务商:从目录选择(选服务商 → 输 Key → 自动载入模型列表)或手动配置 */
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

  srcSel.addEventListener("change", () => {
    const manual = srcSel.value === "manual";
    catBox.style.display = manual ? "none" : "";
    manBox.style.display = manual ? "" : "none";
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
    openSettings();
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
    openSettings();
  };
  move.appendChild(up);
  move.appendChild(down);
  head.appendChild(move);
  const del = document.createElement("span");
  del.className = "del";
  del.textContent = I18n.t("✕ 删除");
  del.title = I18n.t("删除该服务商");
  del.onclick = () => {
    S.config.providers.splice(i, 1);
    openSettings();
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
    openSettings();
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
  const paintModels = () => {
    if (!Array.isArray(prov.models)) prov.models = [];
    orderBox.innerHTML = "";
    prov.models.forEach((mid, mi) => {
      const row = document.createElement("div");
      row.className = "model-order-row";
      const idxEl = document.createElement("span");
      idxEl.className = "mo-idx";
      idxEl.textContent = String(mi + 1);
      const name = document.createElement("span");
      name.className = "mo-name" + (mi === 0 ? " pri" : "");
      name.textContent = mid;
      name.title =
        mi === 0
          ? I18n.t("当前优先使用") + " · " + mid
          : I18n.t("点击上下箭头调整优先级");
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
      row.appendChild(idxEl);
      row.appendChild(name);
      row.appendChild(up);
      row.appendChild(down);
      row.appendChild(rm);
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
  const dshEl = $("#statDsh");
  if (dshEl) {
    const txt = S.lastDshMetrics ? fmtDshMetrics(S.lastDshMetrics) : "";
    dshEl.textContent = txt;
    dshEl.title = txt
      ? txt
      : I18n.t("尚无智能运行统计（运行智能任务后在此显示）");
  }
  renderSessionFooterStat();
  updateRunQueuePanel();
}
function renderAll() {
  renderTop();
  renderCanvas();
  renderStatus();
  renderAssistPanel();
}

