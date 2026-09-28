/* store.js — 内容落盘的脚手架：脏标记 + 防抖自动存盘 + 关闭前强制冲刷
 *
 * 用法（app.js 里三步）：
 *   var store = Store.create({ host: AppHost, file: "data.json", debounceMs: 400 });
 *   store.set(state)            // 改完就喊一声（内部标脏 + 防抖写盘）
 *   await store.load()          // 启动时读回来；store.data 就是盘上那份
 *   store.flush()               // 想立刻写盘时手动调（换文件夹 / 点保存按钮）
 *
 * 纪律：
 *  - 写盘只走宿主（appHost.dataWrite / storageSet）；没有宿主就退化成内存态，
 *    `store.persisted === false`，界面必须**明确告诉用户「本次数据不会保存」**，不许假装成功。
 *  - 宿主调用是异步的，所以「关窗前冲刷」由 close.js 统一 await；这里只保证
 *    flush() 返回的 Promise 跑完时盘上是最新的那一份。
 */
(function () {
  "use strict";

  function isFn(v) {
    return typeof v === "function";
  }

  function create(opts) {
    var o = opts && typeof opts === "object" ? opts : {};
    var H = o.host || null;
    var file = String(o.file || "data.json");
    var debounceMs = Math.max(0, Number(o.debounceMs) || 400);
    /* 两种宿主接口都认：应用窗口的 dataRead/dataWrite（整份数据），
       插件窗口的 dataGet/dataSet（整份对象）—— 老应用不用改写 */
    var canRead = !!(H && (isFn(H.dataRead) || isFn(H.dataGet)));
    var canWrite = !!(H && (isFn(H.dataWrite) || isFn(H.dataSet)));

    var st = {
      data: o.initial && typeof o.initial === "object" ? o.initial : {},
      persisted: canRead && canWrite,
      dirty: false,
      saving: false,
      lastError: "",
      lastSavedAt: 0,
      hooks: [],
    };
    var timer = null;
    var inflight = null;

    function note(ev, arg) {
      for (var i = 0; i < st.hooks.length; i++) {
        try {
          st.hooks[i](ev, arg);
        } catch (e) {
          /* 观察者自己炸了不能拖垮存盘 */
        }
      }
    }

    async function read() {
      if (!canRead) return { ok: false, error: "no_host" };
      try {
        var r = isFn(H.dataRead) ? await H.dataRead({ file: file }) : await H.dataGet();
        if (!r || r.ok === false) return { ok: false, error: (r && r.error) || "read_failed" };
        var d = isFn(H.dataRead) ? r.data : r.data;
        return { ok: true, data: d && typeof d === "object" ? d : {}, migrated: !!r.migrated };
      } catch (e) {
        return { ok: false, error: String((e && e.message) || e) };
      }
    }

    async function write(data) {
      if (!canWrite) return { ok: false, error: "no_host" };
      try {
        var r;
        if (isFn(H.dataWrite)) r = await H.dataWrite(data, { file: file });
        else r = await H.dataSet(data);
        if (!r) return { ok: false, error: "write_failed" };
        return { ok: !!(r.ok !== false), error: r.error || "" };
      } catch (e) {
        return { ok: false, error: String((e && e.message) || e) };
      }
    }

    var api = {
      get data() {
        return st.data;
      },
      get persisted() {
        return st.persisted;
      },
      get dirty() {
        return st.dirty;
      },
      get lastError() {
        return st.lastError;
      },
      get lastSavedAt() {
        return st.lastSavedAt;
      },
      /** 改动登记：替换整份数据并标脏（防抖后自动写盘） */
      set: function (data) {
        if (data && typeof data === "object") st.data = data;
        st.dirty = true;
        note("dirty", st.data);
        if (timer) clearTimeout(timer);
        if (!debounceMs) {
          api.flush();
          return;
        }
        timer = setTimeout(function () {
          timer = null;
          api.flush();
        }, debounceMs);
      },
      /** 立即写盘（同一时刻只允许一发在飞；飞完发现又脏了会再补一发） */
      flush: async function () {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        if (!st.dirty) return { ok: true, skipped: true };
        if (!canWrite) {
          st.dirty = false;
          st.lastError = "no_host";
          note("fail", st.lastError);
          return { ok: false, error: "no_host" };
        }
        if (st.saving) return inflight || { ok: false, error: "busy" };
        st.saving = true;
        st.dirty = false;
        inflight = (async function () {
          var r = await write(st.data);
          st.saving = false;
          if (r.ok) {
            st.lastSavedAt = Date.now();
            st.lastError = "";
            note("saved", st.data);
          } else {
            st.dirty = true; /* 没写成功就还是脏的，下一轮/关窗前还会再试 */
            st.lastError = r.error || "write_failed";
            note("fail", st.lastError);
          }
          return r;
        })();
        var out = await inflight;
        inflight = null;
        if (st.dirty && !timer) {
          /* 写盘期间又改了：再补一发（不递归太深，只补一次） */
          api.flush();
        }
        return out;
      },
      /** 启动时读回来：盘上有就用盘上的，没有就保留 initial */
      load: async function () {
        var r = await read();
        if (r.ok) {
          if (r.data && Object.keys(r.data).length) st.data = r.data;
          st.dirty = false;
          st.lastError = "";
        } else {
          st.lastError = r.error || "";
          note("fail", st.lastError);
        }
        note("loaded", { ok: r.ok, migrated: !!r.migrated, data: st.data });
        return r;
      },
      /** 迁到别处 / 换数据文件夹之后，把当前内存态重新认成「盘上那份」 */
      reset: function (data) {
        st.data = data && typeof data === "object" ? data : {};
        st.dirty = false;
      },
      /** 观察者：ev = loaded | dirty | saved | fail，返回退订函数 */
      on: function (fn) {
        if (!isFn(fn)) return function () {};
        st.hooks.push(fn);
        return function () {
          var i = st.hooks.indexOf(fn);
          if (i >= 0) st.hooks.splice(i, 1);
        };
      },
    };
    return api;
  }

  window.Store = { create: create };
})();