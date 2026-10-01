/* 只读探针（非交付件）：在 config.json（含会话轨迹）里找出用户看到的那条鉴权报错的上下文，
   定位「123」出现在谁身上。用法：node test/_probe-find-authfail.js */
const fs = require("fs");
const path = require("path");
const P = path.join(process.env.APPDATA, "pipeline-console", "pipeline-console", "config.json");
const txt = fs.readFileSync(P, "utf8");
const needles = ["is invalid", "Authentication Fails", "api key: 123", "403", "invalid_api_key"];
for (const n of needles) {
  let i = -1;
  let count = 0;
  const hits = [];
  while ((i = txt.indexOf(n, i + 1)) >= 0 && count < 8) {
    count++;
    hits.push(txt.slice(Math.max(0, i - 320), i + 200).replace(/\\n/g, "\n"));
  }
  console.log("\n===== 「" + n + "」命中 " + count + " 处（只列前 8）=====");
  hits.forEach((h, k) => console.log("\n--- #" + (k + 1) + " ---\n" + h));
}
