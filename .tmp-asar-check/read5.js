const asar = require("E:/dev/tools/pipeline-console/node_modules/@electron/asar");
const buf = asar.extractFile("E:/dev/tools/pipeline-console/dist/win-unpacked/resources/app.asar", "renderer/style.css");
const c = buf.toString("utf8");
let re = /\.agent-side-foot[^}]*\}/g, m, n = 0;
while ((m = re.exec(c)) !== null) { n++; console.log("--- match " + n + " @ " + m.index + " ---"); console.log(m[0]); }
if (!n) console.log("no .agent-side-foot rules");
// also check .agent-side display rules and any rule hiding .agent-side *
re = /\.agent-side\b[^}]*\}/g; n = 0;
while ((m = re.exec(c)) !== null) { n++; console.log("--- .agent-side rule " + n + " ---"); console.log(m[0].substring(0, 300)); if (n > 8) break; }
