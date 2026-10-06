/* store-saas/thumb-fixtures/make-fixtures.cjs —— 生成 thumb-selftest.mjs 用的**真**图夹具。
   人工跑（改动夹具时才需要）：
     node_modules/.bin/electron store-saas/thumb-fixtures/make-fixtures.cjs
   为什么要夹具而不是运行时现造：自测必须验证「真 PNG / 真 JPEG」这条分支，而 JPEG 只能由
   真编码器产出（自己写一个基线编码器既费事又容易把自测写歪——已经踩过一次）。这里借 Electron
   的 Chromium canvas（正是上架链路 `toJPEG(85)` 同一个编码器）把图转出来落盘，随包入库，
   体积都是几 KB 级。产物：quad-640x360.jpg / grad-480x300.jpg / solid-200x200.png */
const { app, BrowserWindow } = require("electron");
const fs = require("fs");
const path = require("path");

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const outDir = __dirname;
  const win = new BrowserWindow({ show: false, width: 800, height: 600, webPreferences: { offscreen: true } });
  await win.loadURL("data:text/html,<html><body style='margin:0'></body></html>");
  const jobs = [
    {
      /* 尺寸对齐线上真实截图：云端 app-icons 里实测就是 1805×1230（≈1.47，比 16:9 更方），
         所以缩略图必然走「左右居中裁切」这条分支 —— 夹具必须复现它，否则自测盖不到。 */
      file: "quad-1805x1230.jpg",
      type: "image/jpeg",
      q: 0.85,
      js: `(() => {
        const c = document.createElement('canvas'); c.width=1805; c.height=1230;
        const g = c.getContext('2d');
        g.fillStyle='#e02020'; g.fillRect(0,0,902,615);
        g.fillStyle='#20c020'; g.fillRect(902,0,903,615);
        g.fillStyle='#2020e0'; g.fillRect(0,615,902,615);
        g.fillStyle='#f0f0f0'; g.fillRect(902,615,903,615);
        return c.toDataURL('image/jpeg', 0.85);
      })()`,
    },
    {
      file: "grad-480x300.jpg",
      type: "image/jpeg",
      q: 0.85,
      js: `(() => {
        const c = document.createElement('canvas'); c.width=480; c.height=300;
        const g = c.getContext('2d');
        const gr = g.createLinearGradient(0,0,480,300);
        gr.addColorStop(0,'#102040'); gr.addColorStop(0.5,'#40c0a0'); gr.addColorStop(1,'#ffe080');
        g.fillStyle=gr; g.fillRect(0,0,480,300);
        return c.toDataURL('image/jpeg', 0.85);
      })()`,
    },
    {
      file: "solid-200x200.png",
      type: "image/png",
      q: 1,
      js: `(() => {
        const c = document.createElement('canvas'); c.width=200; c.height=200;
        const g = c.getContext('2d');
        g.fillStyle='#3355cc'; g.fillRect(0,0,200,200);
        return c.toDataURL('image/png');
      })()`,
    },
  ];
  for (const j of jobs) {
    const url = await win.webContents.executeJavaScript(j.js, true);
    const buf = Buffer.from(String(url).split(",")[1], "base64");
    const f = path.join(outDir, j.file);
    fs.writeFileSync(f, buf);
    console.log("WROTE", j.file, buf.length, "字节");
  }
  app.exit(0);
});
