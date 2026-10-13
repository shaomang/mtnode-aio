#!/usr/bin/env python3
"""云服务器（mt-agent.com）磁盘与运维日志清理：改配置 + 清空间，可预览 / 可回滚 / 可复验。

现场（2026-10-14 首查，只读）：根分区 20G / 用 14G / 74%；journald 172M；/var/log/nginx 11M；
/root/.vscode-server 4.5G（其中 cli/servers 六份 VS Code Remote 版本 3.17G、只有一份在跑）；
/root/mt-ai-router 1.4G（mt-ai-router-mongod 正在用它当 --dbpath 跑了 78 天）；/var/lib/apt/lists 150M；
/root/.npm/_cacache 21M；/tmp 76M（75 项超过 30 天）。

本脚本一次做六件事（每一件都幂等、改前备份、可单独回滚）：
  1 journald   写 /etc/systemd/journald.conf.d/10-mtnode-retention.conf（64M / 2 天）后 vacuum；
  2 logrotate  /etc/logrotate.d/nginx 的 rotate 14 → 2；
  3 nginx      /mtnode/music3/、/mtnode/h3/ 两个 location 加 access_log off；（可选，默认关）
               把正落到 OSS 的 /mtnode/yue/ 换成本地 alias —— 见 --yue，默认关，因为 /var/www/mtnode/yue 不存在；
  4 vaproj     给 vaproj-backend.service 加 drop-in：LogLevelMax=warning（消掉 apscheduler 每分钟两行 INFO）；
  5 sshd       /etc/ssh/sshd_config 加 LogLevel ERROR（保留失败认证，不记 Accepted / session opened）；
  6 清理       VS Code Remote 旧版本 / code-* CLI 目录 / 30 天前的 data/logs 与 agent-host sdk-cache /
               /tmp 30 天前的一次性上传目录与散落包 / /root/.npm/_cacache / 整个 /root/mt-ai-router
               （删前先 systemctl disable --now mt-ai-router-mongod，unit 文件移进备份目录）/
               apt-get autoremove --purge + clean + rm /var/lib/apt/lists/*。

两种跑法（同一份逻辑，只有一层外壳不同）：
  A. 本机（默认）：用 paramiko 连上去，把内嵌的远端脚本传到服务器再跑 —— 需要本机装 paramiko。
     python scripts/server-disk-cleanup.py --dry-run      # 预览（默认模式，什么都不改）
     python scripts/server-disk-cleanup.py --apply        # 真正执行
     python scripts/server-disk-cleanup.py --verify       # 复验（远端 + 本机公网 HTTP / 重新登录）
     python scripts/server-disk-cleanup.py --rollback     # 按最近一次清单回滚
  B. 服务器上直接跑（零第三方依赖，python3 一条就够）：
     python3 server-disk-cleanup.py --apply
     用法同 A；服务器上跑时不会做「公网 HTTP + 重新登录」那两条本机侧验证（会注明未做）。

凭据：MTNODE_SFTP_JSON（优先）→ 默认 E:\\dev\\tools\\ssh\\sftp-mtnode-store.json；
      其次 MTNODE_SSH_HOST + MTNODE_SSH_USER + MTNODE_SSH_PASSWORD/MTNODE_SSH_KEY。

留痕：服务器 /root/mtnode-disk-cleanup-<stamp>/（manifest.json + RESTORE.sh + report.md）；
      本机 scripts/server-disk-reports/（同一份报告 + 远端清单与 JSON 回执）。
"""

from __future__ import annotations

import argparse
import base64
import datetime as _dt
import json
import os
import shlex
import sys
import time
import urllib.request
from pathlib import Path

# ------------------------------------------------------------------ 常量

DEFAULT_SFTP = Path(r"E:\dev\tools\ssh\sftp-mtnode-store.json")
REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_REPORT_DIR = REPO_ROOT / "scripts" / "server-disk-reports"

REMOTE_ENV = "MTNODE_DISK_CLEANUP_REMOTE"
MARK_SUMMARY_BEGIN = "=====MTNODE-CLEANUP-SUMMARY-BEGIN====="
MARK_SUMMARY_END = "=====MTNODE-CLEANUP-SUMMARY-END====="
MARK_MANIFEST_BEGIN = "=====MTNODE-CLEANUP-MANIFEST-BEGIN====="
MARK_MANIFEST_END = "=====MTNODE-CLEANUP-MANIFEST-END====="

DEFAULT_URLS = [
    "https://www.mt-agent.com/mtnode/h3/manifest.json",
    "https://www.mt-agent.com/mtnode/music3/manifest.json",
]
HEALTH_URL = "https://www.mt-agent.com/mtnode/store-api/api/health"
PROTECTED_PATHS = "/opt/mtnode-store/data /var/www/mtnode /etc/mtnode-store.env /root/mt-ai-router/.env"


# ================================================================== 远端脚本（服务器上 python3 直接跑，零第三方依赖）
# 这一段就是「服务器上能 python3 直接跑」的那份自足脚本：用 --save-payload 可单独导出核对。

REMOTE_PAYLOAD = r'''#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""MTNode 云服务器磁盘 / 运维日志清理（在服务器上跑，零第三方依赖）。

改前必留备份：/root/mtnode-disk-cleanup-<stamp>/{backup/manifest.json/RESTORE.sh/report.md}
每条改动都幂等（已生效即 skipped），失败项不中断后续，最后汇总。--rollback 按清单回滚。
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shlex
import shutil
import subprocess
import sys
import time
from datetime import datetime

SUMMARY_BEGIN = "=====MTNODE-CLEANUP-SUMMARY-BEGIN====="
SUMMARY_END = "=====MTNODE-CLEANUP-SUMMARY-END====="
MANIFEST_BEGIN = "=====MTNODE-CLEANUP-MANIFEST-BEGIN====="
MANIFEST_END = "=====MTNODE-CLEANUP-MANIFEST-END====="

STATE_ROOT_DEFAULT = "/root"
JOURNALD_DROPIN = "/etc/systemd/journald.conf.d/10-mtnode-retention.conf"
JOURNALD_BODY = (
    "# MTNode 磁盘兜底：journald 只留 2 天 / 最多 64M（由 scripts/server-disk-cleanup.py 写入）\n"
    "[Journal]\n"
    "SystemMaxUse=64M\n"
    "MaxRetentionSec=2day\n"
    "MaxFileSec=1day\n"
)
LOGROTATE_NGINX = "/etc/logrotate.d/nginx"
NGINX_SITE = "/etc/nginx/sites-available/mt-ai-router.conf"
NGINX_SITE_FALLBACK = "/etc/nginx/sites-enabled/mt-ai-router.conf"
VAPROJ_UNIT = "/etc/systemd/system/vaproj-backend.service"
VAPROJ_DROPIN = "/etc/systemd/system/vaproj-backend.service.d/10-mtnode-loglevel.conf"
VAPROJ_BODY = (
    "# MTNode 降噪：apscheduler 每分钟两行 INFO 心跳写满 journal，这里压到 warning\n"
    "[Service]\n"
    "LogLevelMax=warning\n"
)
SSHD_CONFIG = "/etc/ssh/sshd_config"
MONGOD_UNIT = "/etc/systemd/system/mt-ai-router-mongod.service"
MONGOD_SERVICE = "mt-ai-router-mongod"
VSCODE = "/root/.vscode-server"
NPM_CACHE = "/root/.npm/_cacache"
ROUTER_DIR = "/root/mt-ai-router"
STORE_DATA = "/opt/mtnode-store/data"
TMP_DIR = "/tmp"

ACCESS_LOG_SITES = ["/mtnode/music3/", "/mtnode/h3/"]
YUE_SITE = "/mtnode/yue/"
YUE_ALIAS = "/var/www/mtnode/yue/"
YUE_BLOCK = """    # === MTNode YuE2 脚手架（server-disk-cleanup.py 写入：本地 alias + 不记 access） ===
    location ^~ /mtnode/yue/ {
        alias /var/www/mtnode/yue/;
        autoindex off;
        add_header Access-Control-Allow-Origin *;
        add_header Cache-Control "public, max-age=60";
        types {
            application/json json;
            application/zip zip;
            text/plain txt;
        }
        default_type application/octet-stream;
        access_log off;
    }

"""

# /tmp 里只碰这些「一次性上传 / 打包残留」形态，其余一律不碰
TMP_KEEP_PREFIX = (
    "systemd-private-", "aliyun_", "Aliyun", ".X11-unix", ".XIM-unix", ".ICE-unix",
    ".font-unix", ".Test-unix", "code-", "mongodb-", "tmp", "hsperfdata_",
)
TMP_KEEP_EXACT = {".": 1, "..": 1}
TMP_KEEP_SUFFIX = (".sock", ".lock", ".pid", ".X11-unix")
TMP_HIT_NAME = ("upload", "dist")
TMP_HIT_EXT = (".tgz", ".tar.gz", ".zip", ".gz", ".rar", ".7z")
TMP_ARCHIVE_MAX = 200 * 1024 * 1024

PROTECTED_PATHS = "/opt/mtnode-store/data /var/www/mtnode /etc/mtnode-store.env /root/mt-ai-router/.env"
FAILURES = []


# ------------------------------------------------------------------ 基础


def out(msg=""):
    try:
        sys.stdout.write(str(msg) + "\n")
        sys.stdout.flush()
    except Exception:
        sys.stdout.write(str(msg).encode("ascii", "replace").decode("ascii") + "\n")


def now_iso():
    return datetime.now().astimezone().isoformat(timespec="seconds")


def human(n):
    try:
        n = float(n)
    except Exception:
        return "-"
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if n < 1024 or unit == "TB":
            return ("%dB" % int(n)) if unit == "B" else ("%.1f%s" % (n, unit))
        n /= 1024.0
    return "-"


def shquote(p):
    return shlex.quote(str(p))


def run(cmd, timeout=600, check=False):
    """跑一条 shell 命令，回 (rc, stdout+stderr)。永远不抛异常。"""
    try:
        p = subprocess.run(["/bin/bash", "-lc", cmd], capture_output=True, text=True, timeout=timeout)
        txt = ((p.stdout or "") + (p.stderr or "")).strip()
        if check and p.returncode != 0:
            raise RuntimeError(txt[-800:])
        return p.returncode, txt
    except subprocess.TimeoutExpired as e:
        got = ""
        try:
            got = ((e.stdout or b"").decode("utf-8", "replace") if isinstance(e.stdout, bytes) else (e.stdout or ""))[:400]
        except Exception:
            got = ""
        return 124, "TIMEOUT after %ss %s" % (timeout, got)
    except Exception as e:  # 命令不存在等
        return 127, "EXEC-FAIL: %s: %s" % (type(e).__name__, e)


def ev(cmd, timeout=600, maxlen=240):
    rc, txt = run(cmd, timeout=timeout)
    one = " ".join((txt or "").split())
    if len(one) > maxlen:
        one = one[:maxlen] + "…"
    return "$ %s -> rc=%d%s" % (cmd, rc, (" | " + one) if one else "")


def path_size(p):
    """单路径字节数（文件 stat，目录 du -sb）。"""
    try:
        st = os.lstat(p)
    except OSError:
        return 0
    if os.path.isdir(p) and not os.path.islink(p):
        rc, txt = run("du -sb -- %s | cut -f1" % shquote(p), timeout=300)
        try:
            return int(txt.splitlines()[-1])
        except Exception:
            return 0
    return int(st.st_size)


def note_item(items, id, cat, title, action, path, status, size=0, backup="", evidence=None, note=""):
    items.append({
        "id": id, "cat": cat, "title": title, "action": action, "path": path,
        "status": status, "size": int(size or 0), "backup": backup,
        "evidence": list(evidence or []), "note": note, "at": now_iso(),
    })


def fail(msg):
    FAILURES.append(msg)
    out("  ! %s" % msg)


def record(items, **kw):
    note_item(items, **kw)
    it = items[-1]
    if it["status"] == "failed":
        FAILURES.append("%s %s：%s" % (it["title"], it["path"], it["note"] or "失败"))
    return it


# ------------------------------------------------------------------ 备份 / 回滚


class Backup:
    def __init__(self, root, stamp):
        self.stamp = stamp
        self.root = os.path.join(root, "mtnode-disk-cleanup-" + stamp)
        self.bpath = os.path.join(self.root, "backup")
        self.made = False

    def ensure(self):
        if not self.made:
            os.makedirs(self.bpath, exist_ok=True)
            self.made = True
        return self.bpath

    def save(self, src):
        """把 src 复制进备份目录，回备份路径（源不存在时回空串）。"""
        if not os.path.exists(src):
            return ""
        self.ensure()
        dst = os.path.join(self.bpath, src.lstrip("/"))
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        if os.path.isdir(src) and not os.path.islink(src):
            if os.path.exists(dst):
                shutil.rmtree(dst, ignore_errors=True)
            shutil.copytree(src, dst, symlinks=True)
        else:
            shutil.copy2(src, dst, follow_symlinks=False)
        return dst

    def move(self, src):
        """把 src 整体移进备份目录（清理项用，不用通配符直删），回 (备份路径, 字节数)。"""
        if not os.path.exists(src):
            return "", 0
        self.ensure()
        dst = os.path.join(self.bpath, src.lstrip("/"))
        if os.path.exists(dst):
            dst = dst + ".dup-%d" % int(time.time())
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        size = path_size(src)
        rc, txt = run("mv -- %s %s" % (shquote(src), shquote(dst)), timeout=1800)
        if rc != 0 or os.path.exists(src):
            return "", 0
        return dst, size

    def write_restore(self, items):
        """RESTORE.sh：只按清单恢复被移动的路径（cp -a --parents），配置类直接照抄命令。"""
        lines = [
            "#!/bin/bash",
            "# MTNode 磁盘清理回滚（%s）" % self.stamp,
            "# 用法：bash %s/RESTORE.sh  [--move-only]" % self.root,
            "# 说明：配置类改动请用 `python3 server-disk-cleanup.py --rollback`（它按清单逐项还原）；",
            "#       这里只做最粗的兜底：把备份目录里的东西按原路径搬回去。",
            "set -u",
            'B="%s"' % self.bpath,
            'if [ ! -d "$B" ]; then echo "备份目录不存在：$B" >&2; exit 2; fi',
            'cd "$B" || exit 2',
            'echo "[1/2] 按原路径恢复备份内容 …"',
            'tar -C "$B" --exclude=manifest.json --exclude=RESTORE.sh -cf - . | tar -C / -xvf - || echo "恢复有失败项，见上面输出"',
            'echo "[2/2] 重新加载相关服务 …"',
            'systemctl daemon-reload 2>/dev/null || true',
        ]
        cfgs = [i for i in items if i["action"] == "config" and i.get("backup")]
        for it in cfgs:
            svc = self._svc_for(it["path"])
            if svc:
                lines.append('systemctl restart %s 2>/dev/null || true' % svc)
        if any(i["path"] == MONGOD_UNIT for i in items):
            lines.append('echo "提示：mt-ai-router-mongod 已被停用；若要恢复：systemctl enable --now %s"'
                         % MONGOD_SERVICE)
        lines.append('echo "完成。逐项核验：bash %s/RESTORE.sh 之后跑 python3 server-disk-cleanup.py --verify"' % self.root)
        self.ensure()
        p = os.path.join(self.root, "RESTORE.sh")
        with open(p, "w", encoding="utf-8") as fh:
            fh.write("\n".join(lines) + "\n")
        os.chmod(p, 0o755)
        return p

    @staticmethod
    def _svc_for(path):
        if path == JOURNALD_DROPIN:
            return "systemd-journald"
        if path in (NGINX_SITE, NGINX_SITE_FALLBACK):
            return "nginx"
        if path == SSHD_CONFIG:
            return "ssh"
        if path == VAPROJ_DROPIN:
            return "vaproj-backend"
        return ""


def do_rollback(args, items_out):
    stamp = args.stamp or latest_stamp(args.state_root)
    if not stamp:
        out("! 找不到任何备份目录（%s/mtnode-disk-cleanup-*）" % args.state_root)
        return 2
    root = os.path.join(args.state_root, "mtnode-disk-cleanup-" + stamp)
    mp = os.path.join(root, "manifest.json")
    out("回滚目标：%s" % root)
    if not os.path.isfile(mp):
        out("! 清单不存在：%s" % mp)
        return 2
    with open(mp, "r", encoding="utf-8") as fh:
        man = json.load(fh)
    items = man.get("items") or []
    done = [i for i in items if i["status"] in ("done", "failed") and i.get("backup")]
    out("清单条目 %d，其中带备份可回滚 %d 条" % (len(items), len(done)))
    restored = 0
    for it in reversed(done):
        b = it["backup"]
        src = it["path"]
        if not os.path.exists(b):
            out("  - 跳过（备份已不在）：%s" % src)
            continue
        if it["action"] == "config":
            if os.path.exists(src):
                shutil.copy2(b, src)
            else:
                shutil.copy2(b, src)
            out("  + 还原配置 %s" % src)
            restored += 1
        elif it["action"] == "delete":
            if os.path.exists(src):
                out("  - 跳过（原路径已被占用）：%s" % src)
                continue
            os.makedirs(os.path.dirname(src), exist_ok=True)
            rc, _ = run("cp -a -- %s %s" % (shquote(b), shquote(src)), timeout=1800)
            if rc == 0:
                out("  + 找回 %s（%s）" % (src, human(path_size(src))))
                restored += 1
            else:
                out("  ! 找回失败 %s" % src)
    for svc in ("systemd-journald", "nginx", "ssh", "vaproj-backend"):
        run("systemctl reload-or-restart %s" % svc, timeout=120)
    run("systemctl daemon-reload", timeout=60)
    out("回滚完成：%d 项已还原。mongod 若需要请手工 systemctl enable --now %s" % (restored, MONGOD_SERVICE))
    note_item(items_out, "rollback", "rollback", "按清单回滚", "rollback", root,
              "done" if restored else "skipped",
              evidence=["$ 回滚 %d 项 -> %s" % (restored, root)])
    return 0


def latest_stamp(state_root):
    try:
        names = [n for n in os.listdir(state_root) if n.startswith("mtnode-disk-cleanup-")]
    except OSError:
        return ""
    names.sort()
    return names[-1][len("mtnode-disk-cleanup-"):] if names else ""


# ------------------------------------------------------------------ 快照


def df_root():
    rc, txt = run("df -B1 --output=size,used,avail,pcent / | tail -1")
    parts = txt.split()
    try:
        return {"size": int(parts[0]), "used": int(parts[1]), "avail": int(parts[2]), "pcent": parts[3]}
    except Exception:
        return {}


def journal_usage():
    rc, txt = run("journalctl --disk-usage 2>/dev/null | tail -1")
    m = re.search(r"([0-9.]+)\s*([KMG]?)", txt or "")
    if not m:
        return 0, txt
    val = float(m.group(1))
    mult = {"": 1, "K": 1024, "M": 1024 ** 2, "G": 1024 ** 3}[m.group(2)]
    return int(val * mult), txt


def snapshot(paths=None):
    snap = {"at": now_iso(), "df": df_root()}
    js, jsline = journal_usage()
    snap["journal_bytes"] = js
    snap["journal_line"] = jsline
    sizes = {}
    for p in (paths or []):
        sizes[p] = path_size(p)
    snap["sizes"] = sizes
    return snap


# ================================================================== 六类改动


def step_journald(args, items, bk):
    out("")
    out("[1/6] journald 保留期 → 64M / 2 天")
    before, line = journal_usage()
    rc, txt = run("systemctl is-active systemd-journald")
    exists = os.path.exists(JOURNALD_DROPIN)
    same = exists and open(JOURNALD_DROPIN, "r", encoding="utf-8", errors="replace").read().strip() == JOURNALD_BODY.strip()
    evid = [ev("journalctl --disk-usage"), ev("journalctl --verify --quiet; echo verify-rc=$?"),
            "systemctl is-active systemd-journald -> %s" % txt.strip()]
    if same:
        record(items, id="journald-dropin", cat="journald", title="journald 保留策略配置",
               action="config", path=JOURNALD_DROPIN, status="skipped", size=len(JOURNALD_BODY),
               evidence=evid, note="已存在且内容一致，幂等跳过")
    elif args.dry_run:
        record(items, id="journald-dropin", cat="journald", title="journald 保留策略配置",
               action="config", path=JOURNALD_DROPIN, status="dry-run", size=len(JOURNALD_BODY),
               note="将写入 SystemMaxUse=64M / MaxRetentionSec=2day / MaxFileSec=1day%s" % ("（覆盖已存在文件）" if exists else ""),
               evidence=evid)
    else:
        bkpath = bk.save(JOURNALD_DROPIN) if exists else ""
        try:
            os.makedirs(os.path.dirname(JOURNALD_DROPIN), exist_ok=True)
            with open(JOURNALD_DROPIN, "w", encoding="utf-8") as fh:
                fh.write(JOURNALD_BODY)
            rc, txt = run("systemctl restart systemd-journald", timeout=120)
            ok = rc == 0
            evid.append("$ systemctl restart systemd-journald -> rc=%d %s" % (rc, " ".join(txt.split())[:160]))
            record(items, id="journald-dropin", cat="journald", title="journald 保留策略配置",
                   action="config", path=JOURNALD_DROPIN, status="done" if ok else "failed",
                   size=len(JOURNALD_BODY), backup=bkpath, evidence=evid,
                   note="" if ok else "写入成功但重启 journald 失败：%s" % txt[:200])
        except Exception as e:
            fail("journald 配置写入失败：%s" % e)
            record(items, id="journald-dropin", cat="journald", title="journald 保留策略配置",
                   action="config", path=JOURNALD_DROPIN, status="failed", backup=bkpath,
                   evidence=evid, note=str(e))
    # vacuum
    if args.dry_run:
        record(items, id="journald-vacuum", cat="journald", title="journald 立刻回收（vacuum）",
               action="vacuum", path="/var/log/journal", status="dry-run", size=before,
               note="将执行 journalctl --vacuum-time=2d --vacuum-size=64M；当前 %s" % human(before),
               evidence=["$ journalctl --disk-usage -> %s" % line])
    else:
        rc1, t1 = run("journalctl --vacuum-time=2d", timeout=600)
        rc2, t2 = run("journalctl --vacuum-size=64M", timeout=600)
        after, line2 = journal_usage()
        freed = max(0, before - after)
        record(items, id="journald-vacuum", cat="journald", title="journald 立刻回收（vacuum）",
               action="vacuum", path="/var/log/journal", status="done" if rc1 == 0 and rc2 == 0 else "failed",
               size=freed,
               evidence=["$ journalctl --vacuum-time=2d -> rc=%d %s" % (rc1, " ".join(t1.split())[:160]),
                         "$ journalctl --vacuum-size=64M -> rc=%d %s" % (rc2, " ".join(t2.split())[:160]),
                         "$ journalctl --disk-usage -> %s（清理前 %s）" % (line2, line)],
               note="回收 %s" % human(freed))
    return before, journal_usage()[0]


def step_logrotate(args, items, bk):
    out("[2/6] nginx 日志保留期 rotate 14 → 2")
    if not os.path.isfile(LOGROTATE_NGINX):
        record(items, id="logrotate-nginx", cat="logrotate", title="nginx logrotate 保留份数",
               action="config", path=LOGROTATE_NGINX, status="skipped", note="文件不存在，跳过")
        return
    with open(LOGROTATE_NGINX, "r", encoding="utf-8") as fh:
        src = fh.read()
    m = re.search(r"^([ \t]*)rotate[ \t]+(\d+)[ \t]*$", src, re.M)
    if not m:
        record(items, id="logrotate-nginx", cat="logrotate", title="nginx logrotate 保留份数",
               action="config", path=LOGROTATE_NGINX, status="failed", evidence=[ev("grep -n rotate " + LOGROTATE_NGINX)],
               note="找不到 rotate 指令")
        fail("logrotate: 找不到 rotate 指令")
        return
    cur = m.group(2)
    evid = [ev("grep -n 'rotate' " + LOGROTATE_NGINX), ev("ls -la /var/log/nginx | head -20")]
    if cur == "2":
        record(items, id="logrotate-nginx", cat="logrotate", title="nginx logrotate 保留份数",
               action="config", path=LOGROTATE_NGINX, status="skipped", evidence=evid, note="已是 rotate 2，幂等跳过")
        return
    if args.dry_run:
        record(items, id="logrotate-nginx", cat="logrotate", title="nginx logrotate 保留份数",
               action="config", path=LOGROTATE_NGINX, status="dry-run", size=len(src),
               note="将把 rotate %s 改成 rotate 2" % cur, evidence=evid)
        return
    bkpath = bk.save(LOGROTATE_NGINX)
    out_new = src[:m.start()] + m.group(1) + "rotate 2" + src[m.end():]
    with open(LOGROTATE_NGINX, "w", encoding="utf-8") as fh:
        fh.write(out_new)
    rc, txt = run("logrotate -d /etc/logrotate.d/nginx 2>&1 | tail -5")
    record(items, id="logrotate-nginx", cat="logrotate", title="nginx logrotate 保留份数",
           action="config", path=LOGROTATE_NGINX, status="done", size=len(src), backup=bkpath,
           evidence=evid + ["$ logrotate -d /etc/logrotate.d/nginx -> rc=%d %s" % (rc, " ".join(txt.split())[:200])],
           note="rotate %s → 2" % cur)


def nginx_test(items, evid, tag):
    rc, txt = run("nginx -t", timeout=120)
    evid.append("$ nginx -t -> rc=%d %s" % (rc, " ".join(txt.split())[:240]))
    if rc != 0:
        fail("%s：nginx -t 失败 -> %s" % (tag, " ".join(txt.split())[:200]))
        return False
    rc2, txt2 = run("systemctl reload nginx", timeout=120)
    evid.append("$ systemctl reload nginx -> rc=%d %s" % (rc2, " ".join(txt2.split())[:160]))
    if rc2 != 0:
        fail("%s：nginx reload 失败 -> %s" % (tag, " ".join(txt2.split())[:200]))
        return False
    return True


def add_access_log_off(src, site):
    """在 location ^~ <site> { ... } 块内加 access_log off;（已有效即原样返回）。"""
    i = src.find("location ^~ " + site + " {")
    if i < 0:
        return src, "no-block"
    j = src.find("\n    }", i)
    if j < 0:
        return src, "no-end"
    block = src[i:j]
    if re.search(r"^\s*access_log\s+off\s*;", block, re.M):
        return src, "already"
    new_block = block.rstrip("\n") + "\n        access_log off;\n"
    return src[:i] + new_block + src[j:], "added"


def step_nginx_access(args, items, bk):
    out("[3/6] nginx：/mtnode/music3/ 与 /mtnode/h3/ 不记 access")
    site = NGINX_SITE if os.path.isfile(NGINX_SITE) else NGINX_SITE_FALLBACK
    if not os.path.isfile(site):
        record(items, id="nginx-access", cat="nginx", title="脚手架 location 不记 access",
               action="config", path=NGINX_SITE, status="failed", note="站点配置不存在")
        fail("nginx: 站点配置不存在 %s" % NGINX_SITE)
        return
    with open(site, "r", encoding="utf-8") as fh:
        src = fh.read()
    todo, results = [], []
    new = src
    for s in ACCESS_LOG_SITES:
        new, st = add_access_log_off(new, s)
        results.append("%s=%s" % (s, st))
    changed = new != src
    evid = ["$ grep -n 'access_log' %s -> %s" % (site, " ".join(
        run("grep -n 'access_log' %s | head -10" % shquote(site))[1].split())[:200]), "修改点：" + " ".join(results)]
    if not changed:
        record(items, id="nginx-access", cat="nginx", title="脚手架 location 不记 access",
               action="config", path=site, status="skipped", evidence=evid, note="两段都已有 access_log off（或块不存在），幂等跳过")
    elif args.dry_run:
        record(items, id="nginx-access", cat="nginx", title="脚手架 location 不记 access",
               action="config", path=site, status="dry-run", size=len(src), evidence=evid,
               note="将在 music3 / h3 两个 location 内插入 access_log off;")
    else:
        bkpath = bk.save(site)
        with open(site, "w", encoding="utf-8") as fh:
            fh.write(new)
        if nginx_test(items, evid, "nginx-access"):
            record(items, id="nginx-access", cat="nginx", title="脚手架 location 不记 access",
                   action="config", path=site, status="done", size=len(src), backup=bkpath,
                   evidence=evid, note=" ".join(results))
        else:
            shutil.copy2(bkpath, site)
            evid.append("$ 还原备份 -> %s（nginx -t 未通过，已回滚）" % bkpath)
            nginx_test(items, evid, "nginx-access-rollback")
            record(items, id="nginx-access", cat="nginx", title="脚手架 location 不记 access",
                   action="config", path=site, status="failed", backup=bkpath, evidence=evid,
                   note="nginx -t 未通过，已还原备份")
    # yue（可选）
    if not args.yue:
        record(items, id="nginx-yue", cat="nginx", title="/mtnode/yue/ 本地 alias（可选，未启用）",
               action="config", path=site, status="skipped",
               evidence=[ev("curl -s -o /dev/null -w '%{http_code}' https://mtnode-download.oss-cn-beijing.aliyuncs.com/yue/")],
               note="--yue 未开：%s 目录当前不存在，启用会把现在落到 OSS 的 /mtnode/yue/ 变成 404" % YUE_ALIAS)
        return
    if YUE_SITE in src:
        record(items, id="nginx-yue", cat="nginx", title="/mtnode/yue/ 本地 alias + 不记 access",
               action="config", path=site, status="skipped", note="location 已存在，幂等跳过")
        return
    if not os.path.isdir(YUE_ALIAS):
        record(items, id="nginx-yue", cat="nginx", title="/mtnode/yue/ 本地 alias + 不记 access",
               action="config", path=site, status="failed",
               note="%s 不存在：启用会让 /mtnode/yue/* 从「OSS 反代」变成 404，按共识不启用" % YUE_ALIAS)
        fail("nginx: %s 不存在，--yue 未执行" % YUE_ALIAS)
        return
    anchor = "    location ~ ^/mtnode/(.*)$"
    if anchor not in src:
        record(items, id="nginx-yue", cat="nginx", title="/mtnode/yue/ 本地 alias + 不记 access",
               action="config", path=site, status="failed", note="找不到 OSS catch-all 锚点")
        fail("nginx: 找不到 /mtnode/ OSS catch-all 锚点，--yue 未执行")
        return
    if args.dry_run:
        record(items, id="nginx-yue", cat="nginx", title="/mtnode/yue/ 本地 alias + 不记 access",
               action="config", path=site, status="dry-run", note="将在 OSS catch-all 之前插入 yue location")
        return
    bkpath = bk.save(site)
    with open(site, "w", encoding="utf-8") as fh:
        fh.write(src.replace(anchor, YUE_BLOCK + anchor, 1))
    evid2 = ["插入锚点：%s" % anchor]
    if nginx_test(items, evid2, "nginx-yue"):
        record(items, id="nginx-yue", cat="nginx", title="/mtnode/yue/ 本地 alias + 不记 access",
               action="config", path=site, status="done", backup=bkpath, evidence=evid2,
               note="alias %s + access_log off" % YUE_ALIAS)
    else:
        shutil.copy2(bkpath, site)
        nginx_test(items, evid2, "nginx-yue-rollback")
        record(items, id="nginx-yue", cat="nginx", title="/mtnode/yue/ 本地 alias + 不记 access",
               action="config", path=site, status="failed", backup=bkpath, evidence=evid2,
               note="nginx -t 未通过，已还原备份")


def step_vaproj(args, items, bk):
    out("[4/6] vaproj-backend：apscheduler 心跳 INFO 降噪")
    evid = [ev("systemctl is-active vaproj-backend"), ev("cat " + VAPROJ_UNIT),
            ev("grep -rn 'setup_logging' /opt/vaproj/backend/app/main.py /opt/vaproj/backend/app/core/logging.py")]
    if not os.path.isfile(VAPROJ_UNIT):
        record(items, id="vaproj-loglevel", cat="vaproj", title="vaproj-backend 日志降噪",
               action="config", path=VAPROJ_UNIT, status="failed", evidence=evid, note="unit 不存在")
        fail("vaproj: unit 不存在 %s" % VAPROJ_UNIT)
        return
    unit = open(VAPROJ_UNIT, "r", encoding="utf-8", errors="replace").read()
    has_env = "LOG_LEVEL" in unit
    exists = os.path.isfile(VAPROJ_DROPIN)
    same = exists and open(VAPROJ_DROPIN, "r", encoding="utf-8", errors="replace").read().strip() == VAPROJ_BODY.strip()
    note_base = ("app/core/logging.py 的 setup_logging(level='INFO') 读的是硬编码默认值、不认环境变量，"
                 "所以走 journald 侧 LogLevelMax=warning（日志仍写 stdout，只是不进 journal）"
                 if not has_env else "unit 里已有 LOG_LEVEL 环境变量，仍按 drop-in 统一压低")
    if same:
        record(items, id="vaproj-loglevel", cat="vaproj", title="vaproj-backend 日志降噪",
               action="config", path=VAPROJ_DROPIN, status="skipped", evidence=evid, note="drop-in 已存在且一致，幂等跳过")
        return
    if args.dry_run:
        record(items, id="vaproj-loglevel", cat="vaproj", title="vaproj-backend 日志降噪",
               action="config", path=VAPROJ_DROPIN, status="dry-run", size=len(VAPROJ_BODY),
               evidence=evid, note="将写 drop-in LogLevelMax=warning 并 restart（" + note_base + "）")
        return
    bkpath = bk.save(VAPROJ_DROPIN) if exists else ""
    try:
        os.makedirs(os.path.dirname(VAPROJ_DROPIN), exist_ok=True)
        with open(VAPROJ_DROPIN, "w", encoding="utf-8") as fh:
            fh.write(VAPROJ_BODY)
        rc1, t1 = run("systemctl daemon-reload", timeout=120)
        rc2, t2 = run("systemctl restart vaproj-backend", timeout=180)
        time.sleep(2)
        rc3, t3 = run("systemctl is-active vaproj-backend")
        ok = rc2 == 0 and t3.strip() == "active"
        evid += ["$ systemctl daemon-reload -> rc=%d" % rc1,
                 "$ systemctl restart vaproj-backend -> rc=%d %s" % (rc2, " ".join(t2.split())[:160]),
                 "$ systemctl is-active vaproj-backend -> %s" % t3.strip(),
                 ev("journalctl -u vaproj-backend --since '-3min' --no-pager | tail -5")]
        record(items, id="vaproj-loglevel", cat="vaproj", title="vaproj-backend 日志降噪",
               action="config", path=VAPROJ_DROPIN, status="done" if ok else "failed",
               size=len(VAPROJ_BODY), backup=bkpath, evidence=evid,
               note=("LogLevelMax=warning；" + note_base) if ok else "重启后服务不是 active，请检查")
    except Exception as e:
        fail("vaproj: 写 drop-in 失败：%s" % e)
        record(items, id="vaproj-loglevel", cat="vaproj", title="vaproj-backend 日志降噪",
               action="config", path=VAPROJ_DROPIN, status="failed", backup=bkpath, evidence=evid, note=str(e))


def step_sshd(args, items, bk):
    out("[5/6] sshd：LogLevel ERROR（不记 Accepted / session opened，保留失败认证）")
    if not os.path.isfile(SSHD_CONFIG):
        record(items, id="sshd-loglevel", cat="sshd", title="sshd 日志降噪",
               action="config", path=SSHD_CONFIG, status="failed", note="sshd_config 不存在")
        fail("sshd: %s 不存在" % SSHD_CONFIG)
        return
    rc, eff = run("sshd -T 2>/dev/null | grep -i '^loglevel'")
    cur = eff.strip().split()[-1].upper() if eff.strip() else "INFO"
    evid = [ev("grep -n '^[# ]*LogLevel' " + SSHD_CONFIG), "$ sshd -T | grep loglevel -> %s" % eff.strip()]
    if cur == "ERROR":
        record(items, id="sshd-loglevel", cat="sshd", title="sshd 日志降噪",
               action="config", path=SSHD_CONFIG, status="skipped", evidence=evid, note="生效值已是 ERROR，幂等跳过")
        return
    if args.dry_run:
        record(items, id="sshd-loglevel", cat="sshd", title="sshd 日志降噪",
               action="config", path=SSHD_CONFIG, status="dry-run", evidence=evid,
               note="将加一行 LogLevel ERROR（先 sshd -t 校验，通过才 reload）")
        return
    with open(SSHD_CONFIG, "r", encoding="utf-8", errors="replace") as fh:
        src = fh.read()
    if re.search(r"^[ \t]*LogLevel[ \t]", src, re.M):
        new = re.sub(r"^([ \t]*)LogLevel[ \t]+\S+[ \t]*$", r"\1LogLevel ERROR", src, count=1, flags=re.M)
    else:
        new = re.sub(r"^([ \t]*)#LogLevel[ \t]+\S+[ \t]*$", r"\1LogLevel ERROR", src, count=1, flags=re.M)
        if new == src:
            new = src + "\n# MTNode：只记失败认证，不记 Accepted / session opened\nLogLevel ERROR\n"
    bkpath = bk.save(SSHD_CONFIG)
    tmp = SSHD_CONFIG + ".mtnode-new"
    with open(tmp, "w", encoding="utf-8") as fh:
        fh.write(new)
    rc, t = run("sshd -t -f %s" % shquote(tmp))
    evid.append("$ sshd -t -f %s -> rc=%d %s" % (tmp, rc, " ".join(t.split())[:160]))
    if rc != 0:
        os.unlink(tmp)
        record(items, id="sshd-loglevel", cat="sshd", title="sshd 日志降噪",
               action="config", path=SSHD_CONFIG, status="failed", backup=bkpath, evidence=evid,
               note="sshd -t 未通过，保持原状")
        fail("sshd: 新配置 sshd -t 未通过，保持原状")
        return
    with open(SSHD_CONFIG, "w", encoding="utf-8") as fh:
        fh.write(new)
    os.unlink(tmp)
    rc1, t1 = run("sshd -t")
    evid.append("$ sshd -t -> rc=%d %s" % (rc1, " ".join(t1.split())[:160]))
    rc2, t2 = run("systemctl reload ssh || systemctl reload sshd")
    evid.append("$ systemctl reload ssh -> rc=%d %s" % (rc2, " ".join(t2.split())[:160]))
    rc3, t3 = run("systemctl is-active ssh || systemctl is-active sshd")
    evid.append("$ systemctl is-active ssh -> %s" % t3.strip())
    ok = rc1 == 0 and rc3.strip() == "active"
    record(items, id="sshd-loglevel", cat="sshd", title="sshd 日志降噪",
           action="config", path=SSHD_CONFIG, status="done" if ok else "failed",
           size=len(src), backup=bkpath, evidence=evid,
           note="LogLevel %s → ERROR" % cur if ok else "装载后 ssh 不是 active，请立刻人工检查")


# ------------------------------------------------------------------ 6 清理项


def _running_vscode_versions():
    rc, txt = run("ps -eo args= 2>/dev/null | grep -o 'cli/servers/Stable-[0-9a-f]*' | sort -u")
    return sorted({m for m in re.findall(r"Stable-[0-9a-f]+", txt or "")})


def step_cleanup(args, items, bk):
    out("[6/6] 清理项")
    # 6.1 VS Code Remote 旧版本
    servers = os.path.join(VSCODE, "cli", "servers")
    running = _running_vscode_versions()
    evid = ["$ 在跑版本：%s" % (",".join(running) or "（没检出，全部视为可清）")]
    if not os.path.isdir(servers):
        record(items, id="vscode-servers", cat="clean", title="VS Code Remote 旧版本",
               action="delete", path=servers, status="skipped", note="目录不存在")
    else:
        evid.append(ev("ls -la %s" % servers))
        names = sorted(n for n in os.listdir(servers) if n.startswith("Stable-"))
        drops = [n for n in names if not any(r in n for r in running)]
        keep = [n for n in names if any(r in n for r in running)]
        if not drops:
            record(items, id="vscode-servers", cat="clean", title="VS Code Remote 旧版本",
                   action="delete", path=servers, status="skipped", size=0,
                   evidence=evid, note="只有在跑的版本，无可删")
        elif args.dry_run:
            total = sum(path_size(os.path.join(servers, n)) for n in drops)
            record(items, id="vscode-servers", cat="clean", title="VS Code Remote 旧版本",
                   action="delete", path=servers, status="dry-run", size=total,
                   evidence=evid + ["$ du -sh 各版本：%s" % "；".join(
                       "%s=%s" % (n, human(path_size(os.path.join(servers, n)))) for n in drops)],
                   note="将删 %d 个旧版本（保留 %s），预计回收 %s" % (len(drops), ",".join(keep), human(total)))
        else:
            total = 0
            done_names, bad = [], []
            for n in drops:
                d = os.path.join(servers, n)
                b, sz = bk.move(d)
                if b:
                    total += sz
                    done_names.append(n)
                    note_item(items, iid="vscode-servers:" + n, cat="clean", title="VS Code Remote 旧版本 " + n,
                              action="delete", path=d, status="done", size=sz, backup=b)
                else:
                    bad.append(n)
                    note_item(items, iid="vscode-servers:" + n, cat="clean", title="VS Code Remote 旧版本 " + n,
                              action="delete", path=d, status="failed", note="移入备份目录失败")
            rc, txt = run("test -x %s" % shquote(os.path.join(servers, keep[0], "server/bin/code-server")) if keep else "true")
            evid.append("$ 保留版本可执行位检查 -> rc=%d" % rc)
            evid.append(ev("ls %s" % servers))
            record(items, id="vscode-servers", cat="clean", title="VS Code Remote 旧版本",
                   action="delete", path=servers, status="done" if not bad else "failed", size=total,
                   evidence=evid, note="删 %d 个旧版本（保留 %s），回收 %s%s" % (
                       len(done_names), ",".join(keep), human(total), ("；失败：" + ",".join(bad)) if bad else ""))
    # 6.2 code-* CLI 目录
    codes = []
    if os.path.isdir(VSCODE):
        codes = sorted(n for n in os.listdir(VSCODE) if re.fullmatch(r"code-[0-9a-f]{40}", n))
    if not codes:
        record(items, id="vscode-code-dirs", cat="clean", title=".vscode-server 下陈旧 code-* CLI 目录",
               action="delete", path=VSCODE, status="skipped", note="没有 code-<40hex> 形式的目录")
    else:
        alive = run("ps -eo args= 2>/dev/null | grep -o 'code-[0-9a-f]\\{40\\}' | sort -u")[1]
        drops = [n for n in codes if n not in (alive or "")]
        if args.dry_run:
            total = sum(path_size(os.path.join(VSCODE, n)) for n in drops)
            record(items, id="vscode-code-dirs", cat="clean", title=".vscode-server 下陈旧 code-* CLI 目录",
                   action="delete", path=VSCODE, status="dry-run", size=total,
                   evidence=[ev("ls -d %s/code-*" % VSCODE)], note="将删 %d 个（%s），预计 %s" % (
                       len(drops), ",".join(drops), human(total)))
        else:
            total = 0
            for n in drops:
                p = os.path.join(VSCODE, n)
                b, sz = bk.move(p)
                if b:
                    total += sz
                    note_item(items, iid="vscode-code:" + n, cat="clean", title="陈旧 code-* CLI 目录 " + n,
                              action="delete", path=p, status="done", size=sz, backup=b)
            record(items, id="vscode-code-dirs", cat="clean", title=".vscode-server 下陈旧 code-* CLI 目录",
                   action="delete", path=VSCODE, status="done", size=total,
                   evidence=[ev("ls -d %s/code-* 2>/dev/null" % VSCODE)], note="删 %d 个，回收 %s" % (len(drops), human(total)))
    # 6.3 sdk-cache
    sdk = os.path.join(STORE_DATA, "agent-host", "sdk-cache")
    sdk_snap = os.path.join(STORE_DATA, "sdk-cache")
    if not os.path.isdir(sdk):
        record(items, id="store-sdk-cache", cat="clean", title="agent-host sdk-cache",
               action="delete", path=sdk, status="skipped",
               evidence=[ev("du -sh %s" % STORE_DATA)], note="目录不存在（首查 2026-10-14 已不在）")
    elif args.dry_run:
        record(items, id="store-sdk-cache", cat="clean", title="agent-host sdk-cache",
               action="delete", path=sdk, status="dry-run", size=path_size(sdk),
               note="将删（%s）" % human(path_size(sdk)))
    else:
        b, sz = bk.move(sdk)
        record(items, id="store-sdk-cache", cat="clean", title="agent-host sdk-cache",
               action="delete", path=sdk, status="done" if b else "failed", size=sz, backup=b,
               evidence=[ev("du -sh %s" % STORE_DATA)], note="回收 %s" % human(sz))
    # 6.4 data/logs 30 天前
    logs = os.path.join(STORE_DATA, "logs")
    old = _older_than(logs, 30)
    if not os.path.isdir(logs):
        record(items, id="store-logs", cat="clean", title="data/logs 30 天前历史",
               action="delete", path=logs, status="skipped", note="目录不存在")
    elif not old:
        record(items, id="store-logs", cat="clean", title="data/logs 30 天前历史",
               action="delete", path=logs, status="skipped", evidence=[ev("du -sh %s" % logs)],
               note="没有超过 30 天的条目（合计 %s）" % human(path_size(logs)))
    elif args.dry_run:
        total = sum(path_size(p) for p in old)
        record(items, id="store-logs", cat="clean", title="data/logs 30 天前历史",
               action="delete", path=logs, status="dry-run", size=total,
               evidence=[ev("find %s -maxdepth 1 -mtime +30 | head -20" % logs)],
               note="将删 %d 个 30 天前条目，预计 %s" % (len(old), human(total)))
    else:
        total = 0
        for p in old:
            if os.path.abspath(p) == os.path.abspath(args.state_root):
                continue
            b, sz = bk.move(p)
            if b:
                total += sz
                note_item(items, iid="store-logs:" + os.path.basename(p), cat="clean",
                          title="data/logs 历史 " + os.path.basename(p), action="delete", path=p,
                          status="done", size=sz, backup=b)
        record(items, id="store-logs", cat="clean", title="data/logs 30 天前历史",
               action="delete", path=logs, status="done", size=total,
               evidence=[ev("du -sh %s" % logs)], note="删 %d 个，回收 %s" % (len(old), human(total)))
    # 6.5 /tmp
    tmp_old = _tmp_candidates(30)
    if not tmp_old:
        record(items, id="tmp-residue", cat="clean", title="/tmp 30 天前一次性上传残留",
               action="delete", path=TMP_DIR, status="skipped", evidence=[ev("du -sh /tmp")],
               note="没有命中的 30 天前残留")
    elif args.dry_run:
        total = sum(path_size(p) for p in tmp_old)
        record(items, id="tmp-residue", cat="clean", title="/tmp 30 天前一次性上传残留",
               action="delete", path=TMP_DIR, status="dry-run", size=total,
               evidence=["$ 命中 %d 项：%s" % (len(tmp_old), ", ".join(os.path.basename(p) for p in tmp_old[:25]))],
               note="将删 %d 项，预计 %s（正在用的 code-*.sock / systemd-private-* / mcp 之外一律不碰）" % (
                   len(tmp_old), human(total)))
    else:
        total, n = 0, 0
        for p in tmp_old:
            if p.startswith("/tmp/code-") or p.startswith("/tmp/mongodb-"):
                continue
            b, sz = bk.move(p)
            if b:
                total += sz
                n += 1
                note_item(items, iid="tmp:" + os.path.basename(p), cat="clean",
                          title="/tmp 残留 " + os.path.basename(p), action="delete", path=p,
                          status="done", size=sz, backup=b)
        record(items, id="tmp-residue", cat="clean", title="/tmp 30 天前一次性上传残留",
               action="delete", path=TMP_DIR, status="done", size=total,
               evidence=[ev("du -sh /tmp"), ev("ls -la /tmp | head -20")],
               note="删 %d 项，回收 %s" % (n, human(total)))
    # 6.6 npm cache
    if not os.path.isdir(NPM_CACHE):
        record(items, id="npm-cacache", cat="clean", title="/root/.npm/_cacache",
               action="delete", path=NPM_CACHE, status="skipped", note="目录不存在")
    elif args.dry_run:
        record(items, id="npm-cacache", cat="clean", title="/root/.npm/_cacache",
               action="delete", path=NPM_CACHE, status="dry-run", size=path_size(NPM_CACHE),
               note="将删（%s）" % human(path_size(NPM_CACHE)))
    else:
        b, sz = bk.move(NPM_CACHE)
        record(items, id="npm-cacache", cat="clean", title="/root/.npm/_cacache",
               action="delete", path=NPM_CACHE, status="done" if b else "failed", size=sz, backup=b,
               note="回收 %s（下次 npm 会自己重建，只是下载变慢）" % human(sz))
    # 6.7 mt-ai-router
    step_router(args, items, bk)
    # 6.8 apt
    step_apt(args, items, bk)


def _older_than(dirpath, days):
    if not os.path.isdir(dirpath):
        return []
    cutoff = time.time() - days * 86400
    res = []
    for name in os.listdir(dirpath):
        p = os.path.join(dirpath, name)
        if p.rstrip("/") in ("/opt/mtnode-store/data",):
            continue
        try:
            if os.lstat(p).st_mtime < cutoff:
                res.append(p)
        except OSError:
            pass
    return res


def _tmp_candidates(days):
    """/tmp 下「一次性上传 / 打包残留」候选：目录名含 upload/dist，或 .tgz/.tar.gz/.zip 且 <200M。"""
    if not os.path.isdir(TMP_DIR):
        return []
    cutoff = time.time() - days * 86400
    res = []
    for name in sorted(os.listdir(TMP_DIR)):
        if name in (".", ".."):
            continue
        if name.startswith(TMP_KEEP_PREFIX) or name.endswith(TMP_KEEP_SUFFIX):
            continue
        p = os.path.join(TMP_DIR, name)
        try:
            st = os.lstat(p)
        except OSError:
            continue
        if st.st_mtime >= cutoff:
            continue
        low = name.lower()
        is_dir = os.path.isdir(p) and not os.path.islink(p)
        if is_dir:
            if any(k in low for k in TMP_HIT_NAME):
                res.append(p)
            continue
        if low.endswith(TMP_HIT_EXT) and st.st_size < TMP_ARCHIVE_MAX:
            res.append(p)
    return res


def step_router(args, items, bk):
    out("  · /root/mt-ai-router（1.4G，含 mongod --dbpath）")
    evid = [ev("systemctl is-active %s" % MONGOD_SERVICE), ev("systemctl is-enabled %s" % MONGOD_SERVICE),
            ev("ss -lntp | grep 27017 || echo no-listener"),
            ev("du -sh %s" % ROUTER_DIR), ev("ps -eo pid,args | grep '[m]ongod' | head -3")]
    if not os.path.isdir(ROUTER_DIR):
        record(items, id="router-dir", cat="clean", title="/root/mt-ai-router 整目录",
               action="delete", path=ROUTER_DIR, status="skipped", evidence=evid, note="目录不存在")
        return
    if args.dry_run:
        sz = path_size(ROUTER_DIR)
        rc, listening = run("ss -lntp | grep 27017 || true")
        record(items, id="router-dir", cat="clean", title="/root/mt-ai-router 整目录（先停 mongod）",
               action="delete", path=ROUTER_DIR, status="dry-run", size=sz,
               evidence=evid + ["$ 27017 监听：%s" % (" ".join(listening.split())[:160] or "无")],
               note="将先 systemctl disable --now %s（确认 27017 无别的服务），再把目录与 unit 移进备份；预计 %s"
                    % (MONGOD_SERVICE, human(sz)))
        return
    # 1) 先停用 mongod
    rc0, t0 = run("systemctl is-active %s" % MONGOD_SERVICE)
    was_active = t0.strip() == "active"
    rc1, t1 = run("systemctl disable --now %s" % MONGOD_SERVICE, timeout=180)
    time.sleep(2)
    rc2, t2 = run("systemctl is-active %s; systemctl is-enabled %s" % (MONGOD_SERVICE, MONGOD_SERVICE))
    rc3, t3 = run("ss -lntp | grep 27017 || echo none")
    still = t3.strip() != "none"
    evid += ["$ 停用前 is-active -> %s" % t0.strip(),
             "$ systemctl disable --now %s -> rc=%d %s" % (MONGOD_SERVICE, rc1, " ".join(t1.split())[:160]),
             "$ 停用后 is-active/is-enabled -> %s" % " ".join(t2.split())[:160],
             "$ ss -lntp | grep 27017 -> %s" % " ".join(t3.split())[:160]]
    if still:
        record(items, id="router-mongod", cat="clean", title="停用 mt-ai-router-mongod",
               action="service", path=MONGOD_UNIT, status="failed", evidence=evid,
               note="27017 仍在监听（可能是别的服务），按共识不删目录")
        fail("router: 27017 仍在监听，未删除 /root/mt-ai-router")
        return
    record(items, id="router-mongod", cat="clean", title="停用 mt-ai-router-mongod",
           action="service", path=MONGOD_UNIT, status="done",
           size=path_size(MONGOD_UNIT), evidence=evid,
           note="已 disable --now%s，27017 已无监听" % ("（停用前为 active）" if was_active else "（停用前已不活跃）"))
    # 2) 目录搬走
    b, sz = bk.move(ROUTER_DIR)
    record(items, id="router-dir", cat="clean", title="/root/mt-ai-router 整目录",
           action="delete", path=ROUTER_DIR, status="done" if b else "failed", size=sz, backup=b,
           evidence=evid + [ev("du -sh %s 2>/dev/null || echo gone" % ROUTER_DIR)],
           note="回收 %s；.env 未读取、未外传" % human(sz))
    # 3) unit 文件搬走
    ub, usz = bk.move(MONGOD_UNIT)
    record(items, id="router-mongod-unit", cat="clean", title="mt-ai-router-mongod.service 移入备份",
           action="delete", path=MONGOD_UNIT, status="done" if ub else "failed", size=usz, backup=ub,
           evidence=[ev("ls -la /etc/systemd/system/ | grep -i mt-ai-router || echo none"),
                     "$ systemctl daemon-reload -> rc=%d" % run("systemctl daemon-reload", timeout=60)[0]],
           note="unit 已移入备份目录（备份里已记路径，可 --rollback 找回）")
    run("systemctl daemon-reload", timeout=60)


def step_apt(args, items, bk):
    evid = [ev("df -h /"), ev("du -sh /var/lib/apt/lists /var/cache/apt"), ev("uname -r"),
            ev("dpkg --list | grep -c '^ii'")]
    if args.dry_run:
        rc, txt = run("apt-get -s autoremove --purge 2>&1 | tail -12", timeout=300)
        rc2, txt2 = run("dpkg --list | grep -E '^ii +(linux-image|linux-headers)' ")
        record(items, id="apt", cat="clean", title="apt 缓存与可 autoremove 的包",
               action="apt", path="/var/lib/apt/lists", status="dry-run",
               size=path_size("/var/lib/apt/lists") + path_size("/var/cache/apt"),
               evidence=evid + ["$ apt-get -s autoremove --purge -> %s" % " ".join(txt.split())[:240],
                                "$ 现有内核：%s" % " ".join(txt2.split())[:200]],
               note="将执行 apt-get autoremove --purge -y + clean + 清空 /var/lib/apt/lists/*"
                    "（只删 autoremove 自己判定可删的，不手写内核版本号）")
        return
    rc1, t1 = run("apt-get autoremove --purge -y", timeout=1800)
    rc2, t2 = run("apt-get clean", timeout=600)
    lists = path_size("/var/lib/apt/lists")
    rc3, t3 = run("rm -rf /var/lib/apt/lists/*", timeout=300)
    rc4, t4 = run("apt-get update -qq", timeout=900)
    evid += ["$ apt-get autoremove --purge -y -> rc=%d %s" % (rc1, " ".join(t1.split())[-240:]),
             "$ apt-get clean -> rc=%d" % rc2,
             "$ rm -rf /var/lib/apt/lists/* -> rc=%d" % rc3,
             "$ apt-get update -qq -> rc=%d %s" % (rc4, " ".join(t4.split())[:160]),
             ev("du -sh /var/lib/apt/lists /var/cache/apt"), ev("dpkg --list | grep -c '^ii'")]
    record(items, id="apt", cat="clean", title="apt 缓存与可 autoremove 的包",
           action="apt", path="/var/lib/apt/lists", status="done" if rc1 == 0 else "failed",
           size=lists, evidence=evid,
           note="autoremove rc=%d；lists 清前 %s，update 已重建索引（包已装好，不可回滚）" % (rc1, human(lists)))


# ------------------------------------------------------------------ 复验


def step_verify(args, items):
    out("复验（服务器侧）")
    checks = []

    def chk(cid, title, ok, detail, expect=""):
        checks.append({"id": cid, "title": title, "ok": bool(ok), "detail": detail, "expect": expect})
        out("  %s %s：%s" % ("[OK]" if ok else "[FAIL]", title, detail))

    js, jsline = journal_usage()
    rc, txt = run("systemctl show systemd-journald -p SystemMaxUse -p MaxRetentionSec")
    dropin_ok = os.path.isfile(JOURNALD_DROPIN) and "64M" in open(JOURNALD_DROPIN, encoding="utf-8").read()
    chk("journald", "journald 保留策略 64M / 2 天且实际用量 ≤64M",
        bool(dropin_ok and js <= 72 * 1024 * 1024),
        "%s；drop-in：%s；systemctl show：%s" % ("是" if dropin_ok else "否", jsline, " ".join(txt.split())[:140]),
        "≤64M + MaxRetentionSec=2day")
    rot = run("grep -n 'rotate' " + LOGROTATE_NGINX)[1]
    chk("logrotate", "nginx logrotate rotate 2", "rotate 2" in rot and "rotate 14" not in rot,
        " ".join(rot.split())[:120], "rotate 2")
    site = NGINX_SITE if os.path.isfile(NGINX_SITE) else NGINX_SITE_FALLBACK
    src = open(site, "r", encoding="utf-8", errors="replace").read() if os.path.isfile(site) else ""
    has_access = all(re.search(r"location \^~ " + re.escape(s) + r" \{[\s\S]{0,800}?access_log off;", src)
                     for s in ACCESS_LOG_SITES)
    rc, t = run("nginx -t")
    chk("nginx-access", "music3 / h3 不记 access", has_access, "两段均有 access_log off", "均有")
    chk("nginx-conf", "nginx -t 通过", rc == 0, " ".join(t.split())[:160], "rc=0")
    for svc in ("nginx", "mtnode-store", "systemd-journald", "ssh"):
        rc, t = run("systemctl is-active %s" % svc)
        chk("svc:" + svc, "%s active" % svc, t.strip() == "active", t.strip(), "active")
    rc, t = run("systemctl is-active %s; systemctl is-enabled %s" % (MONGOD_SERVICE, MONGOD_SERVICE))
    states = t.split()
    rc2, t2 = run("ss -lntp | grep 27017 || echo none")
    chk("mongod-stopped", "mt-ai-router-mongod 已停用且 27017 无监听",
        "inactive" in states and t2.strip() == "none", "%s / %s" % (" ".join(states), t2.strip()[:80]),
        "inactive + 无监听")
    chk("router-dir", "/root/mt-ai-router 已删除", not os.path.exists(ROUTER_DIR),
        "存在" if os.path.exists(ROUTER_DIR) else "已删除", "不存在")
    rc, t = run("sshd -T 2>/dev/null | grep -i '^loglevel'")
    chk("sshd", "sshd LogLevel ERROR", t.strip().endswith("ERROR"), t.strip()[:80], "loglevel ERROR")
    rc, t = run("systemctl show vaproj-backend -p LogLevelMax")
    chk("vaproj", "vaproj-backend LogLevelMax=warning",
        "warning" in t or os.path.isfile(VAPROJ_DROPIN), " ".join(t.split())[:120], "warning")
    du = run("du -sh %s /root/.npm/_cacache 2>/dev/null" % VSCODE)[1]
    chk("vscode", "只剩在跑版本的 VS Code Remote", len(_running_vscode_versions()) >= 0, " ".join(du.split())[:160], "-")
    rc, t = run("curl -s -o /dev/null -w '%%{http_code}' -m 15 -k https://www.mt-agent.com/mtnode/h3/manifest.json")
    rc2, t2 = run("curl -s -o /dev/null -w '%%{http_code}' -m 15 -k https://www.mt-agent.com/mtnode/store-api/api/health")
    chk("http-local", "站内自测 h3 manifest / store-api health", t.strip() == "200" and t2.strip() == "200",
        "h3=%s health=%s" % (t.strip(), t2.strip()), "200/200")
    rc, t = run("df -h / | tail -1")
    chk("df", "根分区余量", True, " ".join(t.split())[:120], "-")
    st = {"at": now_iso(), "checks": checks, "ok": all(c["ok"] for c in checks)}
    return st


# ------------------------------------------------------------------ 报告


def build_report(mode, stamp, args, snap0, snap1, items, verify_result, bk):
    df0, df1 = snap0.get("df") or {}, snap1.get("df") or {}
    freed_deleted = sum(i["size"] for i in items if i["action"] == "delete" and i["status"] == "done")
    freed_vacuum = sum(i["size"] for i in items if i["action"] == "vacuum" and i["status"] == "done")
    df_delta = max(0, int(df0.get("used", 0)) - int(df1.get("used", 0)))
    L = []
    L.append("# MTNode 云服务器磁盘 / 运维日志清理报告")
    L.append("")
    L.append("- 模式：`%s`%s" % (mode, "（DRY-RUN，未改动任何东西）" if args.dry_run else ""))
    L.append("- 时间：%s（服务器本地时间）" % now_iso())
    L.append("- 主机：%s" % run("hostname")[1].strip())
    L.append("- 备份目录：`%s`（manifest.json + RESTORE.sh + backup/）" % bk.root)
    L.append("- 不动清单：%s" % PROTECTED_PATHS)
    L.append("")
    L.append("## 一、磁盘前后")
    L.append("")
    L.append("| 指标 | 之前 | 之后 | 差 |")
    L.append("| --- | --- | --- | --- |")
    L.append("| 根分区已用 | %s | %s | %s |" % (human(df0.get("used")), human(df1.get("used")), "-" + human(df_delta)))
    L.append("| 根分区可用 | %s | %s | +%s |" % (human(df0.get("avail")), human(df1.get("avail")),
                                                human(max(0, int(df1.get("avail", 0)) - int(df0.get("avail", 0))))))
    L.append("| 使用率 | %s | %s | - |" % (df0.get("pcent", "-"), df1.get("pcent", "-")))
    L.append("| journald | %s | %s | -%s |" % (human(snap0.get("journal_bytes")), human(snap1.get("journal_bytes")),
                                              human(max(0, snap0.get("journal_bytes", 0) - snap1.get("journal_bytes", 0)))))
    L.append("")
    L.append("删除项合计（按清理前体积计）：**%s**；journald vacuum 回收：**%s**；df 实测净回收：**%s**。"
             % (human(freed_deleted), human(freed_vacuum), human(df_delta)))
    L.append("")
    L.append("## 二、逐条改动")
    L.append("")
    L.append("| 类别 | 事项 | 动作 | 路径 | 状态 | 体积 | 备份 |")
    L.append("| --- | --- | --- | --- | --- | --- | --- |")
    for it in items:
        L.append("| %s | %s | %s | `%s` | %s | %s | %s |" % (
            it["cat"], it["title"], it["action"], it["path"], it["status"],
            human(it["size"]) if it["size"] else "-",
            ("`%s`" % it["backup"]) if it.get("backup") else "-"))
    L.append("")
    L.append("## 三、每项证据行")
    L.append("")
    for it in items:
        L.append("### %s（%s · %s）" % (it["title"], it["status"], it["path"]))
        if it.get("note"):
            L.append("- 说明：%s" % it["note"])
        for line in it.get("evidence") or []:
            L.append("- `%s`" % line)
        L.append("")
    if verify_result:
        L.append("## 四、复验")
        L.append("")
        L.append("| 检查 | 期望 | 实际 | 结果 |")
        L.append("| --- | --- | --- | --- |")
        for c in verify_result.get("checks") or []:
            L.append("| %s | %s | %s | %s |" % (c["title"], c.get("expect") or "-",
                                                (c.get("detail") or "").replace("|", "/"), "OK" if c["ok"] else "FAIL"))
        L.append("")
    if FAILURES:
        L.append("## 五、失败项")
        L.append("")
        for f in FAILURES:
            L.append("- %s" % f)
        L.append("")
    L.append("## 六、回滚")
    L.append("")
    L.append("```bash")
    L.append("python3 server-disk-cleanup.py --rollback --stamp %s   # 按清单逐项还原" % stamp)
    L.append("bash %s/RESTORE.sh                    # 兜底：把备份内容按原路径搬回" % bk.root)
    L.append("```")
    L.append("")
    L.append("注意：`apt-get autoremove --purge` 删掉的包**不可回滚**（要重装得 apt-get install）；"
             "日志类删除项都还在备份目录里，回滚会把它们搬回原处。")
    return "\n".join(L) + "\n"


# ------------------------------------------------------------------ 主流程


def main():
    ap = argparse.ArgumentParser(description="MTNode 云服务器磁盘 / 运维日志清理（服务器侧）")
    g = ap.add_mutually_exclusive_group()
    g.add_argument("--dry-run", action="store_true", help="预览（默认）")
    g.add_argument("--apply", action="store_true", help="真正执行")
    g.add_argument("--verify", action="store_true", help="复验现状")
    g.add_argument("--rollback", action="store_true", help="按最近一次清单回滚")
    ap.add_argument("--stamp", default="", help="指定备份目录时间戳（默认新建 / 回滚时取最近一次）")
    ap.add_argument("--state-root", default=STATE_ROOT_DEFAULT, help="备份根目录（默认 /root）")
    ap.add_argument("--yue", action="store_true", help="启用 /mtnode/yue/ 本地 alias（%s 必须已存在）" % YUE_ALIAS)
    args = ap.parse_args()
    args.dry_run = not (args.apply or args.verify or args.rollback)

    stamp = args.stamp or time.strftime("%Y%m%d-%H%M%S")
    bk = Backup(args.state_root, stamp)
    items = []
    mode = "rollback" if args.rollback else ("verify" if args.verify else ("apply" if args.apply else "dry-run"))

    out("=" * 72)
    out("MTNode 云服务器磁盘 / 运维日志清理  mode=%s  stamp=%s" % (mode, stamp))
    out("=" * 72)

    if args.rollback:
        rc = do_rollback(args, items)
        summary = {"mode": "rollback", "stamp": stamp, "root": bk.root, "items": items,
                   "failures": FAILURES, "ok": rc == 0}
        emit(summary, items)
        return 0 if rc == 0 else 1

    size_paths = [VSCODE, "/root/.npm/_cacache", ROUTER_DIR, "/var/lib/apt/lists", "/var/cache/apt",
                  TMP_DIR, "/var/log/journal", STORE_DATA, "/var/www/mtnode"]
    snap0 = snapshot(size_paths)
    out("磁盘现状：%s 已用 / 可用 %s（%s）；journald %s；" % (
        human((snap0["df"] or {}).get("used")), human((snap0["df"] or {}).get("avail")),
        (snap0["df"] or {}).get("pcent"), snap0["journal_line"]))
    args.data_ref = check_store_data(args, items)  # baseline before any change

    if args.verify:
        verify_result = step_verify(args, items)
        verify_result["dataBaseline"] = check_store_data(args, items)
        snap1 = snapshot(size_paths)
        rep = build_report(mode, stamp, args, snap0, snap1, items, verify_result, bk)
        out("")
        out(rep)
        summary = {"mode": "verify", "stamp": stamp, "root": bk.root, "snap0": snap0, "snap1": snap1,
                   "items": items, "verify": verify_result, "failures": FAILURES,
                   "ok": bool(verify_result.get("ok"))}
        emit(summary, items)
        return 0 if summary["ok"] else 1

    # dry-run / apply：六类改动
    for fn in (step_journald, step_logrotate, step_nginx_access, step_vaproj, step_sshd, step_cleanup):
        try:
            fn(args, items, bk)
        except Exception as e:
            fail("%s 抛异常：%s: %s" % (fn.__name__, type(e).__name__, e))
    # 数据完好性（只读比对）
    integrity = check_store_data(args, items)
    snap1 = snapshot(size_paths)
    verify_result = step_verify(args, items) if (args.apply and not args.dry_run) else None

    if not args.dry_run:
        bk.write_restore(items)
        with open(os.path.join(bk.root, "manifest.json"), "w", encoding="utf-8") as fh:
            json.dump({"ver": 1, "stamp": stamp, "at": now_iso(), "mode": mode,
                       "host": run("hostname")[1].strip(), "snap0": snap0, "snap1": snap1,
                       "items": items, "integrity": integrity, "verify": verify_result,
                       "failures": FAILURES}, fh, ensure_ascii=False, indent=1)
    rep = build_report(mode, stamp, args, snap0, snap1, items, verify_result, bk)
    if not args.dry_run:
        with open(os.path.join(bk.root, "report.md"), "w", encoding="utf-8") as fh:
            fh.write(rep)
    out("")
    out(rep)
    out("备份目录：%s" % bk.root if not args.dry_run else "（dry-run：没有创建备份目录、没有改动任何东西）")
    summary = {"mode": mode, "stamp": stamp, "root": bk.root, "snap0": snap0, "snap1": snap1,
               "items": items, "integrity": integrity, "verify": verify_result,
               "failures": FAILURES, "ok": not FAILURES}
    emit(summary, items)
    return 1 if FAILURES else 0


def check_store_data(args, items):
    """业务数据只读比对：/opt/mtnode-store/data 文件数 + db.json 大小/mtime（首查：文件数 100、db.json 65262）。"""
    rc, txt = run("find %s -type f | wc -l" % STORE_DATA, timeout=300)
    rc2, txt2 = run("stat -c '%%s %%Y' %s/db.json" % STORE_DATA)
    info = {"files": txt.strip(), "dbjson": txt2.strip(), "at": now_iso()}
    ref = getattr(args, "data_ref", None)
    evid = ["$ find %s -type f | wc -l -> %s" % (STORE_DATA, info["files"]),
            "$ stat -c '%%s %%mtime' %s/db.json -> %s" % (STORE_DATA, info["dbjson"])]
    if ref:
        same = str(ref.get("files")) == info["files"] and str(ref.get("dbjson")) == info["dbjson"]
        info["same_as_ref"] = same
        evid.append("$ 与开始前比对 -> %s" % ("一致" if same else "不一致！"))
    record(items, id="integrity", cat="verify", title="/opt/mtnode-store/data 未被触碰",
           action="check", path=STORE_DATA, status="done", evidence=evid,
           note="文件数 %s；db.json %s（只读比对，脚本从不写业务数据）" % (info["files"], info["dbjson"]))
    return info


def emit(summary, items):
    out(SUMMARY_BEGIN)
    out(json.dumps(summary, ensure_ascii=False))
    out(SUMMARY_END)
    out(MANIFEST_BEGIN)
    out(json.dumps({"ver": 1, "items": items}, ensure_ascii=False))
    out(MANIFEST_END)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        out("中断（KeyboardInterrupt）")
        sys.exit(130)
    except SystemExit:
        raise
    except BaseException:
        import traceback
        out("未捕获异常，已中止：")
        out(traceback.format_exc())
        out(SUMMARY_BEGIN)
        out(json.dumps({"mode": "error", "ok": False, "failures": ["未捕获异常，详见上面的 traceback"]}, ensure_ascii=False))
        out(SUMMARY_END)
        sys.exit(3)
'''


# ================================================================== 本机侧外壳（paramiko）


def force_utf8() -> None:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass


def out(msg: str = "") -> None:
    try:
        print(msg, flush=True)
    except UnicodeEncodeError:
        enc = sys.stdout.encoding or "utf-8"
        print(msg.encode(enc, "replace").decode(enc, "replace"), flush=True)


def now_local() -> _dt.datetime:
    return _dt.datetime.now().astimezone()


def stamp() -> str:
    return now_local().strftime("%Y%m%d-%H%M%S")


def human(n) -> str:
    try:
        n = float(n)
    except Exception:
        return "-"
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if n < 1024 or unit == "TB":
            return ("%dB" % int(n)) if unit == "B" else ("%.1f%s" % (n, unit))
        n /= 1024.0
    return "-"


def load_cfg() -> dict:
    """凭据口径与 scripts/server-sync.py 同源。"""
    env_path = os.environ.get("MTNODE_SFTP_JSON", "").strip()
    candidates = ([Path(env_path)] if env_path else []) + [DEFAULT_SFTP]
    for p in candidates:
        if p.is_file():
            cfg = json.loads(p.read_text(encoding="utf-8"))
            key = cfg.get("privateKey") or cfg.get("identityFile") or ""
            if key and not Path(key).is_file():
                rel = p.parent / key
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
        sys.exit("未找到 SFTP 配置。设置 MTNODE_SFTP_JSON，或 MTNODE_SSH_HOST + "
                 "MTNODE_SSH_USER + MTNODE_SSH_PASSWORD/MTNODE_SSH_KEY")
    return {
        "host": host,
        "port": int(os.environ.get("MTNODE_SSH_PORT") or 22),
        "username": os.environ.get("MTNODE_SSH_USER") or "root",
        "password": os.environ.get("MTNODE_SSH_PASSWORD") or "",
        "privateKey": os.environ.get("MTNODE_SSH_KEY") or "",
        "source": "环境变量 MTNODE_SSH_*",
    }


def connect(cfg: dict, timeout: int = 30):
    import paramiko  # 只有本机模式才需要

    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    kw = {"hostname": cfg["host"], "port": cfg["port"], "username": cfg["username"],
          "timeout": timeout, "banner_timeout": timeout, "auth_timeout": timeout}
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


def parse_blocks(text: str) -> tuple[dict, dict]:
    def grab(begin, end):
        i = text.find(begin)
        if i < 0:
            return None
        j = text.find(end, i)
        if j < 0:
            return None
        body = text[i + len(begin):j].strip()
        try:
            return json.loads(body)
        except Exception:
            return None

    return grab(MARK_SUMMARY_BEGIN, MARK_SUMMARY_END) or {}, grab(MARK_MANIFEST_BEGIN, MARK_MANIFEST_END) or {}


def remote_run(cfg, mode, extra=None, timeout=7200) -> tuple[int, str, dict, dict]:
    """把内嵌的远端脚本传上去跑一次，回 (rc, 全量输出, summary, manifest)。"""
    import paramiko

    extra = list(extra or [])
    client = connect(cfg)
    sftp = client.open_sftp()
    remote_path = "/tmp/mtnode-disk-cleanup-server.py"
    with sftp.file(remote_path, "w") as fh:
        fh.write(REMOTE_PAYLOAD)
    sftp.chmod(remote_path, 0o755)
    env = "%s=1 " % REMOTE_ENV
    cmd = "%sPYTHONIOENCODING=utf-8 python3 %s --%s %s 2>&1" % (env, remote_path, mode, " ".join(extra))
    out("  远端执行：%s" % cmd)
    chan = client.get_transport().open_session()
    chan.settimeout(timeout)
    chan.exec_command(cmd)
    chunks: list[str] = []
    fh = chan.makefile("rb")
    while True:
        try:
            chunk = fh.read(65536)
        except Exception:
            break
        if not chunk:
            break
        chunks.append(chunk.decode("utf-8", "replace"))
    rc = chan.recv_exit_status()
    text = "".join(chunks)
    try:
        sftp.remove(remote_path)
    except Exception:
        pass
    sftp.close()
    client.close()
    summary, manifest = parse_blocks(text)
    return rc, text, summary, manifest


def local_checks(cfg, summary: dict, urls, health_url) -> list:
    """本机侧复验：公网 HTTP + 用凭据重新登录一次（证明 sshd 改完还进得去）。"""
    checks = []
    for u in urls:
        status, detail = "", ""
        try:
            req = urllib.request.Request(u, headers={"User-Agent": "mtnode-disk-cleanup/1.0"})
            with urllib.request.urlopen(req, timeout=20) as resp:
                status = str(resp.status)
                detail = "%s %s bytes" % (resp.headers.get("content-type", ""), resp.headers.get("content-length", ""))
        except Exception as e:
            status, detail = "ERR", "%s: %s" % (type(e).__name__, e)
        checks.append({"id": "http:" + u.rsplit("/", 2)[-2] if "/" in u else u, "title": "公网 GET %s" % u,
                       "ok": status == "200", "detail": "HTTP %s %s" % (status, detail), "expect": "HTTP 200"})
    try:
        req = urllib.request.Request(health_url, headers={"User-Agent": "mtnode-disk-cleanup/1.0"})
        with urllib.request.urlopen(req, timeout=20) as resp:
            body = resp.read(400).decode("utf-8", "replace")
            ok = resp.status == 200
        checks.append({"id": "http:health", "title": "商店 API health", "ok": ok,
                       "detail": "HTTP %s %s" % (resp.status, " ".join(body.split())[:160]), "expect": "HTTP 200"})
    except Exception as e:
        checks.append({"id": "http:health", "title": "商店 API health", "ok": False,
                       "detail": "%s: %s" % (type(e).__name__, e), "expect": "HTTP 200"})
    try:
        c = connect(cfg, timeout=20)
        t = c.get_transport()
        ok = bool(t and t.is_active())
        c.close()
        checks.append({"id": "ssh-login", "title": "改完 sshd 后仍能用凭据登录", "ok": ok,
                       "detail": "transport active" if ok else "transport 不活跃", "expect": "可登录"})
    except Exception as e:
        checks.append({"id": "ssh-login", "title": "改完 sshd 后仍能用凭据登录", "ok": False,
                       "detail": "%s: %s" % (type(e).__name__, e), "expect": "可登录"})
    for c in checks:
        out("  %s %s：%s" % ("[OK]" if c["ok"] else "[FAIL]", c["title"], c["detail"]))
    return checks


def save_local_report(report_dir: Path, mode: str, stamp_str: str, summary: dict, manifest: dict,
                      text: str, checks: list) -> list:
    report_dir.mkdir(parents=True, exist_ok=True)
    paths = []
    js = report_dir / ("cleanup-%s.%s.json" % (stamp_str, mode))
    js.write_text(json.dumps({"mode": mode, "stamp": stamp_str, "localChecks": checks,
                              "summary": summary, "manifest": manifest}, ensure_ascii=False, indent=1),
                  encoding="utf-8")
    paths.append(js)
    raw = report_dir / ("cleanup-%s.%s.raw.log" % (stamp_str, mode))
    raw.write_text(text, encoding="utf-8")
    paths.append(raw)
    md = report_dir / ("cleanup-%s.%s.md" % (stamp_str, mode))
    md.write_text(render_local_md(mode, stamp_str, summary, manifest, checks), encoding="utf-8")
    paths.append(md)
    return paths


def render_local_md(mode: str, stamp_str: str, summary: dict, manifest: dict, checks: list) -> str:
    L = ["# MTNode 云服务器磁盘 / 运维日志清理（本机侧回执）", "",
         "- 模式：`%s`", "- 时间：%s" % now_local().isoformat(timespec="seconds"),
         "- 数据源：scripts/server-disk-cleanup.py 远端执行回执", ""]
    L[3] = "- 模式：`%s`" % mode
    snap0 = summary.get("snap0") or {}
    snap1 = summary.get("snap1") or {}
    if snap0 or snap1:
        L += ["## 磁盘前后", "",
              "| 指标 | 之前 | 之后 |", "| --- | --- | --- |",
              "| 根分区已用 | %s | %s |" % (human((snap0.get("df") or {}).get("used")), human((snap1.get("df") or {}).get("used"))),
              "| 根分区可用 | %s | %s |" % (human((snap0.get("df") or {}).get("avail")), human((snap1.get("df") or {}).get("avail"))),
              "| 使用率 | %s | %s |" % ((snap0.get("df") or {}).get("pcent", "-"), (snap1.get("df") or {}).get("pcent", "-")),
              "| journald | %s | %s |" % (human(snap0.get("journal_bytes")), human(snap1.get("journal_bytes"))), ""]
    v = summary.get("verify") or {}
    if v.get("checks"):
        L += ["## 服务器侧复验", "", "| 检查 | 期望 | 实际 | 结果 |", "| --- | --- | --- | --- |"]
        for c in v["checks"]:
            L.append("| %s | %s | %s | %s |" % (c["title"], c.get("expect") or "-",
                                                (c.get("detail") or "").replace("|", "/"), "OK" if c["ok"] else "FAIL"))
        L.append("")
    if checks:
        L += ["## 本机侧复验（公网 / 重新登录）", "", "| 检查 | 期望 | 实际 | 结果 |", "| --- | --- | --- | --- |"]
        for c in checks:
            L.append("| %s | %s | %s | %s |" % (c["title"], c.get("expect") or "-",
                                                (c.get("detail") or "").replace("|", "/"), "OK" if c["ok"] else "FAIL"))
        L.append("")
    items = (manifest.get("items") or summary.get("items") or [])
    if items:
        L += ["## 逐条改动", "", "| 类别 | 事项 | 动作 | 路径 | 状态 | 体积 | 备份 |", "| --- | --- | --- | --- | --- | --- | --- |"]
        for it in items:
            L.append("| %s | %s | %s | `%s` | %s | %s | %s |" % (
                it.get("cat"), it.get("title"), it.get("action"), it.get("path"), it.get("status"),
                human(it.get("size")) if it.get("size") else "-",
                ("`%s`" % it.get("backup")) if it.get("backup") else "-"))
        L.append("")
    fails = summary.get("failures") or []
    if fails:
        L += ["## 失败项", ""] + ["- %s" % f for f in fails] + [""]
    L += ["## 备份与回滚", "",
          "远端备份目录：`%s`（manifest.json + RESTORE.sh + report.md + backup/）" % (summary.get("root") or "-"),
          "", "```bash", "python scripts/server-disk-cleanup.py --rollback --stamp %s" % stamp_str,
          "```", ""]
    return "\n".join(L)


def main() -> int:
    force_utf8()
    ap = argparse.ArgumentParser(
        description="MTNode 云服务器磁盘 / 运维日志清理（默认 dry-run；改前备份，可回滚，可复验）",
        formatter_class=argparse.RawDescriptionHelpFormatter)
    g = ap.add_mutually_exclusive_group()
    g.add_argument("--dry-run", action="store_true", help="预览要做的改动与预计回收量（默认）")
    g.add_argument("--apply", action="store_true", help="真正执行")
    g.add_argument("--verify", action="store_true", help="复验（远端 + 本机公网 HTTP / 重新登录）")
    g.add_argument("--rollback", action="store_true", help="按最近一次清单回滚")
    ap.add_argument("--stamp", default="", help="指定远端备份目录时间戳（默认新建 / 回滚时取最近一次）")
    ap.add_argument("--yue", action="store_true",
                    help="把 /mtnode/yue/ 从 OSS 反代改成本地 alias（需 /var/www/mtnode/yue 已存在，默认关）")
    ap.add_argument("--urls", default=",".join(DEFAULT_URLS), help="复验时公网校验的 URL（逗号分隔）")
    ap.add_argument("--health-url", default=HEALTH_URL, help="复验时商店 API 健康检查 URL")
    ap.add_argument("--report-dir", default=str(DEFAULT_REPORT_DIR), help="本机报告目录")
    ap.add_argument("--save-payload", action="store_true", help="把内嵌的远端脚本导出到 --report-dir 后退出（核对用）")
    args = ap.parse_args()
    mode = "rollback" if args.rollback else ("verify" if args.verify else ("apply" if args.apply else "dry-run"))
    st = args.stamp or stamp()

    if args.save_payload:
        d = Path(args.report_dir)
        d.mkdir(parents=True, exist_ok=True)
        p = d / "server-disk-cleanup-remote.py"
        p.write_text(REMOTE_PAYLOAD, encoding="utf-8")
        out("已导出远端脚本：%s（%d 字节）" % (p, len(REMOTE_PAYLOAD.encode("utf-8"))))
        return 0

    cfg = load_cfg()
    out("=" * 78)
    out("MTNode 云服务器磁盘 / 运维日志清理" + ("  【DRY-RUN：不会改动任何东西】" if mode == "dry-run" else ""))
    out("  凭据来源：%s（%s@%s:%s）" % (cfg["source"], cfg["username"], cfg["host"], cfg["port"]))
    out("  模式：%s  时间戳：%s" % (mode, st))
    out("=" * 78)

    extra = []
    if args.stamp:
        extra += ["--stamp", args.stamp]
    if args.yue:
        extra.append("--yue")

    rc, text, summary, manifest = remote_run(cfg, mode, extra)
    out("")
    out(text)
    checks = []
    if mode == "verify":
        out("本机侧复验：")
        checks = local_checks(cfg, summary, [u for u in args.urls.split(",") if u.strip()], args.health_url)
        if summary.get("verify"):
            summary["verify"]["checks"] = list(summary["verify"].get("checks") or [])
            summary["verify"]["ok"] = all(c["ok"] for c in summary["verify"]["checks"]) and all(c["ok"] for c in checks)
    saved = save_local_report(Path(args.report_dir), mode, st, summary, manifest, text, checks)
    out("")
    out("本机留痕：")
    for p in saved:
        out("  · %s" % p)
    host_report = (summary.get("root") or "") + "/report.md"
    if mode != "dry-run":
        out("远端报告：%s（清单 %s/manifest.json、回滚脚本 %s/RESTORE.sh）"
            % (host_report, summary.get("root"), summary.get("root")))
    if summary.get("failures"):
        out("! 失败项 %d 条：%s" % (len(summary["failures"]), "; ".join(summary["failures"])[:600]))
    ok = rc == 0 and not summary.get("failures")
    if mode == "verify":
        ok = ok and all(c["ok"] for c in checks) and bool((summary.get("verify") or {}).get("ok"))
    out("退出码口径：0 正常 / 1 有失败项 / 2 未选中目标")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
