#!/usr/bin/env node
/**
 * 将 ext-repo/skills 同步为创意工坊官方 Skill（账号默认 ms2308）。
 *
 * 环境变量：
 *   MTNODE_STORE_URL   默认 http://127.0.0.1:8787
 *   MTNODE_STORE_USER  默认 ms2308
 *   MTNODE_STORE_PASS  必填
 *   MTNODE_SKILL_VERSION 默认 1.0.0（当 SKILL.md 无 version 时）
 *
 * 行为：同名官方 skill 已存在则 PATCH（升版本并覆盖正文）；否则 POST 新建并标记 official。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SKILLS =
  process.env.MTNODE_SKILLS_DIR ||
  path.join(ROOT, "ext-repo", "skills");
const BASE = (process.env.MTNODE_STORE_URL || "http://127.0.0.1:8787").replace(/\/$/, "");
const USER = process.env.MTNODE_STORE_USER || "ms2308";
const PASS =
  process.env.MTNODE_STORE_PASS ||
  (process.env.MTNODE_STORE_PASS_FILE
    ? fs.readFileSync(process.env.MTNODE_STORE_PASS_FILE, "utf8").trim()
    : "");
const DEF_VER = process.env.MTNODE_SKILL_VERSION || "1.0.0";

if (!PASS) {
  console.error("Set MTNODE_STORE_PASS or MTNODE_STORE_PASS_FILE");
  process.exit(1);
}
if (!fs.existsSync(SKILLS)) {
  console.error("skills dir missing:", SKILLS);
  process.exit(1);
}

function parseMeta(text) {
  const meta = { name: "", title: "", description: "", version: "" };
  const fm = String(text || "").match(/^---\s*\n([\s\S]*?)\n---/);
  if (!fm) return meta;
  for (const line of fm[1].split("\n")) {
    const m = line.match(/^([a-zA-Z0-9_-]+):\s*(.*)$/);
    if (!m) continue;
    const k = m[1];
    const v = String(m[2] || "").replace(/^['"]|['"]$/g, "").trim();
    if (k === "name" || k === "title" || k === "description" || k === "version") meta[k] = v;
  }
  return meta;
}

function bumpPatch(v) {
  const m = String(v || "").match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) return DEF_VER;
  return m[1] + "." + m[2] + "." + (Number(m[3]) + 1);
}

async function api(method, p, body, token) {
  const headers = { Accept: "application/json", "Content-Type": "application/json" };
  if (token) headers.Authorization = "Bearer " + token;
  const res = await fetch(BASE + p, {
    method,
    headers,
    body: body == null ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) {
    const err = new Error((data && data.error) || "HTTP " + res.status);
    err.data = data;
    throw err;
  }
  return data;
}

async function main() {
  let auth;
  try {
    auth = await api("POST", "/api/login", { username: USER, password: PASS });
  } catch {
    auth = await api("POST", "/api/register", {
      username: USER,
      password: PASS,
      nickname: "Official",
    });
  }
  const token = auth.token;
  const listed = await api("GET", "/api/skills?pageSize=50&sort=official", null, token);
  const byName = new Map();
  for (const it of listed.items || []) {
    if (it.skillName) byName.set(String(it.skillName).toLowerCase(), it);
  }

  const dirs = fs
    .readdirSync(SKILLS, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((id) => /^[a-z0-9][a-z0-9-]{0,63}$/.test(id) && !id.endsWith("-install"))
    .sort();

  for (const id of dirs) {
    const mdPath = path.join(SKILLS, id, "SKILL.md");
    if (!fs.existsSync(mdPath)) continue;
    const text = fs.readFileSync(mdPath, "utf8");
    const meta = parseMeta(text);
    const skillName = String(meta.name || id)
      .trim()
      .toLowerCase()
      .replace(/_/g, "-");
    const title = meta.title || id;
    const description = meta.description || "";
    const fileBase64 = Buffer.from(text, "utf8").toString("base64");
    const tags = ["official", id.split("-")[0]].filter(Boolean);
    const existing = byName.get(skillName);
    if (existing) {
      const version = meta.version || bumpPatch(existing.version || DEF_VER);
      const r = await api(
        "PATCH",
        "/api/skills/" + encodeURIComponent(existing.id),
        {
          title,
          description,
          tags,
          version,
          official: true,
          fileBase64,
        },
        token,
      );
      console.log("updated", skillName, "v" + (r.item && r.item.version));
    } else {
      const version = meta.version || DEF_VER;
      const r = await api(
        "POST",
        "/api/skills",
        {
          title,
          description,
          tags,
          version,
          official: true,
          fileBase64,
        },
        token,
      );
      console.log("created", skillName, "v" + (r.item && r.item.version));
    }
  }
  console.log("SEED_SKILLS_OK", dirs.length);
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
