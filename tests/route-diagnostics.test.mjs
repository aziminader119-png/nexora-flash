import test from 'node:test';
import assert from 'node:assert/strict';
import {traceAmounts,probeRouteImpact,compareRouteSizes} from '../lib/route-diagnostics.mjs';
const A='0x'+'11'.repeat(20), B='0x'+'22'.repeat(20),C='0x'+'33'.repeat(20);
const edge=(key,a,b)=>({pool:{key,type:'v2',router:'0x'+'44'.repeat(20)},tokenIn:{address:a,symbol:a===A?'USDC':'TOKEN'},tokenOut:{address:b,symbol:b===A?'USDC':'TOKEN'}});
const candidate=(id,amount='1000',out1='500',out2='990')=>({
 id,chainId:8453,network:'Base',pair:'USDC → TOKEN → USDC',size:Number(amount),amount,
 netEstimate:-10,provider:{kind:'MORPHO_BLUE'},flashFee:0,gasCost:0.01,executable:false,
 legs:[{pool:'p1',name:'Pool1',type:'v2',router:'0x'+'44'.repeat(20),tokenIn:A,tokenOut:B,quotedOut:out1,fee:0},
 {pool:'p2',name:'Pool2',type:'v2',router:'0x'+'44'.repeat(20),tokenIn:B,tokenOut:A,quotedOut:out2,fee:0}]
});
test('amount trace preserves token raw units and does not mislabel token ratios as USD losses',()=>{
 const c=candidate('x');const t=traceAmounts(c,[edge('p1',A,B),edge('p2',B,A)]);
 assert.equal(t.length,2);assert.equal(t[0].amountInUnits,'1000');assert.equal(t[0].amountOutUnits,'500');
 assert.equal(t[1].amountInUnits,'500');assert.equal(t[1].amountOutUnits,'990');
 assert.equal(t[0].priceImpactBps,null);assert.equal(t[0].impactStatus,'NOT_PROBED');
});
test('same-block small-size quote detects strong slippage without marking route executable',async()=>{
 const c=candidate('x');
 const chain={calls:[],async quoteV2(router,amount,a,b,block){
   this.calls.push({amount,block});
   return a===A ? 100n : 490n;
 }};
 const r=await probeRouteImpact({chain,candidates:[c],routeEdges:[edge('p1',A,B),edge('p2',B,A)],
   block:123,maxRoutes:1,maxProbes:2});
 assert.equal(r.probesUsed,2);
 const d=r.diagnostics.get('x');assert.equal(d.trace.length,2);
 assert.equal(d.trace[0].impactStatus,'HIGH_IMPACT');
 assert.equal(d.liquidityRisk,'HIGH');
 assert.equal(d.probesIncomplete,false);
 assert.deepEqual(chain.calls.map(x=>x.block),[123,123]);
 assert.equal(c.executable,false);
});
test('probe failures and hard budgets fail closed without inventing impact measurements',async()=>{
 const c=candidate('x');
 const chain={async quoteV2(){throw Error('RPC unavailable')}};
 const r=await probeRouteImpact({chain,candidates:[c],routeEdges:[edge('p1',A,B),edge('p2',B,A)],
   block:123,maxRoutes:1,maxProbes:1});
 const d=r.diagnostics.get('x');
 assert.equal(d.probesIncomplete,true);assert.equal(d.maximumImpactBps,null);
 assert.equal(d.trace[0].impactStatus,'UNAVAILABLE');assert.equal(d.trace[1].impactStatus,'NOT_PROBED');
 assert.equal(r.probesUsed,1);
});
test('loan size comparison groups exact pool direction and fee, not just displayed pair',()=>{
 const x=candidate('a'),y=candidate('b','500','250','490'),z=candidate('c');
 // Size comparison intentionally accepts only 5–10-hop cycles.
 for (const c of [x,y,z]) c.legs.push(
   {pool:'p3',tokenIn:A,tokenOut:C,fee:500},
   {pool:'p4',tokenIn:C,tokenOut:B,fee:500},
   {pool:'p5',tokenIn:B,tokenOut:A,fee:500});
 z.legs[0].fee=500;
 const r=compareRouteSizes([x,y,z]);
 assert.equal(r.length,2);
 assert.equal(r.find(q=>q.sizes.length===2).sizes[0].size,500);
 assert.equal(r.find(q=>q.sizes.length===2).bestQuotedSize,500);
});
test('invalid probe limits rejected before hitting RPC',async()=>{
 await assert.rejects(probeRouteImpact({chain:{},candidates:[],maxProbes:500}),/Invalid impact probe limits/);
});
