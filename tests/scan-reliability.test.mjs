import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {projectCurrentScan} from '../lib/scan-reliability.mjs';
const networks=[{id:8453,name:'Base'},{id:42161,name:'Arbitrum'}];
const c=(chainId,block,netEstimate,hops=2)=>({
 chainId,block,netEstimate,size:100,hopCount:hops,
 legs:Array.from({length:hops},()=>({pool:'test'})),
 executable:false
});
test('network failure cannot leak prior-cycle candidates or misrepresent scan complete',()=>{
 const result=projectCurrentScan(networks,[
  {state:{status:'quotes-live',chainId:8453,block:101},candidates:[c(8453,101,5)]},
  {state:{status:'unavailable',chainId:42161,block:102,error:'RPC timeout'},candidates:[c(42161,102,900)]},
 ]);
 assert.equal(result.healthyNetworks,1);
 assert.equal(result.scanComplete,false);
 assert.equal(result.candidates.length,1);
 assert.equal(result.candidates[0].chainId,8453);
 assert.equal(result.failures[0].reason,'RPC timeout');
});
test('cross-block, wrong-network and malformed candidates are excluded',()=>{
 const result=projectCurrentScan([networks[0]],[{
  state:{chainId:8453,status:'quotes-live',block:100},
  candidates:[c(8453,99,500),c(42161,100,500),c(8453,100,3),
    {...c(8453,100,9),size:NaN},{...c(8453,100,7),legs:[]}]
 }]);
 assert.deepEqual(result.candidates.map(x=>x.netEstimate),[3]);
 assert.equal(result.scanComplete,true);
});
test('project top ranked short and long routes independently, never authorize execution',()=>{
 const short=Array.from({length:30},(_,i)=>c(8453,100,100-i,2));
 const long=Array.from({length:10},(_,i)=>c(8453,100,90-i,5));
 const r=projectCurrentScan([networks[0]],[{
  state:{chainId:8453,status:'quotes-live',block:100},candidates:[...short,...long]
 }]);
 assert.equal(r.candidates.length,25);
 assert.equal(r.candidates.filter(x=>x.hopCount===5).length,5);
 assert.equal(r.candidates.every(x=>x.executable===false),true);
 assert.equal(r.candidates[0].netEstimate,100);
});
test('invalid envelopes fail closed',()=>{
 assert.throws(()=>projectCurrentScan(networks,[]),/Invalid/);
 assert.throws(()=>projectCurrentScan([],[],{maxDirect:-1}),/Invalid/);
 const r=projectCurrentScan([networks[0]],[null]);
 assert.equal(r.candidates.length,0);
 assert.equal(r.healthyNetworks,0);
});
test('server clears old opportunities before each scan and uses health-projected results',()=>{
 const s=fs.readFileSync(new URL('../server.js',import.meta.url),'utf8');
 assert.match(s,/opportunities = \[\];\s*scans\+\+/);
 assert.match(s,/projectCurrentScan\(enabled,results\)/);
 assert.match(s,/opportunities=projection\.candidates/);
 assert.match(s,/if \(LIVE && settings\.autoExecute\)/);
});
