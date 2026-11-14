import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {shadowVerify} from '../lib/shadow-verifier.mjs';
import {testNet} from './helpers/fake-chain.mjs';
const net=testNet();
const A=net.stable.address,B=net.wrapped.address;
const r1='0x'+'55'.repeat(20),r2='0x'+'66'.repeat(20);
const routeEdges=[
 {pool:{key:'one',router:r1,fee:0,type:'v2'},tokenIn:{address:A},tokenOut:{address:B}},
 {pool:{key:'two',router:r2,fee:0,type:'v2'},tokenIn:{address:B},tokenOut:{address:A}}
];
const candidate={
 id:'a',chainId:net.id,block:100,asset:A,amount:'100000000',size:100,
 netEstimate:6,provider:{kind:'AAVE_V3',address:net.providers[0].address,fee:'50000'},
 legs:[{pool:'one',router:r1,fee:0,type:'v2',tokenIn:A,tokenOut:B},
 {pool:'two',router:r2,fee:0,type:'v2',tokenIn:B,tokenOut:A}],
};
const settings={minProfitUSD:3,maxLoanUSD:1000};
function rig(opts={}){
 const requests=[];
 const chain={
  chainId:async()=>net.id,
  blockNumber:async()=>101,
  feeData:async()=>({gasPrice:1_000_000n}),
  providerInfo:async()=>({ok:true,available:1000000000n,feeModel:'aave-bps',feeParam:5}),
  quoteV2:async(router,amount,tokenIn,tokenOut,block)=>{
   requests.push({router,amount,block});
   if(tokenIn.toLowerCase()===B.toLowerCase() && tokenOut.toLowerCase()===A.toLowerCase())
     return router===r2 ? amount*53n/100n : 2_000_000_000n;
   return amount*2n;
  },
  ...opts,
 };
 return {chain,requests};
}
test('next-block quote only checks old candidates and never generates executable trade',async()=>{
 const {chain,requests}=rig();
 const r=await shadowVerify({chain,net,settings,candidates:[candidate],
  routeEdges,maxCandidates:2,maxQuotes:10});
 assert.equal(r.status,'COMPLETE');
 assert.equal(r.scanned,1);
 assert.equal(r.quotes,2);
 assert.equal(r.candidates[0].shadowBlock,101);
 assert.equal(r.candidates[0].oldBlock,100);
 assert.equal(r.candidates[0].status,'REQUOTE_ABOVE_THRESHOLD');
 assert.equal(r.candidates[0].executable,false);
 assert.ok(requests.every(q=>q.block===101));
 assert.equal(r.executable,false);
});
test('same block is explicitly unverified, never treated as stable opportunity',async()=>{
 const {chain,requests}=rig({blockNumber:async()=>100});
 const r=await shadowVerify({chain,net,settings,candidates:[candidate],routeEdges});
 assert.equal(r.candidates[0].status,'SAME_BLOCK_NO_INDEPENDENT_REQUOTE');
 assert.equal(r.quotes,0);
});
test('RPC chain mismatch and gas outage fail closed with no signals',async()=>{
 const r=await shadowVerify({chain:rig({chainId:async()=>1}).chain,net,settings,candidates:[candidate],routeEdges});
 assert.equal(r.status,'UNAVAILABLE');assert.equal(r.candidates.length,0);
 const s=await shadowVerify({chain:rig({feeData:async()=>({gasPrice:0n})}).chain,
  net,settings,candidates:[candidate],routeEdges});
 assert.equal(s.status,'UNAVAILABLE');
});
test('route identities and quote errors reject rather than infer any profit',async()=>{
 const {chain}=rig();
 const fake={...candidate,legs:[{...candidate.legs[0],router:'0x'+'88'.repeat(20)},candidate.legs[1]]};
 const r=await shadowVerify({chain,net,settings,candidates:[fake],routeEdges});
 assert.equal(r.candidates[0].status,'UNKNOWN_POOL');
 const broken=rig();
 broken.chain.quoteV2=async(router,...args)=>{
  if(router===r1||router===r2)throw Error('bad rpc');
  return 2_000_000_000n;
 };
 const b=await shadowVerify({chain:broken.chain,net,settings,candidates:[candidate],routeEdges});
 assert.equal(b.candidates[0].status,'RPC_OR_QUOTE_ERROR');
 assert.equal(b.candidates[0].executable,false);
});
test('read-only next-block verification refuses limits and large loan',async()=>{
 const {chain}=rig();
 await assert.rejects(shadowVerify({chain,net,settings,candidates:[],routeEdges,maxQuotes:101}),/Invalid/);
 const r=await shadowVerify({chain,net,settings:{...settings,maxLoanUSD:50},
  candidates:[candidate],routeEdges});
 assert.equal(r.candidates[0].status,'EXCEEDS_LOAN_CEILING');
});
test('service publishes separate shadow endpoint without modifying user interface or execution gate',()=>{
 const s=fs.readFileSync(new URL('../server.js',import.meta.url),'utf8');
 assert.match(s,/\/api\/shadow\/quality/);
 assert.match(s,/if \(!LIVE\) \{\s*try \{\s*const previous=previousScanCandidates/);
 assert.match(s,/if \(LIVE && settings\.autoExecute\)/);
 assert.doesNotMatch(s,/shadowQuality\.get\(.*?executor\.attempt/);
});

test('stale or unavailable flash-loan liquidity cannot create a positive shadow result',async()=>{
 const {chain}=rig({providerInfo:async()=>({ok:true,available:0n,feeModel:'aave-bps',feeParam:5})});
 const r=await shadowVerify({chain,net,settings,candidates:[candidate],routeEdges});
 assert.equal(r.candidates[0].status,'LENDER_QUOTE_UNAVAILABLE');
 assert.equal(r.candidates[0].executable,false);
});
test('current lender fee must be freshly verified rather than reusing old cycle fee',async()=>{
 const {chain}=rig({providerInfo:async()=>({ok:true,available:1_000_000_000n,feeModel:'aave-bps',feeParam:1000})});
 const r=await shadowVerify({chain,net,settings,candidates:[candidate],routeEdges});
 assert.equal(r.candidates[0].status,'REQUOTE_BELOW_THRESHOLD');
 assert.equal(r.candidates[0].feeModel,'CURRENT_BLOCK_ONCHAIN_LENDER_FEE');
});
