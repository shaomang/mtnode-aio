/* 只读探针（非交付件）：扫 config-backups 里每一份配置的 apiKey 值（含短值与 123），
   看「123」在哪个时间点被填进过配置。用法：node test/_probe-backup-keys.js */
const fs = require("fs");
const path = require("path");
const DIR = path.join(process.env.APPDATA, "pipeline-console", "pipeline-console", "config-backups");
const files = fs.readdirSync(DIR).filter((f) => f.endsWith(".json")).sort();
console.log("备份份数：" + files.length);

const mask = (s) => (s.length <= 7 ? "*".repeat(s.length) : s.slice(0, 4) + "****" + s.slice(-4));
const re = /"apiKey"\s*:\s*"([^"]{0,200})"/g;
let found123 = 0;
for (const f of files) {
  let txt;
  try {
    txt = fs.readFileSync(path.join(DIR, f), "utf8");
  } catch (e) {
    console.log(f + " 读取失败");
    continue;
  }
  const vals = new Set();
  let m;
  re.lastIndex = 0;
  while ((m = re.exec(txt))) vals.add(m[1]);
  const short = [...vals].filter((v) => v.length <= 7);
  const has123 = [...vals].some((v) => v === "123");
  if (has123) found123++;
  console.log(
    f.replace("config-", "").replace(".json", "") +
      " | apiKey 值 " + vals.size + " 个 | 短值：" + (short.length ? short.map(mask).join(",") : "无") + (has123 ? "  ⚠️ 有 123" : ""),
  );
}
console.log("\n含 apiKey=\"123\" 的备份份数：" + found123);
