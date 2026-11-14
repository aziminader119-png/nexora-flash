// Exact-block, read-only midpoint loan-size refinement for promising 2–10-hop routes.
// Inputs MUST be previously quoted catalog routes; never use public API
// metadata, never promote a venue, and NEVER produce an executable candidate.
import {selectProvider,routeGasUnits,weiToStable,netProfitUnits} from './profit.mjs';
import {toFloat} from './units.mjs';
import {PROVIDER_KIND} from './networks.mjs';

const low = v => String(v||'').toLowerCase();
const idFor = c => c.legs.map(l =>
 [String(l.pool),low(l.tokenIn),low(l.tokenOut),Number(l.fee||0)].join(':')).join('>');
function matchedLeg(leg,edges){
 return edges.find(e =>
   String(e.pool.key)===String(leg.pool) &&
   low(e.tokenIn.address)===low(leg.tokenIn) &&
   low(e.tokenOut.address)===low(leg.tokenOut) &&
   Number(e.pool.fee||0)===Number(leg.fee||0) &&
   low(e.pool.router)===low(leg.router));
}
export async function refineLoanSizes({
 chain,net,settings,candidates=[],infos=[],block,gasPrice,nativePrice,
 l1FeeWei=0n,maxQuotes=24,maxRoutes=2,nearMissUSD=1,
}){
 if(!Array.isArray(candidates)||!Array.isArray(net.routeEdges)||
  !Number.isInteger(maxQuotes)||maxQuotes<0||maxQuotes>100||
  !Number.isInteger(maxRoutes)||maxRoutes<0||maxRoutes>5||
  typeof gasPrice!=='bigint'||typeof nativePrice!=='bigint'||
  !Number.isFinite(nearMissUSD)||nearMissUSD<0||nearMissUSD>50)
  throw Error('Invalid refinement inputs');
 const families=new Map();
 for(const c of candidates) {
  if(!c||c.chainId!==net.id||c.block!==block||!Array.isArray(c.legs)||
    c.legs.length<2||c.legs.length>10||!Number.isFinite(c.netEstimate)||
    !Number.isFinite(c.size)||typeof c.amount!=='string')continue;
  const key=idFor(c);if(!families.has(key))families.set(key,[]);
  families.get(key).push(c);
 }
 let quotes=0,skipped=0;const refined=[];
 const groups=[...families.values()].filter(rows=>rows.length>=2)
  .map(rows=>rows.sort((a,b)=>b.netEstimate-a.netEstimate))
  .filter(rows=>rows[0].netEstimate>=-nearMissUSD)
  .sort((a,b)=>b[0].netEstimate-a[0].netEstimate).slice(0,maxRoutes);
 for(const rows of groups){
  const best=rows[0];
  const distinct=[...new Map(rows.map(c=>[c.amount,c])).values()]
   .sort((a,b)=>BigInt(a.amount)<BigInt(b.amount)?-1:1);
  const index=distinct.findIndex(c=>c.amount===best.amount);
  if(index<0||distinct.length<2){skipped++;continue;}
  const neighbors=[distinct[index-1],distinct[index+1]].filter(Boolean)
   .sort((a,b)=>b.netEstimate-a.netEstimate);
  if(!neighbors.length){skipped++;continue;}
  const raw=(BigInt(best.amount)+BigInt(neighbors[0].amount))/2n;
  if(raw<=0n||distinct.some(c=>BigInt(c.amount)===raw)){skipped++;continue;}
  const size=toFloat(raw,net.stable.decimals);
  if(size>settings.maxLoanUSD||size>settings.loanSize||size<10){skipped++;continue;}
  const provider=selectProvider(infos,raw).best;
  if(!provider){skipped++;continue;}
  const edges=best.legs.map(l=>matchedLeg(l,net.routeEdges));
  if(edges.some(x=>!x)){skipped++;continue;}
  if(quotes+edges.length>maxQuotes)break;
  let amount=raw,ok=true;const legs=[];
  for(const edge of edges){
   quotes++;
   let out=null;
   try{
    out=edge.pool.type==='v2'?
     await chain.quoteV2(edge.pool.router,amount,edge.tokenIn.address,edge.tokenOut.address,block):
     await chain.quoteV3(edge.pool.quoter,edge.tokenIn.address,edge.tokenOut.address,edge.pool.fee,amount,block);
   }catch{/* fail closed */}
   if(typeof out!=='bigint'||out<=0n){ok=false;break;}
   legs.push({...best.legs[legs.length],quotedOut:out.toString()});
   amount=out;
  }
  if(!ok)continue;
  const gasUnits=routeGasUnits(provider.kind,legs);
  const l1Approx=l1FeeWei+(l1FeeWei*BigInt(Math.max(0,legs.length-2))/2n);
  const gasStable=weiToStable(gasUnits*gasPrice+l1Approx,nativePrice);
  const profit=netProfitUnits({amount:raw,outUnits:amount,fee:provider.fee,gasStable});
  const decimals=net.stable.decimals;
  const blockers=['scan-only: funded execution disabled',
   'adaptive loan size requires independent fork validation'];
  if(legs.some(l=>!l.forkValidated))blockers.push('venue not fork-validated');
  const c={...best,
   id:best.id+':refined:'+raw.toString(),size,amount:raw.toString(),
   provider:{kind:provider.kind,kindId:PROVIDER_KIND[provider.kind],
    address:provider.address,fee:provider.fee.toString()},
   legs,hopCount:legs.length,
   grossUnits:profit.gross.toString(),feeUnits:provider.fee.toString(),
   gasStableUnits:gasStable.toString(),netUnits:profit.net.toString(),
   gasUnits:gasUnits.toString(),gross:toFloat(profit.gross,decimals),
   flashFee:toFloat(provider.fee,decimals),
   gasCost:toFloat(gasStable,decimals),netEstimate:toFloat(profit.net,decimals),
   blockers,status:'QUOTE_ONLY',mode:'ADAPTIVE_SIZE_OBSERVE_ONLY',
   diagnostics:{probesIncomplete:true,maximumImpactBps:null,liquidityRisk:'UNKNOWN'},
   executable:false,profitQualification:'INDICATIVE_WITH_QUOTED_LENDER_FEE',
   refinement:{method:'ON_CHAIN_MIDPOINT',parentSizeUSD:best.size,
    comparedSizeUSD:neighbors[0].size,block,executable:false},
  };
  refined.push(c);
 }
 return {candidates:refined,quotes,refined:refined.length,skipped,
  mode:'SCAN_ONLY_REFINEMENT',executable:false};
}
