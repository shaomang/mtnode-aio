const http=require("http"),fs=require("fs"),path=require("path");
const ROOT="E:\\dev\\tools\\pipeline-console";
const MIME={".html":"text/html; charset=utf-8",".css":"text/css; charset=utf-8",".js":"text/javascript; charset=utf-8",".png":"image/png",".svg":"image/svg+xml"};
http.createServer((req,res)=>{
  const u=decodeURIComponent(String(req.url).split("?")[0]);
  const p=path.join(ROOT, u==="/"?"/test/_preview-trajectory-style.html":u);
  if(!p.startsWith(ROOT)){res.writeHead(403).end();return;}
  fs.readFile(p,(e,b)=>{ if(e){res.writeHead(404).end("404 "+u);return;} res.writeHead(200,{"Content-Type":MIME[path.extname(p).toLowerCase()]||"application/octet-stream"}); res.end(b); });
}).listen(8799,"127.0.0.1",()=>console.log("preview server on http://127.0.0.1:8799/"));
