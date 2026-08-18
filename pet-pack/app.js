"use strict";
/**
 * 桌宠页：
 * - Live2D 负责身体/静置爪/鼠标（限帧）
 * - 按键 PNG 全幅叠加；按下时 Live2D CatParamLeftHandDown 收起静置爪，避免双爪
 * - Live2D 失败则回退 cover（无鼠标形变，按键时暂时隐藏 cover 防双爪）
 */
(function () {
  const coverImg = document.getElementById("coverImg");
  const bgImg = document.getElementById("bgImg");
  const canvas = document.getElementById("live2dCanvas");
  const overlays = document.getElementById("overlays");
  const btnMenu = document.getElementById("btnMenu");
  const btnChat = document.getElementById("btnChat");
  const btnBar = document.querySelector(".btn-bar");

  const DEFAULT_COVER = "models/bongocat-standard/resources/cover.png";
  const DEFAULT_BG = "models/bongocat-standard/resources/background.png";
  const DEFAULT_KEYS = "models/bongocat-standard/resources/left-keys";
  const DEFAULT_MODEL = "models/bongocat-standard/cat.model3.json";

  let keysBase = DEFAULT_KEYS;
  let pressed = Object.create(null);
  let keyImgCache = Object.create(null);
  let petApi = null;
  let mirror = false;
  let live2dReady = false;
  let live2dFailed = false;
  let live2dStarting = false;
  const L2D = window.PetLive2D || null;

  function buildApiFromIpc(ipcRenderer) {
    return {
      close: () => ipcRenderer.invoke("pet:stop"),
      status: () => ipcRenderer.invoke("pet:status"),
      getState: () => ipcRenderer.invoke("pet:getState"),
      getConfig: () => ipcRenderer.invoke("pet:getConfig"),
      setConfig: (partial) => ipcRenderer.invoke("pet:setConfig", partial || {}),
      popupMenu: () => ipcRenderer.invoke("pet:popupMenu"),
      openChat: () => ipcRenderer.invoke("pet:openChat"),
      toggleChat: () => ipcRenderer.invoke("pet:toggleChat"),
      dragStart: (x, y) => ipcRenderer.invoke("pet:dragStart", x, y),
      dragMove: (x, y) => ipcRenderer.invoke("pet:dragMove", x, y),
      dragEnd: () => ipcRenderer.invoke("pet:dragEnd"),
      onDevice: (cb) => {
        const handler = (_e, data) => {
          try {
            cb(data);
          } catch (_) {}
        };
        ipcRenderer.on("pet:device", handler);
        return () => ipcRenderer.removeListener("pet:device", handler);
      },
      onState: (cb) => {
        const handler = (_e, data) => {
          try {
            cb(data);
          } catch (_) {}
        };
        ipcRenderer.on("pet:state", handler);
        return () => ipcRenderer.removeListener("pet:state", handler);
      },
    };
  }

  function resolvePetApi() {
    /* 旧版 preload 有 popupMenu 但缺 openChat，不能直接采用 */
    if (
      window.petApi &&
      typeof window.petApi.popupMenu === "function" &&
      (typeof window.petApi.openChat === "function" ||
        typeof window.petApi.toggleChat === "function")
    ) {
      return window.petApi;
    }
    try {
      const req =
        typeof require === "function"
          ? require
          : typeof window.require === "function"
            ? window.require
            : null;
      if (req) {
        const electron = req("electron");
        if (electron && electron.ipcRenderer) {
          const built = buildApiFromIpc(electron.ipcRenderer);
          /* 旧 preload 已注入不完整 petApi 时，补上对话方法 */
          if (window.petApi && built) {
            try {
              if (!window.petApi.openChat) window.petApi.openChat = built.openChat;
              if (!window.petApi.toggleChat) window.petApi.toggleChat = built.toggleChat;
            } catch (_) {}
          }
          return built;
        }
      }
    } catch (_) {}
    if (window.petApi && typeof window.petApi.popupMenu === "function") {
      return window.petApi;
    }
    return null;
  }

  function showCover(show) {
    if (!coverImg) return;
    /* Live2D 就绪后必须彻底隐藏 cover，否则静置爪会与按键爪重叠 */
    if (live2dReady) show = false;
    coverImg.hidden = !show;
    coverImg.style.display = show ? "block" : "none";
    coverImg.style.visibility = show ? "visible" : "hidden";
    coverImg.style.opacity = show ? "1" : "0";
    coverImg.style.pointerEvents = "none";
  }

  async function initLive2d(modelUrl) {
    if (live2dReady || live2dFailed || live2dStarting) return live2dReady;
    if (!L2D || !canvas || !window.Live2DCubismCore) {
      live2dFailed = true;
      showCover(true);
      return false;
    }
    live2dStarting = true;
    showCover(true);
    try {
      const url = modelUrl || DEFAULT_MODEL;
      const abs = new URL(url, window.location.href);
      const base = abs.href.replace(/[^/]+$/, "");
      await L2D.initLive2d(canvas, abs.href, base);
      live2dReady = !!(L2D.isReady && L2D.isReady());
      if (!live2dReady) throw new Error("not ready");
      showCover(false);
      /* 默认抬爪 */
      if (L2D.applyKeyHand) L2D.applyKeyHand(false);
      let resizeTimer = null;
      let lastResize = { w: window.innerWidth || 0, h: window.innerHeight || 0 };
      window.addEventListener("resize", () => {
        if (dragActive) return;
        const w = window.innerWidth || 0;
        const h = window.innerHeight || 0;
        if (Math.abs(w - lastResize.w) < 2 && Math.abs(h - lastResize.h) < 2) return;
        lastResize = { w, h };
        if (resizeTimer) clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => {
          try {
            L2D.resizeLive2d();
          } catch (_) {}
        }, 120);
      });
      return true;
    } catch (err) {
      console.error("[pet] live2d failed, fallback cover", err);
      live2dFailed = true;
      live2dReady = false;
      try {
        if (L2D && L2D.destroyLive2d) L2D.destroyLive2d();
      } catch (_) {}
      showCover(true);
      return false;
    } finally {
      live2dStarting = false;
    }
  }

  function connectApi(api) {
    petApi = api;
    if (petApi.onDevice) petApi.onDevice(onDevice);
    if (petApi.onState) petApi.onState(onState);
    if (petApi.getState) {
      petApi
        .getState()
        .then((r) => {
          if (r && r.ok) onState(r);
        })
        .catch(() => {});
    }
  }

  function openMenu(ev) {
    if (ev) {
      ev.preventDefault();
      ev.stopPropagation();
    }
    if (!petApi) petApi = resolvePetApi();
    if (petApi && petApi.popupMenu) {
      Promise.resolve(petApi.popupMenu()).catch(() => {});
    }
  }

  /* 自定义拖拽：避免 -webkit-app-region:drag 触发 Windows 系统窗口菜单；单击不再开对话 */
  let dragActive = false;
  let dragOrigin = null;

  function ensureApi() {
    if (!petApi) petApi = resolvePetApi();
    return petApi;
  }

  function isChromeHit(target) {
    if (!target) return false;
    if (btnBar && btnBar.contains(target)) return true;
    if (btnMenu && (target === btnMenu || btnMenu.contains(target))) return true;
    if (btnChat && (target === btnChat || btnChat.contains(target))) return true;
    return false;
  }

  let dragMoveQueued = false;
  let dragLastX = 0;
  let dragLastY = 0;

  document.addEventListener(
    "mousedown",
    (ev) => {
      if (ev.button !== 0) return;
      if (isChromeHit(ev.target)) return;
      dragActive = true;
      dragOrigin = { x: ev.screenX, y: ev.screenY };
      dragLastX = ev.screenX;
      dragLastY = ev.screenY;
      document.body.classList.add("dragging");
      const api = ensureApi();
      if (api && api.dragStart) {
        Promise.resolve(api.dragStart(ev.screenX, ev.screenY)).catch(() => {});
      }
    },
    true,
  );
  document.addEventListener(
    "mousemove",
    (ev) => {
      if (!dragActive || !dragOrigin) return;
      dragLastX = ev.screenX;
      dragLastY = ev.screenY;
      if (dragMoveQueued) return;
      dragMoveQueued = true;
      requestAnimationFrame(() => {
        dragMoveQueued = false;
        if (!dragActive) return;
        const api = ensureApi();
        if (api && api.dragMove) {
          Promise.resolve(api.dragMove(dragLastX, dragLastY)).catch(() => {});
        }
      });
    },
    true,
  );
  function endDrag() {
    if (!dragActive) return;
    dragActive = false;
    dragOrigin = null;
    document.body.classList.remove("dragging");
    const api = ensureApi();
    if (api && api.dragEnd) {
      Promise.resolve(api.dragEnd()).catch(() => {});
    }
  }
  document.addEventListener("mouseup", endDrag, true);
  window.addEventListener("blur", () => {
    if (dragActive) endDrag();
  });

  if (btnMenu) {
    btnMenu.addEventListener("mousedown", (ev) => {
      ev.stopPropagation();
    });
    btnMenu.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      openMenu(ev);
    });
  }
  function openChatWindow(ev) {
    if (ev) {
      ev.preventDefault();
      ev.stopPropagation();
    }
    const api = ensureApi();
    if (!api) {
      console.error("[pet] openChat: petApi unavailable");
      return;
    }
    const open = api.openChat || api.toggleChat;
    if (!open) {
      console.error("[pet] openChat: host app missing pet:openChat (need rebuild)");
      return;
    }
    Promise.resolve(open())
      .then((r) => {
        if (r && r.ok === false) console.error("[pet] openChat failed", r);
      })
      .catch((err) => {
        console.error("[pet] openChat error", err && err.message ? err.message : err);
      });
  }

  if (btnChat) {
    /* 捕获阶段拦截：避免透明窗/拖拽逻辑吞掉点击 */
    btnChat.addEventListener(
      "mousedown",
      (ev) => {
        ev.stopPropagation();
      },
      true,
    );
    btnChat.addEventListener(
      "click",
      (ev) => {
        openChatWindow(ev);
      },
      true,
    );
  }
  document.addEventListener(
    "contextmenu",
    (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
    },
    true,
  );

  function toSkinKeyName(raw) {
    let n = String(raw || "");
    if (!n) return "";
    const aliases = {
      A: "KeyA",
      B: "KeyB",
      C: "KeyC",
      D: "KeyD",
      E: "KeyE",
      F: "KeyF",
      G: "KeyG",
      H: "KeyH",
      I: "KeyI",
      J: "KeyJ",
      K: "KeyK",
      L: "KeyL",
      M: "KeyM",
      N: "KeyN",
      O: "KeyO",
      P: "KeyP",
      Q: "KeyQ",
      R: "KeyR",
      S: "KeyS",
      T: "KeyT",
      U: "KeyU",
      V: "KeyV",
      W: "KeyW",
      X: "KeyX",
      Y: "KeyY",
      Z: "KeyZ",
      0: "Num0",
      1: "Num1",
      2: "Num2",
      3: "Num3",
      4: "Num4",
      5: "Num5",
      6: "Num6",
      7: "Num7",
      8: "Num8",
      9: "Num9",
      Enter: "Return",
      Backquote: "BackQuote",
      Ctrl: "Control",
      CtrlRight: "ControlRight",
    };
    if (aliases[n]) n = aliases[n];
    if (/^[A-Z]$/.test(n)) n = "Key" + n;
    if (/^[0-9]$/.test(n)) n = "Num" + n;
    return n;
  }

  function keyFileCandidates(name) {
    const n = toSkinKeyName(name);
    const list = [];
    if (n) list.push(n + ".png");
    const raw = String(name || "");
    if (raw && raw + ".png" !== list[0]) list.push(raw + ".png");
    if (n === "Control") list.push("ControlLeft.png", "Control.png");
    if (n === "Shift") list.push("ShiftLeft.png", "Shift.png");
    if (n === "ControlRight") list.push("ControlRight.png", "Control.png");
    if (n === "ShiftRight") list.push("ShiftRight.png", "Shift.png");
    return list;
  }

  function tryLoadKey(name, done) {
    if (Object.prototype.hasOwnProperty.call(keyImgCache, name)) {
      return done(keyImgCache[name]);
    }
    const candidates = keyFileCandidates(name);
    let i = 0;
    const next = () => {
      if (i >= candidates.length) {
        keyImgCache[name] = null;
        return done(null);
      }
      const file = candidates[i++];
      const img = new Image();
      img.onload = () => {
        keyImgCache[name] = img;
        done(img);
      };
      img.onerror = next;
      img.src = keysBase.replace(/\/?$/, "/") + file;
    };
    next();
  }

  function syncHandState() {
    const hasKey = Object.keys(pressed).length > 0;
    if (live2dReady && L2D) {
      /* 先收爪再叠按键图，避免一帧内双爪 */
      if (L2D.applyKeyHand) L2D.applyKeyHand(hasKey);
      showCover(false);
      if (canvas) canvas.style.opacity = "1";
      return;
    }
    /* 无 Live2D：按键时隐藏 cover，只留背景+按键爪 */
    showCover(!hasKey);
  }

  function refreshOverlays() {
    if (!overlays) return;
    overlays.innerHTML = "";
    syncHandState();
    const keys = Object.keys(pressed);
    if (!keys.length) return;
    const name = keys[keys.length - 1];
    tryLoadKey(name, (img) => {
      if (!img || !pressed[name]) return;
      const el = document.createElement("img");
      el.className = "key-overlay";
      el.src = img.src;
      overlays.appendChild(el);
    });
  }

  function screenToMonitorRatio(pt) {
    const x = Number(pt && pt.x) || 0;
    const y = Number(pt && pt.y) || 0;
    const sw = window.screen.width || 1920;
    const sh = window.screen.height || 1080;
    return {
      x: Math.min(1, Math.max(0, x / sw)),
      y: Math.min(1, Math.max(0, y / sh)),
    };
  }

  function onDevice(ev) {
    if (!ev || !ev.kind) return;
    if (ev.kind === "KeyboardPress") {
      pressed[String(ev.value)] = true;
      refreshOverlays();
    } else if (ev.kind === "KeyboardRelease") {
      delete pressed[String(ev.value)];
      refreshOverlays();
    } else if (ev.kind === "MousePress") {
      if (live2dReady && L2D) L2D.applyMouseButton(String(ev.value || "Left"), true);
    } else if (ev.kind === "MouseRelease") {
      if (live2dReady && L2D) L2D.applyMouseButton(String(ev.value || "Left"), false);
    } else if (ev.kind === "MouseMove") {
      if (live2dReady && L2D) {
        const r = screenToMonitorRatio(ev.value || {});
        L2D.applyMouseMove(r.x, r.y, mirror);
      }
    }
  }

  function onState(st) {
    if (!st) return;
    mirror = !!(st.config && st.config.mirror);
    document.body.classList.toggle("mirror", mirror);
    const cover = (st.skin && st.skin.coverUrl) || DEFAULT_COVER;
    const bg = (st.skin && st.skin.backgroundUrl) || DEFAULT_BG;
    if (!live2dReady && coverImg && cover && coverImg.getAttribute("src") !== cover) {
      coverImg.src = cover;
    }
    if (bgImg && bg && bgImg.getAttribute("src") !== bg) bgImg.src = bg;
    if (st.skin && st.skin.keysLeftUrl) {
      keysBase = st.skin.keysLeftUrl;
      keyImgCache = Object.create(null);
    }
    if (!live2dReady && !live2dFailed && !live2dStarting) {
      const modelUrl =
        (st.skin && (st.skin.model3Url || st.skin.model3)) || DEFAULT_MODEL;
      initLive2d(modelUrl);
    }
  }

  showCover(true);
  initLive2d(DEFAULT_MODEL);

  let tries = 0;
  const boot = () => {
    const api = resolvePetApi();
    if (api) {
      connectApi(api);
      return true;
    }
    return false;
  };
  if (!boot()) {
    const timer = setInterval(() => {
      tries += 1;
      if (boot() || tries >= 50) clearInterval(timer);
    }, 100);
  }
})();
