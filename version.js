'use strict';
/* 版本管理：唯一事实来源为源码目录下的 version 文件。
   用法：
      node version.js              读取当前版本并同步到 package.json，输出版本号
      node version.js bump         末位 +1（如 1.2.11 → 1.2.12），写回 version 文件并同步 package.json，输出新版本号
      node version.js bump-major   第二位 +1 且末位归零（如 1.2.11 → 1.3.0），大版本升级用，写回 version 文件并同步 package.json，输出新版本号
   注：第二位 +1 即「大版本升级」，首位保持不变。npm 入口为 npm run version:major。
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
} else if (cmd === 'bump-major' || cmd === 'bump:major') {
  const m = v.match(/^(\d+)\.(\d+)\.(\d+)$/);
  v = m[1] + '.' + (parseInt(m[2], 10) + 1) + '.0';
  writeVer(v);
} else if (cmd === 'print' || cmd === '') {
  const pkg = JSON.parse(fs.readFileSync(PKGFILE, 'utf8'));
  if (pkg.version !== v) {
    pkg.version = v;
    fs.writeFileSync(PKGFILE, JSON.stringify(pkg, null, 2) + '\n');
  }
} else {
  console.error('未知命令: ' + cmd + '（可用：print / bump / bump-major）');
  process.exit(1);
}
console.log(v);
