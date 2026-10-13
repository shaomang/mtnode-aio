#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""任务 3/3 用的一次性投递器：把本地文件经 SFTP 上传到服务器并按需执行。

用法（本机）：
  python scripts/server-disk-run3.py --put local.txt:/remote/path [--put ...]
                                    [--mode 0644] [--owner root:root]
                                    [--remote-cmd "<shell 命令>"] [--tag 名字]
只做上传 + 跑命令 + 落痕，不做任何解析加工。
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

import paramiko

ROOT = Path(__file__).resolve().parent
CRED = Path(r"E:\dev\tools\ssh\sftp-mtnode-store.json")
REPORTS = ROOT / "server-disk-reports"


def connect() -> paramiko.SSHClient:
    cfg = json.loads(CRED.read_text(encoding="utf-8"))
    cli = paramiko.SSHClient()
    cli.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    cli.connect(cfg["host"], port=int(cfg.get("port", 22)), username=cfg["username"],
                key_filename=cfg["privateKey"], timeout=25)
    return cli


def rrun(cli, cmd, timeout=1800):
    _in, out, err = cli.exec_command(cmd, timeout=timeout)
    o = out.read().decode("utf-8", "replace")
    e = err.read().decode("utf-8", "replace")
    rc = out.channel.recv_exit_status()
    return rc, o, e


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--put", action="append", default=[],
                    help="本地路径:远端路径（可重复）")
    ap.add_argument("--mode", default="")
    ap.add_argument("--owner", default="")
    ap.add_argument("--remote-cmd", default="")
    ap.add_argument("--cmd-file", default="")
    ap.add_argument("--tag", default="")
    args = ap.parse_args()

    if args.cmd_file:
        args.remote_cmd = Path(args.cmd_file).read_text(encoding="utf-8")

    cli = connect()
    try:
        sftp = cli.open_sftp()
        for spec in args.put:
            local, _, remote = spec.partition(":")
            if not remote:
                raise SystemExit("--put 需要 本地:远端 形式：%s" % spec)
            with sftp.file(remote, "w") as fh:
                fh.write(Path(local).read_bytes())
            if args.mode:
                sftp.chmod(remote, int(args.mode, 8))
            print("uploaded %s -> %s" % (local, remote))
        sftp.close()
        if args.owner:
            rc, o, e = rrun(cli, "chown %s %s" % (
                args.owner, " ".join(s.partition(":")[2] for s in args.put)))
        if not args.remote_cmd:
            return 0
        rc, o, e = rrun(cli, args.remote_cmd)
        REPORTS.mkdir(parents=True, exist_ok=True)
        tag = args.tag or time.strftime("%Y%m%d-%H%M%S")
        p = REPORTS / ("task3.%s.log" % tag)
        p.write_text("$ %s\n[rc=%d]\n%s\n%s\n" % (args.remote_cmd, rc, o, e), encoding="utf-8")
        print("rc=%d 留痕 %s" % (rc, p))
        print(o[-8000:])
        if e.strip():
            print("[stderr]\n" + e[-3000:])
        return rc
    finally:
        cli.close()


if __name__ == "__main__":
    sys.exit(main())
