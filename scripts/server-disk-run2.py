#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""在服务器上按指定模式运行远端 payload（可注入补丁），回传原始输出并落盘。

用法（本机）：
  python scripts/server-disk-run2.py --mode sshd-diag
  python scripts/server-disk-run2.py --mode apply  [--patch note_item,verify]
  python scripts/server-disk-run2.py --mode verify [--patch note_item,verify]
  python scripts/server-disk-run2.py --remote-cmd "<shell 命令>"
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import time
from pathlib import Path

import paramiko

ROOT = Path(__file__).resolve().parent
OUTER = ROOT / "server-disk-cleanup.py"
CRED = Path(r"E:\dev\tools\ssh\sftp-mtnode-store.json")
REPORTS = ROOT / "server-disk-reports"
REMOTE_PAYLOAD = "/tmp/mtnode-disk-cleanup-server.py"
REMOTE_WRAP = "/tmp/mtnode-disk-cleanup-wrap.py"
REMOTE_OUT = "/tmp/mtnode-disk-cleanup-out.txt"
REMOTE_DIAG = "/tmp/mtnode-disk-cleanup-diag.py"

# ------------------------------------------------------------------ 补丁

PATCH_NOTE_ITEM = '''
# ---- patch: note_item 收 iid= 关键字（原实现只收 id=，调用方却传 iid=）----
_orig_note_item = note_item
def note_item(items, id="", cat="", title="", action="", path="", status="", size=0,
              backup="", evidence=None, note="", iid=None):
    return _orig_note_item(items, id=(iid or id), cat=cat, title=title, action=action, path=path,
                           status=status, size=size, backup=backup, evidence=evidence, note=note)
'''

PATCH_VERIFY = '''
# ---- patch: 站内自测的 curl 格式串被写成了 %%{http_code}，字面量下发 ----
_orig_run_for_verify = run
def run(cmd, timeout=600, check=False):
    if "%%{http_code}" in cmd:
        cmd = cmd.replace("%%{http_code}", "%{http_code}")
    return _orig_run_for_verify(cmd, timeout=timeout, check=check)
'''

PATCH_TRACEBACK = '''
# ---- patch: 让 fail() 把完整 traceback 打出来（定位用）----
import traceback as _tb, sys as _sys
_fail_orig = fail
def fail(msg):
    _fail_orig(msg)
    et, ev, tb = _sys.exc_info()
    if tb is not None:
        _sys.stderr.write("---- traceback ----\\n")
        _tb.print_exception(et, ev, tb, file=_sys.stderr)
'''

PATCH_TMP_PREFIX = '''
# ---- patch: /tmp 可清判定里 "tmp" 前缀是笔误（会把 /tmp 自身与 tmp* 全放行）----
import tempfile as _tf  # noqa: F401
'''

DIAG_SSHD = r'''
import sys, types, importlib.util
spec = importlib.util.spec_from_file_location("pl", "/tmp/mtnode-disk-cleanup-server.py")
pl = importlib.util.module_from_spec(spec)
sys.modules["pl"] = pl
spec.loader.exec_module(pl)
print("payload file:", pl.__file__)
import inspect
print("run 源码首行:", inspect.getsource(pl.run).splitlines()[0])
rc, eff = pl.run("sshd -T 2>/dev/null | grep -i '^loglevel'")
print("run() ->", repr(rc), repr(eff), type(eff).__name__)
rc2, txt2 = pl.run("grep -n '^[# ]*LogLevel' /etc/ssh/sshd_config")
print("run2 ->", repr(rc2), repr(txt2)[:200])
print("note_item 签名:", str(inspect.signature(pl.note_item)))
print("sshd_config 现状:", open("/etc/ssh/sshd_config").read().splitlines()[27:31])
import os
print("mongod active:", pl.run("systemctl is-active mt-ai-router-mongod")[1])
print("router dir:", os.path.isdir("/root/mt-ai-router"))
print("vscode servers:", sorted(os.listdir("/root/.vscode-server/cli/servers")))
print("tmp candidates:", [os.path.basename(p) for p in pl._tmp_candidates(30)])
print("df:", pl.run("df -h / | tail -1")[1])
'''


def extract_payload() -> str:
    text = OUTER.read_text(encoding="utf-8")
    m = re.search(r"^REMOTE_PAYLOAD = r'''(.*?)^'''$", text, re.S | re.M)
    if not m:
        raise SystemExit("找不到 REMOTE_PAYLOAD 段")
    return m.group(1)


def connect() -> paramiko.SSHClient:
    cfg = json.loads(CRED.read_text(encoding="utf-8"))
    cli = paramiko.SSHClient()
    cli.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    cli.connect(cfg["host"], port=int(cfg.get("port", 22)), username=cfg["username"],
                key_filename=cfg["privateKey"], timeout=25)
    return cli


def rrun(cli, cmd, timeout=7200):
    _in, out, err = cli.exec_command(cmd, timeout=timeout)
    o = out.read().decode("utf-8", "replace")
    e = err.read().decode("utf-8", "replace")
    rc = out.channel.recv_exit_status()
    return rc, o, e


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--mode", default="")
    ap.add_argument("--stamp", default="")
    ap.add_argument("--patch", default="")
    ap.add_argument("--remote-cmd", default="")
    ap.add_argument("--cmd-file", default="")
    ap.add_argument("--tag", default="")
    args = ap.parse_args()

    payload = extract_payload()
    if args.cmd_file:
        args.remote_cmd = Path(args.cmd_file).read_text(encoding="utf-8")
    tag = args.tag or ("%s%s" % (args.mode, ("-" + args.patch.replace(",", "+")) if args.patch else ""))
    cli = connect()
    try:
        sftp = cli.open_sftp()
        with sftp.file(REMOTE_PAYLOAD, "w") as fh:
            fh.write(payload)
        if args.remote_cmd:
            rc, o, e = rrun(cli, args.remote_cmd, timeout=1800)
            REPORTS.mkdir(parents=True, exist_ok=True)
            p = REPORTS / ("remote-cmd.%s.log" % (args.tag or time.strftime("%Y%m%d-%H%M%S")))
            p.write_text("$ %s\n[rc=%d]\n%s\n%s\n" % (args.remote_cmd, rc, o, e), encoding="utf-8")
            print("rc=%d 留痕 %s" % (rc, p))
            print(o[-4000:])
            if e.strip():
                print("[stderr]\n" + e[-1500:])
            return rc
        if args.mode == "sshd-diag":
            with sftp.file(REMOTE_DIAG, "w") as fh:
                fh.write(DIAG_SSHD)
            rc, o, e = rrun(cli, "python3 %s 2>&1" % REMOTE_DIAG, timeout=600)
            print(o)
            if e.strip():
                print("[stderr]\n" + e)
            return rc

        patches = [x for x in (args.patch or "").split(",") if x]
        pre = []
        if "note_item" in patches:
            pre.append(PATCH_NOTE_ITEM)
        if "verify" in patches:
            pre.append(PATCH_VERIFY)
        if "traceback" in patches:
            pre.append(PATCH_TRACEBACK)
        flag = {"apply": "--apply", "verify": "--verify", "dry-run": "--dry-run",
                "rollback": "--rollback"}.get(args.mode, "--dry-run")
        # 补丁必须在「模块已加载、main 未跑」之间注入；补丁代码在 pl.__dict__ 里 exec，
        # 裸名直接落到 payload 模块命名空间（否则 note_item/run 这些名字不可见）。
        inject = "exec(%r, pl.__dict__)" % ("\n".join(pre),) if pre else "pass"
        body = "\n".join([
            "import sys, importlib.util",
            "spec = importlib.util.spec_from_file_location('pl', %r)" % REMOTE_PAYLOAD,
            "pl = importlib.util.module_from_spec(spec)",
            "sys.modules['pl'] = pl",
            "spec.loader.exec_module(pl)",
            inject,
            "sys.argv = ['server', %r%s]" % (flag, (", '--stamp', %r" % args.stamp) if args.stamp else ""),
            "raise SystemExit(pl.main())",
            "",
        ])
        with sftp.file(REMOTE_WRAP, "w") as fh:
            fh.write(body)
        sftp.close()
        cmd = "cd /root && python3 -u %s > %s 2>&1; echo rc=$?; " % (REMOTE_WRAP, REMOTE_OUT)
        rc, o, e = rrun(cli, cmd, timeout=7200)
        rc2, out, _ = rrun(cli, "cat %s" % REMOTE_OUT, timeout=300)
        REPORTS.mkdir(parents=True, exist_ok=True)
        p = REPORTS / ("run-%s-%s.log" % (tag, time.strftime("%Y%m%d-%H%M%S")))
        p.write_text(out, encoding="utf-8")
        print("远端输出已留痕：%s（%d 字节）" % (p, len(out)))
        print(out[-6000:])
        return 0
    finally:
        cli.close()


if __name__ == "__main__":
    sys.exit(main())
