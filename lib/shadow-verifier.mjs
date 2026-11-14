// Re-quote an already-known route at a *new* block to quantify quote decay.
// NO execution, signer, routing approval, public metadata, or transactions.
// A passing probe is NOT an atomic flash-loan simulation.
import {routeGasUnits,weiToStable,netProfitUnits} from './profit.mjs';
import {pools} from './networks.mjs';
import {toFloat} from './units.mjs';
const addr=v=>String(v||'').toLowerCase();
function matchingEdge(leg,edges){
 return edges.find(e=>String(e.pool.key)===String(leg.pool) &&
   addr(e.pool.router)===addr(leg.router) &&
   addr(e.tokenIn.address)===addr(leg.tokenIn) &&
   addr(e.tokenOut.address)===addr(leg.tokenOut) &&
   Number(e.pool.fee||0)===Number(leg.fee||0));
}
export async function shadowVerify({chain,net,settings,candidates=[],
 routeEdges=[],maxCandidates=2,maxQuotes=20}){
 if(!Array.isArray(candidates)||!Array.isArray(routeEdges)||
 !Number.isInteger(maxCandidates)||maxCandidates<0||maxCandidates>5||
 !Number.isInteger(maxQuotes)||maxQuotes<0||maxQuotes>100)
 throw Error('Invalid shadow verification inputs');
 let block,gasPrice,nativePrice,l1FeeWei=0n;
 try {
   const [cid,b,fd]=await Promise.all([chain.chainId(),chain.blockNumber(),chain.feeData()]);
   if(cid!==net.id || !Number.isSafeInteger(b)||b<0)throw Error('RPC_CHAIN_MISMATCH');
   block=b;
   gasPrice=fd.gasPrice??fd.maxFeePerGas;
   if(typeof gasPrice!=='bigint'||gasPrice<=0n)throw Error('GAS_UNAVAILABLE');
   const stable=net.stable.address,wrapped=net.wrapped.address;
   const native=await Promise.all(pools(net).map(async p=>{
     try{return p.type==='v2'
       ?await chain.quoteV2(p.router,10n**BigInt(net.wrapped.decimals),wrapped,stable,block)
       :await chain.quoteV3(p.quoter,wrapped,stable,p.fee,10n**BigInt(net.wrapped.decimals),block);
     }catch{return null;}
   }));
   const available=native.filter(v=>typeof v==='bigint'&&v>0n);
   if(!available.length)throw Error('NATIVE_PRICE_UNAVAILABLE');
   nativePrice=available.reduce((a,b)=>a>b?a:b);
   if(net.l1Fee==='op-stack')l1FeeWei=BigInt(await chain.l1FeeWei(1100))*3n/2n;
 }catch(e){
   return {mode:'SHADOW_REQUOTE_ONLY',status:'UNAVAILABLE',
     reason:String(e.message||e).slice(0,100),scanned:0,quotes:0,
     candidates:[],executable:false};
 }
 const selected=[...candidates].filter(c=>
   c?.chainId===net.id && c.provider && c.asset?.toLowerCase()===net.stable.address.toLowerCase() &&
   Number.isSafeInteger(c.block)&&c.block<=block &&
   Number.isFinite(c.netEstimate)&&c.netEstimate>=settings.minProfitUSD &&
   Array.isArray(c.legs)&&c.legs.length>=2&&c.legs.length<=10)
   .sort((a,b)=>b.netEstimate-a.netEstimate).slice(0,maxCandidates);
 let quotes=0;const checked=[];
 for(const c of selected){
   if(quotes+c.legs.length>maxQuotes)break;
   const edges=c.legs.map(l=>matchingEdge(l,routeEdges));
   if(edges.some(e=>!e)){checked.push({id:c.id,status:'UNKNOWN_POOL',executable:false});continue;}
   if(block===c.block){checked.push({id:c.id,status:'SAME_BLOCK_NO_INDEPENDENT_REQUOTE',executable:false});continue;}
   let amount;
   try{amount=BigInt(c.amount);if(amount<=0n)throw Error();}catch{
     checked.push({id:c.id,status:'INVALID_AMOUNT',executable:false});continue;
   }
   const original=amount;
   if(original>BigInt(Math.floor(settings.maxLoanUSD*10**net.stable.decimals))) {
     checked.push({id:c.id,status:'EXCEEDS_LOAN_CEILING',executable:false});continue;
   }
   let failure=null;
   for(const e of edges){
     quotes++;
     try{
       const out=e.pool.type==='v2'?
         await chain.quoteV2(e.pool.router,amount,e.tokenIn.address,e.tokenOut.address,block):
         await chain.quoteV3(e.pool.quoter,e.tokenIn.address,e.tokenOut.address,e.pool.fee,amount,block);
       if(typeof out!=='bigint'||out<=0n)throw Error('ZERO_OR_INVALID_QUOTE');
       amount=out;
     }catch{failure='RPC_OR_QUOTE_ERROR';break;}
   }
   if(failure){checked.push({id:c.id,status:failure,executable:false});continue;}
   let fee;
   try{fee=BigInt(c.provider.fee);if(fee<0n)throw Error();}catch{
     checked.push({id:c.id,status:'INVALID_LENDER_FEE',executable:false});continue;
   }
   const gasUnits=routeGasUnits(c.provider.kind,c.legs);
   const l1=l1FeeWei + l1FeeWei*BigInt(Math.max(0,c.legs.length-2))/2n;
   const gas=weiToStable(gasUnits*gasPrice+l1,nativePrice);
   const netResult=netProfitUnits({amount:original,outUnits:amount,fee,gasStable:gas});
   const reQuoted=toFloat(netResult.net,net.stable.decimals);
   checked.push({id:c.id,chainId:net.id,oldBlock:c.block,shadowBlock:block,
     quotedNetUSD:c.netEstimate,shadowNetUSD:reQuoted,
     decayUSD:Number((reQuoted-c.netEstimate).toFixed(6)),
     status:reQuoted>=settings.minProfitUSD?'REQUOTE_ABOVE_THRESHOLD':'REQUOTE_BELOW_THRESHOLD',
     feeModel:'ORIGINAL_LENDER_FEE_REUSED',gasModel:'ESTIMATED_NOT_TX_GAS',
     executable:false});
 }
 return {mode:'SHADOW_REQUOTE_ONLY',status:'COMPLETE',scanned:checked.length,
  quotes,candidates:checked,executable:false,
  caveat:'Subsequent-block route re-quote with original observed lender fee and gas approximation. NOT an atomic execution simulation or proof of realizable profit.'};
}
