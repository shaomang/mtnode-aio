const asar = require("E:/dev/tools/pipeline-console/node_modules/@electron/asar");
const buf = asar.extractFile("E:/dev/tools/pipeline-console/dist/win-unpacked/resources/app.asar", "renderer/index.html");
const c = buf.toString("utf8");
const i = c.indexOf('class="sidebar"');
console.log("--- sidebar region in running build ---");
console.log(c.substring(i - 200, i + 900));
