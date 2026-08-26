const asar = require("E:/dev/tools/pipeline-console/node_modules/@electron/asar");
const buf = asar.extractFile("E:/dev/tools/pipeline-console/dist/win-unpacked/resources/app.asar", "renderer/style.css");
const c = buf.toString("utf8");
let i = c.indexOf(".agent-side-list");
console.log(c.substring(i, i + 220));
i = c.indexOf(".agent-side{");
console.log("---");
console.log(c.substring(i, i + 200));
