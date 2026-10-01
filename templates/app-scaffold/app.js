/* app.js — 脚手架逻辑：宿主探测 → 降级横幅 → 数据文件夹（可改）→ 便签落盘 → 关窗收尾
 *
 * 应用的三件基础设施都在这一个例子里（照抄改业务即可）：
 *   1) 落盘：Store.create(...) 包一层「脏标记 + 防抖自动存盘」，关窗前由 AppClose 强制冲刷；
 *   2) 数据文件夹：显示当前落点、可在窗口里改（dataDirPick，只有用户亲自选过的那一次生效）、
 *      一键在资源管理器中打开；宿主不给这套能力时整块隐藏，不假装能改；
 *   3) 正确关闭：关闭按钮走 appHost.close()，宿主先发 willClose 让本页收尾（写盘 + 退订），
 *      本页再回包；主程序退出时同样走这一条。
 *
 * 契约要点（详见 mtnode-app-dev 技能）：
 *  - 只调 window.AppHost 里探测过的能力；
 *  - appHost 缺席时功能退化成内存态，界面明确说「不会保存」，不静默丢数据；
 *  - 应用侧不碰凭据、不自己拼本机路径（落盘一律交宿主）；
 *  - **模型从 MTNode 继承**：右上「模型」按钮（app-model.js）列出 MTNode 已配置的模型供用户选，
 *    没有可用模型 / 断网 / 模型不支持识图时按宿主的错误码给明确提示，**不降级**。
 */
(function () {
  "use strict";

  var H = window.AppHost || {
    cap: {
      host: false, data: false, dataDir: false, dataDirPick: false, account: false, net: false,
      text: false, models: false, pick: false, close: false, shown: false,
    },
    getData: async function () {
      return { ok: false, data: null };
    },
    setData: async function () {
      return { ok: false, error: "no_host" };
    },
    accountText: async function () {
      return "未接入宿主";
    },
    models: async function () {
      return { ok: false, error: "no_host", models: [], selected: "auto", hasAny: false };
    },
    modelGet: async function () {
      return { ok: false, error: "no_host", selected: "auto" };
    },
    modelSet: async function () {
      return { ok: false, error: "no_host" };
    },
    pickImage: async function () {
      return { ok: false, code: "no_host" };
    },
    text: async function () {
      return { ok: false, code: "no_host" };
    },
    on: function () {
      return false;
    },
    onShown: function () {
      return false;
    },
    offAll: function () {},
    close: function () {},
    quit: function () {},
  };
  var AC = window.AppClose || { on: function () {}, flush: async function () {} };
  var Store = window.Store;

  var $ = function (id) {
    return document.getElementById(id);
  };

  /* 便签数据：形状与 data.json 里落盘的对象一致 */
  var state = { notes: [] };
  var store =
    Store && Store.create
      ? Store.create({ host: H, file: "data.json", debounceMs: 400, initial: state })
      : null;
  /* 没带 store.js 时的兜底：直接整份写（老应用就是这写法，照样能跑） */
  function saveNow() {
    if (store) return store.flush();
    return H.setData(state);
  }

  /* 语言：只改 <html lang>，显示哪一份由 style.css 的 [data-lang] 规则决定
     （首帧就不会两套文案叠在一起）；没有 JS 时中文那份照常显示。 */
  var lang = /^zh/i.test(navigator.language || "") ? "zh" : "en";
  /* 模型选择位（app-model.js）：右上那个按钮 + 下拉；HTM 缺席时它自己会置灰并写清原因 */
  var M = window.AppModel
    ? window.AppModel.create({
        host: H,
        btn: "modelBtn",
        menu: "modelMenu",
        backdrop: "modelMask",
      })
    : null;
  function paintLang() {
    document.documentElement.lang = lang === "zh" ? "zh-CN" : "en";
    var btn = $("langBtn");
    if (btn) {
      btn.textContent = lang === "zh" ? "EN" : "中";
      btn.title = lang === "zh" ? "Switch to English" : "切换到中文";
      btn.setAttribute("aria-label", btn.title);
    }
    if (M) M.render(); /* 模型按钮 / 下拉的文案随语言重画 */
  }
  var langBtn = $("langBtn");
  if (langBtn)
    langBtn.addEventListener("click", function () {
      lang = lang === "zh" ? "en" : "zh";
      paintLang();
    });
  paintLang();

  /* ── 能力横幅：桥缺席 / 接口被裁剪时这里必须出现，而不是白屏 ── */
  function setCapBar() {
    var bar = $("capBar");
    var missing = [];
    if (!H.cap.host) missing.push("宿主未接入（在浏览器里打开？）");
    else {
      if (!H.cap.data) missing.push("数据读写接口缺失");
      if (!H.cap.account) missing.push("账号接口缺失");
      if (!H.cap.net) missing.push("服务端请求接口缺失");
      if (!H.cap.text) missing.push("文本生成接口缺失（模型能力不可用）");
      if (!H.cap.models) missing.push("模型选择接口缺失（不能从 MTNode 继承模型）");
    }
    if (!missing.length) {
      bar.hidden = true;
      return;
    }
    bar.hidden = false;
    bar.textContent = "降级运行：" + missing.join(" · ") + " —— 便签只留在内存，关窗即丢。";
  }

  function persistText() {
    return H.cap.data ? "由宿主落盘（data.json）" : "内存（不保存）";
  }

  function hint(text, kind) {
    var el = $("saveHint");
    el.textContent = text;
    el.dataset.kind = kind || "";
    if (!text) return;
    setTimeout(function () {
      if (el.textContent === text) el.textContent = "";
    }, 2400);
  }

  function render() {
    var ul = $("noteList");
    ul.textContent = "";
    for (var i = 0; i < state.notes.length; i++) {
      var li = document.createElement("li");
      li.className = "list-item";
      li.textContent = state.notes[i];
      ul.appendChild(li);
    }
    $("kvStore").textContent = persistText();
  }

  /* ── 数据文件夹：显示 / 打开 / 改 ── */
  function renderDataDir(info) {
    var box = $("dataRow");
    var val = $("dataDirVal");
    var capLine = $("dataCap");
    var inf = info && info.ok !== false ? info : null;
    if (!inf) {
      val.textContent = "—";
      val.title = "";
      capLine.textContent =
        H.cap.dataDir
          ? "读不到数据文件夹：" + ((info && info.error) || "未知错误")
          : "本版本宿主没有「数据文件夹」这套能力：数据由宿主保管，应用看不到路径。";
      $("btnDataPick").hidden = true;
      $("btnDataOpen").hidden = true;
      $("btnDataDefault").hidden = true;
      return;
    }
    val.textContent = String(inf.dir || "");
    val.title = String(inf.dir || "");
    capLine.textContent = inf.def
      ? "默认位置（跟着 MTNode 的数据目录走）"
      : "自定义位置（你亲自选的）";
    box.dataset.custom = inf.def ? "" : "1";
    $("btnDataPick").hidden = !H.cap.dataDirPick;
    $("btnDataOpen").hidden = !H.cap.dataDirOpen;
    $("btnDataDefault").hidden = !!inf.def;
  }

  async function refreshDataDir() {
    if (!H.cap.dataDir) {
      renderDataDir(null);
      return null;
    }
    var r = await H.dataDirGet();
    renderDataDir(r);
    return r;
  }

  async function boot() {
    setCapBar();
    /* 模型清单：先拉一次（按钮文案与下拉内容都靠它）；失败也照常在界面上写清原因 */
    if (M) await M.init();
    if (store) {
      var loaded = await store.load();
      if (loaded.ok && loaded.data && Array.isArray(loaded.data.notes)) {
        state.notes = loaded.data.notes.map(String);
      }
      store.on(function (ev, arg) {
        if (ev === "saved") hint("已保存");
        else if (ev === "fail") hint("保存失败：" + String(arg || ""), "warn");
      });
    } else {
      /* 没带 store.js：老写法兜底（读一次就够） */
      var r = await H.getData();
      if (r.ok && r.data && Array.isArray(r.data.notes)) state.notes = r.data.notes.map(String);
    }
    $("kvId").textContent = H.id || (H.host && H.host.id) || "（未知 id）";
    $("kvAccount").textContent = await H.accountText();
    render();
    await refreshDataDir();

    /* 窗口又被显示 / 置顶：刷新账号与数据文件夹（用户可能在别处改过） */
    H.onShown(async function () {
      $("kvAccount").textContent = await H.accountText();
      await refreshDataDir();
    });

    /* 关窗收尾：先冲刷未落盘的内容，再退订事件 —— 宿主会等这一步（上限 1.5s） */
    AC.on(function () {
      return Promise.all([saveNow(), Promise.resolve(H.offAll())]);
    });
  }

  function addNote() {
    var input = $("noteInput");
    var text = String(input.value || "").trim();
    if (!text) return;
    state.notes.push(text);
    input.value = "";
    render();
    if (store) store.set({ notes: state.notes });
    else
      H.setData({ notes: state.notes }).then(function (w) {
        hint(w && w.ok !== false ? "已保存" : "宿主不可用：本条只留在内存", w && w.ok !== false ? "" : "warn");
      });
  }

  function clearNotes() {
    state.notes = [];
    render();
    if (store) store.set({ notes: [] });
    else H.setData({ notes: [] });
  }

  /* 换数据文件夹：只有用户亲自点、亲自选目录那一次才生效（宿主侧同样只认它） */
  async function pickDataDir() {
    if (!H.cap.dataDirPick) return;
    var before = await H.dataDirGet();
    var r = await H.dataDirPick();
    if (!r || r.canceled) return;
    if (r.ok === false) {
      hint("选择失败：" + (r.error || ""), "warn");
      return;
    }
    await saveNow(); /* 换目录前把还没写的内容落到**旧**目录，不丢 */
    await refreshDataDir();
    var moved = r.dir && before && before.dir && r.dir !== before.dir;
    hint(moved ? "已切换数据文件夹（原目录内容留在原处）" : "已设置数据文件夹");
    /* 新目录当场生效：把当前内存态写过去（不搬旧数据，旧文件原样留在原处） */
    if (store) {
      store.reset(state);
      store.set(state);
    } else {
      H.setData(state);
    }
  }

  async function openDataDir() {
    if (!H.cap.dataDirOpen) return;
    var r = await H.dataDirOpen();
    if (r && r.ok === false) hint("打不开文件夹：" + (r.error || ""), "warn");
  }

  async function resetDataDir() {
    if (!H.cap.dataDirReset) return;
    await saveNow(); /* 先把内容留在当前（自定义）目录，再切回默认 */
    var r = await H.dataDirReset();
    if (r && r.ok === false) {
      hint("切回默认失败：" + (r.error || ""), "warn");
      return;
    }
    await refreshDataDir();
    hint("已回到默认数据文件夹（原目录内容留在原处）");
  }

  /* ── 模型能力示例：文字 + 图像一起问 ──
   选图走宿主（AppHost.pickImage，系统对话框，用户亲自选的那一次才生效）；
   图只给**路径**，读盘 / 缩放由宿主做。问的时候带上当前模型（M.model()，空串 = 跟随默认）。
   任何失败都按宿主的错误码给一句可操作的提示，不降级、不静默丢图。 */
  var picked = "";

  function askOut(text, kind) {
    var el = $("askOut");
    if (!text) {
      el.hidden = true;
      el.textContent = "";
      el.dataset.kind = "";
      return;
    }
    el.hidden = false;
    el.textContent = text;
    el.dataset.kind = kind || "";
  }

  async function pickImage() {
    askOut("");
    if (!H.cap.pick) {
      askOut("本版本宿主没有「选图」接口：模型只能收文字。", "warn");
      return;
    }
    var r = await H.pickImage();
    if (r && r.code === "cancelled") return; /* 用户主动取消：不当报错 */
    if (!r || r.ok === false) {
      askOut("选图失败：" + (M ? M.errorText(r) : (r && r.error) || ""), "warn");
      return;
    }
    picked = String(r.path || "");
    $("pickName").textContent = picked ? picked.split(/[\\/]/).pop() : "";
    $("pickName").title = picked;
  }

  async function askWithImage() {
    var q = String($("askInput").value || "").trim();
    if (!q) {
      askOut("先写一句要问的话（例如：图里有什么？）", "warn");
      return;
    }
    if (!H.cap.text) {
      askOut("本版本宿主没有文本生成接口：模型能力不可用。", "warn");
      return;
    }
    askOut("正在问模型…");
    var res = await H.text(q, {
      model: M ? M.model() : "",
      images: picked ? [picked] : [],
    });
    if (!res || res.ok === false) {
      /* no_provider / no_vision / bad_image / too_large / offline / http_401… 都从这里出去 */
      askOut((M ? M.errorText(res) : (res && res.error) || "调用失败"), "warn");
      if (M && (res.code === "no_vision" || res.code === "bad_model")) M.render(); /* 让用户当场换模型 */
      return;
    }
    askOut(String(res.text || "") + (res.model ? "\n\n— " + res.model : ""));
  }

  /* ── 底部语音听写（speech.js）：footer 里那一枚话筒 + 「音频转文字」 ──
     识别用的是本机内置语音（官方本地 SenseVoice，跑在 MTNode 的 dsh 运行时里），
     与上面那条的别的宿主能力一样：先探能力，缺了就写清原因，不假装能用。
     结果只展示 + 一键复制，应用要拿去做什么由自己的代码决定（见 window.Speech）。 */
  var speechBar = null;
  if (window.Speech && typeof window.Speech.mount === "function") {
    speechBar = window.Speech.mount($("speechBar"));
  } else {
    var sb = $("speechBar");
    if (sb) sb.textContent = "语音听写模块未加载（speech.js 缺失）";
  }
  /* 示例：应用自己也能直接调用（不进 footer 的界面）——
       AppHost.pickAudio() → AppHost.transcribe({ path }) → { ok, text }
       AppHost.transcribeWav(base64_16k_mono_pcm16_wav)（应用自己录的音频）
       AppHost.speechStatus() / AppHost.speechPrepare()（现况与首次下载） */

  $("btnAdd").addEventListener("click", addNote);
  $("btnClear").addEventListener("click", clearNotes);
  $("btnClose").addEventListener("click", function () {
    saveNow();
    H.close();
  });
  $("btnDataPick").addEventListener("click", pickDataDir);
  $("btnDataOpen").addEventListener("click", openDataDir);
  $("btnDataDefault").addEventListener("click", resetDataDir);
  $("noteInput").addEventListener("keydown", function (ev) {
    if (ev.key === "Enter") addNote();
  });
  $("btnPick").addEventListener("click", pickImage);
  $("btnAsk").addEventListener("click", askWithImage);
  $("askInput").addEventListener("keydown", function (ev) {
    if (ev.key === "Enter") askWithImage();
  });

  boot();
})();