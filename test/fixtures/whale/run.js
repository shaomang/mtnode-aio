/* 鲸圆币 · 钱包真渲染夹具的 Electron 入口（开发期自检用，不属于发布链）。
 *
 *   node_modules\electron\dist\electron.exe test\fixtures\whale\run.js
 *
 * 隐藏窗加载 test/fixtures/whale/wallet.html（真 style.css + 真 i18n.js +
 * 真 app-whalecoin.js + 真 app-wallet.js，只桩掉 openOverlay 与 storeRequest），
 * 把窗内断言结果打回终端；有 FAIL 则退出码 1。
 * 截图必须走真实合成（隐藏窗 / 离屏只拍到全黑），所以默认短暂露一下窗，
 * 想看纯后台跑就设 WHALE_SHOT=0。
 */
const path = require("path");
const fs = require("fs");
const { app, BrowserWindow } = require("electron");

/* 截图要真画面：不关硬件加速（关了 + 隐藏窗会拍到全黑） */
if (process.env.WHALE_SHOT === "0") app.disableHardwareAcceleration();

const SHOT = process.env.WHALE_SHOT !== "0";

app.whenReady().then(() => {
  const win = new BrowserWindow({
    show: SHOT, /* 默认露一下（约 2 秒）才拍得到真实画面 */
    width: 1240, /* 够放整只充值窗（.wallet-root 最小宽 520px）+ 订单/流水两张表 */
    height: 1000,
    webPreferences: { contextIsolation: false, nodeIntegration: false },
  });
  let lines = [];
  win.webContents.on("console-message", (...args) => {
    /* Electron 39 新签名是单个事件对象；老签名 (ev, level, message) 仍兼容 */
    const ev = args[0];
    const msg = ev && typeof ev === "object" && "message" in ev ? ev.message : args[2];
    lines.push(String(msg));
    if (String(msg).startsWith("FIXTURE")) finish(false);
  });
  win.webContents.on("did-fail-load", (_e, code, desc, url) => {
    lines.push("FAIL 页面加载失败 " + code + " " + desc + " " + url);
  });

  let done = false;
  let extraFails = 0;
  function say(cond, msg) {
    if (!cond) extraFails++;
    console.log((cond ? "ok   " : "FAIL ") + msg);
  }
  function finish(fromTimer) {
    if (done) return;
    done = true;
    lines.forEach((l) => console.log(l));
    const fails = lines.filter((l) => l.startsWith("FAIL")).length;
    const ok = lines.some((l) => l.startsWith("FIXTURE OK") || l.startsWith("FIXTURE FAIL"));
    if (!ok) console.log("FIXTURE 未跑完（窗内断言没出结论）");
    const shot = () => {
      /* 隐藏 / 未上屏的窗在这一版 Electron 上会拍到 0 字节（无合成帧）：
         截图前把窗摆到屏上并聚焦，等一下再拍。 */
      try {
        win.setPosition(60, 40);
        win.show();
        win.focus();
        win.webContents.setZoomFactor(2); /* 金币只有 20px 上下：放大 2 倍再拍，看图也看得清 */
      } catch (e) {}
      setTimeout(() => {
        win.webContents
          .capturePage()
          .then((img) => {
            const out = path.join(__dirname, "shot-wallet.png");
            const buf = img.toPNG();
            fs.writeFileSync(out, buf);
            console.log("SHOT " + out + " " + buf.length + " bytes");

            /* ── 像素级证据：金币到底画出来没有（读图工具之外的第二条路）──
               取余额旁那枚金币在截图里的矩形，算平均色与圆内蓝色占比：
               金圈 = R>G>B 且偏亮；圆心 = DeepSeek logo 的深蓝（B>R）。 */
            const js = `(function(){var ic=document.querySelector('#wlBalance .coin-ico');
              if(!ic) return null; var r=ic.getBoundingClientRect();
              var ri=ic.querySelector('img'); var rr=ri?ri.getBoundingClientRect():null;
              return {x:r.x,y:r.y,w:r.width,h:r.height,
                      page:{w:innerWidth,h:innerHeight,dpr:devicePixelRatio},
                      img: ri?{x:rr.x,y:rr.y,w:rr.width,h:rr.height,ok:!!ri.naturalWidth,nat:ri.naturalWidth,src:ri.currentSrc}:null};})()`;
            return win.webContents.executeJavaScript(js).then((rect) => {
              if (!rect) {
                say(false, "截不到金币位置（#wlBalance .coin-ico 不在 DOM）");
                return;
              }
              /* 世界坐标（CSS px）→ 截图坐标：capturePage 出来的是设备像素 */
              const scale = rect.page && rect.page.dpr ? rect.page.dpr : 1;
              const box = {
                x: Math.max(0, Math.round(rect.x * scale)),
                y: Math.max(0, Math.round(rect.y * scale)),
                width: Math.max(2, Math.round(rect.w * scale)),
                height: Math.max(2, Math.round(rect.h * scale)),
              };
              const crop = img.crop(box);
              const bmp = crop.toBitmap(); /* BGRA */
              const { width: cw, height: ch } = crop.getSize();
              let gold = 0, blue = 0, total = 0, opaque = 0;
              const cx = cw / 2, cy = ch / 2;
              for (let y = 0; y < ch; y++) {
                for (let x = 0; x < cw; x++) {
                  const i = (y * cw + x) * 4;
                  const b = bmp[i], g = bmp[i + 1], r = bmp[i + 2], a = bmp[i + 3];
                  total++;
                  if (a > 200) opaque++;
                  if (r > 170 && g > 110 && b < 150 && r >= g) gold++;
                  /* 圆内 40% 半径看 logo 的深蓝 */
                  const dx = (x - cx) / cx, dy = (y - cy) / cy;
                  if (dx * dx + dy * dy < 0.16 && a > 200 && b > r + 12) blue++;
                }
              }
              console.log("PIXEL 金币矩形 " + cw + "×" + ch + "（截图 " + JSON.stringify(img.getSize()) +
                " / 页面 " + JSON.stringify(rect.page) + "）不透明 " + opaque + "/" + total +
                " 金色像素 " + gold + " 圆内偏蓝像素 " + blue);
              say(gold > total * 0.15, "金币是真金色圆环（金像素占比 " + ((gold / total) * 100).toFixed(1) + "%）");
              say(blue > 4, "金币内部嵌着深蓝 logo（圆内偏蓝像素 " + blue + "）");
              say(!!(rect.img && rect.img.ok), "金币里的 deepseek-logo.png 已解码到位（naturalWidth " +
                (rect.img ? rect.img.nat : "无") + " · " + (rect.img ? rect.img.src : "无") + "）");
            });
          })
          .catch((e) => console.log("SHOT 失败：" + ((e && e.message) || e)))
          .then(() => app.exit(fails + extraFails || !ok ? 1 : 0));
      }, 800);
    };
    /* 断言跑完后再等一拍让样式收敛（字体 / 图标落位），然后截图收工 */
    setTimeout(shot, 600);
  }

  win.loadFile(path.join(__dirname, "wallet.html"));
  setTimeout(() => finish(true), 6000); /* 窗内夹具自己挂了也要有结论，不能吊着 */
});
