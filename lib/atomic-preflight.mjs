// Strictly read-only eth_call + estimateGas validation of a previously
// quoted opportunity against an ALREADY DEPLOYED/ALLOWED executor contract.
// Never signs, sends, approves routers, or claims realized profits.
import {buildPlan} from './planner.mjs';
import {weiToStable,protectedFloorUnits} from './profit.mjs';
import {toFloat,parseUnits} from './units.mjs';
import {pools,PROVIDER_KIND} from './networks.mjs';
const ADDR=/^0x[0-9a-fA-F]{40}$/;
const low=x=>String(x||'').toLowerCase();
const incomplete=(reason,additional={})=>({
 mode:'ATOMIC_ETH_CALL_ONLY',passed:false,status:'UNVERIFIED',
 reason,executable:false,...additional});
export async function auditAtomicOpportunity({
 chain,net,candidate,settings,executorAddress,operatorAddress,
 maxBlockLag=1,gasSafetyBps=2000
}){
 if(!chain||!net||!settings||!Number.isInteger(maxBlockLag)||maxBlockLag<0||maxBlockLag>8||
 !Number.isInteger(gasSafetyBps)||gasSafetyBps<0||gasSafetyBps>10000)
 throw Error('Invalid atomic audit parameters');
 const c=candidate;
 if(!ADDR.test(executorAddress)||!ADDR.test(operatorAddress))
  return incomplete('DEPLOYED_EXECUTOR_OR_OPERATOR_REQUIRED');
 if(!c||c.chainId!==net.id||!ADDR.test(c.asset)||low(c.asset)!==low(net.stable.address)||
    !Array.isArray(c.legs)||c.legs.length<2||c.legs.length>10||
    !c.provider||!ADDR.test(c.provider.address)||
    !net.providers.some(p=>p.kind===c.provider.kind&&low(p.address)===low(c.provider.address)))
  return incomplete('UNSUPPORTED_ROUTE_OR_LENDER');
 // Operator catalog flags are untrusted. A route's venue must match a
 // hard-coded, fork-reviewed router and fee tier before eth_call is taken
 // as an actionable *audit result*. This never authorizes trading.
 const reviewed=c.legs.every(l=>net.venues?.some(v=>v.forkValidated===true &&
  l.forkValidated===true && v.type===l.type &&
  low(v.router)===low(l.router) &&
  (v.type==='v2'?(l.routerKind===0&&Number(l.fee)===0):
    (v.routerKind===l.routerKind && v.fees.includes(Number(l.fee)))));
 if(!reviewed)return incomplete('UNREVIEWED_DEX_VENUE');
 if(c.legs.some((l,i)=>!ADDR.test(l.tokenIn)||!ADDR.test(l.tokenOut)||
     !ADDR.test(l.router)||l.forkValidated!==true||
     (i>0&&low(c.legs[i-1].tokenOut)!==low(l.tokenIn))) ||
    low(c.legs[0].tokenIn)!==low(c.asset) ||
    low(c.legs.at(-1).tokenOut)!==low(c.asset))
  return incomplete('INVALID_OR_UNVALIDATED_ROUTE');
 try{
  const [cid,block,code]=await Promise.all([
   chain.chainId(),chain.blockNumber(),chain.contractCode(executorAddress)
  ]);
  if(cid!==net.id) return incomplete('CHAIN_ID_MISMATCH');
  if(!code||code==='0x') return incomplete('EXECUTOR_CODE_MISSING');
  if(!Number.isSafeInteger(c.block)||block<c.block||block-c.block>maxBlockLag)
   return incomplete('CANDIDATE_BLOCK_STALE',{candidateBlock:c.block,auditBlock:block});
  const provider=net.providers.find(p=>p.kind===c.provider.kind &&
   low(p.address)===low(c.provider.address));
  const info=await chain.providerInfo(provider,net.stable.address,block);
  if(!info?.ok||BigInt(info.available)<BigInt(c.amount))
   return incomplete('FLASH_LOAN_LIQUIDITY_UNAVAILABLE');
  const tokens=[...new Set(c.legs.flatMap(l=>[low(l.tokenIn),low(l.tokenOut)]))];
  const st=await chain.executorState(executorAddress,{
   provider:c.provider.address,routers:c.legs.map(l=>l.router),
   tokens,asset:c.asset
  });
  if(st.paused||low(st.operator)!==low(operatorAddress)||
    Number(st.providerKind)!==PROVIDER_KIND[c.provider.kind]||
    BigInt(st.maxLoan)<BigInt(c.amount)||
    BigInt(st.maxRouteLegs)<BigInt(c.legs.length)||
    !st.routersAllowed?.every(Boolean)||!st.tokensAllowed?.every(Boolean))
   return incomplete('EXECUTOR_ALLOWLIST_OR_LIMIT_REJECTED');
  const d=net.stable.decimals;
  const minNet=parseUnits(String(settings.minProfitUSD),d);
  const fee=BigInt(c.provider.fee);
  if(fee<0n) return incomplete('INVALID_OR_STALE_LENDER_FEE');
  // The lender's current fee calculation is independently validated by
  // eth_call in the contract. We cannot infer it from catalog metadata.
  const first=buildPlan(c,{slippageBps:settings.slippageBps,
    minProfitUnits:1n,maxFeeUnits:fee,
    deadline:Math.floor(Date.now()/1000)+60});
  const sim=await chain.simulateStart(executorAddress,first,operatorAddress);
  const gasUnits=await chain.estimateStart(executorAddress,first,operatorAddress);
  const fd=await chain.feeData();
  const gasPrice=net.txType===0?fd.gasPrice:(fd.maxFeePerGas??fd.gasPrice);
  if(typeof gasPrice!=='bigint'||gasPrice<=0n||gasUnits<=0n)
   return incomplete('GAS_ESTIMATION_UNAVAILABLE');
  const wrapped=net.wrapped.address,stable=net.stable.address;
  let nativePrice=null;
  for(const pool of pools(net)){
    try{
      const quoted=pool.type==='v2'?
       await chain.quoteV2(pool.router,10n**BigInt(net.wrapped.decimals),wrapped,stable,block):
       await chain.quoteV3(pool.quoter,wrapped,stable,pool.fee,
         10n**BigInt(net.wrapped.decimals),block);
      if(typeof quoted==='bigint'&&quoted>0n)
       nativePrice=nativePrice===null?quoted:
         quoted>nativePrice?quoted:nativePrice; // worst observable gas valuation
    }catch{/* failed price sources are not trusted */}
  }
  if(nativePrice===null)return incomplete('NATIVE_PRICE_UNAVAILABLE');
  const gasLimit=(gasUnits*(10000n+BigInt(gasSafetyBps))+9999n)/10000n;
  const l1=net.l1Fee==='op-stack'?
    BigInt(await chain.l1FeeWei(1300))*3n/2n:0n;
  const cost=weiToStable(gasLimit*gasPrice+l1,nativePrice);
  const netUSD=toFloat(sim.profit-cost,d);
  const floor=protectedFloorUnits({minNetUnits:minNet,gasStableUnits:cost});
  const withinLimits=netUSD>=settings.minProfitUSD &&
    gasLimit<=BigInt(settings.maxGasUnits) &&
    toFloat(cost,d)<=settings.maxGasPerTxUSD &&
    Number(gasPrice)/1e9<=settings.maxGasGwei;
  // The simulator's observed profit must clear the stricter min-profit floor.
  const profitable=withinLimits&&sim.profit>=floor;
  const endBlock=await chain.blockNumber();
  if(endBlock!==block)return incomplete('BLOCK_CHANGED_DURING_AUDIT',
    {initialBlock:block,lastBlock:endBlock});
  return {
   mode:'ATOMIC_ETH_CALL_ONLY',status:profitable?'ETH_CALL_ABOVE_FLOOR':'ETH_CALL_BELOW_FLOOR',
   passed:profitable,chainId:net.id,block,simulatedProfitUSD:toFloat(sim.profit,d),
   estimatedWorstGasUSD:toFloat(cost,d),estimatedNetUSD:netUSD,
   gasUnits:gasLimit.toString(),lenderFeeMaxUnits:fee.toString(),executable:false,
   caveat:'eth_call and estimateGas are read-only; a successful call is not a mined transaction or guaranteed inclusion/profit.'
  };
 }catch(e){
  return incomplete('ATOMIC_RPC_OR_REVERT',{detail:String(e.message||e).slice(0,140)});
 }
}
