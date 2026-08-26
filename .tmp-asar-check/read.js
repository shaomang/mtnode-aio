const asar = require("E:/dev/tools/pipeline-console/node_modules/@electron/asar");
const buf = asar.extractFile("E:/dev/tools/pipeline-console/dist/win-unpacked/resources/app.asar", "renderer/app.js");
const c = buf.toString("utf8");
const i = c.indexOf("function setView(");
console.log("setView idx:", i);
if (i >= 0) console.log(c.substring(i, i + 1100));
