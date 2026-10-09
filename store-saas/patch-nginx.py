#!/usr/bin/env python3
"""把 nginx 的 store-api 限位与 server.mjs 的常量对齐（幂等 · 只改指令行 · 改动前备份）。

为什么需要它（2026-10-09 事故）：服务端早已把上架链路的请求体上限放宽到
MAX_BODY_APP_UPLOAD(96MB)，线上 nginx 的 `location ^~ /mtnode/store-api/` 却还留着
`client_max_body_size 40m` + `proxy_read_timeout 120s` —— 稍大的应用包在入口就被掐，
客户端表现是「上传中卡住很久然后失败」。两边谁都没发现，直到用户报障。

本脚本的纪律（上一版踩过坑，写在这里免得后人重犯）：
  · **只在目标 location 块内部**逐行改「指令行」，绝不整块重写、绝不插入重复块 ——
    上一版按整块替换，跑三次就长出三份 store-api（location 从 43 涨到 67），
    而且 `location = /mtnode/admin {` 与 `location ^~ /mtnode/admin/ {` 只差几个字符，
    子串匹配会把内容塞进 302 块里。这一版只认**顶层整行**（strip 后正好等于 `location … {`）。
  · 目标值写死在 TARGETS 里，与 store-saas/server.mjs 的常量一一对应；
    服务端启动时也会读这个文件做一次对账自检（nginxLimitAudit），两边互相钉住。
  · 幂等：已经是对的指令就一个字节都不动；没有任何改动时不写文件、不打备份。

在服务器上执行（通常由 upload.py / 人工部署时调用）：
    python3 patch-nginx.py                  # 改 /etc/nginx/sites-available/mt-ai-router.conf
    python3 patch-nginx.py --dry-run        # 只打印将要改的指令，不写任何文件
之后务必人工确认：nginx -t && systemctl reload nginx
"""
import argparse
import re
import shutil
from pathlib import Path

DEFAULT_CONF = "/etc/nginx/sites-available/mt-ai-router.conf"
# 目标 location（顶层整行，缩进会被 strip 掉后比较）
SCOPE_HEAD = "location ^~ /mtnode/store-api/ {"
# 指令 → 期望值。数值口径见 store-saas/server.mjs：
#   client_max_body_size = MAX_BODY_APP_UPLOAD(96MB)
#   proxy_read_timeout / proxy_send_timeout = 客户端上架超时 600s（renderer/app-publish.js 传 600000ms）
#   client_body_timeout 放宽到 300s、关请求体缓冲：慢网上行不再被默认 60s 掐断、也不落磁盘中转
TARGETS = [
    ("client_max_body_size", "96m"),
    ("client_body_timeout", "300s"),
    ("proxy_request_buffering", "off"),
    ("proxy_read_timeout", "600s"),
    ("proxy_send_timeout", "600s"),
]
# 这些指令允许在缺失时自动插入（插在块首行之后，缩进沿用块内已有指令）
INSERT_AFTER_OPEN = {"client_body_timeout", "proxy_request_buffering", "proxy_send_timeout"}


def read_conf(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def find_scope(lines, head):
    """找到 `location … {` 这一行并定出它的块范围，返回 (行号, 缩进, 块结束行号)。
    找不到就回 (-1, "", -1)，调用方**什么都不写**。

    判据用「**缩进**」而不是全局花括号深度：nginx 配置里存在
    `location = /mtnode/admin { return 302 …; }` 这种**一行写完**的块，也有 `types { … }`
    这类嵌套块 —— 用「整行花括号计数」推进全局深度时，只要有一处数错（`}` 与 `;` 同行、
    注释里带花括号…），后面所有 location 都会被判成「不在顶层」，整份配置一个字都改不动
    （干跑时真撞到过：find_scope 恒回 -1，脚本只会说「还没接入」）。
    缩进法只看一件事：块结束 = 之后第一条**缩进不大于它**且以 `}` 开头的行。"""
    want = head.strip()
    for idx, line in enumerate(lines):
        if line.strip() != want:
            continue
        indent = line[: len(line) - len(line.lstrip())]
        for j in range(idx + 1, len(lines)):
            st = lines[j].strip()
            if st.startswith("}") and len(lines[j]) - len(lines[j].lstrip()) <= len(indent):
                return (idx, indent, j)
        return (idx, indent, len(lines) - 1)
    return (-1, "", -1)


def directive_line(line):
    """这一行是不是「指令行」：`key value;`（忽略前导空白）。不是就回 None。"""
    m = re.match(r"^\s*([a-z_]+)\s+([^;]+);", line)
    if not m:
        return None
    return (m.group(1), m.group(2).strip())


def patch_scope(lines, head, targets):
    """在目标块内逐行对齐指令值：存在就改值，允许插入的缺失项插在块首行之后。
    返回 (新行数组, 改动说明数组)。"""
    start, indent, end = find_scope(lines, head)
    if start < 0:
        # 找不到目标块时**一个字节都不写**（调用方据此直接收工）：
        # 这一版只负责「把已有的 store-api 限位改对」，不负责建 location（那是新站接入的事）。
        return (lines, ["找不到 " + head.strip() + "：这个站点可能还没接入 store-api（本脚本只改已存在的块，不新建）"])
    out = list(lines)
    changes = []
    inner_indent = None
    for j in range(start + 1, end):
        got = directive_line(out[j])
        if got:
            inner_indent = out[j][: len(out[j]) - len(out[j].lstrip())]
            break
    if inner_indent is None:
        inner_indent = indent + "    "
    for key, want in targets:
        hit = -1
        for j in range(start + 1, end):
            got = directive_line(out[j])
            if got and got[0] == key:
                hit = j
                break
        if hit >= 0:
            got = directive_line(out[hit])
            if got[1] == want:
                continue
            out[hit] = re.sub(
                r"^(\s*" + re.escape(key) + r"\s+)[^;]+;",
                lambda m: m.group(1) + want + ";",
                out[hit],
            )
            changes.append(key + ": " + got[1] + " → " + want)
        elif key in INSERT_AFTER_OPEN:
            # 插在**块内最后一条指令之后**（不是紧跟块首行）：这样新指令与同类指令排在一起，
            # 块首那条 `# === MTNode 模板商店 API ===` 注释仍然贴着 location 行，配置读起来不乱。
            at = start + 1
            for j in range(start + 1, end):
                if directive_line(out[j]):
                    at = j + 1
            out.insert(at, inner_indent + key + " " + want + ";")
            end += 1
            changes.append(key + ": (缺) → " + want)
        else:
            changes.append(key + ": 块里没有这一行，且不自动插入（请人工确认）")
    return (out, changes)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--conf", default=DEFAULT_CONF)
    ap.add_argument("--dry-run", action="store_true", help="只打印将要改的指令，不写任何文件")
    args = ap.parse_args()
    path = Path(args.conf)
    if not path.is_file():
        raise SystemExit("找不到 nginx 配置：" + str(path))
    lines = read_conf(path).split("\n")
    new_lines, changes = patch_scope(lines, SCOPE_HEAD, TARGETS)
    if not changes:
        print("nginx 限位已与 server.mjs 同口径，无需改动：" + str(path))
        return
    # 找不到目标块（本站点还没接入 store-api）时**绝不写文件**：没有可改的东西，
    # 写下去只会留下一个无意义的备份（上一版就在这里把「找不到」当成一次改动写盘了）。
    if len(changes) == 1 and changes[0].startswith("找不到"):
        print(changes[0])
        return
    print("改动明细：")
    for c in changes:
        print("  · " + c)
    if args.dry_run:
        print("（--dry-run：没有写任何文件）")
        return
    if new_lines == lines:
        print("（内容没有实际变化，不写文件）")
        return
    backup = path.with_suffix(path.suffix + ".bak-limitpatch")
    shutil.copyfile(str(path), str(backup))
    path.write_text("\n".join(new_lines), encoding="utf-8")
    print("已写入 " + str(path) + "（备份 " + str(backup) + "）")
    print("接着必须人工确认：nginx -t && systemctl reload nginx")


if __name__ == "__main__":
    main()
