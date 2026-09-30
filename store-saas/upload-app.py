#!/usr/bin/env python3
"""上传 / 更新自己的应用 zip 到 MTNode 应用市场（store-saas 的 /api/apps）。

与 store-saas/upload.py（服务端部署脚本）同一套配置与命令行口径，但走 HTTP API：
登录 → POST 新建（首次）或 PATCH 更新（版本 +1 并覆盖 zip）。owner 由服务端按登录态
绑定，本脚本不传 userId（传了也会被服务端忽略）。

用法：
  python upload-app.py --zip dist/my-app.zip --id my-app --title "我的应用" \
      [--version 1.0.0] [--desc "一句话说明"] [--entry index.html] [--icon icon.png] \
      [--tags 工具,效率] [--accept-declaration] [--update] [--append-version] \
      [--parent-version 1.0.0] [--version-note "修了导出按钮"] \
      [--list] [--list-versions] [--delete] [--delete-version 1.0.0] \
      [--unpublish] [--publish] [--catalog-out apps/catalog.json] \
      [--base https://www.mt-agent.com/mtnode/store-api] [--dry-run]

  不传 --update 时：id 已存在则报错并提示改用 --update 或 --append-version
  （避免误覆盖别人的应用）。
  --accept-declaration：上架 / 更新（新建、追加版本、更新）**必须**勾选声明，没传就当场
  退出（不会静默发请求）。声明正文：
  本人保证该应用符合中华人民共和国法律法规，不含违法有害内容，不侵犯他人知识产权；
  因该应用产生的全部责任由上传者承担。
  --append-version：对已有应用追加一版（走 POST /api/apps/<id>/versions，版本号缺省 +1），
  而不是覆盖更新；--parent-version / --version-note 描述这一版的父版与说明。
  --list-versions / --delete-version：看版本树 / 删掉某一版（包与记录一起下掉）。
  --unpublish / --publish：下架 / 重新发布（记录与所有版本的包都保留）。
  --catalog-out 把服务端 GET /api/apps/catalog 的结果写成本地静态清单，并把本次的
  zip / 图标按静态目录布局放好（<id>.zip、<id>/<version>.zip、icons/<id>.<ext>）——只作本地留档 / 手查。
  线上静态目录（客户端真正读的 /mtnode/apps/catalog.json）现在由 server.mjs 在每次应用变更后
  自动落盘同步，所以**发布应用不需要再跑 upload.py**；改了 server.mjs / deploy.sh 本人才需要部署。

凭据（与 seed-skills.mjs / upload.py 同口径，只读环境变量，不落盘）：
  MTNODE_STORE_URL        默认 https://www.mt-agent.com/mtnode/store-api
  MTNODE_STORE_USER       默认 ms2308
  MTNODE_STORE_PASS       或 MTNODE_STORE_PASS_FILE
"""
from __future__ import annotations

import argparse
import base64
import datetime
import hashlib
import json
import os
import re
import shutil
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

MAX_APP_ZIP = 24 * 1024 * 1024  # 与服务端 MAX_APP_ZIP 一致（base64 后约 32MB < 40MB body 上限）
DEFAULT_BASE = "https://www.mt-agent.com/mtnode/store-api"
# 声明正文（与服务端 DECLARATION_REQUIRED 的提示同口径；客户端逐字展示这一段）。
DECLARATION_TEXT = (
    "本人保证该应用符合中华人民共和国法律法规，不含违法有害内容，不侵犯他人知识产权；"
    "因该应用产生的全部责任由上传者承担。"
)


def bump_version(v: str) -> str:
    """与服务端 bumpAppVersion 同口径：x.y.z → x.y.(z+1)；其它形态退回「追加 .1」。"""
    s = str(v or "").strip() or "1.0.0"
    m = re.match(r"^(\d+)\.(\d+)\.(\d+)$", s)
    if m:
        return "%s.%s.%d" % (m.group(1), m.group(2), int(m.group(3)) + 1)
    return s + ".1"


def fmt_time(ms) -> str:
    """毫秒时间戳 → 本地「YYYY-MM-DD HH:MM」（拿不到就回 -）。"""
    try:
        return datetime.datetime.fromtimestamp(int(ms) / 1000).strftime("%Y-%m-%d %H:%M")
    except Exception:
        return "-"


def require_declaration(args) -> None:
    """上架 / 更新必须先勾选声明：没传 --accept-declaration 就当场退出，绝不静默发请求。"""
    if not args.accept_declaration:
        sys.exit(
            "上架 / 更新应用必须先接受声明：请加 --accept-declaration。\n声明正文：" + DECLARATION_TEXT
        )


def print_versions(out: dict) -> None:
    """打印版本树（GET /api/apps/<id>/versions 的回执）。"""
    print("latestVersion:", out.get("latestVersion") or "-", "· unpublished=%s" % out.get("unpublished"))
    for v in out.get("versions") or []:
        print(
            "  %-12s %9s bytes  %s  %-10s %s%s"
            % (
                v.get("version"),
                v.get("bytes"),
                fmt_time(v.get("createdAt")),
                v.get("uploader") or "-",
                (v.get("note") or "")[:40],
                "  [最新]" if v.get("current") else "",
            )
        )


def load_creds(base: str) -> tuple[str, str, str]:
    """回 (base, user, pass)：base 优先命令行，再环境变量（与 upload.py 的配置读取口径一致）。"""
    base = (base or os.environ.get("MTNODE_STORE_URL", "") or DEFAULT_BASE).rstrip("/")
    user = os.environ.get("MTNODE_STORE_USER", "").strip() or "ms2308"
    password = os.environ.get("MTNODE_STORE_PASS", "").strip()
    if not password:
        pass_file = os.environ.get("MTNODE_STORE_PASS_FILE", "").strip()
        if pass_file:
            p = Path(pass_file)
            if not p.is_file():
                sys.exit("MTNODE_STORE_PASS_FILE 指向的文件不存在：" + pass_file)
            password = p.read_text(encoding="utf-8").strip()
    if not password:
        sys.exit("缺少密码：设置 MTNODE_STORE_PASS 或 MTNODE_STORE_PASS_FILE")
    return base, user, password


def api(base: str, method: str, path: str, body=None, token: str = "", expect: bool = True) -> dict:
    headers = {"Accept": "application/json", "Content-Type": "application/json"}
    if token:
        headers["Authorization"] = "Bearer " + token
    data = None if body is None else json.dumps(body).encode("utf-8")
    req = urllib.request.Request(base + path, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=300) as res:
            raw = res.read()
    except urllib.error.HTTPError as e:
        raw = e.read()
        try:
            out = json.loads(raw)
        except Exception:
            out = {"ok": False, "error": raw.decode("utf-8", "replace")[:500], "status": e.code}
        if expect:
            sys.exit("%s %s -> %s" % (method, path, out.get("error") or out))
        out["_status"] = e.code
        return out
    out = json.loads(raw) if raw else {}
    if expect and out.get("ok") is False:
        sys.exit("%s %s 失败：%s" % (method, path, out.get("error") or out))
    return out


def login(base: str, user: str, password: str) -> str:
    out = api(base, "POST", "/api/login", {"username": user, "password": password})
    token = out.get("token") or ""
    if not token:
        sys.exit("登录未拿到 token：" + json.dumps(out, ensure_ascii=False)[:300])
    print("login ok:", user)
    return token


def b64_file(path: Path, label: str, limit: int) -> str:
    buf = path.read_bytes()
    if not buf:
        sys.exit("%s 是空文件：%s" % (label, path))
    if len(buf) > limit:
        sys.exit("%s 超过 %d 字节上限：%s（%d 字节）" % (label, limit, path, len(buf)))
    return base64.b64encode(buf).decode("ascii")


def main() -> None:
    ap = argparse.ArgumentParser(description="上传 / 更新自己的 MTNode 应用 zip（登录后走 /api/apps）")
    ap.add_argument("--zip", help="应用包 .zip（导出应用时生成的 <AppName>.zip）")
    ap.add_argument("--id", help="应用 id（= 客户端安装目录名，统一小写；2-64 位字母/数字/._-）")
    ap.add_argument("--title", help="应用标题（列表 / 详情显示名）")
    ap.add_argument("--version", help="版本号；更新时留空 = 服务端自动 +1")
    ap.add_argument("--desc", "--description", dest="desc", help="一句话说明")
    ap.add_argument("--entry", help="入口页（包内相对路径，默认 index.html）")
    ap.add_argument("--icon", help="图标文件（png/jpeg/webp，≤500KB）")
    ap.add_argument("--tags", help="标签，逗号分隔")
    ap.add_argument("--update", action="store_true", help="存在同 id 应用时更新它（PATCH，覆盖 zip）")
    ap.add_argument(
        "--append-version",
        action="store_true",
        help="对已有应用追加一版（POST /api/apps/<id>/versions，版本号缺省按当前版本 +1）",
    )
    ap.add_argument("--parent-version", dest="parent_version", help="这一版的父版本号（缺省 = 当前最新版）")
    ap.add_argument("--version-note", dest="version_note", help="版本说明（≤200 字，随版本记录留档）")
    ap.add_argument(
        "--accept-declaration",
        dest="accept_declaration",
        action="store_true",
        help="上架 / 更新必须勾选声明（" + DECLARATION_TEXT + "）",
    )
    ap.add_argument("--list", action="store_true", help="只列出自己名下的应用")
    ap.add_argument("--list-versions", dest="list_versions", action="store_true", help="列出某个应用的版本树（--id）")
    ap.add_argument("--delete", action="store_true", help="删除自己名下的这个应用（--id）")
    ap.add_argument(
        "--delete-version",
        dest="delete_version",
        metavar="V",
        help="删掉某个应用的某一版（--id，包与版本记录一起下掉）",
    )
    ap.add_argument("--unpublish", action="store_true", help="下架这个应用（--id，目录不再显示，包保留）")
    ap.add_argument("--publish", action="store_true", help="重新发布这个应用（--id，清 unpublished）")
    ap.add_argument("--catalog-out", help="把 GET /api/apps/catalog 写到这个本地路径（静态清单）")
    ap.add_argument("--base", help="服务基址；默认取 MTNODE_STORE_URL 或 " + DEFAULT_BASE)
    ap.add_argument("--user", help="账号；默认取 MTNODE_STORE_USER 或 ms2308")
    ap.add_argument("--dry-run", action="store_true", help="只打印将要发送的请求，不真正上传")
    args = ap.parse_args()

    base, user, password = load_creds(args.base)
    if args.user:
        user = args.user
    print("store:", base, "user:", user)

    if args.dry_run:
        payload = {
            "id": args.id,
            "title": args.title,
            "version": args.version,
            "desc": args.desc,
            "entry": args.entry,
            "tags": args.tags,
            "zip": args.zip,
            "icon": args.icon,
            "update": bool(args.update),
            "appendVersion": bool(args.append_version),
            "parentVersion": args.parent_version,
            "versionNote": args.version_note,
            "acceptDeclaration": bool(args.accept_declaration),
            "list": bool(args.list),
            "listVersions": bool(args.list_versions),
            "delete": bool(args.delete),
            "deleteVersion": args.delete_version,
            "unpublish": bool(args.unpublish),
            "publish": bool(args.publish),
            "catalogOut": args.catalog_out,
        }
        print("dry-run:", json.dumps(payload, ensure_ascii=False, indent=2))
        if not args.accept_declaration:
            print("dry-run 提示：没带 --accept-declaration —— 真正上架 / 更新会被服务端拒（400 DECLARATION_REQUIRED）")
        if args.append_version:
            print("dry-run 提示：--append-version 走 POST /api/apps/<id>/versions（版本号缺省按当前版本 +1）")
        return

    token = login(base, user, password)
    app_id = args.id.strip().lower() if args.id else ""
    # upload 路径才会赋值，但 write_catalog 在 --list / --delete 等模式下也会读，所以先给默认值。
    sha = ""
    latest_ver = ""

    def write_catalog() -> None:
        """把服务端目录文档写成本地静态清单（上传之后调用，才会带上刚传的那一条）；
        同时把本次的 zip / 图标按静态目录布局放好（<id>.zip、<id>/<version>.zip、
        icons/<id>.<ext>），这样随 store-saas 跑一次 upload.py 就能把 /mtnode/apps/
        发布成目录里写的样子（多版本时 deploy.sh 会把 <id>/ 逐版装进静态目录）。"""
        if not args.catalog_out:
            return
        doc = api(base, "GET", "/api/apps/catalog", token=token)
        doc.pop("ok", None)
        dest = Path(args.catalog_out)
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_text(json.dumps(doc, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print("catalog written:", dest, "apps=%d" % len(doc.get("apps") or []))
        if app_id and args.zip and Path(args.zip).is_file():
            static_zip = dest.parent / (app_id + ".zip")
            shutil.copyfile(args.zip, static_zip)
            print("static zip:", static_zip)
            # 多版本的每一版按 <id>/<version>.zip 布局放好（catalog 的 versions[].zipUrl 就是这个相对路径）。
            # 本机只有「本次上传的那一版」的包（按 sha256 认领）；其余版本要给提示，别假装放好了。
            entry = next((e for e in (doc.get("apps") or []) if e.get("id") == app_id), None)
            multi = [
                v
                for v in ((entry or {}).get("versions") or [])
                if str(v.get("zipUrl") or "") not in ("", app_id + ".zip")
            ]
            placed = 0
            for v in multi:
                if v.get("sha256") and sha and v.get("sha256") != sha:
                    continue
                vdir = dest.parent / app_id
                vdir.mkdir(parents=True, exist_ok=True)
                vdest = vdir / (str(v.get("version")) + ".zip")
                shutil.copyfile(args.zip, vdest)
                print("static version zip:", vdest)
                placed += 1
            if multi and placed < len(multi):
                print(
                    "提示：%s 还有 %d 个版本的包不在本机（已放好 %d 个）——在各自机器上重跑 --catalog-out，"
                    "或手工放进 %s/" % (app_id, len(multi) - placed, placed, app_id)
                )
        if app_id and args.icon and Path(args.icon).is_file():
            icons = dest.parent / "icons"
            icons.mkdir(parents=True, exist_ok=True)
            static_icon = icons / (app_id + Path(args.icon).suffix.lower())
            shutil.copyfile(args.icon, static_icon)
            print("static icon:", static_icon)

    if args.list:
        out = api(base, "GET", "/api/apps?owner=" + urllib.parse.quote(user) + "&pageSize=50", token=token)
        for it in out.get("items") or []:
            print(
                "%-24s v%-10s %-8s %s"
                % (it.get("id"), it.get("version"), it.get("sha256", "")[:8], it.get("title"))
            )
        print("total:", out.get("total"))
        write_catalog()
        return

    if not args.id:
        sys.exit("缺少 --id")

    if args.delete:
        api(base, "DELETE", "/api/apps/" + urllib.parse.quote(app_id), token=token)
        print("deleted:", app_id)
        write_catalog()
        return

    if args.list_versions:
        out = api(base, "GET", "/api/apps/" + urllib.parse.quote(app_id) + "/versions", token=token, expect=False)
        if out.get("_status") or out.get("ok") is False:
            sys.exit("查版本失败：" + str(out.get("error") or out))
        print_versions(out)
        return

    if args.delete_version:
        out = api(
            base,
            "DELETE",
            "/api/apps/%s/versions/%s"
            % (urllib.parse.quote(app_id), urllib.parse.quote(args.delete_version)),
            token=token,
        )
        print("deleted version:", args.delete_version, "→ latestVersion=%s" % (out.get("latestVersion") or "-"))
        print_versions(out)
        # 本地静态目录里也把这版的包删掉（远端目录由下一次 upload.py 覆盖发布）
        if args.catalog_out:
            stale = Path(args.catalog_out).parent / app_id / (args.delete_version + ".zip")
            if stale.is_file():
                stale.unlink()
                print("static version zip removed:", stale)
        write_catalog()
        return

    if args.unpublish or args.publish:
        act = "unpublish" if args.unpublish else "publish"
        out = api(
            base,
            "POST",
            "/api/apps/%s/%s" % (urllib.parse.quote(app_id), act),
            token=token,
        )
        print(act, "ok:", app_id, "unpublished=%s" % out.get("unpublished"))
        if args.unpublish:
            print("已下架：目录与公开列表不再显示它（记录与所有版本的包都保留，--publish 可恢复）")
        write_catalog()
        return

    if not args.zip:
        sys.exit("缺少 --zip（应用包路径）")
    zip_path = Path(args.zip)
    if not zip_path.is_file():
        sys.exit("zip 不存在：" + str(zip_path))
    buf = zip_path.read_bytes()
    if not buf:
        sys.exit("应用包是空文件：" + str(zip_path))
    if len(buf) > MAX_APP_ZIP:
        sys.exit("应用包超过 %d 字节上限：%d 字节（服务端 MAX_APP_ZIP）" % (MAX_APP_ZIP, len(buf)))
    sha = hashlib.sha256(buf).hexdigest()
    print("zip:", zip_path, len(buf), "bytes", "sha256=" + sha)
    zip_b64 = base64.b64encode(buf).decode("ascii")
    # 声明前置：上架 / 更新（新建、追加版本、PATCH 更新）没勾选就当场退出，
    # 连存在性探测都不发（避免「发了一半请求才发现没勾声明」）。
    require_declaration(args)

    existing = api(base, "GET", "/api/apps/" + urllib.parse.quote(app_id), token=token, expect=False)
    exists = bool(existing.get("item"))

    body = {
        "id": app_id,
        "title": args.title,
        "desc": args.desc,
        "entry": args.entry,
        "tags": args.tags,
        "zipBase64": zip_b64,
        # 服务端只认 acceptDeclaration === true（契约 §7.3）。
        "acceptDeclaration": True,
    }
    if args.parent_version is not None:
        body["parentVersion"] = args.parent_version
    if args.version_note is not None:
        body["versionNote"] = args.version_note
    if args.icon:
        icon_path = Path(args.icon)
        if not icon_path.is_file():
            sys.exit("图标不存在：" + str(icon_path))
        body["iconBase64"] = b64_file(icon_path, "图标", 500 * 1024)
    if args.version:
        body["version"] = args.version

    if exists:
        if args.append_version:
            # 追加一版：走契约里的 POST /api/apps/<id>/versions（版本号缺省按当前最新版 +1）。
            cur = (existing.get("item") or {}).get("latestVersion") or (existing.get("item") or {}).get("version") or "1.0.0"
            ver = args.version or bump_version(cur)
            vbody = {k: v for k, v in body.items() if k != "id" and v is not None}
            vbody["version"] = ver
            out = api(base, "POST", "/api/apps/%s/versions" % urllib.parse.quote(app_id), vbody, token=token)
            item = out.get("item") or {}
            latest_ver = str(out.get("version") or item.get("latestVersion") or ver)
            print(
                "version appended:", item.get("id"), "v" + latest_ver,
                "(parent=%s)" % (args.parent_version if args.parent_version is not None else cur),
            )
        elif not args.update:
            sys.exit(
                "应用 id 已存在（owner=%s）：%s\n如需覆盖更新请加 --update（仅 owner 可改）"
                % ((existing.get("item") or {}).get("owner"), app_id)
            )
        else:
            # PATCH 不接受 id 字段：由路径定位；未传 version 时服务端自动 +1
            patch = {k: v for k, v in body.items() if k != "id" and v is not None}
            out = api(base, "PATCH", "/api/apps/" + urllib.parse.quote(app_id), patch, token=token)
            item = out.get("item") or {}
            latest_ver = str(item.get("latestVersion") or item.get("version") or "")
            print("updated:", item.get("id"), "v" + str(item.get("version")), "(bumped=%s)" % out.get("bumped"))
    else:
        if args.append_version:
            sys.exit("--append-version 只对已存在的应用有意义：" + app_id + " 还不存在，直接上传即可（去掉 --append-version）")
        if not args.title:
            sys.exit("新建应用必须传 --title")
        post = {k: v for k, v in body.items() if v is not None}
        out = api(base, "POST", "/api/apps", post, token=token)
        item = out.get("item") or {}
        latest_ver = str(item.get("latestVersion") or item.get("version") or "")
        print("created:", item.get("id"), "v" + str(item.get("version")))

    catalog = out.get("catalog") or {}
    print(
        "catalog entry: id=%s version=%s latestVersion=%s owner=%s zipUrl=%s sha256=%s"
        % (
            catalog.get("id"),
            catalog.get("version"),
            catalog.get("latestVersion") or latest_ver,
            catalog.get("owner"),
            catalog.get("zipUrl"),
            catalog.get("sha256"),
        )
    )
    if catalog.get("versions"):
        print("versions:", ", ".join(str(v.get("version")) for v in catalog.get("versions") or []))
    if catalog.get("sha256") and catalog.get("sha256") != sha:
        sys.exit("上传后 sha256 与本地不一致，请重传：" + str(catalog.get("sha256")))
    write_catalog()
    if args.catalog_out:
        print("静态清单已写好（本地留档）；线上静态目录由服务端自动同步，无需再跑 upload.py")


if __name__ == "__main__":
    main()