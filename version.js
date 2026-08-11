'use strict';
/* 版本管理：唯一事实来源为源码目录下的 version 文件。
   用法：
     node version.js        读取当前版本并同步到 package.json，输出版本号
     node version.js bump   末位 +1，写回 version 文件并同步 package.json，输出新版本号
*/
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const VFILE = path.join(ROOT, 'version');
const PKGFILE = path.join(ROOT, 'package.json');

function readVer() {
  try { return fs.readFileSync(VFILE, 'utf8').trim(); } catch { return '0.0.0'; }
}
function writeVer(v) {
  fs.writeFileSync(VFILE, v + '\n');
  const pkg = JSON.parse(fs.readFileSync(PKGFILE, 'utf8'));
  pkg.version = v;
  fs.writeFileSync(PKGFILE, JSON.stringify(pkg, null, 2) + '\n');
}

const cmd = process.argv[2] || 'print';
let v = readVer();
if (!/^\d+\.\d+\.\d+$/.test(v)) {
  console.error('version 文件格式非法: ' + v + '（应为 x.y.z）');
  process.exit(1);
}
if (cmd === 'bump') {
  const m = v.match(/^(\d+)\.(\d+)\.(\d+)$/);
  v = m[1] + '.' + m[2] + '.' + (parseInt(m[3], 10) + 1);
  writeVer(v);
} else {
  const pkg = JSON.parse(fs.readFileSync(PKGFILE, 'utf8'));
  if (pkg.version !== v) {
    pkg.version = v;
    fs.writeFileSync(PKGFILE, JSON.stringify(pkg, null, 2) + '\n');
  }
}
console.log(v);
