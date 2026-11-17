const fs=require("fs"),os=require("os"),path=require("path");
const ROOT=path.resolve(__dirname);
const html=fs.readFileSync(path.join(ROOT,"renderer/index.html"),"utf8");
const body=/<body[^>]*>([\s\S]*)<\/body>/i.exec(html)[1].replace(/<script[\s\S]*?<\/script>/gi,"");
const entry=fs.readFileSync(path.join(ROOT,"renderer/style.css"),"utf8");
const names=[];const re=/@import\s+url\(["']?([^"')]+)["']?\)/g;let m;
while((m=re.exec(entry)))names.push(m[1]);
let css="";
for(const n of names)css+="\n"+fs.readFileSync(path.join(ROOT,"renderer",n),"utf8");
css+="\n"+fs.readFileSync(path.join(ROOT,"renderer/css/grow-input.css"),"utf8");
const grow=fs.readFileSync(path.join(ROOT,"renderer/app-grow-input.js"),"utf8");
const out='<!DOCTYPE html><html><head><meta charset="UTF-8"><style>'+css+'</style></head><body>'+body+
'\n<script>'+grow+'</scr'+'ipt>\n<script>window.__p=function(){var a=document.getElementById("agentPane");var b=document.querySelector(".agent-body");var t=document.getElementById("agentInput");return {paneDisp:a?getComputedStyle(a).display:"none",paneH:a?a.clientHeight:0,bodyH:b?b.clientHeight:0,taDisp:t?getComputedStyle(t).display:"none",taH:t?t.offsetHeight:0,win:window.innerHeight};};</scr'+'ipt></body></html>';
fs.writeFileSync(path.join(os.tmpdir(),"probe-grow.html"),out);
const {app,BrowserWindow}=require("electron");
app.commandLine.appendSwitch("disable-gpu");
app.whenReady().then(async()=>{
  const w=new BrowserWindow({show:false,useContentSize:true,width:1280,height:800,webPreferences:{offscreen:true,sandbox:false,contextIsolation:true,nodeIntegration:false}});
  await w.loadFile(path.join(os.tmpdir(),"probe-grow.html"));
  w.webContents.setZoomFactor(1);
  const r=await w.webContents.executeJavaScript("JSON.stringify(window.__p())",true).catch(e=>"ERR "+e.message);
  console.log(r);
  app.exit(0);
});
