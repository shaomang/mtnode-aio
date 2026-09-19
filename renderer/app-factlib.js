"use strict";
/* ============ 团队事实库（Fact Library）· 路径解析与文件落盘 ============
 *
 * 每个画布锚点一份「事实库」：库内可有多篇**互相独立**的文档（不同主题各一篇，由专家建档），
 * 全部落在同一个库目录里；图片资产由整库共享。它等同于「文字处理节点」的文档，
 * 但**不上画布**，只服务左侧专家列表里的「团队」。
 *
 * 落盘形态（全部在磁盘，画布配置只存绝对路径）：
 *   <dir>/<doc>.md             每篇文档一份正文（当前稿，可手动编辑）
 *   <dir>/<doc>.review.json    每篇文档一份审阅 sidecar（版本链 / notesLog / voided）
 *   <dir>/assets/              库级共享插图资产（md 里用相对路径引用）
 *
 * 路径解析（resolvePaths，建库时写死进 S.config.team.canvases[].fact）：
 *   1) 画布文件夹优先：teamCanvasWorkspace(canvasId)（= app-team.js factWorkspace，
 *      口径为「锚点手填 > 该画布的工作目录（顶栏「工作目录」）」）非空 → <画布文件夹>/团队事实库/
 *      —— **刻意不含「画布项目根（开发节点 devPath）」那一档**：事实库是画布自己的资料，
 *      跟着 devPath 走会被拽进项目源码目录；该项目恰好是应用自身时库就落进应用文件夹。
 *   2) 画布还没有文件夹（顶栏工作目录为空）→ 弹目录选择让用户**为这张画布**选一个，
 *      选定结果写进库记录（`fact.dir`），此后库跟着画布走；**不回写画布 / 会话工作区**
 *      （那会连带改掉专家会话的落盘目录）。
 *      **不再回落到全局「项目文件夹根」（旧 S.config.projectsRoot）** —— 那个根常常就是
 *      正在开发的项目目录，库会被拽进去（用户报过的错）；用户取消 → 建库失败（不猜路径、
 *      **绝不**回落应用数据目录）。
 *   建库后一律读配置里的绝对路径（工作区变更不漂移），只有从未建过库时才重新解析。
 *   硬守卫（misplacedReason）：解析结果若位于**应用目录**（app.getAppPath() / exe 目录，经
 *   api.appDirs() 取）**或该画布的开发节点项目根**内，一律拒绝（前者升级 / 卸载会带走或覆盖，
 *   后者就是「库被拽进源码目录」的入口）；口径与主进程 factLibDirOf / isInsideAppDir 一致。
 *   已建库的历史错位（旧版跟着项目根落进了应用 / 项目目录）由 relocateLibrary 体检 + 显式迁移。
 *
 * 迁移与幂等口径：旧配置只有单条 file（无 docs）时，app-team.js normalizeFact 折成
 * docs[0]（幂等，未知键保留）；本文件按 docs[].name / docs[].file 逐篇解析路径，
 * doc.file 为空时按 <dir>/<name>.md 生成，reviewFile 同理；ensureDocByName 幂等建文档，
 * 已存在（同名）原样返回、绝不覆盖正文。
 *
 * 保存即广播：每次 writeDoc 成功落盘后都在 document 上派发 "factlib:saved"
 *   （detail = { file }），左侧栏文档行据此立即刷新该篇的更新时间，不必等整面重渲染。
 *   正文由专家用文件工具直接写入（不经 writeDoc）时由运行结束的 renderTeamPane 兜底。
 *
 * 自动登记（reconcile）：专家用文件工具把新 <doc>.md 写进库目录时，配置里没有对应
 *   docs[] 记录（连库记录本身都可能缺），左栏自然列不出来。reconcile(canvasId) 扫库目录
 *   与 docs[] 比对，只把**缺失的** .md 登记进库（缺库记录时先建库），落盘即生成对应 json；
 *   只增不删不覆盖，幂等。
 *
 * 公开接口：window.MTNodeFactLib（同层脚本也可用全局 factlib* 函数）。
 */
(function () {
  function T(s) {
    return window.I18n && window.I18n.t ? window.I18n.t(s) : String(s);
  }
  function api() {
    try {
      return window.api || null;
    } catch (e) {
      return null;
    }
  }
  function str(v) {
    return String(v == null ? "" : v);
  }
  /* 提示（app.js 的全局 toast；缺失时静默）。 */
  function warn(msg) {
    try {
      if (typeof toast === "function") toast(msg, "warn");
    } catch (e) {}
  }

  /* 首次建库写入的正文模板（用户可随手改；标题即库名）。 */
  var TEMPLATE = [
    "# " + T("团队事实库"),
    "",
    T("> 本文件是团队共享的事实库，可手动编辑；团队成员在回答事实性问题前会先查阅这里。"),
    "",
    "## " + T("事实"),
    "",
  ].join("\n");

  /* ───────────────────────── 路径工具（渲染层无 node path，自己拼） ───────────────────────── */

  function isWinPath(p) {
    var s = str(p);
    return /^[a-zA-Z]:/.test(s) || s.indexOf("\\") >= 0;
  }
  function joinPath() {
    var parts = [];
    for (var i = 0; i < arguments.length; i++) {
      var p = arguments[i];
      if (p != null && str(p) !== "") parts.push(str(p));
    }
    if (!parts.length) return "";
    var win = isWinPath(parts[0]);
    var joined = parts
      .map(function (s) {
        return s.replace(/[\\/]+/g, "/").replace(/\/+$/, "");
      })
      .join("/")
      .replace(/\/{2,}/g, "/");
    return win ? joined.replace(/\//g, "\\") : joined;
  }
  function dirNameOf(p) {
    var s = str(p).replace(/[\\/]+$/, "");
    var i = Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\"));
    if (i <= 0) return i === 0 ? s.slice(0, 1) : "";
    return s.slice(0, i);
  }
  function baseNameOf(p) {
    var s = str(p).replace(/[\\/]+$/, "");
    var i = Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\"));
    return i >= 0 ? s.slice(i + 1) : s;
  }
  function stripExt(name) {
    var s = str(name);
    var i = s.lastIndexOf(".");
    return i > 0 ? s.slice(0, i) : s;
  }
  function isAbs(p) {
    var s = str(p).trim();
    if (!s) return false;
    return /^[a-zA-Z]:[\\/]/.test(s) || /^\\\\/.test(s) || s.charAt(0) === "/";
  }
  /* 路径比对键：统一分隔符 + 去尾斜杠 + 小写（Windows 大小写不敏感），避免同一文件被重复登记。 */
  function pathKey(p) {
    return str(p)
      .replace(/[\\/]+/g, "/")
      .replace(/\/+$/, "")
      .toLowerCase();
  }

  /* 库名 → 安全文件名（去掉路径分隔符与 Windows 非法字符，空则回落「事实库」）。 */
  function safeName(name) {
    var s = str(name)
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
      .trim();
    return s || T("事实库");
  }

  /* ──────── 落点守卫：应用目录 / 该画布的开发节点项目根 ──────── */

  /* 应用目录（asar 根 + exe 目录）：由主进程 app:dirs 给出，只取一次并缓存。
     事实库解析结果落在这里一律拒绝（升级 / 卸载会带走或覆盖），与主进程 factLibDirOf 同口径。 */
  var _appDirs = null;
  function appDirs() {
    if (_appDirs) return _appDirs;
    var a = api();
    if (!a || typeof a.appDirs !== "function") {
      _appDirs = Promise.resolve([]);
      return _appDirs;
    }
    _appDirs = Promise.resolve(a.appDirs()).then(
      function (r) {
        var out = [];
        if (r && r.ok !== false) {
          if (r.appPath) out.push(str(r.appPath));
          if (r.exeDir) out.push(str(r.exeDir));
          if (Array.isArray(r.dirs))
            r.dirs.forEach(function (d) {
              if (d) out.push(str(d));
            });
        }
        return out;
      },
      function () {
        return [];
      },
    );
    return _appDirs;
  }

  /* 目录是否位于应用目录内（本目录或它的子路径）。返回 Promise<boolean>。 */
  function isInAppDir(dir) {
    var d = pathKey(dir);
    if (!d) return Promise.resolve(false);
    return appDirs().then(function (dirs) {
      for (var i = 0; i < dirs.length; i++) {
        var base = pathKey(dirs[i]);
        if (!base) continue;
        if (d === base || d.indexOf(base + "/") === 0) return true;
      }
      return false;
    });
  }

  /* 旧的「项目文件夹根」（S.config.projectsRoot）已**不再**作为事实库落点：
     那个根常常就是正在开发的项目目录，库会被拽进源码目录（用户报过的错）。
     事实库只认画布文件夹 —— 画布还没有文件夹时，让用户为这张画布选一个。 */

  /* 该画布的「开发节点项目根」（app-team.js factDevRoot，经 window.teamFactDevRoot 暴露）。 */
  function canvasDevRoot(canvasId) {
    try {
      if (typeof window.teamFactDevRoot === "function")
        return str(window.teamFactDevRoot(canvasId)).trim();
    } catch (e) {}
    return "";
  }
  /* dir 是否等于 root 或位于其下（Windows 大小写不敏感）。 */
  function underRoot(dir, root) {
    var d = pathKey(dir);
    var r = pathKey(root);
    if (!d || !r) return false;
    return d === r || d.indexOf(r + "/") === 0;
  }
  /* 事实库错位原因："" = 没问题；"app" = 落在应用目录内；"dev" = 落在该画布开发节点项目根内。
     两者都属于「不该落的地方」：库是画布自己的资料，必须待在画布文件夹里；
     项目根等于应用源码目录时，"dev" 这一档就是库被拽进应用文件夹的入口。 */
  function misplacedReason(dir, canvasId) {
    return isInAppDir(dir).then(function (bad) {
      if (bad) return "app";
      var root = canvasDevRoot(canvasId);
      return root && underRoot(dir, root) ? "dev" : "";
    });
  }
  /* 让用户为**这张画布**选一个文件夹（「画布文件夹」）：选定结果写进库记录（`fact.dir`），
     库从此跟着画布走；**不回写画布 / 会话工作区** —— 那会连带改掉专家会话的落盘目录
     （开发画布的项目根正是源码目录，绝不能被这里改掉）。取消 / 无 API → 空串
     （调用方按建库失败处理，绝不猜、绝不落应用数据目录）。 */
  function pickCanvasFolder(canvasId) {
    var a = api();
    if (!a || typeof a.fileOpenDialog !== "function") return Promise.resolve("");
    return Promise.resolve(
      a.fileOpenDialog({
        title: T("选择画布文件夹（团队事实库将建在此目录下的「团队事实库」文件夹里）"),
        directory: true,
      }),
    ).then(
      function (r) {
        var p = r && r.path ? str(r.path).trim() : "";
        if (!p || !isAbs(p)) return "";
        return p;
      },
      function () {
        return "";
      },
    );
  }

  /* ───────────────────────── 路径解析 ───────────────────────── */

  /* 单篇文档的落盘路径：优先用 doc.file（重命名后以配置为准），否则按 <dir>/<name>.md 生成。
     返回 { id, name, file, reviewFile }。 */
  function docPathsOf(dir, doc) {
    var d = doc && typeof doc === "object" ? doc : { name: doc };
    var file = str(d.file);
    var name = safeName(
      d.name || (file ? stripExt(baseNameOf(file)) : "") || T("文档"),
    );
    if (!file) file = joinPath(dir, name + ".md");
    var fdir = dirNameOf(file) || str(dir);
    return {
      id: str(d.id),
      name: name,
      file: file,
      reviewFile:
        str(d.reviewFile) || joinPath(fdir, stripExt(baseNameOf(file)) + ".review.json"),
    };
  }

  /* 计算库目录：画布文件夹优先；画布还没有文件夹就弹目录选择（选定写进库记录，不回写工作区）。
     **不再回落应用数据目录，也不再回落全局「项目文件夹根」**；
     解析结果位于应用目录 / 该画布开发节点项目根内时一律拒绝（返回 null）。
     「画布文件夹」= teamCanvasWorkspace（app-team.js factWorkspace：锚点手填 > 该画布工作目录），
     不含开发节点的项目根 —— 项目画布的 devPath 是应用源码目录时，库必须留在画布自己那边。
     返回 Promise<{ dir, name, docName, file, reviewFile, assetsDir, fromWorkspace }>，
     其中 file / reviewFile 指向**首篇文档**（旧调用点兼容；多文档见 pathsOf / listDocs）；
     用户取消目录选择 / 路径落在禁区内 → null（调用方按建库失败处理，不猜路径）。 */
  function resolvePaths(canvasId, opts) {
    var id = str(canvasId);
    var o = opts || {};
    var docName = safeName(o.docName || o.name || T("事实库"));
    var libName = str(o.libName).trim() || T("事实库");
    var ws = "";
    try {
      /* 画布文件夹（不含开发节点项目根）：见 app-team.js factWorkspace 的说明。 */
      if (typeof window.teamCanvasWorkspace === "function")
        ws = str(window.teamCanvasWorkspace(id)).trim();
    } catch (e) {}
    function pack(dir, fromWs) {
      var dp = docPathsOf(dir, { name: docName });
      return {
        dir: dir,
        name: libName,
        docName: dp.name,
        file: dp.file,
        assetsDir: joinPath(dir, "assets"),
        reviewFile: dp.reviewFile,
        fromWorkspace: !!fromWs,
      };
    }
    /* 落点守卫：命中应用目录 / 该画布开发节点项目根 → 拒绝。
       画布文件夹本身就在禁区时（顶栏工作目录恰好是项目源码目录），非静默情形让用户再选一个
       （只重试一次，避免死循环）；仍不合规就返回 null（建库失败，绝不落禁区）。 */
    function finish(root, fromWs, retried) {
      var dir = joinPath(root, "团队事实库");
      return misplacedReason(dir, id).then(function (why) {
        if (!why) return pack(dir, fromWs);
        warn(
          why === "app"
            ? T("事实库目录不能落在应用目录内")
            : T("事实库目录不能落在项目源码目录内（应放在画布文件夹）"),
        );
        if (o.silent || retried) return null;
        return pickCanvasFolder(id).then(function (picked) {
          if (!picked || pathKey(picked) === pathKey(root)) return null;
          return finish(picked, true, true);
        });
      });
    }
    if (ws) return finish(ws, true);
    /* 画布还没有文件夹（顶栏工作目录为空）→ 让用户为这张画布选一个；
       绝不再回落到全局「项目文件夹根」—— 那个根可能正是开发项目目录。
       静默模式（reconcile 的自动登记扫描）：没有已定画布文件夹就放弃，绝不擅自弹目录选择。 */
    if (o.silent) return Promise.resolve(null);
    return pickCanvasFolder(id).then(function (picked) {
      if (!picked) return null;
      return finish(picked, true);
    });
  }

  /* 从已建库的 fact 记录直接取路径（配置里的绝对路径为准）：
     返回 { dir, name, assetsDir, docs:[{id,name,file,reviewFile}], file, reviewFile, fromWorkspace }。
     docs 覆盖库内全部文档；file / reviewFile 为首篇文档路径镜像（旧调用点兼容）。 */
  function pathsOf(fact) {
    var f = fact && typeof fact === "object" ? fact : {};
    var anyFile = str(f.file);
    var dir = str(f.dir) || (anyFile ? dirNameOf(anyFile) : "");
    if (!dir) return null;
    var assetsDir = str(f.assetsDir) || joinPath(dir, "assets");
    var libName =
      str(f.name).trim() || (anyFile ? stripExt(baseNameOf(anyFile)) : T("事实库"));
    var docs = [];
    if (Array.isArray(f.docs)) {
      f.docs.forEach(function (d) {
        if (!d || typeof d !== "object") return;
        docs.push(docPathsOf(dir, d));
      });
    }
    if (!docs.length && anyFile) {
      docs.push(docPathsOf(dir, { name: stripExt(baseNameOf(anyFile)), file: anyFile }));
    }
    return {
      dir: dir,
      name: libName,
      assetsDir: assetsDir,
      docs: docs,
      file: docs.length ? docs[0].file : anyFile,
      reviewFile: docs.length ? docs[0].reviewFile : "",
      fromWorkspace: false,
    };
  }

  /* ───────────────── 历史错位修复（库落在应用目录 / 项目源码目录 → 迁回画布文件夹） ─────────────────

     旧版本的库路径跟着开发画布的「项目根」走：项目根 = 应用自身源码目录时（正在开发 MTNode
     的那张画布），库就被建进了应用文件夹（打包态下它可能就是 dist\win-unpacked 之外的项目目录，
     所以**不能只认应用目录**）。建库后一律读配置里的绝对路径，pathsOf 只读配置，
     resolvePaths 的守卫拦不住**已建**的库 —— 于是表现为「库还在开发项目目录里」。
     这里做一次体检 + 显式迁移（数据搬家由用户点确认，绝不静默搬迁）：
       库目录位于应用目录内 **或** 位于该画布开发节点项目根内 → 按当前口径重新解析出画布文件夹 →
       问用户是否迁移 → 同意则调主进程整库搬迁（原子 rename / 跨卷 copy+校验）→ 配置里
       dir / assetsDir / 每篇文档路径一次改到位；源目录已不在（被手删 / 只改了配置）则只重定位。
       用户拒绝、解析不出新目录、搬迁失败都保持原样。 */

  /* 迁移确认（app.js 的 confirmDialog；宿主没加载时视为不同意，绝不擅自搬）。
     why 区分错位原因（"app" 应用目录 / "dev" 项目源码目录），文案各说各的损失。 */
  function askRelocate(fromDir, toDir, why) {
    try {
      if (typeof confirmDialog !== "function") return Promise.resolve(false);
      return Promise.resolve(
        confirmDialog(
          (why === "app"
            ? T("事实库当前位于应用文件夹内，应用升级或卸载会丢失。")
            : T("事实库当前位于项目源码目录内（旧版跟着画布项目根走的落点）。")) +
            T("是否迁移到画布文件夹？") +
            "\n" +
            fromDir +
            "\n→\n" +
            toDir,
          {
            title: T("移动事实库"),
            okText: T("迁移"),
            cancelText: T("保持不动"),
          },
        ),
      );
    } catch (e) {
      return Promise.resolve(false);
    }
  }

  /* 体检 + 迁移：返回 Promise<boolean>（true = 本次真的落到了画布文件夹）。
     opts.assumeYes = 跳过确认（测试 / 无界面场景）。 */
  function relocateLibrary(canvasId, opts) {
    return Promise.resolve().then(function () {
      var id = str(canvasId);
      var o = opts || {};
      var team = window.MTNodeTeam;
      var lib = libOf(id);
      if (!id || !lib || !team || typeof team.updateFact !== "function") return false;
      var p = pathsOf(lib);
      if (!p || !p.dir) return false;
      return misplacedReason(p.dir, id).then(function (why) {
        if (!why) return false;
        var docName = (p.docs[0] && p.docs[0].name) || T("事实库");
        var libName = str(lib.name).trim() || T("事实库");
        return resolvePaths(id, {
          name: docName,
          libName: libName,
          silent: o.silent === true,
        }).then(function (np) {
          if (!np || !np.dir || pathKey(np.dir) === pathKey(p.dir)) return false;
          var go = o.assumeYes
            ? Promise.resolve(true)
            : askRelocate(p.dir, np.dir, why);
          return go.then(function (ok) {
            if (!ok) return false;
            return Promise.all([fileExists(p.dir), fileExists(np.dir)]).then(
              function (ex) {
                var srcThere = !!ex[0];
                var dstThere = !!ex[1];
                /* 目标已有同名库 → 不搬（不合并、不覆盖），只把配置改去用它；
                   源目录还在 → 主进程整库搬迁；源已不在（被手删 / 只改了配置）→ 只重定位配置。 */
                var move = Promise.resolve({ ok: true, moved: false });
                if (srcThere && !dstThere) {
                  var a = api();
                  if (a && typeof a.factRelocateLibrary === "function")
                    move = Promise.resolve(
                      a.factRelocateLibrary({ from: p.dir, to: np.dir }),
                    );
                }
                return move.then(function (r) {
                  if (r && r.ok === false) {
                    warn(str(r.error) || T("事实库迁移失败"));
                    return false;
                  }
                  /* 配置改到新目录：每篇文档保留原文件名，只换目录。 */
                  var docs = (p.docs || []).map(function (d) {
                    var base = baseNameOf(d.file);
                    return {
                      id: d.id,
                      name: d.name,
                      file: joinPath(np.dir, base),
                      reviewFile: joinPath(
                        np.dir,
                        stripExt(base) + ".review.json",
                      ),
                    };
                  });
                  var next = team.updateFact(id, {
                    dir: np.dir,
                    assetsDir: np.assetsDir,
                    docs: docs,
                  });
                  /* 正文补建：目标已有库时交给 reconcile 登记实际存在的 .md（只增不删）；
                     源目录已不在且目标为空时按记录补模板（ensureDoc 绝不覆盖已有正文）。 */
                  if (dstThere) {
                    if (typeof reconcile === "function") reconcile(id);
                  } else if (!srcThere && next) {
                    docs.forEach(function (d) {
                      ensureDoc(d);
                    });
                  }
                  warn(
                    dstThere
                      ? T("事实库已改用画布文件夹中已有的库")
                      : T("事实库已迁移到画布工作目录"),
                  );
                  return true;
                });
              },
            );
          });
        });
      });
    });
  }

  /* 入参可以是画布 id、库记录或单篇文档；统一取库记录（拿不到返回 null）。 */
  function libOf(x) {
    if (x && typeof x === "object") return x;
    var team = window.MTNodeTeam;
    if (team && typeof team.fact === "function") return team.fact(str(x));
    return null;
  }
  /* 库内全部文档的路径记录（磁盘路径已解析好）。 */
  function listDocs(x) {
    var p = pathsOf(libOf(x));
    return p ? p.docs : [];
  }
  /* 按名称幂等建档：已存在同名文档直接返回，否则建记录 + 落模板。
     返回 Promise<{id,name,file,reviewFile}>（失败 / 无库 → null）。 */
  function ensureDocByName(canvasId, name) {
    return Promise.resolve().then(function () {
      var team = window.MTNodeTeam;
      var lib = libOf(canvasId);
      if (!lib || !team || typeof team.ensureFactDoc !== "function") return null;
      var p = pathsOf(lib);
      if (!p) return null;
      var want = safeName(name);
      var d = team.ensureFactDoc(canvasId, { name: want });
      if (!d) return null;
      var dp = docPathsOf(p.dir, d);
      /* 记录里缺路径（手工建 / 迁移）→ 补全，保持配置与磁盘一致。 */
      if (
        str(d.file) !== dp.file ||
        str(d.reviewFile) !== dp.reviewFile ||
        str(d.name) !== dp.name
      ) {
        if (typeof team.updateFactDoc === "function")
          team.updateFactDoc(canvasId, d.id, {
            name: dp.name,
            file: dp.file,
            reviewFile: dp.reviewFile,
          });
      }
      return ensureDoc(dp).then(function () {
        return dp;
      });
    });
  }
  /* 重命名单篇文档：改磁盘文件名（md + sidecar，主进程校验目录）再改配置记录。
     返回 Promise<{ok, doc, error?}>。 */
  function renameDoc(canvasId, docId, newName) {
    return Promise.resolve().then(function () {
      var team = window.MTNodeTeam;
      var lib = libOf(canvasId);
      if (!lib || !team || typeof team.factDoc !== "function")
        return { ok: false, error: T("事实库未就绪") };
      var doc = team.factDoc(canvasId, docId);
      if (!doc) return { ok: false, error: T("文档不存在") };
      var p = pathsOf(lib);
      var dp = p ? docPathsOf(p.dir, doc) : null;
      var name = safeName(newName);
      if (dp && name === dp.name) return { ok: true, doc: doc };
      var a = api();
      if (!dp || !a || typeof a.factRenameLibrary !== "function")
        return { ok: false, error: T("无法重命名") };
      return Promise.resolve(a.factRenameLibrary({ file: dp.file, name: name })).then(
        function (r) {
          if (!r || r.ok === false)
            return { ok: false, error: str(r && r.error) || T("无法重命名") };
          var newFile = str(r.file) || dp.file;
          var next = team.updateFactDoc(canvasId, doc.id, {
            name: name,
            file: newFile,
            reviewFile: joinPath(dirNameOf(newFile) || p.dir, name + ".review.json"),
          });
          return { ok: true, doc: next || doc };
        },
        function (err) {
          return { ok: false, error: String((err && err.message) || err) };
        },
      );
    });
  }
  /* 删单篇文档：先把磁盘上的 md + sidecar 搬进系统回收站（主进程路径守卫，可在资源管理器还原），
     再从配置摘掉这篇记录。共享 assets/ 的回收由主进程在「库内已无其它文档」时处理
     （整库一起进回收站，见 main.js fact:removeLibrary）。 */
  function removeDoc(canvasId, docId) {
    return Promise.resolve().then(function () {
      var team = window.MTNodeTeam;
      var lib = libOf(canvasId);
      if (!lib || !team || typeof team.factDoc !== "function")
        return { ok: false, error: T("事实库未就绪") };
      var doc = team.factDoc(canvasId, docId);
      if (!doc) return { ok: false, error: T("文档不存在") };
      var p = pathsOf(lib);
      var dp = p ? docPathsOf(p.dir, doc) : null;
      var a = api();
      var del =
        dp && a && typeof a.factRemoveLibrary === "function"
          ? Promise.resolve(a.factRemoveLibrary({ file: dp.file }))
          : Promise.resolve({ ok: true });
      return del.then(
        function (r) {
          if (r && r.ok === false)
            return { ok: false, error: str(r.error) || T("无法删除") };
          if (typeof team.removeFactDoc === "function") team.removeFactDoc(canvasId, doc.id);
          return { ok: true, doc: doc };
        },
        function (err) {
          return { ok: false, error: String((err && err.message) || err) };
        },
      );
    });
  }

  /* 删整库：先把整个「团队事实库」目录搬进系统回收站（正文 / 批注 / 插图一并进回收站，
     可在资源管理器还原），再摘掉画布锚点上的库记录。返回 Promise<{ok, error?}>。 */
  function removeLibrary(canvasId) {
    return Promise.resolve().then(function () {
      var team = window.MTNodeTeam;
      var lib = libOf(canvasId);
      if (!lib || !team || typeof team.removeFact !== "function")
        return { ok: false, error: T("事实库未就绪") };
      var p = pathsOf(lib);
      var dir = p && p.dir ? p.dir : "";
      var a = api();
      var del =
        dir && a && typeof a.factRemoveLibrary === "function"
          ? Promise.resolve(a.factRemoveLibrary({ dir: dir }))
          : Promise.resolve({ ok: true });
      return del.then(
        function (r) {
          if (r && r.ok === false)
            return { ok: false, error: str(r && r.error) || T("无法删除") };
          team.removeFact(canvasId);
          return { ok: true, dir: dir };
        },
        function (err) {
          return { ok: false, error: String((err && err.message) || err) };
        },
      );
    });
  }

  /* ───────────────────────── 自动登记（专家直接写盘的新文档） ───────────────────────── */

  /* 扫库目录，把配置里没有记录的 .md 登记进库（缺库记录时先建库）。
     返回 Promise<{ added }>：added = 本次新增的文档数；幂等，重复调用第二次为 0。
     边界：只登记新增，不删 / 不覆盖已有记录，不改文件正文；跳过 assets/ 与 *.review.json。 */
  function reconcile(canvasId) {
    return Promise.resolve().then(function () {
      var id = str(canvasId);
      var a = api();
      var team = window.MTNodeTeam;
      if (!id || !team || !a || typeof a.fileListDir !== "function")
        return { added: 0 };
      var lib = libOf(id);
      var known = lib ? pathsOf(lib) : null;
      var dirReady =
        known && known.dir
          ? Promise.resolve(known.dir)
          : resolvePaths(id, { silent: true }).then(function (p) {
              return p && p.dir ? p.dir : "";
            });
      return dirReady.then(function (dir) {
        dir = str(dir);
        if (!dir) return { added: 0 };
        return Promise.resolve(a.fileListDir(dir)).then(
          function (r) {
            var list = r && r.ok !== false && Array.isArray(r.list) ? r.list : [];
            var mds = list.filter(function (it) {
              if (!it || it.isDir) return false;
              var rel = str(it.rel).replace(/\\/g, "/");
              if (!/\.md$/i.test(rel)) return false;
              if (/(^|\/)assets\//i.test(rel)) return false;
              return true;
            });
            if (!mds.length) return { added: 0 };
            /* 库记录本身都可能缺（专家在目录里直接建档）→ 先建库，落盘即生成对应 json。 */
            if (!team.fact(id)) {
              if (typeof team.ensureFact !== "function") return { added: 0 };
              if (typeof team.ensureCanvas === "function")
                team.ensureCanvas({ id: id });
              team.ensureFact(id, {
                name: baseNameOf(dir) || T("事实库"),
                dir: dir,
                assetsDir: joinPath(dir, "assets"),
              });
            }
            var cur = team.fact(id);
            if (!cur || typeof team.ensureFactDoc !== "function")
              return { added: 0 };
            var cp = pathsOf(cur);
            var seenFiles = {};
            var seenNames = {};
            ((cp && cp.docs) || []).forEach(function (d) {
              seenFiles[pathKey(d.file)] = true;
              seenNames[str(d.name)] = true;
            });
            var added = 0;
            mds.forEach(function (it) {
              var rel = str(it.rel).replace(/\\/g, "/");
              var file = joinPath(dir, rel);
              var name = safeName(stripExt(baseNameOf(rel)));
              /* 已有同路径记录，或已有同名文档（不抢已有记录）→ 跳过。 */
              if (seenFiles[pathKey(file)] || seenNames[name]) return;
              var fdir = dirNameOf(file) || dir;
              var d = team.ensureFactDoc(id, {
                name: name,
                file: file,
                reviewFile: joinPath(fdir, name + ".review.json"),
              });
              if (!d) return;
              seenFiles[pathKey(file)] = true;
              seenNames[str(d.name)] = true;
              added++;
            });
            return { added: added };
          },
          function () {
            return { added: 0 };
          },
        );
      });
    });
  }

  /* ───────────────────────── 读写 ───────────────────────── */

  function fileExists(p) {
    var a = api();
    if (!p || !a || typeof a.fileExists !== "function") return Promise.resolve(false);
    return Promise.resolve(a.fileExists(p)).then(
      function (r) {
        return !!r;
      },
      function () {
        return false;
      },
    );
  }

  /* 读正文：文件不存在时返回空串（exists=false），由调用方决定是否写模板。 */
  function readDoc(fact) {
    var a = api();
    var p = str(fact && fact.file);
    if (!p || !a || typeof a.fileReadText !== "function")
      return Promise.resolve({ ok: false, exists: false, content: "" });
    return Promise.resolve(a.fileReadText(p)).then(
      function (r) {
        return {
          ok: !!(r && r.ok !== false),
          exists: !!(r && r.exists),
          content: str(r && r.content),
        };
      },
      function (err) {
        return { ok: false, exists: false, content: "", error: String((err && err.message) || err) };
      },
    );
  }

  /* 落盘成功后广播：左侧栏文档行按 file 刷新字数（每次保存都更新）。 */
  function notifySaved(file) {
    var p = str(file);
    if (!p) return;
    try {
      if (typeof document === "undefined" || !document.dispatchEvent) return;
      var detail = { file: p };
      var ev = null;
      try {
        ev = new CustomEvent("factlib:saved", { detail: detail });
      } catch (_) {
        if (typeof document.createEvent === "function") {
          ev = document.createEvent("CustomEvent");
          ev.initCustomEvent("factlib:saved", false, false, detail);
        }
      }
      if (ev) document.dispatchEvent(ev);
    } catch (_) {}
  }

  function writeDoc(fact, content) {
    var a = api();
    var p = str(fact && fact.file);
    if (!p || !a || typeof a.fileWriteText !== "function") return Promise.resolve(false);
    return Promise.resolve(a.fileWriteText(p, str(content))).then(
      function (r) {
        var ok = !!(r && r.ok !== false);
        if (ok) notifySaved(p);
        return ok;
      },
      function () {
        return false;
      },
    );
  }

  /* 首次创建写模板（已存在则原样保留，绝不覆盖用户内容）。 */
  function ensureDoc(fact) {
    return fileExists(str(fact && fact.file)).then(function (has) {
      if (has) return false;
      return writeDoc(fact, TEMPLATE);
    });
  }

  /* sidecar 审阅记录（app-review.js 的版本链 / notesLog / voided）。 */
  function readReview(fact) {
    var a = api();
    var p = str(fact && fact.reviewFile) || (pathsOf(fact) || {}).reviewFile;
    if (!p || !a || typeof a.fileReadText !== "function") return Promise.resolve(null);
    return Promise.resolve(a.fileReadText(p)).then(
      function (r) {
        if (!r || !r.exists) return null;
        try {
          var j = JSON.parse(str(r.content) || "null");
          return j && typeof j === "object" ? j : null;
        } catch (e) {
          return null;
        }
      },
      function () {
        return null;
      },
    );
  }
  function writeReview(fact, obj) {
    var a = api();
    var p = str(fact && fact.reviewFile) || (pathsOf(fact) || {}).reviewFile;
    if (!p || !a || typeof a.fileWriteText !== "function") return Promise.resolve(false);
    return Promise.resolve(
      a.fileWriteText(p, JSON.stringify(obj && typeof obj === "object" ? obj : {}, null, 2)),
    ).then(
      function (r) {
        return !!(r && r.ok !== false);
      },
      function () {
        return false;
      },
    );
  }

  /* 建库：不存在则解析路径 + 落配置 + 建首篇文档（沿用模板）；已建好则原样返回（幂等）。
     库内后续文档由 ensureDocByName / 专家建档新增。 */
  function ensureLibrary(canvasId, over) {
    return Promise.resolve().then(function () {
      var team = window.MTNodeTeam;
      if (!team || typeof team.fact !== "function") return null;
      var existing = team.fact(canvasId);
      var exPaths = existing ? pathsOf(existing) : null;
      if (existing && exPaths && exPaths.docs.length) return existing;
      var docName = safeName((over && over.docName) || (over && over.name) || T("事实库"));
      var libName =
        str(over && over.libName).trim() ||
        str(existing && existing.name).trim() ||
        T("事实库");
      return resolvePaths(canvasId, { name: docName, libName: libName }).then(function (paths) {
        /* 用户取消目录选择 / 解析结果落在应用目录内 → 建库失败（不落配置、不猜路径）。 */
        if (!paths || !paths.dir) return null;
        var patch = { name: libName, dir: paths.dir, assetsDir: paths.assetsDir };
        /* 记录已存在但缺路径（旧配置 / 手工改坏）→ 补路径；否则新建。 */
        var f = existing
          ? team.updateFact(canvasId, patch)
          : team.ensureFact(canvasId, Object.assign({}, over || {}, patch));
        if (!f) return null;
        var d =
          typeof team.ensureFactDoc === "function"
            ? team.ensureFactDoc(canvasId, {
                name: docName,
                file: paths.file,
                reviewFile: paths.reviewFile,
              })
            : null;
        var dp = d
          ? docPathsOf(paths.dir, d)
          : { name: docName, file: paths.file, reviewFile: paths.reviewFile };
        return ensureDoc(dp).then(function () {
          return team.fact(canvasId) || f;
        });
      });
    });
  }

  /* 统计：正文行数 / 正文字符数 + 磁盘 mtime（左侧文档行展示用）。
     文档行只显示更新时间，取 max(配置 updatedAt, mtime)；mtime 走 api.fileStat，
     这样专家用文件工具直接写盘（不经 writeDoc）也能反映到更新时间。 */
  function statsOf(doc) {
    var p = str(doc && doc.file);
    return readDoc(doc).then(function (r) {
      var text = r.content || "";
      var body = text.replace(/!\[[^\]]*\]\([^)]+\)/g, "");
      var base = {
        chars: body.replace(/\s+/g, "").length,
        lines: text ? text.split(/\r?\n/).length : 0,
        exists: !!r.exists,
        mtime: 0,
      };
      var a = api();
      if (!p || !a || typeof a.fileStat !== "function") return base;
      return Promise.resolve(a.fileStat(p)).then(
        function (st) {
          base.mtime = st && st.ok ? Math.floor(Number(st.mtime) || 0) : 0;
          return base;
        },
        function () {
          return base;
        },
      );
    });
  }

  /* 删除（removeDoc 单篇 / removeLibrary 整库）只负责「先搬进系统回收站、再摘配置」，
     左栏入口见 app-teamview.js（✕ 按钮 + 确认弹窗），主进程守卫见 main.js fact:removeLibrary。 */

  var API = {
    TEMPLATE: TEMPLATE,
    T: T,
    joinPath: joinPath,
    dirNameOf: dirNameOf,
    baseNameOf: baseNameOf,
    stripExt: stripExt,
    isAbs: isAbs,
    safeName: safeName,
    resolvePaths: resolvePaths,
    docPathsOf: docPathsOf,
    pathsOf: pathsOf,
    misplacedReason: misplacedReason,
    pickCanvasFolder: pickCanvasFolder,
    libOf: libOf,
    listDocs: listDocs,
    ensureDocByName: ensureDocByName,
    renameDoc: renameDoc,
    removeDoc: removeDoc,
    removeLibrary: removeLibrary,
    reconcile: reconcile,
    relocateLibrary: relocateLibrary,
    fileExists: fileExists,
    readDoc: readDoc,
    writeDoc: writeDoc,
    ensureDoc: ensureDoc,
    readReview: readReview,
    writeReview: writeReview,
    ensureLibrary: ensureLibrary,
    statsOf: statsOf,
  };

  window.MTNodeFactLib = API;

  /* 全局别名：同层脚本可直接调用。 */
  window.factlibPaths = resolvePaths;
  window.factlibPathsOf = pathsOf;
  window.factlibDocPaths = docPathsOf;
  window.factlibListDocs = listDocs;
  window.factlibEnsureDoc = ensureDocByName;
  window.factlibRenameDoc = renameDoc;
  window.factlibRemoveDoc = removeDoc;
  window.factlibRemoveLib = removeLibrary;
  window.factlibReconcile = reconcile;
  window.factlibRelocate = relocateLibrary;
  window.factlibRead = readDoc;
  window.factlibWrite = writeDoc;
  window.factlibEnsure = ensureLibrary;
  window.factlibStats = statsOf;
})();
