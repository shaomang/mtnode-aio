/* 临时探针：在 Node 里跑真 renderer/app-relay.js（window 影子 + 桩桥），
   验证打码串真的落进快照、且 401 失败时也照旧显示。非交付件。 */
const fs=require('fs'), path=require('path'), vm=require('vm');
const src=fs.readFileSync(path.join(__dirname,'..','renderer','app-relay.js'),'utf8');
function run(relayKeyInfo, relayMe){
  const S={config:{providers:[],modelKinds:{}}};
  const win={};
  const sandbox={window:win,S:S,console,
    I18n:{t:(s)=>s},
    repaintSettingsProvTiles:()=>{}, renderCanvas:()=>{},
    setTimeout, clearTimeout};
  sandbox.window.api={relayKeyInfo, relayMe};
  sandbox.window.window=sandbox.window;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, {filename:'app-relay.js'});
  return {MtRelay: sandbox.window.MtRelay, S};
}
(async()=>{
  const okKey=()=>Promise.resolve({ok:true,signedIn:true,maskedKey:'5500****4162',keyLength:48,readIssue:''});
  const okDoc=()=>Promise.resolve({ok:true,at:Date.now(),doc:{baseUrl:'https://relay.example/v1',providerName:'MTNode 中转服务',enabled:true,everRecharged:true,balanceYuan:99.5,totalYuan:99.5,models:[{id:'deepseek-v4-flash',kind:'text'}]}});
  let {MtRelay,S}=run(okKey,okDoc);
  await MtRelay.sync({force:true});
  const p=S.config.providers[0];
  console.log('成功路径 relay =', JSON.stringify(p.relay));console.log('maskKey(PLACEHOLDER) =', JSON.stringify(MtRelay.maskKey(MtRelay.KEY_PLACEHOLDER)), ' maskKey(abc) =', JSON.stringify(MtRelay.maskKey('abcdefghij')));

  /* 失败路径（401）：凭据打码串照旧要显示出来 */
  const failMe=()=>Promise.resolve({ok:false,status:401,error:'未登录'});
  ({MtRelay,S}=run(okKey,failMe));
  await MtRelay.sync({force:true});
  console.log('拉取失败（此时还没建卡，卡不存在属预期）');

  /* 先成功建卡，再让服务端 401：打码串必须还在 */
  const seq=[okDoc, failMe];
  ({MtRelay,S}=run(okKey, ()=>seq.length?seq.shift()():failMe()));
  await MtRelay.sync({force:true});
  await MtRelay.sync({force:true});
  const p2=S.config.providers[0];
  console.log('失败回退 ->', JSON.stringify({keyMasked:p2.relay.keyMasked,authKey:p2.relay.authKey,error:p2.relay.error}));

  /* 换账号 / 退出登录：打码串要抹掉 */
  MtRelay.onAuthState(null);
  console.log('退出登录后 providers 数 =', S.config.providers.length);
  const dirty=run(okKey,okDoc);
  await dirty.MtRelay.sync({force:true});
  dirty.S.config.providers[0].relay.keyMasked='9999****8888';
  dirty.MtRelay.onAuthState({id:'u_other'});
  console.log('换账号后旧卡已收：providers 数 =', dirty.S.config.providers.length);
})();



