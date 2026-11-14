import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {ShadowMetrics} from '../lib/shadow-metrics.mjs';
const at=Date.parse('2026-11-14T12:00:00Z');
const report=(statuses)=>({status:'COMPLETE',quotes:statuses.length*2,
 candidates:statuses.map((status,i)=>({status,oldBlock:100,shadowBlock:101,
 quotedNetUSD:10,shadowNetUSD:status==='REQUOTE_ABOVE_THRESHOLD'?7:-1,
 decayUSD:status==='REQUOTE_ABOVE_THRESHOLD'?-3:-11}))});
test('cross-block quote persistence measures profit retention without claiming realized P&L',()=>{
 const m=new ShadowMetrics(null,{now:()=>at});
 m.record(8453,report(['REQUOTE_ABOVE_THRESHOLD','REQUOTE_BELOW_THRESHOLD']));
 m.record(42161,report(['RPC_OR_QUOTE_ERROR']));
 const r=m.summary();
 assert.equal(r.scans,2);
 assert.equal(r.attempted,3);
 assert.equal(r.independentlyRequoted,2);
 assert.equal(r.aboveProfitThreshold,1);
 assert.equal(r.retentionRate,0.5);
 assert.equal(r.failures,1);
 assert.equal(r.quoteDecayP10USD,-11);
 assert.equal(r.quoteDecayP90USD,-3);
 assert.equal(r.executable,false);
 assert.equal(m.summary({chainId:8453}).failures,0);
});
test('metrics persist across restart without storing candidate IDs or tokens',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'nexora-shadow-'));
 try{
  const file=path.join(dir,'shadow.jsonl');
  const m=new ShadowMetrics(file,{now:()=>at});
  m.record(8453,{...report(['REQUOTE_ABOVE_THRESHOLD']),candidates:[
   {...report(['REQUOTE_ABOVE_THRESHOLD']).candidates[0],id:'SECRET_ID',asset:'SECRET_TOKEN'}]});
  const raw=fs.readFileSync(file,'utf8');
  assert.ok(!raw.includes('SECRET_ID')&&!raw.includes('SECRET_TOKEN'));
  assert.equal(new ShadowMetrics(file,{now:()=>at}).summary().independentlyRequoted,1);
  assert.equal(fs.statSync(file).mode&0o777,0o600);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('empty and malformed records never produce invented success statistics',()=>{
 const m=new ShadowMetrics(null,{now:()=>at});
 const r=m.summary();
 assert.equal(r.retentionRate,null);
 assert.equal(r.quoteDecayP50USD,null);
 assert.throws(()=>m.summary({lookbackMs:-1}),/Invalid/);
 assert.throws(()=>m.record(-1,report([])),/Invalid/);
});
test('backend retains separate read-only telemetry without changing execution gate',()=>{
 const s=fs.readFileSync(new URL('../server.js',import.meta.url),'utf8');
 assert.match(s,/\/api\/shadow\/metrics/);
 assert.match(s,/shadowMetrics\.record\(net\.id,shadow\)/);
 assert.match(s,/if \(LIVE && settings\.autoExecute\)/);
});
