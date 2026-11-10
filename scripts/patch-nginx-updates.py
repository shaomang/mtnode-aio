#!/usr/bin/env python3
"""Patch nginx for the electron-updater feed /mtnode/updates/.

Why this script exists
----------------------
The feed is the only place where a bad HTTP detail costs real money and real
users: electron-updater downloads a *differential* package by asking for many
small byte ranges of the .exe. If the server stops answering `206 Partial
Content` (or answers it from a broken cache), every client silently falls back
to the full 170 MB download. So this patch does three things and keeps Range
intact:

  1. TLS + HTTP/2 on the site's 443 server block.
  2. A faster source than "nginx proxies 170 MB" for the feed, in one of three
     modes:
       - redirect mode (DEFAULT when --origin is given): answer 302 to the
         bucket and let the bytes come straight from OSS. Measured reason: this
         VPS egress is capped near 100 Mbps (13.9 MB/s to an off-site client)
         while the bucket delivers ~104 MB/s, so proxying the installer here is
         7-8x slower. Range 206 then comes from OSS, and electron-updater
         follows the redirect for latest.yml *and* for the differential
         .exe/.blockmap Range requests (builder-util-runtime
         HttpExecutor.doDownload -> prepareRedirectUrlOptions keeps Range).
       - proxy mode (--proxy-bytes; origin already used by the live site,
         response headers carry x-oss-request-id): proxy_cache +
         proxy_force_ranges -- the client's own Range goes upstream unchanged
         (206 straight from the origin) and full 200 bodies are cached, so
         repeat installs are served locally. Only worth it when the origin is
         slow or reachable only from this host.
       - static mode (plain directory): native static serving (Range native),
         sendfile + tcp_nopush, explicit no-cache on the yml manifest.
     `--slice=4m` is available but OFF by default: on nginx 1.22 + this OSS
     origin, slice truncated full-file downloads (curl: "end of response with
     NN bytes missing"), i.e. it broke the very file it was meant to speed up.
  3. A post-patch probe: a ranged request must end at 206 (skipped with
     --no-probe); it follows redirects, so it passes in every mode.

Usage
-----
  python3 patch-nginx-updates.py                 # auto-detect config and mode
  python3 patch-nginx-updates.py --dry-run       # print the patched config only
  python3 patch-nginx-updates.py --origin=https://mtnode.oss-cn-shanghai.aliyuncs.com
                                                 # redirect mode against an origin
  python3 patch-nginx-updates.py --origin=... --proxy-bytes
                                                 # proxy + cache instead (slow VPS egress)
  python3 patch-nginx-updates.py --static=/var/www/html/mtnode/updates
                                                 # force static mode
  python3 patch-nginx-updates.py --config=/path/to/site.conf --dry-run
                                                 # patch an arbitrary file (testing)

Idempotent: the managed block carries BEGIN/END markers. Re-running replaces
the block in place (so an older hand-written location gets upgraded once), and
never touches the history files on disk -- old .exe/.blockmap pairs must stay
where they are or differential updates break for everyone still on them.
"""
from __future__ import annotations

import argparse
import re
import shutil
import subprocess
import sys
from pathlib import Path

CANDIDATES = [
    Path("/etc/nginx/sites-enabled/default"),
    Path("/etc/nginx/sites-available/default"),
    Path("/etc/nginx/conf.d/mt-agent.conf"),
]

LOCATION_PREFIX = "location ^~ /mtnode/updates/"
# Markers are matched without their indentation: the block is re-indented on
# insert, and a second run must still find its own block (otherwise it would
# stack a new location on top of the old one).
BEGIN_MARK = "# >>> mtnode-updates"
END_MARK = "# <<< mtnode-updates"
BEGIN = "    " + BEGIN_MARK + ": managed by scripts/patch-nginx-updates.py"
END = "    " + END_MARK

DEFAULT_STATIC_DIR = "/var/www/html/mtnode/updates"
CACHE_PATH_DIR = "/var/cache/nginx/mtnode-updates"
BACKUP_DIR = Path("/etc/nginx/backups")
CACHE_ZONE = "mtnode_updates"
CACHE_MAX = "2g"  # slices of a few installers; eviction is harmless (OSS still has the file)
SLICE = "4m"


# ── config discovery ─────────────────────────────────────────────────────────
def find_config(explicit: str) -> Path:
    if explicit:
        p = Path(explicit)
        if not p.exists():
            sys.exit("config not found: %s" % p)
        return p
    for p in CANDIDATES:
        if p.exists():
            return p
    for pattern in ("/etc/nginx/conf.d/*.conf", "/etc/nginx/sites-enabled/*"):
        for p in sorted(Path("/").glob(pattern.lstrip("/"))):
            try:
                if "mtnode/updates" in p.read_text(encoding="utf-8", errors="replace"):
                    return p
            except OSError:
                continue
    sys.exit("nginx config not found; pass --config=/path/to/site.conf")


def block_span(text: str, open_idx: int) -> tuple[int, int]:
    """Return (start, end) of the {...} block whose '{' is at/after open_idx."""
    start = text.find("{", open_idx)
    if start < 0:
        return (-1, -1)
    depth = 0
    for i in range(start, len(text)):
        ch = text[i]
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return (start, i + 1)
    return (-1, -1)


def pick_server_block(text: str) -> tuple[int, int]:
    """Prefer the server block that serves www.mt-agent.com, else the first TLS one."""
    spans = []
    for m in re.finditer(r"\bserver\s*\{", text):
        s, e = block_span(text, m.start())
        if s > 0:
            spans.append((s, e))
    if not spans:
        return (-1, -1)
    for s, e in spans:
        chunk = text[s:e]
        if re.search(r"server_name[^;]*mt-agent\.com", chunk):
            return (s, e)
    for s, e in spans:
        if re.search(r"listen[^;]*443", text[s:e]):
            return (s, e)
    return spans[0]


# ── existing location inspection ────────────────────────────────────────────
def find_location(text: str):
    """Return (start, end) of the managed block or of the legacy location block."""
    b = text.find(BEGIN_MARK)
    if b >= 0:
        e = text.find(END_MARK, b)
        if e >= 0:
            start = text.rfind("\n", 0, b) + 1
            stop = text.find("\n", e)
            return (start, len(text) if stop < 0 else stop)
    idx = text.find(LOCATION_PREFIX)
    if idx < 0:
        return (-1, -1)
    line_start = text.rfind("\n", 0, idx) + 1
    s, e = block_span(text, idx)
    if s < 0:
        return (-1, -1)
    return (line_start, e)


def existing_upstream(text: str) -> tuple[str, str]:
    """(mode, target) of the current location block: ('proxy', url) / ('static', dir) / ('', '')."""
    s, e = find_location(text)
    if s < 0:
        return ("", "")
    chunk = text[s:e]
    m = re.search(r"proxy_pass\s+([^;]+);", chunk)
    if m:
        return ("proxy", m.group(1).strip())
    m = re.search(r"alias\s+([^;]+);", chunk)
    if m:
        return ("static", m.group(1).strip())
    m = re.search(r"(?:root\s+([^;]+);)", chunk)
    if m:
        return ("static", m.group(1).strip())
    return ("", "")


# ── block builders ──────────────────────────────────────────────────────────
def redirect_block(origin_url: str) -> str:
    return "\n".join(
        [
            BEGIN,
            "    # /mtnode/updates/ -- electron-updater feed, bytes come from the bucket.",
            "    # Measured 2026-11-07 from an off-site client: this VPS delivers",
            "    # ~13.9 MB/s (100 Mbps egress cap) while the bucket delivers ~104 MB/s,",
            "    # so proxying an installer through nginx is 7-8x slower than a redirect.",
            "    # 302 keeps the public URL; Range 206 then comes straight from OSS, and",
            "    # electron-updater follows redirects for both latest.yml and the",
            "    # differential .exe/.blockmap Range requests (builder-util-runtime",
            "    # HttpExecutor.doDownload -> prepareRedirectUrlOptions keeps Range).",
            "    location ^~ /mtnode/updates/ {",
            "        rewrite ^/mtnode/updates/(.*)$ %s$1 redirect;" % origin_url,
            "        add_header Cache-Control \"no-cache\";",
            "    }",
            END,
        ]
    )


def proxy_block(origin: str, host_header: str, slice_size: str) -> str:
    lines = [
        BEGIN,
        "    # /mtnode/updates/ -- electron-updater feed (differential download).",
        "    # Range MUST stay 206: without it every client re-downloads the full",
        "    # installer. proxy_force_ranges lets a cached object answer 206.",
    ]
    if slice_size and slice_size != "off":
        lines += [
            "    # slice+proxy_cache caches the 4 MB chunks electron-updater asks for.",
        ]
    lines += [
        "    location ^~ /mtnode/updates/ {",
        "        proxy_pass %s;" % origin,
        "        proxy_http_version 1.1;",
        "        proxy_ssl_server_name on;",
        "        proxy_set_header Host %s;" % host_header,
    ]
    if slice_size and slice_size != "off":
        lines += [
            "        proxy_set_header Range $slice_range;",
            "        proxy_set_header If-Range \"\";",
            "",
            "        slice %s;" % slice_size,
            "        proxy_cache %s;" % CACHE_ZONE,
            "        proxy_cache_key $uri$slice_range;",
            "        proxy_cache_valid 200 206 30m;",
        ]
    else:
        lines += [
            "        # no slice: the client's own Range goes upstream unchanged and the",
            "        # 206 comes straight from the origin; only full 200 bodies are cached.",
            "        proxy_set_header Range $http_range;",
            "        proxy_set_header If-Range $http_if_range;",
            "        proxy_cache %s;" % CACHE_ZONE,
            "        proxy_cache_key $scheme$host$uri;",
            "        proxy_cache_valid 200 30m;",
            "        proxy_max_temp_file_size 0;",
        ]
    lines += [
        "        proxy_cache_lock on;",
        "        proxy_cache_use_stale error timeout updating http_500 http_502 http_503 http_504;",
        "        proxy_force_ranges on;",
        "",
        "        # the bucket marks installers as attachments; a feed must not",
        "        proxy_hide_header Content-Disposition;",
        "        proxy_hide_header x-oss-force-download;",
        "        proxy_redirect off;",
        "",
        "        add_header X-Update-Cache $upstream_cache_status;",
        "        add_header Cache-Control \"no-cache\";",
        "        add_header Access-Control-Allow-Origin *;",
        "        autoindex off;",
        "    }",
        END,
    ]
    return "\n".join(lines)


def static_block(directory: str) -> str:
    return "\n".join(
        [
            BEGIN,
            "    # /mtnode/updates/ -- electron-updater feed (differential download).",
            "    # Static serving answers Range natively (206); sendfile/tcp_nopush keep",
            "    # the many small differential requests cheap. Do not add gzip here:",
            "    # gzip drops byte ranges for clients that do not ask for it.",
            "    location ^~ /mtnode/updates/ {",
            "        alias %s/;" % directory.rstrip("/"),
            "        autoindex off;",
            "        sendfile on;",
            "        tcp_nopush on;",
            "        add_header Cache-Control \"no-cache\";",
            "        add_header Access-Control-Allow-Origin * always;",
            "    }",
            END,
        ]
    )


def cache_path_directive() -> str:
    return (
        "    # >> mtnode-updates cache zone\n"
        "    proxy_cache_path %s levels=1:2 keys_zone=%s:16m max_size=%s "
        "inactive=30d use_temp_path=off;\n"
        "    # << mtnode-updates cache zone"
    ) % (CACHE_PATH_DIR, CACHE_ZONE, CACHE_MAX)


# ── transformations ────────────────────────────────────────────────────────
def ensure_http2(text: str, server_span: tuple[int, int], mode: str) -> tuple[str, str]:
    """Make the TLS listener speak HTTP/2. Returns (text, note)."""
    if mode == "off":
        return text, "http2 left as-is (--http2=off)"
    s, e = server_span
    if s < 0:
        return text, "no server block; http2 untouched"
    chunk = text[s:e]
    if re.search(r"^\s*http2\s+on\s*;", chunk, re.M):
        return text, "http2 already on"
    m = re.search(r"^(\s*)listen[^;]*443[^;]*;", chunk, re.M)
    if not m:
        return text, "no 443 listen found; http2 untouched (TLS handled elsewhere)"
    line = m.group(0)
    if "http2" in line:
        return text, "http2 already on the 443 listen line"
    if "ssl" not in line:
        return text, "443 listen has no ssl; http2 untouched (add TLS first)"
    new_line = line[: -len(";")] + " http2;"
    old = text[s:e]
    text = text[:s] + old.replace(line, new_line, 1) + text[e:]
    return text, "http2 enabled on the 443 listen line"


def ensure_cache_path(text: str) -> tuple[str, str]:
    if CACHE_ZONE in text or "proxy_cache_path %s" % CACHE_PATH_DIR in text:
        return text, "cache zone already declared"
    idx = text.find("http {")
    if idx < 0:
        return text, "no http block: run nginx -t yourself (cache zone missing)"
    brace = text.find("{", idx)
    text = text[: brace + 1] + "\n" + cache_path_directive() + text[brace + 1 :]
    return text, "cache zone declared in http block"


def upsert_block(text: str, block: str) -> tuple[str, str]:
    """Replace the managed/legacy location block, or insert one next to store-api."""
    s, e = find_location(text)
    if s >= 0:
        return text[:s] + block + text[e:], "location block replaced in place"
    needle = "location ^~ /mtnode/store-api/"
    if needle in text:
        return text.replace(needle, block.lstrip(" ") + "\n\n    " + needle, 1), "inserted before store-api"
    spans = pick_server_block(text)
    if spans[0] >= 0:
        s2, _ = spans
        brace = text.find("{", s2)
        return text[: brace + 1] + "\n" + block + text[brace + 1 :], "inserted into server block"
    idx = text.find("server {")
    if idx < 0:
        sys.exit("cannot find server block in config")
    brace = text.find("{", idx)
    return text[: brace + 1] + "\n" + block + text[brace + 1 :], "inserted into first server block"


def backup_path(target: Path) -> Path:
    """Backups must NOT sit next to the config: nginx includes sites-enabled/* and
    would load a *.bak copy as a second server block (duplicate server_name, stale
    proxy_cache zone -> nginx -t fails on the next reload)."""
    try:
        inside = str(target.resolve()).startswith("/etc/nginx/")
    except OSError:
        inside = False
    if inside:
        BACKUP_DIR.mkdir(parents=True, exist_ok=True)
        return BACKUP_DIR / (target.name + ".bak")
    return Path(str(target) + ".bak-updates")


def probe(config_path: Path, expect_host: str = "") -> bool:
    """Ranged request to the local nginx: the *final* status must be 206, i.e. Range
    survived the patch (-L, because redirect mode answers 302 first)."""
    cmd = ["curl", "-sS", "-L", "-o", "/dev/null", "-D", "-", "-k", "--max-time", "20",
           "--resolve", "www.mt-agent.com:443:127.0.0.1",
           "-r", "0-100", "https://www.mt-agent.com/mtnode/updates/latest.yml"]
    print("probe: " + " ".join(cmd))
    try:
        out = subprocess.run(cmd, capture_output=True, text=True)
    except OSError as exc:
        print("probe skipped (curl unavailable): %s" % exc)
        return True
    head = (out.stdout or "") + (out.stderr or "")
    statuses = re.findall(r"HTTP/[\d.]+ (\d{3})", head)
    version = re.search(r"HTTP/([\d.]+) ", head)
    hops = " -> ".join(statuses) if statuses else "no response"
    final = statuses[-1] if statuses else ""
    location = re.search(r"^\s*location:\s*(\S+)", head, re.M | re.I)
    problem = ""
    if final == "206":
        if expect_host and location and expect_host not in location.group(1):
            problem = "redirect does not go to %s" % expect_host
        if not problem:
            print("probe OK: %s (HTTP/%s)" % (hops, version.group(1) if version else "?"))
            if location:
                print("  redirect: %s" % location.group(1))
            return True
    if not problem:
        problem = "expected a final 206, got: %s" % hops
    print("probe WARNING: %s" % problem)
    print("  first response line: %s" % (head.splitlines()[:1] or ["no response"]))
    print("  -> keep the old config if differential updates broke: "
          "cp %s %s && nginx -t && systemctl reload nginx"
          % (backup_path(config_path), config_path))
    return False


def ensure_cache_dir(main_text: str, dry_run: bool) -> str:
    """proxy_cache_path needs a writable dir; nginx workers run as `user`."""
    m = re.search(r"^user\s+([^;\s]+)", main_text, re.M)
    owner = m.group(1) if m else "www-data"
    if dry_run:
        return "would create %s (owner %s)" % (CACHE_PATH_DIR, owner)
    try:
        Path(CACHE_PATH_DIR).mkdir(parents=True, exist_ok=True)
        subprocess.run(["chown", "-R", "%s:%s" % (owner, owner), CACHE_PATH_DIR], check=False)
    except OSError as exc:
        return "cache dir problem (create %s by hand: %s)" % (CACHE_PATH_DIR, exc)
    return "cache dir %s ready (owner %s)" % (CACHE_PATH_DIR, owner)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--config", default="", help="nginx site config to patch (default: auto-detect)")
    ap.add_argument("--main-config", default="/etc/nginx/nginx.conf",
                    help="config holding the http{} block (cache zone goes there)")
    ap.add_argument("--origin", default="",
                    help="bucket/CDN base URL behind /mtnode/updates/ (default mode: 302 redirect)")
    ap.add_argument("--proxy-bytes", action="store_true",
                    help="proxy the bytes through nginx (+proxy_cache) instead of redirecting; "
                         "only worth it when the origin is slow or private")
    ap.add_argument("--static", default="", help="static mode: directory holding the feed")
    ap.add_argument("--http2", default="auto", choices=["auto", "on", "off"])
    ap.add_argument("--slice", default="off", metavar="4m|off",
                    help="slice size for cacheable Range chunks (default off: nginx 1.22 "
                         "slice truncated full downloads on this OSS origin, see UPDATES.md)")
    ap.add_argument("--reload", action="store_true", help="systemctl reload nginx after nginx -t passes")
    ap.add_argument("--dry-run", action="store_true", help="print the result, do not write")
    ap.add_argument("--no-probe", action="store_true", help="skip the local Range probe")
    args = ap.parse_args()

    config_path = find_config(args.config)
    text = config_path.read_text(encoding="utf-8-sig", errors="replace")

    mode, target = existing_upstream(text)
    want_proxy = args.origin and args.proxy_bytes
    if args.proxy_bytes and not args.origin:
        sys.exit("--proxy-bytes needs --origin=<bucket base URL>")
    if args.origin and not args.proxy_bytes:
        mode, target = "redirect", args.origin
    elif args.origin:
        mode, target = "proxy", args.origin
    elif args.static:
        mode, target = "static", args.static
    notes = []
    expect_host = ""

    main_path = Path(args.main_config) if args.main_config else None
    main_text = ""
    if main_path and main_path.exists() and main_path != config_path:
        main_text = main_path.read_text(encoding="utf-8-sig", errors="replace")

    if mode in ("proxy", "redirect"):
        origin = target.rstrip("/")
        if "://" not in origin:
            origin = "https://" + origin
        host = origin.split("://", 1)[1].split("/")[0]
        sub = origin.split("://", 1)[1]
        sub = sub.split("/", 1)[1].strip("/") if "/" in sub else ""
        if not sub:
            # bucket root layout: /mtnode/updates/X lives at <bucket>/updates/X
            sub = "updates"
            notes.append("origin has no path: mapping /mtnode/updates/ -> /%s/" % sub)
        origin_url = "https://%s/%s/" % (host, sub)
        if mode == "redirect":
            expect_host = host
            notes.append("redirect mode: /mtnode/updates/ 302 -> %s (bytes never touch this host)"
                         % origin_url)
            block = redirect_block(origin_url)
        else:
            notes.append("proxy mode: /mtnode/updates/ -> %s" % origin_url)
            block = proxy_block(origin_url, host, args.slice)
    else:
        directory = target or DEFAULT_STATIC_DIR
        if mode == "static":
            notes.append("static mode (alias %s): Range served natively" % directory)
        else:
            notes.append("no existing location: defaulting to static %s" % directory)
        block = static_block(directory)

    text, note = ensure_http2(text, pick_server_block(text), args.http2)
    notes.append(note)
    # 缓存区是否已存在，必须在插入 location 之前判断（插进去的块自己就会提到 zone 名）
    zone_already = CACHE_ZONE in text or (bool(main_text) and CACHE_ZONE in main_text)
    text, note = upsert_block(text, block)
    notes.append(note)

    # cache zone lives in the http{} block (nginx.conf), not in the site file
    if mode == "proxy" and not zone_already:
        if main_text:
            main_text, note = ensure_cache_path(main_text)
            notes.append("%s (%s)" % (note, main_path))
            notes.append(ensure_cache_dir(main_text, args.dry_run))
        else:
            text, note = ensure_cache_path(text)
            notes.append(note)
            notes.append(ensure_cache_dir(text, args.dry_run))

    for n in notes:
        print("[patch-nginx-updates] %s" % n)

    if args.dry_run:
        print(text)
        if main_text:
            print("--- %s" % main_path)
            print(main_text)
        return 0

    backup = backup_path(config_path)
    shutil.copy2(config_path, backup)
    config_path.write_text(text, encoding="utf-8")
    print("[patch-nginx-updates] patched %s (backup %s)" % (config_path, backup))
    main_backup = None
    if main_text and main_path:
        main_backup = backup_path(main_path)
        shutil.copy2(main_path, main_backup)
        main_path.write_text(main_text, encoding="utf-8")
        print("[patch-nginx-updates] patched %s (backup %s)" % (main_path, main_backup))

    if shutil.which("nginx"):
        test = subprocess.run(["nginx", "-t"], capture_output=True, text=True)
        print((test.stderr or test.stdout).strip())
        if test.returncode != 0:
            print("nginx -t failed; restoring backups")
            shutil.copy2(backup, config_path)
            if main_backup:
                shutil.copy2(main_backup, main_path)
            return 1
    if args.reload:
        reload = subprocess.run(["systemctl", "reload", "nginx"], capture_output=True, text=True)
        print("[patch-nginx-updates] reload rc=%d %s" % (reload.returncode, (reload.stderr or "").strip()))
    if not args.no_probe:
        probe(config_path, expect_host)
    return 0


if __name__ == "__main__":
    sys.exit(main())
