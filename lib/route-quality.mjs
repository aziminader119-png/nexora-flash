// Ranking of read-only observations. Nothing returned here is an execution approval.
// A quote is not a real-liquidity fork test, a simulation, or a guaranteed trade.
const allowedNonTradeBlockers=new Set([
  'scan-only: funded execution disabled',
  'multi-hop execution requires separate validation and explicit opt-in',
]);
function safeProfit(c){return typeof c.netEstimate==='number'&&Number.isFinite(c.netEstimate)?c.netEstimate:-Infinity;}
function incomplete(c){
 const d=c?.diagnostics;
 return !d || d.probesIncomplete!==false ||
  typeof d.maximumImpactBps!=='number' || !Number.isFinite(d.maximumImpactBps);
}
export function reviewObservedRoutes(candidates,{minProfitUSD=3,maxImpactBps=300,maxResults=10}={}){
 if(!Array.isArray(candidates) || !Number.isFinite(minProfitUSD) || minProfitUSD<=0 ||
   !Number.isInteger(maxImpactBps) || maxImpactBps<0 || maxImpactBps>10000 ||
   !Number.isInteger(maxResults) || maxResults<1 || maxResults>100)
   throw Error('Invalid route review inputs');
 const counts={observed:0,negativeOrBelowMin:0,missingLenderQuote:0,
  unprobedOrPartial:0,highImpact:0,otherBlocked:0,reviewCandidates:0};
 const eligible=[];
 for(const c of candidates){
  if(!c || (c.hopCount!=null && (!Number.isInteger(c.hopCount) || c.hopCount<2 || c.hopCount>10)))continue;
  counts.observed++;
  if(safeProfit(c)<minProfitUSD){counts.negativeOrBelowMin++;continue;}
  if(!c.provider || !c.profitQualification?.includes('QUOTED_LENDER_FEE')){counts.missingLenderQuote++;continue;}
  if(incomplete(c)){counts.unprobedOrPartial++;continue;}
  if(c.diagnostics.maximumImpactBps>maxImpactBps){counts.highImpact++;continue;}
  if((c.blockers||[]).some(b=>!allowedNonTradeBlockers.has(b))){counts.otherBlocked++;continue;}
  eligible.push(c);
 }
 eligible.sort((a,b)=>safeProfit(b)-safeProfit(a));
 counts.reviewCandidates=eligible.length;
 return {
  mode:'READ_ONLY_REVIEW',minimumProfitUSD:minProfitUSD,maxImpactBps,
  counts,noQualifiedRoute:eligible.length===0,
  caveat:'These are candidates for independent fork review only. No trade is authorized or guaranteed.',
  candidates:eligible.slice(0,maxResults).map(c=>({
   id:c.id,chainId:c.chainId,network:c.network,pair:c.pair,hopCount:c.hopCount ?? c.legs?.length ?? 2,
   size:c.size,netEstimate:c.netEstimate,flashFee:c.flashFee,gasCost:c.gasCost,
   maximumImpactBps:c.diagnostics.maximumImpactBps,
   reviewStatus:'REQUIRES_REAL_VENUE_FORK_TEST',
   executable:false,
  })),
 };
}

/**
 * Rank all observed paths, short and long, by quoted net return. A route with
 * incomplete impact analysis is labelled UNVERIFIED, not discarded as "safe".
 * Observational output must never feed transaction authorization.
 */
export function rankObservedRoutes(candidates=[],{minProfitUSD=3,maxImpactBps=300,limit=20}={}){
  if(!Array.isArray(candidates) || !Number.isFinite(minProfitUSD) || minProfitUSD<=0 ||
     !Number.isInteger(maxImpactBps) || maxImpactBps<0 || maxImpactBps>10000 ||
     !Number.isInteger(limit) || limit<1 || limit>100) throw Error('Invalid ranking inputs');
  const rows=candidates.filter(c=>c && Number.isFinite(c.netEstimate) &&
    (c.hopCount??c.legs?.length??2)>=2 && (c.hopCount??c.legs?.length??2)<=10)
    .map(c=>{
      const hops=c.hopCount??c.legs?.length??2;
      const impact=c.diagnostics?.maximumImpactBps;
      const complete=c.diagnostics?.probesIncomplete===false && Number.isFinite(impact);
      const profitable=c.netEstimate>=minProfitUSD;
      const hasLender=!!c.provider && c.profitQualification==='INDICATIVE_WITH_QUOTED_LENDER_FEE';
      const highImpact=complete && impact>maxImpactBps;
      const extraBlockers=(Array.isArray(c.blockers)?c.blockers:[]).filter(b=>!allowedNonTradeBlockers.has(b));
      const status=!profitable?'BELOW_MINIMUM_NET_PROFIT':
        !hasLender?'MISSING_VERIFIED_LENDER_FEE':
        extraBlockers.length?'OTHER_BLOCKER':
        highImpact?'HIGH_ESTIMATED_PRICE_IMPACT':
        !complete?'IMPACT_UNVERIFIED':'FORK_SIMULATION_REQUIRED';
      return {id:c.id,network:c.network,chainId:c.chainId,
        pair:c.pair,hopCount:hops,size:c.size,netEstimate:c.netEstimate,
        gasCost:c.gasCost,flashFee:c.flashFee,impactBps:complete?impact:null,
        status,eligibleForReview:status==='FORK_SIMULATION_REQUIRED',executable:false};
    });
  rows.sort((a,b)=>b.netEstimate-a.netEstimate || a.hopCount-b.hopCount);
  return {mode:'SCAN_ONLY_RANKING',total:rows.length,minProfitUSD,maxImpactBps,
    bestObserved:rows[0]??null,
    recommendedForFurtherReview:rows.filter(r=>r.eligibleForReview).slice(0,limit),
    topObserved:rows.slice(0,limit),
    note:'Quotes are observations, not validated profit. Ranking cannot authorize transactions.'};
}
