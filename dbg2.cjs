const fs=require("fs");
const f="dist\\msix-publish\\ms2308.MTNodeAI-1.7.2.0-x64.msix";
const size=fs.statSync(f).size;
const fd=fs.openSync(f,"r");
const tailLen=Math.min(size,66*1024); const tail=Buffer.alloc(tailLen);
fs.readSync(fd,tail,0,tailLen,size-tailLen);
let eocdAt=-1; for(let i=tail.length-22;i>=0;i--){ if(tail.readUInt32LE(i)===0x06054b50){eocdAt=i;break;} }
const locAt=eocdAt-20;
console.log("locator at tail",locAt,"sig",tail.readUInt32LE(locAt).toString(16),"locOff",Number(tail.readBigUInt64LE(locAt+8)));
const locOff=Number(tail.readBigUInt64LE(locAt+8));
const rec=Buffer.alloc(56); fs.readSync(fd,rec,0,56,locOff);
console.log("rec sig",rec.readUInt32LE(0).toString(16),"count",Number(rec.readBigUInt64LE(32)),"cdSize",Number(rec.readBigUInt64LE(40)),"cdOff",Number(rec.readBigUInt64LE(48)));
const cdOff=Number(rec.readBigUInt64LE(48)), cdSize=Number(rec.readBigUInt64LE(40));
const cd=Buffer.alloc(cdSize); fs.readSync(fd,cd,0,cdSize,cdOff);
let p=0, n=0, found=0;
while(p+46<=cd.length){
  if(cd.readUInt32LE(p)!==0x02014b50){ console.log("stop at",p,"sig",cd.readUInt32LE(p).toString(16)); break; }
  const method=cd.readUInt16LE(p+10), csize=cd.readUInt32LE(p+20), usize=cd.readUInt32LE(p+24);
  const nameLen=cd.readUInt16LE(p+28), extraLen=cd.readUInt16LE(p+30), commentLen=cd.readUInt16LE(p+32);
  const localOff=cd.readUInt32LE(p+42);
  const name=cd.slice(p+46,p+46+nameLen).toString("utf8");
  if(/AppxManifest/i.test(name)||n<3){
    console.log({n,name,method,csize,usize,localOff,extraLen, flags:cd.readUInt16LE(p+8)});
    if(extraLen){ console.log("  extra:",cd.slice(p+46+nameLen,p+46+nameLen+extraLen).toString("hex")); }
  }
  n++; p+=46+nameLen+extraLen+commentLen;
}
console.log("entries",n,"cdSize",cdSize);
