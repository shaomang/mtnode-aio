const asar = require("E:/dev/tools/pipeline-console/node_modules/@electron/asar");
const buf = asar.extractFile("E:/dev/tools/pipeline-console/dist/win-unpacked/resources/app.asar", "renderer/style.css");
const c = buf.toString("utf8");
for (const pat of [".agent-pane", ".agent-side{", ".agent-side-foot", "#agentPane", ".agent-side-logo"]) {
  const i = c.indexOf(pat);
  console.log("=== " + pat + " @ " + i + " ===");
  if (i >= 0) console.log(c.substring(i, i + 220));
}
