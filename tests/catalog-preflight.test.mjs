import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyCatalogIdentities} from '../lib/catalog-preflight.mjs';
const A='0x'+'11'.repeat(20),B='0x'+'22'.repeat(20);
const R1='0x'+'33'.repeat(20),R2='0x'+'44'.repeat(20);
const net={id:8453,stable:{address:A,decimals:6}};
const edges=[
 {pool:{type:'v2',key:'a',router:R1},tokenIn:{address:A},tokenOut:{address:B}},
 {pool:{type:'v2',key:'b',router:R2},tokenIn:{address:B},tokenOut:{address:A}},
];
function rig(overrides={}){
 const calls=[];
 const chain={
  chainId:async()=>8453,blockNumber:async()=>123,
  contractCode:async(address,block)=>{calls.push({kind:'code',address,block});return '0x60016000';},
  tokenDecimals:async(address,block)=>{calls.push({kind:'decimals',address,block});
    return address.toLowerCase()===A.toLowerCase()?6:18;},
  quoteV2:async(router,amount,a,b,block)=>{calls.push({kind:'quote',block});return amount;},
  ...overrides,
 };
 return {chain,calls};
}
test('preflight verifies code, decimals and quoted directions on the exact block without authorizing execution',async()=>{
 const {chain,calls}=rig();
 const r=await verifyCatalogIdentities({chain,net,edges,block:123});
 assert.equal(r.status,'QUOTE_PREFLIGHT_PASSED');
 assert.equal(r.passed,true);
 assert.equal(r.quoteChecks,2);
 assert.equal(r.verifiedTokens,2);
 assert.ok(calls.every(c=>c.block===123));
 assert.equal(r.executable,false);
});
test('wrong chain, missing code or wrong stable decimals fail closed',async()=>{
 let r=await verifyCatalogIdentities({chain:rig({chainId:async()=>42161}).chain,net,edges,block:123});
 assert.equal(r.passed,false);
 assert.equal(r.failures[0].reason,'RPC_CHAIN_ID_MISMATCH');
 r=await verifyCatalogIdentities({chain:rig({contractCode:async()=> '0x'}).chain,net,edges,block:123});
 assert.equal(r.passed,false);assert.ok(r.failures.some(x=>x.reason==='CONTRACT_CODE_UNAVAILABLE'));
 r=await verifyCatalogIdentities({chain:rig({tokenDecimals:async()=>18}).chain,net,edges,block:123});
 assert.equal(r.passed,false);assert.ok(r.failures.some(x=>x.reason==='BASE_TOKEN_DECIMALS_MISMATCH'));
});
test('budgeted partial quote coverage does not claim passed full catalog',async()=>{
 const r=await verifyCatalogIdentities({chain:rig().chain,net,edges,block:123,maxQuotes:1});
 assert.equal(r.status,'PARTIAL');
 assert.equal(r.passed,false);
 assert.equal(r.quoteChecks,1);
});
test('quote outage, too many contracts and malformed inputs do not create positive validation',async()=>{
 const r=await verifyCatalogIdentities({chain:rig({quoteV2:async()=>{throw Error('RPC');}}).chain,net,edges,block:123});
 assert.equal(r.status,'REJECTED');
 assert.equal(r.passed,false);
 assert.ok(r.failures.some(x=>x.reason==='SMALL_QUOTE_UNAVAILABLE'));
 const b=await verifyCatalogIdentities({chain:rig().chain,net,edges,block:123,maxContracts:1});
 assert.equal(b.status,'REJECTED');
 await assert.rejects(verifyCatalogIdentities({chain:rig().chain,net,edges,block:-1}),/Invalid/);
});
