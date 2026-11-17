"""缓存：key 公式、index.json、原子写、2 GiB + 30 天 LRU、孤儿清理。

key（唯一实现，service-contract §9.1）：

    optionsHash = sha256(canonical_json(归一化 options))        # 不含 cache 模式
    key         = sha256("mtnode.audio.analyze|1.0.0|" + realpath + "|" +
                         sizeBytes + "|" + mtimeMs + "|" + optionsHash)[:32]

* `realpath` 进键：不同目录下同 size + 同 mtime 的文件不会撞键；
* `mtimeMs = st_mtime_ns // 1_000_000`（取整到毫秒，避免 NTFS 抖动出两个键）；
* 落盘布局：`cache/<key>/analysis.json` + `artifacts/<key16>/<kind>.png`，**同生同灭**：
  先写 `<name>.tmp-<pid>/` 再 os.replace 成正式目录。

全部注释与消息为中文。
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import threading
import time

from . import contract

_EPS = 1e-9


def canonical_json(obj) -> str:
    """规范化 JSON（键排序、无多余空白、UTF-8 保真）。"""
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def options_hash(normalized_options: dict) -> str:
    """只含影响结果的选项（cache 模式不参与）。"""
    return hashlib.sha256(canonical_json(normalized_options).encode("utf-8")).hexdigest()


def key_for(real_path: str, size: int, mtime_ms: int, opt_hash: str) -> str:
    """缓存键（32 hex）。"""
    raw = "|".join((contract.SERVICE_NAME, contract.VERSION, real_path,
                    str(int(size)), str(int(mtime_ms)), opt_hash))
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:32]


class Cache:
    """缓存目录的读写与清扫（进程内单例，serve.py 启动时建一次）。"""

    def __init__(self, root: str):
        self.root = os.path.abspath(root)
        self.cache_dir = os.path.join(self.root, "cache")
        self.artifacts_dir = os.path.join(self.root, "artifacts")
        self.index_path = os.path.join(self.cache_dir, "index.json")
        self._lock = threading.RLock()
        self._dirty = False
        os.makedirs(self.cache_dir, exist_ok=True)
        os.makedirs(self.artifacts_dir, exist_ok=True)
        self.index: dict[str, dict] = self._load_index()
        self.sweep()

    # ------------------------------------------------------------ 索引

    def _load_index(self) -> dict:
        try:
            with open(self.index_path, "r", encoding="utf-8") as fh:
                data = json.load(fh)
            if isinstance(data, dict) and isinstance(data.get("entries"), dict):
                return {str(k): v for k, v in data["entries"].items() if isinstance(v, dict)}
            if isinstance(data, dict):
                return {str(k): v for k, v in data.items() if isinstance(v, dict)}
        except Exception:
            pass
        return {}

    def _flush_index(self) -> None:
        """原子写 index.json（tmp → os.replace）。"""
        payload = {"version": 1, "entries": self.index,
                   "updatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
        tmp = self.index_path + ".tmp-%d" % os.getpid()
        try:
            with open(tmp, "w", encoding="utf-8") as fh:
                json.dump(payload, fh, ensure_ascii=False)
                fh.flush()
                os.fsync(fh.fileno())
            os.replace(tmp, self.index_path)
            self._dirty = False
        except Exception:
            try:
                os.unlink(tmp)
            except Exception:
                pass

    def counts(self) -> tuple[int, int]:
        with self._lock:
            return len(self.index), int(sum(int(v.get("bytes") or 0) for v in self.index.values()))

    def artifact_count(self) -> int:
        try:
            return sum(1 for name in os.listdir(self.artifacts_dir)
                       if os.path.isdir(os.path.join(self.artifacts_dir, name)))
        except Exception:
            return 0

    # ------------------------------------------------------------ 读

    def entry(self, key: str) -> dict | None:
        with self._lock:
            item = self.index.get(key)
            if not item:
                return None
            item["lastUsedAt"] = _now_iso()
            self._dirty = True
            return dict(item)

    def read_result(self, key: str) -> dict | None:
        """读 analysis.json（不存在回 None）。"""
        path = os.path.join(self.cache_dir, key, "analysis.json")
        try:
            with open(path, "r", encoding="utf-8") as fh:
                data = json.load(fh)
            return data if isinstance(data, dict) else None
        except Exception:
            return None

    def artifacts_exist(self, key16: str, kinds) -> bool:
        """请求的图种是否都已在 artifacts 里（缺一张就要重算）。"""
        base = os.path.join(self.artifacts_dir, key16)
        for kind in kinds:
            if not os.path.isfile(os.path.join(base, "%s.png" % kind)):
                return False
        return True

    # ------------------------------------------------------------ 写

    def write(self, key: str, body: dict, source: dict, opt_hash: str,
              pngs: dict[str, bytes]) -> bool:
        """写缓存条目（analysis.json + PNG 同生同灭）。返回是否落盘成功。"""
        payload = json.dumps(body, ensure_ascii=False).encode("utf-8")
        total = len(payload) + sum(len(v) for v in pngs.values())
        if total > contract.CACHE_MAX_ENTRY_BYTES:
            return False
        key16 = key[:16]
        pid = os.getpid()
        cache_tmp = os.path.join(self.cache_dir, "%s.tmp-%d" % (key, pid))
        art_tmp = os.path.join(self.artifacts_dir, "%s.tmp-%d" % (key16, pid))
        try:
            shutil.rmtree(cache_tmp, ignore_errors=True)
            os.makedirs(cache_tmp, exist_ok=True)
            with open(os.path.join(cache_tmp, "analysis.json"), "wb") as fh:
                fh.write(payload)
                fh.flush()
                os.fsync(fh.fileno())
            if pngs:
                shutil.rmtree(art_tmp, ignore_errors=True)
                os.makedirs(art_tmp, exist_ok=True)
                for kind, data in pngs.items():
                    with open(os.path.join(art_tmp, "%s.png" % kind), "wb") as fh:
                        fh.write(data)
            # 先落图再落数据：反过来会出现「有数据没图」
            if pngs:
                target_art = os.path.join(self.artifacts_dir, key16)
                shutil.rmtree(target_art, ignore_errors=True)
                os.replace(art_tmp, target_art)
            target = os.path.join(self.cache_dir, key)
            shutil.rmtree(target, ignore_errors=True)
            os.replace(cache_tmp, target)
        except Exception:
            shutil.rmtree(cache_tmp, ignore_errors=True)
            shutil.rmtree(art_tmp, ignore_errors=True)
            return False
        now = _now_iso()
        with self._lock:
            self.index[key] = {
                "bytes": total,
                "createdAt": now,
                "lastUsedAt": now,
                "source": {"path": source.get("path", ""), "size": source.get("size", 0),
                           "mtimeMs": source.get("mtimeMs", 0)},
                "optionsHash": opt_hash,
            }
            self._dirty = True
            self._flush_index()
        self.sweep()
        return True

    def touch(self) -> None:
        """把内存里的 lastUsedAt 变化落盘（命中缓存后调用）。"""
        with self._lock:
            if self._dirty:
                self._flush_index()

    # ------------------------------------------------------------ 清扫

    def sweep(self) -> dict:
        """2 GiB + 30 天 LRU；顺手清孤儿目录与索引里指向已消失目录的条目。"""
        removed = 0
        freed = 0
        now = time.time()
        with self._lock:
            # 1) 索引有、目录没了 → 删条目
            for key in list(self.index.keys()):
                if not os.path.isdir(os.path.join(self.cache_dir, key)):
                    self.index.pop(key, None)
                    removed += 1
            # 2) 超 30 天
            for key, item in list(self.index.items()):
                last = _parse_iso(item.get("lastUsedAt") or item.get("createdAt"))
                if last is not None and now - last > contract.CACHE_TTL_SEC:
                    freed += int(item.get("bytes") or 0)
                    self._drop(key)
                    removed += 1
            # 3) 超容量：按 lastUsedAt 从旧到新淘汰
            total = int(sum(int(v.get("bytes") or 0) for v in self.index.values()))
            if total > contract.CACHE_MAX_BYTES:
                ordered = sorted(self.index.items(),
                                 key=lambda kv: _parse_iso(kv[1].get("lastUsedAt")) or 0.0)
                for key, item in ordered:
                    if total <= contract.CACHE_MAX_BYTES:
                        break
                    total -= int(item.get("bytes") or 0)
                    freed += int(item.get("bytes") or 0)
                    self._drop(key)
                    removed += 1
            # 4) 孤儿：目录有、索引没有（崩溃残留 / 临时目录）
            try:
                names = os.listdir(self.cache_dir)
            except Exception:
                names = []
            for name in names:
                path = os.path.join(self.cache_dir, name)
                if not os.path.isdir(path):
                    continue
                if ".tmp-" in name:
                    shutil.rmtree(path, ignore_errors=True)
                    continue
                if name not in self.index:
                    shutil.rmtree(path, ignore_errors=True)
                    removed += 1
            try:
                art_names = os.listdir(self.artifacts_dir)
            except Exception:
                art_names = []
            live = {k[:16] for k in self.index.keys()}
            for name in art_names:
                path = os.path.join(self.artifacts_dir, name)
                if not os.path.isdir(path):
                    continue
                if ".tmp-" in name or name not in live:
                    shutil.rmtree(path, ignore_errors=True)
            if removed or self._dirty:
                self._flush_index()
        return {"removed": removed, "freedBytes": freed}

    def _drop(self, key: str) -> None:
        """删一条缓存（目录 + 图 + 索引项）。"""
        self.index.pop(key, None)
        shutil.rmtree(os.path.join(self.cache_dir, key), ignore_errors=True)
        shutil.rmtree(os.path.join(self.artifacts_dir, key[:16]), ignore_errors=True)

    def close(self) -> None:
        with self._lock:
            if self._dirty:
                self._flush_index()


def _now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def _parse_iso(text) -> float | None:
    """ISO-8601（Z）→ epoch 秒；解析不了回 None。"""
    if not text or not isinstance(text, str):
        return None
    s = text.strip().replace("Z", "+00:00")
    try:
        import datetime
        return datetime.datetime.fromisoformat(s).timestamp()
    except Exception:
        return None


def stat_of(path: str) -> dict:
    """源文件 stat 快照（缓存键与「分析期间被改」判定都用它）。"""
    st = os.stat(path)
    return {
        "path": os.path.realpath(path),
        "size": int(st.st_size),
        "mtimeMs": int(st.st_mtime_ns // 1_000_000),
    }


def same_stat(a: dict, b: dict) -> bool:
    return (int(a.get("size") or 0) == int(b.get("size") or 0)
            and int(a.get("mtimeMs") or 0) == int(b.get("mtimeMs") or 0)
            and a.get("path") == b.get("path"))
