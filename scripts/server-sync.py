#!/usr/bin/env python3
"""把云服务器（mt-agent.com）的内容单向拉回本地镜像。

方向：**服务器 → 本地**，本地永不回写服务器（本脚本只做 get / listdir / 只读 exec）。

口径（与 scripts/SERVER-SYNC.md 同一份共识）：
  · 差异增量：按远端目录树逐级列举，只下载「大小不同 / mtime 不同 / 本地缺失」的文件；
    索引落在 <ROOT>/_sync/index.json，删掉索引 = 下次全量重扫一遍。
  · 删除安全：服务器上已不存在的文件**不直接删**，移进 <ROOT>/.sync-trash/<时间戳>/（可手工取回）。
  · 时间戳：本地文件写服务器原 mtime。
  · 留痕：<ROOT>/_sync/manifest.json（本次条目与字节数）+ <ROOT>/_sync/sync.log（追加日志）。
  · 敏感值：按用户明确要求**原样拉取**（/etc/mtnode-store.env 含支付 / 微信 / 中转上游密钥），
    所以镜像根目录本身即敏感 —— 不要放进任何仓库或同步盘。
  · 仓库只比对不写入：--compare-repo 把线上 /opt/mtnode-store 与仓库 store-saas/ 逐文件比哈希，
    差异只进清单与日志（默认开启）。

用法：
  python scripts/server-sync.py --dry-run              # 预览：只说会做什么，不落任何文件
  python scripts/server-sync.py                        # 全量增量同步
  python scripts/server-sync.py --only store,www       # 只同步其中几项
  python scripts/server-sync.py --list                 # 列出目标名
  python scripts/server-sync.py --root D:\\somewhere    # 换镜像根目录

凭据：MTNODE_SFTP_JSON（优先）→ 默认 E:\\dev\\tools\\ssh\\sftp-mtnode-store.json；
      其次 MTNODE_SSH_HOST + MTNODE_SSH_USER + MTNODE_SSH_PASSWORD/KEY。
依赖：paramiko（本机已装 5.0.0）。
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import posixpath
import shutil
import stat as statmod
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

try:
    import paramiko
except ImportError:  # pragma: no cover
    sys.exit("需要 paramiko：pip install paramiko")

# ---------------------------------------------------------------- 常量 / 目标表

DEFAULT_SFTP = Path(r"E:\dev\tools\ssh\sftp-mtnode-store.json")
DEFAULT_ROOT = Path(r"Z:\Dev\mtnode-aio")
REPO_ROOT = Path(__file__).resolve().parent.parent

# 服务器上要拉的目标。code = --only 用的短名；dirs 为空 = 只光秃秃拉这一层文件。
TARGETS = [
    {
        "code": "store",
        "aliases": ["mtnode-store", "/opt/mtnode-store"],
        "remote": "/opt/mtnode-store",
        "local": "store",
        "dirs": ["."],  # 整目录递归（含 rollback/ backup-*/ *.bak-* 历史备份）
        "desc": "/opt/mtnode-store 服务端代码 + data/（db.json、apps、skills、files、forum-images…）",
    },
    {
        "code": "www",
        "aliases": ["var-www-mtnode", "/var/www/mtnode"],
        "remote": "/var/www/mtnode",
        "local": "www",
        "dirs": ["."],
        "desc": "/var/www/mtnode 静态站与分发包（admin/apps/assets/downloads/ext/h3/music3/pay-done/plugins）",
    },
    {
        "code": "nginx",
        "aliases": ["sites-available", "/etc/nginx/sites-available"],
        "remote": "/etc/nginx/sites-available",
        "local": "nginx/sites-available",
        "dirs": ["."],
        "desc": "/etc/nginx/sites-available 站点配置（含 .bak-*）",
    },
    {
        "code": "units",
        "aliases": ["systemd", "/etc/systemd/system"],
        "remote": "/etc/systemd/system",
        "local": "systemd",
        "dirs": [],  # 只挑白名单 unit，不递归
        "files": [
            "mtnode-store.service",
            "mt-ai-router.service",
            "mt-teach.service",
            "mt-ai-router-mongod.service",
        ],
        "desc": "/etc/systemd/system 白名单 unit（mtnode-store / mt-ai-router / mt-teach / mt-ai-router-mongod）",
    },
]

# /etc/nginx/ssl：只登记证书材料（文件名 + 有效期），**不拉私钥**
SSL_TARGET = {
    "code": "ssl",
    "aliases": ["nginx-ssl", "/etc/nginx/ssl"],
    "remote": "/etc/nginx/ssl",
    "desc": "/etc/nginx/ssl 目录登记（文件名 + openssl 有效期，仅登记不下载私钥）",
}

# 仓库副本比对：镜像里的路径 → 仓库里同源的开发目录
SOURCES = {
    "store": REPO_ROOT / "store-saas",
}

UNIT_ALIASES = {"unit": "units", "systemd-units": "units", "service": "units",
                "web": "www", "html": "www", "sites": "nginx", "all": "*"}


# ---------------------------------------------------------------- 基础工具


def force_utf8() -> None:
    """控制台 / 重定向都按 utf-8 出字，避免管道里中文变乱码。"""
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass


def out(msg: str = "") -> None:
    try:
        print(msg, flush=True)
    except UnicodeEncodeError:  # 老控制台代码页兜底
        enc = sys.stdout.encoding or "utf-8"
        print(msg.encode(enc, "replace").decode(enc, "replace"), flush=True)


def now_local() -> datetime:
    return datetime.now().astimezone()


def stamp() -> str:
    return now_local().strftime("%Y%m%d-%H%M%S")


def human(n: int) -> str:
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024 or unit == "GB":
            return f"{n:.1f}{unit}" if unit != "B" else f"{n}B"
        n /= 1024.0
    return f"{n:.1f}GB"


def norm_dt(v) -> float:
    return round(float(v), 3)


def fmt_dt(v) -> str:
    try:
        return datetime.fromtimestamp(float(v)).strftime("%Y-%m-%d %H:%M:%S")
    except Exception:
        return "-"


class Logger:
    """控制台 + 追加日志文件双写。"""

    def __init__(self, path: Path | None, echo: bool = True):
        self.path = path
        self.echo = echo
        self.lines: list[str] = []
        if path:
            path.parent.mkdir(parents=True, exist_ok=True)

    def __call__(self, msg: str = "") -> None:
        if self.echo:
            out(msg)
        self.lines.append(msg)

    def flush(self) -> None:
        if not self.path or not self.lines:
            return
        with self.path.open("a", encoding="utf-8") as fh:
            fh.write("\n".join(self.lines) + "\n")

    def note(self, msg: str) -> None:
        """只进日志不刷屏（用于逐文件进度）。"""
        self.lines.append(msg)


# ---------------------------------------------------------------- 连接


def load_cfg() -> dict:
    """凭据口径与 scripts/deploy-ssl.py / store-saas/upload.py 同源，只是默认路径换成新文件。"""
    env_path = os.environ.get("MTNODE_SFTP_JSON", "").strip()
    candidates = ([Path(env_path)] if env_path else []) + [DEFAULT_SFTP]
    for p in candidates:
        if p.is_file():
            cfg = json.loads(p.read_text(encoding="utf-8"))
            key = cfg.get("privateKey") or cfg.get("identityFile") or ""
            if key and not Path(key).is_file():
                rel = p.parent / key  # 相对凭据档所在目录
                key = str(rel if rel.is_file() else key)
            return {
                "host": cfg.get("host"),
                "port": int(cfg.get("port") or 22),
                "username": cfg.get("username") or "root",
                "password": cfg.get("password") or "",
                "privateKey": key,
                "source": str(p),
            }
    host = os.environ.get("MTNODE_SSH_HOST", "").strip()
    if not host:
        sys.exit(
            "未找到 SFTP 配置。设置 MTNODE_SFTP_JSON，或 MTNODE_SSH_HOST + "
            "MTNODE_SSH_USER + MTNODE_SSH_PASSWORD/MTNODE_SSH_KEY"
        )
    return {
        "host": host,
        "port": int(os.environ.get("MTNODE_SSH_PORT") or 22),
        "username": os.environ.get("MTNODE_SSH_USER") or "root",
        "password": os.environ.get("MTNODE_SSH_PASSWORD") or "",
        "privateKey": os.environ.get("MTNODE_SSH_KEY") or "",
        "source": "环境变量 MTNODE_SSH_*",
    }


def connect(cfg: dict, timeout: int = 30):
    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    kw = {
        "hostname": cfg["host"],
        "port": cfg["port"],
        "username": cfg["username"],
        "timeout": timeout,
        "banner_timeout": timeout,
        "auth_timeout": timeout,
    }
    if cfg.get("privateKey"):
        kw["key_filename"] = cfg["privateKey"]
        if cfg.get("password"):
            kw["passphrase"] = cfg["password"]
    elif cfg.get("password"):
        kw["password"] = cfg["password"]
    else:
        sys.exit(f"凭据 {cfg['source']} 缺少 password 或 privateKey")
    c.connect(**kw)
    t = c.get_transport()
    if t:
        t.set_keepalive(30)
    return c


# ---------------------------------------------------------------- 远端列举


def list_remote(sftp, target: dict, log: Logger) -> dict:
    """返回 {远端绝对路径: {"size": int, "mtime": float}}。"""
    found: dict[str, dict] = {}

    def add_dir(d: str) -> bool:
        try:
            entries = sftp.listdir_attr(d)
        except IOError as e:
            log(f"    ! 无法列举 {d}：{e}")
            return False
        for a in entries:
            fp = posixpath.join(d, a.filename)
            if statmod.S_ISDIR(a.st_mode):
                if a.filename in (".", ".."):
                    continue
                # 软链目录不当目录递归（避免环）
                if statmod.S_ISLNK(a.st_mode):
                    log(f"    ! 跳过软链 {fp}")
                    continue
                add_dir(fp)
            elif statmod.S_ISREG(a.st_mode):
                found[fp] = {"size": int(a.st_size), "mtime": norm_dt(a.st_mtime)}
            else:
                log(f"    ! 跳过非普通文件 {fp}")
        return True

    for d in target.get("dirs") or []:
        add_dir(target["remote"] if d == "." else posixpath.join(target["remote"], d))
    for name in target.get("files") or []:
        fp = posixpath.join(target["remote"], name)
        try:
            a = sftp.stat(fp)
        except IOError:
            log(f"    ! 白名单文件不存在：{fp}")
            continue
        if statmod.S_ISREG(a.st_mode):
            found[fp] = {"size": int(a.st_size), "mtime": norm_dt(a.st_mtime)}
        else:
            log(f"    ! 白名单项不是普通文件：{fp}")
    return found


def remote_rel(target: dict, remote_path: str) -> str:
    rel = posixpath.relpath(remote_path, target["remote"])
    return "" if rel == "." else rel


def local_of(target: dict, rel: str) -> Path:
    base = target["_root"] / target["local"]
    return base if not rel else base / Path(*rel.split("/"))


# ---------------------------------------------------------------- 索引


def index_path(root: Path) -> Path:
    return root / "_sync" / "index.json"


def load_index(root: Path) -> dict:
    p = index_path(root)
    if not p.is_file():
        return {"ver": 1, "targets": {}}
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
    except Exception as e:
        out(f"! 索引读取失败（当作空索引重扫）：{e}")
        return {"ver": 1, "targets": {}}
    data.setdefault("targets", {})
    return data


def save_index(root: Path, idx: dict) -> None:
    p = index_path(root)
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(idx, ensure_ascii=False, indent=1), encoding="utf-8")
    os.replace(tmp, p)


# ---------------------------------------------------------------- 下载


def sha1_of(path: Path, limit: int | None = None) -> str:
    h = hashlib.sha1()
    with path.open("rb") as fh:
        while True:
            chunk = fh.read(1024 * 1024)
            if not chunk:
                break
            h.update(chunk)
    return h.hexdigest()


def download(sftp, remote: str, dest: Path, mtime: float, retries: int = 3) -> int:
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_name(dest.name + ".part")
    last = None
    for attempt in range(1, retries + 1):
        try:
            sftp.get(remote, str(tmp))
            os.replace(tmp, dest)
            try:
                os.utime(dest, (mtime, mtime))
            except OSError:
                pass
            return dest.stat().st_size
        except Exception as e:  # 网络抖动 / 临时权限
            last = e
            if tmp.exists():
                try:
                    tmp.unlink()
                except OSError:
                    pass
            if attempt < retries:
                time.sleep(1.5 * attempt)
    raise IOError(f"{remote} → {dest} 下载失败（{retries} 次）：{last}")


def trash_file(root: Path, dest: Path, run_trash: Path, log: Logger) -> str:
    """把本地多余文件移进回收站，返回回收站内的相对路径。"""
    try:
        rel = dest.relative_to(root)
    except ValueError:
        rel = Path(dest.name)
    tgt = run_trash / rel
    tgt.parent.mkdir(parents=True, exist_ok=True)
    if tgt.exists():
        tgt = tgt.with_name(tgt.name + f".{int(time.time())}")
    os.replace(dest, tgt)
    log.note(f"    - trash  {rel}")
    return str(tgt)


def prune_empty(dirpath: Path, stop: Path) -> None:
    cur = dirpath
    while True:
        try:
            if cur == stop or stop not in cur.parents:
                return
            if not cur.is_dir() or any(cur.iterdir()):
                return
            cur.rmdir()
            cur = cur.parent
        except OSError:
            return


# ---------------------------------------------------------------- 单个目标


def sync_target(sftp, target: dict, root: Path, idx: dict, args, log: Logger, stats: dict) -> dict:
    code = target["code"]
    log(f"  · {target['remote']}  →  {root / target['local']}")
    remote_map = list_remote(sftp, target, log)
    log(f"    远端 {len(remote_map)} 个文件")
    entries: dict[str, dict] = dict((idx["targets"].get(code) or {}).get("entries", {}))
    run_trash = root / ".sync-trash" / f"{args.stamp}-{code}"
    seen: set[str] = set()
    created = updated = skipped = 0
    trashed = 0
    bytes_new = 0
    diffs: list[dict] = []
    local_sha: dict[str, str] = {}
    for remote_path in sorted(remote_map):
        info = remote_map[remote_path]
        rel = remote_rel(target, remote_path)
        if not rel:
            continue
        seen.add(remote_path)
        ent = entries.get(remote_path)
        dest = local_of(target, rel)
        size, mtime = info["size"], info["mtime"]
        need = (ent is None) or int(ent.get("size", -1)) != size or abs(float(ent.get("mtime", 0)) - mtime) > 1.0
        if not need and not dest.is_file():
            need = True
        if need:
            kind = "新增" if ent is None else "更新"
            if ent is None:
                created += 1
            else:
                updated += 1
            bytes_new += size
            log.note(f"    + {kind}  {rel}  ({human(size)} · {fmt_dt(mtime)})")
            stats["items"].append({"t": code, "k": "new" if ent is None else "upd", "p": rel,
                                   "size": size, "mtime": mtime})
            if args.dry_run:
                entries[remote_path] = {"rel": rel, "size": size, "mtime": mtime}
                continue
            got = download(sftp, remote_path, dest, mtime, retries=args.retries)
            digest = sha1_of(dest) if size <= args.hash_max else None
            if digest:
                local_sha[remote_path] = digest
            entries[remote_path] = {"rel": rel, "size": got, "mtime": mtime, "sha1": digest}
        else:
            skipped += 1
            if ent is None:
                entries[remote_path] = {"rel": rel, "size": size, "mtime": mtime}
    # 服务器上已删 / 已改名 → 进回收站
    for remote_path in sorted(set(entries) - seen):
        ent = entries.pop(remote_path, None) or {}
        rel = ent.get("rel") or remote_rel(target, remote_path)
        dest = local_of(target, rel)
        if not dest.is_file():
            continue
        trashed += 1
        if args.dry_run:
            log.note(f"    - 将进回收站  {rel}")
            stats["items"].append({"t": code, "k": "trash", "p": rel,
                                   "size": dest.stat().st_size, "mtime": dest.stat().st_mtime})
            continue
        was = int(dest.stat().st_size)
        tgt = trash_file(root, dest, run_trash, log)
        stats["items"].append({"t": code, "k": "trash", "p": rel, "to": tgt, "size": was})
        prune_empty(dest.parent, root / target["local"])
    # 仓库比对（只报不写）
    if args.compare_repo and code in SOURCES:
        repo = SOURCES[code]
        if repo.is_dir():
            log(f"    仓库比对：{repo}")
            if args.repo_prefix == "auto":
                cand = [remote_rel(target, p) for p in remote_map]
                cand = [r for r in cand if r and not r.startswith("data/") and r.split("/")[0] not in ("rollback", "admin")]
                with_pfx = sum(1 for r in cand if r.startswith("store-saas/"))
                prefix = "store-saas" if with_pfx >= max(1, len(cand) // 2) else ""
                log.note(f"    仓库比对前缀：{'store-saas/' if prefix else '（镜像根，直接用相对路径）'}")
            else:
                prefix = args.repo_prefix or "store-saas"
            prefix = "" if prefix == "." else prefix.strip("/")
            limit = args.hash_max if args.sha_repo else 0
            for remote_path in sorted(remote_map):
                rel = remote_rel(target, remote_path)
                if not rel or rel.startswith("data/") or rel.split("/")[0] in ("rollback", "admin"):
                    continue
                if prefix:
                    rel = rel[len(prefix) + 1:] if rel.startswith(prefix + "/") else ""
                    if not rel:
                        continue
                if args.ignore_repo and any(tok in rel for tok in args.ignore_repo):
                    continue
                rp = repo / Path(*rel.split("/"))
                if not rp.is_file():
                    diffs.append({"rel": rel, "kind": "仓库缺少", "remote": remote_path})
                    continue
                rsize = int(rp.stat().st_size)
                rsize_remote = int(remote_map[remote_path]["size"])
                if rsize != rsize_remote:
                    diffs.append({"rel": rel, "kind": "大小不同", "repo": rsize, "remote": rsize_remote})
                    continue
                if limit and rsize <= limit:
                    msha = local_sha.get(remote_path) or (entries.get(remote_path) or {}).get("sha1")
                    if not msha and not args.assume_local:
                        mpath = local_of(target, remote_rel(target, remote_path))
                        if mpath.is_file():
                            msha = sha1_of(mpath)
                    if not msha:
                        continue  # 镜像里还没这份文件（例如 --dry-run 首轮）
                    rsha = sha1_of(rp)
                    if rsha != msha:
                        diffs.append({"rel": rel, "kind": "同大小但内容不同",
                                      "sha1_repo": rsha, "sha1_mirror": msha})
            for d in diffs[:40]:
                log.note(f"    ≈ 差异  {d['rel']}  ({d['kind']})")
            if len(diffs) > 40:
                log.note(f"    ≈ 差异共 {len(diffs)} 条（清单里全量）")
        else:
            log(f"    （仓库目录不存在，跳过比对：{repo}）")
    idx["targets"][code] = {
        "remote": target["remote"],
        "local": target["local"],
        "syncedAt": now_local().isoformat(),
        "entries": entries,
    }
    log(
        f"    结果：新增 {created} · 更新 {updated} · 未变 {skipped} · 进回收站 {trashed}"
        f" · 新增字节 {human(bytes_new)}{'（dry-run 未落盘）' if args.dry_run else ''}"
    )
    return {
        "code": code,
        "remote": target["remote"],
        "local": target["local"],
        "created": created,
        "updated": updated,
        "unchanged": skipped,
        "trashed": trashed,
        "bytes": bytes_new,
        "files_remote": len(remote_map),
        "repoDiffs": diffs,
    }


def ssl_inventory(ssh, sftp, target: dict, root: Path, args, log: Logger) -> dict:
    log(f"  · {target['remote']}  →  仅登记（不下载私钥）")
    try:
        entries = sftp.listdir_attr(target["remote"])
    except IOError as e:
        log(f"    ! 无法列举：{e}")
        return {"code": target["code"], "error": str(e)}
    lines = [
        f"# {target['remote']} 目录登记  {now_local().isoformat()}",
        "# 仅登记文件名 / 大小 / mtime / 证书有效期（不下载私钥内容）",
        "",
    ]
    listed = 0
    names: list[str] = []

    def register(fp: str, label: str) -> None:
        nonlocal listed
        listed += 1
        names.append(label)
        q = fp.replace("'", "'\\''")
        cmd = (
            f"printf '%s | %s | ' \"$(stat -c %s '{q}')\" \"$(stat -c %y '{q}' | cut -d. -f1)\"; "
            f"openssl x509 -in '{q}' -noout -subject -enddate 2>/dev/null | tr '\\n' ' ' ; echo"
        )
        try:
            _in, stdout, _err = ssh.exec_command(cmd, timeout=20)
            lines.append(f"{label} :: {stdout.read().decode('utf-8', 'replace').strip()}")
        except Exception as e:
            lines.append(f"{label} :: <登记失败 {e}>")

    def walk(d: str, depth: int) -> None:
        try:
            entries = sftp.listdir_attr(d)
        except IOError as e:
            lines.append(f"{d} :: <无法列举 {e}>")
            return
        for a in sorted(entries, key=lambda x: x.filename):
            fp = posixpath.join(d, a.filename)
            rel = posixpath.relpath(fp, target["remote"])
            if statmod.S_ISDIR(a.st_mode):
                lines.append(f"{rel}/ :: DIR")
                if depth < 2:
                    walk(fp, depth + 1)
            elif statmod.S_ISREG(a.st_mode):
                register(fp, rel)

    walk(target["remote"], 1)
    body = "\n".join(lines) + "\n"
    if not args.dry_run:
        p = root / "nginx" / "ssl-inventory.txt"
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(body, encoding="utf-8")
        log(f"    已登记 {len(names)} 个文件 → {p.relative_to(root)}")
    else:
        log(f"    将登记 {len(names)} 个文件 → nginx/ssl-inventory.txt")
    return {"code": "ssl", "remote": target["remote"], "local": "nginx/ssl-inventory.txt",
            "listed": len(names), "files": names}


def prune_trash(root: Path, days: int, log: Logger, dry: bool) -> None:
    base = root / ".sync-trash"
    if days <= 0 or not base.is_dir():
        return
    cutoff = time.time() - days * 86400
    for d in sorted(base.iterdir()):
        try:
            if d.is_dir() and d.stat().st_mtime < cutoff:
                log(f"  · 清理过期回收站：{d.name}（超过 {days} 天）")
                if not dry:
                    shutil.rmtree(d, ignore_errors=True)
        except OSError:
            pass


# ---------------------------------------------------------------- 主流程


def pick_targets(only: str | None, log: Logger, with_ssl: bool) -> tuple[list[dict], bool]:
    if not only:
        return list(TARGETS), with_ssl
    wanted: list[str] = []
    for raw in only.replace("，", ",").split(","):
        token = raw.strip().lower()
        if not token:
            continue
        token = UNIT_ALIASES.get(token, token)
        if token == "*":
            return list(TARGETS), True
        hit = None
        for t in TARGETS + [SSL_TARGET]:
            if token in (t["code"], *t.get("aliases", [])):
                hit = t["code"]
                break
        if not hit:
            log(f"! 未知目标名 {raw!r}（可用：{', '.join(t['code'] for t in TARGETS)}, ssl）")
            continue
        wanted.append(hit)
    picked = [t for t in TARGETS if t["code"] in wanted]
    return picked, ("ssl" in wanted)


def main() -> int:
    force_utf8()
    ap = argparse.ArgumentParser(
        description="把云服务器（mt-agent.com）内容单向拉回本地镜像（只下载差异，删除进回收站）",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    ap.add_argument("--root", default=str(DEFAULT_ROOT), help=f"本地镜像根目录（默认 {DEFAULT_ROOT}）")
    ap.add_argument("--only", help="只同步其中几项：store,www,nginx,units,ssl（逗号分隔；all = 全部）")
    ap.add_argument("--dry-run", action="store_true", help="预览：只列出会做什么，不写本地任何文件（含索引）")
    ap.add_argument("--list", action="store_true", help="列出目标名后退出")
    ap.add_argument("--compare-repo", dest="compare_repo", action="store_true", default=True,
                    help="顺带比对仓库 store-saas/ 与线上（默认开）")
    ap.add_argument("--no-compare-repo", dest="compare_repo", action="store_false", help="关闭仓库比对")
    ap.add_argument("--trash-days", type=int, default=30, help="回收站保留天数（0 = 永不清理，默认 30）")
    ap.add_argument("--retries", type=int, default=3, help="单文件下载重试次数（默认 3）")
    ap.add_argument("--hash-max", type=int, default=8 * 1024 * 1024,
                    help="参与哈希计算的单文件上限字节（默认 8MB）")
    ap.add_argument("--no-sha-repo", dest="sha_repo", action="store_false", default=True,
                    help="仓库比对只比文件大小，不算哈希（更快）")
    ap.add_argument("--repo-prefix", default="auto",
                    help="仓库比对的镜像子路径前缀（默认 auto 自动判断；用 . = 直接用相对路径）")
    ap.add_argument("--ignore-repo", action="append", default=[],
                    help="仓库比对忽略的路径片段，可重复（如 --ignore-repo .bak- --ignore-repo backup-）")
    ap.add_argument("--assume-local", action="store_true",
                    help="信任索引：仓库比对时不再为「索引里没哈希」的文件现算镜像侧 sha1（更快，可能少报几条差异）")
    ap.add_argument("--quiet", action="store_true", help="控制台只打摘要，逐文件明细只进日志")
    args = ap.parse_args()
    args.stamp = stamp()

    if args.list:
        for t in TARGETS + [SSL_TARGET]:
            out(f"{t['code']:<7} {t['remote']:<34} {t['desc']}")
        return 0

    root = Path(args.root).expanduser()
    log_file = None if args.dry_run else root / "_sync" / "sync.log"
    log = Logger(log_file, echo=True)
    detail = Logger(log_file, echo=not args.quiet)
    args.detail_mode = not args.quiet

    log("=" * 78)
    log(f"[{now_local().strftime('%Y-%m-%d %H:%M:%S')}] MTNode 云端 → 本地镜像同步"
        f"{'  （DRY-RUN，不落盘）' if args.dry_run else ''}")
    log(f"  本地根目录：{root}")
    cfg = load_cfg()
    log(f"  凭据来源：{cfg['source']}（{cfg['username']}@{cfg['host']}:{cfg['port']}）")

    picked, with_ssl = pick_targets(args.only, log, True)
    if not picked and not with_ssl:
        log("! 没有选中任何目标，退出")
        log.flush()
        return 2
    log(f"  目标：{', '.join(t['code'] for t in picked)}{' + ssl' if with_ssl else ''}")

    stats = {"items": []}
    for t in picked:
        t["_root"] = root
    idx = {"ver": 1, "targets": {}} if args.dry_run else load_index(root)
    client = connect(cfg)
    sftp = client.open_sftp()
    results: list[dict] = []
    failures: list[str] = []
    try:
        for t in picked:
            try:
                results.append(sync_target(sftp, t, root, idx, args, detail, stats))
            except Exception as e:
                failures.append(f"{t['code']}: {e}")
                log(f"  ! 目标 {t['code']} 失败：{e}")
        if with_ssl:
            try:
                results.append(ssl_inventory(client, sftp, SSL_TARGET, root, args, detail))
            except Exception as e:
                failures.append(f"ssl: {e}")
                log(f"  ! ssl 登记失败：{e}")
    finally:
        try:
            sftp.close()
        except Exception:
            pass
        client.close()

    if not args.dry_run:
        save_index(root, idx)
        prune_trash(root, args.trash_days, log, False)

    manifest = {
        "ver": 1,
        "syncedAt": now_local().isoformat(),
        "host": cfg["host"],
        "root": str(root),
        "mode": "dry-run" if args.dry_run else "sync",
        "only": args.only or None,
        "targets": results,
        "items": stats["items"],
        "failures": failures,
        "totals": {
            "created": sum(r.get("created", 0) for r in results),
            "updated": sum(r.get("updated", 0) for r in results),
            "unchanged": sum(r.get("unchanged", 0) for r in results),
            "trashed": sum(r.get("trashed", 0) for r in results),
            "bytes": sum(r.get("bytes", 0) for r in results),
            "repoDiffs": sum(len(r.get("repoDiffs") or []) for r in results),
        },
        "indexPath": str(index_path(root)),
    }
    tot = manifest["totals"]
    log("-" * 78)
    log(f"  合计：新增 {tot['created']} · 更新 {tot['updated']} · 未变 {tot['unchanged']}"
        f" · 进回收站 {tot['trashed']} · 传输 {human(tot['bytes'])}")
    if tot["repoDiffs"]:
        log(f"  仓库比对差异 {tot['repoDiffs']} 条（详见清单，仓库文件未被改动）")
    if failures:
        log(f"  ! 失败 {len(failures)} 项：{'; '.join(failures)}")
    if not args.dry_run:
        mpath = root / "_sync" / "manifest.json"
        mpath.parent.mkdir(parents=True, exist_ok=True)
        mpath.write_text(json.dumps(manifest, ensure_ascii=False, indent=1), encoding="utf-8")
        log(f"  清单：{mpath}")
        log(f"  索引：{index_path(root)}")
        log(f"  日志：{log_file}")
    log("=" * 78)
    log.flush()
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
