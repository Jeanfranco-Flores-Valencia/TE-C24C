const S=require('path').join(__dirname,'..','..','server','src')+'/';
const P=require(S+'protocol'); const {Guard}=require(S+'guard'); const {execFileSync}=require('child_process');
const KEY='0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const ok=P.signCommand(KEY,{deviceId:'esp32-01',cmdId:'abc123def4567890',ts:P.nowS(),action:'led',value:'on'});
const fake={...ok,cmdId:'fake0001',sig:'f'.repeat(64)};
const old=P.signCommand(KEY,{deviceId:'esp32-01',cmdId:'old0001',ts:P.nowS()-120,action:'led',value:'off'});
const out=execFileSync(process.argv[2],[JSON.stringify(ok),JSON.stringify(ok),JSON.stringify(fake),JSON.stringify(old),'{malo']).toString();
const g=new Guard({devices:new Map([['esp32-01',KEY]]),replayWindowS:30,rateMax:50,rateWindowS:10,blockS:60,badSigMax:5,tempMin:-40,tempMax:80,humMin:0,humMax:100,maxJump:10,maxPayload:512});
for(const l of out.split('\n').filter(l=>l.startsWith('PUB '))){
  const [,topic,json]=l.match(/^PUB (\S+) (.*)$/); const kind=topic.endsWith('telemetry')?'telemetry':'audit';
  const r=g.check(kind,'esp32-01',Buffer.from(json)); const m=JSON.parse(json);
  console.log(kind.padEnd(9), r.ok?'ACEPTADO por servidor':'RECHAZADO '+r.code, kind==='audit'?`${m.event} ${m.ref} ${m.detail}`:`T=${m.temp} led=${m.led}`);
}
console.log(out.match(/LED=\d$/m)[0]);
