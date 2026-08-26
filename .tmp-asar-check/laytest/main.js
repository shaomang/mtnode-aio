const { app, BrowserWindow } = require("electron");
const path = require("path");
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 900, height: 700, show: false, useContentSize: true, webPreferences: { offscreen: false } });
  await win.loadFile(path.join(__dirname, "test.html"));
  await new Promise(r => setTimeout(r, 800));
  const img = await win.webContents.capturePage();
  require("fs").writeFileSync(path.join(__dirname, "shot.png"), img.toPNG());
  console.log("CAPTURED");
  app.exit(0);
});
