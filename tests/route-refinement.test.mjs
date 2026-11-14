import test from 'node:test';
import assert from 'node:assert/strict';
import {refineLoanSizes} from '../lib/route-refinement.mjs';
import {DEFAULT_SETTINGS} from '../lib/settings.mjs';
import {S,AAVE,testNet} from './helpers/fake-chain.mjs';
const A='0x'+'44'.repeat(20),R1='0x'+'55'.repeat(20),R2='0x'+'66'.repeat(20);
const edges=[
 {pool:{key:'p1',name:'first',type:'v2',router:R1,routerKind:0,fee:0,forkValidated:true},
  tokenIn:{address:S,symbol:'USDC'},tokenOut:{address:A,symbol:'AAA'}},
 {pool:{key:'p2',name:'second',type:'v2',router:R2,routerKind:0,fee:0,forkValidated:true},
  tokenIn:{address:A,symbol:'AAA'},tokenOut:{address:S,symbol:'USDC'}}
];
const network={...testNet(),routeEdges:edges};
const infos=[{kind:'AAVE_V3',address:AAVE,ok:true,available:1_000_000_000000n,feeModel:'aave-bps',feeParam:5}];
function sample(size,net=0.1){
 const amount=BigInt(size)*1_000000n;
 return {id:'sample:'+size,chainId:network.id,network:network.name,block:777,
 size,amount:amount.toString(),netEstimate:net,asset:S,assetSymbol:'USDC',decimals:6,
 pair:'USDC → AAA → USDC',provider:{kind:'AAVE_V3',fee:'0'},
 legs:[{pool:'p1',router:R1,type:'v2',tokenIn:S,tokenOut:A,fee:0,forkValidated:true},
       {pool:'p2',router:R2,type:'v2',tokenIn:A,tokenOut:S,fee:0,forkValidated:true}],
 blockers:[],executable:false};
}
function rig(){
 const chain={calls:[],async quoteV2(router,amount,a,b,block){
   this.calls.push({router,amount,block});
   return router===R1?amount*2n:amount*52n/100n;
 }};
 return {chain,net:network,settings:{...DEFAULT_SETTINGS,loanSize:1000,maxLoanUSD:1000},
  candidates:[sample(100,0.2),sample(200,0.1)],infos,block:777,
  gasPrice:1_000_000n,nativePrice:2_000_000_000n};
}
test('midpoint 150 quote uses exact on-chain calls, lender fee and per-route gas',async()=>{
 const o=rig();const r=await refineLoanSizes(o);
 assert.equal(r.refined,1);
 assert.equal(r.quotes,2);
 const c=r.candidates[0];
 assert.equal(c.size,150);
 assert.equal(c.amount,'150000000');
 assert.equal(c.hopCount,2);
 assert.ok(c.netEstimate>0);
 assert.equal(c.provider.kind,'AAVE_V3');
 assert.equal(c.refinement.method,'ON_CHAIN_MIDPOINT');
 assert.equal(c.mode,'ADAPTIVE_SIZE_OBSERVE_ONLY');
 assert.equal(c.executable,false);
 assert.ok(c.blockers.includes('adaptive loan size requires independent fork validation'));
 assert.ok(o.chain.calls.every(q=>q.block===777));
});
test('skip heavily negative routes instead of wasting quote calls',async()=>{
 const o=rig();o.candidates=[sample(100,-10),sample(200,-20)];
 const r=await refineLoanSizes(o);
 assert.equal(r.quotes,0);assert.equal(r.refined,0);assert.equal(o.chain.calls.length,0);
});
test('stale block, unrecognized pool and missing provider all fail closed',async()=>{
 let o=rig();o.candidates[1].block=776;
 assert.equal((await refineLoanSizes(o)).refined,0);
 o=rig();o.candidates[0].legs[0].pool='unrecognized';
 assert.equal((await refineLoanSizes(o)).refined,0);
 o=rig();o.infos=[];
 assert.equal((await refineLoanSizes(o)).refined,0);
});
test('RPC failure produces no partial route and preserves nonexecution',async()=>{
 const o=rig();o.chain.quoteV2=async (...args)=>{o.chain.calls.push(args);throw Error('RPC unavailable')};
 const r=await refineLoanSizes(o);assert.equal(r.refined,0);assert.equal(r.quotes,1);
});
test('quote budgets prevent partial execution and unused budget leaks',async()=>{
 const o=rig();const r=await refineLoanSizes({...o,maxQuotes:1});
 assert.equal(r.refined,0);assert.equal(r.quotes,0);
 await assert.rejects(refineLoanSizes({...o,maxRoutes:6}),/Invalid refinement inputs/);
});
