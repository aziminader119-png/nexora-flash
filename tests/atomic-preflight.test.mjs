import test from 'node:test';
import assert from 'node:assert/strict';
import {auditAtomicOpportunity} from '../lib/atomic-preflight.mjs';
import {testNet} from './helpers/fake-chain.mjs';
const net={...testNet(),venues:[
 {id:'r1',name:'V2 one',type:'v2',router:'0x'+'11'.repeat(20),forkValidated:true},
 {id:'r2',name:'V2 two',type:'v2',router:'0x'+'22'.repeat(20),forkValidated:true},
]};
const A=net.stable.address,B=net.wrapped.address;
const R1='0x'+'11'.repeat(20),R2='0x'+'22'.repeat(20);
const exe='0x'+'33'.repeat(20),operator='0x'+'44'.repeat(20);
const settings={minProfitUSD:3,slippageBps:30,maxGasUnits:1200000,maxGasPerTxUSD:3,maxGasGwei:5};
const c={
 id:'observation',chainId:net.id,block:100,asset:A,amount:'100000000',decimals:6,
 provider:{kind:'AAVE_V3',address:net.providers[0].address,fee:'50000'},
 legs:[
  {pool:'a',type:'v2',router:R1,routerKind:0,tokenIn:A,tokenOut:B,fee:0,quotedOut:'200000000',forkValidated:true},
  {pool:'b',type:'v2',router:R2,routerKind:0,tokenIn:B,tokenOut:A,fee:0,quotedOut:'110000000',forkValidated:true}
 ]
};
function rig(overrides={}){
 const calls={sims:0,gas:0};
 const chain={
  chainId:async()=>net.id,blockNumber:async()=>100,contractCode:async()=> '0x6000',
  providerInfo:async()=>({ok:true,available:1_000_000_000n}),
  executorState:async()=>({paused:false,operator,providerKind:1,maxLoan:1_000_000_000n,
   maxRouteLegs:10n,routersAllowed:[true,true],tokensAllowed:[true,true]}),
  simulateStart:async()=>{calls.sims++;return {profit:10_000_000n,fee:50_000n};},
  estimateStart:async()=>{calls.gas++;return 250_000n;},
  feeData:async()=>({gasPrice:1_000_000n,maxFeePerGas:1_000_000n}),
  quoteV2:async()=>2_000_000_000n,
  quoteV3:async()=>2_000_000_000n,l1FeeWei:async()=>0n,
  ...overrides
 };
 return {chain,calls};
}
async function audit(chain,candidate=c,opts={}){
 return auditAtomicOpportunity({chain,net,candidate,settings,executorAddress:exe,
  operatorAddress:operator,...opts});
}
test('a valid read-only eth_call and gas estimate report positive result without submitting anything',async()=>{
 const {chain,calls}=rig();
 const r=await audit(chain);
 assert.equal(r.status,'ETH_CALL_ABOVE_FLOOR');
 assert.equal(r.passed,true);
 assert.equal(r.executable,false);
 assert.equal(calls.sims,1);assert.equal(calls.gas,1);
 assert.ok(r.estimatedNetUSD>3);
});
test('missing executor, stale quote and changed chain fail without eth_call',async()=>{
 const {chain,calls}=rig();
 const no=await auditAtomicOpportunity({chain,net,candidate:c,settings,operatorAddress:operator});
 assert.equal(no.status,'UNVERIFIED');
 assert.equal(no.reason,'DEPLOYED_EXECUTOR_OR_OPERATOR_REQUIRED');
 assert.equal(calls.sims,0);
 const stale=await audit(rig({blockNumber:async()=>103}).chain);
 assert.equal(stale.reason,'CANDIDATE_BLOCK_STALE');
 const changed=await audit(rig({chainId:async()=>137}).chain);
 assert.equal(changed.reason,'CHAIN_ID_MISMATCH');
});
test('executor and lender allowlist fail closed',async()=>{
 let r=await audit(rig({executorState:async()=>({paused:true})}).chain);
 assert.equal(r.reason,'EXECUTOR_ALLOWLIST_OR_LIMIT_REJECTED');
 r=await audit(rig({providerInfo:async()=>({ok:false,available:0n})}).chain);
 assert.equal(r.reason,'FLASH_LOAN_LIQUIDITY_UNAVAILABLE');
 r=await audit(rig().chain,{...c,provider:{...c.provider,address:'0x'+'77'.repeat(20)}});
 assert.equal(r.reason,'UNSUPPORTED_ROUTE_OR_LENDER');
});
test('route continuity and fork-validated edges required, no matter simulated profitability',async()=>{
 const broken={...c,legs:[{...c.legs[0],forkValidated:false},c.legs[1]]};
 assert.equal((await audit(rig().chain,broken)).reason,'INVALID_OR_UNVALIDATED_ROUTE');
});
test('reverts, low simulated profit, and moving block fail closed',async()=>{
 let r=await audit(rig({simulateStart:async()=>{throw Error('reverted')}}).chain);
 assert.equal(r.reason,'ATOMIC_RPC_OR_REVERT');
 r=await audit(rig({simulateStart:async()=>({profit:10000n,fee:50000n})}).chain);
 assert.equal(r.status,'ETH_CALL_BELOW_FLOOR');
 let count=0;
 r=await audit(rig({blockNumber:async()=>++count===1?100:101}).chain);
 assert.equal(r.reason,'BLOCK_CHANGED_DURING_AUDIT');
});

test('unreviewed router fails even when catalog claims forkValidated and eth_call would profit',async()=>{
 const altered={...c,legs:[{...c.legs[0],router:'0x'+'77'.repeat(20)},c.legs[1]]};
 const {chain,calls}=rig();
 const r=await audit(chain,altered);
 assert.equal(r.reason,'UNREVIEWED_DEX_VENUE');
 assert.equal(r.passed,false);
 assert.equal(calls.sims,0);
});
