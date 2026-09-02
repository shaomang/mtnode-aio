"use strict";
/* ============ 顶栏「插件」：可选组件（桌宠等） ============ */
let _petProgressOff = null;
const PLUGIN_ACT_SVG = {
  play:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5 3.2l8 4.8-8 4.8z" fill="currentColor"/></svg>',
  stop:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="4.2" y="4.2" width="7.6" height="7.6" rx="1" fill="currentColor"/></svg>',
  download:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2.4v7.2M5.4 7.4L8 10.2 10.6 7.4" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round"/><path d="M3.4 12.8h9.2" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round"/></svg>',
  update:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.5v8.2M8 9.7l-2.6-2.6M8 9.7l2.6-2.6" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M2.5 11.5v1.2c0 .7.6 1.3 1.3 1.3h8.4c.7 0 1.3-.6 1.3-1.3v-1.2" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round"/></svg>',
  trash: KIND_ICON_SVG.menu_delete,
};
function pluginIconName(item) {
  const raw = String((item && item.icon) || (item && item.id ? item.id + ".png" : "")).replace(/\\/g, "/");
  const name = raw.split("/").pop() || "";
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}\.(png|jpe?g|webp)$/i.test(name)) return "";
  return name;
}
function pluginIconUrl(item) {
  if (item && typeof item.iconDataUrl === "string" && item.iconDataUrl.indexOf("data:image/") === 0)
    return item.iconDataUrl;
  const name = pluginIconName(item);
  if (!name) return "";
  try {
    return new URL("plugin-icons/" + name, document.baseURI).href;
  } catch {
    return "plugin-icons/" + name;
  }
}
function replacePluginCover(img) {
  if (!img || !img.parentNode) return;
  const ph = document.createElement("div");
  ph.className = "plugin-tile-ph";
  img.replaceWith(ph);
}
function bindPluginCover(img, item) {
  if (!img) return;
  const url = pluginIconUrl(item);
  const name = pluginIconName(item);
  if (!url) {
    replacePluginCover(img);
    return;
  }
  let triedIpc = false;
  img.onerror = () => {
    if (!triedIpc && name && window.api && window.api.appPluginsIcon) {
      triedIpc = true;
      window.api
        .appPluginsIcon(name)
        .then((r) => {
          if (r && r.dataUrl) img.src = r.dataUrl;
          else replacePluginCover(img);
        })
        .catch(() => replacePluginCover(img));
      return;
    }
    replacePluginCover(img);
  };
  img.src = url;
}
function pluginVerLabel(st, root) {
  const v =
    (st && (st.installedVersion || st.version)) ||
    (root && root.dataset && root.dataset.catalogVer) ||
    "";
  const s = String(v).replace(/^v/i, "").trim();
  return s ? "v" + s : "";
}
function setPluginVer(root, st) {
  const el = root && root.querySelector("[data-plugin-ver]");
  if (el) el.textContent = pluginVerLabel(st, root);
}
function mkPluginActBtn(kind, title, onClick, opts) {
  const b = document.createElement("button");
  b.type = "button";
  let cls = "mini btn-sq tpl-ico plugin-act";
  if (opts && opts.primary) cls += " primary";
  if (opts && opts.danger) cls += " danger";
  if (opts && opts.on) cls += " on";
  b.className = cls;
  b.title = title;
  b.setAttribute("aria-label", title);
  b.innerHTML = PLUGIN_ACT_SVG[kind] || "";
  b.disabled = !!(opts && opts.disabled);
  b.onclick = (ev) => {
    ev.stopPropagation();
    if (onClick) onClick();
  };
  return b;
}
function closePluginPop(wrap, pop) {
  if (!wrap) return;
  wrap.querySelectorAll(".plugin-tile.sel").forEach((el) => el.classList.remove("sel"));
  wrap.classList.remove("has-pop");
  if (pop) {
    pop.classList.remove("on", "flip");
    pop.innerHTML = "";
  }
}
function positionPluginPop(wrap, pop, card) {
  if (!pop || !card || !pop.classList.contains("on")) return;
  const r = card.getBoundingClientRect();
  const popW = pop.offsetWidth || 240;
  const popH = pop.offsetHeight || 80;
  const gap = 10;
  let left = r.left - popW - gap;
  let flip = false;
  if (left < 8) {
    left = r.right + gap;
    flip = true;
  }
  let top = r.top;
  const maxTop = Math.max(8, window.innerHeight - popH - 8);
  if (top > maxTop) top = maxTop;
  if (top < 8) top = 8;
  pop.classList.toggle("flip", flip);
  pop.style.left = left + "px";
  pop.style.top = top + "px";
}
function openPluginPop(wrap, pop, card, item) {
  const already = card.classList.contains("sel");
  closePluginPop(wrap, pop);
  if (already) return;
  card.classList.add("sel");
  wrap.classList.add("has-pop");
  const title = document.createElement("div");
  title.className = "plugin-pop-title";
  title.textContent = pluginLoc(item, "title") || item.id;
  const desc = document.createElement("div");
  desc.className = "plugin-pop-desc";
  desc.textContent = pluginLoc(item, "subtitle") || I18n.t("暂无描述");
  pop.appendChild(title);
  pop.appendChild(desc);
  pop.classList.add("on");
  requestAnimationFrame(() => positionPluginPop(wrap, pop, card));
}
function ensurePetExtras(root) {
  let extras = root.querySelector("[data-pet-extras]");
  if (extras) return extras;
  extras = document.createElement("div");
  extras.setAttribute("data-pet-extras", "1");
  extras.style.marginTop = "10px";
  extras.style.display = "none";
  root.appendChild(extras);
  return extras;
}
async function paintPetExtras(root, st) {
  const extras = ensurePetExtras(root);
  if (!st || !st.installed) {
    extras.style.display = "none";
    extras.innerHTML = "";
    return;
  }
  extras.style.display = "block";
  extras.innerHTML = "";
  const cfg = (st.config || {});
  const row = document.createElement("div");
  row.className = "plugin-card-actions";
  row.style.marginTop = "0";

  const mkCheck = (label, key) => {
    const lab = document.createElement("label");
    lab.style.display = "inline-flex";
    lab.style.alignItems = "center";
    lab.style.gap = "6px";
    lab.style.fontSize = "12px";
    lab.style.color = "var(--muted)";
    const inp = document.createElement("input");
    inp.type = "checkbox";
    inp.checked = !!cfg[key];
    inp.onchange = async () => {
      const patch = {};
      patch[key] = !!inp.checked;
      await window.api.petSetConfig(patch);
      refreshPetPluginCard(root);
    };
    lab.appendChild(inp);
    lab.appendChild(document.createTextNode(label));
    row.appendChild(lab);
  };
  mkCheck(I18n.t("窗口穿透"), "penetrable");
  mkCheck(I18n.t("始终置顶"), "alwaysOnTop");
  mkCheck(I18n.t("镜像"), "mirror");
  mkCheck(I18n.t("悬停隐藏"), "hideOnHover");
  extras.appendChild(row);

  const row2 = document.createElement("div");
  row2.className = "plugin-card-actions";
  const scaleLab = document.createElement("label");
  scaleLab.style.fontSize = "12px";
  scaleLab.style.color = "var(--muted)";
  scaleLab.textContent = I18n.t("缩放");
  const scaleSel = document.createElement("select");
  [50, 75, 100, 125, 150].forEach((v) => {
    const o = document.createElement("option");
    o.value = String(v);
    o.textContent = v + "%";
    if (Number(cfg.scale) === v) o.selected = true;
    scaleSel.appendChild(o);
  });
  scaleSel.onchange = async () => {
    await window.api.petSetConfig({ scale: Number(scaleSel.value) });
    refreshPetPluginCard(root);
  };
  scaleLab.appendChild(document.createTextNode(" "));
  scaleLab.appendChild(scaleSel);
  row2.appendChild(scaleLab);

  const opLab = document.createElement("label");
  opLab.style.fontSize = "12px";
  opLab.style.color = "var(--muted)";
  opLab.textContent = I18n.t("透明度");
  const opSel = document.createElement("select");
  [40, 60, 80, 100].forEach((v) => {
    const o = document.createElement("option");
    o.value = String(v);
    o.textContent = v + "%";
    if (Number(cfg.opacity) === v) o.selected = true;
    opSel.appendChild(o);
  });
  opSel.onchange = async () => {
    await window.api.petSetConfig({ opacity: Number(opSel.value) });
    refreshPetPluginCard(root);
  };
  opLab.appendChild(document.createTextNode(" "));
  opLab.appendChild(opSel);
  row2.appendChild(opLab);
  extras.appendChild(row2);

  const row3 = document.createElement("div");
  row3.className = "plugin-card-actions";
  const skinLab = document.createElement("label");
  skinLab.style.fontSize = "12px";
  skinLab.style.color = "var(--muted)";
  skinLab.textContent = I18n.t("形象");
  const skinSel = document.createElement("select");
  (st.skins || []).forEach((s) => {
    const o = document.createElement("option");
    o.value = s.id;
    o.textContent = s.name || s.id;
    if ((cfg.skinId || "default") === s.id) o.selected = true;
    skinSel.appendChild(o);
  });
  skinSel.onchange = async () => {
    await window.api.petSetSkin(skinSel.value);
    refreshPetPluginCard(root);
  };
  skinLab.appendChild(document.createTextNode(" "));
  skinLab.appendChild(skinSel);
  row3.appendChild(skinLab);
  const importBtn = document.createElement("button");
  importBtn.className = "mini";
  importBtn.textContent = I18n.t("导入形象…");
  importBtn.onclick = async () => {
    const r = await window.api.petImportSkin();
    if (r && r.ok) toast(I18n.t("已导入形象：") + (r.name || r.id), "ok");
    else if (r && r.error && r.error !== "cancelled")
      toast(I18n.t("导入失败：") + r.error, "err");
    refreshPetPluginCard(root);
  };
  row3.appendChild(importBtn);
  extras.appendChild(row3);

  if (st.running && st.hook === false) {
    const tip = document.createElement("div");
    tip.className = "plugin-progress-txt";
    tip.style.display = "block";
    tip.textContent = I18n.t("全局键鼠钩子未就绪（仍可使用窗口与形象功能）");
    extras.appendChild(tip);
  }
}
async function refreshPetPluginCard(root) {
  if (!root || !window.api || !window.api.petStatus) return;
  const st = await window.api.petStatus();
  const actions = root.querySelector("[data-pet-actions]");
  const prog = root.querySelector("[data-pet-progress]");
  const progTxt = root.querySelector("[data-plugin-progress-txt]");
  if (!actions) return;
  setPluginVer(root, st);
  actions.innerHTML = "";
  const addBtn = (kind, title, onClick, opts) => {
    actions.appendChild(mkPluginActBtn(kind, title, onClick, opts));
  };
  if (!st.installed) {
    addBtn("download", I18n.t("下载安装"), async () => {
      if (prog) prog.style.display = "block";
      if (progTxt) {
        progTxt.style.display = "block";
        progTxt.textContent = I18n.t("准备下载…");
      }
      const bar = prog && prog.querySelector("i");
      if (bar) bar.style.width = "2%";
      const r = await window.api.petInstall();
      if (prog) prog.style.display = "none";
      if (progTxt) progTxt.style.display = "none";
      if (r && r.ok) {
        toast(
          I18n.t("桌宠已安装") +
            (r.version ? " v" + r.version : "") +
            (r.source === "local-fallback" ? I18n.t("（本地包）") : ""),
          "ok",
        );
      } else {
        toast(I18n.t("桌宠安装失败：") + ((r && r.error) || I18n.t("未知错误")), "err");
      }
      refreshPetPluginCard(root);
    }, { primary: true, disabled: !!st.installing });
  } else {
    if (st.running) {
      addBtn("stop", I18n.t("停止"), async () => {
        await window.api.petStop();
        refreshPetPluginCard(root);
      });
    } else {
      addBtn("play", I18n.t("运行"), async () => {
        const r = await window.api.petStart();
        if (!r || !r.ok) {
          toast(I18n.t("启动桌宠失败：") + ((r && r.error) || I18n.t("未知错误")), "err");
        }
        refreshPetPluginCard(root);
      }, { primary: true });
    }
    if (st.updateAvailable) {
      addBtn("update", I18n.t("更新"), async () => {
        if (prog) prog.style.display = "block";
        if (progTxt) {
          progTxt.style.display = "block";
          progTxt.textContent = I18n.t("准备下载…");
        }
        const wasRunning = !!st.running;
        if (wasRunning) await window.api.petStop();
        const r = await window.api.petInstall();
        if (prog) prog.style.display = "none";
        if (progTxt) progTxt.style.display = "none";
        if (r && r.ok) {
          toast(I18n.t("插件已更新") + (r.version ? " v" + r.version : ""), "ok");
          if (wasRunning) await window.api.petStart();
        } else {
          toast(I18n.t("桌宠安装失败：") + ((r && r.error) || I18n.t("未知错误")), "err");
        }
        refreshPetPluginCard(root);
      });
    }
    addBtn("trash", I18n.t("卸载"), async () => {
      if (!(await confirmDialog(I18n.t("卸载桌宠？将删除已下载的运行时文件。"), { title: I18n.t("卸载桌宠"), danger: true, okText: I18n.t("卸载") }))) return;
      await window.api.petUninstall();
      toast(I18n.t("桌宠已卸载"), "ok");
      refreshPetPluginCard(root);
    }, { danger: true });
  }
  const extras = root.querySelector("[data-pet-extras]");
  if (extras) {
    extras.style.display = "none";
    extras.innerHTML = "";
  }
}
async function refreshMusic3PluginCard(root) {
  if (!root || !window.api || !window.api.music3Status) return;
  const st = await window.api.music3Status();
  const actions = root.querySelector("[data-plugin-actions]");
  const prog = root.querySelector("[data-plugin-progress]");
  const progTxt = root.querySelector("[data-plugin-progress-txt]");
  if (!actions) return;
  setPluginVer(root, { version: st.version, installed: true });
  actions.innerHTML = "";
  const addBtn = (kind, title, onClick, opts) => {
    actions.appendChild(mkPluginActBtn(kind, title, onClick, opts));
  };
  /* 列表仅保留控制台 运行/停止 互斥开关；后端启停在控制台窗口内操作，避免 play+stop 并存 */
  if (st.consoleOpen) {
    addBtn("stop", I18n.t("停止"), async () => {
      if (window.api.music3Close) await window.api.music3Close();
      refreshMusic3PluginCard(root);
    });
  } else {
    addBtn("play", I18n.t("运行"), async () => {
      const r = await window.api.music3Open();
      if (!r || !r.ok) toast(I18n.t("打开失败：") + ((r && r.error) || I18n.t("未知错误")), "err");
      refreshMusic3PluginCard(root);
    }, { primary: true });
  }
  if (st.updateAvailable && window.api.music3UpdateRuntime) {
    addBtn(
      "update",
      I18n.t("更新") + (st.latestVersion || st.feedVersion ? " → v" + (st.feedVersion || st.latestVersion) : ""),
      async () => {
        if (prog) prog.style.display = "block";
        if (progTxt) {
          progTxt.style.display = "block";
          progTxt.textContent = I18n.t("准备下载…");
        }
        const wasOpen = !!st.consoleOpen;
        if (wasOpen && window.api.music3Close) await window.api.music3Close();
        const r = await window.api.music3UpdateRuntime();
        if (prog) prog.style.display = "none";
        if (progTxt) progTxt.style.display = "none";
        if (r && r.ok) {
          toast(I18n.t("插件已更新") + (r.version ? " v" + r.version : ""), "ok");
          if (wasOpen && window.api.music3Open) await window.api.music3Open();
        } else {
          toast(I18n.t("安装失败：") + ((r && r.error) || I18n.t("未知错误")), "err");
        }
        refreshMusic3PluginCard(root);
      },
      { disabled: !!st.updating || !!st.installing },
    );
  }
  addBtn("trash", I18n.t("移除入口"), async () => {
    if (
      !(await confirmDialog(
        I18n.t("仅移除插件入口与控制台缓存，不会删除你设置的安装目录中的项目与模型。"),
        { title: I18n.t("移除插件入口"), danger: false, okText: I18n.t("移除") },
      ))
    )
      return;
    if (window.api.music3RemovePluginMeta) await window.api.music3RemovePluginMeta();
    toast(I18n.t("已移除入口；安装目录项目已保留"), "ok");
    refreshMusic3PluginCard(root);
  }, { danger: true });
  if (prog && (st.installing || st.updating)) {
    prog.style.display = "block";
    if (progTxt) {
      progTxt.style.display = "block";
      progTxt.textContent = st.updating ? I18n.t("更新中…") : I18n.t("安装中…");
    }
  }
}
function bindMusic3Progress(host) {
  if (!window.api || !window.api.onMusic3Progress) return null;
  const prog = host.querySelector("[data-plugin-progress]");
  const progTxt = host.querySelector("[data-plugin-progress-txt]");
  return window.api.onMusic3Progress((data) => {
    if (!data || (data.id && data.id !== "minimax-music3")) return;
    if (data.phase !== "install" && data.phase !== "dsh" && data.phase !== "update") return;
    if (prog) prog.style.display = "block";
    if (progTxt) progTxt.style.display = "block";
    const pct = Math.max(0, Math.min(100, Number(data.pct) || 0));
    const bar = prog && prog.querySelector("i");
    if (bar) bar.style.width = pct + "%";
    if (progTxt) {
      progTxt.textContent =
        (data.stepLabel || data.step || I18n.t("安装中…")) +
        (data.message ? " — " + data.message : "") +
        " " +
        pct +
        "%";
    }
    if (data.step === "done" || data.error) {
      setTimeout(() => {
        if (prog) prog.style.display = "none";
        if (progTxt) progTxt.style.display = "none";
        refreshMusic3PluginCard(host);
      }, 600);
    }
  });
}
async function refreshH3PluginCard(root) {
  if (!root || !window.api || !window.api.h3Status) return;
  const st = await window.api.h3Status();
  const actions = root.querySelector("[data-plugin-actions]");
  const prog = root.querySelector("[data-plugin-progress]");
  const progTxt = root.querySelector("[data-plugin-progress-txt]");
  if (!actions) return;
  setPluginVer(root, { version: st.version, installed: true });
  actions.innerHTML = "";
  const addBtn = (kind, title, onClick, opts) => {
    actions.appendChild(mkPluginActBtn(kind, title, onClick, opts));
  };
  /* 列表仅保留控制台 运行/停止 互斥开关；后端启停在控制台窗口内操作，避免 play+stop 并存 */
  if (st.consoleOpen) {
    addBtn("stop", I18n.t("停止"), async () => {
      if (window.api.h3Close) await window.api.h3Close();
      refreshH3PluginCard(root);
    });
  } else {
    addBtn("play", I18n.t("运行"), async () => {
      const r = await window.api.h3Open();
      if (!r || !r.ok) toast(I18n.t("打开失败：") + ((r && r.error) || I18n.t("未知错误")), "err");
      refreshH3PluginCard(root);
    }, { primary: true });
  }
  if (st.updateAvailable && window.api.h3UpdateRuntime) {
    addBtn(
      "update",
      I18n.t("更新") + (st.latestVersion || st.feedVersion ? " → v" + (st.feedVersion || st.latestVersion) : ""),
      async () => {
        if (prog) prog.style.display = "block";
        if (progTxt) {
          progTxt.style.display = "block";
          progTxt.textContent = I18n.t("准备下载…");
        }
        const wasOpen = !!st.consoleOpen;
        if (wasOpen && window.api.h3Close) await window.api.h3Close();
        const r = await window.api.h3UpdateRuntime();
        if (prog) prog.style.display = "none";
        if (progTxt) progTxt.style.display = "none";
        if (r && r.ok) {
          toast(I18n.t("插件已更新") + (r.version ? " v" + r.version : ""), "ok");
          if (wasOpen && window.api.h3Open) await window.api.h3Open();
        } else {
          toast(I18n.t("安装失败：") + ((r && r.error) || I18n.t("未知错误")), "err");
        }
        refreshH3PluginCard(root);
      },
      { disabled: !!st.updating || !!st.installing },
    );
  }
  addBtn("trash", I18n.t("移除入口"), async () => {
    if (
      !(await confirmDialog(
        I18n.t("仅移除插件入口与控制台缓存，不会删除你设置的安装目录中的项目与模型。"),
        { title: I18n.t("移除插件入口"), danger: false, okText: I18n.t("移除") },
      ))
    )
      return;
    if (window.api.h3RemovePluginMeta) await window.api.h3RemovePluginMeta();
    toast(I18n.t("已移除入口；安装目录项目已保留"), "ok");
    refreshH3PluginCard(root);
  }, { danger: true });
  if (prog && (st.installing || st.updating)) {
    prog.style.display = "block";
    if (progTxt) {
      progTxt.style.display = "block";
      progTxt.textContent = st.updating ? I18n.t("更新中…") : I18n.t("安装中…");
    }
  }
}
function bindH3Progress(host) {
  if (!window.api || !window.api.onH3Progress) return null;
  const prog = host.querySelector("[data-plugin-progress]");
  const progTxt = host.querySelector("[data-plugin-progress-txt]");
  return window.api.onH3Progress((data) => {
    if (!data || (data.id && data.id !== "minimax-h3")) return;
    if (data.phase !== "install" && data.phase !== "dsh" && data.phase !== "update") return;
    if (prog) prog.style.display = "block";
    if (progTxt) progTxt.style.display = "block";
    const pct = Math.max(0, Math.min(100, Number(data.pct) || 0));
    const bar = prog && prog.querySelector("i");
    if (bar) bar.style.width = pct + "%";
    if (progTxt) {
      progTxt.textContent =
        (data.stepLabel || data.step || I18n.t("安装中…")) +
        (data.message ? " — " + data.message : "") +
        " " +
        pct +
        "%";
    }
    if (data.step === "done" || data.error) {
      setTimeout(() => {
        if (prog) prog.style.display = "none";
        if (progTxt) progTxt.style.display = "none";
        refreshH3PluginCard(host);
      }, 600);
    }
  });
}

/* ── Remotion 动效视频（应用插件 kind remotion） ──
   安装流程在插件控制台窗内完成（设置目录 → 复制 remotion-pack → npm install），
   卡片只做状态展示与入口：未安装 → 「打开控制台安装」；已安装 → 运行/停止控制台 + 移除入口。 */
async function refreshRemotionPluginCard(root) {
  if (!root || !window.api || !window.api.remotionStatus) return;
  const st = await window.api.remotionStatus();
  const actions = root.querySelector("[data-plugin-actions]");
  const prog = root.querySelector("[data-plugin-progress]");
  const progTxt = root.querySelector("[data-plugin-progress-txt]");
  if (!actions) return;
  setPluginVer(root, { version: st.version, installed: !!st.installed });
  actions.innerHTML = "";
  const addBtn = (kind, title, onClick, opts) => {
    actions.appendChild(mkPluginActBtn(kind, title, onClick, opts));
  };
  const openConsole = async () => {
    const r = await window.api.remotionOpen();
    if (!r || !r.ok) {
      toast(I18n.t("打开失败：") + ((r && r.error) || I18n.t("未知错误")), "err");
    }
  };
  if (!st.installed) {
    addBtn("download", I18n.t("打开控制台安装"), openConsole, {
      primary: true,
      disabled: !!st.installing,
    });
    const hint = document.createElement("div");
    hint.className = "plugin-progress-txt";
    hint.style.display = "block";
    hint.textContent = I18n.t("在控制台窗中设置安装目录并安装（npm install，需联网）");
    actions.appendChild(hint);
  } else {
    if (st.consoleOpen) {
      addBtn("stop", I18n.t("停止"), async () => {
        if (window.api.remotionClose) await window.api.remotionClose();
        refreshRemotionPluginCard(root);
      });
    } else {
      addBtn("play", I18n.t("运行"), openConsole, { primary: true });
    }
    addBtn("trash", I18n.t("移除入口"), async () => {
      if (
        !(await confirmDialog(
          I18n.t("仅移除插件入口与控制台缓存，不会删除你设置的安装目录中的项目与模型。"),
          { title: I18n.t("移除插件入口"), danger: false, okText: I18n.t("移除") },
        ))
      )
        return;
      if (window.api.remotionRemovePluginMeta) await window.api.remotionRemovePluginMeta();
      toast(I18n.t("已移除入口；安装目录项目已保留"), "ok");
      refreshRemotionPluginCard(root);
      if (typeof refreshAppPluginsCache === "function") refreshAppPluginsCache();
    }, { danger: true });
  }
  if (st.installed && st.installDir) {
    const dirHint = document.createElement("div");
    dirHint.className = "plugin-progress-txt";
    dirHint.style.display = "block";
    dirHint.textContent = st.installDir;
    actions.appendChild(dirHint);
  }
  if (prog && (st.installing || st.rendering)) {
    prog.style.display = "block";
    if (progTxt) {
      progTxt.style.display = "block";
      progTxt.textContent = st.installing
        ? I18n.t("安装中…")
        : I18n.t("渲染中 ") + Math.round(st.renderState ? st.renderState.pct || 0 : 0) + "%";
    }
  }
}
function bindRemotionProgress(host) {
  if (!window.api || !window.api.onRemotionProgress) return null;
  const prog = host.querySelector("[data-plugin-progress]");
  const progTxt = host.querySelector("[data-plugin-progress-txt]");
  return window.api.onRemotionProgress((data) => {
    if (!data || (data.id && data.id !== "remotion")) return;
    if (data.phase !== "install" && data.phase !== "render") return;
    if (prog) prog.style.display = "block";
    if (progTxt) progTxt.style.display = "block";
    const pct = Math.max(0, Math.min(100, Number(data.pct) || 0));
    const bar = prog && prog.querySelector("i");
    if (bar) bar.style.width = pct + "%";
    if (progTxt) {
      progTxt.textContent =
        (data.stepLabel || data.step || I18n.t("安装中…")) +
        (data.message ? " — " + data.message : "") +
        " " +
        pct +
        "%";
    }
    if (data.step === "done" || data.error) {
      setTimeout(() => {
        if (prog) prog.style.display = "none";
        if (progTxt) progTxt.style.display = "none";
        refreshRemotionPluginCard(host);
        /* 安装完成 / 失败后刷新画布插件缓存（菜单项可见性 / 节点警示条） */
        if (typeof refreshAppPluginsCache === "function") refreshAppPluginsCache();
      }, 600);
    }
  });
}
async function refreshLlamaPluginCard(root) {
  if (!root || !window.api || !window.api.llamaStatus) return;
  const st = await window.api.llamaStatus();
  const actions = root.querySelector("[data-plugin-actions]");
  const prog = root.querySelector("[data-plugin-progress]");
  const progTxt = root.querySelector("[data-plugin-progress-txt]");
  if (!actions) return;
  setPluginVer(root, { version: st.version, installed: true });
  actions.innerHTML = "";
  const addBtn = (kind, title, onClick, opts) => {
    actions.appendChild(mkPluginActBtn(kind, title, onClick, opts));
  };
  if (st.consoleOpen) {
    addBtn("stop", I18n.t("停止"), async () => {
      if (window.api.llamaClose) await window.api.llamaClose();
      refreshLlamaPluginCard(root);
    });
  } else {
    addBtn("play", I18n.t("运行"), async () => {
      const r = await window.api.llamaOpen();
      if (!r || !r.ok) toast(I18n.t("打开失败：") + ((r && r.error) || I18n.t("未知错误")), "err");
      refreshLlamaPluginCard(root);
    }, { primary: true });
  }
  addBtn("trash", I18n.t("移除入口"), async () => {
    if (
      !(await confirmDialog(
        I18n.t("仅移除插件入口与控制台缓存，不会删除你设置的安装目录中的项目与模型。"),
        { title: I18n.t("移除插件入口"), danger: false, okText: I18n.t("移除") },
      ))
    )
      return;
    if (window.api.llamaRemovePluginMeta) await window.api.llamaRemovePluginMeta();
    toast(I18n.t("已移除入口；安装目录项目已保留"), "ok");
    refreshLlamaPluginCard(root);
  }, { danger: true });
  if (prog && st.installing) {
    prog.style.display = "block";
    if (progTxt) {
      progTxt.style.display = "block";
      progTxt.textContent = I18n.t("安装中…");
    }
  }
}
function bindLlamaProgress(host) {
  if (!window.api || !window.api.onLlamaProgress) return null;
  const prog = host.querySelector("[data-plugin-progress]");
  const progTxt = host.querySelector("[data-plugin-progress-txt]");
  return window.api.onLlamaProgress((data) => {
    if (!data || (data.id && data.id !== "llama-local")) return;
    if (data.phase !== "install" && data.phase !== "dsh") return;
    if (prog) prog.style.display = "block";
    if (progTxt) progTxt.style.display = "block";
    const pct = Math.max(0, Math.min(100, Number(data.pct) || 0));
    const bar = prog && prog.querySelector("i");
    if (bar) bar.style.width = pct + "%";
    if (progTxt) {
      progTxt.textContent =
        (data.stepLabel || data.step || I18n.t("安装中…")) +
        (data.message ? " — " + data.message : "") +
        " " +
        pct +
        "%";
    }
    if (data.step === "done" || data.error) {
      setTimeout(() => {
        if (prog) prog.style.display = "none";
        if (progTxt) progTxt.style.display = "none";
        refreshLlamaPluginCard(host);
      }, 600);
    }
  });
}
async function refreshTtsPluginCard(root) {
  if (!root || !window.api || !window.api.ttsStatus) return;
  const st = await window.api.ttsStatus();
  const actions = root.querySelector("[data-plugin-actions]");
  const prog = root.querySelector("[data-plugin-progress]");
  const progTxt = root.querySelector("[data-plugin-progress-txt]");
  if (!actions) return;
  setPluginVer(root, { version: st.version, installed: true });
  actions.innerHTML = "";
  const addBtn = (kind, title, onClick, opts) => {
    actions.appendChild(mkPluginActBtn(kind, title, onClick, opts));
  };
  if (st.consoleOpen) {
    addBtn("stop", I18n.t("停止"), async () => {
      if (window.api.ttsClose) await window.api.ttsClose();
      refreshTtsPluginCard(root);
    });
  } else {
    addBtn("play", I18n.t("运行"), async () => {
      const r = await window.api.ttsOpen();
      if (!r || !r.ok) toast(I18n.t("打开失败：") + ((r && r.error) || I18n.t("未知错误")), "err");
      refreshTtsPluginCard(root);
    }, { primary: true });
  }
  addBtn("trash", I18n.t("移除入口"), async () => {
    if (
      !(await confirmDialog(
        I18n.t("仅移除插件入口与控制台缓存，不会删除你设置的安装目录中的项目与模型。"),
        { title: I18n.t("移除插件入口"), danger: false, okText: I18n.t("移除") },
      ))
    )
      return;
    if (window.api.ttsRemovePluginMeta) await window.api.ttsRemovePluginMeta();
    toast(I18n.t("已移除入口；安装目录项目已保留"), "ok");
    refreshTtsPluginCard(root);
  }, { danger: true });
  if (prog && st.installing) {
    prog.style.display = "block";
    if (progTxt) {
      progTxt.style.display = "block";
      progTxt.textContent = I18n.t("安装中…");
    }
  }
}
function bindTtsProgress(host) {
  if (!window.api || !window.api.onTtsProgress) return null;
  const prog = host.querySelector("[data-plugin-progress]");
  const progTxt = host.querySelector("[data-plugin-progress-txt]");
  return window.api.onTtsProgress((data) => {
    if (!data || (data.id && data.id !== "tts-local")) return;
    if (data.phase !== "install" && data.phase !== "dsh") return;
    if (prog) prog.style.display = "block";
    if (progTxt) progTxt.style.display = "block";
    const pct = Math.max(0, Math.min(100, Number(data.pct) || 0));
    const bar = prog && prog.querySelector("i");
    if (bar) bar.style.width = pct + "%";
    if (progTxt) {
      progTxt.textContent =
        (data.stepLabel || data.step || I18n.t("安装中…")) +
        (data.message ? " — " + data.message : "") +
        " " +
        pct +
        "%";
    }
    if (data.step === "done" || data.error) {
      setTimeout(() => {
        if (prog) prog.style.display = "none";
        if (progTxt) progTxt.style.display = "none";
        refreshTtsPluginCard(host);
      }, 600);
    }
  });
}
function pluginLoc(p, key) {
  const v = p && p[key];
  if (v && typeof v === "object") {
    const loc = I18n.getLocale && I18n.getLocale() === "en" ? "en" : "zh";
    return v[loc] || v.zh || v.en || "";
  }
  return String(v || "");
}
function pluginCatalogHint(cat) {
  const src = cat && cat.source;
  if (src === "remote") return I18n.t("插件列表来自云端，可不升级主程序获取新插件。");
  if (src === "cache") {
    return (
      I18n.t("云端目录暂不可用，已显示上次缓存。") +
      (cat.remoteError ? " (" + cat.remoteError + ")" : "")
    );
  }
  return (
    I18n.t("云端目录暂不可用，已显示内置列表。") +
    (cat && cat.remoteError ? " (" + cat.remoteError + ")" : "")
  );
}
function pluginErrText(err) {
  const s = String(err || "");
  if (s === "need_app_update") return I18n.t("请先升级主程序");
  if (s === "sha256_mismatch") return I18n.t("安装包校验失败");
  if (s === "not_window_plugin") return I18n.t("此插件需升级主程序后才能安装");
  if (s === "bad_zip_url") return I18n.t("下载地址无效");
  if (s === "pack_missing_entry") return I18n.t("安装包缺少入口页");
  if (s === "not_installed") return I18n.t("尚未安装");
  if (s === "not_ready") return I18n.t("尚未安装");
  if (s === "too_large") return I18n.t("安装包过大");
  if (s === "timeout") return I18n.t("下载超时");
  if (s === "busy") return I18n.t("正在安装…");
  return s || I18n.t("未知错误");
}
function bindPluginProgress(host, pluginId, isPet) {
  const prog = host.querySelector("[data-plugin-progress]");
  const progTxt = host.querySelector("[data-plugin-progress-txt]");
  const apply = (data) => {
    if (!data) return;
    if (isPet && data.id && data.id !== "bongochat") return;
    if (!isPet && data.id && data.id !== pluginId) return;
    if (prog) prog.style.display = "block";
    if (progTxt) progTxt.style.display = "block";
    const pct = Math.max(0, Math.min(100, Number(data.percent) || 0));
    const bar = prog && prog.querySelector("i");
    if (bar) bar.style.width = pct + "%";
    const phase = data.phase || "";
    let msg = pct + "%";
    if (phase === "manifest") msg = I18n.t("读取清单…");
    else if (phase === "download") msg = I18n.t("下载中…") + " " + pct + "%";
    else if (phase === "extract" || phase === "copy") msg = I18n.t("解压安装中…");
    else if (phase === "done") msg = I18n.t("完成");
    else if (phase === "error") msg = I18n.t("失败：") + pluginErrText(data.error);
    if (progTxt) progTxt.textContent = msg;
    if (phase === "done" || phase === "error") {
      setTimeout(() => {
        if (prog) prog.style.display = "none";
        if (progTxt) progTxt.style.display = "none";
      }, 800);
    }
  };
  if (isPet && window.api && window.api.onPetProgress) {
    const off = window.api.onPetProgress(apply);
    return off;
  }
  if (!isPet && window.api && window.api.onAppPluginsProgress) {
    return window.api.onAppPluginsProgress(apply);
  }
  return null;
}
async function refreshWindowPluginCard(host, item) {
  const actions = host.querySelector("[data-plugin-actions]");
  if (!actions) return;
  const st = item || {};
  setPluginVer(host, st);
  actions.innerHTML = "";
  const addBtn = (kind, title, onClick, opts) => {
    actions.appendChild(mkPluginActBtn(kind, title, onClick, opts));
  };
  if (!st.compatible) {
    addBtn("download", I18n.t("请先升级主程序"), null, { disabled: true });
    return;
  }
  if (st.kind === "unknown") {
    addBtn("download", I18n.t("请更新应用以使用此插件"), null, { disabled: true });
    return;
  }
  if (!st.installed) {
    addBtn("download", I18n.t("下载安装"), async () => {
      const r = await window.api.appPluginsInstall(st.id);
      if (r && r.ok) toast(I18n.t("插件已安装") + (r.version ? " v" + r.version : ""), "ok");
      else toast(I18n.t("安装失败：") + pluginErrText(r && r.error), "err");
      const cat = await window.api.appPluginsCatalog();
      const next = ((cat && cat.plugins) || []).find((p) => p.id === st.id);
      if (next) host._pluginItem = next;
      refreshWindowPluginCard(host, next || st);
    }, { primary: true });
    return;
  }
  let winOpen = false;
  if (window.api.appPluginsIsOpen) {
    try {
      const ir = await window.api.appPluginsIsOpen(st.id);
      winOpen = !!(ir && ir.open);
    } catch {}
  }
  if (winOpen) {
    addBtn("stop", I18n.t("停止"), async () => {
      if (window.api.appPluginsClose) await window.api.appPluginsClose(st.id);
      refreshWindowPluginCard(host, host._pluginItem || st);
    });
  } else {
    addBtn("play", I18n.t("运行"), async () => {
      const r = await window.api.appPluginsOpen(st.id);
      if (!r || !r.ok) toast(I18n.t("打开失败：") + pluginErrText(r && r.error), "err");
      refreshWindowPluginCard(host, host._pluginItem || st);
    }, { primary: true });
  }
  if (st.updateAvailable) {
    addBtn("update", I18n.t("更新"), async () => {
      const r = await window.api.appPluginsInstall(st.id);
      if (r && r.ok) toast(I18n.t("插件已更新") + (r.version ? " v" + r.version : ""), "ok");
      else toast(I18n.t("安装失败：") + pluginErrText(r && r.error), "err");
      const cat = await window.api.appPluginsCatalog();
      const next = ((cat && cat.plugins) || []).find((p) => p.id === st.id);
      if (next) host._pluginItem = next;
      refreshWindowPluginCard(host, next || st);
    });
  }
  addBtn("trash", I18n.t("卸载"), async () => {
    if (
      !(await confirmDialog(I18n.t("卸载该插件？将删除已下载的运行时文件。"), {
        title: I18n.t("卸载插件"),
        danger: true,
        okText: I18n.t("卸载"),
      }))
    )
      return;
    await window.api.appPluginsUninstall(st.id);
    toast(I18n.t("插件已卸载"), "ok");
    const cat = await window.api.appPluginsCatalog();
    const next = ((cat && cat.plugins) || []).find((p) => p.id === st.id);
    if (!next) {
      const wrap = host.closest(".plugin-grid-wrap");
      const pop = wrap && wrap.querySelector(".plugin-pop");
      if (wrap) closePluginPop(wrap, pop);
      host.remove();
    } else {
      host._pluginItem = next;
      refreshWindowPluginCard(host, next);
    }
  }, { danger: true });
}
function mkPluginCardShell(item) {
  const card = document.createElement("div");
  card.className = "plugin-tile";
  card.setAttribute("data-plugin-id", item.id);
  card.setAttribute("role", "button");
  card.tabIndex = 0;
  if (item.version) card.dataset.catalogVer = String(item.version);
  const iconUrl = pluginIconUrl(item);
  const ver = pluginVerLabel(item, card);
  card.innerHTML =
    '<div class="plugin-tile-cover">' +
    (iconUrl
      ? '<img alt="" width="128" height="128">'
      : '<div class="plugin-tile-ph"></div>') +
    "</div>" +
    '<div class="plugin-tile-title"></div>' +
    '<div class="plugin-tile-ver" data-plugin-ver></div>' +
    '<div class="plugin-tile-actions" data-plugin-actions data-pet-actions></div>' +
    '<div class="plugin-progress" data-plugin-progress data-pet-progress style="display:none"><i></i></div>' +
    '<div class="plugin-progress-txt" data-plugin-progress-txt data-pet-progress-txt style="display:none"></div>';
  card.querySelector(".plugin-tile-title").textContent = pluginLoc(item, "title") || item.id;
  card.querySelector("[data-plugin-ver]").textContent = ver;
  const img = card.querySelector(".plugin-tile-cover img");
  if (img) {
    img.alt = pluginLoc(item, "title") || item.id;
    bindPluginCover(img, item);
  }
  return card;
}
async function openAppPluginsDialog() {
  openOverlay(I18n.t("插件"));
  overlayPersistent = true;
  const body = $("#ovBody");
  const foot = $("#ovFoot");
  body.innerHTML = "";
  foot.innerHTML = "";

  const intro = document.createElement("div");
  intro.className = "settings-hint";
  intro.style.marginBottom = "12px";
  intro.textContent = I18n.t("正在拉取云端插件目录…");
  body.appendChild(intro);

  if (_petProgressOff) {
    try { _petProgressOff(); } catch {}
    _petProgressOff = null;
  }

  const closeBtn = document.createElement("button");
  closeBtn.className = "mini";
  closeBtn.textContent = I18n.t("关闭");
  closeBtn.onclick = () => {
    if (_petProgressOff) {
      try { _petProgressOff(); } catch {}
      _petProgressOff = null;
    }
    closeOverlay();
  };
  const refreshBtn = document.createElement("button");
  refreshBtn.className = "mini";
  refreshBtn.textContent = I18n.t("刷新目录");
  refreshBtn.onclick = () => openAppPluginsDialog();
  foot.appendChild(closeBtn);
  foot.appendChild(refreshBtn);

  let cat = { ok: true, source: "fallback", plugins: [] };
  try {
    if (window.api && window.api.appPluginsCatalog)
      cat = (await window.api.appPluginsCatalog()) || cat;
  } catch (e) {
    cat.remoteError = (e && e.message) || String(e);
  }
  intro.textContent = pluginCatalogHint(cat);
  const list = (
    Array.isArray(cat.plugins) && cat.plugins.length
      ? cat.plugins
      : [
          {
            id: "bongochat",
            kind: "pet",
            handler: "pet",
            icon: "bongochat.png",
            version: "0.3.7",
            title: { zh: "BongoChat", en: "BongoChat" },
            subtitle: { zh: I18n.t("可以聊天的BongoCat！"), en: "A BongoCat you can chat with!" },
            compatible: true,
          },
          {
            id: "llama-local",
            kind: "llama",
            handler: "llama",
            icon: "llama-local.png",
            version: "1.0.0",
            title: { zh: "llama.cpp 本地模型", en: "llama.cpp Local Models" },
            subtitle: {
              zh: I18n.t("基于 llama.cpp 的本地 GGUF 模型管理：指定目录安装、国内镜像、多模型显存管理、OpenAI 兼容 API。"),
              en: "llama.cpp local GGUF model manager with CN mirrors and VRAM management.",
            },
                        compatible: true,
            installed: true,
          },
          {
            id: "tts-local",
            kind: "tts",
            handler: "tts",
            icon: "tts-local.png",
            version: "1.0.0",
            title: { zh: "GPT-SoVITS 本地 TTS", en: "GPT-SoVITS Local TTS" },
            subtitle: {
              zh: I18n.t("基于 GPT-SoVITS 的本地文本转语音：指定目录安装、参考音频音色管理、OpenAI 兼容 TTS API（API Key 鉴权）。"),
              en: "GPT-SoVITS local TTS: custom install dir, reference-audio voice manager, OpenAI-compatible TTS API.",
            },
            compatible: true,
            installed: true,
          },
        ]
  ).filter((p) => p && p.id !== "forum");

  const wrap = document.createElement("div");
  wrap.className = "plugin-grid-wrap";
  const pop = document.createElement("div");
  pop.className = "plugin-pop";
  pop.setAttribute("role", "dialog");
  const grid = document.createElement("div");
  grid.className = "plugin-grid";
  wrap.appendChild(grid);
  wrap.addEventListener("click", (e) => {
    if (e.target === wrap || e.target === grid) closePluginPop(wrap, pop);
  });
  const overlayEl = $("#overlay");
  overlayEl.querySelectorAll(":scope > .plugin-pop").forEach((el) => el.remove());
  overlayEl.appendChild(pop);
  pop.addEventListener("click", (e) => e.stopPropagation());
  intro.addEventListener("click", () => closePluginPop(wrap, pop));
  body.appendChild(wrap);
  const onReposition = () => {
    const sel = wrap.querySelector(".plugin-tile.sel");
    if (sel) positionPluginPop(wrap, pop, sel);
  };
  body.addEventListener("scroll", onReposition);
  window.addEventListener("resize", onReposition);

  const offs = [];
  offs.push(() => {
    body.removeEventListener("scroll", onReposition);
    window.removeEventListener("resize", onReposition);
    if (pop && pop.parentNode) pop.remove();
  });
  for (const item of list) {
    const card = mkPluginCardShell(item);
    card._pluginItem = item;
    const openPop = () => openPluginPop(wrap, pop, card, item);
    card.addEventListener("click", (ev) => {
      if (ev.target.closest(".plugin-tile-actions")) return;
      openPop();
    });
    card.addEventListener("keydown", (ev) => {
      if (ev.key !== "Enter" && ev.key !== " ") return;
      ev.preventDefault();
      openPop();
    });
    grid.appendChild(card);
    if (item.kind === "pet" || item.handler === "pet") {
      const off = bindPluginProgress(card, item.id, true);
      if (off) offs.push(off);
      refreshPetPluginCard(card);
    } else if (item.kind === "music3" || item.handler === "music3") {
      const off = bindMusic3Progress(card);
      if (off) offs.push(off);
      if (window.api && window.api.onMusic3ConsoleChanged) {
        offs.push(window.api.onMusic3ConsoleChanged(() => refreshMusic3PluginCard(card)));
      }
      refreshMusic3PluginCard(card);
    } else if (item.kind === "h3" || item.handler === "h3") {
      const off = bindH3Progress(card);
      if (off) offs.push(off);
      if (window.api && window.api.onH3ConsoleChanged) {
        offs.push(window.api.onH3ConsoleChanged(() => refreshH3PluginCard(card)));
      }
      refreshH3PluginCard(card);
    } else if (item.kind === "remotion" || item.handler === "remotion") {
      const off = bindRemotionProgress(card);
      if (off) offs.push(off);
      if (window.api && window.api.onRemotionConsoleChanged) {
        offs.push(
          window.api.onRemotionConsoleChanged(() => refreshRemotionPluginCard(card)),
        );
      }
      refreshRemotionPluginCard(card);
    } else if (item.kind === "llama" || item.handler === "llama") {
      const off = bindLlamaProgress(card);
      if (off) offs.push(off);
      if (window.api && window.api.onLlamaConsoleChanged) {
        offs.push(window.api.onLlamaConsoleChanged(() => refreshLlamaPluginCard(card)));
      }
      refreshLlamaPluginCard(card);
    } else if (item.kind === "tts" || item.handler === "tts") {
      const off = bindTtsProgress(card);
      if (off) offs.push(off);
      if (window.api && window.api.onTtsConsoleChanged) {
        offs.push(window.api.onTtsConsoleChanged(() => refreshTtsPluginCard(card)));
      }
      refreshTtsPluginCard(card);
    } else {
      const off = bindPluginProgress(card, item.id, false);
      if (off) offs.push(off);
      if (window.api && window.api.onAppPluginsWindowChanged) {
        offs.push(
          window.api.onAppPluginsWindowChanged((data) => {
            if (!data || data.id !== item.id) return;
            refreshWindowPluginCard(card, card._pluginItem || item);
          }),
        );
      }
      refreshWindowPluginCard(card, item);
    }
  }
  _petProgressOff = () => {
    offs.forEach((fn) => {
      try { fn(); } catch {}
    });
  };
  if (!list.length) {
    const empty = document.createElement("div");
    empty.className = "settings-hint";
    empty.textContent = I18n.t("暂无插件");
    body.appendChild(empty);
  }
}

/* ============ DSH 插件管理（近全屏独立对话框，避免撑爆设置栏） ============ */

const DSH_PLUGINS_UI = {
  list: [],
  selectedKey: "",
  query: "",
  hintEl: null,
  open: false,
};

function dshPluginHasCjk(s) {
  return /[\u4e00-\u9fff]/.test(String(s || ""));
}

function dshPluginKey(p) {
  return String((p && p.id) || "") + "\n" + String((p && p.name) || "");
}

function dshPluginShortName(pkg) {
  const seg = String(pkg || "").split("/").pop();
  return seg.startsWith("dsh-") ? seg.slice(4) : seg;
}

function dshPluginLabel(p) {
  if (!p) return "";
  return dshPluginShortName(
    p.id && !String(p.id).startsWith("user-plugin") ? p.id : p.name,
  );
}

function dshPluginCopyFor(p) {
  const map =
    typeof window.DSH_PLUGIN_COPY === "object" && window.DSH_PLUGIN_COPY
      ? window.DSH_PLUGIN_COPY
      : {};
  return (p && (map[p.id] || map[p.name])) || null;
}

function enrichDshPluginCopy(p) {
  if (!p) return p;
  const zh = !(I18n && I18n.getLocale && I18n.getLocale() === "en");
  const copy = dshPluginCopyFor(p);
  let title = p.title || dshPluginLabel(p);
  let description = String(p.description || "").trim();
  let purpose = String(p.purpose || "").trim();
  if (zh && copy) {
    if (copy.title && !dshPluginHasCjk(title)) title = copy.title;
    if (copy.description && (!description || !dshPluginHasCjk(description))) {
      description = copy.description;
    }
    if (copy.purpose && (!purpose || !dshPluginHasCjk(purpose))) {
      purpose = copy.purpose;
    }
  }
  if (!purpose) {
    const first = description.split(/[。.!?\n]/)[0].trim();
    if (!zh) {
      const base = first || ("Extends the agent runtime (" + (p.id || p.name || "") + ")");
      purpose = /[.!?]$/.test(base) ? base : base + ".";
    } else if (!first) {
      purpose = I18n.t("用于扩展 Agent 运行时能力（{id}）。", {
        id: p.id || p.name || "",
      });
    } else if (/^用于/.test(first)) {
      purpose = /[。！？]$/.test(first) ? first : first + "。";
    } else {
      purpose = "用于" + first + (/[。！？]$/.test(first) ? "" : "。");
    }
  }
  return Object.assign({}, p, { title, description, purpose });
}

function ensureDshPluginsDlg() {
  let host = document.getElementById("dshPluginsDlg");
  if (host) return host;
  host = document.createElement("div");
  host.id = "dshPluginsDlg";
  host.className = "mt-dialog dsh-plugins-dlg";
  host.tabIndex = -1;
  host.innerHTML =
    '<div class="mt-dialog-box dsh-plugins-box" role="dialog" aria-modal="true">' +
    '<div class="dsh-plugins-head">' +
    '<b id="dshPluginsTitle"></b>' +
    '<input id="dshPluginsSearch" class="dsh-plugin-search" type="text">' +
    '<button type="button" class="mini node-guide-x" id="dshPluginsClose">✕</button>' +
    "</div>" +
    '<div class="dsh-plugins-main">' +
    '<div class="dsh-plugins-grid" id="dshPluginsGrid"></div>' +
    '<div class="dsh-plugins-info" id="dshPluginsInfo"></div>' +
    "</div></div>";
  document.body.appendChild(host);
  host.querySelector("#dshPluginsClose").onclick = () => closeDshPluginsDialog();
  host.addEventListener("click", (ev) => {
    if (ev.target === host) closeDshPluginsDialog();
  });
  host.addEventListener("keydown", (ev) => {
    if (ev.key !== "Escape") return;
    const mt = document.getElementById("mtDialog");
    if (mt && mt.classList.contains("on")) return;
    ev.preventDefault();
    closeDshPluginsDialog();
  });
  host.querySelector("#dshPluginsSearch").addEventListener("input", () => {
    DSH_PLUGINS_UI.query = host.querySelector("#dshPluginsSearch").value || "";
    renderDshPluginsDialog();
  });
  return host;
}

function closeDshPluginsDialog() {
  const host = document.getElementById("dshPluginsDlg");
  if (host) host.classList.remove("on");
  DSH_PLUGINS_UI.open = false;
}

function paintDshPluginsChrome() {
  const host = ensureDshPluginsDlg();
  const title = host.querySelector("#dshPluginsTitle");
  const search = host.querySelector("#dshPluginsSearch");
  const closeBtn = host.querySelector("#dshPluginsClose");
  if (title) title.textContent = I18n.t("管理 DSH 插件");
  if (search)
    search.placeholder = I18n.t("筛选 DSH 插件（按包名 / 行 id / 描述）…");
  if (closeBtn) closeBtn.title = I18n.t("关闭");
}

function renderDshPluginInfo(p) {
  const info = document.getElementById("dshPluginsInfo");
  if (!info) return;
  info.innerHTML = "";
  if (!p) {
    const em = document.createElement("div");
    em.className = "dsh-plugin-empty";
    em.textContent = I18n.t("选择左侧插件查看说明");
    info.appendChild(em);
    return;
  }
  const head = document.createElement("div");
  head.className = "dsh-plugin-info-head";
  const title = document.createElement("div");
  title.className = "dsh-plugin-info-title";
  title.textContent = p.title || dshPluginLabel(p);
  head.appendChild(title);
  const tags = document.createElement("div");
  tags.className = "dsh-plugin-info-tags";
  const tag = document.createElement("span");
  tag.className =
    "dsh-plugin-tag " + (p.core ? "builtin" : p.disabled ? "off" : "on");
  tag.textContent = p.core
    ? I18n.t("核心")
    : p.disabled
      ? I18n.t("未挂载")
      : I18n.t("已挂载");
  tags.appendChild(tag);
  const src = document.createElement("span");
  src.className = "dsh-plugin-tag " + (p.source === "config" ? "on" : "builtin");
  src.textContent =
    p.source === "config" ? I18n.t("配置目录") : I18n.t("应用内置");
  tags.appendChild(src);
  if (p.version) {
    const ver = document.createElement("span");
    ver.className = "dsh-plugin-info-ver";
    ver.textContent = "v" + p.version;
    tags.appendChild(ver);
  }
  head.appendChild(tags);
  info.appendChild(head);
  const full = document.createElement("div");
  full.className = "dsh-plugin-full";
  full.textContent = p.name;
  info.appendChild(full);
  const addField = (label, text) => {
    if (!text) return;
    const lab = document.createElement("div");
    lab.className = "dsh-plugin-info-label";
    lab.textContent = label;
    const body = document.createElement("div");
    body.className = "dsh-plugin-info-text";
    body.textContent = text;
    info.appendChild(lab);
    info.appendChild(body);
  };
  addField(I18n.t("描述"), p.description);
  addField(I18n.t("用途"), p.purpose);
  if (!p.description && !p.purpose) {
    const em = document.createElement("div");
    em.className = "dsh-plugin-empty";
    em.textContent = I18n.t("暂无描述");
    info.appendChild(em);
  }
  if (p.toggleable) {
    const btns = document.createElement("div");
    btns.className = "dsh-plugin-btns";
    const tg = document.createElement("button");
    tg.className = "mini";
    tg.textContent = p.disabled ? I18n.t("挂载") : I18n.t("取消挂载");
    tg.onclick = async (ev) => {
      ev.stopPropagation();
      try {
        const rr = await window.api.dshPluginSetEnabled(p.name, !!p.disabled, p.id);
        if (rr && rr.ok === false) throw new Error(rr.error);
        toast((p.disabled ? I18n.t("已挂载 ") : I18n.t("已取消挂载 ")) + p.name, "ok");
      } catch (e) {
        toast(I18n.t("操作失败：") + (e.message || String(e)), "err");
      }
      await refreshDshPluginInventory();
    };
    btns.appendChild(tg);
    if (p.removable) {
      const rm = document.createElement("button");
      rm.className = "mini";
      rm.textContent = I18n.t("移除");
      rm.onclick = async (ev) => {
        ev.stopPropagation();
        if (
          !(await confirmDialog(
            I18n.t("移除 DSH 插件 ") + p.name + I18n.t("？引擎将自动重启。"),
            { title: I18n.t("移除插件"), danger: true, okText: I18n.t("移除") },
          ))
        )
          return;
        try {
          const rr = await window.api.dshPluginRemove(p.name);
          if (rr && rr.ok === false) throw new Error(rr.error);
          toast(I18n.t("已移除 ") + p.name, "ok");
        } catch (e) {
          toast(I18n.t("移除失败：") + (e.message || String(e)), "err");
        }
        await refreshDshPluginInventory();
      };
      btns.appendChild(rm);
    }
    info.appendChild(btns);
  }
  if (p.detail) {
    const det = document.createElement("details");
    det.className = "dsh-plugin-yaml";
    const sum = document.createElement("summary");
    sum.textContent = I18n.t("配置片段");
    det.appendChild(sum);
    const pre = document.createElement("pre");
    pre.className = "dsh-plugin-detail";
    pre.textContent = p.detail;
    det.appendChild(pre);
    info.appendChild(det);
  }
}

function renderDshPluginsDialog() {
  const grid = document.getElementById("dshPluginsGrid");
  if (!grid) return;
  grid.innerHTML = "";
  const q = String(DSH_PLUGINS_UI.query || "").trim().toLowerCase();
  const hay = (p) =>
    [p.name, p.id, p.title, p.description, p.purpose]
      .filter(Boolean)
      .join("\n")
      .toLowerCase();
  const list = DSH_PLUGINS_UI.list.filter((p) => !q || hay(p).includes(q));
  if (!list.length) {
    const em = document.createElement("div");
    em.className = "dsh-plugin-empty";
    em.textContent = q
      ? I18n.t("无匹配 DSH 插件")
      : I18n.t("暂无 DSH 插件（在上方输入 npm 包名安装）");
    grid.appendChild(em);
    renderDshPluginInfo(null);
    return;
  }
  const selected =
    list.find((p) => dshPluginKey(p) === DSH_PLUGINS_UI.selectedKey) || list[0];
  DSH_PLUGINS_UI.selectedKey = dshPluginKey(selected);
  for (const p of list) {
    const on = dshPluginKey(p) === DSH_PLUGINS_UI.selectedKey;
    const card = document.createElement("div");
    card.className =
      "dsh-plugin-card" + (p.disabled ? " off" : "") + (on ? " sel" : "");
    card.setAttribute("role", "button");
    card.tabIndex = 0;
    const row = document.createElement("div");
    row.className = "dsh-plugin-card-row";
    const dot = document.createElement("span");
    dot.className = "dsh-plugin-dot" + (p.disabled ? "" : " on");
    dot.title = p.disabled ? I18n.t("未挂载") : I18n.t("已挂载");
    const nm = document.createElement("span");
    nm.className = "dsh-plugin-name";
    nm.textContent = p.title || dshPluginLabel(p);
    nm.title = p.name;
    const tag = document.createElement("span");
    tag.className =
      "dsh-plugin-tag " + (p.core ? "builtin" : p.disabled ? "off" : "on");
    tag.textContent = p.core
      ? I18n.t("核心")
      : p.disabled
        ? I18n.t("未挂载")
        : I18n.t("已挂载");
    row.appendChild(dot);
    row.appendChild(nm);
    row.appendChild(tag);
    if (p.source === "config") {
      const loc = document.createElement("span");
      loc.className = "dsh-plugin-tag on";
      loc.textContent = I18n.t("配置目录");
      row.appendChild(loc);
    }
    card.appendChild(row);
    const pick = () => {
      DSH_PLUGINS_UI.selectedKey = dshPluginKey(p);
      renderDshPluginsDialog();
    };
    card.onclick = pick;
    card.onkeydown = (ev) => {
      if (ev.key === "Enter" || ev.key === " ") {
        ev.preventDefault();
        pick();
      }
    };
    grid.appendChild(card);
  }
  renderDshPluginInfo(selected);
}

async function refreshDshPluginInventory(attempt) {
  attempt = attempt || 0;
  let r = null;
  try {
    r = await window.api.dshPluginList();
  } catch (e) {
    r = { ok: false, error: e.message || String(e) };
  }
  const hint = DSH_PLUGINS_UI.hintEl;
  if (!r || r.ok === false || !Array.isArray(r.plugins)) {
    if (attempt < 2) {
      setTimeout(() => refreshDshPluginInventory(attempt + 1), 1500);
      return r;
    }
    DSH_PLUGINS_UI.list = [];
    if (hint) {
      hint.textContent =
        I18n.t("DSH 插件列表不可用（") +
        ((r && r.error) || I18n.t("引擎未连接")) +
        I18n.t("）· 重新打开设置重试");
    }
    if (DSH_PLUGINS_UI.open) renderDshPluginsDialog();
    return r;
  }
  DSH_PLUGINS_UI.list = r.plugins.map(enrichDshPluginCopy);
  const n = DSH_PLUGINS_UI.list.length;
  const m = DSH_PLUGINS_UI.list.filter((p) => !p.disabled).length;
  if (hint) {
    hint.textContent = n
      ? I18n.t("已安装 {n} 个插件（已挂载 {m}）", { n: n, m: m })
      : I18n.t("暂无 DSH 插件（在上方输入 npm 包名安装）");
  }
  if (DSH_PLUGINS_UI.open) renderDshPluginsDialog();
  return r;
}

async function openDshPluginsDialog() {
  const host = ensureDshPluginsDlg();
  paintDshPluginsChrome();
  const search = host.querySelector("#dshPluginsSearch");
  if (search) search.value = DSH_PLUGINS_UI.query || "";
  DSH_PLUGINS_UI.open = true;
  host.classList.add("on");
  try {
    host.focus();
  } catch (_) {}
  if (!DSH_PLUGINS_UI.list.length) {
    const grid = document.getElementById("dshPluginsGrid");
    if (grid) {
      grid.innerHTML =
        '<div class="dsh-plugin-empty">' + I18n.t("（读取中…）") + "</div>";
    }
    await refreshDshPluginInventory();
  } else {
    renderDshPluginsDialog();
  }
}

