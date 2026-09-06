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

/* ============ 扩展能力管理（DSH 插件 / 技能 Skills / MCP 服务器 统一对话框）
   设置里这三类扩展原本各占一块（DSH 插件还内联一长串列表），现整合成一个
   「扩展能力」界面，一律通过「管理」打开本对话框；DSH 插件只是其中一个分类，
   技能与 MCP 复用同一套「卡片清单 + 右侧详情」的样式（.dsh-plugin-card /
   .dsh-plugins-info），让三个分类看起来是同一个东西，而不是各写一遍的面板。
   宿主改为 #extManagerDlg，并顺带清掉旧版 #dshPluginsDlg，避免改版后残留两个实例。
   ============ */

const EXT_KINDS = [
  {
    key: "dsh",
    zh: "DSH 插件",
    tab: "DSH",
    grid: "dshPluginsGrid",
    empty: "暂无 DSH 插件（点上方「＋ 安装插件」）",
    install: true,
    newLabel: "＋ 安装插件",
  },
  {
    key: "skill",
    zh: "技能 Skills",
    tab: "Skill",
    grid: "dshSkillsGrid",
    empty: "暂无技能（点上方「＋ 创建技能」）",
    install: false,
    newLabel: "＋ 创建技能",
  },
  {
    key: "mcp",
    zh: "MCP 服务器",
    tab: "MCP",
    grid: "dshMcpGrid",
    empty: "暂无 MCP 服务器（点上方「＋ 添加服务器」）",
    install: false,
    newLabel: "＋ 添加服务器",
  },
];

const EXT_KIND = {};
for (const k of EXT_KINDS) EXT_KIND[k.key] = k;

const EXT_UI = {
  open: false,
  kind: "dsh",
  hintEl: null,
  loaded: { dsh: false, skill: false, mcp: false },
  errors: { dsh: "", skill: "", mcp: "" },
  state: {
    dsh: { list: [], selectedKey: "", query: "" },
    skill: { list: [], selectedKey: "", query: "", editor: null },
    mcp: { list: [], selectedKey: "", query: "", editor: null },
  },
};

function extState(kind) {
  return EXT_UI.state[kind] || EXT_UI.state.dsh;
}

function extItems(kind) {
  if (kind === "skill") {
    return (EXT_UI.state.skill.list || []).filter(
      (s) => !isInstallOnlySkillName(s && s.name),
    );
  }
  return EXT_UI.state[kind] ? EXT_UI.state[kind].list || [] : [];
}

function extKeyOf(kind, it) {
  if (kind === "skill") return String((it && it.name) || "");
  if (kind === "mcp") return String((it && it.serverName) || "");
  return dshPluginKey(it);
}

function extIsOn(kind, it) {
  return !(it && it.disabled);
}

function extHay(kind, it) {
  let parts;
  if (kind === "skill") parts = [it.name, it.title, it.description];
  else if (kind === "mcp")
    parts = [it.serverName, it.transport, it.command, it.url, it.args];
  else parts = [it.name, it.id, it.title, it.description, it.purpose];
  return parts.filter(Boolean).join("\n").toLowerCase();
}

function extFilter(kind) {
  const st = extState(kind);
  const q = String(st.query || "").trim().toLowerCase();
  const list = extItems(kind);
  return q ? list.filter((it) => extHay(kind, it).includes(q)) : list.slice();
}

function extCount(kind) {
  return extItems(kind).length;
}

function extSelected(kind) {
  const st = extState(kind);
  const list = extFilter(kind);
  if (!list.length) return null;
  const sel =
    list.find((it) => extKeyOf(kind, it) === st.selectedKey) || list[0];
  st.selectedKey = extKeyOf(kind, sel);
  return sel;
}

/* ── 设置里的汇总提示 ── */

function extHintText() {
  const p = EXT_UI.state.dsh.list.length;
  const m = EXT_UI.state.dsh.list.filter((x) => !x.disabled).length;
  const zh = !(I18n && I18n.getLocale && I18n.getLocale() === "en");
  const bits = [
    I18n.t("DSH 插件 ") +
      p +
      (zh ? "（已挂载 " : " (mounted ") +
      m +
      (zh ? "）" : ")"),
    I18n.t("技能 ") + extCount("skill"),
    I18n.t("MCP ") + extCount("mcp"),
  ];
  const errs = EXT_KINDS.filter((k) => EXT_UI.errors[k.key]).map(
    (k) => k.tab,
  );
  let s = bits.join(" · ");
  if (errs.length)
    s +=
      (zh ? I18n.t("（部分列表不可用：") : " (some lists unavailable: ") +
      errs.join(" / ") +
      (zh ? "）" : ")");
  return s;
}

function paintExtHint() {
  const hint = EXT_UI.hintEl;
  if (!hint) return;
  if (!EXT_UI.loaded.dsh && !EXT_UI.loaded.skill && !EXT_UI.loaded.mcp) {
    hint.textContent = I18n.t("（读取中…）");
    return;
  }
  hint.textContent = extHintText();
}

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

function ensureExtManagerDlg() {
  const old = document.getElementById("dshPluginsDlg");
  if (old) old.remove();
  let host = document.getElementById("extManagerDlg");
  if (host) return host;
  host = document.createElement("div");
  host.id = "extManagerDlg";
  host.className = "mt-dialog dsh-plugins-dlg ext-manager-dlg";
  host.tabIndex = -1;
  host.innerHTML =
    '<div class="mt-dialog-box dsh-plugins-box ext-manager-box" role="dialog" aria-modal="true">' +
    '<div class="dsh-plugins-head">' +
    '<b id="extManagerTitle"></b>' +
    '<div class="dsh-ext-tabs" id="extManagerTabs"></div>' +
    '<input id="extManagerSearch" class="dsh-plugin-search" type="text">' +
    '<button type="button" class="mini node-guide-x" id="extManagerClose">✕</button>' +
    "</div>" +
    '<div class="dsh-ext-toolbar" id="extManagerToolbar"></div>' +
    '<div class="dsh-plugins-main">' +
    '<div class="dsh-plugins-grid" id="dshPluginsGrid"></div>' +
    '<div class="dsh-plugins-grid" id="dshSkillsGrid" style="display:none"></div>' +
    '<div class="dsh-plugins-grid" id="dshMcpGrid" style="display:none"></div>' +
    '<div class="dsh-plugins-info" id="extManagerInfo"></div>' +
    "</div></div>";
  document.body.appendChild(host);
  host.querySelector("#extManagerClose").onclick = () => closeExtManagerDialog();
  host.addEventListener("click", (ev) => {
    if (ev.target === host) closeExtManagerDialog();
  });
  host.addEventListener("keydown", (ev) => {
    if (ev.key !== "Escape") return;
    const mt = document.getElementById("mtDialog");
    if (mt && mt.classList.contains("on")) return;
    ev.preventDefault();
    if (extState(EXT_UI.kind).editor) {
      paintExtManager();
      return;
    }
    closeExtManagerDialog();
  });
  host.querySelector("#extManagerSearch").addEventListener("input", (ev) => {
    extState(EXT_UI.kind).query = ev.target.value || "";
    paintExtManager();
  });
  return host;
}

function closeExtManagerDialog() {
  const host = document.getElementById("extManagerDlg");
  if (host) host.classList.remove("on");
  EXT_UI.open = false;
}

function paintExtTabs(host) {
  const tabs = host.querySelector("#extManagerTabs");
  if (!tabs) return;
  tabs.innerHTML = "";
  for (const k of EXT_KINDS) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "dsh-ext-tab" + (EXT_UI.kind === k.key ? " on" : "");
    b.textContent = I18n.t(k.tab) + " " + extCount(k.key);
    b.title = I18n.t(k.zh);
    b.onclick = () => {
      if (EXT_UI.kind === k.key) return;
      EXT_UI.kind = k.key;
      paintExtManager();
    };
    tabs.appendChild(b);
  }
}

function extInstallSubmit(host) {
  const inp = host.querySelector("#extManagerInstall");
  if (!inp) return;
  const pkg = String(inp.value || "").trim();
  if (!pkg) return;
  inp.value = "";
  extAddPlugin(pkg);
}

function paintExtToolbar(host) {
  const bar = host.querySelector("#extManagerToolbar");
  if (!bar) return;
  const kind = EXT_UI.kind;
  const meta = EXT_KIND[kind];
  bar.innerHTML = "";
  if (meta.install) {
    const inp = document.createElement("input");
    inp.type = "text";
    inp.id = "extManagerInstall";
    inp.className = "dsh-plugin-search dsh-ext-install";
    inp.placeholder = I18n.t("npm 包名或 GitHub 地址，例如 @scope/pkg");
    inp.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        extInstallSubmit(host);
      }
    });
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "mini primary";
    btn.textContent = I18n.t("＋ 安装插件");
    btn.onclick = () => extInstallSubmit(host);
    bar.appendChild(inp);
    bar.appendChild(btn);
  } else {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "mini primary";
    btn.textContent = I18n.t(meta.newLabel);
    btn.onclick = () => {
      const st = extState(kind);
      st.editor = { mode: "new", data: null };
      st.selectedKey = "";
      paintExtManager();
    };
    bar.appendChild(btn);
  }
  const spacer = document.createElement("span");
  spacer.className = "dsh-ext-spacer";
  bar.appendChild(spacer);
  const store = document.createElement("button");
  store.type = "button";
  store.className = "mini";
  store.textContent = I18n.t("🌐 在线浏览");
  store.title = I18n.t("在线浏览:线上目录(插件 / 技能 / MCP),可安装与卸载");
  store.onclick = () => {
    closeExtManagerDialog();
    if (typeof openStoreDialog === "function") openStoreDialog();
  };
  bar.appendChild(store);
  const cnt = document.createElement("span");
  cnt.className = "dsh-ext-count";
  cnt.textContent = extCount(kind) + I18n.t(" 项");
  bar.appendChild(cnt);
}

function extFieldRow(labelText, el) {
  const lab = document.createElement("div");
  lab.className = "dsh-plugin-info-label";
  lab.textContent = labelText;
  const wrap = document.createElement("div");
  wrap.className = "dsh-ext-field";
  wrap.appendChild(lab);
  wrap.appendChild(el);
  return wrap;
}

function extTextInput(ph, value) {
  const el = document.createElement("input");
  el.type = "text";
  el.placeholder = ph;
  el.value = value || "";
  return el;
}

function extTextArea(ph, value, rows) {
  const el = document.createElement("textarea");
  el.rows = rows || 4;
  el.placeholder = ph;
  el.value = value || "";
  return el;
}

function extSelect(options, value) {
  const el = document.createElement("select");
  for (const [v, l] of options) {
    const o = document.createElement("option");
    o.value = v;
    o.textContent = I18n.t(l);
    el.appendChild(o);
  }
  el.value = value;
  return el;
}

function extErrorText(e) {
  return String((e && e.message) || e || "");
}

async function extAddPlugin(pkg) {
  const host = document.getElementById("extManagerDlg");
  const cnt = host && host.querySelector(".dsh-ext-count");
  if (cnt) cnt.textContent = I18n.t("安装中（需要联网，可能需要几分钟）…");
  try {
    const rr = await window.api.dshPluginAdd(pkg);
    if (rr && rr.ok === false) throw new Error(rr.error);
    toast((rr && rr.message) || I18n.t("DSH 插件已安装：") + pkg, "ok");
  } catch (e) {
    toast(I18n.t("安装失败：") + extErrorText(e), "err");
  }
  await refreshExtInventory({ quiet: true });
  paintExtManager();
}

function renderExtManagerInfo(host) {
  const info = host.querySelector("#extManagerInfo");
  if (!info) return;
  info.innerHTML = "";
  const kind = EXT_UI.kind;
  const st = extState(kind);
  if (st.editor) {
    buildExtEditor(info, kind, st);
    return;
  }
  const it = extSelected(kind);
  if (!it) {
    const em = document.createElement("div");
    em.className = "dsh-plugin-empty";
    em.textContent =
      EXT_UI.errors[kind] || I18n.t("选择左侧条目查看说明与管理操作");
    info.appendChild(em);
    return;
  }
  if (kind === "dsh") renderDshPluginInfo(it, info);
  else if (kind === "skill") renderExtSkillInfo(it, info);
  else renderExtMcpInfo(it, info);
}

function extInfoHead(info, titleText, tags, fullname) {
  const head = document.createElement("div");
  head.className = "dsh-plugin-info-head";
  const title = document.createElement("div");
  title.className = "dsh-plugin-info-title";
  title.textContent = titleText;
  head.appendChild(title);
  const tw = document.createElement("div");
  tw.className = "dsh-plugin-info-tags";
  for (const [cls, text] of tags || []) {
    const t = document.createElement("span");
    t.className = "dsh-plugin-tag " + cls;
    t.textContent = text;
    tw.appendChild(t);
  }
  head.appendChild(tw);
  info.appendChild(head);
  if (fullname) {
    const full = document.createElement("div");
    full.className = "dsh-plugin-full";
    full.textContent = fullname;
    info.appendChild(full);
  }
}

function extInfoField(info, label, text) {
  if (!text) return;
  const lab = document.createElement("div");
  lab.className = "dsh-plugin-info-label";
  lab.textContent = label;
  info.appendChild(lab);
  const body = document.createElement("div");
  body.className = "dsh-plugin-info-text";
  body.textContent = text;
  info.appendChild(body);
}

function extInfoButtons(info, actions) {
  if (!actions || !actions.length) return;
  const btns = document.createElement("div");
  btns.className = "dsh-plugin-btns";
  for (const [label, cls, fn] of actions) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "mini " + (cls || "");
    b.textContent = I18n.t(label);
    b.onclick = async (ev) => {
      ev.stopPropagation();
      await fn();
    };
    btns.appendChild(b);
  }
  info.appendChild(btns);
}

function extInfoDetails(info, label, text, cls) {
  const det = document.createElement("details");
  det.className = cls || "dsh-plugin-yaml";
  const sum = document.createElement("summary");
  sum.textContent = label;
  det.appendChild(sum);
  const pre = document.createElement("pre");
  pre.className = "dsh-plugin-detail";
  pre.textContent = text;
  det.appendChild(pre);
  info.appendChild(det);
}

/* 右侧详情：DSH 插件（沿用原样式与操作） */
function renderDshPluginInfo(p, info) {
  extInfoHead(
    info,
    p.title || dshPluginLabel(p),
    [
      [p.core ? "builtin" : p.disabled ? "off" : "on", p.core ? I18n.t("核心") : p.disabled ? I18n.t("未挂载") : I18n.t("已挂载")],
      [
        p.source === "config" ? "on" : "builtin",
        p.source === "config" ? I18n.t("配置目录") : I18n.t("应用内置"),
      ],
    ],
    p.name,
  );
  if (p.version) {
    const ver = document.createElement("div");
    ver.className = "dsh-plugin-info-ver";
    ver.textContent = "v" + p.version;
    info.appendChild(ver);
  }
  extInfoField(info, I18n.t("描述"), p.description);
  extInfoField(info, I18n.t("用途"), p.purpose);
  if (!p.description && !p.purpose) {
    const em = document.createElement("div");
    em.className = "dsh-plugin-empty";
    em.textContent = I18n.t("暂无描述");
    info.appendChild(em);
  }
  const actions = [];
  if (p.toggleable) {
    actions.push([p.disabled ? "挂载" : "取消挂载", "", async () => {
      try {
        const rr = await window.api.dshPluginSetEnabled(
          p.name,
          !!p.disabled,
          p.id,
        );
        if (rr && rr.ok === false) throw new Error(rr.error);
        toast(
          (p.disabled ? I18n.t("已挂载 ") : I18n.t("已取消挂载 ")) + p.name,
          "ok",
        );
      } catch (e) {
        toast(I18n.t("操作失败：") + extErrorText(e), "err");
      }
      await refreshExtInventory({ kinds: ["dsh"], quiet: true });
      paintExtManager();
    }]);
  }
  if (p.removable) {
    actions.push(["移除", "danger", async () => {
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
        toast(I18n.t("移除失败：") + extErrorText(e), "err");
      }
      await refreshExtInventory({ kinds: ["dsh"], quiet: true });
      paintExtManager();
    }]);
  }
  extInfoButtons(info, actions);
  if (p.detail) extInfoDetails(info, I18n.t("配置片段"), p.detail);
}

/* 右侧详情：技能 */
function renderExtSkillInfo(s, info) {
  extInfoHead(
    info,
    s.title || s.name,
    [
      [s.builtin ? "builtin" : "on", s.builtin ? I18n.t("内置") : I18n.t("本机")],
      [
        s.storeId ? "on" : "builtin",
        s.storeId ? I18n.t("来自工坊") : I18n.t("本地创建"),
      ],
    ],
    s.name,
  );
  if (s.version) {
    const ver = document.createElement("div");
    ver.className = "dsh-plugin-info-ver";
    ver.textContent = "v" + s.version;
    info.appendChild(ver);
  }
  extInfoField(info, I18n.t("描述"), s.description);
  const body = s._body || "";
  if (body) {
    extInfoDetails(
      info,
      I18n.t("技能内容 SKILL.md") + "（" + body.length + "）",
      body,
      "dsh-plugin-yaml dsh-skill-body",
    );
  } else if (s._bodyLoading) {
    const em = document.createElement("div");
    em.className = "dsh-plugin-empty";
    em.textContent = I18n.t("（读取中…）");
    info.appendChild(em);
  }
  if (Array.isArray(s.files) && s.files.length) {
    extInfoField(
      info,
      I18n.t("附带文件"),
      s.files.map((f) => f.path + " (" + f.bytes + "B)").join("\n"),
    );
  }
  const actions = [];
  actions.push([s.builtin ? "查看" : "编辑", "", async () => {
    if (s.builtin) {
      toast(I18n.t("内置技能只读，不可修改"), "warn");
    }
    try {
      const g = await window.api.skillGet(s.name);
      if (!g || !g.ok) throw new Error((g && g.error) || I18n.t("未知错误"));
      s._body = g.body || "";
      s.files = g.files || [];
      if (s.builtin) {
        paintExtManager();
        return;
      }
      extState("skill").editor = { mode: "edit", data: s };
      paintExtManager();
    } catch (e) {
      toast(I18n.t("加载失败：") + extErrorText(e), "err");
    }
  }]);
  if (!s.builtin) {
    actions.push(["移除", "danger", async () => {
      if (
        !(await confirmDialog(I18n.t("移除技能 ") + s.name + I18n.t("？"), {
          title: I18n.t("移除技能"),
          danger: true,
          okText: I18n.t("移除"),
        }))
      )
        return;
      try {
        const rr = await window.api.skillRemove(s.name);
        if (rr && rr.ok === false) throw new Error(rr.error);
        toast(I18n.t("已移除技能 ") + s.name, "ok");
      } catch (e) {
        toast(I18n.t("移除失败：") + extErrorText(e), "err");
      }
      extState("skill").selectedKey = "";
      await refreshExtInventory({ kinds: ["skill"], quiet: true });
      paintExtManager();
    }]);
  }
  extInfoButtons(info, actions);
}

/* 右侧详情：MCP 服务器 */
function renderExtMcpInfo(s, info) {
  extInfoHead(
    info,
    s.serverName,
    [
      [s.disabled ? "off" : "on", s.disabled ? I18n.t("已停用") : I18n.t("已启用")],
      ["builtin", s.transport === "stdio" ? "stdio" : "streamable-http"],
    ],
    s.transport === "stdio" ? s.command : s.url,
  );
  extInfoField(
    info,
    I18n.t("命令 / 参数"),
    s.transport === "stdio" ? (s.command || "") + " " + (s.args || "") : "",
  );
  extInfoField(info, "URL", s.transport === "stdio" ? "" : s.url);
  extInfoDetails(
    info,
    I18n.t("配置片段"),
    [
      "serverName: " + s.serverName,
      "transport: " + s.transport,
      s.transport === "stdio"
        ? "command: " + (s.command || "") + "\nargs: " + (s.args || "")
        : "url: " + (s.url || ""),
      "disabled: " + (s.disabled ? "true" : "false"),
    ].join("\n"),
  );
  extInfoButtons(info, [
    [s.disabled ? "启用" : "停用", "", async () => {
      try {
        const rr = await window.api.dshMcpSetEnabled(s.serverName, !!s.disabled);
        if (rr && rr.ok === false) throw new Error(rr.error);
        toast(
          (s.disabled ? I18n.t("已启用 ") : I18n.t("已停用 ")) + s.serverName,
          "ok",
        );
      } catch (e) {
        toast(I18n.t("操作失败：") + extErrorText(e), "err");
      }
      await refreshExtInventory({ kinds: ["mcp"], quiet: true });
      paintExtManager();
    }],
    ["移除", "danger", async () => {
      if (
        !(await confirmDialog(
          I18n.t("移除 MCP 服务器 ") + s.serverName + I18n.t("？引擎将自动重启。"),
          { title: I18n.t("移除 MCP"), danger: true, okText: I18n.t("移除") },
        ))
      )
        return;
      try {
        const rr = await window.api.dshMcpRemove(s.serverName);
        if (rr && rr.ok === false) throw new Error(rr.error);
        toast(I18n.t("已移除 ") + s.serverName, "ok");
      } catch (e) {
        toast(I18n.t("移除失败：") + extErrorText(e), "err");
      }
      extState("mcp").selectedKey = "";
      await refreshExtInventory({ kinds: ["mcp"], quiet: true });
      paintExtManager();
    }],
  ]);
}

/* 新建 / 编辑表单（技能、MCP），同样开在右侧详情区，保持一个样式 */
function buildExtEditor(info, kind, st) {
  const ed = st.editor;
  const cur = ed.mode === "edit" ? ed.data : null;
  const title = document.createElement("div");
  title.className = "dsh-plugin-info-title";
  title.textContent = I18n.t(
    kind === "skill"
      ? cur
        ? "编辑技能"
        : "创建技能"
      : cur
        ? "MCP 服务器"
        : "添加 MCP 服务器",
  );
  info.appendChild(title);
  const form = document.createElement("div");
  form.className = "dsh-skill-form";
  info.appendChild(form);

  const save = document.createElement("button");
  save.type = "button";
  save.className = "mini primary";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "mini";
  cancel.textContent = I18n.t("取消");
  cancel.onclick = () => {
    st.editor = null;
    paintExtManager();
  };

  if (kind === "skill") {
    const nm = extTextInput(
      I18n.t("技能名（kebab-case，如 pdf-summary）"),
      cur ? cur.name : "",
    );
    if (cur) nm.disabled = true;
    const desc = extTextInput(
      I18n.t("一句话描述（模型据此判断何时使用）"),
      cur ? cur.description || "" : "",
    );
    const body = extTextArea(
      I18n.t("技能内容（Markdown，模型按此执行）…"),
      cur ? cur._body || "" : "",
      12,
    );
    form.appendChild(extFieldRow(I18n.t("技能名"), nm));
    form.appendChild(extFieldRow(I18n.t("描述"), desc));
    form.appendChild(extFieldRow(I18n.t("内容"), body));
    save.textContent = I18n.t(cur ? "保存本机修改" : "创建技能");
    save.onclick = async () => {
      try {
        const rr = await window.api.skillAdd({
          name: (cur ? cur.name : nm.value).trim().toLowerCase(),
          description: desc.value.trim(),
          body: body.value,
          overwrite: !!cur,
          files: cur && Array.isArray(cur.files) ? cur.files : undefined,
        });
        if (rr && rr.ok === false) throw new Error(rr.error);
        toast(
          cur ? I18n.t("本机技能已保存（未自动同步工坊）") : I18n.t("技能已创建，智能节点可立即使用"),
          "ok",
        );
        st.editor = null;
        st.selectedKey = (cur ? cur.name : nm.value).trim().toLowerCase();
      } catch (e) {
        toast(I18n.t("保存失败：") + extErrorText(e), "err");
        return;
      }
      await refreshExtInventory({ kinds: ["skill"], quiet: true });
      paintExtManager();
    };
  } else {
    const nm = extTextInput(
      I18n.t("服务器名（1-32 位字母/数字/_/-）"),
      cur ? cur.serverName : "",
    );
    const tr = extSelect(
      [
        ["stdio", "stdio（本地命令）"],
        ["streamable-http", "streamable-http（远程 URL）"],
      ],
      (cur && cur.transport) || "stdio",
    );
    const cmd = extTextInput(
      I18n.t("命令（如 npx.cmd 或 node 完整路径）"),
      cur ? cur.command || "" : "",
    );
    const args = extTextInput(
      I18n.t("参数（空格分隔，如 -y @modelcontextprotocol/server-filesystem）"),
      cur ? cur.args || "" : "",
    );
    const url = extTextInput("http(s)://host/mcp", cur ? cur.url || "" : "");
    const syncTransport = () => {
      const http = tr.value !== "stdio";
      cmd.style.display = http ? "none" : "";
      args.style.display = http ? "none" : "";
      url.style.display = http ? "" : "none";
    };
    tr.addEventListener("change", syncTransport);
    form.appendChild(extFieldRow(I18n.t("服务器名"), nm));
    form.appendChild(extFieldRow(I18n.t("传输方式"), tr));
    form.appendChild(extFieldRow(I18n.t("命令"), cmd));
    form.appendChild(extFieldRow(I18n.t("参数"), args));
    form.appendChild(extFieldRow("URL", url));
    syncTransport();
    save.textContent = I18n.t("添加服务器");
    save.onclick = async () => {
      try {
        const rr = await window.api.dshMcpAdd({
          serverName: nm.value.trim(),
          transport: tr.value,
          command: cmd.value.trim(),
          args: args.value.trim(),
          url: url.value.trim(),
        });
        if (rr && rr.ok === false) throw new Error(rr.error);
        toast(I18n.t("MCP 服务器已添加，引擎重启后生效"), "ok");
        st.editor = null;
        st.selectedKey = nm.value.trim();
      } catch (e) {
        toast(I18n.t("添加失败：") + extErrorText(e), "err");
        return;
      }
      await refreshExtInventory({ kinds: ["mcp"], quiet: true });
      paintExtManager();
    };
  }
  const btns = document.createElement("div");
  btns.className = "dsh-plugin-btns";
  btns.appendChild(save);
  btns.appendChild(cancel);
  info.appendChild(btns);
}

function extCardText(kind, it) {
  if (kind === "skill") return (it && (it.title || it.name)) || "";
  if (kind === "mcp") return (it && it.serverName) || "";
  return (it && (it.title || dshPluginLabel(it))) || "";
}

function extCardTag(kind, it) {
  if (kind === "skill")
    return it.builtin
      ? [I18n.t("内置"), "builtin"]
      : [I18n.t("本机"), "on"];
  if (kind === "mcp")
    return it.disabled
      ? [I18n.t("已停用"), "off"]
      : [I18n.t("已启用"), "on"];
  return it.core
    ? [I18n.t("核心"), "builtin"]
    : it.disabled
      ? [I18n.t("未挂载"), "off"]
      : [I18n.t("已挂载"), "on"];
}

function renderExtGrid(host, kind) {
  const grid = host.querySelector("#" + EXT_KIND[kind].grid);
  if (!grid) return;
  grid.innerHTML = "";
  const st = extState(kind);
  const list = extFilter(kind);
  if (!list.length) {
    const em = document.createElement("div");
    em.className = "dsh-plugin-empty";
    em.textContent = st.query
      ? I18n.t("无匹配 ") + EXT_KIND[kind].tab
      : EXT_UI.loaded[kind]
        ? EXT_UI.errors[kind] || I18n.t(EXT_KIND[kind].empty)
        : I18n.t("（读取中…）");
    grid.appendChild(em);
    return;
  }
  extSelected(kind);
  for (const it of list) {
    const on = extKeyOf(kind, it) === st.selectedKey;
    const card = document.createElement("div");
    card.className =
      "dsh-plugin-card" + (extIsOn(kind, it) ? "" : " off") + (on ? " sel" : "");
    card.setAttribute("role", "button");
    card.tabIndex = 0;
    const row = document.createElement("div");
    row.className = "dsh-plugin-card-row";
    const dot = document.createElement("span");
    dot.className = "dsh-plugin-dot" + (extIsOn(kind, it) ? " on" : "");
    dot.title = extIsOn(kind, it) ? I18n.t("已启用") : I18n.t("未启用");
    const nm = document.createElement("span");
    nm.className = "dsh-plugin-name";
    nm.textContent = extCardText(kind, it);
    nm.title =
      kind === "skill"
        ? it.description || it.name
        : kind === "mcp"
          ? it.command || it.url || it.serverName
          : it.name;
    const [tagText, tagCls] = extCardTag(kind, it);
    const tag = document.createElement("span");
    tag.className = "dsh-plugin-tag " + tagCls;
    tag.textContent = tagText;
    row.appendChild(dot);
    row.appendChild(nm);
    row.appendChild(tag);
    if (kind === "dsh" && it.source === "config") {
      const loc = document.createElement("span");
      loc.className = "dsh-plugin-tag on";
      loc.textContent = I18n.t("配置目录");
      row.appendChild(loc);
    }
    card.appendChild(row);
    const pick = () => {
      st.selectedKey = extKeyOf(kind, it);
      st.editor = null;
      paintExtManager();
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
}

function paintExtManager() {
  if (!EXT_UI.open) return;
  const host = ensureExtManagerDlg();
  paintExtTabs(host);
  paintExtToolbar(host);
  const search = host.querySelector("#extManagerSearch");
  if (search) {
    const ph = {
      dsh: I18n.t("筛选 DSH 插件（按包名 / 行 id / 描述）…"),
      skill: I18n.t("筛选技能（按技能名 / 描述）…"),
      mcp: I18n.t("筛选 MCP 服务器（按名称 / 命令 / URL）…"),
    }[EXT_UI.kind];
    search.placeholder = ph;
    if (search.value !== (extState(EXT_UI.kind).query || ""))
      search.value = extState(EXT_UI.kind).query || "";
  }
  for (const k of EXT_KINDS) {
    const grid = host.querySelector("#" + k.grid);
    if (grid) grid.style.display = EXT_UI.kind === k.key ? "" : "none";
  }
  renderExtGrid(host, EXT_UI.kind);
  renderExtManagerInfo(host);
}

/* 三类清单一把抓：任一分类失败不影响其余分类（引擎未连接时插件分类仍会重试） */
async function fetchExtPlugins(attempt) {
  attempt = attempt || 0;
  let r = null;
  try {
    r = await window.api.dshPluginList();
  } catch (e) {
    r = { ok: false, error: extErrorText(e) };
  }
  if (!r || r.ok === false || !Array.isArray(r.plugins)) {
    if (attempt < 2) {
      await new Promise((res) => setTimeout(res, 1500));
      return fetchExtPlugins(attempt + 1);
    }
    EXT_UI.state.dsh.list = [];
    EXT_UI.errors.dsh =
      I18n.t("DSH 插件列表不可用（") +
      ((r && r.error) || I18n.t("引擎未连接")) +
      I18n.t("）· 重新打开设置重试");
    return;
  }
  EXT_UI.state.dsh.list = r.plugins.map(enrichDshPluginCopy);
  EXT_UI.errors.dsh = "";
}

async function refreshExtInventory(opts) {
  opts = opts || {};
  const want = opts.kinds || ["dsh", "skill", "mcp"];
  if (!want.length) return;
  const fetchers = {
    dsh: fetchExtPlugins,
    skill: async () => {
      try {
        const r = await window.api.skillList();
        if (r && r.ok === false) throw new Error(r.error);
        EXT_UI.state.skill.list = (r && r.skills) || [];
        EXT_UI.errors.skill = "";
      } catch (e) {
        EXT_UI.state.skill.list = [];
        EXT_UI.errors.skill =
          I18n.t("技能列表不可用（") + extErrorText(e) + I18n.t("）");
      }
    },
    mcp: async () => {
      try {
        const r = await window.api.dshMcpList();
        if (!r || r.ok === false || !Array.isArray(r.servers))
          throw new Error((r && r.error) || I18n.t("引擎未连接"));
        EXT_UI.state.mcp.list = r.servers;
        EXT_UI.errors.mcp = "";
      } catch (e) {
        EXT_UI.state.mcp.list = [];
        EXT_UI.errors.mcp =
          I18n.t("MCP 列表不可用（") + extErrorText(e) + I18n.t("）");
      }
    },
  };
  for (const k of want) {
    EXT_UI.loaded[k] = true;
    try {
      await fetchers[k]();
    } catch (e) {
      EXT_UI.errors[k] = extErrorText(e);
    }
  }
  paintExtHint();
  paintExtManager();
}

async function openExtManagerDialog(kind) {
  const host = ensureExtManagerDlg();
  EXT_UI.kind = EXT_KIND[kind] ? kind : "dsh";
  EXT_UI.state[EXT_UI.kind].query = "";
  EXT_UI.open = true;
  host.classList.add("on");
  try {
    host.focus();
  } catch (_) {}
  const t = document.getElementById("extManagerTitle");
  if (t) t.textContent = I18n.t("扩展能力管理");
  /* 每次点「管理」都重新拉一遍三类清单：引擎可能刚装完插件又重启过 */
  await refreshExtInventory();
  paintExtManager();
}

/* ── 兼容旧命名（设置与助手工具仍在用这些名字）── */
function openDshPluginsDialog() {
  return openExtManagerDialog("dsh");
}
function closeDshPluginsDialog() {
  return closeExtManagerDialog();
}
function refreshDshPluginInventory() {
  return refreshExtInventory({ kinds: ["dsh"] });
}