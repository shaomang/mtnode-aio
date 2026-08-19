#!/usr/bin/env python3
import json, urllib.request, urllib.error, base64

base = "http://127.0.0.1:8787"

def call(method, path, body=None, token=None, expect=True):
    headers = {"Content-Type": "application/json", "Accept": "application/json"}
    if token:
        headers["Authorization"] = "Bearer " + token
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(base + path, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=20) as res:
            raw = res.read()
            ct = res.headers.get("content-type") or ""
            out = json.loads(raw) if "json" in ct else {"ok": True, "bytes": len(raw)}
    except urllib.error.HTTPError as e:
        raw = e.read()
        try:
            out = json.loads(raw)
        except Exception:
            out = {"ok": False, "error": raw.decode("utf-8", "replace"), "status": e.code}
        if expect:
            raise SystemExit("%s %s -> %s" % (method, path, out))
        return out
    if expect and not out.get("ok", True):
        raise SystemExit("%s %s failed: %s" % (method, path, out))
    keys = {k: out[k] for k in out if k not in ("base64", "token")}
    print(method, path, "OK", keys)
    return out

buf = b"MTNODES" + bytes([1]) + b"\x00\x00\x00\x00"
b64 = base64.b64encode(buf).decode()
reg = call("POST", "/api/register", {"username": "smokebot", "password": "smoke-pass", "nickname": "Smoke"}, expect=False)
if not reg.get("ok"):
    reg = call("POST", "/api/login", {"username": "smokebot", "password": "smoke-pass"})
token = reg["token"]
call("GET", "/api/me", token=token)
call("GET", "/api/tags")
call("GET", "/api/templates")
item = call("POST", "/api/templates", {
    "title": "smoke template",
    "description": "api smoke",
    "tags": ["smoke", "test"],
    "fileBase64": b64,
}, token=token)["item"]
tid = item["id"]
call("GET", "/api/templates/" + tid)
call("POST", "/api/templates/" + tid + "/like", {}, token=token)
call("GET", "/api/templates/" + tid + "/file")
me = call("GET", "/api/me", token=token)
print("stats downloadsReceived=%s likesReceived=%s" % (me["user"]["downloadsReceived"], me["user"]["likesReceived"]))
call("PATCH", "/api/templates/" + tid, {"title": "smoke template 2", "tags": ["smoke"]}, token=token)
call("DELETE", "/api/templates/" + tid, token=token)

skill_md = """---
name: smoke-skill
title: smoke skill
description: api smoke skill
version: 1.0.0
---

# smoke
""".encode()
skill_b64 = base64.b64encode(skill_md).decode()
sk = call("POST", "/api/skills", {
    "title": "smoke skill",
    "description": "api smoke",
    "tags": ["smoke"],
    "version": "1.0.0",
    "fileBase64": skill_b64,
}, token=token)["item"]
sid = sk["id"]
call("GET", "/api/skills/" + sid)
call("POST", "/api/skills/" + sid + "/like", {}, token=token)
call("GET", "/api/skills/" + sid + "/file")
call("GET", "/api/skills")
call("GET", "/api/me/skills", token=token)
call("GET", "/api/tags?kind=skills")
call("PATCH", "/api/skills/" + sid, {"title": "smoke skill 2", "version": "1.0.1"}, token=token)
call("DELETE", "/api/skills/" + sid, token=token)

chg = call("POST", "/api/change-password", {
    "username": "smokebot",
    "oldPassword": "smoke-pass",
    "newPassword": "smoke-pass2",
})
token2 = chg["token"]
call("GET", "/api/me", token=token2)
bad = call("POST", "/api/login", {"username": "smokebot", "password": "smoke-pass"}, expect=False)
assert not bad.get("ok")
chg2 = call("POST", "/api/change-password", {
    "username": "smokebot",
    "oldPassword": "smoke-pass2",
    "newPassword": "smoke-pass",
})
token = chg2["token"]

fm = call("POST", "/api/forum/messages", {"room": "general", "text": "smoke hello"}, token=token)["item"]
assert fm.get("text") == "smoke hello"
lst = call("GET", "/api/forum/messages?room=general", token=token)
assert any(x.get("id") == fm["id"] for x in lst.get("items") or [])
call("POST", "/api/forum/messages", {"room": "nope", "text": "x"}, token=token, expect=False)
print("SMOKE_OK")
