#!/usr/bin/env python3
# 对着一个**本机 dev 服务**跑一遍接口全流程（需先自己起 server.mjs；默认 http://127.0.0.1:8787）。
# 换端口 / 换实例：SMOKE_BASE=http://127.0.0.1:18888 py -3 store-saas/smoke-api.py
# 注意：本脚本会往目标实例里写 smoke 数据，别对着线上库跑。
# 不需要 dev 服务的删帖全流程（权限矩阵 / 管理员 / 评论连带 / 留档）见 store-saas/smoke-forum-delete.mjs。
import json, os, urllib.request, urllib.error, base64

base = os.environ.get("SMOKE_BASE", "http://127.0.0.1:8787")
# 本机 dev 服务绝不该走系统代理：Windows 上 urllib 会读注册表里的代理设置（本机实测
# http://127.0.0.1:8400 会把每个请求变成 503 空体），而 proxy_bypass("127.0.0.1") 又不成立。
urllib.request.install_opener(urllib.request.build_opener(urllib.request.ProxyHandler({})))

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

# —— 删帖（本轮需求）：软删除 + 连带回复 ——
# 线上口径的轻量校验：作者能删自己的回复与话题，删完列表 / 详情都不可达，未登录一律被拒。
# 权限矩阵（非作者 403 / 话题作者删别人的回复 / 管理员删任意帖 / 评论连带 / 留档字段）由
# store-saas/smoke-forum-delete.mjs 自起服务跑全，那边不依赖线上数据。
del_topic = call("POST", "/api/forum/topics", {
    "title": "smoke delete topic",
    "content": "将被删除的话题",
    "status": "general",
}, token=token)["item"]
del_reply = call("POST", "/api/forum/replies", {"topicId": del_topic["id"], "content": "将被删除的回复"}, token=token)["item"]
gone_reply = call("DELETE", "/api/forum/replies", {"id": del_reply["id"]}, token=token)
assert gone_reply.get("deleted") is True, gone_reply
det_after_reply = call("GET", "/api/forum/topic?id=" + del_topic["id"])
assert not any(r.get("id") == del_reply["id"] for r in det_after_reply["replies"]["items"]), "删掉的回复不该还在详情里"
assert int(det_after_reply["topic"]["replyCount"]) == 0, "删回复后 replyCount 归零（计数按未删记录重算）"
anon_del = call("DELETE", "/api/forum/topic", {"id": del_topic["id"]}, expect=False)
assert not anon_del.get("ok"), "未登录删帖必须被拒"
gone_topic = call("DELETE", "/api/forum/topic", {"id": del_topic["id"]}, token=token)
assert gone_topic.get("deleted") is True, gone_topic
after_del = call("GET", "/api/forum/topics?q=smoke%20delete%20topic")
assert not any(x.get("id") == del_topic["id"] for x in after_del.get("items") or []), "已删话题不该还在列表里"
det_404 = call("GET", "/api/forum/topic?id=" + del_topic["id"], expect=False)
assert not det_404.get("ok"), "已删话题的详情必须 404"
print("SMOKE_OK")
