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
schema_b64 = base64.b64encode(b"# schema\nfoo: bar\n").decode()
sk = call("POST", "/api/skills", {
    "title": "smoke skill",
    "description": "api smoke",
    "tags": ["smoke"],
    "version": "1.0.0",
    "fileBase64": skill_b64,
    "files": [{"path": "schemas.md", "base64": schema_b64}],
}, token=token)["item"]
sid = sk["id"]
assert any(f.get("path") == "schemas.md" for f in (sk.get("files") or []))
call("GET", "/api/skills/" + sid)
call("POST", "/api/skills/" + sid + "/like", {}, token=token)
pack = call("GET", "/api/skills/" + sid + "/file")
assert any(f.get("path") == "schemas.md" for f in (pack.get("extras") or []))
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

# —— 论坛：免登录列表 / 未登录发帖 401 / 建话题 / 回复 / 状态筛选 / 关键词搜索 / 带图 ——
# 1x1 PNG（合法图片头，便于服务端校验最大边）
png_b64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="

anon = call("POST", "/api/forum/topics", {"title": "anon", "content": "anon"}, expect=False)
assert not anon.get("ok")

# 编辑器上传：未登录 401；登录后拿 imageId，再免登录取图
anon_img = call("POST", "/api/forum/images", {"base64": png_b64, "mime": "image/png"}, expect=False)
assert not anon_img.get("ok")
up = call("POST", "/api/forum/images", {"base64": png_b64, "mime": "image/png"}, token=token)
assert up.get("imageId"), up
call("GET", "/api/forum/images/" + up["imageId"])

topic = call("POST", "/api/forum/topics", {
    "title": "smoke topic 论坛",
    "content": "# smoke\n\nhello forum markdown",
    "status": "help",
    "imageBase64": [png_b64],
}, token=token)["item"]
topic_id = topic["id"]
assert topic.get("status") == "help"
assert len(topic.get("imageIds") or []) == 1

open_lst = call("GET", "/api/forum/topics")
assert any(x.get("id") == topic_id for x in open_lst.get("items") or [])
assert all("content" not in x for x in open_lst.get("items") or [])

det = call("GET", "/api/forum/topic?id=" + topic_id)
assert det["topic"]["content"].startswith("# smoke")
assert det["replies"]["page"] == 1 and det["replies"]["total"] == 0

rep = call("POST", "/api/forum/replies", {"topicId": topic_id, "content": "first reply"}, token=token)["item"]
assert rep["topicId"] == topic_id
det2 = call("GET", "/api/forum/topic?id=" + topic_id + "&replyPage=1&replyPageSize=10")
assert any(r.get("id") == rep["id"] for r in det2["replies"]["items"])
assert det2["topic"]["replyCount"] == 1

flt = call("GET", "/api/forum/topics?status=help")
assert any(x.get("id") == topic_id for x in flt.get("items") or [])
sea = call("GET", "/api/forum/topics?q=markdown&sort=active")
assert any(x.get("id") == topic_id for x in sea.get("items") or [])

solved = call("PATCH", "/api/forum/topic", {"id": topic_id, "status": "solved"}, token=token)["item"]
assert solved["status"] == "solved"
call("GET", "/api/forum/images/" + topic["imageIds"][0])
print("SMOKE_OK")
