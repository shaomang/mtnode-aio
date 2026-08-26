const asar = require("E:/dev/tools/pipeline-console/node_modules/@electron/asar");
const buf = asar.extractFile("E:/dev/tools/pipeline-console/dist/win-unpacked/resources/app.asar", "renderer/app.js");
const c = buf.toString("utf8");
for (const pat of ["agent-side-foot", "btnAssistAgent", "agentSideList", "agent-side-region", "agent-side-list"]) {
  let i = c.indexOf(pat), n = 0;
  console.log("=== " + pat + " ===");
  while (i >= 0 && n < 4) {
    console.log("  @" + i + ": " + c.substring(Math.max(0, i - 120), i + 160).replace(/\n/g, " "));
    i = c.indexOf(pat, i + 1); n++;
  }
  if (n === 0) console.log("  (not found)");
}
