/* 临时探针：在 Node 里跑真 renderer/app-relay.js（window 影子 + 桩桥），
   验证主进程回的**明文 Key**真的落进卡上的 apiKey（本轮口径：真票就在配置卡上），
   且拉取失败 / 退出登录 / 换账号时的处理符合预期。非交付件。
   跑法：node test/_probe-relay-sync.js */
const fs=require('fs'), path=require('path'), vm=require('vm');
const src=fs.readFileSync(path.join(__dirname,'..','renderer','app-relay.js'),'utf8');
const PLAIN='a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4';
const ROTATE={day:'2026-02-19',left:4,limit:5};
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
  /* 桥桩：relayKeyInfo 回明文 key（没有 maskedKey 字段了）；relayMe 回 keyState + key/rotate */
  const okKey=()=>Promise.resolve({ok:true,signedIn:true,key:PLAIN,keyLength:PLAIN.length,
    fromConfig:true,fromRelayKey:true,expiresAt:4102444800000,renewBeforeMs:0,renewDue:false,
    rotate:ROTATE,from:'store',readIssue:'',writeIssue:''});
  const okDoc=()=>Promise.resolve({ok:true,at:Date.now(),
    keyState:{has:true,fromConfig:true,key:PLAIN,expiresAt:4102444800000,due:false,
      fromRelayKey:true,persisted:true,writeIssue:'',rotate:ROTATE},
    key:PLAIN,keyExpiresAt:4102444800000,rotate:ROTATE,issuedRelayKey:true,
    doc:{baseUrl:'https://relay.example/v1',providerName:'MTNode 中转服务',enabled:true,everRecharged:true,balanceYuan:99.5,totalYuan:99.5,models:[{id:'deepseek-v4-flash',kind:'text'}]}});
  let {MtRelay,S}=run(okKey,okDoc);
  await MtRelay.sync({force:true});
  const p=S.config.providers[0];
  console.log('成功路径：卡上 apiKey =', JSON.stringify(p.apiKey), '（=== 主进程回的明文：'+(p.apiKey===PLAIN)+'）');
  console.log('成功路径 relay =', JSON.stringify(p.relay));
  console.log('keyView(卡) =', JSON.stringify(MtRelay.keyView(p)));
  console.log('MtRelay.maskKey 已删除 =', MtRelay.maskKey===undefined, '| MtRelay.rotateKey =', typeof MtRelay.rotateKey);

  /* 失败路径（401）：凭据（卡上的真票 + relay 元数据）照旧要留着 */
  const failMe=()=>Promise.resolve({ok:false,status:401,error:'未登录'});
  ({MtRelay,S}=run(okKey,failMe));
  await MtRelay.sync({force:true});
  console.log('拉取失败（此时还没建卡，卡不存在属预期）');

  /* 先成功建卡，再让服务端 401：卡上那份真票必须还在 */
  const seq=[okDoc, failMe];
  ({MtRelay,S}=run(okKey, ()=>seq.length?seq.shift()():failMe()));
  await MtRelay.sync({force:true});
  await MtRelay.sync({force:true});
  const p2=S.config.providers[0];
  console.log('失败回退 ->', JSON.stringify({apiKey:p2.apiKey,fromConfig:p2.relay.fromConfig,authKey:p2.relay.authKey,error:p2.relay.error}));

  /* 换账号 / 退出登录：卡上那串真票要抹掉（退回占位标记，等主进程重新写回） */
  MtRelay.onAuthState(null);
  console.log('退出登录后 providers 数 =', S.config.providers.length);
  const dirty=run(okKey,okDoc);
  await dirty.MtRelay.sync({force:true});
  dirty.S.config.providers[0].apiKey='9999ffff8888eeee7777dddd6666cccc5555bbbb4444aaaa3333eeee2222dddd';
  dirty.MtRelay.onAuthState({id:'u_other'});
  console.log('换账号后旧卡已收：providers 数 =', dirty.S.config.providers.length);

  /* 没票时（主进程回空 key）：卡上退回占位串，绝不把空串当票 */
  const noKey=()=>Promise.resolve({ok:true,signedIn:false,key:'',keyLength:0,fromConfig:false,fromRelayKey:false,expiresAt:0,renewBeforeMs:0,renewDue:false,rotate:null,from:'none',readIssue:'',writeIssue:''});
  const noDoc=()=>Promise.resolve({ok:true,at:Date.now(),keyState:{has:false,fromConfig:false,key:'',expiresAt:0,due:false,fromRelayKey:false,persisted:false,writeIssue:'',rotate:null},key:'',keyExpiresAt:0,rotate:null,issuedRelayKey:false,
    doc:{baseUrl:'https://relay.example/v1',providerName:'MTNode 中转服务',enabled:true,everRecharged:true,balanceYuan:0,totalYuan:0,models:[{id:'deepseek-v4-flash',kind:'text'}]}});
  const bare=run(noKey,noDoc);
  await bare.MtRelay.sync({force:true});
  const p3=bare.S.config.providers[0];
  console.log('没票时卡上 apiKey =', JSON.stringify(p3&&p3.apiKey), '（占位串：'+(!!p3&&p3.apiKey===bare.MtRelay.KEY_PLACEHOLDER)+'）');
  console.log('没票时 keyView =', JSON.stringify(bare.MtRelay.keyView(p3)));
})();
