#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把 server-disk-cleanup.py 内嵌的远端脚本抽出来，经 SSH 上传并按其原样执行/检查。

只做三件事：抽 payload、上传、跑；输出原样回传（不做解析加工）。
用法：
  python scripts/server-disk-run.py --dump <本地路径>          # 只抽 payload 落盘
  python scripts/server-disk-run.py --grep <正则>              # 抽 payload 后打印匹配行
  python scripts/server-disk-run.py --remote-cat-inline        # 远端 payload 与本地 payload 的哈希比对
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import json
import re
import sys
from pathlib import Path

import paramiko

ROOT = Path(__file__).resolve().parent
OUTER = ROOT / "server-disk-cleanup.py"
CRED = Path(r"E:\dev\tools\ssh\sftp-mtnode-store.json")
REMOTE_PAYLOAD = "/tmp/mtnode-disk-cleanup-server.py"

def extract_payload() -> str:
    """取外层脚本里 REMOTE_PAYLOAD = r'''…''' 的那一段原文（字节级原样）。"""
    text = OUTER.read_text(encoding="utf-8")
    m = re.search(r"^REMOTE_PAYLOAD = r'''(.*?)^'''$", text, re.S | re.M)
    if not m:
        raise SystemExit("找不到 REMOTE_PAYLOAD = r'''…''' 段")
    return m.group(1)


def connect() -> paramiko.SSHClient:
    cfg = json.loads(CRED.read_text(encoding="utf-8"))
    cli = paramiko.SSHClient()
    cli.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    cli.connect(cfg["host"], port=int(cfg.get("port", 22)), username=cfg["username"],
                key_filename=cfg["privateKey"], timeout=25)
    return cli


def rrun(cli, cmd, timeout=3600) -> tuple[int, str]:
    _in, out, err = cli.exec_command(cmd, timeout=timeout)
    o = out.read().decode("utf-8", "replace")
    e = err.read().decode("utf-8", "replace")
    rc = out.channel.recv_exit_status()
    return rc, (o + e)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dump")
    ap.add_argument("--grep")
    ap.add_argument("--remote-cat-inline", action="store_true")
    args = ap.parse_args()

    payload = extract_payload()
    if args.dump:
        Path(args.dump).write_text(payload, encoding="utf-8", newline="\n")
        print("已写出 %s（%d 字节 · sha256=%s）" % (
            args.dump, len(payload.encode()), hashlib.sha256(payload.encode()).hexdigest()[:16]))
    if args.grep:
        rx = re.compile(args.grep)
        for i, line in enumerate(payload.splitlines(), 1):
            if rx.search(line):
                print("%5d\t%s" % (i, line))
    if args.remote_cat_inline:
        cli = connect()
        try:
            rrun(cli, "cat > %s" % REMOTE_PAYLOAD, timeout=60) if False else None
            sftp = cli.open_sftp()
            with sftp.file(REMOTE_PAYLOAD, "w") as fh:
                fh.write(payload)
            sftp.close()
            rc, txt = rrun(cli, "sha256sum %s; wc -c %s" % (REMOTE_PAYLOAD, REMOTE_PAYLOAD))
            print("远端：" + txt.strip())
            print("本地 sha256=%s bytes=%d" % (
                hashlib.sha256(payload.encode()).hexdigest(), len(payload.encode())))
        finally:
            cli.close()
    if not (args.dump or args.grep or args.remote_cat_inline):
        ap.print_help()
    return 0


if __name__ == "__main__":
    sys.exit(main())
