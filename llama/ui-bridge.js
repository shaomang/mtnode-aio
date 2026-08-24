"use strict";

const fs = require("fs");
const path = require("path");

function join(...a) {
  return path.join(...a);
}

function readJson(p, fb) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return fb;
  }
}

function ownerPath(dataDir) {
  return join(dataDir, ".ui-owner.json");
}

function signalPath(dataDir) {
  return join(dataDir, ".ui-signal.json");
}

function isAlivePid(pid) {
  const n = Number(pid);
  if (!n) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch {
    return false;
  }
}

function writeOwner(dataDir, role, pid) {
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(
      ownerPath(dataDir),
      JSON.stringify({ role, pid: Number(pid) || process.pid, updatedAt: Date.now() }, null, 2),
      "utf8",
    );
  } catch {}
}

function clearOwner(dataDir) {
  try {
    const p = ownerPath(dataDir);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  } catch {}
}

function mtnodeUiAlive(dataDir) {
  const o = readJson(ownerPath(dataDir), null);
  return !!(o && o.role === "mtnode" && isAlivePid(o.pid));
}

function requestMtnodeShowUi(dataDir, from) {
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(
      signalPath(dataDir),
      JSON.stringify({ action: "show", from: from || "tray", ts: Date.now(), handled: false }, null, 2),
      "utf8",
    );
    return true;
  } catch {
    return false;
  }
}

function consumeShowUiSignal(dataDir) {
  const p = signalPath(dataDir);
  const j = readJson(p, null);
  if (!j || j.handled || j.action !== "show") return false;
  try {
    fs.writeFileSync(p, JSON.stringify(Object.assign({}, j, { handled: true }), null, 2), "utf8");
  } catch {}
  return true;
}

function requestTrayHideUi(dataDir) {
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(
      signalPath(dataDir),
      JSON.stringify({ action: "hide-tray", ts: Date.now(), handled: false }, null, 2),
      "utf8",
    );
  } catch {}
}

function consumeTrayHideSignal(dataDir) {
  const p = signalPath(dataDir);
  const j = readJson(p, null);
  if (!j || j.handled || j.action !== "hide-tray") return false;
  try {
    fs.writeFileSync(p, JSON.stringify(Object.assign({}, j, { handled: true }), null, 2), "utf8");
  } catch {}
  return true;
}

module.exports = {
  writeOwner,
  clearOwner,
  mtnodeUiAlive,
  requestMtnodeShowUi,
  consumeShowUiSignal,
  requestTrayHideUi,
  consumeTrayHideSignal,
};
