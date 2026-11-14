import test from 'node:test';
import assert from 'node:assert/strict';
import {summarizeShadowSoak} from '../lib/soak-acceptance.mjs';
const IDs=[56,8453,42161,10,137];
const sample=(options={})=>({
 mode:'SCAN_ONLY',liveExecutionEnabled:false,longRouteExecutionOptIn:false,
 signer:null,trades:[],settings:{autoExecute:false,liveChains:[]},
 networks:IDs.map(chainId=>({chainId,status:'quotes-live',block:100,multiHopQuotes:10,
  multiHopCycles:0})),...options
});
test('healthy five-chain scan-only soak passes without claiming profits',()=>{
 const samples=Array.from({length:5},()=>sample());
 const r=summarizeShadowSoak(samples,{minSamples:5});
 assert.equal(r.decision,'PASS_SCAN_ONLY');
 assert.equal(r.networks.length,5);
 assert.equal(r.networks.every(n=>n.availability===1),true);
 assert.equal(r.profitableArbitrageProven,false);
 assert.equal(r.atomicSimulationProven,false);
});
test('missing samples cannot make a deployment passed',()=>{
 const r=summarizeShadowSoak([sample()],{minSamples:3});
 assert.equal(r.decision,'INCOMPLETE');
});
test('any enabled execution/signer or trade history is a hard failure',()=>{
 const enabled=sample({liveExecutionEnabled:true});
 const r=summarizeShadowSoak([sample(),enabled],{minSamples:1});
 assert.equal(r.decision,'REJECTED');
 assert.ok(r.violations.includes('TRADING_MODE_OR_SETTINGS_NOT_DISABLED'));
 const signer=summarizeShadowSoak([sample({signer:'0x123'})],{minSamples:1});
 assert.equal(signer.decision,'REJECTED');
 const trades=summarizeShadowSoak([sample({trades:[{hash:'x'}]})],{minSamples:1});
 assert.equal(trades.decision,'REJECTED');
});
test('low network availability and long outage fail regardless of other network health',()=>{
 const samples=Array.from({length:10},(_,i)=>{
  const x=sample();
  if(i<6)x.networks[2].status='unavailable';
  return x;
 });
 const r=summarizeShadowSoak(samples,{minSamples:8,minimumAvailability:0.9,
  maxConsecutiveUnhealthy:5});
 assert.equal(r.decision,'REJECTED');
 assert.equal(r.networks.find(n=>n.chainId===42161).availability,0.4);
});
test('zero opportunities are valid market data, not a fabricated profit claim',()=>{
 const r=summarizeShadowSoak(Array.from({length:3},()=>sample()),{minSamples:3});
 assert.equal(r.decision,'PASS_SCAN_ONLY');
 assert.equal(r.networks.every(x=>x.observedCycles===0),true);
 assert.equal(r.profitableArbitrageProven,false);
});
