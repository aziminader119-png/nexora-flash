#!/usr/bin/env node
// 72h default unattended READ-ONLY monitoring of existing localhost NEXORA.
// Queries GET endpoints only; no wallet, signing, HTTP POST or transactions.
import fs from 'node:fs';
import path from 'node:path';
import {summarizeShadowSoak} from '../lib/soak-acceptance.mjs';
const parse=(name,fallback)=>{
 const i=process.argv.indexOf('--'+name);
 return i<0?fallback:process.argv[i+1];
};
const hours=Number(parse('hours','72')),intervalSeconds=Number(parse('interval','30'));
const base='http://127.0.0.1:3080';
if(!Number.isFinite(hours)||hours<=0||hours>168||
 !Number.isInteger(intervalSeconds)||intervalSeconds<5||intervalSeconds>3600)
 throw Error('Invalid duration/interval');
const output=String(parse('output','validation/scan-only-soak-'+Date.now()));
const reportFile=output+'.json',seriesFile=output+'.jsonl';
fs.mkdirSync(path.dirname(path.resolve(reportFile)),{recursive:true});
const deadline=Date.now()+hours*3600000;
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const statuses=[],errors=[];
let previousScan=null,staleSamples=0;
async function get(endpoint){
 const r=await fetch(base+endpoint,{signal:AbortSignal.timeout(8000)});
 if(!r.ok)throw Error(endpoint+' HTTP '+r.status);
 return r.json();
}
function persist(){
 const report=summarizeShadowSoak(statuses,{minSamples:Math.ceil(hours*3600/intervalSeconds*.90)});
 report.measurement={requestedHours:hours,intervalSeconds,
  capturedAt:new Date().toISOString(),staleSamples,httpFailures:errors.length,
  failures:errors.slice(-25),endpoint:base,observedOverTime:statuses.length};
 if(staleSamples>3||errors.length>Math.ceil(statuses.length*.05))
  report.decision=report.decision==='REJECTED'?'REJECTED':'INCOMPLETE';
 const tmp=reportFile+'.tmp';
 fs.writeFileSync(tmp,JSON.stringify(report,null,2)+'\n',{mode:0o600});
 fs.renameSync(tmp,reportFile);
 return report;
}
let stopped=false;
process.on('SIGINT',()=>{stopped=true;});
process.on('SIGTERM',()=>{stopped=true;});
while(Date.now()<deadline&&!stopped){
 const started=Date.now();
 try {
  const [state,shadow,scanner]=await Promise.all([
   get('/api/status'),get('/api/shadow/metrics'),get('/api/scanner/health')
  ]);
  if(state.lastScan===previousScan)staleSamples++;
  previousScan=state.lastScan;
  const sample={...state,
   // Limit JSONL to essential non-secret fields; never persist logs,
   // journal contents, admin settings or candidate details.
   networks:(state.networks||[]).map(n=>({
    chainId:n.chainId,name:n.name,status:n.status,block:n.block,
    multiHopQuotes:n.multiHopQuotes,multiHopCycles:n.multiHopCycles
   })),trades:Array.isArray(state.trades)?state.trades.slice(0,1):[],
   opportunities:undefined,logs:undefined,attempts:undefined,
   pending:undefined,settings:{autoExecute:state.settings?.autoExecute,
     liveChains:state.settings?.liveChains},
   contracts:undefined,registry:undefined,gate:undefined,shadow,
   scannerHealth:scanner.networks,
  };
  statuses.push(sample);
  fs.appendFileSync(seriesFile,JSON.stringify(sample)+'\n',{mode:0o600});
 } catch(e){
  errors.push({at:new Date().toISOString(),message:String(e.message||e).slice(0,120)});
 }
 persist();
 await sleep(Math.max(0,intervalSeconds*1000-(Date.now()-started)));
}
const result=persist();
console.log(JSON.stringify({report:reportFile,observations:result.sampleCount,
 result:result.decision,profitableArbitrageProven:false,
 actualOrdersSubmitted:false}));
if(result.decision!=='PASS_SCAN_ONLY')process.exitCode=1;
